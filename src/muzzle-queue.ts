// mu — a worker queued in muzzle is waiting, not stalled (spec D14).
//
// muzzle queues heavy shell commands for the machine's slots. A worker whose
// command waits there fires no harness hook for as long as it waits, so its
// pane looks like a turn that went quiet. `muzzle status --json` names each
// waiting muzzle's pid (and the tmux pane it started from); a waiter whose
// pid runs under an agent's pane process means that agent is queued. The
// pid, not the recorded pane, decides: pane ids repeat across tmux servers
// (mu's private test server, a nested tmux), a process tree does not.
//
// Only agents off the ctl channel are looked up: pi reports its running tool
// over ctl, and its readings stay exactly as they were. With no muzzle on
// PATH, or no waiter, nothing is queued and no process table is read.

import { execFileCapture } from "./exec-file.js";
import { activeMux } from "./mux/detect.js";

/** One waiting muzzle, from `muzzle status --json`'s `waiting` list. */
export interface MuzzleWaiter {
  pid: number;
  /** The `$TMUX_PANE` it was started from; null when unset or from a muzzle that predates it. */
  pane: string | null;
}

export type MuzzleRunner = () => Promise<string | null>;
/** pid → parent pid, of every process on the machine. */
export type ProcessParents = () => Promise<Map<number, number>>;

/** The queue moves on the scale of builds; a wait tick must not spawn muzzle every poll. */
const MUZZLE_CACHE_MS = 5_000;
/** How far up a waiter's ancestry the pane process may be. */
const MAX_DEPTH = 64;

let runnerForTests: MuzzleRunner | null = null;
let parentsForTests: ProcessParents | null = null;
let cache: { at: number; stdout: string | null } | undefined;

const defaultRunner: MuzzleRunner = async () => {
  try {
    const r = await execFileCapture("muzzle", ["status", "--json"], { timeoutMs: 3_000 });
    return r.exitCode === 0 ? r.stdout : null;
  } catch {
    return null;
  }
};

const defaultParents: ProcessParents = async () => {
  const parents = new Map<number, number>();
  const r = await execFileCapture("ps", ["-A", "-o", "pid=", "-o", "ppid="], { timeoutMs: 3_000 });
  if (r.exitCode !== 0) return parents;
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && !Number.isNaN(pid) && !Number.isNaN(ppid)) {
      parents.set(pid, ppid);
    }
  }
  return parents;
};

/** Test seam: what `muzzle status --json` prints (null: no muzzle). Resets the cache. */
export function setMuzzleRunnerForTests(run: MuzzleRunner | null): void {
  runnerForTests = run;
  cache = undefined;
}

/** Test seam: the process table's parent links. */
export function setProcessParentsForTests(read: ProcessParents | null): void {
  parentsForTests = read;
}

/** The waiting muzzles in a `muzzle status --json` reply; [] for anything else. */
export function parseMuzzleWaiters(stdout: string): MuzzleWaiter[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const waiting = (parsed as { waiting?: unknown } | null)?.waiting;
  if (!Array.isArray(waiting)) return [];
  return waiting.flatMap((w: unknown): MuzzleWaiter[] => {
    const { pid, pane } = (w ?? {}) as { pid?: unknown; pane?: unknown };
    // A muzzle older than the field names no pid: it cannot be placed.
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return [];
    return [{ pid, pane: typeof pane === "string" ? pane : null }];
  });
}

/**
 * The panes (of `panes`, pane id → the pid of its first process) with a
 * waiter in their process tree: the waiter's pid, or one of its ancestors
 * within MAX_DEPTH hops, is the pane's process. Pure.
 */
export function panesWithWaiters(
  waiters: readonly MuzzleWaiter[],
  panes: ReadonlyMap<string, number>,
  parents: ReadonlyMap<number, number>,
): Set<string> {
  const byPid = new Map<number, string>();
  for (const [paneId, pid] of panes) byPid.set(pid, paneId);
  const out = new Set<string>();
  for (const w of waiters) {
    let pid: number | undefined = w.pid;
    for (let hop = 0; pid !== undefined && pid > 1 && hop <= MAX_DEPTH; hop++) {
      const pane = byPid.get(pid);
      if (pane !== undefined) {
        out.add(pane);
        break;
      }
      pid = parents.get(pid);
    }
  }
  return out;
}

async function readWaiters(now: number): Promise<MuzzleWaiter[]> {
  if (cache === undefined || now - cache.at >= MUZZLE_CACHE_MS) {
    let stdout: string | null;
    try {
      stdout = await (runnerForTests ?? defaultRunner)();
    } catch {
      stdout = null;
    }
    cache = { at: now, stdout };
  }
  return cache.stdout === null ? [] : parseMuzzleWaiters(cache.stdout);
}

/**
 * Which of `paneIds` hold a muzzle run waiting for slots. Best effort: no
 * muzzle, an unreadable process table or a pane the mux cannot place reads
 * as not queued, never as an error.
 */
export async function queuedPanes(
  paneIds: readonly string[],
  opts: { now?: number } = {},
): Promise<Set<string>> {
  if (paneIds.length === 0) return new Set();
  const waiters = await readWaiters(opts.now ?? Date.now());
  if (waiters.length === 0) return new Set();
  const panes = new Map<string, number>();
  try {
    const mux = await activeMux();
    for (const id of new Set(paneIds)) {
      try {
        const pid = await mux.panePid?.(id);
        if (pid !== undefined) panes.set(id, pid);
      } catch {
        // A pane the mux cannot place is not queued.
      }
    }
  } catch {
    return new Set();
  }
  if (panes.size === 0) return new Set();
  let parents: Map<number, number>;
  try {
    parents = await (parentsForTests ?? defaultParents)();
  } catch {
    return new Set();
  }
  return panesWithWaiters(waiters, panes, parents);
}
