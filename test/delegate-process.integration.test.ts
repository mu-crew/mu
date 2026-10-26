// The mux-free delegate runner (src/delegate-process.ts) against a fake pi
// (test/fixtures/fake-pi.mjs) that serves the real ctl protocol over
// $MU_CTL_SOCK. tmux and herdr are OFF PATH and unset: nothing here may need
// a multiplexer. Real child processes, so full tier only.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DelegateTool, registerDelegate } from "../extension/delegate.js";
import { type MuRunner, runChild } from "../extension/mu-run.js";
import { type Db, openDb } from "../src/db.js";
import {
  type DelegateRunResult,
  delegateProcessPaths,
  runDelegateProcess,
} from "../src/delegate-process.js";
import {
  getDelegateCall,
  listDelegates,
  markDelegate,
  registerDelegateCall,
} from "../src/delegates.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { rmFixtureDir } from "./_fs.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const KEYS = [
  "PATH",
  "TMUX",
  "TMUX_PANE",
  "HERDR_ENV",
  "MU_MUX",
  "MU_PI_COMMAND",
  "MU_STATE_DIR",
  "MU_DB_PATH",
  "FAKE_PI",
  "FAKE_PI_LOG",
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let db: Db;
let log: string;
let n = 0;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mu-dp-"));
  // PATH holds node and git only: tmux and herdr are not reachable.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const b of ["git"]) symlinkSync(execFileSync("which", [b]).toString().trim(), join(bin, b));
  symlinkSync(process.execPath, join(bin, "node"));
  process.env.PATH = bin;
  for (const k of ["TMUX", "TMUX_PANE", "HERDR_ENV", "MU_MUX", "FAKE_PI"]) delete process.env[k];
  process.env.MU_PI_COMMAND = `${process.execPath} ${FAKE}`;
  process.env.MU_STATE_DIR = dir;
  log = join(dir, "requests.log");
  process.env.FAKE_PI_LOG = log;
  db = openDb({ path: join(dir, "mu.db") });
});
afterEach(() => {
  db.close();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmFixtureDir(dir);
});

const sends = (): number =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l === "send").length
    : 0;
const running = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function register(extra: Record<string, unknown> = {}, request: object = {}) {
  const callId = `pi:s:${++n}`;
  if (!getTask(db, "f1", "crew")) addTask(db, { localId: "f1", workstream: "crew", title: "f1" });
  const { call } = registerDelegateCall(db, {
    callId,
    caller: "pi:s",
    workstream: "scratch",
    request: { text: "check it", label: "ref", ...request },
    record: { workstream: "crew", task: "f1" },
    state: "starting",
    ...extra,
  });
  return { callId, call };
}

const run = (
  callId: string,
  mode: string,
  o: { startupMs?: number; signal?: AbortSignal; keep?: boolean } = {},
) => {
  process.env.FAKE_PI = mode;
  return runDelegateProcess(db, callId, { extension: FAKE, startupMs: 3000, ...o });
};

describe("runDelegateProcess (no mux)", () => {
  it("answers: one send, verdict + report + close durable, child stopped", async () => {
    const { callId, call } = register();
    const r = await run(callId, "answer");
    expect(r).toMatchObject({
      ran: true,
      outcome: "done",
      state: "done",
      transport: "process",
      attach: null,
    });
    expect(sends()).toBe(1);
    expect(getDelegateCall(db, callId)).toMatchObject({
      state: "done",
      verdict: "CONFIRMED",
      agent: call.task,
    });
    const ref = getTask(db, call.task, "scratch");
    expect(ref?.status).toBe("CLOSED");
    expect(r.sessionFile).toMatch(/fake-session/);
    expect(existsSync(r.logPath ?? "")).toBe(true);
    expect(running(r.pid)).toBe(false);
    const notes = db
      .prepare("SELECT kind, content FROM task_notes WHERE kind = 'verdict'")
      .all() as { content: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("EVIDENCE: read it");
    // a repeat is a no-op: nothing starts, nothing is resent
    expect((await run(callId, "answer")).ran).toBe(false);
    expect(sends()).toBe(1);
  });

  it("a definite no before the send refuses the call (reissuable) and leaves no child or receipt", async () => {
    for (const [mode, extra] of [
      ["refuse", {}],
      ["silent", { startupMs: 300 }],
      ["die", {}],
    ] as const) {
      const { callId, call } = register();
      const r = await run(callId, mode, extra);
      expect(r, mode).toMatchObject({ outcome: "refused", state: "refused" });
      expect(running(r.pid), mode).toBe(false);
      expect(existsSync(delegateProcessPaths(db, call).receipt), mode).toBe(false);
      expect(getDelegateCall(db, callId)?.error, mode).toBeTruthy();
      expect(markDelegate(db, callId, "starting").state).toBe("starting"); // reissue
    }
  });

  it("an ambiguous delivery is unknown, evidence kept, never resent or respawned", async () => {
    const { callId, call } = register();
    const r = await run(callId, "lost");
    expect(r).toMatchObject({ outcome: "unknown", state: "failed" });
    expect(r.error).toContain("Not respawned, not resent");
    expect(sends()).toBe(1);
    expect(existsSync(delegateProcessPaths(db, call).receipt)).toBe(true);
    expect(running(r.pid)).toBe(false);
    expect((await run(callId, "answer")).ran).toBe(false);
    expect(sends()).toBe(1);
  });

  it("a reply lost after the child accepted the prompt is confirmed by msgId, not resent", async () => {
    const { callId } = register();
    const r = await run(callId, "drop");
    expect(r).toMatchObject({ outcome: "done", state: "done" });
    expect(sends()).toBe(1);
  });

  it("a stale receipt (an earlier attempt) finishes unknown without spawning", async () => {
    const { callId, call } = register();
    const p = delegateProcessPaths(db, call);
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.receipt, JSON.stringify({ runner: 2 ** 22 + 1, phase: "sending" }));
    const r = await run(callId, "answer");
    expect(r).toMatchObject({ outcome: "unknown", state: "failed" });
    expect(existsSync(log)).toBe(false);
  });

  it("maps blocked, error, empty, died and timeout to recorded failures and keeps the evidence", async () => {
    for (const mode of ["blocked", "error", "empty", "crash", "hang"]) {
      const { callId } = register({}, mode === "hang" ? { timeoutS: 1 } : {});
      const r = await run(callId, mode);
      const want = {
        blocked: "blocked",
        error: "error",
        empty: "empty",
        crash: "died",
        hang: "timeout",
      }[mode];
      expect(r, mode).toMatchObject({ outcome: want, state: "failed" });
      expect(running(r.pid), mode).toBe(false);
      expect(getDelegateCall(db, callId)?.verdict, mode).toBeNull();
    }
  });

  it("an abort cancels: the turn is aborted, the call cancelled, the child stopped", async () => {
    const { callId } = register();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const r = await run(callId, "hang", { signal: ac.signal });
    expect(r).toMatchObject({ outcome: "cancelled", state: "cancelled" });
    expect(running(r.pid)).toBe(false);
  });

  it("keep: true leaves the child live after the durable finish; stop() ends it", async () => {
    const { callId } = register({}, { keep: true });
    const r: DelegateRunResult = await run(callId, "answer");
    expect(r).toMatchObject({ state: "done" });
    expect(running(r.pid)).toBe(true);
    await r.live?.stop();
    expect(running(r.pid)).toBe(false);
  });

  it("keep: false (the extension's --no-keep) overrides the call's keep and returns the answer", async () => {
    const { callId } = register({}, { keep: true });
    const r = await run(callId, "answer", { keep: false });
    expect(r).toMatchObject({ state: "done", outcome: "done" });
    expect(r.answer).toBeTruthy();
    expect(r.live).toBeUndefined();
    expect(running(r.pid)).toBe(false);
  });

  it("workspace: true uses a registered git worktree and removes it when clean", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const g = (...a: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    g("init", "-q");
    g("commit", "-q", "--allow-empty", "-m", "init");
    const { callId } = register({}, { workspace: true, cwd: repo });
    const r = await run(callId, "answer");
    expect(r).toMatchObject({ state: "done" });
    expect(r.workspace).toContain("worktrees");
    expect(r.worktree).toMatchObject({ action: "removed" });
    expect(existsSync(r.workspace ?? "")).toBe(false);
  });
});

describe("mu_delegate with no multiplexer (extension -> real `mu delegates run`)", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  /** The extension's runner on the built CLI, against this test's DB and the fake pi. */
  const runner = (): MuRunner => (args, signal, stdin, opts) =>
    runChild(process.execPath, [CLI, ...args], signal, stdin, {
      ...opts,
      env: {
        ...opts?.env,
        MU_DB_PATH: join(dir, "mu.db"),
        MU_SYNC_DIR: "",
      },
    });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  const fakePi = () => {
    const tools = new Map<string, DelegateTool>();
    const sent: { content: string }[] = [];
    registerDelegate(
      {
        registerTool: (t) => void tools.set(t.name, t),
        sendMessage: (m) => void sent.push(m),
        on: () => {},
        events: { emit: () => {} },
      },
      runner(),
    );
    const tool = (name: string) => {
      const t = tools.get(name);
      if (!t) throw new Error(`${name} not registered`);
      return t;
    };
    return { tool, sent };
  };

  it("answers: the runner records the verdict, the follow-up names no pane", async () => {
    if (!existsSync(CLI)) return; // needs `npm run build`
    process.env.FAKE_PI = "answer";
    addTask(db, { localId: "f1", workstream: "crew", title: "f1" });
    const p = fakePi();
    const res = await p.tool("mu_delegate").execute("t", {
      task: "check it",
      record: { task: "crew/f1" },
      cwd: dir,
    });
    expect(res.details).toMatchObject({ transport: "process", attach: null, state: "running" });
    await until(() => p.sent.length > 0);
    expect(p.sent[0]?.content).toMatch(/finished .*Child pi stopped/s);
    expect(p.sent[0]?.content).not.toMatch(/Pane|attach/);
    const [call] = listDelegates(db);
    expect(call?.state).toBe("done");
    expect(sends()).toBe(1);
  });

  it("cancel SIGTERMs the run: the call is cancelled and the child pi is gone", async () => {
    if (!existsSync(CLI)) return;
    process.env.FAKE_PI = "hang";
    const p = fakePi();
    const res = await p.tool("mu_delegate").execute("t", { task: "check it", cwd: dir });
    const name = (res.details as { name: string }).name;
    await until(() => sends() === 1);
    const pid = Number(
      (
        JSON.parse(
          readFileSync(delegateProcessPaths(db, listDelegates(db)[0] as never).receipt, "utf8"),
        ) as {
          pid: number;
        }
      ).pid,
    );
    const c = await p.tool("mu_delegate_cancel").execute("c", { name });
    expect(c.content[0]?.text).toContain("call cancelled");
    expect(running(pid)).toBe(false);
    expect(p.sent).toHaveLength(0);
  });
});
