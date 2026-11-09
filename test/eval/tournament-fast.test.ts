// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Fast mode (spec §4.7, user decision 2026-11-09): the R1 plan, the fast win rule and decision,
// and the CLI refusing R2/R3/R4 per group.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NextCase, ProbeRow } from "../../tools/eval/nextstep.ts";
import { normQuantile } from "../../tools/eval/stats.ts";
import {
  assertFrozen,
  assertMode,
  type ControlRow,
  controlFile,
  DEFAULT_WIN_RULE,
  FAST_TARGET,
  FastModeError,
  freshRows,
  LEGACY_WIN_RULE,
  modeOf,
  nPlan,
  parseWinRule,
  readControl,
  roundJobs,
  ruleTests,
  winRuleOf,
  winZ,
} from "../../tools/eval/tournament.ts";
import { migrateFast, tournamentCli } from "../../tools/eval/tournament-cli.ts";
import { fastFacts, renderReport } from "../../tools/eval/tournament-report.ts";
import {
  BASE,
  decideFast,
  fastErrorRates,
  type ScoreInput,
  scoreRound,
  type VariantScore,
} from "../../tools/eval/tournament-score.ts";
import { withEnv } from "../_env.ts";
import { cellRows, GEMINI, HAIKU, prompt, rng, row, SONNET, spec } from "./_tournament-rows.ts";

const setup: ScoreInput["setup"] = {
  models: { weak: [HAIKU, GEMINI], gate: SONNET },
  rho: {},
  rhoPool: {},
};
const fastInput = (
  rows: ProbeRow[],
  ids: string[],
  headline = ["h1"],
  fastZ = 1.65,
): ScoreInput => ({
  round: "r1",
  group: "c1_wait",
  rows,
  variants: ids.map((id) => ({ id, spec, textDelta: id.length })),
  setup,
  headline,
  headlineAny: headline,
  nameCues: [],
  prompt,
  fast: true,
  fastZ,
});
/** R1 rows at the fast plan (10 × 3 clusters, r = 1) on one case. */
const r1 = (surface: string, p: number | Record<string, number>, rand: () => number) =>
  cellRows({
    surface,
    caseId: "h1",
    models: [HAIKU, GEMINI, SONNET],
    p,
    r: 1,
    rand,
    round: "r1",
  });

const fakeCase = (id: string, group: NextCase["group"] = "c1_wait"): NextCase =>
  ({
    id,
    group,
    role: "headline",
    arms: ["none", "skill", "recipe:orchestrator-loop"],
    paraphrases: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, goal: "g" })),
    expectedRowMs: 30_000,
  }) as unknown as NextCase;

describe("fast plan", () => {
  it("plans the own headline cases only, at n_eff 30 per model and 45 pooled, and R1 runs the plan's reps", () => {
    const cases = [fakeCase("own"), fakeCase("cross", "c2_close")];
    const plan = nPlan("c1_wait", cases, null, "fast");
    expect(plan.map((p) => p.case)).toEqual(["own"]);
    const [own] = plan;
    expect(FAST_TARGET).toEqual({ own: 30, pooled: 45 });
    // ρ 0.2, 10 × 3 clusters: r = 1 gives 30 per model and 60 / 1.2 = 50 pooled
    expect(own?.plan).toMatchObject({ m: 30, r: 1, reached: true });
    expect(own?.plan.nEff).toBeCloseTo(30, 6);
    expect(own?.plan.nEffPooled).toBeCloseTo(50, 6);
    expect(own?.r1).toBe(own?.plan.r);
    expect(own?.mde).not.toBeNull();
    // at a high ρ the plan needs more reps, and R1 runs them
    const hi = nPlan(
      "c1_wait",
      cases,
      {
        models: setup.models,
        rho: { own: { [HAIKU]: 0.4, [GEMINI]: 0.4, [SONNET]: 0.4 } },
        rhoPool: { own: 0.4 },
      },
      "fast",
    );
    expect(hi[0]?.r1).toBeGreaterThan(1);
    const jobs = roundJobs(
      "r1",
      "c1_wait",
      cases,
      hi,
      {
        surfaces: [{ label: BASE, surface: {} as never }],
        models: [HAIKU],
      },
      { seed: "s", epoch: 0 },
    );
    expect(jobs).toHaveLength(30 * (hi[0]?.r1 ?? 0));
    // full mode keeps R1 at one rep
    expect(nPlan("c1_wait", cases, null)[0]?.r1).toBe(1);
  });
});

describe("fast win rule (decide --fast)", () => {
  it("a true 0.5 → 0.8 variant wins with power ≥ 0.85 (Monte Carlo)", () => {
    const rand = rng(21);
    const sims = 200;
    let won = 0;
    for (let s = 0; s < sims; s++) {
      const rows = [...r1(BASE, 0.5, rand), ...r1("v1", 0.8, rand)];
      if (decideFast(scoreRound(fastInput(rows, ["v1"]))).winner === "v1") won++;
    }
    // measured 0.94 at the fast plan, ρ 0.2
    expect(won / sims).toBeGreaterThanOrEqual(0.85);
  });

  it("a null variant usually ties: no winner at least 0.9 of the time (Monte Carlo)", () => {
    const rand = rng(22);
    const sims = 300;
    let tied = 0;
    for (let s = 0; s < sims; s++) {
      const rows = [...r1(BASE, 0.5, rand), ...r1("v1", 0.5, rand)];
      if (decideFast(scoreRound(fastInput(rows, ["v1"]))).winner === null) tied++;
    }
    // per test about 0.05: z ≥ 1.65 is nominal one-sided 0.05
    expect(tied / sims).toBeGreaterThanOrEqual(0.9);
  });

  it("a 0.8 → 0.5 variant is eliminated by a loss at least 0.8 of the time, and never wins", () => {
    const rand = rng(23);
    const sims = 100;
    let lost = 0;
    for (let s = 0; s < sims; s++) {
      const rows = [...r1(BASE, 0.8, rand), ...r1("v1", 0.5, rand)];
      const scores = scoreRound(fastInput(rows, ["v1"]));
      if (scores[0]?.eliminated.includes("loss (per-case Holm)")) lost++;
      expect(decideFast(scores).winner).toBeNull();
    }
    expect(lost / sims).toBeGreaterThanOrEqual(0.8);
  });

  /** Deterministic rows: per cluster one row per model, hit for the first `k` of 30 clusters. */
  const det = (surface: string, hits: Record<string, number>, promptSha = "exposed") =>
    Array.from({ length: 30 }, (_, c) =>
      Object.entries(hits).map(([model, k]) =>
        row({
          surface,
          case: "h1",
          round: "r1",
          rep: 1,
          model,
          arm: `a${c % 3}` as ProbeRow["arm"],
          paraphrase: `p${Math.floor(c / 3)}`,
          hit: c < k,
          promptSha,
        }),
      ),
    ).flat();
  const at = (h: number, g: number, s = 20) => ({ [HAIKU]: h, [GEMINI]: g, [SONNET]: s });

  it("both weak models must be ahead: a pooled z ≥ 1.65 carried by one model alone is no win", () => {
    const base = det(BASE, at(15, 15));
    const carried = scoreRound(fastInput([...base, ...det("v1", at(30, 15))], ["v1"]));
    expect(carried[0]?.win[0]?.z).toBeGreaterThanOrEqual(1.65);
    expect(carried[0]?.win[0]?.win).toBe(false);
    const both = scoreRound(fastInput([...base, ...det("v1", at(23, 22))], ["v1"]));
    expect(both[0]?.win[0]?.z).toBeGreaterThanOrEqual(1.65);
    expect(both[0]?.win[0]?.win).toBe(true);
  });

  it("the threshold is pinned from both sides: z at it wins, z just below it ties", () => {
    const base = det(BASE, at(15, 15));
    const cell = (h: number, g: number, fastZ: number) =>
      scoreRound(fastInput([...base, ...det("v1", at(h, g))], ["v1"], ["h1"], fastZ))[0]?.win[0];
    const z = cell(21, 21, 99)?.z ?? 0;
    expect(z).toBeGreaterThan(1.65);
    expect(cell(21, 21, z)?.win).toBe(true);
    expect(cell(21, 21, z + 1e-9)?.win).toBe(false);
    // the default rule's thresholds bracket this cell's z: it wins at 6 tests, ties at 12
    const z6 = winZ(DEFAULT_WIN_RULE, 6, 1);
    const z12 = winZ(DEFAULT_WIN_RULE, 6, 2);
    expect(z6).toBeLessThan(z);
    expect(z12).toBeGreaterThan(z);
    expect(cell(21, 21, z6)?.win).toBe(true);
    expect(cell(21, 21, z12)?.win).toBe(false);
    expect(() => scoreRound({ ...fastInput(base, ["v1"]), fastZ: undefined })).toThrow(
      /win threshold/,
    );
  });

  it("exposure gates wins: an unexposed variant does not win", () => {
    const rows = [...det(BASE, at(15, 15)), ...det("v1", at(28, 28), "plain")];
    const [v] = scoreRound(fastInput(rows, ["v1"]));
    expect(v?.win[0]?.unexposed).toBe(true);
    expect(v?.wins).toBe(0);
  });

  it("at most one winner: the highest pooled z, then the shorter text", () => {
    const base = det(BASE, at(15, 15));
    const rows = [...base, ...det("v1", at(24, 24)), ...det("v22", at(27, 27))];
    const scores = scoreRound(fastInput(rows, ["v1", "v22"]));
    expect(scores.every((s) => s.wins === 1)).toBe(true);
    expect(decideFast(scores)).toMatchObject({ winner: "v22", ranking: ["v22", "v1"] });
    const tie = scoreRound(
      fastInput([...base, ...det("v1", at(24, 24)), ...det("v22", at(24, 24))], ["v22", "v1"]),
    );
    expect(decideFast(tie).winner).toBe("v1"); // textDelta = id length: v1 is shorter
  });

  it("an eliminated variant cannot win, and a non-fast score has no fast win", () => {
    const s = (over: Partial<VariantScore>): VariantScore =>
      ({
        id: "v1",
        eliminated: [],
        reviews: [],
        wins: 1,
        winZ: 3,
        textDelta: 1,
        win: [],
        ...over,
      }) as VariantScore;
    expect(decideFast([s({ eliminated: ["loss (per-case Holm)"] })]).winner).toBeNull();
    expect(decideFast([s({ wins: 0 })]).winner).toBeNull();
    expect(() => scoreRound({ ...fastInput([], ["v1"]), round: "r2" })).toThrow(/R1 rows only/);
  });
});

describe("fast win threshold (data on the freeze row)", () => {
  it("is z at one-sided alpha over the corrected tests", () => {
    expect(ruleTests({ alpha: 0.2, correct: "none" }, 6, 3)).toBe(1);
    expect(ruleTests({ alpha: 0.2, correct: "variants" }, 6, 3)).toBe(6);
    expect(ruleTests({ alpha: 0.2, correct: "bonferroni" }, 6, 3)).toBe(18);
    expect(ruleTests({ alpha: 0.2, correct: "bonferroni" }, 0, 3)).toBe(1);
    // option A: none at 0.05 is the old 1.65; option B at 0.10 over 12 tests is 2.39
    expect(winZ(LEGACY_WIN_RULE, 6, 3)).toBeCloseTo(1.645, 3);
    expect(winZ({ alpha: 0.1, correct: "bonferroni" }, 6, 2)).toBeCloseTo(2.394, 3);
    // the chosen default: bonferroni at family 0.20
    expect(DEFAULT_WIN_RULE).toEqual({ alpha: 0.2, correct: "bonferroni" });
    expect(winZ(DEFAULT_WIN_RULE, 6, 1)).toBeCloseTo(1.834, 3);
    expect(winZ(DEFAULT_WIN_RULE, 6, 2)).toBeCloseTo(2.128, 3);
    expect(winZ(DEFAULT_WIN_RULE, 6, 3)).toBeCloseTo(2.287, 3);
    expect(normQuantile(0.975)).toBeCloseTo(1.959964, 5);
  });

  it("parses --win-alpha and --correct, defaulting to bonferroni at 0.20, and refuses nonsense", () => {
    expect(parseWinRule(undefined, undefined)).toEqual(DEFAULT_WIN_RULE);
    expect(parseWinRule("0.1", "variants")).toEqual({ alpha: 0.1, correct: "variants" });
    expect(() => parseWinRule("2", undefined)).toThrow(/--win-alpha/);
    expect(() => parseWinRule(undefined, "holm")).toThrow(/--correct/);
  });

  it("is read from the latest freeze or migration; a fast freeze without one is the legacy rule", () => {
    const fz = (over: object) =>
      ({
        kind: "freeze",
        judgesHash: "h",
        files: [],
        nPlan: [],
        checks: "skipped",
        ...over,
      }) as ControlRow;
    expect(winRuleOf([fz({ mode: "fast" })])).toEqual(LEGACY_WIN_RULE);
    expect(winRuleOf([fz({ mode: "fast", win: { alpha: 0.1, correct: "none" } })])).toEqual({
      alpha: 0.1,
      correct: "none",
    });
  });
});

describe("fast error rates (Monte Carlo)", () => {
  // oracle: the reviewer's independent Monte Carlo (delegate_rv-fast_907974bb): 30 clusters, ρ 0.2,
  // one row per weak model per cluster, base shared across the group
  const c30 = { clusters: 30, reps: 1, rho: 0.2 };
  const at = (variants: number, h: number, z: number) =>
    fastErrorRates({ variants, cases: Array(h).fill(c30), z, iters: 3000 });

  it("reproduces the uncorrected z ≥ 1.65 false-win table and its power", () => {
    expect(Math.abs(at(6, 1, 1.65).falseWin - 0.195)).toBeLessThan(0.04);
    expect(Math.abs(at(6, 3, 1.65).falseWin - 0.49)).toBeLessThan(0.08);
    expect(Math.abs(at(6, 1, 1.65).power - 0.94)).toBeLessThan(0.03);
  });

  it("reproduces Bonferroni at 0.10: per-group rate and power at 6 × 1, 6 × 3 and 12 × 3", () => {
    const b = (n: number, h: number) => at(n, h, winZ({ alpha: 0.1, correct: "bonferroni" }, n, h));
    const r61 = b(6, 1);
    const r63 = b(6, 3);
    const r123 = b(12, 3);
    expect(Math.abs(r61.falseWin - 0.079)).toBeLessThan(0.03);
    expect(Math.abs(r63.falseWin - 0.071)).toBeLessThan(0.03);
    expect(Math.abs(r123.falseWin - 0.075)).toBeLessThan(0.03);
    expect(Math.abs(r61.power - 0.86)).toBeLessThan(0.03);
    expect(Math.abs(r63.power - 0.75)).toBeLessThan(0.03);
    expect(Math.abs(r123.power - 0.66)).toBeLessThan(0.03);
  });

  it("the chosen default holds about 0.15 per group at power about 0.8", () => {
    for (const [n, h] of [
      [6, 1],
      [6, 2],
      [6, 3],
    ] as const) {
      const r = at(n, h, winZ(DEFAULT_WIN_RULE, n, h));
      expect(r.falseWin).toBeGreaterThan(0.09);
      expect(r.falseWin).toBeLessThan(0.19);
      expect(r.power).toBeGreaterThan(0.78);
    }
  });

  it("matches scoreRound's rule on synthetic rows (6 null variants, one case, z 1.65)", () => {
    const rand = rng(31);
    const sims = 300;
    let any = 0;
    for (let s = 0; s < sims; s++) {
      const ids = ["v1", "v2", "v3", "v4", "v5", "v6"];
      const rows = [BASE, ...ids].flatMap((sf) =>
        cellRows({
          surface: sf,
          caseId: "h1",
          models: [HAIKU, GEMINI],
          p: 0.5,
          r: 1,
          rand,
          round: "r1",
        }),
      );
      if (scoreRound(fastInput(rows, ids)).some((v) => v.wins > 0)) any++;
    }
    expect(Math.abs(any / sims - at(6, 1, 1.65).falseWin)).toBeLessThan(0.06);
  });

  it("needs both weak models ahead, as scoreRound does: at z* 0 a null variant wins far less than half", () => {
    // pooled ahead alone is about 0.5; both models ahead as well is about 0.35
    const mc = at(1, 1, 0).falseWin;
    const rand = rng(32);
    const sims = 400;
    let won = 0;
    for (let s = 0; s < sims; s++) {
      const rows = [BASE, "v1"].flatMap((sf) =>
        cellRows({
          surface: sf,
          caseId: "h1",
          models: [HAIKU, GEMINI],
          p: 0.5,
          r: 1,
          rand,
          round: "r1",
        }),
      );
      if ((scoreRound(fastInput(rows, ["v1"], ["h1"], 0))[0]?.wins ?? 0) > 0) won++;
    }
    expect(mc).toBeLessThan(0.42);
    expect(Math.abs(mc - won / sims)).toBeLessThan(0.07);
  });
});

describe("fast report facts", () => {
  it("states the rule, its threshold and the Monte Carlo rates at the group's design and field", () => {
    const plan = nPlan("c1_wait", [fakeCase("a"), fakeCase("b")], null, "fast");
    const f = fastFacts(plan, 6, { rule: DEFAULT_WIN_RULE, iters: 2000 });
    expect(f.tests).toBe(12);
    expect(f.z).toBeCloseTo(2.128, 3);
    expect(f.design).toEqual([
      { clusters: 30, reps: 1, rho: 0.2 },
      { clusters: 30, reps: 1, rho: 0.2 },
    ]);
    expect(f.falseWin).toBeGreaterThan(0.09);
    expect(f.falseWin).toBeLessThan(0.19);
    expect(f.power).toBeGreaterThan(0.78);
    expect(f.falseWinAny).toBeCloseTo(1 - (1 - f.falseWin) ** 6, 10);
  });
});

describe("fast report", () => {
  it("renders the fast section, skips R2/R3/R4, and shows the fast decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "mu-fast-report-"));
    try {
      const plan = nPlan("c1_wait", [fakeCase("a")], null, "fast");
      const rows = [
        {
          kind: "freeze",
          judgesHash: "h",
          files: [],
          mode: "fast",
          targets: FAST_TARGET,
          nPlan: plan,
          checks: "skipped",
        },
        { kind: "round_score", round: "r1", epoch: 0, S: null, mode: "fast", scores: [] },
        {
          kind: "decision",
          mode: "fast",
          epoch: 0,
          winner: "v1",
          why: "fast: v1 wins on a z 2.10",
        },
      ];
      writeFileSync(controlFile(dir), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
      const md = renderReport({ group: "c1_wait", dir, candDir: join(dir, "none") });
      expect(md).toContain("### Fast mode (user decision 2026-11-09)");
      // a fast freeze row without `win` is the legacy rule; with no R1 field yet, 0 variants
      expect(md).toContain("family α 0.05 one-sided, uncorrected: 1 tests, z ≥ 1.64");
      expect(md).toMatch(
        /per-group false-win rate 0\.0\d; power for a real 0\.5 → 0\.8 fix 0\.9\d/,
      );
      expect(md).toContain("C7 (`tournament final --combined`) is the regression gate");
      expect(md).toContain("R2, R3 and R4: not run in fast mode");
      expect(md).not.toContain("## 4. R3 scan");
      expect(md).toContain("**winner: v1**: fast: v1 wins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fast mode refusals", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mu-fast-cli-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const inRoot = (fn: () => Promise<void>) => withEnv("EVAL_TOURNAMENT_ROOT", root, fn);
  const freeze = (mode: "fast" | "full") => {
    const dir = join(root, "c1_wait");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      controlFile(dir),
      `${JSON.stringify({ kind: "freeze", judgesHash: "h", files: [], mode, nPlan: [], checks: "skipped" })}\n`,
    );
  };

  it("the CLI refuses R2, R3, R4 and the per-group final in fast mode, naming C7", async () => {
    freeze("fast");
    await inRoot(async () => {
      for (const sub of ["r2", "r3", "r4", "final"])
        await expect(tournamentCli([sub, "c1_wait"])).rejects.toThrow(
          /fast mode: no .*C7 \(`tournament final --combined`\)/,
        );
    });
  });

  it("refuses decide without --fast or on a full-mode group, and --fast on a full-mode group", async () => {
    freeze("full");
    await inRoot(async () => {
      await expect(tournamentCli(["decide", "--fast", "c1_wait"])).rejects.toThrow(FastModeError);
      await expect(tournamentCli(["r1", "c1_wait", "--fast"])).rejects.toThrow(
        /frozen in full mode/,
      );
    });
    expect(() => assertMode([], "decide", false)).toThrow(/fast mode only/);
    expect(() => assertMode([], "decide", true)).toThrow(/fast mode only/);
    expect(() => assertMode([], "r2", false)).not.toThrow();
  });
});

describe("fresh R1 rows (the CLI's rep filter)", () => {
  it("keeps this epoch's R1 reps only: no R2 rows, no earlier epoch's", () => {
    const rows = [
      { round: "r1", rep: 6001, id: "keep" },
      { round: "r1", rep: 6002, id: "keep2" },
      { round: "r2", rep: 6101, id: "r2" },
      { round: "r1", rep: 5001, id: "epoch5" },
      { round: "r1", rep: 1, id: "epoch0" },
      { round: "r1", rep: 7001, id: "epoch7" },
    ] as const;
    expect(freshRows(rows, "r1", 6).map((r) => r.id)).toEqual(["keep", "keep2"]);
    expect(freshRows(rows, "r2", 6).map((r) => r.id)).toEqual(["r2"]);
    expect(freshRows(rows, "r1", 0).map((r) => r.id)).toEqual(["epoch0"]);
  });
});

describe("migrate-fast (C2: a full-mode group with R1 done switches to fast)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-fast-migrate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const full = (extra: object[] = []) => {
    const rows = [
      { kind: "freeze", judgesHash: "h0", files: [], mode: "full", nPlan: [], checks: "skipped" },
      { kind: "refreeze", row: "x", why: "rig fix", judgesHash: "h6", epoch: 6 },
      { kind: "round_score", round: "r1", epoch: 6, S: null, scores: [] },
      { kind: "cut", round: "r1", epoch: 6, advanced: [] },
      ...extra,
    ];
    writeFileSync(controlFile(dir), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
    return readControl(dir);
  };
  const why = ["--why", "fast mode for phase C"];

  it("keeps the epoch, records the rule and the judges, and then decide --fast is allowed and R2 refused", () => {
    const rows = full();
    expect(modeOf(rows)).toBe("full");
    expect(migrateFast("c2_close", dir, rows, why, { hash: () => "h6" })).toBe(0);
    const after = readControl(dir);
    expect(after.at(-1)).toMatchObject({
      kind: "migrate_fast",
      from: "full",
      epoch: 6,
      win: DEFAULT_WIN_RULE,
      judgesHash: "h6",
      previousJudgesHash: "h6",
      judgesChanged: [],
    });
    expect(modeOf(after)).toBe("fast");
    expect(winRuleOf(after)).toEqual(DEFAULT_WIN_RULE);
    expect(() => assertFrozen(after, "h6")).not.toThrow();
    expect(() => assertMode(after, "decide", true)).not.toThrow();
    expect(() => assertMode(after, "r2", false)).toThrow(/C7/);
    expect(() => assertMode(after, "migrate-fast", false)).toThrow(/fast mode already/);
  });

  it("re-checks the judges: a moved hash names the changed files and needs --accept-judges <new hash>", () => {
    const rows = full();
    const deps = { hash: () => "h7", diff: () => ["tools/eval/nextstep.ts"] };
    expect(migrateFast("c2_close", dir, rows, why, deps)).toBe(1);
    expect(readControl(dir).some((r) => r.kind === "migrate_fast")).toBe(false);
    expect(migrateFast("c2_close", dir, rows, [...why, "--accept-judges", "h6"], deps)).toBe(1);
    expect(
      migrateFast(
        "c2_close",
        dir,
        rows,
        [...why, "--accept-judges", "h7", "--win-alpha", "0.1", "--correct", "variants"],
        deps,
      ),
    ).toBe(0);
    const after = readControl(dir);
    expect(after.at(-1)).toMatchObject({
      judgesHash: "h7",
      previousJudgesHash: "h6",
      judgesChanged: ["tools/eval/nextstep.ts"],
      win: { alpha: 0.1, correct: "variants" },
    });
    // later commands check the accepted hash
    expect(() => assertFrozen(after, "h7")).not.toThrow();
    expect(() => assertFrozen(after, "h6")).toThrow(/judges changed/);
  });

  it("refuses without a scored R1 in the epoch, after an R2 score or a decision, and without --why", () => {
    const hash = { hash: () => "h6" };
    const noR1 = full().filter((r) => r.kind !== "round_score");
    expect(() => migrateFast("c2_close", dir, noR1, why, hash)).toThrow(/no R1 score in epoch 6/);
    const r2 = full([{ kind: "round_score", round: "r2", epoch: 6, S: 3, scores: [] }]);
    expect(() => migrateFast("c2_close", dir, r2, why, hash)).toThrow(/would follow its result/);
    const decided = full([{ kind: "decision", winner: null, why: "x" }]);
    expect(() => migrateFast("c2_close", dir, decided, why, hash)).toThrow(/would follow/);
    expect(() => migrateFast("c2_close", dir, full(), [], hash)).toThrow(/usage/);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
