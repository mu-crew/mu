import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  type ControlRow,
  JudgesChangedError,
  nPlan,
  pendingStops,
  ReviewPendingError,
  readControl,
  roundJobs,
  type SetupRow,
} from "../../tools/eval/tournament.ts";
import {
  admit,
  behaviourDiff,
  type CorpusFile,
  deriveMarkers,
  type GoldenTrace,
  lengthCap,
  lengthViolations,
  newNames,
} from "../../tools/eval/tournament-build.ts";
import {
  auditSession,
  briefRefusals,
  type DenyContext,
  defaultDenyContext,
  denyHits,
  designerArgs,
  designerEnv,
  homePaths,
  nodeInstallDir,
  packTokens,
  scrubPack,
} from "../../tools/eval/tournament-design.ts";
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

// ---- synthetic rows -----------------------------------------------------------------------------

const HAIKU = "claude-haiku-5-5";
const GEMINI = "gemini-3.8-flash";
const SONNET = "claude-sonnet-5-5";
const MARK = "the worker's final report line is shown below";
const spec: ExposureSpec = { markers: [MARK], contextMarkers: [], newNames: [], changedCalls: [] };
const PROMPTS: Record<string, string> = { exposed: `x ${MARK} y`, plain: "x y" };
const prompt = (sha: string): string => PROMPTS[sha] ?? "";

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function row(over: Partial<ProbeRow>): ProbeRow {
  return {
    kind: "probe",
    group: "c1_wait",
    round: "r2",
    case: "h1",
    role: "headline",
    paraphrase: "p1",
    leadIn: "a",
    arm: "none",
    surface: BASE,
    surfaceId: "s",
    build: "b",
    model: HAIKU,
    rep: 101,
    promptSha: "exposed",
    systemSha: "x",
    transcriptPath: "",
    leadInCalls: [],
    leadInExits: [0],
    reply: "",
    commands: [],
    tooMany: false,
    perCommand: [],
    muCalls: [],
    hit: false,
    partial: false,
    invalid: false,
    why: [],
    stray: [],
    destructive: [],
    tokens: 100,
    ms: 1,
    ...over,
  };
}

/**
 * Rows of one (surface, case) over `models`: m = arms × paraphrases clusters of r rows per model,
 * hit rate p, intra-cluster correlation ρ through a shared cluster draw (each row takes it with
 * probability √ρ, so two rows of a cluster correlate at ρ). The weak models share the cluster
 * draw (one prompt), sonnet has its own.
 */
function cellRows(o: {
  surface: string;
  caseId: string;
  models: string[];
  p: number | Record<string, number>;
  m?: number;
  r: number;
  rho?: number;
  rand: () => number;
  round?: "r1" | "r2";
  promptSha?: string;
}): ProbeRow[] {
  const out: ProbeRow[] = [];
  const mix = Math.sqrt(o.rho ?? 0.2);
  const m = o.m ?? 30;
  for (let c = 0; c < m; c++) {
    const shared = o.rand();
    const own = o.rand();
    for (const model of o.models) {
      const p = typeof o.p === "number" ? o.p : (o.p[model] ?? 0);
      const u = model === SONNET ? own : shared;
      for (let k = 0; k < o.r; k++) {
        const hit = o.rand() < mix ? u < p : o.rand() < p;
        out.push(
          row({
            surface: o.surface,
            case: o.caseId,
            model,
            arm: `a${c % 3}` as ProbeRow["arm"],
            paraphrase: `p${Math.floor(c / 3)}`,
            rep: (o.round === "r1" ? 1 : 101) + k,
            round: o.round ?? "r2",
            hit,
            promptSha: o.promptSha ?? "exposed",
          }),
        );
      }
    }
  }
  return out;
}

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

describe("scoreRound: losses, wins and their error rates", () => {
  it("a null variant at the R2 plan is lost at most 0.10 of the time (Monte Carlo)", () => {
    const rand = rng(7);
    const sims = 200;
    let lost = 0;
    const all = [HAIKU, GEMINI, SONNET];
    for (let s = 0; s < sims; s++) {
      const rows: ProbeRow[] = [];
      for (const surface of [BASE, "v1"]) {
        for (const c of ["h1", "h2", "h3"])
          rows.push(...cellRows({ surface, caseId: c, models: all, p: 0.7, r: 4, rand }));
        for (const c of ["x1", "x2", "x3", "x4"])
          rows.push(...cellRows({ surface, caseId: c, models: all, p: 0.7, r: 2, rand }));
        rows.push(...cellRows({ surface, caseId: "g1", models: all, p: 0.8, m: 12, r: 8, rand }));
      }
      const [v] = scoreRound(input({ rows, variants: [variant("v1")] }));
      if (v?.eliminated.some((e) => e.startsWith("loss"))) lost++;
    }
    expect(lost / sims).toBeLessThanOrEqual(0.1);
  });

  it("a null group lands a false win at most 0.05 of the time with S = 6 (Monte Carlo)", () => {
    const rand = rng(11);
    const sims = 300;
    let won = 0;
    const ids = ["v1", "v2", "v3", "v4", "v5", "v6"];
    for (let s = 0; s < sims; s++) {
      const rows: ProbeRow[] = [];
      for (const surface of [BASE, ...ids])
        for (const c of ["h1", "h2", "h3"])
          rows.push(
            ...cellRows({ surface, caseId: c, models: [HAIKU, GEMINI], p: 0.5, r: 4, rand }),
          );
      const scores = scoreRound(input({ rows, variants: ids.map(variant), S: 6 }));
      if (scores.some((v) => v.wins > 0)) won++;
    }
    expect(won / sims).toBeLessThanOrEqual(0.05);
  });

  it("a 0.5 → 0.8 variant wins at the planned power", () => {
    const rand = rng(3);
    const sims = 80;
    let won = 0;
    for (let s = 0; s < sims; s++) {
      const rows: ProbeRow[] = [];
      for (const [surface, p] of [
        [BASE, 0.5],
        ["v1", 0.8],
      ] as const) {
        rows.push(...cellRows({ surface, caseId: "h1", models: [HAIKU, GEMINI], p, r: 4, rand }));
        for (const c of ["h2", "h3"])
          rows.push(
            ...cellRows({ surface, caseId: c, models: [HAIKU, GEMINI], p: 0.5, r: 4, rand }),
          );
      }
      const [v] = scoreRound(input({ rows, variants: [variant("v1")], S: 6 }));
      if (v?.win.find((w) => w.case === "h1")?.win) won++;
    }
    // planned power 0.92 at B = 18 (spec §4.2); the slack is Monte Carlo error
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

const fakeCase = (id: string, over: Partial<NextCase> = {}): NextCase =>
  ({
    id,
    group: "c1_wait",
    role: "headline",
    arms: ["none", "skill", "recipe:orchestrator-loop"],
    shell: "bash",
    expectedRowMs: 30_000,
    paraphrases: Array.from({ length: 10 }, (_, i) => ({
      id: `p${i + 1}`,
      leadIn: "a",
      goal: `Goal number ${i + 1} about worker results.`,
    })),
    leadInVerbs: ["wait"],
    seed: async () => ({}),
    leadIn: (_sb, st) => [{ cmd: `mu wait agent:auth/worker-1@${st.runs} --json | jq -c .data` }],
    judge: async () => ({ hit: false, why: [] }),
    golden: () => ["true"],
    bad: () => ["true"],
    extras: () => [],
    ...over,
  }) as NextCase;

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
});

// ---- isolation ----------------------------------------------------------------------------------

describe("designer isolation", () => {
  const ctx: DenyContext = {
    home: "/home/u",
    repo: "/home/u/hacking/crew/mu",
    worktrees: "/home/u/.local/state/mu-next/worktrees",
    surfaces: "/home/u/.cache/mu/eval/surfaces",
    packs: "/home/u/.cache/mu/eval/packs",
    transcripts: "/home/u/.local/state/mu-next/eval-transcripts",
    museum: ["/home/u/museum", "/home/u/hacking/crew/museum"],
    ownPack: "/home/u/.cache/mu/eval/designers/c1_wait/opus/pack",
    ownDdir: "/home/u/.cache/mu/eval/designers/c1_wait/opus",
    allow: ["/home/u/.nvm/versions/node/v22.1.0"],
    caseIds: ["wait_result_read", "dead_once"],
  };
  const rules = (t: string): string[] => denyHits(t, ctx).map((h) => h.rule);

  it("flags every denied term and path", () => {
    expect(rules("cat tools/eval/nextstep-cases.ts")).toEqual(
      expect.arrayContaining(["nextstep", "tools/eval"]),
    );
    expect(rules("grep -r wait_result_read")).toContain("case id");
    expect(rules("x test/eval/y")).toContain("test/eval");
    expect(rules("ls docs/eval")).toContain("docs/eval");
    expect(rules("read cold-intents")).toContain("cold-intents");
    expect(rules("hill-r2-tournament.md")).toContain("hill-r2-tournament");
    expect(rules("cat /home/u/hacking/crew/mu/src/a.ts")).toContain("main checkout");
    expect(rules("ls ~/.local/state/mu-next/worktrees/crew-hill2/w-b3b")).toContain(
      "crew worktrees",
    );
    expect(rules("ls /home/u/.cache/mu/eval/surfaces/hill2-base")).toContain("built surfaces");
    expect(rules("ls $HOME/.cache/mu/eval/packs/c2_close")).toContain("another pack");
    expect(rules(`cat ${"$"}{HOME}/.local/state/mu-next/eval-transcripts/x`)).toContain(
      "eval transcripts",
    );
    expect(rules("ls ~/.pi/agent/sessions")).toContain("pi sessions");
    expect(rules("ls /home/u/.claude/projects/x")).toContain("claude projects");
    expect(rules("ls ~/.codex/sessions")).toContain("codex sessions");
    expect(rules("ls /home/u/museum/db")).toContain("museum");
    expect(rules("cat /x/skills/museum/SKILL.md")).toContain("museum skill");
    expect(rules('{"command":"museum search wait"}')).toContain("museum command");
    expect(rules('{"command":"cd x && /opt/bin/museum find y"}')).toContain("museum command");
    // a file that names the museum hook is not a call (mu's own init tests do)
    expect(rules('{"content":"command: \\"museum hook claude\\""}')).toEqual([]);
    expect(rules('{"command":"grep museum test/mu-init.test.ts"}')).toEqual([]);
    expect(rules("mu task notes hill2 -w crew-hill2")).toContain("task notes");
    expect(rules("mu task notes b3b_tournament_driver")).toContain("task notes");
    expect(rules("mu task notes delegate_friction-orch_b97e7056 -w scratch")).toContain(
      "task notes",
    );
  });

  it("the catch-all denies any other path under the real HOME, but lets node's install dir through", () => {
    expect(rules("cat /home/u/.ssh/config")).toEqual(["under the real HOME"]);
    expect(rules("cat ~/notes.txt")).toEqual(["under the real HOME"]);
    expect(rules("ls $HOME")).toEqual(["under the real HOME"]);
    expect(
      rules("at /home/u/.nvm/versions/node/v22.1.0/lib/node_modules/npm/lib/cli.js:12"),
    ).toEqual([]);
    expect(rules("cd /home/u/.cache/mu/eval/designers/c1_wait/opus/pack && npm run build")).toEqual(
      [],
    );
    expect(rules("mu task notes t1 -w auth; ls error-nextsteps.test.ts")).toEqual([]);
    expect(homePaths("a ~/x b $HOME/y c /home/u/z.", "/home/u").map((p) => p.path)).toEqual([
      "/home/u/x",
      "/home/u/y",
      "/home/u/z",
    ]);
  });

  it("the default context lets node's own install dir through the catch-all", () => {
    const node = nodeInstallDir();
    const c = defaultDenyContext({
      repo: "/r",
      ownPack: "/p",
      ownDdir: "/d",
      caseIds: [],
      home: dirname(node),
    });
    expect(denyHits(`    at Module._compile (${node}/lib/node_modules/x.js:1:1)`, c)).toEqual([]);
    expect(denyHits(`cat ${dirname(node)}/elsewhere`, c).map((h) => h.rule)).toEqual([
      "under the real HOME",
    ]);
  });

  it("audits what the designer did strictly, and excuses what the pack itself shows it", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-audit-"));
    const pack = join(tmp, "pack");
    mkdirSync(join(pack, "docs"), { recursive: true });
    writeFileSync(join(pack, "docs", "state.md"), "State lives in ~/.local/state/mu-next/mu.db.\n");
    const excused = packTokens(pack, ctx);
    expect([...excused]).toEqual(["~/.local/state/mu-next/mu.db"]);
    const call = (name: string, args: Record<string, unknown>) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
      });
    const result = (text: string) =>
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text }] },
      });
    const said = (text: string) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    const audit = (lines: string[]): string[] => {
      const sd = join(tmp, `s${Math.random()}`);
      mkdirSync(sd);
      writeFileSync(join(sd, "x.jsonl"), lines.join("\n"));
      return auditSession(sd, ctx, excused).map((h) => h.rule);
    };
    // reading the pack's doc that names the state dir, and talking about it: clean
    expect(
      audit([
        call("read", { path: `${ctx.ownPack}/docs/state.md` }),
        result("State lives in ~/.local/state/mu-next/mu.db."),
        said("mu keeps ~/.local/state/mu-next/mu.db"),
        call("edit", {
          path: `${ctx.ownPack}/src/a.ts`,
          newText: "see ~/.local/state/mu-next/mu.db",
        }),
      ]),
    ).toEqual([]);
    // opening that path is not
    expect(
      audit([call("bash", { command: "sqlite3 ~/.local/state/mu-next/mu.db .tables" })]),
    ).toEqual(["under the real HOME"]);
    // a result showing what the pack does not carry is a leak
    expect(audit([result("/home/u/.ssh/id_rsa")])).toEqual(["under the real HOME"]);
    expect(audit([call("write", { path: "/home/u/notes.md", content: "x" })])).toEqual([
      "under the real HOME",
    ]);
    expect(audit(["not json /home/u/.ssh"])).toEqual(["under the real HOME"]);
    // writing to a path the pack names is still an act outside the pack
    expect(audit([call("write", { path: "~/.local/state/mu-next/mu.db", content: "x" })])).toEqual([
      "under the real HOME",
    ]);
  });

  it("node's install dir is the prefix above bin/node", () => {
    expect(nodeInstallDir("/no/such/.nvm/versions/node/v22/bin/node")).toBe(
      "/no/such/.nvm/versions/node/v22",
    );
    expect(nodeInstallDir("/no/such/mise/dist-package/node")).toBe("/no/such/mise/dist-package");
  });

  let tmp = "";
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("launches the designer with an empty HOME, the provider extension only, and no mu or museum on PATH", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-designer-"));
    const sys = join(tmp, "sys");
    const userBin = join(tmp, "userbin");
    for (const d of [sys, userBin]) mkdirSync(d);
    for (const [d, n] of [
      [userBin, "mu"],
      [userBin, "museum"],
      [sys, "git"],
    ] as const) {
      writeFileSync(join(d, n), "#!/bin/sh\n");
      chmodSync(join(d, n), 0o755);
    }
    const ddir = join(tmp, "ddir");
    const env = designerEnv({
      ddir,
      pack: join(ddir, "pack"),
      pathEnv: process.env.PATH,
      systemDirs: [userBin, sys],
      base: {},
    });
    expect(env.HOME).toBe(join(ddir, "home"));
    expect(env.PI_CODING_AGENT_DIR).toBe(env.HOME);
    expect(readFileSync(join(ddir, "home", "settings.json"), "utf8")).toContain("retry");
    expect(env.MU_SYNC_DIR).toBe("");
    expect(env.MU_DB_PATH?.startsWith(ddir)).toBe(true);
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "MU_DB_PATH",
        "MU_STATE_DIR",
        "MU_SYNC_DIR",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "TERM",
      ].sort(),
    );
    const dirs = (env.PATH ?? "").split(":");
    expect(dirs).not.toContain(userBin);
    expect(dirs).toContain(sys);
    for (const d of dirs) {
      expect(existsSync(join(d, "mu"))).toBe(false);
      expect(existsSync(join(d, "museum"))).toBe(false);
    }
    expect(existsSync(join(ddir, "bin", "node"))).toBe(true);
    const args = designerArgs({ ddir, model: "m", providerExt: "/p/ext.ts", prompt: "go" });
    expect(args).toEqual(
      expect.arrayContaining(["--no-extensions", "--no-skills", "--no-context-files", "--no-mcp"]),
    );
    expect(args.filter((a) => a === "-e")).toHaveLength(1);
    expect(args[args.indexOf("-e") + 1]).toBe("/p/ext.ts");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(join(ddir, "sessions"));
  });

  it("scrubs denied text out of the pack's remaining files", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-pack-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc && tsc -p tools/eval/tsconfig.json",
          eval: "node tools/eval/main.ts",
          build: "tsup",
        },
      }),
    );
    writeFileSync(join(tmp, "README.md"), "keep\nchecked by (`tools/eval`).\nkeep too\n");
    writeFileSync(join(tmp, "a.ts"), "// see tools/eval\nconst x = 1;\n");
    expect(scrubPack(tmp, { caseIds: [] })).toEqual([]);
    expect(JSON.parse(readFileSync(join(tmp, "package.json"), "utf8")).scripts).toEqual({
      typecheck: "tsc",
      build: "tsup",
    });
    expect(readFileSync(join(tmp, "README.md"), "utf8")).toBe("keep\nkeep too\n");
    writeFileSync(join(tmp, "b.ts"), 'const p = "tools/eval";\n');
    expect(scrubPack(tmp, { caseIds: [] })).toEqual(['b.ts: const p = "tools/eval";']);
  });
});

describe("BRIEF.md refusals", () => {
  const cases = [
    fakeCase("wait_result_read", {
      paraphrases: [
        { id: "p1", leadIn: "a", goal: "What did worker-1 report? Show me its result line." },
      ],
    }),
  ];
  const judgeFiles = ["nextstep-cases.ts", "poll_wave.ts"];
  const refuse = (t: string): string[] => briefRefusals(t, { cases, judgeFiles });

  it("lets a problem statement with counts through", () => {
    expect(
      refuse(
        "Most orchestrator waits were filtered through a JSON tool, 304 of 430, and the filter dropped the result.",
      ),
    ).toEqual([]);
  });

  it("refuses code, commands, cases, goals, judge files and deleted paths", () => {
    expect(refuse("x\n```sh\nmu wait\n```\n")).toContain("a fenced code block");
    expect(refuse("$ mu wait x\n")).toContain("a line starting with `$ `");
    expect(refuse("they ran mu wait agent:auth/worker-1@3 --json | jq -c .data a lot")[0]).toMatch(
      /lead-in command/,
    );
    expect(
      refuse("they piped --json | jq -c .data often").some((r) => r.startsWith("16 characters")),
    ).toBe(true);
    expect(refuse("see wait_result_read")).toContain("case id wait_result_read");
    expect(
      refuse("users ask what did worker-1 report, show me often").some((r) =>
        r.startsWith("5 words"),
      ),
    ).toBe(true);
    expect(refuse("Show me its result line.").some((r) => r.startsWith("5 words"))).toBe(true);
    expect(refuse("judged in poll_wave.ts")).toContain("judge file poll_wave.ts");
    expect(refuse("as docs/history says")).toContain("deleted path docs/history");
  });
});
