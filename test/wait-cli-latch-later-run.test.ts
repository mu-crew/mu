// fix_latch_later_run: a later run always supersedes a settled latch. Two CLI repros:
// (P1a) `mu wait -w w --all --on-stall exit`: run 1's malformed CLOSE ends the wait as a stall
// (exit 7); during the printed resume run 2 settles with a valid CLOSE: the resume closes the task.
// (P1b) `mu task wait t1 --all --on-stall warn`: run 1 settles mid-task, run 2 with a valid CLOSE:
// the same wait closes t1, not a heartbeat at the timeout.
// Real SQLite, a fake pi control socket that holds `wait`, no real mux.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
} from "../src/agents.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask, getTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { withEnv } from "./_env.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli } from "./_runCli.js";

const CALLER = "pi:s";
const VALID = 'CLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\ndone';
let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-latch-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  servers = [];
  setSleepForTests(async () => {});
  setWaitSleepForTests(async (ms) => {
    await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  });
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  mux = installMux("tmux", async (args) => ({
    stdout:
      args[0] === "list-panes"
        ? args[1] === "-a"
          ? `%w1\tidle\t${Date.now() - 600_000}\n`
          : "@1\t%w1\tagent\tsh\n"
        : "",
    stderr: "",
    exitCode: 0,
  }));
});
afterEach(async () => {
  mux.restore();
  resetSleep();
  setWaitSleepForTests(undefined);
  resetCommandResolverForTests();
  for (const s of servers) s.close();
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** A pi the test drives: `settle(text)` ends a run (idle since now), `busy()` starts one. */
async function servePi(): Promise<{ settle: (text: string) => void; busy: () => void }> {
  let state: "busy" | "idle" = "busy";
  let runs = 0;
  let since = Date.now();
  let lastText = "";
  const held: { sock: Socket; afterRuns?: number }[] = [];
  const status = () => ({
    v: 1,
    ok: true,
    incarnation: INC,
    state,
    since,
    runs,
    pending: false,
  });
  const reply = () => ({ ...status(), lastText, ended: "settled" });
  const settle = (text: string): void => {
    state = "idle";
    runs++;
    since = Date.now() - 60_000;
    lastText = text;
    for (const h of held.splice(0)) h.sock.end(encode(reply()));
  };
  const path = ctlSocketPath("w", "w1", dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    const dec = new LineDecoder();
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; afterRuns?: number };
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait") {
          if (req.afterRuns !== undefined && runs > req.afterRuns && state === "idle") {
            sock.end(encode(reply()));
          } else
            held.push({
              sock,
              ...(req.afterRuns !== undefined ? { afterRuns: req.afterRuns } : {}),
            });
        } else sock.end(encode(status()));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return {
    settle,
    busy: () => {
      state = "busy";
      since = Date.now();
    },
  };
}

const settles = (): number[] =>
  (db.prepare("SELECT runs FROM agent_settles ORDER BY runs").all() as { runs: number }[]).map(
    (r) => r.runs,
  );

async function asCaller(args: string[]): Promise<Awaited<ReturnType<typeof runCli>>> {
  let out: Awaited<ReturnType<typeof runCli>> | undefined;
  await withEnv("PI_SESSION_ID", "s", () =>
    withEnv("MU_MANAGED_AGENT", undefined, async () => {
      out = await runCli(args, dbPath);
    }),
  );
  if (out === undefined) throw new Error("no CLI result");
  return out;
}

async function setup(): Promise<{ settle: (text: string) => void; busy: () => void }> {
  addTask(db, { localId: "t1", workstream: "w", title: "t1", impact: 50, effortDays: 1 });
  insertAgent(db, { name: "w1", workstream: "w", paneId: "%w1", cli: "pi", spawner: CALLER });
  await claimTask(db, "t1", { workstream: "w", agentName: "w1" });
  return servePi();
}

describe("a later run supersedes a settled latch (fix_latch_later_run)", () => {
  it("P1a: the resume after a malformed-CLOSE stall applies run 2's valid CLOSE (exit 0)", async () => {
    const pi = await setup();
    pi.settle('CLOSE: task=t1 evidence="e"\nREPORT:\n');
    const args = ["--all", "--on-stall", "exit", "--stuck-after", "0.05", "--timeout", "7"];
    const first = await asCaller(["wait", "-w", "w", ...args, "--json"]);
    expect(first.exitCode).toBe(7);
    const doc = (JSON.parse(first.stdout) as { data: { resume: string; reason: string } }).data;
    expect(doc.reason).toContain("no close (malformed)");
    const id = /--resume (\w+)/.exec(doc.resume)?.[1] ?? "";
    // The resume starts with the owner still idle at run 1 (it re-reads that run); then the owner
    // is sent work and run 2 settles with a valid CLOSE while the resume runs.
    setTimeout(() => {
      pi.busy();
      setTimeout(() => pi.settle(VALID), 50);
    }, 200);
    const second = await asCaller(["wait", "--resume", id, "-w", "w", "--json"]);
    expect(JSON.parse(second.stdout).data).toMatchObject({ exit: 0 });
    expect(second.exitCode).toBeNull();
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "CLOSED" });
    expect(settles()).toEqual([1, 2]);
  });

  it("P1b: --on-stall warn, run 1 settles mid-task, run 2's valid CLOSE closes t1 in the same wait", async () => {
    const pi = await setup();
    pi.settle("paused mid-task");
    setTimeout(() => {
      pi.busy();
      setTimeout(() => pi.settle(VALID), 50);
    }, 200);
    const out = await asCaller([
      "task",
      "wait",
      "t1",
      "-w",
      "w",
      "--all",
      "--status",
      "CLOSED",
      "--on-stall",
      "warn",
      "--stuck-after",
      "0.05",
      "--timeout",
      "5",
      "--json",
    ]);
    expect(out.stderr).toMatch(/still waiting \(--on-stall warn\)/);
    expect(JSON.parse(out.stdout).data).toMatchObject({ timedOut: false, exit: 0 });
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "CLOSED" });
    expect(settles()).toEqual([2]);
  });
});
