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
// - claim: muzzle on PATH and no outer claim. Each row claims w slots; at most floor(budget / w)
//   rows run at once (more would only queue).
// - nested: the rig itself runs inside a muzzle claim (MUZZLE_SLOTS set, e.g. the user's mu-eval
//   rule or pi's muzzle extension). A nested `muzzle run` claims nothing (muzzle D17), so rows take
//   no claim of their own and the rig runs at most floor(MUZZLE_SLOTS / w) rows (at least 1) inside
//   the outer claim.
// - unmanaged: no muzzle. At most floor((cores * 1.5 - 2) / w) rows, muzzle's own default budget.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpus } from "node:os";

export type RowKind = "probe" | "guess" | "aut" | "design";

/**
 * Slots per row: ceil(1.5 x the row's average cores), muzzle's 1.5 slots per core. Measured
 * 2026-11-08 on the mac (16 cores), one row at a time with scripted models (a real model adds about
 * 1 CPU-s and a wait): probe 0.37-0.65 cores (6 CPU-s, peak 16 processes), guess 0.6 (1.5 CPU-s,
 * peak 15), AUT run 0.56-0.8 (11-35 CPU-s, peak 29); a designer is one pi that may build.
 * docs/eval/eval-load.md. EVAL_ROW_SLOTS_<KIND> (e.g. EVAL_ROW_SLOTS_AUT=3) overrides.
 */
export const ROW_SLOTS: Record<RowKind, number> = { probe: 1, guess: 1, aut: 2, design: 2 };

export interface RowPlan {
  mode: "claim" | "nested" | "unmanaged";
  slots: number;
  concurrency: number;
  /** One line for the run's log: why this many rows at once. */
  note: string;
}

/** muzzle's budget: the first line of `muzzle status` ("budget 22 slots ..."), else its default. */
function muzzleBudget(bin: string): number {
  const r = spawnSync(bin, ["status"], { encoding: "utf8", timeout: 10_000 });
  const m = /budget (\d+) slots/.exec(r.stdout ?? "");
  return m?.[1] ? Number(m[1]) : defaultBudget();
}

const defaultBudget = (): number => Math.max(1, Math.floor(cpus().length * 1.5) - 2);

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

/** How many `kind` rows run at once and whether each claims its own slots. */
export function planRows(
  kind: RowKind,
  requested: number,
  env: NodeJS.ProcessEnv = process.env,
  muzzle: string | null = findMuzzle(env),
  budget: (bin: string) => number = muzzleBudget,
): RowPlan {
  const slots = rowSlots(kind, env);
  const want = Math.max(1, Math.floor(requested) || 1);
  const rowsIn = (total: number): number => Math.max(1, Math.floor(total / slots));
  const outer = Number(env.MUZZLE_SLOTS);
  if (Number.isFinite(outer) && outer > 0) {
    const concurrency = Math.min(want, rowsIn(outer));
    return {
      mode: "nested",
      slots,
      concurrency,
      note: `eval: inside a muzzle claim of ${outer} slots: ${concurrency} ${kind} row(s) at once (${slots} slots each), no per-row claims`,
    };
  }
  if (muzzle === null) {
    const concurrency = Math.min(want, rowsIn(defaultBudget()));
    return {
      mode: "unmanaged",
      slots,
      concurrency,
      note: `eval: no muzzle on PATH: ${concurrency} ${kind} row(s) at once (${slots} slots each of a ${defaultBudget()}-slot budget), unclaimed`,
    };
  }
  const total = budget(muzzle);
  const concurrency = Math.min(want, rowsIn(total));
  return {
    mode: "claim",
    slots,
    concurrency,
    note: `eval: ${concurrency} ${kind} row(s) at once, each under its own muzzle claim of ${slots} slots (budget ${total})`,
  };
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

/** Wait for muzzle to admit a holder; resolves with a release function. */
function acquire(bin: string, kind: RowKind, slots: number): Promise<() => Promise<void>> {
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
      if (out.includes("admitted")) res(release);
    });
    child.on("error", (e) => rej(new RowClaimError(`muzzle claim failed: ${e.message}`)));
    child.on("close", (code) => {
      if (!out.includes("admitted"))
        rej(new RowClaimError(`muzzle claim exited ${code} before admission: ${err.trim()}`));
    });
  });
}

/** The claim each `kind` row runs under: its own muzzle holder in claim mode, else none. */
export function rowClaim(kind: RowKind, plan: RowPlan, bin: string | null): Claim {
  if (plan.mode !== "claim" || bin === null) return (fn) => fn();
  return async (fn) => {
    const release = await acquire(bin, kind, plan.slots);
    try {
      return await fn();
    } finally {
      await release();
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
  const claim = rowClaim(kind, plan, plan.bin);
  await Promise.all(Array.from({ length: plan.concurrency }, () => worker(claim)));
}

/** One unit of work outside a pool (a designer session, a sequential check). */
export async function withRowClaim<T>(kind: RowKind, fn: () => Promise<T>): Promise<T> {
  const plan = planFor(kind, 1);
  return rowClaim(kind, plan, plan.bin)(fn);
}

/** planRows on the process env; under vitest with no fake muzzle, the requested rows unclaimed. */
function planFor(kind: RowKind, requested: number): RowPlan & { bin: string | null } {
  const env = process.env;
  if (env.VITEST && !env.EVAL_MUZZLE_BIN) {
    const concurrency = Math.max(1, Math.floor(requested) || 1);
    return { mode: "unmanaged", slots: rowSlots(kind, env), concurrency, note: "", bin: null };
  }
  const bin = findMuzzle(env);
  return { ...planRows(kind, requested, env, bin), bin };
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
