// `mu task wait --any`, `--first` and the default are ONE contract: the first event ends
// the wait, and the result names it. (Before the unified wait, --any left `firing` null
// and only --first named the ref; a consumer doing `.firing.name` after a successful
// --any crashed. wait-json-firing-null-exit0.) A clean exit with an event always names
// the ref; a timeout is ok:true with timedOut and a heartbeat event, never an error exit.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, closeTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

interface WaitJsonPayload {
  firing: { kind: string; ref: string | null };
  event: { kind: string; ref: string | null };
  exit: number;
  timedOut: boolean;
  snapshots: Array<{ ref: string; fired: boolean }>;
  resume: string;
}

describe("mu task wait — --any vs --first output shape", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    // No managed agents: the per-poll reconcile must see an empty
    // pane list rather than hitting a real tmux server.
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-panes" && args[1] === "-s") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-shape-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    // Only `a` reaches the target so "first/any" has a single firing ref.
    closeTask(db, "a", { workstream: "test", evidence: "test" });
  });

  afterEach(() => {
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--first, --any and the default all return the same event, naming the ref", async () => {
    const outs: WaitJsonPayload[] = [];
    for (const flag of [["--first"], ["--any"], ["--first-of"], []]) {
      const r = await runCliJson(["task", "wait", "a", "b", ...flag, "-w", "test"], dbPath);
      expect(r.error).toBeUndefined();
      expect(r.exitCode).toBeNull();
      outs.push(r.data as WaitJsonPayload);
    }
    for (const o of outs) {
      expect(o.firing).toEqual({ kind: "closed", ref: "task:test/a" });
      expect(o.event).toEqual(o.firing);
      expect(o.exit).toBe(0);
      expect(o.timedOut).toBe(false);
      // b is still open: the resume command waits for it, not for a.
      expect(o.resume).toContain("task:test/b");
      expect(o.resume).not.toContain("task:test/a");
    }
  });

  it("always one JSON document, with no --json flag", async () => {
    const r = await runCli(["task", "wait", "a", "-w", "test"], dbPath);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      data: { firing: { ref: "task:test/a" } },
    });
  });

  it("--first and --all together are a usage error, not a silent pick", async () => {
    const r = await runCli(["task", "wait", "a", "--first", "--all", "-w", "test"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, exit: 2 });
  });

  it("a clean exit names the ref; a timeout is ok:true, timedOut, exit 0, a heartbeat event", async () => {
    const hit = await runCliJson(["task", "wait", "a", "b", "--first", "-w", "test"], dbPath);
    expect((hit.data as WaitJsonPayload).firing.ref).not.toBeNull();

    const miss = await runCliJson(["task", "wait", "b", "-w", "test", "--timeout", "0.3"], dbPath);
    expect(miss.exitCode).toBeNull();
    expect(miss.doc.ok).toBe(true);
    const payload = miss.data as WaitJsonPayload;
    expect(payload).toMatchObject({ timedOut: true, exit: 0 });
    expect(payload.firing).toEqual({ kind: "heartbeat", ref: null });
    expect(payload.snapshots.map((s) => s.ref)).toEqual(["task:test/b"]);
    expect(payload.resume).toContain("task:test/b");
  });
});
