// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ColdRow } from "../../tools/eval/cold-guess.ts";
import type { ExposureSpec } from "../../tools/eval/exposure.ts";
import type { NextCase, ProbeRow } from "../../tools/eval/nextstep.ts";
import {
  appendReviewDecision,
  appendReviewStop,
  assertB0,
  assertFrozen,
  assertNoPendingStops,
  type CasePlan,
  type ControlRow,
  JudgesChangedError,
  nPlan,
  pendingStops,
  planCmhPower,
  ReviewPendingError,
  readControl,
  roundJobs,
  type SetupRow,
} from "../../tools/eval/tournament.ts";
import {
  admit,
  behaviourDiff,
  type CorpusFile,
  capRule,
  deriveMarkers,
  type GoldenTrace,
  jsonShape,
  lengthCap,
  lengthViolations,
  newNames,
  normalise,
} from "../../tools/eval/tournament-build.ts";
import {
  changedStrings,
  parseManifest,
  parsePatch,
  pathsOutside,
  stringLiterals,
  wordDiff,
} from "../../tools/eval/tournament-patch.ts";
import {
  BASE,
  cut,
  rank,
  type ScoreInput,
  scoreRound,
  type VariantScore,
} from "../../tools/eval/tournament-score.ts";

import {
  cellRows,
  fakeCase,
  GEMINI,
  HAIKU,
  prompt,
  rng,
  row,
  SONNET,
  spec,
} from "./_tournament-rows.ts";

const setup: ScoreInput["setup"] = {
  models: { weak: [HAIKU, GEMINI], gate: SONNET },
  rho: {},
  rhoPool: {},
};
const input = (o: Partial<ScoreInput> & Pick<ScoreInput, "rows" | "variants">): ScoreInput => ({
  round: "r2",
  group: "c1_wait",
  setup,
  headline: ["h1", "h2", "h3"],
  headlineAny: ["h1", "h2", "h3"],
  nameCues: [],
  prompt,
  S: 6,
  ...o,
});
const variant = (id: string) => ({ id, spec, textDelta: 0 });

// ---- statistics of the round --------------------------------------------------------------------

/**
 * The R2 plan's reps straight from nPlan at the default ρ (no B5 data): own headline cases (10 × 3
 * clusters), cross-group headline cases (10 × 3) and the two guards (6 × 2, 6 × 3). Lazy: fakeCase
 * is defined further down.
 */
function planned(): { own: number; cross: number; g12: number; g18: number; ownNEff: number } {
  const guard = (id: string, arms: NextCase["arms"]) =>
    fakeCase(id, {
      group: "guard",
      role: "guard",
      arms,
      paraphrases: fakeCase("x").paraphrases.slice(0, 6),
    });
  const p = nPlan(
    "c1_wait",
    [
      fakeCase("own"),
      fakeCase("cross", { group: "c2_close" }),
      guard("g12", ["none", "skill"]),
      guard("g18", ["none", "skill", "recipe:orchestrator-loop"]),
    ],
    null,
  );
  const r = (i: number): number => p[i]?.plan.r ?? 0;
  return { own: r(0), cross: r(1), g12: r(2), g18: r(3), ownNEff: p[0]?.plan.nEff ?? 0 };
}

/**
 * One surface's R2 rows at the plan: 3 own headline cases, 9 cross-group headline cases, the two
 * guards; `p` per case kind. One stratum per case and model, as in §4.2's CMH table.
 */
function planRows(
  surface: string,
  p: { own: number; cross: number; guard: number },
  models: string[],
  rand: () => number,
): ProbeRow[] {
  const n = planned();
  const out: ProbeRow[] = [];
  for (const c of ["h1", "h2", "h3"])
    out.push(...cellRows({ surface, caseId: c, models, p: p.own, r: n.own, rand }));
  for (let i = 1; i <= 9; i++)
    out.push(...cellRows({ surface, caseId: `x${i}`, models, p: p.cross, r: n.cross, rand }));
  out.push(...cellRows({ surface, caseId: "g12", models, p: p.guard, m: 12, r: n.g12, rand }));
  out.push(...cellRows({ surface, caseId: "g18", models, p: p.guard, m: 18, r: n.g18, rand }));
  return out;
}

describe("scoreRound: losses, wins and their error rates", () => {
  it("the planned n is nPlan's: own r = 3 (n_eff 64 per model, 90 pooled), cross r = 2, guards 8 and 4", () => {
    expect(planned()).toMatchObject({ own: 3, cross: 2, g12: 8, g18: 4 });
    expect(planned().ownNEff).toBeCloseTo(64.3, 1);
  });

  it("a null variant at the R2 plan is lost at most 0.10 of the time (Monte Carlo)", () => {
    const rand = rng(7);
    const sims = 200;
    let lost = 0;
    const all = [HAIKU, GEMINI, SONNET];
    for (let s = 0; s < sims; s++) {
      const rows = [BASE, "v1"].flatMap((surface) =>
        planRows(surface, { own: 0.7, cross: 0.7, guard: 0.8 }, all, rand),
      );
      const [v] = scoreRound(input({ rows, variants: [variant("v1")] }));
      if (v?.eliminated.some((e) => e.startsWith("loss"))) lost++;
    }
    expect(lost / sims).toBeLessThanOrEqual(0.1);
  });

  it("a broad 0.8 → 0.7 drop at the R2 plan is a CMH loss with power ≥ 0.95 per model (Monte Carlo)", () => {
    const rand = rng(5);
    const sims = 200;
    let caught = 0;
    for (let s = 0; s < sims; s++) {
      const rows = [
        ...planRows(BASE, { own: 0.8, cross: 0.8, guard: 0.8 }, [HAIKU], rand),
        ...planRows("v1", { own: 0.7, cross: 0.7, guard: 0.7 }, [HAIKU], rand),
      ];
      const [v] = scoreRound(input({ rows, variants: [variant("v1")] }));
      if (v?.cmh.find((c) => c.model === HAIKU)?.loss) caught++;
    }
    // planCmhPower at this plan: 0.98; the clustered rows measured 0.995 in review
    expect(caught / sims).toBeGreaterThanOrEqual(0.95);
  });

  it("planCmhPower reports the plan's CMH power: 0.8 → 0.7 near 0.98, 0.8 → 0.75 near 0.5", () => {
    const n = planned();
    const at = (nEff: number) => ({ plan: { nEff } }) as CasePlan;
    const plan = [
      ...Array.from({ length: 3 }, () => at(n.ownNEff)),
      ...Array.from({ length: 9 }, () => at(50)),
      at(40),
      at(45),
    ];
    const [p70, p75] = planCmhPower(plan);
    expect(p70?.drop).toBe("0.8→0.7");
    expect(p70?.power).toBeGreaterThanOrEqual(0.95);
    expect(p75?.power).toBeGreaterThan(0.4);
    expect(p75?.power).toBeLessThan(0.7);
  });

  it("a null group lands a false win at most 0.05 of the time with S = 6 (Monte Carlo)", () => {
    const rand = rng(11);
    const sims = 300;
    let won = 0;
    const ids = ["v1", "v2", "v3", "v4", "v5", "v6"];
    const r = planned().own;
    for (let s = 0; s < sims; s++) {
      const rows: ProbeRow[] = [];
      for (const surface of [BASE, ...ids])
        for (const c of ["h1", "h2", "h3"])
          rows.push(...cellRows({ surface, caseId: c, models: [HAIKU, GEMINI], p: 0.5, r, rand }));
      const scores = scoreRound(input({ rows, variants: ids.map(variant), S: 6 }));
      if (scores.some((v) => v.wins > 0)) won++;
    }
    expect(won / sims).toBeLessThanOrEqual(0.05);
  });

  it("a 0.5 → 0.8 variant wins at the planned power", () => {
    const rand = rng(3);
    const sims = 80;
    let won = 0;
    const r = planned().own;
    for (let s = 0; s < sims; s++) {
      const rows: ProbeRow[] = [];
      for (const [surface, p] of [
        [BASE, 0.5],
        ["v1", 0.8],
      ] as const) {
        rows.push(...cellRows({ surface, caseId: "h1", models: [HAIKU, GEMINI], p, r, rand }));
        for (const c of ["h2", "h3"])
          rows.push(...cellRows({ surface, caseId: c, models: [HAIKU, GEMINI], p: 0.5, r, rand }));
      }
      const [v] = scoreRound(input({ rows, variants: [variant("v1")], S: 6 }));
      if (v?.win.find((w) => w.case === "h1")?.win) won++;
    }
    // planned power 0.92 at pooled n_eff 90, B = 18 (spec §4.2); the slack is Monte Carlo error
    expect(won / sims).toBeGreaterThanOrEqual(0.85);
  });

  it("a broad 0.8 → 0.7 drop is a CMH loss that no single case shows", () => {
    // deterministic counts: every stratum exactly at its rate, clusters of 4 (DEFF 1.6)
    const det = (surface: string, caseId: string, rate: number): ProbeRow[] =>
      Array.from({ length: 120 }, (_, i) =>
        row({
          surface,
          case: caseId,
          model: HAIKU,
          paraphrase: `p${Math.floor(i / 4)}`,
          hit: (i * 7) % 120 < Math.round(rate * 120),
        }),
      );
    const cases = Array.from({ length: 15 }, (_, i) => `c${i}`);
    const rows = cases.flatMap((c) => [...det(BASE, c, 0.8), ...det("v1", c, 0.7)]);
    const [v] = scoreRound(input({ rows, variants: [variant("v1")], headline: [] }));
    expect(v?.loss.some((c) => c.loss)).toBe(false);
    expect(v?.cmh.find((c) => c.model === HAIKU)?.loss).toBe(true);
    expect(v?.eliminated).toEqual(["loss (stratified CMH)"]);
  });
});

describe("scoreRound: rules", () => {
  const winRows = (p: Record<string, Record<string, number>>, extra: Partial<ProbeRow> = {}) =>
    Object.entries(p).flatMap(([surface, rates]) =>
      Array.from({ length: 30 }, (_, c) =>
        Object.entries(rates).flatMap(([model, rate]) =>
          Array.from({ length: 4 }, (_, k) =>
            row({
              surface,
              model,
              paraphrase: `p${c}`,
              hit: (c * 4 + k) % 10 < rate * 10,
              ...extra,
            }),
          ),
        ),
      ).flat(),
    );

  it("wins on exposed clusters; nameCue rows are dropped from wins and kept for losses", () => {
    const rows = winRows({
      [BASE]: { [HAIKU]: 0.3, [GEMINI]: 0.3 },
      v1: { [HAIKU]: 0.9, [GEMINI]: 0.9 },
    });
    const [won] = scoreRound(input({ rows, variants: [variant("v1")], headline: ["h1"] }));
    expect(won?.win[0]?.win).toBe(true);
    const cues = Array.from({ length: 30 }, (_, c) => ({
      case: "h1",
      paraphrase: `p${c}`,
      variant: "v1",
      word: "text",
    }));
    const [cued] = scoreRound(
      input({ rows, variants: [variant("v1")], headline: ["h1"], nameCues: cues }),
    );
    expect(cued?.win[0]).toMatchObject({ unexposed: true, win: false, nameCueRows: 240 });
    // a cued variant that drops is still a loss
    const drop = winRows({ [BASE]: { [HAIKU]: 0.9 }, v1: { [HAIKU]: 0.1 } });
    const [lost] = scoreRound(
      input({ rows: drop, variants: [variant("v1")], headline: ["h1"], nameCues: cues }),
    );
    expect(lost?.eliminated).toContain("loss (per-case Holm)");
  });

  it("unexposed rows never select a win cluster", () => {
    const rows = winRows(
      { [BASE]: { [HAIKU]: 0.3, [GEMINI]: 0.3 }, v1: { [HAIKU]: 0.9, [GEMINI]: 0.9 } },
      { promptSha: "plain" },
    );
    const [v] = scoreRound(input({ rows, variants: [variant("v1")], headline: ["h1"] }));
    expect(v?.win[0]).toMatchObject({ unexposed: true, win: false, exposedClusters: 0 });
  });

  it("a pooled win needs the direction on each weak model", () => {
    const rows = winRows({
      [BASE]: { [HAIKU]: 0.2, [GEMINI]: 0.5 },
      v1: { [HAIKU]: 1, [GEMINI]: 0.4 },
    });
    const [v] = scoreRound(input({ rows, variants: [variant("v1")], headline: ["h1"] }));
    expect(v?.win[0]?.p).toBeLessThan(0.001);
    expect(v?.win[0]?.direction).toEqual({ [HAIKU]: true, [GEMINI]: false });
    expect(v?.win[0]?.win).toBe(false);
  });

  it("the win threshold is 0.05/S with Holm across the headline cases", () => {
    const rows = winRows({
      [BASE]: { [HAIKU]: 0.3, [GEMINI]: 0.3 },
      v1: { [HAIKU]: 0.9, [GEMINI]: 0.9 },
    });
    const [v] = scoreRound(
      input({ rows, variants: [variant("v1")], headline: ["h1", "h2"], S: 6 }),
    );
    expect(v?.win.find((w) => w.case === "h1")?.threshold).toBeCloseTo(0.05 / 6 / 2);
    // h2 has no rows: unexposed, and it sees the step-2 threshold
    expect(v?.win.find((w) => w.case === "h2")).toMatchObject({ unexposed: true, win: false });
  });

  it("R1 rows in R2 scoring are an error; so are rows below the round's rep floor", () => {
    const rows = [row({ round: "r1", rep: 1 })];
    expect(() => scoreRound(input({ rows, variants: [] }))).toThrow(/r1 row/);
    expect(() =>
      scoreRound(input({ rows: [row({ rep: 1 })], variants: [], repFloor: 101 })),
    ).toThrow(/fresh/);
  });

  it("an invalid lead-in on a headline case eliminates, and scores as a miss", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ surface: BASE, leadInExits: [0] })),
      row({ surface: "v1", leadInExits: [1], hit: true }),
    ];
    const [v] = scoreRound(input({ rows, variants: [variant("v1")] }));
    expect(v?.eliminated).toContain("invalid lead-in");
    expect(v?.invalidRows).toBe(1);
  });

  it("an attributable destructive entry eliminates; a new unattributable one stops for review", () => {
    const d = { entry: "git-reset-hard: x", source: "DESTRUCTIVE", callIdx: 0 };
    const rows = [row({ surface: BASE }), row({ surface: "v1", destructive: [d] })];
    const [exposed] = scoreRound(input({ rows, variants: [variant("v1")] }));
    expect(exposed?.eliminated).toContain("attributable destructive");
    const plain = [
      row({ surface: BASE }),
      row({ surface: "v1", destructive: [d], promptSha: "plain" }),
    ];
    const [stop] = scoreRound(input({ rows: plain, variants: [variant("v1")] }));
    expect(stop?.eliminated).toEqual([]);
    expect(stop?.reviews).toHaveLength(1);
    // base had the same class: noted only
    const same = [
      row({ surface: BASE, destructive: [d] }),
      row({ surface: "v1", destructive: [d], promptSha: "plain" }),
    ];
    expect(scoreRound(input({ rows: same, variants: [variant("v1")] }))[0]?.reviews).toEqual([]);
  });

  it("the cold-guess guard is one more loss stratum per model", () => {
    const cold = (surface: string, hit: boolean): ColdRow[] =>
      Array.from(
        { length: 60 },
        (_, i) => ({ surface, model: HAIKU, intent: `i${i % 20}`, hit }) as ColdRow,
      );
    const [v] = scoreRound(
      input({
        rows: [],
        cold: [...cold(BASE, true), ...cold("v1", false)],
        variants: [variant("v1")],
      }),
    );
    expect(v?.loss.find((c) => c.case === "cold-guess")?.loss).toBe(true);
  });
});

describe("rank and cut", () => {
  const s = (id: string, over: Partial<VariantScore> = {}): VariantScore => ({
    id,
    loss: [],
    cmh: [],
    win: [],
    eliminated: [],
    attributable: [],
    reviews: [],
    invalidRows: 0,
    infra: {
      retries: 0,
      recovered: 0,
      failedRows: 0,
      droppedPairings: 0,
      droppedClusters: 0,
      clusters: 0,
      dropped: [],
    },
    r1Score: 0,
    wins: 0,
    winZ: 0,
    hitsExposed: 0,
    meanTokens: 0,
    textDelta: 0,
    ...over,
  });

  it("is a total order ending in the variant id", () => {
    const scores = [
      s("d", { r1Score: 1, hitsExposed: 5, meanTokens: 10, textDelta: 3 }),
      s("c", { r1Score: 1, hitsExposed: 5, meanTokens: 10, textDelta: 3 }),
      s("b", { r1Score: 1, hitsExposed: 5, meanTokens: 9 }),
      s("a", { r1Score: 2 }),
      s("e", { r1Score: 1, hitsExposed: 6 }),
    ];
    expect(rank("r1", scores).map((x) => x.id)).toEqual(["a", "e", "b", "c", "d"]);
    expect(rank("r1", [...scores].reverse()).map((x) => x.id)).toEqual(["a", "e", "b", "c", "d"]);
    expect(
      rank("r2", [
        s("x", { wins: 1, winZ: 2 }),
        s("y", { wins: 2 }),
        s("z", { wins: 1, winZ: 3 }),
      ]).map((x) => x.id),
    ).toEqual(["y", "z", "x"]);
  });

  it("R1 advances exactly min(⌈N/2⌉, E1); R2 exactly min(2, W2)", () => {
    const r1 = cut("r1", [
      s("a", { r1Score: 3 }),
      s("b", { r1Score: 2 }),
      s("c", { r1Score: 0 }),
      s("d", { r1Score: -1 }),
      s("e", { r1Score: 5, eliminated: ["loss (per-case Holm)"] }),
    ]);
    expect(r1).toMatchObject({ advance: 2, advanced: ["a", "b"] });
    const many = cut(
      "r1",
      ["a", "b", "c", "d", "e"].map((id, i) => s(id, { r1Score: 5 - i })),
    );
    expect(many).toMatchObject({ advance: 3, advanced: ["a", "b", "c"] });
    const r2 = cut("r2", [
      s("a", { wins: 1 }),
      s("b", { wins: 2 }),
      s("c", { wins: 1, winZ: 1 }),
      s("d"),
    ]);
    expect(r2).toMatchObject({ advance: 2, advanced: ["b", "c"] });
    expect(cut("r2", [s("a"), s("b")]).advance).toBe(0);
  });
});

// ---- plan and jobs ------------------------------------------------------------------------------

describe("n plan and job lists", () => {
  const cases = [
    fakeCase("own1"),
    fakeCase("other", { group: "c2_close" }),
    fakeCase("guard", {
      group: "guard",
      role: "guard",
      arms: ["none", "skill"],
      paraphrases: fakeCase("x").paraphrases.slice(0, 6),
    }),
  ];
  const plan = nPlan("c1_wait", cases, null);

  it("plans own headline, cross-group and guard cases against their targets", () => {
    expect(plan.map((p) => p.kind)).toEqual(["own", "cross", "guard"]);
    expect(plan[0]?.plan.nEff).toBeGreaterThanOrEqual(60);
    expect(plan[0]?.plan.nEffPooled).toBeGreaterThanOrEqual(90);
    expect(plan[1]?.plan.nEff).toBeGreaterThanOrEqual(40);
    expect(plan[2]?.plan).toMatchObject({ m: 12, r: 8 });
  });

  it("R1 runs own headline cases once per cluster; R2 uses fresh rep indices", () => {
    const surfaces = {
      surfaces: [BASE, "v1"].map((label) => ({
        label,
        surface: { name: label, root: "", cli: "", extension: "", skillDir: "" },
      })),
      models: [HAIKU, GEMINI, SONNET],
    };
    const r1 = roundJobs("r1", "c1_wait", cases, plan, surfaces, { seed: "s", epoch: 0 });
    expect(new Set(r1.map((j) => j.caseId))).toEqual(new Set(["own1"]));
    expect(r1).toHaveLength(30 * 2 * 3);
    const r2 = roundJobs("r2", "c1_wait", cases, plan, surfaces, { seed: "s", epoch: 0 });
    const r1Reps = new Set(r1.map((j) => j.rep));
    expect(r2.some((j) => r1Reps.has(j.rep))).toBe(false);
    expect(new Set(r2.map((j) => j.caseId))).toEqual(new Set(["own1", "other", "guard"]));
    // seeded: the same queue twice
    expect(roundJobs("r1", "c1_wait", cases, plan, surfaces, { seed: "s", epoch: 0 })).toEqual(r1);
  });
});

// ---- control file -------------------------------------------------------------------------------

describe("control rows", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to run on changed judges", () => {
    const rows: ControlRow[] = [
      { kind: "freeze", judgesHash: "aaa", files: [], nPlan: [], checks: "green" },
    ];
    expect(() => assertFrozen(rows, "aaa")).not.toThrow();
    expect(() => assertFrozen(rows, "bbb")).toThrow(JudgesChangedError);
    expect(() => assertFrozen([], "aaa")).toThrow(/no freeze/);
    const refrozen: ControlRow[] = [
      ...rows,
      { kind: "refreeze", row: "r", why: "w", judgesHash: "bbb", epoch: 1 },
    ];
    expect(() => assertFrozen(refrozen, "bbb")).not.toThrow();
    expect(() => assertFrozen(refrozen, "aaa")).toThrow(JudgesChangedError);
  });

  it("refuses a group without the B0 proof for every model", () => {
    const base = {
      models: { weak: [HAIKU, GEMINI], gate: SONNET },
      b0: {
        models: [],
        providerExt: null,
        rows: [
          { model: HAIKU, ok: true },
          { model: SONNET, ok: true },
        ],
      },
    } as unknown as SetupRow;
    expect(() => assertB0(base)).toThrow(/gemini/);
    base.b0.rows.push({ model: GEMINI, ok: true });
    expect(() => assertB0(base)).not.toThrow();
  });

  it("a review stop holds every command until its decision", () => {
    dir = mkdtempSync(join(tmpdir(), "mu-tourn-"));
    const pings: string[] = [];
    const stop = {
      variant: "v1",
      cell: "h1/haiku",
      entries: ["sql-write: x"],
      transcript: "t",
      source: "probe" as const,
    };
    const id = appendReviewStop(dir, stop, (m) => pings.push(m));
    expect(appendReviewStop(dir, stop, (m) => pings.push(m))).toBe(id);
    expect(pings).toHaveLength(1);
    expect(() => assertNoPendingStops(readControl(dir))).toThrow(ReviewPendingError);
    expect(() => appendReviewDecision(dir, { stop: id, decision: "continue", why: " " })).toThrow();
    appendReviewDecision(dir, {
      stop: id,
      decision: "drop",
      why: "line 12: rm -rf of its own temp dir",
    });
    expect(pendingStops(readControl(dir))).toEqual([]);
    // a re-score that meets the same stop honours its decision
    const d = { entry: "sql-write: x", source: "s", callIdx: 0 };
    const [v] = scoreRound(
      input({
        rows: [
          row({ surface: BASE, model: "h" }),
          row({ surface: "v1", model: "h", destructive: [d], promptSha: "plain" }),
        ],
        variants: [variant("v1")],
        setup: { ...setup, models: { weak: [], gate: "h" } },
        decisions: [{ stop: "rs-other", decision: "continue" }],
      }),
    );
    expect(v?.reviews).toHaveLength(1);
  });
});

// ---- variants -----------------------------------------------------------------------------------

const PATCH = `diff --git a/src/cli/wait.ts b/src/cli/wait.ts
--- a/src/cli/wait.ts
+++ b/src/cli/wait.ts
@@ -1,4 +1,5 @@
 const x = 1;
-  console.log(\`next: mu wait \${ref} --timeout 60\`);
+  console.log(\`next: mu wait \${ref} --timeout 110 (the shell kills a call at 120 s)\`);
+  cmd.option("--text", "print the result text");
   const y = "unchanged";
diff --git a/skills/mu/SKILL.md b/skills/mu/SKILL.md
--- a/skills/mu/SKILL.md
+++ b/skills/mu/SKILL.md
@@ -1,3 +1,3 @@
 # mu
-Wait with mu wait and then scan the whole snapshot.
+Wait with mu wait and read the result line it prints first.
 end
`;

describe("variant patches", () => {
  it("reads a manifest and refuses a bad one", () => {
    const ok = { id: "c1-a", group: "c1_wait", kind: ["output"], summary: "one line" };
    expect(parseManifest(JSON.stringify(ok), "c1_wait")).toEqual(ok);
    expect(() => parseManifest(JSON.stringify({ ...ok, markers: ["x"] }), "c1_wait")).toThrow(
      /markers/,
    );
    expect(() => parseManifest(JSON.stringify(ok), "c2_close")).toThrow(/group/);
  });

  it("splits literals at a template placeholder and skips comments", () => {
    const ph = "$" + "{d}";
    expect(stringLiterals(`f("a b", \`c ${ph} e\`) // "no"`)).toEqual([
      { text: "a b", parts: ["a b"] },
      { text: `c ${ph} e`, parts: ["c ", " e"] },
    ]);
    expect(stringLiterals('  // "comment"')).toEqual([]);
    expect(wordDiff("a b c", "a x y c")).toEqual({ added: ["x y"], removed: ["b"] });
  });

  it("derives markers; a context string that occurs twice in base is rejected", () => {
    const files = parsePatch(PATCH);
    expect(pathsOutside(files)).toEqual([]);
    const diff = changedStrings(files);
    const base: CorpusFile[] = [
      {
        file: "dist/cli.js",
        text: "next: mu wait --timeout 60 Wait with mu wait and then scan the whole snapshot.",
      },
      { file: "dist/extension/mu-pi.js", text: "then scan the whole snapshot." },
    ];
    const variant: CorpusFile[] = [
      {
        file: "dist/cli.js",
        text: "--timeout 110 (the shell kills a call at 120 s) read the result line it prints first.",
      },
    ];
    const d = deriveMarkers(diff, variant, base);
    expect(d.markers).toContain(" --timeout 110 (the shell kills a call at 120 s)".trim());
    expect(d.markers).toContain("result line it prints first.");
    // the unchanged segment `next: mu wait ` is no context marker; the dropped one is
    expect(d.contextMarkers).toEqual(["--timeout 60"]);
    expect(d.rejected).toEqual([{ text: "whole snapshot.", why: "2 places in base" }]);
    // a changed part base already ships anywhere is no marker
    const shipped = deriveMarkers(diff, variant, [
      ...base,
      { file: "skills/mu/SKILL.md", text: "result line it prints first." },
    ]);
    expect(shipped.markers).not.toContain("result line it prints first.");
    // once in base: accepted
    const once = deriveMarkers(diff, variant, [base[0] as CorpusFile]);
    expect(once.contextMarkers).toContain("whole snapshot.");
  });

  it("caps each changed string's length", () => {
    expect(lengthCap(null)).toBe(120);
    expect(lengthCap(20)).toBe(60);
    expect(lengthCap(400)).toBe(500);
    expect(lengthCap(1000)).toBe(1120);
    const long = { file: "src/a.ts", text: "x".repeat(61), parts: [], base: "y".repeat(20) };
    expect(lengthViolations([long])).toHaveLength(1);
    expect(lengthViolations([{ ...long, text: "x".repeat(60) }])).toEqual([]);
  });

  it("skill and recipe text gets max(2x base, base+200); src strings keep their cap; the admission says which", () => {
    expect(capRule("skills/mu/recipes/orchestrator-loop.md")).toBe("skill");
    expect(capRule("skills/mu/SKILL.md")).toBe("skill");
    expect(capRule("docs/guide/upgrade.md")).toBe("skill");
    expect(capRule("src/cli/wait.ts")).toBe("src");
    expect(capRule("extension/mu-pi.ts")).toBe("src");
    expect(lengthCap(null, "skill")).toBe(200);
    expect(lengthCap(100, "skill")).toBe(300);
    expect(lengthCap(400, "skill")).toBe(800);
    expect(lengthCap(1000, "skill")).toBe(2000);
    // C3's refused recipe line: 196 chars on a 113-char base, over the src cap 153, within 313
    const line = {
      file: "skills/mu/recipes/orchestrator-loop.md",
      text: "x".repeat(196),
      parts: [],
      base: "y".repeat(113),
    };
    expect(lengthViolations([line])).toEqual([]);
    expect(lengthViolations([{ ...line, file: "src/cli/notes.ts" }])).toEqual([
      expect.stringContaining("over its cap 153 (src cap"),
    ]);
    expect(lengthViolations([{ ...line, text: "x".repeat(314) }])).toEqual([
      expect.stringContaining("over its cap 313 (skill cap"),
    ]);
    const a = admit({
      files: [],
      built: { ok: true },
      helpExit: 0,
      words: { skill: 1, recipes: 1 },
      changed: [line, { ...line, file: "src/a.ts", text: "x", base: "y" }],
      spec: { markers: ["m"], contextMarkers: [], newNames: [], changedCalls: [] },
    });
    expect(a).toMatchObject({ ok: true, caps: { src: 1, skill: 1 } });
  });

  it("refuses a patch outside src, extension and skills", () => {
    const files = parsePatch(PATCH.replace(/src\/cli\/wait\.ts/g, "tools/eval/x.ts"));
    expect(pathsOutside(files)).toContain("tools/eval/x.ts");
  });

  const traces = (exit: number, out = "ok"): GoldenTrace[] => [
    {
      id: "nextstep:a/a",
      ok: true,
      calls: [{ argv: "agent close worker-1 -w auth --if 3", exit, out }],
    },
  ];
  const key = (argv: string): string =>
    argv.startsWith("agent close") ? "agent close|--if" : argv;
  const none = { markers: [], contextMarkers: [], newNames: [], changedCalls: [] };
  const admitWith = (s: ExposureSpec) =>
    admit({
      files: [],
      built: { ok: true },
      helpExit: 0,
      words: { skill: 1, recipes: 1 },
      changed: [],
      spec: s,
    });

  it("admits a behaviour-only variant (a short new flag; a changed exit code) and refuses an inert one", () => {
    const files = parsePatch(PATCH);
    expect(newNames(files, new Set(["timeout"]))).toEqual(["--text"]);
    expect(newNames(files, new Set(["text"]))).toEqual([]);
    // the formatter's two-line form: `.option(` on one added line, the flags on the next
    const split = parsePatch(
      'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,6 @@\n const a = 1;\n+  .option(\n+    "--if-clean",\n+    "apply in one call when clean",\n+  )\n const b = 2;\n',
    );
    expect(newNames(split, new Set(["if"]))).toEqual(["--if-clean"]);
    expect(admitWith({ ...none, newNames: ["--text"] }).ok).toBe(true);
    const calls = behaviourDiff(traces(0), traces(3), key);
    expect(calls).toEqual(["agent close|--if"]);
    expect(admitWith({ ...none, changedCalls: calls }).ok).toBe(true);
    expect(behaviourDiff(traces(0), traces(0), key)).toEqual([]);
    expect(admitWith(none)).toMatchObject({
      ok: false,
      failures: [expect.stringMatching(/inert/)],
    });
  });

  it("does not read run-to-run noise as behaviour", () => {
    const a = traces(0, "phrase alpha beta");
    const b = traces(0, "phrase gamma delta");
    expect(behaviourDiff(a, b, key)).toEqual(["agent close|--if"]);
    expect(behaviourDiff(a, b, key, traces(0, "phrase other words"))).toEqual([]);
    // nonces and counts are normalised
    expect(
      behaviourDiff(traces(0, "id 3f9a2c1d at 12"), traces(0, "id 77aa00ee at 99"), key),
    ).toEqual([]);
    // a JSON shape change is behaviour even when the text is noise
    expect(
      behaviourDiff(traces(0, '{"a":1}'), traces(0, '{"a":1,"b":2}'), key, traces(0, '{"a":7}')),
    ).toEqual(["agent close|--if"]);
  });

  it("normalises ids glued to a name, check ids and JSON keys that are data", () => {
    expect(normalise("task notes delegate_rev_3b9f1ea2 -w auth")).toBe(
      "task notes delegate_rev_<hex> -w auth",
    );
    expect(normalise("--check 1MNYRCNEVWKNJSNCNFNXRAP")).toBe("--check <id>");
    expect(normalise("delegate:scratch/pi:01a1bd95-394c-7735-a0d7-e50e085700a9:9fce1a-1")).toBe(
      normalise("delegate:scratch/pi:01a1be5a-0c36-7233-8e0e-95744efe4880:17f8c0-2"),
    );
    expect(jsonShape('{"cursor":{"delegate:auth/rv-95e575d7":{"runs":1}}}')).toBe(
      jsonShape('{"cursor":{"delegate:auth/rv-09bad6f3":{"runs":2}}}'),
    );
    expect(jsonShape('{"a":1}')).not.toBe(jsonShape('{"b":1}'));
  });

  it("masks a call family the two base runs disagree on, in count or output", () => {
    const run = (calls: [string, string][]): GoldenTrace[] => [
      { id: "r4:p", ok: true, calls: calls.map(([argv, out]) => ({ argv, exit: 0, out })) },
    ];
    const k = (argv: string): string => argv;
    const b1 = run([
      ["task notes c5", ""],
      ["task notes c5", "verdict x"],
      ["wait", "w"],
    ]);
    const b2 = run([
      ["task notes c5", "verdict x"],
      ["wait", "w"],
    ]);
    const v = run([
      ["task notes c5", ""],
      ["task notes c5", ""],
      ["task notes c5", "verdict x"],
      ["wait", "w"],
    ]);
    expect(behaviourDiff(b1, v, k, b2)).toEqual([]);
    // without the second base run the extra poll reads as behaviour
    expect(behaviourDiff(b1, v, k)).toEqual(["task notes c5"]);
  });

  it("pairs calls by occurrence: workers interleaving in another order is no behaviour", () => {
    const run = (argvs: string[], out = "ok", id = "r4:x"): GoldenTrace[] => [
      { id, ok: true, calls: argvs.map((argv) => ({ argv, exit: 0, out })) },
    ];
    const k = (argv: string): string => argv.split(" -")[0] ?? argv;
    const order1 = ["task claim a", "task claim b", "task close a", "wait x"];
    const order2 = ["task claim b", "task claim a", "task close a", "wait x"];
    expect(behaviourDiff(run(order1), run(order2), k, run(order2))).toEqual([]);
    expect(behaviourDiff(run(order1), run(order2), k)).toEqual([]);
    // a call the variant drops, that both base runs make, is behaviour
    expect(behaviourDiff(run(order1), run(order1.slice(0, 3)), k, run(order2))).toEqual(["wait x"]);
    // one the base runs disagree on (made once of two) is chance
    expect(behaviourDiff(run(order1), run(order1.slice(0, 3)), k, run(order1.slice(0, 3)))).toEqual(
      [],
    );
  });
});
