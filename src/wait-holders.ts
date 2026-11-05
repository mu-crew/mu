// mu — which live processes wait as a caller.
//
// `--as <caller>` lets a process without a managed env (a harness's Stop
// hook, a script) wait as a caller. Two waits as one caller would race for
// the same events, so `--as` is refused while another live process waits as
// that caller, and the Stop hook lets the turn end while one does (spec D7,
// D9). `wait_registrations` cannot answer this: a wait that died leaves
// `waiting` behind. So every wait marks itself, one file per caller,
// `<state dir>/waiters/<caller hash>/<pid>.json`, removed when it ends. A file
// whose process is gone, or whose pid now names a later process, is no holder
// and is pruned by the next reader.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir } from "./state-dir.js";

/** One live wait's mark. */
export interface WaitHolder {
  caller: string;
  pid: number;
  /** The process's start, in ms since the epoch: tells a reused pid from the holder. */
  startedMs: number;
}

/** A process start read from the process table, in ms; null when unreadable. */
export type StartReader = (pid: number) => number | null;

/** Slack between this process's own start estimate and `ps`'s whole-second `lstart`. */
const START_SLACK_MS = 2000;

/** Thrown when `--as <caller>` names a caller another live process already waits as. */
export class CallerBusyError extends Error {
  override readonly name = "CallerBusyError";
  constructor(
    public readonly caller: string,
    public readonly pid: number,
  ) {
    super(
      `--as ${caller}: process ${pid} already waits as this caller; its wait returns the events (stop it first, or let it return)`,
    );
  }
}

export function waitersDir(): string {
  return join(defaultStateDir(), "waiters");
}

function callerDir(caller: string): string {
  return join(waitersDir(), createHash("sha256").update(caller).digest("hex").slice(0, 16));
}

/** `ps -o lstart=` of `pid`, parsed as murmur parses it. */
const psStart: StartReader = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const ms = Date.parse(out.trim().replace(/\s+/g, " "));
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** This process's start, in ms since the epoch. */
function selfStartedMs(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Mark this process as waiting for each of `callers`. Returns the release,
 * which is idempotent and also runs at exit. Best effort: a state dir that
 * cannot be written marks nothing (the wait itself still runs).
 *
 * `refuse` (the `--as` callers) marks first and checks after: when another
 * live process also waits as one of them, this mark is released and
 * CallerBusyError thrown. Two `--as` waits racing for one caller then each see
 * the other's mark, and both refusing is the safe side; a check before the
 * mark would let both through.
 */
export function holdCallers(
  callers: readonly string[],
  opts: { refuse?: readonly string[]; startOf?: StartReader } = {},
): () => void {
  const files: string[] = [];
  const startedMs = selfStartedMs();
  for (const caller of new Set(callers)) {
    const dir = callerDir(caller);
    const file = join(dir, `${process.pid}.json`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const holder: WaitHolder = { caller, pid: process.pid, startedMs };
      writeFileSync(`${file}.tmp`, `${JSON.stringify(holder)}\n`);
      renameSync(`${file}.tmp`, file);
      files.push(file);
    } catch {
      // best effort
    }
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);
    for (const f of files) rmSync(f, { force: true });
  };
  process.on("exit", release);
  for (const caller of opts.refuse ?? []) {
    const holder = liveHolder(caller, opts.startOf !== undefined ? { startOf: opts.startOf } : {});
    if (holder === undefined) continue;
    release();
    throw new CallerBusyError(caller, holder.pid);
  }
  return release;
}

/**
 * A live process other than this one that waits as `caller`, or undefined.
 * A mark whose pid is dead, or whose pid started at another time (reused), is
 * removed. An unreadable start keeps a live pid a holder: refusing is the safe
 * side.
 */
export function liveHolder(
  caller: string,
  opts: { startOf?: StartReader; self?: number } = {},
): WaitHolder | undefined {
  const dir = callerDir(caller);
  const self = opts.self ?? process.pid;
  const startOf = opts.startOf ?? psStart;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    let holder: WaitHolder;
    try {
      holder = JSON.parse(readFileSync(file, "utf8")) as WaitHolder;
    } catch {
      continue; // mid-write or foreign: not proof of a holder
    }
    if (holder.caller !== caller || typeof holder.pid !== "number" || holder.pid === self) continue;
    const alive = pidAlive(holder.pid);
    const started = alive ? startOf(holder.pid) : null;
    if (!alive || (started !== null && Math.abs(started - holder.startedMs) > START_SLACK_MS)) {
      rmSync(file, { force: true });
      continue;
    }
    return holder;
  }
  return undefined;
}
