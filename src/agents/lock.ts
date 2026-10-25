// The agent lock: one cross-process lock per (workstream, agent name), held
// by every step that destroys or re-stages that name's disk state: `agent
// close` (the whole sequence: kill, worktree release, row delete) and a
// `--worktree` spawn's staging and rollback (reclaim, create, register,
// remove). Row writes by anything else (reconcile, teardown, plain spawn)
// do not take it; they carry their own compare-and-swap on the row's
// identity (`deleteAgent`'s `expected`).
//
// FAIL CLOSED. Unlike the spawn lock (which only narrows a race and runs
// unlocked when it cannot lock), a destructive agent step never runs
// unlocked: no lock dir, or a live holder past the deadline, throws
// `AgentLockBusyError` and nothing is done. STRICT ownership: the lock is
// stolen only from a holder whose process is gone (a close can spend a
// long time in git cleanup, well past the spawn lock's stale budget), and
// a holder never removes a lock someone else took. See src/file-lock.ts.
//
// The lock lives beside the DB it protects (`<db dir>/locks/`), so two
// databases never contend and a test DB in a temp dir locks in that dir.

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Db } from "../db.js";
import { locksDir, withFileLock } from "../file-lock.js";
import { AgentLockBusyError } from "./errors.js";

/** Lock directory for an agent name. Workstream and agent names share the
 *  charset `[a-z0-9_-]`, so `.` keeps `a-b`+`c` apart from `a`+`b-c`. */
export function agentLockPath(db: Db, workstream: string, name: string): string {
  const base = db.memory || db.name === "" ? locksDir() : join(dirname(db.name), "locks");
  return join(base, `agent-${workstream}.${name}.lock`);
}

/** Run `fn` holding the agent's lock; throws `AgentLockBusyError` instead
 *  of running when it cannot be taken. */
export async function withAgentLock<T>(
  db: Db,
  workstream: string,
  name: string,
  fn: () => Promise<T>,
  opts?: { acquireTimeoutMs?: number },
): Promise<T> {
  return withFileLock(agentLockPath(db, workstream, name), `${workstream}/${name}`, fn, {
    strict: true,
    ...(opts?.acquireTimeoutMs !== undefined ? { acquireTimeoutMs: opts.acquireTimeoutMs } : {}),
    timeoutEnvVar: "MU_AGENT_LOCK_TIMEOUT_MS",
    onUnavailable: () => {
      throw new AgentLockBusyError(name, workstream);
    },
  });
}

/**
 * The spawn-attempt lock: one cross-process lock per (task, attempt key),
 * held for a whole `agent spawn --task` attempt (reservation to outcome), so
 * two callers of the same attempt never both spawn or send. Strict like the
 * agent lock (fails closed, stolen only from a dead holder), and unlike the
 * advisory spawn lock, which runs unlocked when it cannot lock. A long DB
 * transaction is not the mechanism: the attempt spans panes and sockets.
 */
export function spawnAttemptLockPath(db: Db, taskId: number, attemptKey: string): string {
  const base = db.memory || db.name === "" ? locksDir() : join(dirname(db.name), "locks");
  const key = createHash("sha256").update(attemptKey).digest("hex").slice(0, 16);
  return join(base, `attempt-${taskId}.${key}.lock`);
}

export async function withSpawnAttemptLock<T>(
  db: Db,
  taskId: number,
  attemptKey: string,
  fn: () => Promise<T>,
  onBusy: () => never,
): Promise<T> {
  return withFileLock(
    spawnAttemptLockPath(db, taskId, attemptKey),
    `task ${taskId}/${attemptKey}`,
    fn,
    {
      strict: true,
      timeoutEnvVar: "MU_AGENT_LOCK_TIMEOUT_MS",
      onUnavailable: onBusy,
    },
  );
}
