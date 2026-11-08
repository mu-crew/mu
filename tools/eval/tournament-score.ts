// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Tournament scoring (spec docs/specs/2026-11-07-hill-r2-tournament.md §4.1-4.2, unit B3b): the
// scoring of a round (per-case Holm and stratified CMH losses, the pooled weak-model win test at
// 0.05/S with Holm across the group's headline cases, eliminations), the ranking and its fixed
// advance counts. Pure over rows; exposure and attribution come from exposure.ts, the tests from
// stats.ts, the control-row types from tournament.ts.
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
import type { Group, NameCue, ProbeRow } from "./nextstep.ts";
import { cmh, deff, fisher, holm, kish, type Stratum } from "./stats.ts";
import {
  ALPHA,
  CMH_ALPHA,
  DEFAULT_RHO,
  type ReviewStopRow,
  type SetupRow,
  stopId,
} from "./tournament.ts";
import type { VariantRow } from "./tournament-build.ts";

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
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
