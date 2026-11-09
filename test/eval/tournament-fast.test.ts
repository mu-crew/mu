// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Fast mode (spec §4.7, user decision 2026-11-09): the R1 plan, the fast win rule and decision,
// and the CLI refusing R2/R3/R4 per group.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NextCase, ProbeRow } from "../../tools/eval/nextstep.ts";
import {
  assertMode,
  controlFile,
  FAST_TARGET,
  FastModeError,
  nPlan,
  roundJobs,
} from "../../tools/eval/tournament.ts";
import { tournamentCli } from "../../tools/eval/tournament-cli.ts";
import { fastFacts, renderReport } from "../../tools/eval/tournament-report.ts";
import {
  BASE,
  decideFast,
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
const fastInput = (rows: ProbeRow[], ids: string[], headline = ["h1"]): ScoreInput => ({
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

  it("the threshold is z ≥ 1.65: just below is a tie, at it a win", () => {
    const base = det(BASE, at(15, 15));
    const z = (h: number, g: number) =>
      scoreRound(fastInput([...base, ...det("v1", at(h, g))], ["v1"]))[0]?.win[0];
    const below = z(20, 20);
    const above = z(21, 21);
    expect(below?.z).toBeLessThan(1.65);
    expect(below?.win).toBe(false);
    expect(above?.z).toBeGreaterThanOrEqual(1.65);
    expect(above?.win).toBe(true);
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

describe("fast report facts", () => {
  it("states the accepted 0.10 per group and 0.47 over six groups, and this group's test-count bound", () => {
    const plan = nPlan("c1_wait", [fakeCase("a"), fakeCase("b")], null, "fast");
    const f = fastFacts(plan, 6);
    expect(f.falseWin).toBe(0.1);
    expect(f.falseWinAny).toBeCloseTo(0.469, 3);
    expect(f.tests).toBe(12);
    expect(f.falseWinBound).toBeCloseTo(1 - 0.95 ** 12, 10);
    expect(f.winPower).toBeGreaterThan(0.7);
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
      expect(md).toMatch(/per-group false-win rate is about 0\.1\b/);
      expect(md).toContain("1 − 0.9^6 = 0.47");
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
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
