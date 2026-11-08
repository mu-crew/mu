// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Per-row muzzle claims. Every unit of AUT work the rig starts (a probe row, an AUT run, a
// cold-guess guess, a designer session) holds its own muzzle claim of ROW_SLOTS[kind] slots while
// it runs, so the host's queue sees the rig's real load and other agents' gates get their turn.
//
// A row's work runs in this process (sandboxes, tmux servers, mu calls), so the claim is a holder:
// `muzzle run --rule mu-eval-<kind> --slots <w> -- sh -c 'echo admitted; exec cat >/dev/null'`.
// The row starts when the holder prints `admitted` and ends by closing its stdin; if the rig dies
// the pipe closes, the holder exits and muzzle frees the slots.
//
// Modes (planRows):
// - claim: muzzle usable and the rig in no claim. Each row claims w slots; at most
//   floor(budget / w) rows run at once (more would only queue). The first admitted holder is
//   checked in `muzzle status --json`: a holder muzzle ran nested holds nothing, so the rig
//   switches to the capped mode and says so.
// - nested: the rig runs inside a muzzle claim, found the way muzzle finds it (D17): MUZZLE_SLOTS
//   set, or a live holder that is an ancestor of the rig or leads an ancestor's process group (pi's
//   muzzle extension leaves MUZZLE_SLOTS and MUZZLE_HOLD unset). A nested `muzzle run` claims
//   nothing, so rows take no claim of their own and the rig runs floor(outer slots / w) rows (at
//   least 1) inside the outer claim.
// - capped: no muzzle on PATH, `muzzle status` unusable, or nested with an unknown outer weight.
//   Unclaimed, at most floor(LOW_CAP_SLOTS / w) rows (2 probe rows, 1 AUT run), with a warning.
//
// Every unit runs inside a row context (rowPool, withRowClaim); createSandbox refuses to run
// outside one (assertInRow), so a new AUT path that skips its claim fails at once.
import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

export type RowKind = "probe" | "guess" | "aut" | "design";

/**
 * Slots per row: ceil(1.5 x the row's average cores), muzzle's 1.5 slots per core. Measured
 * 2026-11-08 on the mac (16 cores), one row at a time with scripted models (a real model adds about
 * 1 CPU-s and a wait): probe 0.37-0.65 cores (6 CPU-s, peak 16 processes), guess 0.6 (1.5 CPU-s,
 * peak 15), AUT run 0.56-0.8 (11-35 CPU-s, peak 29); a designer is one pi that may build.
 * docs/eval/eval-load.md. EVAL_ROW_SLOTS_<KIND> (e.g. EVAL_ROW_SLOTS_AUT=3) overrides.
 */
export const ROW_SLOTS: Record<RowKind, number> = { probe: 1, guess: 1, aut: 2, design: 2 };

/** The slots the capped mode runs in when muzzle can't account for the rows: 2 probe rows, 1 AUT run. */
export const LOW_CAP_SLOTS = 2;

export interface RowPlan {
  mode: "claim" | "nested" | "capped";
  slots: number;
  concurrency: number;
  /** One line for the run's log: why this many rows at once. */
  note: string;
}

/** The parts of `muzzle status --json` the rig reads. */
export interface MuzzleStatus {
  budget: number;
  holders: { slots: number; pid: number; pgid?: number | null }[];
}

type StatusReader = (bin: string) => MuzzleStatus | null;

/** `muzzle status --json`, or null when muzzle fails or prints something else. */
const realStatus: StatusReader = (bin) => {
  const r = spawnSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout ?? "") as Partial<MuzzleStatus>;
    if (typeof j.budget !== "number" || !Array.isArray(j.holders)) return null;
    return { budget: j.budget, holders: j.holders };
  } catch {
    return null;
  }
};
let statusReader: StatusReader = realStatus;

/** Tests: replace how `muzzle status --json` is read (null restores the real one). */
export function setStatusForTests(s: StatusReader | null): void {
  statusReader = s ?? realStatus;
}

/** This process and its ancestors with their process groups, from one `ps`. */
type Ancestry = () => { pid: number; pgid: number }[];
const realAncestry: Ancestry = () => {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  const procs = new Map<number, { ppid: number; pgid: number }>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid !== undefined && ppid !== undefined && pgid !== undefined && Number.isFinite(pid))
      procs.set(pid, { ppid, pgid });
  }
  const out: { pid: number; pgid: number }[] = [];
  for (let pid = process.pid, n = 0; pid > 1 && n < 200; n++) {
    const p = procs.get(pid);
    if (!p) break;
    out.push({ pid, pgid: p.pgid });
    pid = p.ppid;
  }
  return out;
};
let ancestry: Ancestry = realAncestry;

/** Tests: replace the ancestry walk (null restores the real one). */
export function setAncestryForTests(a: Ancestry | null): void {
  ancestry = a ?? realAncestry;
}

/** D17's ancestry test: the live holder whose muzzle is an ancestor of the rig or whose group an ancestor is in. */
export function outerHolder(
  st: MuzzleStatus,
  ancestors: readonly { pid: number; pgid: number }[],
): MuzzleStatus["holders"][number] | null {
  return (
    st.holders.find((h) =>
      ancestors.some((a) => a.pid === h.pid || (h.pgid != null && h.pgid === a.pgid)),
    ) ?? null
  );
}

/** The muzzle binary on PATH, or null. EVAL_MUZZLE_BIN names another one (tests). */
export function findMuzzle(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.EVAL_MUZZLE_BIN) return env.EVAL_MUZZLE_BIN;
  // tests never queue on the user's real muzzle; claim tests name a fake through EVAL_MUZZLE_BIN
  if (env.VITEST) return null;
  const r = spawnSync("sh", ["-c", "command -v muzzle"], { encoding: "utf8", env });
  const p = (r.stdout ?? "").trim();
  return r.status === 0 && p !== "" ? p : null;
}

export function rowSlots(kind: RowKind, env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env[`EVAL_ROW_SLOTS_${kind.toUpperCase()}`]);
  return Number.isInteger(v) && v > 0 ? v : ROW_SLOTS[kind];
}

const rowsIn = (total: number, slots: number): number => Math.max(1, Math.floor(total / slots));

/** The capped plan: unclaimed, LOW_CAP_SLOTS worth of rows, and why. */
function capped(kind: RowKind, want: number, slots: number, why: string): RowPlan {
  const concurrency = Math.min(want, rowsIn(LOW_CAP_SLOTS, slots));
  return {
    mode: "capped",
    slots,
    concurrency,
    note: `eval: WARNING ${why}: ${concurrency} ${kind} row(s) at once, unclaimed (low cap of ${LOW_CAP_SLOTS} slots, ${slots} per row)`,
  };
}

/** The nested plan: floor(outer / w) rows inside the outer claim. */
function nested(kind: RowKind, want: number, slots: number, outer: number, how: string): RowPlan {
  const concurrency = Math.min(want, rowsIn(outer, slots));
  return {
    mode: "nested",
    slots,
    concurrency,
    note: `eval: inside a muzzle claim of ${outer} slots (${how}): ${concurrency} ${kind} row(s) at once (${slots} slots each), no per-row claims`,
  };
}

/**
 * How many `kind` rows run at once and whether each claims its own slots. `requested` is the
 * caller's --concurrency; Infinity (`--concurrency auto`) means as many as the plan allows.
 */
export function planRows(
  kind: RowKind,
  requested: number,
  env: NodeJS.ProcessEnv = process.env,
  muzzle: string | null = findMuzzle(env),
): RowPlan {
  const slots = rowSlots(kind, env);
  const want =
    requested === Number.POSITIVE_INFINITY ? requested : Math.max(1, Math.floor(requested) || 1);
  const outer = Number(env.MUZZLE_SLOTS);
  if (Number.isFinite(outer) && outer > 0) return nested(kind, want, slots, outer, "MUZZLE_SLOTS");
  if (muzzle === null) return capped(kind, want, slots, "no muzzle on PATH");
  const st = statusReader(muzzle);
  if (st === null) return capped(kind, want, slots, `\`${muzzle} status --json\` failed`);
  const holder = outerHolder(st, ancestry());
  if (holder !== null) return nested(kind, want, slots, holder.slots, `holder pid ${holder.pid}`);
  const concurrency = Math.min(want, rowsIn(st.budget, slots));
  return {
    mode: "claim",
    slots,
    concurrency,
    note: `eval: ${concurrency} ${kind} row(s) at once, each under its own muzzle claim of ${slots} slots (budget ${st.budget})`,
  };
}

/** `--concurrency <n|auto>`: a number, or Infinity for auto (planRows' cap). */
export function parseConcurrency(v: string | undefined, dflt: number | "auto"): number {
  const s = v ?? String(dflt);
  if (s === "auto") return Number.POSITIVE_INFINITY;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--concurrency wants a positive integer or auto, got ${s}`);
  return n;
}

/** Runs one row's work under its claim. */
export type Claim = <T>(fn: () => Promise<T>) => Promise<T>;

type Spawner = (bin: string, args: string[]) => ChildProcess;
const realSpawn: Spawner = (bin, args) => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
let spawner: Spawner = realSpawn;

/** Tests: replace how the holder is started (null restores the real spawn). */
export function setClaimSpawnForTests(s: Spawner | null): void {
  spawner = s ?? realSpawn;
}

export class RowClaimError extends Error {}

export const HOLDER = ["sh", "-c", "echo admitted; exec cat >/dev/null"];

export const claimArgs = (kind: RowKind, slots: number): string[] => [
  "run",
  "--rule",
  `mu-eval-${kind}`,
  "--slots",
  String(slots),
  "--",
  ...HOLDER,
];

interface Held {
  pid: number | undefined;
  release: () => Promise<void>;
}

/** Wait for muzzle to admit a holder. */
function acquire(bin: string, kind: RowKind, slots: number): Promise<Held> {
  const child = spawner(bin, claimArgs(kind, slots));
  let err = "";
  child.stderr?.on("data", (d: Buffer) => {
    err = (err + d.toString()).slice(-2000);
  });
  const exited = new Promise<void>((res) => {
    child.on("close", () => res());
    child.on("error", () => res());
  });
  const release = async (): Promise<void> => {
    child.stdin?.end();
    await exited;
  };
  return new Promise((res, rej) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("admitted")) res({ pid: child.pid, release });
    });
    child.on("error", (e) => rej(new RowClaimError(`muzzle claim failed: ${e.message}`)));
    child.on("close", (code) => {
      if (!out.includes("admitted"))
        rej(new RowClaimError(`muzzle claim exited ${code} before admission: ${err.trim()}`));
    });
  });
}

/** A counting semaphore. */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

const inRow = new AsyncLocalStorage<RowKind>();

/** The kind of the row this code runs in, or undefined outside every row. */
export const currentRow = (): RowKind | undefined => inRow.getStore();

/**
 * Refuses AUT work (a sandbox) outside a row: every unit must run in rowPool or withRowClaim so it
 * holds its claim. Tests that build sandboxes directly (judges, the shim) are exempt under vitest.
 */
export function assertInRow(what: string): void {
  if (inRow.getStore() !== undefined || process.env.VITEST) return;
  throw new RowClaimError(
    `${what} outside a row claim: wrap the unit in withRowClaim or rowPool (tools/eval/claim.ts)`,
  );
}

/**
 * The claim each `kind` row runs under: its own muzzle holder in claim mode, else none. In claim
 * mode the first holder is checked in `muzzle status`; if it holds no slots (nested, D17) every row
 * after it runs unclaimed under the capped limit, and `log` gets one line.
 */
export function rowClaim(
  kind: RowKind,
  plan: RowPlan,
  bin: string | null,
  log: (l: string) => void = (l) => console.error(l),
): Claim {
  if (plan.mode !== "claim" || bin === null) return (fn) => inRow.run(kind, fn);
  let verdict: Promise<boolean> | null = null; // true: holders hold slots
  let cap: ReturnType<typeof limiter> | null = null;
  const unclaimed = <T>(fn: () => Promise<T>): Promise<T> => {
    cap ??= limiter(rowsIn(LOW_CAP_SLOTS, plan.slots));
    return cap(() => inRow.run(kind, fn));
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (verdict !== null && !(await verdict)) return unclaimed(fn);
    const first = verdict === null;
    let ok: (v: boolean) => void = () => {};
    if (first)
      verdict = new Promise<boolean>((r) => {
        ok = r;
      });
    let held: Held;
    try {
      held = await acquire(bin, kind, plan.slots);
    } catch (e) {
      if (first) {
        verdict = null; // the next row tries again
        ok(true);
      }
      throw e;
    }
    if (first) {
      const st = statusReader(bin);
      const holds = st?.holders.some((h) => h.pid === held.pid) ?? false;
      ok(holds);
      if (!holds) {
        log(
          `eval: WARNING the muzzle claim for a ${kind} row holds no slots (${st === null ? "muzzle status failed" : "nested in an outer claim"}): running unclaimed, ${rowsIn(LOW_CAP_SLOTS, plan.slots)} ${kind} row(s) at once`,
        );
        await held.release();
        return unclaimed(fn);
      }
    }
    try {
      return await inRow.run(kind, fn);
    } finally {
      await held.release();
    }
  };
}

/**
 * Run `worker` on planRows' concurrency, each worker given the row claim to wrap every unit of
 * work in. Replaces `Promise.all(Array.from({ length: concurrency }, worker))`.
 */
export async function rowPool(
  kind: RowKind,
  requested: number,
  worker: (claim: Claim) => Promise<void>,
  log: (l: string) => void = (l) => console.error(l),
): Promise<void> {
  const plan = planFor(kind, requested);
  if (plan.note !== "" && (plan.concurrency < requested || plan.mode !== "claim")) log(plan.note);
  const claim = rowClaim(kind, plan, plan.bin, log);
  await Promise.all(Array.from({ length: plan.concurrency }, () => worker(claim)));
}

/** One unit of work outside a pool (a designer session, a sequential check, a single run). */
export async function withRowClaim<T>(kind: RowKind, fn: () => Promise<T>): Promise<T> {
  if (inRow.getStore() !== undefined) return fn(); // already inside a row's claim
  const plan = planFor(kind, 1);
  if (plan.note !== "" && plan.mode !== "claim") console.error(plan.note);
  return rowClaim(kind, plan, plan.bin)(fn);
}

/** How many rows `--concurrency auto` (or a request) gives for `kind` on this host. */
export function rowsAtOnce(kind: RowKind, requested: number): number {
  return planFor(kind, requested).concurrency;
}

/** planRows on the process env; under vitest with no fake muzzle, the requested rows unclaimed. */
function planFor(kind: RowKind, requested: number): RowPlan & { bin: string | null } {
  const env = process.env;
  if (env.VITEST && !env.EVAL_MUZZLE_BIN) {
    const concurrency =
      requested === Number.POSITIVE_INFINITY ? 4 : Math.max(1, Math.floor(requested) || 1);
    return { mode: "capped", slots: rowSlots(kind, env), concurrency, note: "", bin: null };
  }
  const bin = findMuzzle(env);
  return { ...planRows(kind, requested, env, bin), bin };
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
