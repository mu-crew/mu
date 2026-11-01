// close-notice: a worker whose CLOSE block was refused as malformed is told
// once, by the wait that saw the refusal (src/close-notice.ts). Real SQLite,
// a fake pi control socket that holds `wait` and records `send`, no real mux.

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
import { CLOSE_MALFORMED } from "../src/close-block.js";
import { closeNoticeText, NOTICE_CAP, noticeable } from "../src/close-notice.js";
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
const BAD = 'CLOSE: task=t1 evidence="npm test: 3 passed"\nstill working on it';
const BAD2 = 'CLOSE: task=t1 evidence="npm test"\nREPORT:\n';
let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let mux: MuxHarness;
/** Every `send` the fake pi received, by text. */
let sends: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-close-notice-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  servers = [];
  sends = [];
  setSleepForTests(async () => {});
  setWaitSleepForTests(async (ms) => {
    await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  });
  setCommandResolverForTests(async (c) => ({ ok: true, binary: c, resolvedPath: `/bin/${c}` }));
  mux = installMux("tmux", async (args) => ({
    stdout:
      args[0] === "list-panes"
        ? args[1] === "-a"
          ? `%41\tidle\t${Date.now() - 600_000}\n`
          : "@1\t%41\tagent\tsh\n"
        : args[0] === "display-message"
          ? "%41|0||\n"
          : "",
    stderr: "",
    exitCode: 0,
  }));
});
afterEach(() => {
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

/** A pi that settles one run per text in `runs` (each after the previous was answered). */
async function servePi(texts: string[], spawner = CALLER): Promise<void> {
  addTask(db, { localId: "t1", workstream: "w", title: "t1", impact: 50, effortDays: 1 });
  insertAgent(db, { name: "w1", workstream: "w", paneId: "%41", cli: "pi", spawner });
  await claimTask(db, "t1", { workstream: "w", agentName: "w1" });
  let runs = 0;
  let lastText = "";
  const held: Socket[] = [];
  const status = () => ({
    v: 1,
    ok: true,
    incarnation: INC,
    state: "idle",
    since: Date.now() - 60_000,
    runs,
    pending: false,
  });
  const next = (): void => {
    const t = texts.shift();
    if (t === undefined) return;
    runs++;
    lastText = t;
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
        const req = JSON.parse(line) as {
          op: string;
          afterRuns?: number;
          text?: string;
          msgId?: string;
        };
        if (req.op === "hello") sock.end(encode(helloReply({ incarnation: INC })));
        else if (req.op === "wait") {
          if (req.afterRuns !== undefined && runs > req.afterRuns) {
            sock.end(encode({ ...status(), lastText, ended: "settled" }));
          } else held.push(sock);
        } else if (req.op === "send") {
          sends.push(req.text ?? "");
          sock.end(encode({ ...status(), msgId: req.msgId }));
          // The worker answers the note with its next run.
          setTimeout(next, 20);
        } else sock.end(encode(status()));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  next();
}

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

const taskWait = (timeout = "3") =>
  asCaller(["task", "wait", "t1", "-w", "w", "--on-stall", "warn", "--timeout", timeout, "--json"]);

/** Wait again and again, as a settle hook does, until the task closes or the worker goes quiet. */
async function settleLoop(): Promise<void> {
  for (let i = 0; i < 8 && getTask(db, "t1", "w")?.status !== "CLOSED"; i++) await taskWait("0.5");
}

describe("the note", () => {
  it("is fixed text: the reason and the exact shape, no worker output", () => {
    const t = closeNoticeText("w", "t1", `${CLOSE_MALFORMED}: the report is empty`);
    expect(t).toContain("w/t1 was not applied: the report is empty.");
    expect(t).toContain('CLOSE: task=t1 evidence="<command + result>"\nREPORT:\n<what you did>');
    expect(t).toContain("do not write CLOSE: at all");
  });

  it("only a malformed block on a known task is noticeable", () => {
    expect(noticeable({ task: "t1", reason: `${CLOSE_MALFORMED}: evidence is empty` })).toBe(true);
    expect(noticeable({ task: null, reason: `${CLOSE_MALFORMED}: evidence is empty` })).toBe(false);
    expect(noticeable({ task: "t1", reason: "task is not owned by this agent" })).toBe(false);
  });
});

describe("a wait that sees a malformed CLOSE tells the worker once", () => {
  it("the worker gets the note, fixes the block on its next run, and the task closes", async () => {
    await servePi([BAD, 'CLOSE: task=t1 evidence="npm test: 3 passed"\nREPORT:\ndone']);
    // The settle hook's loop: wait, and wait again until the task closes.
    await settleLoop();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("the line after CLOSE: is not exactly REPORT:");
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "CLOSED" });
  });

  it("once per run, across waits: a second wait on the same refused run sends nothing", async () => {
    await servePi([BAD]);
    await taskWait("0.5");
    await taskWait("0.5");
    expect(sends).toHaveLength(1);
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "IN_PROGRESS" });
  });

  it(`at most ${NOTICE_CAP} per incarnation: a worker that keeps failing goes back to the orchestrator`, async () => {
    await servePi([BAD, BAD2, BAD, BAD2, BAD]);
    await settleLoop();
    expect(sends).toHaveLength(NOTICE_CAP);
    expect(getTask(db, "t1", "w")).toMatchObject({ status: "IN_PROGRESS" });
  });

  it("a worker another caller spawned is never told", async () => {
    await servePi([BAD], "pi:someone-else");
    await taskWait("0.5");
    expect(sends).toEqual([]);
  });
});
