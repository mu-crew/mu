// mu — generic cross-process advisory lock, via atomic `fs.mkdir`.
//
// Extracted from src/agents/spawn-lock.ts, which had exactly this logic
// keyed to a tmux session name. Segments need the same primitive keyed to
// a sync directory, and two copies of a lock implementation is how they
// drift — so the mechanism lives here once and both callers name their own
// resource. spawn-lock.ts keeps its session-specific wrapper and its
// tests; only the body moved.
//
// Why a lockfile at all: every `mu` invocation is a separate short-lived
// process, so there is no in-process mutex to lean on. `fs.mkdir` is
// atomic and fails EEXIST when the directory exists — the classic
// primitive, no dependency (honours the ROADMAP anti-feature pledge).
//
// BEST-EFFORT BY DEFAULT. A lock that cannot be taken (a read-only state
// dir, or still contended at the deadline) falls through to running the
// body UNLOCKED rather than failing the command. That suits the spawn
// lock, which only narrows a race. A caller whose body must never run
// unlocked passes `onUnavailable`, which runs INSTEAD of the body: the
// segment flush does, because an unlocked append can interleave partial
// lines or race another flush's self-repair truncate.
//
// STRICT MODE (`strict: true`, the agent lock) is a different protocol, and
// fails closed on every error:
//   - PUBLISH. The lock dir is built complete (meta.json inside) under a
//     private name and `rename`d onto the lock path: it appears whole or
//     not at all, so no lock without an owner record exists, and a failed
//     metadata write is a failed acquire (`onUnavailable`), never a body
//     run without a lock.
//   - STALE RECLAIM. An aged lock is reclaimed only when its holder's pid
//     is gone and its record is readable. Reclaiming takes an O_EXCL claim
//     file (`<lock>.reclaim`), re-probes the SAME holder under the claim,
//     and only then removes the dir: two removers cannot both proceed, and
//     none can remove a newer holder that took the path after its probe.
//     An unreadable, missing or foreign record is never reclaimed. A claim left by a
//     crashed remover blocks (fails closed) until it is removed by hand.
//   - RELEASE is by token: a holder removes the lock only if it is still its.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultStateDir } from "./db.js";

/** Sub-directory of the state dir holding lock directories. */
export function locksDir(): string {
  return join(defaultStateDir(), "locks");
}

/** Default: max time to wait to acquire before giving up. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;
/** A held lock older than this is presumed abandoned (crashed process). */
const DEFAULT_STALE_LOCK_MS = 30_000;
/** Poll interval while spinning. */
const RETRY_INTERVAL_MS = 25;

export interface FileLockOptions<T = unknown> {
  acquireTimeoutMs?: number;
  staleLockMs?: number;
  /** Env var consulted for the acquire timeout, if any. */
  timeoutEnvVar?: string;
  /** Run instead of `fn` when the lock cannot be taken (contended past
   *  the deadline, or the lock dir cannot be created). Absent, `fn` runs
   *  unlocked. */
  onUnavailable?: () => T;
  /** Strict ownership (see the header): an aged lock is reclaimed only
   *  when the process that took it is gone (pid probe on this host), never
   *  because it is old, and only under an exclusive claim. A holder doing
   *  slow work (git cleanup, a pane kill) keeps its lock for as long as it
   *  lives. Anything unreadable or failing is unavailable. Pair it with
   *  `onUnavailable` to fail closed. */
  strict?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resolveTimeout(opts?: FileLockOptions<unknown>): number {
  const envVar = opts?.timeoutEnvVar;
  if (envVar !== undefined) {
    const raw = process.env[envVar];
    if (raw !== undefined && raw !== "") {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
}

/** True unless `pid` is certainly gone (ESRCH). EPERM means it exists. */
function pidMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Best-effort staleness probe (legacy mode): old enough. A vanished lock
 *  returns false so the caller simply retries the mkdir. */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** Strict probe: the token of a lock that is old AND whose holder is
 *  certainly gone; undefined for anything else, unreadable included. */
async function staleHolder(path: string, staleMs: number): Promise<string | undefined> {
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs <= staleMs) return undefined;
  } catch {
    return undefined;
  }
  const meta = await readFileLockMeta(path);
  if (meta === null || typeof meta.pid !== "number" || typeof meta.token !== "string") {
    return undefined;
  }
  return pidMayBeAlive(meta.pid) ? undefined : meta.token;
}

/** Remove a stale strict lock, exclusively. True when it is gone and the
 *  caller should retry the acquire; false when it is not stale, someone
 *  else is reclaiming, or anything failed. */
async function reclaimStale(lockPath: string, staleMs: number): Promise<boolean> {
  const seen = await staleHolder(lockPath, staleMs);
  if (seen === undefined) return false;
  const claim = `${lockPath}.reclaim`;
  try {
    await writeFile(claim, String(process.pid), { flag: "wx" });
  } catch {
    return false;
  }
  try {
    // Under the claim no other remover runs, and a stale lock is not
    // taken (the path is occupied): the holder seen above is still the
    // one there, or the lock is already gone. Anything else is left alone.
    if ((await staleHolder(lockPath, staleMs)) !== seen) return false;
    await rm(lockPath, { recursive: true });
    return true;
  } catch {
    return false;
  } finally {
    await rm(claim, { force: true }).catch(() => {});
  }
}

/** Strict acquire: the token when taken, undefined when unavailable. */
async function acquireStrict(
  lockPath: string,
  label: string,
  staleMs: number,
  deadline: number,
): Promise<string | undefined> {
  const token = randomBytes(8).toString("hex");
  const tmp = `${lockPath}.acq-${token}`;
  try {
    await mkdir(tmp);
    await writeFile(
      join(tmp, "meta.json"),
      JSON.stringify({ pid: process.pid, label, acquiredAt: new Date().toISOString(), token }),
    );
    for (;;) {
      try {
        await rename(tmp, lockPath); // whole or not at all; fails while held
        return token;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") return undefined;
      }
      if (await reclaimStale(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) return undefined;
      await sleep(RETRY_INTERVAL_MS);
    }
  } catch {
    return undefined;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run `fn` while holding the lock directory at `lockPath`.
 *
 * Releases in a `finally`, so a throwing `fn` never leaks the lock.
 * Records pid + acquisition time in `meta.json` for stale-lock
 * diagnostics.
 */
export async function withFileLock<T>(
  lockPath: string,
  label: string,
  fn: () => Promise<T>,
  opts?: FileLockOptions<T>,
): Promise<T> {
  const staleMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + resolveTimeout(opts);
  const onUnavailable = opts?.onUnavailable;
  const unlocked = async (): Promise<T> =>
    onUnavailable === undefined ? await fn() : onUnavailable();
  let held = false;

  try {
    await mkdir(dirname(lockPath), { recursive: true });
  } catch {
    // Cannot even create the locks dir: run unlocked rather than refuse.
    return await unlocked();
  }

  if (opts?.strict === true) {
    const token = await acquireStrict(lockPath, label, staleMs, deadline);
    if (token === undefined) return await unlocked();
    try {
      return await fn();
    } finally {
      // Only a lock that is still ours: never a newer holder's.
      if ((await readFileLockMeta(lockPath))?.token === token) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  while (!held) {
    try {
      await mkdir(lockPath); // atomic; EEXIST if already held
      held = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return await unlocked();
      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return await unlocked();
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  // Our token: release removes the lock only if it is still ours. A lock
  // stolen from us (aged out, legacy mode) now belongs to its new holder.
  const token = randomBytes(8).toString("hex");
  const wrote = await writeFile(
    join(lockPath, "meta.json"),
    JSON.stringify({ pid: process.pid, label, acquiredAt: new Date().toISOString(), token }),
  ).then(
    () => true,
    () => false,
  );

  try {
    return await fn();
  } finally {
    // Wrote no record: nothing to compare, remove as before. Wrote one and
    // it is gone or another's: the lock was stolen, and is not ours to remove.
    if (!wrote || (await readFileLockMeta(lockPath))?.token === token) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Read a held lock's metadata, or null. Exposed for tests. */
export async function readFileLockMeta(
  lockPath: string,
): Promise<{ pid: number; label: string; acquiredAt: string; token?: string } | null> {
  try {
    const raw = await readFile(join(lockPath, "meta.json"), "utf8");
    return JSON.parse(raw) as { pid: number; label: string; acquiredAt: string; token?: string };
  } catch {
    return null;
  }
}
