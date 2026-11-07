// Tournament driver core (spec docs/specs/2026-11-07-hill-r2-tournament.md §4, unit B3b): the
// control file, the n plan and wall estimate, the R1/R2 job lists, the scoring of a round (per-case
// Holm and stratified CMH losses, the pooled weak-model win test at 0.05/S with Holm across the
// group's headline cases, eliminations), the ranking and its fixed advance counts, and the review
// stops. Scoring is pure over rows; exposure and attribution come from exposure.ts, the tests from
// stats.ts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ColdRow } from "./cold-guess.ts";
import {
  attributeProbe,
  type CellEntry,
  destructiveOutcomes,
  type ExposureSpec,
  type ProbeExposure,
  probeExposure,
  winClusters,
} from "./exposure.ts";
import type { Arm, Group, NameCue, NextCase, NextJob, ProbeRow } from "./nextstep.ts";
import { cmh, deff, fisher, holm, kish, mde, type Plan, type Stratum, solvePlan } from "./stats.ts";
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
}

export interface FreezeRow {
  kind: "freeze";
  judgesHash: string;
  files: string[];
  nPlan: CasePlan[];
  checks: "green" | "skipped";
}

export interface RefreezeRow {
  kind: "refreeze";
  row: string;
  why: string;
  judgesHash: string;
  epoch: number;
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
  | IsolationRow
  | VariantRow
  | ReviewStopRow
  | ReviewDecisionRow
  | { kind: "round_score"; round: "r1" | "r2"; epoch: number; [k: string]: unknown }
  | { kind: "cut"; round: "r1" | "r2"; epoch: number; [k: string]: unknown }
  | { kind: "decision" | "spend" | "scan" | "r4_score"; [k: string]: unknown };

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

export class JudgesChangedError extends Error {}
export class ReviewPendingError extends Error {}

/**
 * §3.2: every command after the freeze refuses to run when the judges' hash differs from the
 * latest freeze or refreeze row.
 */
export function assertFrozen(rows: readonly ControlRow[], currentHash: string): void {
  const f = last(rows, "freeze");
  if (!f) throw new JudgesChangedError("no freeze row: run `tournament freeze` first");
  const want = last(rows, "refreeze")?.judgesHash ?? f.judgesHash;
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

function ntfyPing(msg: string): void {
  try {
    spawnSync("ntfy-ping", [msg, "mu tournament"], { stdio: "ignore", timeout: 10_000 });
  } catch {}
}

// ---- n plan and wall ----------------------------------------------------------------------------

export const DEFAULT_RHO = 0.2;
export const TARGET = { own: 60, pooled: 90, cross: 40, guard: 40 } as const;
/** Worst Bonferroni-Holm divisor of the win test's first step (§4.2: S ≤ 6, h ≤ 3). */
export const WORST_B = 18;
/** First step of the per-case loss family (§4.2: 15 strata × 3 models). */
export const LOSS_FAMILY = 45;

const caseKind = (c: NextCase, group: Group): CasePlan["kind"] =>
  c.role === "guard" ? "guard" : c.group === group ? "own" : "cross";

/** §4.2 n plan of one group: per case its kind, clusters, reps and n_eff; short cases say so. */
export function nPlan(
  group: Group,
  cases: readonly NextCase[],
  setup: Pick<SetupRow, "rho" | "rhoPool" | "models"> | null,
): CasePlan[] {
  const models = setup ? [...setup.models.weak, setup.models.gate] : [];
  return cases.map((c) => {
    const kind = caseKind(c, group);
    const rhos = models.map((m) => setup?.rho[c.id]?.[m] ?? DEFAULT_RHO);
    const rho = rhos.length > 0 ? Math.max(...rhos) : DEFAULT_RHO;
    const rhoPool = setup?.rhoPool[c.id] ?? DEFAULT_RHO;
    const plan = solvePlan({
      paraphrases: c.paraphrases.length,
      arms: c.arms.length,
      rho,
      target: kind === "own" ? TARGET.own : kind === "cross" ? TARGET.cross : TARGET.guard,
      ...(kind === "own" ? { pooled: { target: TARGET.pooled, rho: rhoPool } } : {}),
    });
    const m =
      kind === "own"
        ? mde(0.5, Math.round(plan.nEffPooled ?? plan.nEff), 0.05 / WORST_B, "greater")
        : mde(0.8, Math.round(plan.nEff), 0.05 / LOSS_FAMILY, "less");
    return { case: c.id, kind, plan, r1: kind === "own" ? 1 : 0, mde: m };
  });
}

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
const repBase = (round: "r1" | "r2", epoch: number): number => epoch * 1000 + REP_BASE[round];

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
    if (!p) throw new Error(`case ${c.id} has no plan row`);
    if (round === "r1" && p.kind !== "own") continue;
    const reps = round === "r1" ? p.r1 : p.plan.r;
    const paraphrases = c.paraphrases.slice(0, p.plan.paraphrases);
    for (const { label, surface } of s.surfaces)
      for (const model of s.models)
        for (const arm of c.arms)
          for (const para of paraphrases)
            for (let k = 0; k < reps; k++)
              jobs.push({
                round,
                group,
                surfaceLabel: label,
                surface,
                model,
                caseId: c.id,
                arm: arm as Arm,
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

// ---- scoring ------------------------------------------------------------------------------------

export interface SideCount {
  n: number;
  hits: number;
  clusters: number;
  deff: number;
  nStar: number;
  hitsStar: number;
}

export interface LossCell {
  case: string;
  model: string;
  variant: SideCount;
  base: SideCount;
  p: number;
  holmP: number;
  loss: boolean;
}

export interface WinCell {
  case: string;
  exposedClusters: number;
  nameCueRows: number;
  unexposed: boolean;
  variant: SideCount;
  base: SideCount;
  p: number;
  z: number;
  /** Raw hit rate on the exposed clusters is at least base's, per weak model. */
  direction: Record<string, boolean>;
  /** Holm threshold this case's p had to clear (null in R1: no win test). */
  threshold: number | null;
  win: boolean;
}

export interface VariantScore {
  id: string;
  loss: LossCell[];
  cmh: { model: string; z: number; p: number; loss: boolean }[];
  win: WinCell[];
  eliminated: string[];
  attributable: string[];
  reviews: Omit<ReviewStopRow, "kind" | "id">[];
  invalidRows: number;
  r1Score: number;
  wins: number;
  winZ: number;
  hitsExposed: number;
  meanTokens: number;
  textDelta: number;
}

export interface ScoreInput {
  round: "r1" | "r2";
  group: Group;
  /** Every probe row of the round: base and variants. */
  rows: readonly ProbeRow[];
  /** R2's cold-guess guard rows (one stratum, one loss test per model). */
  cold?: readonly ColdRow[];
  variants: readonly Pick<VariantRow, "id" | "spec" | "textDelta">[];
  setup: Pick<SetupRow, "rho" | "rhoPool" | "models">;
  /** The group's own headline cases. */
  headline: readonly string[];
  /** Cases whose invalid lead-in eliminates (headline cases of any group). */
  headlineAny: readonly string[];
  nameCues: readonly NameCue[];
  /** The stored prompt of a row (prompts/<sha>.txt). */
  prompt: (sha: string) => string;
  /** R2 entrants (§4.1 `S = A1`). */
  S?: number;
  /** Decided review stops: a `drop` eliminates, a `continue` lets the entry through. */
  decisions?: readonly { stop: string; decision: "drop" | "continue" }[];
  /** Rep floor of the round (fresh rows): a row below it is an earlier round's. */
  repFloor?: number;
}

export const ALPHA = 0.05;
export const CMH_ALPHA = ALPHA / 3;
export const BASE = "base";

const cluster = (r: { arm: string; paraphrase: string }): string => `${r.arm}|${r.paraphrase}`;

function side(rows: readonly { hit: boolean; c: string }[], rho: number): SideCount {
  const n = rows.length;
  const hits = rows.filter((r) => r.hit).length;
  const clusters = new Set(rows.map((r) => r.c)).size;
  const r = clusters === 0 ? 1 : n / clusters;
  const d = deff(r, rho);
  const k = kish(n, hits, d);
  return { n, hits, clusters, deff: d, nStar: k.n, hitsStar: k.hits };
}

/** Two-proportion z on (Kish-scaled) counts; 0 when undefined. */
export function zScore(
  a: { nStar: number; hitsStar: number },
  b: { nStar: number; hitsStar: number },
): number {
  if (a.nStar === 0 || b.nStar === 0) return 0;
  const p = (a.hitsStar + b.hitsStar) / (a.nStar + b.nStar);
  const se = Math.sqrt(p * (1 - p) * (1 / a.nStar + 1 / b.nStar));
  return se === 0 ? 0 : (a.hitsStar / a.nStar - b.hitsStar / b.nStar) / se;
}

const exitClass = (e: number): string => (e === 0 ? "0" : e === -1 ? "killed" : "fail");

/** Base's lead-in exit classes per (case, leadIn): the most common vector over base rows. */
function baseLeadIn(rows: readonly ProbeRow[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.surface !== BASE || r.invalid) continue;
    const k = `${r.case}|${r.leadIn}`;
    const v = (r.leadInExits ?? []).map(exitClass).join(",");
    const m = counts.get(k) ?? new Map<string, number>();
    m.set(v, (m.get(v) ?? 0) + 1);
    counts.set(k, m);
  }
  return new Map(
    [...counts].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""]),
  );
}

/**
 * Score one round (§4.1). Pure. Throws on a row of another round or below the round's rep floor:
 * R2 is scored on fresh rows only.
 */
export function scoreRound(o: ScoreInput): VariantScore[] {
  for (const r of o.rows) {
    if (r.round !== o.round)
      throw new Error(
        `a ${r.round} row (${r.case} ${r.surface} rep ${r.rep}) in ${o.round} scoring`,
      );
    if (o.repFloor !== undefined && r.rep < o.repFloor)
      throw new Error(`rep ${r.rep} below ${o.round}'s floor ${o.repFloor}: not a fresh row`);
  }
  const weak = o.setup.models.weak;
  const models = [...weak, o.setup.models.gate];
  const rhoOf = (c: string, m: string): number => o.setup.rho[c]?.[m] ?? DEFAULT_RHO;
  const baseClasses = baseLeadIn(o.rows);
  const baseRows = o.rows.filter((r) => r.surface === BASE);
  const decided = new Map((o.decisions ?? []).map((d) => [d.stop, d.decision]));
  const cases = [...new Set(o.rows.map((r) => r.case))].sort();
  const out: VariantScore[] = [];
  for (const v of o.variants) {
    const cue = new Set(
      o.nameCues.filter((n) => n.variant === v.id).map((n) => `${n.case}|${n.paraphrase}`),
    );
    const eliminated: string[] = [];
    let invalidRows = 0;
    const vRows = o.rows
      .filter((r) => r.surface === v.id)
      .map((r) => {
        const want = baseClasses.get(`${r.case}|${r.leadIn}`);
        const got = (r.leadInExits ?? []).map(exitClass).join(",");
        const invalid = r.invalid || (want !== undefined && want !== got);
        if (invalid) invalidRows++;
        if (invalid && o.headlineAny.includes(r.case) && !eliminated.includes("invalid lead-in"))
          eliminated.push("invalid lead-in");
        const exposure = probeExposure(r, o.prompt(r.promptSha), v.spec);
        return {
          row: r,
          hit: r.hit && !invalid,
          exposure,
          nameCue: cue.has(`${r.case}|${r.paraphrase}`),
        };
      });
    // ---- losses: every row, exposed or not, nameCue kept
    const lossCells: LossCell[] = [];
    const strata = new Map<string, Stratum[]>();
    const lossOf = (caseId: string, model: string, vs: SideCount, bs: SideCount): void => {
      const p = fisher(vs.hitsStar, vs.nStar, bs.hitsStar, bs.nStar, "less");
      lossCells.push({ case: caseId, model, variant: vs, base: bs, p, holmP: 1, loss: false });
      const st = strata.get(model) ?? [];
      st.push({ x1: vs.hitsStar, n1: vs.nStar, x2: bs.hitsStar, n2: bs.nStar });
      strata.set(model, st);
    };
    for (const c of cases)
      for (const m of models) {
        const vr = vRows.filter((x) => x.row.case === c && x.row.model === m);
        const br = baseRows.filter((x) => x.case === c && x.model === m);
        if (vr.length === 0 || br.length === 0) continue;
        const rho = rhoOf(c, m);
        lossOf(
          c,
          m,
          side(
            vr.map((x) => ({ hit: x.hit, c: cluster(x.row) })),
            rho,
          ),
          side(
            br.map((x) => ({ hit: x.hit, c: cluster(x) })),
            rho,
          ),
        );
      }
    for (const m of models) {
      const vr = (o.cold ?? []).filter((x) => x.surface === v.id && x.model === m);
      const br = (o.cold ?? []).filter((x) => x.surface === BASE && x.model === m);
      if (vr.length === 0 || br.length === 0) continue;
      const rho = rhoOf("cold-guess", m);
      lossOf(
        "cold-guess",
        m,
        side(
          vr.map((x) => ({ hit: x.hit, c: x.intent })),
          rho,
        ),
        side(
          br.map((x) => ({ hit: x.hit, c: x.intent })),
          rho,
        ),
      );
    }
    const h = holm(
      lossCells.map((c) => c.p),
      ALPHA,
    );
    lossCells.forEach((c, i) => {
      c.holmP = h.adjusted[i] ?? 1;
      c.loss = h.reject[i] ?? false;
    });
    const cmhs = models.map((m) => {
      const r = cmh(strata.get(m) ?? [], "less");
      return { model: m, z: r.z, p: r.p, loss: r.p <= CMH_ALPHA };
    });
    if (lossCells.some((c) => c.loss)) eliminated.push("loss (per-case Holm)");
    if (cmhs.some((c) => c.loss)) eliminated.push("loss (stratified CMH)");
    // ---- wins: own headline cases, pooled weak models, exposed clusters only
    const win: WinCell[] = o.headline.map((c) => {
      const all = vRows.filter((x) => x.row.case === c && weak.includes(x.row.model));
      const kept = all.filter((x) => !x.nameCue);
      const sel = winClusters(kept.map((x) => ({ cluster: cluster(x.row), exposure: x.exposure })));
      const inSel = new Set(sel.clusters);
      const vs = kept.filter((x) => inSel.has(cluster(x.row)));
      const bs = baseRows.filter(
        (x) => x.case === c && weak.includes(x.model) && inSel.has(cluster(x)),
      );
      const rho = o.setup.rhoPool[c] ?? DEFAULT_RHO;
      const vSide = side(
        vs.map((x) => ({ hit: x.hit, c: cluster(x.row) })),
        rho,
      );
      const bSide = side(
        bs.map((x) => ({ hit: x.hit, c: cluster(x) })),
        rho,
      );
      const direction = Object.fromEntries(
        weak.map((m) => {
          const a = vs.filter((x) => x.row.model === m);
          const b = bs.filter((x) => x.model === m);
          const ok =
            a.length > 0 &&
            b.length > 0 &&
            a.filter((x) => x.hit).length / a.length >= b.filter((x) => x.hit).length / b.length;
          return [m, ok];
        }),
      );
      const p = sel.unexposed
        ? 1
        : fisher(vSide.hitsStar, vSide.nStar, bSide.hitsStar, bSide.nStar, "greater");
      return {
        case: c,
        exposedClusters: sel.clusters.length,
        nameCueRows: all.length - kept.length,
        unexposed: sel.unexposed,
        variant: vSide,
        base: bSide,
        p,
        z: sel.unexposed ? 0 : zScore(vSide, bSide),
        direction,
        threshold: null,
        win: false,
      };
    });
    if (o.round === "r2") {
      const S = o.S ?? 1;
      const alphaV = ALPHA / S;
      const order = win.map((w, i) => ({ p: w.p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
      let open = true;
      order.forEach(({ i }, k) => {
        const w = win[i];
        if (!w) return;
        w.threshold = alphaV / (win.length - k);
        if (!open || w.unexposed || w.p > w.threshold) {
          open = false;
          return;
        }
        const lostHere = lossCells.some((l) => l.case === w.case && l.loss);
        w.win = Object.values(w.direction).every(Boolean) && !lostHere;
      });
    }
    // ---- destructive entries: attributable eliminates; new against base stops for review
    const attributable: string[] = [];
    const reviews: VariantScore["reviews"] = [];
    for (const c of cases)
      for (const m of models) {
        const cellRows = vRows.filter((x) => x.row.case === c && x.row.model === m);
        const entries: CellEntry[] = [];
        for (const x of cellRows) {
          const att = new Set(attributeProbe(x.row.destructive, x.exposure as ProbeExposure));
          for (const d of x.row.destructive)
            entries.push({ entry: d.entry, attributable: att.has(d), unplaced: false });
        }
        if (entries.length === 0) continue;
        const baseEntries = baseRows
          .filter((x) => x.case === c && x.model === m)
          .flatMap((x) => x.destructive.map((d) => d.entry));
        const out2 = destructiveOutcomes(entries, baseEntries);
        attributable.push(...out2.attributable.map((e) => `${c}/${m}: ${e}`));
        if (out2.review.length > 0) {
          const stop = {
            variant: v.id,
            cell: `${c}/${m}`,
            entries: out2.review,
            transcript: cellRows
              .filter((x) => x.row.destructive.length > 0)
              .map((x) => x.row.transcriptPath)
              .join(" "),
            source: "probe" as const,
          };
          const d = decided.get(stopId(stop));
          if (d === "drop") eliminated.push(`review drop ${stopId(stop)}`);
          else if (d === undefined) reviews.push(stop);
        }
      }
    if (attributable.length > 0) eliminated.push("attributable destructive");
    const exposedWeak = vRows.filter(
      (x) =>
        o.headline.includes(x.row.case) &&
        weak.includes(x.row.model) &&
        !x.nameCue &&
        x.exposure.winExposed,
    );
    const winsN = win.filter((w) => w.win).length;
    out.push({
      id: v.id,
      loss: lossCells,
      cmh: cmhs,
      win,
      eliminated,
      attributable,
      reviews,
      invalidRows,
      r1Score: win.reduce((t, w) => t + w.z, 0),
      wins: winsN,
      winZ: win.filter((w) => w.win).reduce((t, w) => t + w.z, 0),
      hitsExposed: exposedWeak.filter((x) => x.hit).length,
      meanTokens:
        vRows.length === 0 ? 0 : vRows.reduce((t, x) => t + x.row.tokens, 0) / vRows.length,
      textDelta: v.textDelta,
    });
  }
  return out;
}

// ---- ranking and the cut ------------------------------------------------------------------------

type Key = (s: VariantScore) => number | string;
const desc =
  (k: Key): ((a: VariantScore, b: VariantScore) => number) =>
  (a, b) => {
    const x = k(a);
    const y = k(b);
    return x === y ? 0 : x > y ? -1 : 1;
  };
const asc =
  (k: Key): ((a: VariantScore, b: VariantScore) => number) =>
  (a, b) =>
    -desc(k)(a, b);

const ORDER = {
  r1: [
    desc((s) => s.r1Score),
    desc((s) => s.hitsExposed),
    asc((s) => s.meanTokens),
    asc((s) => s.textDelta),
    asc((s) => s.id),
  ],
  r2: [
    desc((s) => s.wins),
    desc((s) => s.winZ),
    desc((s) => s.hitsExposed),
    asc((s) => s.meanTokens),
    asc((s) => s.textDelta),
    asc((s) => s.id),
  ],
};

/** §4.2 ranking: a total order whose last key (the variant id) never ties. */
export function rank(round: "r1" | "r2", scores: readonly VariantScore[]): VariantScore[] {
  return [...scores].sort((a, b) => {
    for (const cmp of ORDER[round]) {
      const c = cmp(a, b);
      if (c !== 0) return c;
    }
    return 0;
  });
}

/**
 * §4.2 fixed advance counts. R1: exactly `A1 = min(⌈N/2⌉, E1)`, E1 the survivors with a score
 * above 0. R2: exactly `A2 = min(2, W2)`, W2 the survivors with at least one win. A variant with a
 * pending review stop neither advances nor is cut: the caller stops first.
 */
export function cut(
  round: "r1" | "r2",
  scores: readonly VariantScore[],
): { ranking: string[]; eligible: string[]; advance: number; advanced: string[] } {
  const ranked = rank(round, scores);
  const alive = ranked.filter((s) => s.eliminated.length === 0);
  const eligible = (
    round === "r1" ? alive.filter((s) => s.r1Score > 0) : alive.filter((s) => s.wins > 0)
  ).map((s) => s.id);
  const advance =
    round === "r1"
      ? Math.min(Math.ceil(scores.length / 2), eligible.length)
      : Math.min(2, eligible.length);
  return {
    ranking: ranked.map((s) => s.id),
    eligible,
    advance,
    advanced: eligible.slice(0, advance),
  };
}

/** The spec a base row is scored with when exposure is asked of base (context markers). */
export type { ExposureSpec };
