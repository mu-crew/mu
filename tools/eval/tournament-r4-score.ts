// The pure half of the R3 scan, the R4 gate and the final gate (spec
// docs/specs/2026-11-07-hill-r2-tournament.md §4.4-§4.6, unit B3c): which scenarios exercise a
// finalist, the R4 completion test with Holm over the three models, the exercised precondition,
// the destructive outcomes, cost, the decision, and the holdout gate. No I/O; tournament-r4.ts runs
// the jobs and writes the rows.
import {
  type CellEntry,
  destructiveOutcomes,
  type Exposure,
  type ExposureSpec,
  markersIn,
  runEntries,
} from "./exposure.ts";
import { fisher, holm } from "./stats.ts";
import { ALPHA, type ReviewStopRow, stopId } from "./tournament.ts";
import { behaviourDiff, type GoldenTrace } from "./tournament-build.ts";
import type { VariantKind } from "./tournament-patch.ts";
import type { DestructiveFx, RunResult, Verdict } from "./types.ts";

export const BASE = "base";

/** Fields of an R4 row (§6 `R4Row`) the scoring reads. */
export type ScoredRow = Pick<RunResult, "scenario" | "model" | "rep" | "metrics"> & {
  verdict: Pick<Verdict, "completed" | "wrong" | "destructive">;
  variant: string;
  exposure: readonly Exposure[];
  destructiveFx: readonly DestructiveFx[];
  log?: string;
};

/**
 * A verdict's placed destructive entries. `destructiveFx` is optional on a Verdict (old rows, a
 * judge that threw), so a missing or short one is never read as "nothing destructive": every
 * `destructive[]` entry without a placed counterpart comes back unplaced (`at: null`), and an
 * unplaced entry always goes to review (§5.2 outcome 2).
 */
export function placedFx(v: Pick<Verdict, "destructive" | "destructiveFx">): DestructiveFx[] {
  const fx = [...(v.destructiveFx ?? [])];
  const have = new Map<string, number>();
  for (const d of fx) have.set(d.entry, (have.get(d.entry) ?? 0) + 1);
  for (const entry of v.destructive) {
    const n = have.get(entry) ?? 0;
    if (n > 0) have.set(entry, n - 1);
    else fx.push({ entry, at: null, source: "unknown" });
  }
  return fx;
}

// ---- R3 scan (§4.4) -----------------------------------------------------------------------------

/** At most this many scenarios go to R4 per finalist (§4.4 step 4). */
export const MAX_R4_SCENARIOS = 6;
/** Live haiku runs per candidate scenario in step 3. */
export const SCAN_LIVE_RUNS = 2;
/** Kinds whose behaviour diff counts in step 2. */
const BEHAVIOUR_KINDS: readonly VariantKind[] = ["verb", "error", "output"];

export interface ScanScenario {
  id: string;
  /** Step 1: the variant's markers in a variant golden's mu-out. */
  markers: string[];
  /** Step 1: its context markers in a base golden's mu-out. */
  context: string[];
  /** Step 2: call keys whose exit, --json shape or mu-out differ between base and variant goldens. */
  behaviour: string[];
  /** Step 3: live haiku runs and how many were exposed (null: not run). */
  live: { runs: number; exposed: number } | null;
  exercised: boolean;
  why: string[];
}

export interface ScanResult {
  variant: string;
  scenarios: ScanScenario[];
  /** The R4 scenarios: every behaviour-diff one, then the most exposed, up to 6. */
  selected: string[];
  /** Step 3 ran (skill/recipe kind, or fewer than 2 scenarios from steps 1-2). */
  live: boolean;
  /** Step 5: no exercising scenario, so the finalist cannot win. */
  canWin: boolean;
}

const traceOut = (t: GoldenTrace | undefined): string =>
  (t?.calls ?? []).map((c) => c.out).join("\n");

/** Steps 1-2 of one finalist over the candidate scenarios, from the golden traces (`r4:<id>`). */
export function scanZero(o: {
  kind: readonly VariantKind[];
  spec: ExposureSpec;
  scenarios: readonly string[];
  base: readonly GoldenTrace[];
  baseAgain?: readonly GoldenTrace[];
  variant: readonly GoldenTrace[];
  key: (argv: string) => string;
}): ScanScenario[] {
  const by = (ts: readonly GoldenTrace[]) => new Map(ts.map((t) => [t.id, t]));
  const b = by(o.base);
  const b2 = by(o.baseAgain ?? []);
  const v = by(o.variant);
  const behaviourOn = o.kind.some((k) => BEHAVIOUR_KINDS.includes(k));
  return o.scenarios.map((id) => {
    const tid = `r4:${id}`;
    const bt = b.get(tid);
    const vt = v.get(tid);
    const markers = markersIn(traceOut(vt), o.spec.markers);
    const context = markersIn(traceOut(bt), o.spec.contextMarkers);
    const behaviour =
      behaviourOn && bt && vt
        ? behaviourDiff([bt], [vt], o.key, b2.has(tid) ? [b2.get(tid) as GoldenTrace] : [])
        : [];
    const why = [
      ...(markers.length + context.length > 0 ? ["marker"] : []),
      ...(behaviour.length > 0 ? ["behaviour diff"] : []),
    ];
    return { id, markers, context, behaviour, live: null, exercised: why.length > 0, why };
  });
}

/** Step 3 runs for skill and recipe variants, and for any with fewer than 2 scenarios from steps 1-2. */
export const needsLive = (kind: readonly VariantKind[], zero: readonly ScanScenario[]): boolean =>
  kind.includes("skill") || kind.includes("recipe") || zero.filter((s) => s.exercised).length < 2;

/** Steps 3-5: fold in the live runs (rows of this variant, round "scan") and select the R4 set. */
export function scanSelect(
  variant: string,
  zero: readonly ScanScenario[],
  liveRows: readonly Pick<ScoredRow, "scenario" | "exposure">[] | null,
): ScanResult {
  const scenarios = zero.map((s) => {
    if (liveRows === null) return { ...s };
    const runs = liveRows.filter((r) => r.scenario === s.id);
    const exposed = runs.filter((r) => r.exposure.length > 0).length;
    const why = [...s.why, ...(exposed > 0 ? ["live exposure"] : [])];
    return {
      ...s,
      live: { runs: runs.length, exposed },
      exercised: s.exercised || exposed > 0,
      why,
    };
  });
  const weight = (s: ScanScenario): number =>
    s.markers.length + s.context.length + (s.live?.exposed ?? 0);
  const behaviour = scenarios.filter((s) => s.behaviour.length > 0).map((s) => s.id);
  const rest = scenarios
    .filter((s) => s.exercised && s.behaviour.length === 0)
    .sort((a, b) => weight(b) - weight(a) || a.id.localeCompare(b.id))
    .map((s) => s.id);
  const selected = [...behaviour, ...rest].slice(0, MAX_R4_SCENARIOS);
  return {
    variant,
    scenarios,
    selected,
    live: liveRows !== null,
    canWin: selected.length > 0,
  };
}

// ---- R4 gate (§4.5) -----------------------------------------------------------------------------

/** Runs per (surface, model) pooled that the R4 test needs (§4.5: Fisher power 0.80 at n = 48). */
export const R4_RUNS = 48;
/** Reps per scenario for `k` exercising scenarios: max(5, ⌈48/k⌉). */
export const r4Reps = (k: number): number => (k <= 0 ? 0 : Math.max(5, Math.ceil(R4_RUNS / k)));

/** §4.5 cost of one run: tokens + 10·muErrors + 50·wrong. */
export const runCost = (r: Pick<ScoredRow, "metrics" | "verdict">): number =>
  r.metrics.usage.total + 10 * r.metrics.muErrors + 50 * r.verdict.wrong.length;

/** Mean over reps of each rep's total cost, and the spread (max − min) of those totals. */
export function repCost(rows: readonly Pick<ScoredRow, "rep" | "metrics" | "verdict">[]): {
  mean: number;
  spread: number;
} {
  const per = new Map<number, number>();
  for (const r of rows) per.set(r.rep, (per.get(r.rep) ?? 0) + runCost(r));
  const t = [...per.values()];
  if (t.length === 0) return { mean: 0, spread: 0 };
  return {
    mean: t.reduce((a, b) => a + b, 0) / t.length,
    spread: Math.max(...t) - Math.min(...t),
  };
}

export interface R4Cell {
  scenario: string;
  model: string;
  surface: string;
  runs: number;
  completed: number;
  exposed: number;
  wrong: number;
  muErrors: number;
  attributable: number;
  review: number;
  noted: number;
}

export interface R4ModelTest {
  model: string;
  variant: { n: number; completed: number };
  base: { n: number; completed: number };
  p: number;
  holmP: number;
  loss: boolean;
}

export interface R4FinalistScore {
  id: string;
  scenarios: string[];
  reps: number;
  models: R4ModelTest[];
  cells: R4Cell[];
  /** §4.5 precondition: a scenario where ≥ half of the finalist's runs are exposed, on a weak model. */
  exercised: boolean;
  eliminated: string[];
  attributable: string[];
  /** Pending review stops (§5.2 outcome 2): the caller appends them and exits 7. */
  reviews: Omit<ReviewStopRow, "kind" | "id">[];
  meanCost: number;
  wins: number;
  winZ: number;
  textDelta: number;
  passes: boolean;
}

export interface R4Score {
  finalists: R4FinalistScore[];
  base: { meanCost: number; spread: number };
  /** null: base stays; undefined: a review stop is pending, no decision yet. */
  winner: string | null | undefined;
  why: string;
}

export interface R4Finalist {
  id: string;
  scenarios: readonly string[];
  /** Reps per scenario for this finalist; base rows above it are left out of its comparison. */
  reps: number;
  wins: number;
  winZ: number;
  textDelta: number;
}

/** A row's place in its round: reps start at `repFloor`. */
const inReps = (r: { rep: number }, floor: number, reps: number): boolean =>
  r.rep >= floor && r.rep < floor + reps;

function cellsOf(rows: readonly ScoredRow[], surface: string): R4Cell[] {
  const by = new Map<string, ScoredRow[]>();
  for (const r of rows) {
    const k = `${r.scenario}|${r.model}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, rs]) => {
      const [scenario = "", model = ""] = k.split("|");
      return {
        scenario,
        model,
        surface,
        runs: rs.length,
        completed: rs.filter((r) => r.verdict.completed).length,
        exposed: rs.filter((r) => r.exposure.length > 0).length,
        wrong: rs.reduce((t, r) => t + r.verdict.wrong.length, 0),
        muErrors: rs.reduce((t, r) => t + r.metrics.muErrors, 0),
        attributable: 0,
        review: 0,
        noted: 0,
      };
    });
}

/**
 * §4.5 over the R4 rows: per finalist and model, one-sided Fisher on completed counts pooled over
 * its exercising scenarios (every run, exposed or not), Holm over the three models at 0.05; the
 * exercised precondition; destructive outcomes per (scenario, model) cell; cost. Then the decision:
 * the passing finalist with the most R2 wins, then R2 win z, lower mean cost, shorter text, id.
 */
export function scoreR4(o: {
  rows: readonly ScoredRow[];
  finalists: readonly R4Finalist[];
  models: readonly string[];
  weak: readonly string[];
  repFloor: number;
  decisions?: readonly { stop: string; decision: "drop" | "continue" }[];
}): R4Score {
  const decided = new Map((o.decisions ?? []).map((d) => [d.stop, d.decision]));
  const base = o.rows.filter((r) => r.variant === BASE);
  const out: R4FinalistScore[] = [];
  for (const f of o.finalists) {
    const scen = new Set(f.scenarios);
    const vr = o.rows.filter(
      (r) => r.variant === f.id && scen.has(r.scenario) && inReps(r, o.repFloor, f.reps),
    );
    const br = base.filter((r) => scen.has(r.scenario) && inReps(r, o.repFloor, f.reps));
    const tests = o.models.map((model) => {
      const a = vr.filter((r) => r.model === model);
      const b = br.filter((r) => r.model === model);
      const v = { n: a.length, completed: a.filter((r) => r.verdict.completed).length };
      const bb = { n: b.length, completed: b.filter((r) => r.verdict.completed).length };
      const p = v.n === 0 || bb.n === 0 ? 1 : fisher(v.completed, v.n, bb.completed, bb.n, "less");
      return { model, variant: v, base: bb, p, holmP: 1, loss: false };
    });
    const h = holm(
      tests.map((t) => t.p),
      ALPHA,
    );
    tests.forEach((t, i) => {
      t.holmP = h.adjusted[i] ?? 1;
      t.loss = h.reject[i] ?? false;
    });
    const exercised = f.scenarios.some((s) =>
      o.weak.some((m) => {
        const rs = vr.filter((r) => r.scenario === s && r.model === m);
        return rs.length > 0 && rs.filter((r) => r.exposure.length > 0).length * 2 >= rs.length;
      }),
    );
    const cells = [...cellsOf(vr, f.id), ...cellsOf(br, BASE)];
    const eliminated: string[] = [];
    if (f.scenarios.length === 0) eliminated.push("no exercising scenario (§4.4 step 5)");
    else if (!exercised) eliminated.push("not exercised (§4.5 precondition)");
    if (tests.some((t) => t.loss)) eliminated.push("loss (R4 Holm)");
    const attributable: string[] = [];
    const reviews: R4FinalistScore["reviews"] = [];
    for (const cell of cells.filter((c) => c.surface === f.id)) {
      const rs = vr.filter((r) => r.scenario === cell.scenario && r.model === cell.model);
      const entries: CellEntry[] = rs.flatMap((r) => runEntries(r.destructiveFx, r.exposure));
      if (entries.length === 0) continue;
      const baseEntries = br
        .filter((r) => r.scenario === cell.scenario && r.model === cell.model)
        .flatMap((r) => r.destructiveFx.map((d) => d.entry));
      const res = destructiveOutcomes(entries, baseEntries);
      cell.attributable = res.attributable.length;
      cell.review = res.review.length;
      cell.noted = res.noted.length;
      const where = `${cell.scenario}/${cell.model}`;
      attributable.push(...res.attributable.map((e) => `${where}: ${e}`));
      if (res.review.length === 0) continue;
      const stop = {
        variant: f.id,
        cell: where,
        entries: res.review,
        transcript: rs
          .filter((r) => r.destructiveFx.length > 0)
          .map((r) => r.log ?? `${r.scenario} rep ${r.rep}`)
          .join(" "),
        source: "r4" as const,
      };
      const d = decided.get(stopId(stop));
      if (d === "drop") eliminated.push(`review drop ${stopId(stop)}`);
      else if (d === undefined) reviews.push(stop);
    }
    if (attributable.length > 0) eliminated.push("attributable destructive");
    out.push({
      id: f.id,
      scenarios: [...f.scenarios],
      reps: f.reps,
      models: tests,
      cells,
      exercised,
      eliminated,
      attributable,
      reviews,
      meanCost: repCost(vr).mean,
      wins: f.wins,
      winZ: f.winZ,
      textDelta: f.textDelta,
      passes: eliminated.length === 0 && reviews.length === 0,
    });
  }
  const bc = repCost(base);
  const baseCost = { meanCost: bc.mean, spread: bc.spread };
  if (out.some((f) => f.reviews.length > 0))
    return { finalists: out, base: baseCost, winner: undefined, why: "review stop pending" };
  const pass = out
    .filter((f) => f.passes && f.wins > 0)
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.winZ - a.winZ ||
        a.meanCost - b.meanCost ||
        a.textDelta - b.textDelta ||
        a.id.localeCompare(b.id),
    );
  const w = pass[0];
  return w
    ? {
        finalists: out,
        base: baseCost,
        winner: w.id,
        why: `${w.id} passes R4 with ${w.wins} R2 win(s) (z ${w.winZ.toFixed(2)})${
          pass.length > 1
            ? `, ahead of ${pass
                .slice(1)
                .map((x) => x.id)
                .join(", ")}`
            : ""
        }`,
      }
    : { finalists: out, base: baseCost, winner: null, why: "no finalist passes R4: base stays" };
}

// ---- the final gate (§4.6) ----------------------------------------------------------------------

/** Holdout reps per (scenario, surface, model): 4 scenarios × 12 = 48 runs per model. */
export const HOLDOUT_REPS = 12;

export interface FinalScore {
  models: R4ModelTest[];
  cells: R4Cell[];
  /** Destructive entries of the combined surface new against base, per cell. */
  newDestructive: { cell: string; entries: string[] }[];
  stop: boolean;
  why: string;
}

/**
 * §4.6: the §4.5 loss test (Holm over three models) of the combined surface against base, and
 * any destructive entry new against base in a (scenario, model) cell. Either is a stop; no
 * attribution, no bisection.
 */
export function scoreFinal(o: {
  rows: readonly ScoredRow[];
  combined: string;
  models: readonly string[];
}): FinalScore {
  const vr = o.rows.filter((r) => r.variant === o.combined);
  const br = o.rows.filter((r) => r.variant === BASE);
  const models = o.models.map((model) => {
    const a = vr.filter((r) => r.model === model);
    const b = br.filter((r) => r.model === model);
    const v = { n: a.length, completed: a.filter((r) => r.verdict.completed).length };
    const bb = { n: b.length, completed: b.filter((r) => r.verdict.completed).length };
    const p = v.n === 0 || bb.n === 0 ? 1 : fisher(v.completed, v.n, bb.completed, bb.n, "less");
    return { model, variant: v, base: bb, p, holmP: 1, loss: false };
  });
  const h = holm(
    models.map((m) => m.p),
    ALPHA,
  );
  models.forEach((m, i) => {
    m.holmP = h.adjusted[i] ?? 1;
    m.loss = h.reject[i] ?? false;
  });
  const cells = [...cellsOf(vr, o.combined), ...cellsOf(br, BASE)];
  const newDestructive: FinalScore["newDestructive"] = [];
  for (const c of cells.filter((x) => x.surface === o.combined)) {
    const of = (rs: readonly ScoredRow[]): string[] =>
      rs
        .filter((r) => r.scenario === c.scenario && r.model === c.model)
        .flatMap((r) => r.destructiveFx.map((d) => d.entry));
    const res = destructiveOutcomes(
      of(vr).map((entry) => ({ entry, attributable: false, unplaced: false })),
      of(br),
    );
    c.review = res.review.length;
    c.noted = res.noted.length;
    if (res.review.length > 0)
      newDestructive.push({ cell: `${c.scenario}/${c.model}`, entries: res.review });
  }
  const lost = models.filter((m) => m.loss).map((m) => m.model);
  const why = [
    ...(lost.length > 0 ? [`holdout loss on ${lost.join(", ")}`] : []),
    ...(newDestructive.length > 0
      ? [`new destructive entries in ${newDestructive.map((d) => d.cell).join(", ")}`]
      : []),
  ];
  return {
    models,
    cells,
    newDestructive,
    stop: why.length > 0,
    why: why.join("; ") || "holdouts pass",
  };
}
