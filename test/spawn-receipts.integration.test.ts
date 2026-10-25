// Cross-process contention for `agent spawn --task` (v_spawn_receipts), real
// CLI processes and a real tmux server. A sh agent has no ctl and no send on
// tmux, so every attempt ends UNSENT (exit 4) and must leave nothing behind:
// the interesting part is that concurrent callers of one attempt are
// serialised by the strict attempt lock (or refused with exit 4), never
// interleaved. Needs `npm run build` and $TMUX.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSpawnAttemptLock } from "../src/agents/lock.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { taskIdFor } from "../src/tasks.js";
import { killSession } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";

const execFileP = promisify(execFile);
const CLI = join(process.cwd(), "dist", "cli.js");
const ready = process.env.TMUX !== undefined && process.env.TMUX !== "" && existsSync(CLI);
const describeIfReady = ready ? describe : describe.skip;

describeIfReady("spawn --task across processes (real tmux)", () => {
  let dir: string;
  let dbPath: string;
  let ws: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-rcpt-"));
    dbPath = join(dir, "mu.db");
    ws = `rc${process.pid}x${Math.floor(Math.random() * 1e6)}`.slice(0, 32);
    db = openDb({ path: dbPath });
    ensureWorkstream(db, ws);
    addTask(db, { localId: "t1", workstream: ws, title: "T", impact: 50, effortDays: 1 });
  });

  afterEach(async () => {
    db.close();
    try {
      await killSession(`mu-${ws}`);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (name: string, env: Record<string, string> = {}) =>
    execFileP(
      "node",
      [CLI, "agent", "spawn", name, "-w", ws, "--cli", "sh", "--task", "t1", "--send", "go"],
      {
        env: { ...process.env, MU_DB_PATH: dbPath, MU_SPAWN_LIVENESS_MS: "0", ...env },
      },
    ).then(
      () => ({ code: 0 }),
      (e: { code?: number }) => ({ code: e.code ?? 1 }),
    );

  const state = () => {
    const c = openDb({ path: dbPath });
    try {
      return {
        agents: (c.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
        owner: (c.prepare("SELECT owner_id AS o FROM tasks").get() as { o: number | null }).o,
        receipts: c.prepare("SELECT attempt_key AS k, state FROM spawn_receipts").all(),
      };
    } finally {
      c.close();
    }
  };

  it("a held attempt lock refuses a second process with exit 4 and does nothing", async () => {
    const id = taskIdFor(db, "t1", ws) ?? 0;
    await withSpawnAttemptLock(
      db,
      id,
      "manual:t1",
      async () => {
        const r = await run("worker-1", { MU_AGENT_LOCK_TIMEOUT_MS: "300" });
        expect(r.code).toBe(4);
      },
      () => {
        throw new Error("could not take the lock");
      },
    );
    expect(state()).toEqual({ agents: 0, owner: null, receipts: [] });
  }, 30_000);

  it("concurrent callers of one attempt are serialised: every one ends unsent, nothing leaks", async () => {
    const results = await Promise.all([run("worker-1"), run("worker-1"), run("worker-1")]);
    // Unsent (a sh agent cannot receive a prompt on tmux): exit 4, or 4 for a busy lock.
    expect(results.map((r) => r.code)).toEqual([4, 4, 4]);
    const s = state();
    expect(s.agents).toBe(0);
    expect(s.owner).toBeNull();
    expect(s.receipts).toEqual([{ k: "manual:t1", state: "failed" }]);
  }, 60_000);
});
