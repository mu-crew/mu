// `mu task wait t1 --all --status CLOSED --on-stall steer` (fix_allstall_steer_rearm): the owner's
// first run settles mid-task and is steered once; its SECOND run settles with a valid CLOSE block.
// The same wait must read that run and exit 0, not return `stall: budget-exhausted` (exit 7).
// Real SQLite, a fake pi control socket that holds `wait` and answers `send`, no real mux.

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
import { authorizeTasks } from "../src/task-auto.js";
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
let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let mux: MuxHarness;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-wait-allstall-"));
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

/** A pi that is busy; run 1 settles mid-task on its own, run 2 settles (with the CLOSE) after a `send`. */
async function servePi(sends: unknown[]): Promise<void> {
  let state: "busy" | "idle" = "busy";
  let runs = 0;
  let lastText = "";
  const held: Socket[] = [];
  const status = () => ({
    v: 1,
    ok: true,
    incarnation: INC,
    state,
    since: state === "idle" ? 1 : Date.now(),
    runs,
    pending: false,
  });
  const settle = (text: string): void => {
    state = "idle";
    runs++;
    lastText = text;
    for (const s of held.splice(0)) s.end(encode({ ...status(), lastText, ended: "settled" }));
  };
  const path = ctlSocketPath("w", "w1", dir);
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    const dec = new LineDecoder();
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string; afterRuns?: number; msgId?: string };
        if (req.op === "hello") sock.end(encode(helloReply()));
        else if (req.op === "wait") {
          if (req.afterRuns !== undefined && runs > req.afterRuns && state === "idle") {
            sock.end(encode({ ...status(), lastText, ended: "settled" }));
          } else held.push(sock);
        } else if (req.op === "send") {
          sends.push(req);
          state = "busy";
          sock.end(encode(status()));
          setTimeout(
            () => settle('CLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\ndone'),
            40,
          );
        } else sock.end(encode(status()));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  setTimeout(() => settle("paused mid-task"), 40);
}

describe("mu task wait --all --on-stall steer", () => {
  it("steers once after run 1 and closes on run 2's CLOSE in the same wait (exit 0)", async () => {
    addTask(db, { localId: "t1", workstream: "w", title: "t1", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "w1", workstream: "w", paneId: "%w1", cli: "pi", spawner: CALLER });
    await claimTask(db, "t1", { workstream: "w", agentName: "w1" });
    authorizeTasks(db, ["t1"], { workstream: "w", cli: "pi", worktree: false, maxRuns: 1 });
    const sends: unknown[] = [];
    await servePi(sends);
    let out: Awaited<ReturnType<typeof runCli>> | undefined;
    await withEnv("PI_SESSION_ID", "s", () =>
      withEnv("MU_MANAGED_AGENT", undefined, async () => {
        out = await runCli(
          [
            "task",
            "wait",
            "t1",
            "-w",
            "w",
            "--all",
            "--status",
            "CLOSED",
            "--on-stall",
            "steer",
            "--stuck-after",
            "1",
            "--timeout",
            "7",
            "--json",
          ],
          dbPath,
        );
      }),
    );
    expect(out?.stderr).toMatch(/sent the reminder to w1/);
    expect(sends).toHaveLength(1);
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "CLOSED" });
    expect(out?.exitCode).toBeNull();
  });
});
