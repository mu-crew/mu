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
import { CLOSE_MALFORMED, CLOSE_SHAPE, malformedReason } from "../src/close-block.js";
import {
  closeNotices,
  closeNoticeText,
  NOTICE_CAP,
  noticeable,
  noticeRefusedClose,
} from "../src/close-notice.js";
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
const BAD = 'CLOSE: task=t1 evidence="npm test: 3 passed"\nstill working on it';
const BAD2 = 'CLOSE: task=t1 evidence="npm test"\nREPORT:\n';
let dir: string;
let dbPath: string;
let db: Db;
let servers: Server[];
let mux: MuxHarness;
/** Every `send` the fake pi received, by text. */
let sends: string[];
/** The fake pi takes a `send` and never answers it. */
let silentSends: boolean;
/** The fake pi answers sends but never starts a next run. */
let silentAfterNotice: boolean;
/** Runs once when the fake pi answers its next `hello` (the window before the write fence). */
let onHello: (() => string | undefined) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-close-notice-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  servers = [];
  sends = [];
  silentSends = false;
  silentAfterNotice = false;
  onHello = undefined;
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
        if (req.op === "hello") {
          const h = onHello;
          onHello = undefined;
          sock.end(encode(helloReply({ incarnation: h?.() ?? INC })));
        } else if (req.op === "wait") {
          if (req.afterRuns !== undefined && runs > req.afterRuns) {
            sock.end(encode({ ...status(), lastText, ended: "settled" }));
          } else held.push(sock);
        } else if (req.op === "send") {
          sends.push(req.text ?? "");
          if (silentSends) continue;
          sock.end(encode({ ...status(), msgId: req.msgId }));
          // The worker answers the note with its next run.
          if (!silentAfterNotice) setTimeout(next, 20);
        } else sock.end(encode(status()));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  next();
}

async function asCaller(
  args: string[],
  session = "s",
): Promise<Awaited<ReturnType<typeof runCli>>> {
  let out: Awaited<ReturnType<typeof runCli>> | undefined;
  await withEnv("PI_SESSION_ID", session, () =>
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

  it("drops the reason's one-line shape: the note prints it as lines once", () => {
    const t = closeNoticeText("w", "t1", malformedReason("evidence is empty"));
    expect(t).toContain("w/t1 was not applied: evidence is empty.\n");
    expect(t).not.toContain(CLOSE_SHAPE);
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

  it("a wait whose --until-text the refused run does not match still tells the worker", async () => {
    await servePi([BAD]);
    await asCaller([
      "wait",
      "agent:w/w1",
      "-w",
      "w",
      "--until-text",
      "NEVERMATCH",
      "--timeout",
      "0.5",
      "--json",
    ]);
    expect(sends).toHaveLength(1);
  });

  it("another caller's wait applying the run first does not cost the spawner its notice", async () => {
    await servePi([BAD]);
    await asCaller(
      ["wait", "agent:w/w1", "-w", "w", "--after-runs", "0", "--timeout", "0.5", "--json"],
      "other",
    );
    expect(sends).toEqual([]);
    await taskWait("0.5");
    expect(sends).toHaveLength(1);
  });
});

describe("with --on-stall steer", () => {
  it("a run that got the close notice is not steered as well", async () => {
    // The worker stays quiet after the note (no next run): a stall on that run must not add a steer.
    await servePi([BAD]);
    authorizeTasks(db, ["t1"], { workstream: "w", cli: "pi", worktree: false, maxRuns: 1 });
    silentAfterNotice = true;
    await asCaller([
      "task",
      "wait",
      "t1",
      "-w",
      "w",
      "--all",
      "--on-stall",
      "steer",
      "--stuck-after",
      "0.05",
      "--timeout",
      "1",
      "--json",
    ]);
    expect(sends.filter((t) => t.includes("was not applied"))).toHaveLength(1);
    expect(sends.filter((t) => t.includes("is still yours"))).toEqual([]);
  });
});

describe("the fence", () => {
  const refused = (over: Partial<Parameters<typeof noticeRefusedClose>[1]> = {}) => ({
    workstream: "w",
    agent: "w1",
    agentId: 0,
    incarnation: INC,
    runs: 1,
    task: "t1",
    reason: `${CLOSE_MALFORMED}: the report is empty`,
    ...over,
  });
  const rowId = (): number =>
    (db.prepare("SELECT id FROM agents WHERE name = 'w1'").get() as { id: number }).id;

  it("a workstream torn down while the hello is in flight gets no notice", async () => {
    await servePi([]);
    const id = rowId();
    onHello = () => {
      db.prepare("UPDATE workstreams SET torn_down_at = ? WHERE name = 'w'").run(
        new Date().toISOString(),
      );
      return undefined;
    };
    expect(await noticeRefusedClose(db, refused({ agentId: id }), [CALLER])).toBe("skipped");
    expect(sends).toEqual([]);
  });

  it("an old incarnation's marks never reset the live one's count", async () => {
    await servePi([]);
    const id = rowId();
    for (let runs = 1; runs <= NOTICE_CAP; runs++) {
      expect(await noticeRefusedClose(db, refused({ agentId: id, runs }), [CALLER])).toBe("sent");
    }
    // A late notice for the previous pi, whose hello it still answers: it passes the fence (and
    // marks), then the write is refused by the live pi. It must mark only its own incarnation.
    onHello = () => "old-pi";
    await noticeRefusedClose(db, refused({ agentId: id, incarnation: "old-pi", runs: 9 }), [
      CALLER,
    ]);
    expect(
      await noticeRefusedClose(db, refused({ agentId: id, runs: NOTICE_CAP + 1 }), [CALLER]),
    ).toBe("skipped");
    expect(await noticeRefusedClose(db, refused({ agentId: id, runs: 2 }), [CALLER])).toBe(
      "skipped",
    );
  });
});

describe("a wait's notices (closeNotices)", () => {
  it("a notice that hangs never holds a stopped wait, and a graceful one only up to the grace", async () => {
    await servePi([]);
    silentSends = true;
    const id = (db.prepare("SELECT id FROM agents WHERE name = 'w1'").get() as { id: number }).id;
    const ac = new AbortController();
    const n = closeNotices(db, [CALLER], ac.signal, () => {});
    n.start(
      { kind: "agent", workstream: "w", id: "w1" },
      { agentId: id, incarnation: INC, runs: 1 },
      { applied: false, task: "t1", reason: `${CLOSE_MALFORMED}: the report is empty` },
    );
    await new Promise((r) => setTimeout(r, 50)); // the send is written and held
    expect(n.answers({ workstreamName: "w", name: "w1" }, 1)).toBe(true);
    const t0 = Date.now();
    await n.settle(false);
    expect(Date.now() - t0).toBeLessThan(200);
    ac.abort();
  });
});
