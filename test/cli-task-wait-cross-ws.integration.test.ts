// `mu task wait` over qualified refs in several workstreams (task_wait_cross_workstream).
//
// Real SQLite (in-temp-dir), no tmux. Drives the CLI in-process via runCli so the
// assertions cover the whole verb pipeline (parse + resolve + dispatch + JSON shape).
//
//   1. Two-workstream qualified refs resolve without -w; the result names the firing ref.
//   2. Mixed bare + qualified refs: bare uses -w, qualified uses its own prefix.
//   3. A bad qualified ref (the workstream or task does not exist) is TaskNotFoundError
//      naming the ref, as ONE JSON document with exit 3. Nothing waited.
//   4. --all success: every ref is in `snapshots`, fired; a partial timeout is ok:true
//      with timedOut and the unmet ref in `resume`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, closeTask } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/wait.js";
import { loadResume } from "../src/wait-resume.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

interface WaitOut {
  firing: { kind: string; ref: string | null };
  exit: number;
  timedOut: boolean;
  snapshots: { ref: string; workstream: string; id: string; status: string; fired: boolean }[];
  resume: string | null;
  nextSteps?: { intent: string; command: string }[];
}

const storedRefs = (resume: string | null, dbPath: string): string[] => {
  const id = /--resume (\w+)/.exec(resume ?? "")?.[1] ?? "";
  const db = openDb({ path: dbPath });
  try {
    return loadResume(db, id).spec.refs.map((r) => `${r.workstream}/${r.id}`);
  } finally {
    db.close();
  }
};

describe("mu task wait — cross-workstream qualified refs + --first", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let restoreSleep: ((ms: number) => Promise<void>) | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-x-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsa");
    ensureWorkstream(db, "wsb");
    // Tight poll-sleep so timeout-path tests don't burn real wall time.
    restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
    });
  });

  afterEach(() => {
    if (restoreSleep !== undefined) setWaitSleepForTests(restoreSleep);
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--first across two workstreams names the firing ref, qualified", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    // wsa/foo is already CLOSED → wait should return immediately.
    closeTask(db, "foo", { workstream: "wsa", evidence: "test" });

    const { exitCode, data, stderr, error } = await runCliJson(
      ["task", "wait", "wsa/foo", "wsb/bar", "--first", "--timeout", "5"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    const out = data as WaitOut;
    expect(out.firing).toEqual({ kind: "closed", ref: "task:wsa/foo" });
    expect(out.snapshots[0]).toMatchObject({
      workstream: "wsa",
      id: "foo",
      status: "CLOSED",
      fired: true,
    });
    expect(out.snapshots[1]).toMatchObject({ workstream: "wsb", id: "bar", fired: false });
    expect(out.resume).toMatch(/^mu wait --resume [0-9a-f]{10}$/);
    expect(storedRefs(out.resume, dbPath)).toEqual(["wsb/bar"]);
  });

  it("mixed bare + qualified: bare uses -w, qualified uses its prefix", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    closeTask(db, "foo", { workstream: "wsa", evidence: "test" });
    closeTask(db, "bar", { workstream: "wsb", evidence: "test" });

    // foo is bare (resolves via -w wsa); wsb/bar is qualified.
    const { exitCode, data, stderr, error } = await runCliJson(
      ["task", "wait", "foo", "wsb/bar", "-w", "wsa", "--all", "--timeout", "5"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    const out = data as WaitOut;
    expect(out.timedOut).toBe(false);
    expect(out.snapshots.map((s) => s.ref).sort()).toEqual(["task:wsa/foo", "task:wsb/bar"]);
    expect(out.snapshots.every((s) => s.fired)).toBe(true);
  });

  it("--all success: every ref fired, nothing left in resume", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    closeTask(db, "foo", { workstream: "wsa", evidence: "test" });
    closeTask(db, "bar", { workstream: "wsb", evidence: "test" });

    const { exitCode, data, error } = await runCliJson(
      ["task", "wait", "wsa/foo", "wsb/bar", "--all", "--timeout", "5"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const out = data as WaitOut;
    expect(out.firing.kind).toBe("closed");
    expect(out.snapshots).toHaveLength(2);
    expect(out.snapshots.every((s) => s.fired)).toBe(true);
    // Everything was delivered and no caller owns more: no command that would fail.
    expect(out.resume).toBeNull();
  });

  it("--all partial timeout: ok:true, timedOut, exit 0; the stored resume keeps every ref", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    // foo CLOSED, bar OPEN → --all times out with partial progress.
    closeTask(db, "foo", { workstream: "wsa", evidence: "test" });

    const { exitCode, data, doc, error } = await runCliJson(
      ["task", "wait", "wsa/foo", "wsb/bar", "--all", "--timeout", "0.3"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(doc.ok).toBe(true);
    const out = data as WaitOut;
    expect(out).toMatchObject({ timedOut: true, exit: 0 });
    expect(out.firing).toEqual({ kind: "heartbeat", ref: null });
    expect(out.snapshots.filter((s) => s.fired).map((s) => s.ref)).toEqual(["task:wsa/foo"]);
    expect(out.snapshots.filter((s) => !s.fired).map((s) => s.ref)).toEqual(["task:wsb/bar"]);
    // A timeout delivered nothing: the stored --all wait still names both (foo stays fired on resume).
    expect(storedRefs(out.resume, dbPath)).toEqual(["wsa/foo", "wsb/bar"]);
  });

  // ─── Bad ref handling ──────────────────────────────────────────────

  it("qualified ref to a non-existent workstream → TaskNotFoundError as one JSON document; nothing waited", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });

    const { exitCode, stdout, stderr, error } = await runCli(
      ["task", "wait", "wsa/foo", "ghostws/bar", "--timeout", "60"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBe(3);
    expect(stderr).toBe("");
    const doc = JSON.parse(stdout) as { ok: boolean; error: string; message: string; exit: number };
    expect(doc).toMatchObject({ ok: false, error: "TaskNotFoundError", exit: 3 });
    expect(doc.message).toContain("ghostws/bar");
  });

  it("qualified ref where the task doesn't exist → TaskNotFoundError naming the qualified ref", async () => {
    // wsa exists but has no 'missing' task.
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });

    const { exitCode, stdout, error } = await runCli(
      ["task", "wait", "wsa/missing", "--timeout", "60"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBe(3);
    expect(JSON.parse(stdout).message).toContain("wsa/missing");
  });
});
