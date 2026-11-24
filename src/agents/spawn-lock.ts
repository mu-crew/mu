// Cross-process mux topology lock for managed pane creation and session teardown.
//
// Why this exists: every `mu` invocation is a separate short-lived
// process, so there is no in-process mutex to lean on. When an operator
// (or the model) fires several spawns in parallel —
//
//   for n in 1 2 3; do mu agent spawn scout-$n -w scratch & done; wait
//
// — each process runs the check-then-act inside `mux.spawnAgent`:
// "does mu-scratch exist?" → all see "no" → all call
// `tmux new-session -d -s mu-scratch`. Exactly one wins; the losers get
// "duplicate session", throw, and `rollbackSpawn` removes their agent
// row. Net effect: agents silently dropped (and sometimes duplicated as
// windows race).
//
// The lock is keyed on the mux SESSION name
// (the shared resource — two spawns into different sessions never
// contend). It wraps ONLY the fast topology + DB-insert section, NOT the
// slow liveness/readiness wait, so genuine parallelism (the whole point
// of `&`) is preserved: process A creates the session and inserts its
// row, releases, then waits for liveness while process B is already
// creating its own window.
//
// An unavailable lock refuses the operation; age alone never evicts a live holder.

import { join } from "node:path";
import { locksDir, withFileLock } from "../file-lock.js";
import { MuxError } from "../mux/types.js";

/** Lock directory path for a given tmux session name. The session name
 *  is already validated ([a-z0-9_-] plus the `mu-` prefix), so it is a
 *  safe path segment. Exported for tests that need to read the lock's
 *  metadata directly via readFileLockMeta. */
export function lockPathForSession(session: string): string {
  return join(locksDir(), `spawn-${session}.lock`);
}

/** Max time to wait to acquire the lock before giving up (ms). A spawn's
 *  critical section is sub-second; this is generous headroom for a deep
 *  parallel fan-out queued behind one slow tmux server. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

/** Minimum age for reclaiming a lock whose holder is proven gone. */
const STALE_LOCK_MS = 30_000;

export interface SpawnLockOptions {
  acquireTimeoutMs?: number;
  staleLockMs?: number;
}

/** Run `fn` under the per-session topology lock, or fail without running it. */
export async function withSpawnLock<T>(
  session: string,
  fn: () => Promise<T>,
  opts?: SpawnLockOptions,
): Promise<T> {
  return withFileLock(lockPathForSession(session), session, fn, {
    strict: true,
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    staleLockMs: opts?.staleLockMs ?? STALE_LOCK_MS,
    timeoutEnvVar: "MU_SPAWN_LOCK_TIMEOUT_MS",
    onUnavailable: () => {
      throw new MuxError(`cannot lock mux session ${session}; retry when it is available`);
    },
  });
}
