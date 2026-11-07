import { describe, expect, it } from "vitest";
import {
  cmh,
  deff,
  fisher,
  fisherPower,
  holm,
  icc,
  iccModel,
  iccPooled,
  kish,
  mde,
  normCdf,
  type Stratum,
  solvePlan,
} from "../../tools/eval/stats.ts";

/** Seeded uniform [0, 1) (mulberry32), so the Monte Carlo checks are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const draw = (u: () => number, n: number, p: number): number => {
  let x = 0;
  for (let i = 0; i < n; i++) if (u() < p) x++;
  return x;
};

describe("Fisher exact", () => {
  it("matches the tea-tasting table (3 of 4 vs 1 of 4)", () => {
    expect(fisher(3, 4, 1, 4, "greater")).toBeCloseTo(17 / 70, 12);
    expect(fisher(3, 4, 1, 4, "less")).toBeCloseTo(69 / 70, 12);
    expect(fisher(4, 4, 0, 4, "greater")).toBeCloseTo(1 / 70, 12);
  });

  // spec §4.2 "Win (pooled weak models)": power 0.5 → 0.8 at α = 0.05/B, and the MDE at 80%, B = 18
  it.each([
    [48, 0.56, 0.65, 0.8, 0.86],
    [66, 0.77, 0.83, 0.92, 0.81],
    [90, 0.92, 0.95, 0.98, 0.77],
    [100, 0.95, 0.97, 0.99, 0.76],
  ])("win power at n_eff %i matches the §4.2 row", (n, b18, b9, b3, mde18) => {
    const pw = (B: number) => fisherPower(0.8, 0.5, n, n, 0.05 / B, "greater");
    expect(Math.abs(pw(18) - b18)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(pw(9) - b9)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(pw(3) - b3)).toBeLessThanOrEqual(0.005);
    expect(mde(0.5, n, 0.05 / 18, "greater")).toBe(mde18);
  });

  // spec §4.2 "Loss, per case": Holm first step of 45 tests, MDE from 0.8 and power for 0.8 → 0.5
  it.each([
    [40, 0.35, 0.33],
    [50, 0.41, 0.48],
    [75, 0.48, 0.76],
  ])("loss at n_eff %i matches the §4.2 row", (n, mdeTo, power) => {
    expect(mde(0.8, n, 0.05 / 45, "less")).toBe(mdeTo);
    expect(Math.abs(fisherPower(0.5, 0.8, n, n, 0.05 / 45, "less") - power)).toBeLessThanOrEqual(
      0.005,
    );
  });

  it("R4: 0.8 → 0.5 at n = 48 per side, α 0.05/3, has power 0.80 (§4.5)", () => {
    expect(Math.abs(fisherPower(0.5, 0.8, 48, 48, 0.05 / 3, "less") - 0.8)).toBeLessThanOrEqual(
      0.005,
    );
  });

  it("power under the null is at most α (Fisher is conservative)", () => {
    for (const p of [0.3, 0.5, 0.8])
      expect(fisherPower(p, p, 50, 50, 0.05, "greater")).toBeLessThanOrEqual(0.05);
  });
});

describe("Holm", () => {
  it("adjusts a known vector (as R's p.adjust(..., 'holm'))", () => {
    const { adjusted, reject } = holm([0.01, 0.04, 0.03, 0.005], 0.05);
    expect(adjusted.map((p) => +p.toFixed(10))).toEqual([0.03, 0.06, 0.06, 0.02]);
    expect(reject).toEqual([true, false, false, true]);
  });
  it("caps at 1 and keeps input order", () => {
    expect(holm([0.9, 0.6]).adjusted).toEqual([1, 1]);
  });
});

describe("normal CDF", () => {
  it("matches reference quantiles", () => {
    expect(normCdf(-1.959963984540054)).toBeCloseTo(0.025, 9);
    expect(normCdf(1.6448536269514722)).toBeCloseTo(0.95, 9);
    expect(normCdf(-3)).toBeCloseTo(0.0013498980316301, 12);
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
  });
});

describe("stratified CMH", () => {
  // UC Berkeley admissions by department (R's UCBAdmissions): male (x1, n1) vs female (x2, n2).
  // R: mantelhaen.test(UCBAdmissions) → Mantel-Haenszel X-squared = 1.4269 (continuity-corrected),
  // p = 0.2323 two-sided; without the correction X-squared = 1.5246.
  const ucb: Stratum[] = [
    [512, 313, 89, 19],
    [353, 207, 17, 8],
    [120, 205, 202, 391],
    [138, 279, 131, 244],
    [53, 138, 94, 299],
    [22, 351, 24, 317],
  ].map(([ma = 0, mr = 0, fa = 0, fr = 0]) => ({ x1: ma, n1: ma + mr, x2: fa, n2: fa + fr }));

  it("matches the reference value", () => {
    const { z, p } = cmh(ucb, "less");
    expect(z * z).toBeCloseTo(1.4269, 3);
    expect(2 * p).toBeCloseTo(0.2323, 3);
    // the other tail: the correction moves z away from the drop
    expect(cmh(ucb, "greater").p).toBeGreaterThan(0.5);
  });

  it("has no evidence without variance", () => {
    expect(cmh([{ x1: 5, n1: 5, x2: 5, n2: 5 }], "less")).toEqual({ z: 0, p: 1 });
  });

  // the §4.2 R2 plan, one model: 3 own headline strata at n_eff 75, 9 cross-group at 50, guards at
  // 40 and 45, cold-guess at 60; α 0.05/3
  const sizes = [75, 75, 75, ...Array<number>(9).fill(50), 40, 45, 60];
  const alpha = 0.05 / 3;
  const rate = (pv: (i: number) => number, draws: number, seed: number): number => {
    const u = rng(seed);
    let rej = 0;
    for (let d = 0; d < draws; d++) {
      const strata = sizes.map((n, i) => ({
        x1: draw(u, n, pv(i)),
        n1: n,
        x2: draw(u, n, 0.8),
        n2: n,
      }));
      if (cmh(strata, "less").p <= alpha) rej++;
    }
    return rej / draws;
  };

  it("rejects at most α under the null (Monte Carlo, 3000 draws)", () => {
    const r = rate(() => 0.8, 3000, 1);
    // nominal 0.0167; Monte Carlo SE ≈ 0.0023
    expect(r).toBeLessThanOrEqual(alpha + 2 * Math.sqrt((alpha * (1 - alpha)) / 3000));
  });

  it("catches a broad 0.8 → 0.7 drop (§4.2: power 0.99)", () => {
    expect(rate(() => 0.7, 500, 2)).toBeGreaterThanOrEqual(0.95);
  });
});

describe("ICC, DEFF and Kish", () => {
  const rows = [
    ...[1, 1].map((h) => ({ cluster: "c1", model: "haiku", hit: h === 1 })),
    ...[1, 0].map((h) => ({ cluster: "c1", model: "gemini", hit: h === 1 })),
    ...[0, 0].map((h) => ({ cluster: "c2", model: "haiku", hit: h === 1 })),
    ...[0, 1].map((h) => ({ cluster: "c2", model: "gemini", hit: h === 1 })),
    // another model's rows never enter the weak-model pool
    ...[1, 1, 1, 1].map(() => ({ cluster: "c2", model: "sonnet", hit: true })),
  ];

  it("one-way ANOVA ICC on a hand-computed table", () => {
    // pooled clusters [1,1,1,0] and [0,0,0,1]: MSB 0.5, MSW 0.25, n0 4 → (0.5−0.25)/(0.5+3·0.25)
    expect(
      icc([
        [1, 1, 1, 0],
        [0, 0, 0, 1],
      ]),
    ).toBeCloseTo(0.2, 12);
    expect(iccPooled(rows, ["haiku", "gemini"])).toBeCloseTo(0.2, 12);
    // per model: haiku's clusters are pure (1); gemini's are anti-correlated (−1), floored at 0.1
    expect(iccModel(rows, "haiku")).toBeCloseTo(1, 12);
    expect(iccModel(rows, "gemini")).toBe(0.1);
    // unequal cluster sizes use n0; [1,1,1] [0] [1,0] by the textbook formula
    expect(icc([[1, 1, 1], [0], [1, 0]])).toBeCloseTo(
      (() => {
        const msb = (3 * (1 - 4 / 6) ** 2 + (0 - 4 / 6) ** 2 + 2 * (0.5 - 4 / 6) ** 2) / 2;
        const msw = 0.5 / 3;
        const n0 = (6 - (9 + 1 + 4) / 6) / 2;
        return (msb - msw) / (msb + (n0 - 1) * msw);
      })(),
      12,
    );
  });

  it("design effect and Kish-scaled counts", () => {
    expect(deff(4, 0.2)).toBeCloseTo(1.6, 12);
    expect(kish(120, 90, 1.6)).toEqual({ n: 75, hits: 56 });
    expect(kish(3, 3, 2)).toEqual({ n: 2, hits: 2 });
  });
});

describe("n plan solver", () => {
  // the §4.2 plan at ρ̂ = ρ̂_pool = 0.2
  it("cross-group headline and guards meet their per-model targets at the planned r", () => {
    expect(solvePlan({ paraphrases: 10, arms: 3, rho: 0.2, target: 40 })).toMatchObject({
      r: 2,
      nEff: 50,
      add: 0,
    });
    expect(solvePlan({ paraphrases: 6, arms: 2, rho: 0.2, target: 40 })).toMatchObject({
      r: 8,
      reached: true,
    });
    expect(solvePlan({ paraphrases: 6, arms: 3, rho: 0.2, target: 40 })).toMatchObject({
      r: 4,
      nEff: 45,
    });
  });

  it("own headline: the smallest r meeting both per-model 60 and pooled 90", () => {
    const p = solvePlan({
      paraphrases: 10,
      arms: 3,
      rho: 0.2,
      target: 60,
      pooled: { target: 90, rho: 0.2 },
    });
    // r = 3 gives per-model 64.3 and pooled exactly 90 (the §4.2 table shows r = 4: one rep of margin)
    expect(p).toMatchObject({ r: 3, add: 0, reached: true });
    expect(p.nEffPooled).toBeCloseTo(90, 9);
  });

  it("an unreachable target (m/ρ̂ < 1.25 × target) adds paraphrases first", () => {
    // ρ̂ 0.3: 30/0.3 = 100 < 112.5 → 12 paraphrases (36/0.3 = 120), then r = 4
    const p = solvePlan({
      paraphrases: 10,
      arms: 3,
      rho: 0.3,
      target: 60,
      pooled: { target: 90, rho: 0.3 },
    });
    expect(p).toMatchObject({ paraphrases: 12, add: 2, m: 36, r: 4, reached: true });
    expect(p.nEffPooled ?? 0).toBeGreaterThanOrEqual(90);
  });

  it("still short at 14 paraphrases: reached false, n_eff at 0.8 of its asymptote", () => {
    const p = solvePlan({
      paraphrases: 10,
      arms: 3,
      rho: 0.6,
      target: 60,
      pooled: { target: 90, rho: 0.6 },
    });
    expect(p).toMatchObject({ paraphrases: 14, add: 4, m: 42, reached: false });
    expect(p.nEff).toBeGreaterThanOrEqual((0.8 * 42) / 0.6 - 1e-9);
  });
});
