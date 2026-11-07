// Tournament statistics (spec docs/specs/2026-11-07-hill-r2-tournament.md §4.1-4.2). Pure: no I/O.
//
// Every test here is one-sided. A 2×2 table is (variant hits x1 of n1, base hits x2 of n2).
// "greater" asks whether the variant beats base (a win); "less" whether it drops (a loss).

export type Alt = "greater" | "less";

// ---- log factorials and the hypergeometric ------------------------------------------------------

const LF: number[] = [0];
function logFact(n: number): number {
  for (let i = LF.length; i <= n; i++) LF[i] = (LF[i - 1] ?? 0) + Math.log(i);
  return LF[n] ?? 0;
}
const logChoose = (n: number, k: number): number =>
  k < 0 || k > n ? Number.NEGATIVE_INFINITY : logFact(n) - logFact(k) - logFact(n - k);

/** P(X = x) for X ~ Hypergeometric(population N, K successes, n draws). */
function hyper(x: number, N: number, K: number, n: number): number {
  return Math.exp(logChoose(K, x) + logChoose(N - K, n - x) - logChoose(N, n));
}

/** P(X = x) for X ~ Binomial(n, p). */
export function binom(x: number, n: number, p: number): number {
  if (p <= 0) return x === 0 ? 1 : 0;
  if (p >= 1) return x === n ? 1 : 0;
  return Math.exp(logChoose(n, x) + x * Math.log(p) + (n - x) * Math.log(1 - p));
}

// ---- Fisher exact ------------------------------------------------------------------------------

/**
 * One-sided Fisher exact p for the variant's hits x1 of n1 against base's x2 of n2, conditional on
 * the margins. "greater": P(X ≥ x1) (H0 p_variant ≤ p_base); "less": P(X ≤ x1) (H0 p_variant ≥ p_base).
 */
export function fisher(x1: number, n1: number, x2: number, n2: number, alt: Alt): number {
  const N = n1 + n2;
  const K = x1 + x2;
  const lo = Math.max(0, K - n2);
  const hi = Math.min(K, n1);
  let p = 0;
  if (alt === "greater") for (let x = x1; x <= hi; x++) p += hyper(x, N, K, n1);
  else for (let x = lo; x <= x1; x++) p += hyper(x, N, K, n1);
  return Math.min(1, p);
}

/**
 * Exact power of the one-sided Fisher test at level `alpha`, by enumeration: the variant's true hit
 * rate `pv` over n1 rows, base's `pb` over n2 rows.
 */
export function fisherPower(
  pv: number,
  pb: number,
  n1: number,
  n2: number,
  alpha: number,
  alt: Alt,
): number {
  const N = n1 + n2;
  // For each total K, the rejection region in x1 is a tail: its critical value.
  const crit: number[] = [];
  for (let K = 0; K <= N; K++) {
    const lo = Math.max(0, K - n2);
    const hi = Math.min(K, n1);
    let tail = 0;
    let c = alt === "greater" ? hi + 1 : lo - 1; // no rejection
    if (alt === "greater")
      for (let x = hi; x >= lo; x--) {
        tail += hyper(x, N, K, n1);
        if (tail > alpha) break;
        c = x;
      }
    else
      for (let x = lo; x <= hi; x++) {
        tail += hyper(x, N, K, n1);
        if (tail > alpha) break;
        c = x;
      }
    crit[K] = c;
  }
  const b1 = Array.from({ length: n1 + 1 }, (_, x) => binom(x, n1, pv));
  const b2 = Array.from({ length: n2 + 1 }, (_, x) => binom(x, n2, pb));
  let power = 0;
  for (let x1 = 0; x1 <= n1; x1++)
    for (let x2 = 0; x2 <= n2; x2++) {
      const c = crit[x1 + x2] ?? 0;
      if (alt === "greater" ? x1 >= c : x1 <= c) power += (b1[x1] ?? 0) * (b2[x2] ?? 0);
    }
  return power;
}

/**
 * Minimum detectable effect: the variant rate (on a 0.01 grid, moving away from `pb` in the test's
 * direction) at which the Fisher test at `alpha` over n rows a side first reaches `power`. Null
 * when no rate in [0, 1] reaches it.
 */
export function mde(pb: number, n: number, alpha: number, alt: Alt, power = 0.8): number | null {
  const step = alt === "greater" ? 0.01 : -0.01;
  for (let i = 1; i <= 100; i++) {
    const pv = Math.round((pb + step * i) * 100) / 100;
    if (pv < 0 || pv > 1) return null;
    if (fisherPower(pv, pb, n, n, alpha, alt) >= power) return pv;
  }
  return null;
}

// ---- Holm --------------------------------------------------------------------------------------

/** Holm step-down at family-wise `alpha`: adjusted p (monotone, capped at 1) and rejection, in input order. */
export function holm(
  ps: readonly number[],
  alpha = 0.05,
): { adjusted: number[]; reject: boolean[] } {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const adjusted = new Array<number>(m).fill(1);
  let run = 0;
  order.forEach(({ p, i }, k) => {
    run = Math.max(run, Math.min(1, (m - k) * p));
    adjusted[i] = run;
  });
  return { adjusted, reject: adjusted.map((a) => a <= alpha) };
}

// ---- the normal and the stratified CMH test ----------------------------------------------------

/** Standard normal CDF: Hart's double-precision rational form (G. West, "Better approximations to cumulative normal functions", 2005). */
export function normCdf(z: number): number {
  const x = Math.abs(z);
  let c: number;
  if (x > 37) c = 0;
  else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let n = 3.52624965998911e-2 * x + 0.700383064443688;
      n = n * x + 6.37396220353165;
      n = n * x + 33.912866078383;
      n = n * x + 112.079291497871;
      n = n * x + 221.213596169931;
      n = n * x + 220.206867912376;
      let d = 8.83883476483184e-2 * x + 1.75566716318264;
      d = d * x + 16.064177579207;
      d = d * x + 86.7807322029461;
      d = d * x + 296.564248779674;
      d = d * x + 637.333633378831;
      d = d * x + 793.826512519948;
      d = d * x + 440.413735824752;
      c = (e * n) / d;
    } else {
      let d = x + 0.65;
      d = x + 4 / d;
      d = x + 3 / d;
      d = x + 2 / d;
      d = x + 1 / d;
      c = e / d / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}

export interface Stratum {
  /** variant hits */
  x1: number;
  n1: number;
  /** base hits */
  x2: number;
  n2: number;
}

/**
 * One-sided Cochran-Mantel-Haenszel test with continuity correction over 2×2 strata (spec §4.1 loss
 * test 2). z = (Σx1 − ΣE ± ½)/√ΣV, E and V the hypergeometric mean and variance of x1 in each
 * stratum. "less": p = Φ(z) with +½ (a drop); "greater": p = 1 − Φ(z) with −½. A stratum with
 * fewer than 2 rows adds nothing; with no variance at all, p = 1.
 */
export function cmh(strata: readonly Stratum[], alt: Alt): { z: number; p: number } {
  let s = 0;
  let e = 0;
  let v = 0;
  for (const t of strata) {
    const N = t.n1 + t.n2;
    if (N < 2) continue;
    const m1 = t.x1 + t.x2;
    s += t.x1;
    e += (t.n1 * m1) / N;
    v += (t.n1 * t.n2 * m1 * (N - m1)) / (N * N * (N - 1));
  }
  if (v <= 0) return { z: 0, p: 1 };
  const z = alt === "less" ? (s - e + 0.5) / Math.sqrt(v) : (s - e - 0.5) / Math.sqrt(v);
  return { z, p: alt === "less" ? normCdf(z) : 1 - normCdf(z) };
}

/**
 * Power of the one-sided CMH drop test at `alpha` by Monte Carlo on scaled counts (spec §4.2's
 * method): each stratum draws base hits from Bin(n, pb) and the variant's from Bin(n, pv), n its
 * rounded n_eff. Seeded (mulberry32), so a plan prints the same number every time.
 */
export function cmhPower(
  strata: readonly { nEff: number; pb: number; pv: number }[],
  alpha: number,
  draws = 3000,
  seed = 1,
): number {
  let a = seed >>> 0;
  const u = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bin = (n: number, p: number): number => {
    let x = 0;
    for (let i = 0; i < n; i++) if (u() < p) x++;
    return x;
  };
  let rej = 0;
  for (let d = 0; d < draws; d++) {
    const s = strata.map((t) => {
      const n = Math.round(t.nEff);
      return { x1: bin(n, t.pv), n1: n, x2: bin(n, t.pb), n2: n };
    });
    if (cmh(s, "less").p <= alpha) rej++;
  }
  return rej / draws;
}

// ---- correlation, design effect, Kish scaling --------------------------------------------------

/** The ICC floor of spec §4.1: ρ̂ and ρ̂_pool are never taken below it. */
export const ICC_FLOOR = 0.1;

/**
 * One-way ANOVA intra-cluster correlation over 0/1 rows grouped in clusters (unequal sizes: n0
 * form). Clusters with no rows are ignored. 0 when it is undefined (one cluster, or no variance).
 * Not floored: use `iccFloored` for the planning value.
 */
export function icc(clusters: readonly (readonly number[])[]): number {
  const cs = clusters.filter((c) => c.length > 0);
  const k = cs.length;
  const N = cs.reduce((t, c) => t + c.length, 0);
  if (k < 2 || N <= k) return 0;
  const mean = cs.reduce((t, c) => t + c.reduce((a, b) => a + b, 0), 0) / N;
  let ssb = 0;
  let ssw = 0;
  for (const c of cs) {
    const m = c.reduce((a, b) => a + b, 0) / c.length;
    ssb += c.length * (m - mean) ** 2;
    for (const y of c) ssw += (y - m) ** 2;
  }
  const msb = ssb / (k - 1);
  const msw = ssw / (N - k);
  const n0 = (N - cs.reduce((t, c) => t + c.length ** 2, 0) / N) / (k - 1);
  const den = msb + (n0 - 1) * msw;
  return den <= 0 ? 0 : (msb - msw) / den;
}

export const iccFloored = (clusters: readonly (readonly number[])[], floor = ICC_FLOOR): number =>
  Math.max(floor, icc(clusters));

/** One row of a cell, for ICC estimation: its cluster key (arm, paraphrase), model and hit. */
export interface IccRow {
  cluster: string;
  model: string;
  hit: boolean;
}

const groupBy = (rows: readonly IccRow[], key: (r: IccRow) => string): number[][] => {
  const m = new Map<string, number[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.hit ? 1 : 0]);
  return [...m.values()];
};

/** ρ̂ for one model: clusters are (arm, paraphrase) on that model's rows only. Floored. */
export const iccModel = (rows: readonly IccRow[], model: string, floor = ICC_FLOOR): number =>
  iccFloored(
    groupBy(
      rows.filter((r) => r.model === model),
      (r) => r.cluster,
    ),
    floor,
  );

/**
 * ρ̂_pool: the rows of `models` pooled, a cluster being (arm, paraphrase) across those models (2r
 * rows for two models at r reps), so the shared-prompt dependence between models lands inside the
 * cluster. Floored.
 */
export const iccPooled = (
  rows: readonly IccRow[],
  models: readonly string[],
  floor = ICC_FLOOR,
): number =>
  iccFloored(
    groupBy(
      rows.filter((r) => models.includes(r.model)),
      (r) => r.cluster,
    ),
    floor,
  );

/** Design effect of clusters of `r` correlated rows: 1 + (r − 1)·ρ. */
export const deff = (r: number, rho: number): number => 1 + (r - 1) * rho;

/** Kish-scaled counts: n* = round(n / DEFF), hits* = round(hits / DEFF) (rounding is monotone, so hits* ≤ n*). */
export const kish = (n: number, hits: number, d: number): { n: number; hits: number } => ({
  n: Math.round(n / d),
  hits: Math.round(hits / d),
});

// ---- the n plan --------------------------------------------------------------------------------

export interface PlanInput {
  paraphrases: number;
  arms: number;
  /** ρ̂ for the case (the largest over its models: the plan must hold on every model). */
  rho: number;
  /** Per-model n_eff target (60 own headline, 40 cross-group and guards). */
  target: number;
  /** Own headline only: the pooled weak-model target (90) and ρ̂_pool. */
  pooled?: { target: number; rho: number };
  /** Paraphrases B4b may add up to (spec §1.4: p14). */
  maxParaphrases?: number;
}

export interface Plan {
  paraphrases: number;
  /** Paraphrases the case must gain before the freeze. */
  add: number;
  /** clusters = paraphrases × arms */
  m: number;
  r: number;
  nEff: number;
  nEffPooled?: number;
  /** Every target is met. False: the case is short; its achieved n_eff and MDE go in the freeze row. */
  reached: boolean;
}

/** Per model n_eff of m clusters of r rows. */
export const nEff = (m: number, r: number, rho: number): number => (m * r) / deff(r, rho);
/** Pooled over two models: clusters of 2r rows. */
export const nEffPooled = (m: number, r: number, rho: number): number =>
  (2 * m * r) / deff(2 * r, rho);

const MARGIN = 1.25;
const MAX_R = 1000;
/** Float slack: 96 / (1 + 7·0.2) is 39.999… in doubles, and it meets a target of 40. */
const EPS = 1e-9;

/**
 * The n plan of spec §4.2 for one case. Reps cannot reach a target when m/ρ̂ < 1.25 × target (the
 * n_eff asymptote leaves no margin): then the fewest extra paraphrases that make m/ρ̂ ≥ 1.25 ×
 * target on every target, up to `maxParaphrases`. Then the smallest r meeting every target. A case
 * still short at the cap gets the r at which each n_eff reaches 0.8 of its asymptote (the point
 * where the 1.25 margin would have put the target), and `reached: false`.
 */
export function solvePlan(o: PlanInput): Plan {
  const max = Math.max(o.maxParaphrases ?? 14, o.paraphrases);
  const ok = (m: number): boolean =>
    m / o.rho >= MARGIN * o.target - EPS &&
    (!o.pooled || m / o.pooled.rho >= MARGIN * o.pooled.target - EPS);
  let p = o.paraphrases;
  while (p < max && !ok(p * o.arms)) p++;
  const m = p * o.arms;
  const reached = ok(m);
  const goal = reached ? o.target : (0.8 * m) / o.rho;
  const goalPooled = o.pooled ? (reached ? o.pooled.target : (0.8 * m) / o.pooled.rho) : 0;
  let r = 1;
  while (
    r < MAX_R &&
    (nEff(m, r, o.rho) < goal - EPS ||
      (o.pooled && nEffPooled(m, r, o.pooled.rho) < goalPooled - EPS))
  )
    r++;
  return {
    paraphrases: p,
    add: p - o.paraphrases,
    m,
    r,
    nEff: nEff(m, r, o.rho),
    ...(o.pooled ? { nEffPooled: nEffPooled(m, r, o.pooled.rho) } : {}),
    reached,
  };
}
