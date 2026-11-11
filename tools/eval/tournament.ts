// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Tournament driver core (spec docs/specs/2026-11-07-hill-r2-tournament.md §4, unit B3b): the
// control file, the n plan, its CMH power and the wall estimate, the R1/R2 job lists, and the review
// stops. The scoring of a round, the ranking and the cut live in tournament-score.ts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ColdRow } from "./cold-guess.ts";
import {
  type Arm,
  type Group,
  HELP_ARMS,
  type NextCase,
  type NextJob,
  type ProbeRow,
} from "./nextstep.ts";
import {
  cmhPower,
  type IccRow,
  iccModel,
  iccPooled,
  mde,
  normQuantile,
  type Plan,
  solvePlan,
} from "./stats.ts";
import type { VariantRow } from "./tournament-build.ts";
import type { Surface } from "./types.ts";

// ---- control file -------------------------------------------------------------------------------

export const ROW_ROOT = join(
  homedir(),
  ".local",
  "state",
  "mu-next",
  "eval-transcripts",
  "hill-r2",
);

/** `<root>/<group>/`: tournament.jsonl, probe.jsonl, prompts/, logs/, sealed/ (§6). */
export const rowDir = (group: Group, root = process.env.EVAL_TOURNAMENT_ROOT ?? ROW_ROOT): string =>
  join(root, group);

export const WEAK = ["claude-haiku-5-5", "gemini-3.8-flash"] as const;
export const GATE = "claude-sonnet-5-5";

export interface SetupRow {
  kind: "setup";
  group: Group;
  baseSha: string;
  baseDir: string;
  /** B0: one probe row per model came back without a model error. */
  b0: { models: string[]; providerExt: string | null; rows: { model: string; ok: boolean }[] };
  models: { weak: string[]; gate: string };
  providerExt: string | null;
  systemSha: string;
  /** ρ̂ per (case, model) from B5's base rows; `cold-guess` is the cold guard. Floored. */
  rho: Record<string, Record<string, number>>;
  /** ρ̂_pool per case, haiku and gemini pooled. Floored. */
  rhoPool: Record<string, number>;
  seed: string;
  holdouts: { ids: string[]; note: "not run, not read" };
}

export interface CasePlan {
  case: string;
  kind: "own" | "cross" | "guard";
  plan: Plan;
  /** R1 reps (own headline only: 1). */
  r1: number;
  /** MDE at 80% power: own headline on the pooled win test at B = 18, others on the first loss step. */
  mde: number | null;
  /** The arms the rounds run (a plan without them, frozen before the help arms: the case's own). */
  arms?: Arm[];
}

/** Full mode runs R1 → R2 → R3 → R4 per group; fast mode decides on R1 and gates in C7 (§4.7). */
export type Mode = "full" | "fast";

export interface FreezeRow {
  kind: "freeze";
  judgesHash: string;
  files: string[];
  /** Absent on a row frozen before fast mode existed: full. */
  mode?: Mode;
  /** Fast mode: the n_eff targets the plan was solved for. */
  targets?: { own: number; pooled: number };
  /** Fast mode: the win threshold's family level and correction (§4.7); absent: LEGACY_WIN_RULE. */
  win?: WinRule;
  nPlan: CasePlan[];
  /** CMH power per model at this plan for a broad drop from 0.8 (§4.2), keyed by the drop; absent on a row frozen before it was recorded. */
  cmhPower?: PlanPower[];
  checks: "green" | "skipped";
}

export interface RefreezeRow {
  kind: "refreeze";
  row: string;
  why: string;
  judgesHash: string;
  epoch: number;
}

/**
 * §4.7 migration: a group frozen in full mode, with R1 scored in its current epoch and no R2 score,
 * switches to fast mode keeping the epoch, so `decide --fast` reads that epoch's R1 rows. The judges
 * are re-checked: a hash that moved since the latest freeze or refreeze is named and accepted here.
 */
export interface MigrateFastRow {
  kind: "migrate_fast";
  from: "full";
  epoch: number;
  why: string;
  win: WinRule;
  judgesHash: string;
  /** The hash of the latest freeze or refreeze, and the judge files that changed since it. */
  previousJudgesHash: string;
  judgesChanged: string[];
}

export interface IsolationRow {
  kind: "isolation";
  session: string;
  model: string;
  hits: { file: string; rule: string; match: string }[];
}

export interface ReviewStopRow {
  kind: "review_stop";
  id: string;
  variant: string;
  cell: string;
  entries: string[];
  transcript: string;
  source: "probe" | "r4" | "holdout";
}

export interface ReviewDecisionRow {
  kind: "review_decision";
  stop: string;
  decision: "drop" | "continue";
  why: string;
}

export type ControlRow =
  | SetupRow
  | FreezeRow
  | RefreezeRow
  | MigrateFastRow
  | IsolationRow
  | VariantRow
  | ReviewStopRow
  | ReviewDecisionRow
  | { kind: "round_score"; round: "r1" | "r2"; epoch: number; [k: string]: unknown }
  | { kind: "cut"; round: "r1" | "r2"; epoch: number; [k: string]: unknown }
  | {
      kind: "decision" | "spend" | "scan" | "r4_score" | "final" | "final_score" | "c7_r4";
      [k: string]: unknown;
    };

export const controlFile = (dir: string): string => join(dir, "tournament.jsonl");

export function readControl(dir: string): (ControlRow & { at?: string })[] {
  const f = controlFile(dir);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ControlRow);
}

export function appendControl(dir: string, row: ControlRow): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(controlFile(dir), `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`);
}

const last = <K extends ControlRow["kind"]>(
  rows: readonly ControlRow[],
  kind: K,
): Extract<ControlRow, { kind: K }> | undefined =>
  [...rows].reverse().find((r) => r.kind === kind) as Extract<ControlRow, { kind: K }> | undefined;

export const setupOf = (rows: readonly ControlRow[]): SetupRow | undefined => last(rows, "setup");

/** Refreezes so far: rounds run before the latest one are re-run into fresh files. */
export const epochOf = (rows: readonly ControlRow[]): number => last(rows, "refreeze")?.epoch ?? 0;

/** The probe file of an epoch: `probe.jsonl`, then `probe.e<k>.jsonl` after each refreeze. */
export const probeFile = (dir: string, epoch: number): string =>
  join(dir, epoch === 0 ? "probe.jsonl" : `probe.e${epoch}.jsonl`);
export const coldFile = (dir: string, epoch: number): string =>
  join(dir, epoch === 0 ? "cold-r2.jsonl" : `cold-r2.e${epoch}.jsonl`);

/** The latest freeze or fast migration: the row the group's mode and win rule come from. */
const modeRow = (rows: readonly ControlRow[]): FreezeRow | MigrateFastRow | undefined =>
  [...rows].reverse().find((r) => r.kind === "freeze" || r.kind === "migrate_fast") as
    | FreezeRow
    | MigrateFastRow
    | undefined;

/** The mode of the latest freeze or migration (full before any freeze). */
export const modeOf = (rows: readonly ControlRow[]): Mode => {
  const r = modeRow(rows);
  return r?.kind === "migrate_fast" ? "fast" : (r?.mode ?? "full");
};

/** The fast group was switched from full mode (`migrate-fast`), not frozen fast. */
export const migratedOf = (rows: readonly ControlRow[]): MigrateFastRow | undefined => {
  const r = modeRow(rows);
  return r?.kind === "migrate_fast" ? r : undefined;
};

/** The judges' hash every command checks: the latest freeze, refreeze or migration row's. */
export const frozenHash = (rows: readonly ControlRow[]): string | undefined =>
  (
    [...rows]
      .reverse()
      .find((r) => r.kind === "freeze" || r.kind === "refreeze" || r.kind === "migrate_fast") as
      | { judgesHash: string }
      | undefined
  )?.judgesHash;

// ---- the fast win threshold (§4.7) --------------------------------------------------------------

/** How the fast win threshold corrects for the group's tests: none, over variants, or over variants × headline cases. */
export type Correction = "none" | "variants" | "bonferroni";
export const CORRECTIONS: readonly Correction[] = ["none", "variants", "bonferroni"];

/** The fast win threshold as data: family level `alpha`, one-sided, split over the `correct` tests. */
export interface WinRule {
  alpha: number;
  correct: Correction;
}

/** Fast mode's default (orch call, user delegated 2026-11-09): Bonferroni over variants × headline cases at family α 0.20. */
export const DEFAULT_WIN_RULE: WinRule = { alpha: 0.2, correct: "bonferroni" };
/** A fast freeze from before the rule was data: nominal one-sided 0.05 per test, uncorrected (z 1.645). */
export const LEGACY_WIN_RULE: WinRule = { alpha: 0.05, correct: "none" };

export const winRuleOf = (rows: readonly ControlRow[]): WinRule =>
  modeRow(rows)?.win ?? LEGACY_WIN_RULE;

/** The tests the rule divides `alpha` over, for a field of `variants` on `cases` own headline cases. */
export const ruleTests = (rule: WinRule, variants: number, cases: number): number =>
  Math.max(
    1,
    rule.correct === "none" ? 1 : rule.correct === "variants" ? variants : variants * cases,
  );

/** The pooled weak-model z a fast win needs: z at one-sided `alpha / tests`. */
export const winZ = (rule: WinRule, variants: number, cases: number): number =>
  normQuantile(1 - rule.alpha / ruleTests(rule, variants, cases));

/** `--win-alpha <a> --correct none|variants|bonferroni` (each defaults to DEFAULT_WIN_RULE's). */
export function parseWinRule(alpha: string | undefined, correct: string | undefined): WinRule {
  const a = alpha === undefined ? DEFAULT_WIN_RULE.alpha : Number(alpha);
  if (!(a > 0 && a < 1)) throw new Error(`--win-alpha ${alpha}: a level in (0, 1)`);
  const c = (correct ?? DEFAULT_WIN_RULE.correct) as Correction;
  if (!CORRECTIONS.includes(c))
    throw new Error(`--correct ${correct}: one of ${CORRECTIONS.join(", ")}`);
  return { alpha: a, correct: c };
}

/** One line naming a rule and, given the field, its threshold. */
export const ruleLine = (rule: WinRule, variants?: number, cases?: number): string => {
  const what =
    rule.correct === "none"
      ? "uncorrected"
      : rule.correct === "variants"
        ? "Bonferroni over variants"
        : "Bonferroni over variants × headline cases";
  if (variants === undefined || cases === undefined)
    return `family α ${rule.alpha} one-sided, ${what}`;
  const k = ruleTests(rule, variants, cases);
  return `family α ${rule.alpha} one-sided, ${what}: ${k} tests, z ≥ ${winZ(rule, variants, cases).toFixed(2)}`;
};

export class FastModeError extends Error {}

/**
 * §4.7: a fast-mode group has no R2 and no per-group R3, R4 or final gate; C7 is the regression
 * gate. `--fast` on a full-mode freeze, and `decide` on one, are refused too.
 */
export function assertMode(rows: readonly ControlRow[], sub: string, fastFlag: boolean): void {
  const mode = modeOf(rows);
  const frozen = rows.some((r) => r.kind === "freeze");
  if (fastFlag && frozen && mode !== "fast" && sub !== "migrate-fast")
    throw new FastModeError(
      "this group is frozen in full mode: --fast needs a `freeze --fast`, or `migrate-fast <group>` once R1 is scored",
    );
  if (sub === "migrate-fast" && mode === "fast")
    throw new FastModeError("this group is in fast mode already");
  if (sub === "decide" && (!fastFlag || mode !== "fast"))
    throw new FastModeError(
      "`decide --fast` is fast mode only (a `freeze --fast` group); full mode decides in R4",
    );
  if (mode === "fast" && ["r2", "r3", "r4", "final"].includes(sub))
    throw new FastModeError(
      `fast mode: no ${sub.toUpperCase()} per group; decide on R1 (\`tournament decide --fast <group>\`), and C7 (\`tournament final --combined\`) is the regression gate`,
    );
}

export class JudgesChangedError extends Error {}
export class ReviewPendingError extends Error {}

/**
 * §3.2: every command after the freeze refuses to run when the judges' hash differs from the
 * latest freeze or refreeze row.
 */
export function assertFrozen(rows: readonly ControlRow[], currentHash: string): void {
  const f = last(rows, "freeze");
  if (!f) throw new JudgesChangedError("no freeze row: run `tournament freeze` first");
  const want = frozenHash(rows) ?? f.judgesHash;
  if (want !== currentHash)
    throw new JudgesChangedError(
      `judges changed since the freeze (${want} -> ${currentHash}); a judge changes only through \`tournament refreeze\``,
    );
}

/** §0: the group does not start without the B0 proof for every model. */
export function assertB0(setup: SetupRow | undefined): void {
  if (!setup) throw new Error("no setup row: run `tournament freeze` first");
  const models = [...setup.models.weak, setup.models.gate];
  const missing = models.filter((m) => !setup.b0.rows.some((r) => r.model === m && r.ok));
  if (missing.length > 0)
    throw new Error(
      `no B0 proof for ${missing.join(", ")}: the group does not start (back to the user)`,
    );
}

// ---- review stops -------------------------------------------------------------------------------

const sha12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** A stop's id is its content's hash, so re-scoring finds the stop (and its decision) it already wrote. */
export const stopId = (s: Omit<ReviewStopRow, "kind" | "id" | "transcript">): string =>
  `rs-${sha12(JSON.stringify([s.source, s.variant, s.cell, [...s.entries].sort()]))}`;

/** §5.2 outcome 2: append the stop (once) and ping. Returns its id. Exit 7 is the caller's. */
export function appendReviewStop(
  dir: string,
  s: Omit<ReviewStopRow, "kind" | "id">,
  ping: (msg: string) => void = ntfyPing,
): string {
  const id = stopId(s);
  if (!readControl(dir).some((r) => r.kind === "review_stop" && r.id === id)) {
    appendControl(dir, { kind: "review_stop", id, ...s });
    ping(`tournament review stop ${id}: ${s.variant} ${s.cell}`);
  }
  return id;
}

export function appendReviewDecision(
  dir: string,
  d: { stop: string; decision: "drop" | "continue"; why: string },
): void {
  const rows = readControl(dir);
  if (!rows.some((r) => r.kind === "review_stop" && r.id === d.stop))
    throw new Error(`no review stop ${d.stop}`);
  if (d.why.trim() === "") throw new Error("--why must quote the transcript lines");
  appendControl(dir, { kind: "review_decision", ...d });
}

export const pendingStops = (rows: readonly ControlRow[]): ReviewStopRow[] => {
  const decided = new Set(rows.flatMap((r) => (r.kind === "review_decision" ? [r.stop] : [])));
  return rows.filter((r): r is ReviewStopRow => r.kind === "review_stop" && !decided.has(r.id));
};

export function assertNoPendingStops(rows: readonly ControlRow[]): void {
  const p = pendingStops(rows);
  if (p.length > 0)
    throw new ReviewPendingError(
      `review pending: ${p.map((s) => s.id).join(", ")} (tournament review <group> --stop <id> --decision drop|continue --why "...")`,
    );
}

export function ntfyPing(msg: string): void {
  try {
    spawnSync("ntfy-ping", [msg, "mu tournament"], { stdio: "ignore", timeout: 10_000 });
  } catch {}
}

// ---- n plan and wall ----------------------------------------------------------------------------

export const DEFAULT_RHO = 0.2;
export const ALPHA = 0.05;
/** The stratified CMH loss test's level per model (Bonferroni over three models, §4.1). */
export const CMH_ALPHA = ALPHA / 3;
export const TARGET = { own: 60, pooled: 90, cross: 40, guard: 40 } as const;
/** Fast mode's R1 targets for own headline cases (user decision 2026-11-09, §4.7). */
export const FAST_TARGET = { own: 30, pooled: 45 } as const;
/** The per-test Fisher level of a fast plan's MDE (the field, so the rule's tests, is not known at the freeze). */
export const FAST_ALPHA = 0.05;
/** Worst Bonferroni-Holm divisor of the win test's first step (§4.2: S ≤ 6, h ≤ 3). */
export const WORST_B = 18;
/** First step of the per-case loss family (§4.2: 15 strata × 3 models). */
export const LOSS_FAMILY = 45;

/**
 * ρ̂ per (case, model) and ρ̂_pool per case from B5's base rows (§4.1), plus the cold-guess guard's
 * ρ̂ (clusters = intents) when cold rows are given. Rows with a model error are rig noise, not a
 * reading outcome, and are left out: counted as misses they would inflate the between-cluster
 * variance of whichever cluster drew them.
 */
export function rhoFromB5(
  probe: readonly (Pick<ProbeRow, "case" | "arm" | "paraphrase" | "model" | "hit" | "modelError"> &
    Partial<Pick<ProbeRow, "rigReads" | "infraFail">>)[],
  cold: readonly Pick<ColdRow, "intent" | "model" | "hit" | "modelError">[],
  models: { weak: readonly string[]; gate: string },
): Pick<SetupRow, "rho" | "rhoPool"> {
  const all = [...models.weak, models.gate];
  const rho: SetupRow["rho"] = {};
  const rhoPool: SetupRow["rhoPool"] = {};
  // a rig read (rig-guard.ts) is an invalid row, not a reading outcome either
  // and a row that failed every try (infra-retry.ts) never reached the model
  const ok = probe.filter(
    (r) =>
      r.modelError === undefined && (r.rigReads?.length ?? 0) === 0 && r.infraFail === undefined,
  );
  for (const c of [...new Set(ok.map((r) => r.case))]) {
    const rows: IccRow[] = ok
      .filter((r) => r.case === c)
      .map((r) => ({ cluster: `${r.arm}|${r.paraphrase}`, model: r.model, hit: r.hit }));
    rho[c] = Object.fromEntries(all.map((m) => [m, iccModel(rows, m)]));
    rhoPool[c] = iccPooled(rows, models.weak);
  }
  const coldOk = cold.filter((r) => r.modelError === undefined);
  if (coldOk.length > 0) {
    const rows = coldOk.map((r) => ({ cluster: r.intent, model: r.model, hit: r.hit }));
    rho["cold-guess"] = Object.fromEntries(all.map((m) => [m, iccModel(rows, m)]));
  }
  return { rho, rhoPool };
}

/**
 * The arms a plan runs: the case's own, plus the help arms in fast mode unless turned off (hill2
 * note 33: a help or flag variant is shown to the model only through them).
 */
export const planArms = (c: NextCase, mode: Mode, helpArms = true): Arm[] =>
  mode === "fast" && helpArms ? [...new Set([...c.arms, ...HELP_ARMS])] : [...c.arms];

const caseKind = (c: NextCase, group: Group): CasePlan["kind"] =>
  c.role === "guard" ? "guard" : c.group === group ? "own" : "cross";

/**
 * §4.2 n plan of one group: per case its kind, clusters, reps and n_eff; short cases say so. Fast
 * mode (§4.7) plans only the own headline cases, for R1, at FAST_TARGET: R1 runs `r` reps.
 */
export function nPlan(
  group: Group,
  cases: readonly NextCase[],
  setup: Pick<SetupRow, "rho" | "rhoPool" | "models"> | null,
  mode: Mode = "full",
  o: { helpArms?: boolean } = {},
): CasePlan[] {
  const models = setup ? [...setup.models.weak, setup.models.gate] : [];
  const fast = mode === "fast";
  return cases.flatMap((c) => {
    const kind = caseKind(c, group);
    if (fast && kind !== "own") return [];
    const arms = planArms(c, mode, o.helpArms ?? true);
    const rhos = models.map((m) => setup?.rho[c.id]?.[m] ?? DEFAULT_RHO);
    const rho = rhos.length > 0 ? Math.max(...rhos) : DEFAULT_RHO;
    const rhoPool = setup?.rhoPool[c.id] ?? DEFAULT_RHO;
    const plan = solvePlan({
      paraphrases: c.paraphrases.length,
      arms: arms.length,
      rho,
      target: fast
        ? FAST_TARGET.own
        : kind === "own"
          ? TARGET.own
          : kind === "cross"
            ? TARGET.cross
            : TARGET.guard,
      ...(kind === "own"
        ? { pooled: { target: fast ? FAST_TARGET.pooled : TARGET.pooled, rho: rhoPool } }
        : {}),
    });
    const m =
      kind === "own"
        ? mde(
            0.5,
            Math.round(plan.nEffPooled ?? plan.nEff),
            fast ? FAST_ALPHA : 0.05 / WORST_B,
            "greater",
          )
        : mde(0.8, Math.round(plan.nEff), 0.05 / LOSS_FAMILY, "less");
    return [{ case: c.id, kind, plan, r1: kind !== "own" ? 0 : fast ? plan.r : 1, mde: m, arms }];
  });
}

export interface PlanPower {
  drop: string;
  power: number;
}

/** Broad drops whose CMH power the plan reports: every stratum 0.8 → 0.7 and 0.8 → 0.75. */
export const CMH_DROPS = [0.7, 0.75] as const;

/**
 * CMH power per model at a plan (§4.2): one stratum per case at its per-model n_eff, every stratum
 * dropping from 0.8 to each of CMH_DROPS. The cold-guess guard is one more stratum in R2, so the
 * number is a lower bound.
 */
export function planCmhPower(plan: readonly CasePlan[]): PlanPower[] {
  return CMH_DROPS.map((pv) => ({
    drop: `0.8→${pv}`,
    power: cmhPower(
      plan.map((p) => ({ nEff: p.plan.nEff, pb: 0.8, pv })),
      CMH_ALPHA,
    ),
  }));
}

/** One line of the plan's CMH power for the freeze and plan output. */
export const powerLine = (p: readonly PlanPower[]): string =>
  `CMH power per model (α 0.05/3, cold-guess stratum not counted): ${p.map((x) => `${x.drop} ${x.power.toFixed(2)}`).join(", ")}`;

/** Seconds per model call and calls per provider at once (§4.2 throughput). */
export const MODEL_CALL_S = 15;

/** §4.2 wall estimate of a job list: the slower of row slots and model calls per provider. */
export function wallEstimate(
  jobs: readonly Pick<NextJob, "caseId" | "model">[],
  cases: readonly NextCase[],
  o: { concurrency: number; modelConcurrency: number },
): { rows: number; slotHours: number; modelHours: number; hours: number } {
  const ms = new Map(cases.map((c) => [c.id, c.expectedRowMs]));
  const slot = jobs.reduce((t, j) => t + (ms.get(j.caseId) ?? 30_000), 0) / 1000;
  const perProvider = new Map<string, number>();
  for (const j of jobs) {
    const p = providerOf(j.model);
    perProvider.set(p, (perProvider.get(p) ?? 0) + 1);
  }
  const modelS = Math.max(
    0,
    ...[...perProvider.values()].map((n) => (n * MODEL_CALL_S) / o.modelConcurrency),
  );
  const slotHours = slot / o.concurrency / 3600;
  const modelHours = modelS / 3600;
  return { rows: jobs.length, slotHours, modelHours, hours: Math.max(slotHours, modelHours) };
}

/** claude-* models share one provider, as in runNext's per-provider limit. */
const providerOf = (model: string): string =>
  model.includes("/") ? (model.split("/")[0] ?? model) : (model.split("-")[0] ?? model);

// ---- job lists ----------------------------------------------------------------------------------

/** A seeded Fisher-Yates shuffle (mulberry32), as `nextstep run`'s. */
export function shuffle<T>(xs: readonly T[], seed: string): T[] {
  let h = 1779033703;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  let a = h >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Rep indices of a round never meet another round's: R1 from 1, R2 from 101, per epoch. */
export const REP_BASE = { r1: 1, r2: 101 } as const;
export const repBase = (round: "r1" | "r2", epoch: number): number =>
  epoch * 1000 + REP_BASE[round];

/**
 * The fresh rows of a round in an epoch's probe file: that round's rows from its rep floor up. R2
 * rows (an R2 run a fast migration left behind) and an earlier epoch's reps are not R1's.
 */
export const freshRows = <R extends Pick<ProbeRow, "round" | "rep">>(
  rows: readonly R[],
  round: "r1" | "r2",
  epoch: number,
): R[] => {
  const floor = repBase(round, epoch);
  return rows.filter((r) => r.round === round && r.rep >= floor && r.rep < floor + 900);
};

export interface RoundSurfaces {
  /** "base" first, then the variants in the round. */
  surfaces: { label: string; surface: Surface }[];
  models: string[];
}

/**
 * The jobs of R1 (own headline cases, r = 1) or R2 (own headline at the R2 plan, every other
 * group's headline cases at the cross plan, the guards at theirs), over base and the round's
 * variants and all three models. One interleaved shuffled queue (seed in the setup row), long
 * cases first so they leave no tail.
 */
export function roundJobs(
  round: "r1" | "r2",
  group: Group,
  cases: readonly NextCase[],
  plan: readonly CasePlan[],
  s: RoundSurfaces,
  o: { seed: string; epoch: number },
): NextJob[] {
  const byCase = new Map(plan.map((p) => [p.case, p]));
  const jobs: NextJob[] = [];
  for (const c of cases) {
    const p = byCase.get(c.id);
    // a fast plan (§4.7) has rows for the own headline cases only
    if (round === "r1" && p?.kind !== "own") continue;
    if (!p) throw new Error(`case ${c.id} has no plan row`);
    const reps = round === "r1" ? p.r1 : p.plan.r;
    const paraphrases = c.paraphrases.slice(0, p.plan.paraphrases);
    for (const { label, surface } of s.surfaces)
      for (const model of s.models)
        for (const arm of p.arms ?? c.arms)
          for (const para of paraphrases)
            for (let k = 0; k < reps; k++)
              jobs.push({
                round,
                group,
                surfaceLabel: label,
                surface,
                model,
                caseId: c.id,
                arm,
                paraphrase: para.id,
                rep: repBase(round, o.epoch) + k,
              });
  }
  const ms = new Map(cases.map((c) => [c.id, c.expectedRowMs]));
  return shuffle(jobs, `${o.seed}:${round}:${o.epoch}`)
    .map((j, i) => ({ j, i }))
    .sort((a, b) => (ms.get(b.j.caseId) ?? 0) - (ms.get(a.j.caseId) ?? 0) || a.i - b.i)
    .map(({ j }) => j);
}
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
