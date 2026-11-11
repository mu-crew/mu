// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// The R4 gate commands (runScan, runR4Gate, runFinal) and the report (powerFacts, writeReport).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlFile, readControl, type SetupRow } from "../../tools/eval/tournament.ts";
import type { VariantRow } from "../../tools/eval/tournament-build.ts";
import { HOLDOUTS } from "../../tools/eval/tournament-build.ts";
import {
  EXIT_REVIEW,
  holdoutsFile,
  r4File,
  readR4Rows,
  runFinal,
  runR4Gate,
  runScan,
} from "../../tools/eval/tournament-r4.ts";
import {
  committedControl,
  powerFacts,
  publicControl,
  writeReport,
} from "../../tools/eval/tournament-report.ts";
import type { Surface } from "../../tools/eval/types.ts";
import { fakeRun, type Outcome, tool } from "./_r4-fakes.ts";
import {
  GATE,
  MARK,
  MODELS,
  SCEN,
  SPEC,
  surfaceDir as surfaceAt,
  trace,
  WEAK,
} from "./_r4-fixtures.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-r4-gate-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});
const surfaceDir = (name: string, description: string): string => surfaceAt(tmp, name, description);

// ---- the gate commands --------------------------------------------------------------------------

function setupRow(baseDir: string): SetupRow {
  return {
    kind: "setup",
    group: "c1_wait",
    baseSha: "abc123",
    baseDir,
    b0: { models: MODELS, providerExt: null, rows: MODELS.map((model) => ({ model, ok: true })) },
    models: { weak: WEAK, gate: GATE },
    providerExt: null,
    systemSha: "sys",
    rho: { c1: Object.fromEntries(MODELS.map((m) => [m, 0.2])) },
    rhoPool: { c1: 0.2 },
    seed: "seed",
    holdouts: { ids: [...HOLDOUTS], note: "not run, not read" },
  };
}

function variantRow(
  id: string,
  dir: string,
  kind: VariantRow["manifest"]["kind"] = ["output"],
): VariantRow {
  return {
    kind: "variant",
    id,
    session: "opus",
    manifest: { id, group: "c1_wait", kind, summary: `variant ${id}` },
    patchSha: "p",
    ref: "abc123+p",
    dir,
    spec: SPEC,
    rejectedContext: [],
    textDelta: 12,
    admission: { ok: true, failures: [] },
    goldenCompat: { broken: [] },
  };
}

const writeControl = (dir: string, rs: readonly unknown[]): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(controlFile(dir), rs.map((r) => `${JSON.stringify(r)}\n`).join(""));
};

function gateDir(): { dir: string; base: string; v1: string } {
  const base = surfaceDir("base", "plain base");
  const v1 = surfaceDir("v1", "plain variant");
  const dir = join(tmp, "rows", "c1_wait");
  writeControl(dir, [
    setupRow(base),
    variantRow("v1", v1),
    {
      kind: "round_score",
      round: "r2",
      epoch: 0,
      S: 2,
      scores: [{ id: "v1", wins: 1, winZ: 2.5 }],
    },
    {
      kind: "cut",
      round: "r2",
      epoch: 0,
      ranking: ["v1"],
      eligible: ["v1"],
      advance: 1,
      advanced: ["v1"],
    },
  ]);
  return { dir, base, v1 };
}

const exposedRun = (): Outcome => ({ toolCalls: [tool("t0", { output: MARK, turn: 0, idx: 0 })] });

describe("runScan and runR4Gate", () => {
  it("scans, runs R4 at max(5, ⌈48/k⌉) reps and decides", async () => {
    const { dir, base, v1 } = gateDir();
    const traces = async (s: Surface, scenarios: readonly string[]) =>
      scenarios.map((id) => trace(id, s.root === v1 && id !== "poll_wave" ? MARK : "x"));
    const f = fakeRun((o) => (o.surface.root === v1 ? exposedRun() : {}));
    const deps = { traces, run: f.run, paths: () => ["agent close"], ping: () => {} };
    expect(
      await runScan({
        group: "c1_wait",
        dir,
        repo: tmp,
        args: ["--scenarios", SCEN.join(",")],
        deps,
      }),
    ).toBe(0);
    const scan = readControl(dir).find((r) => r.kind === "scan") as unknown as {
      selected: string[];
    };
    expect(scan.selected).toEqual(["course_check", "multi_notes"]);
    expect(f.calls).toHaveLength(0); // two marker scenarios: no live step for an output variant
    expect(await runR4Gate({ group: "c1_wait", dir, repo: tmp, args: [], deps })).toBe(0);
    // 2 scenarios → 24 reps × 3 models × (variant + base)
    expect(f.calls).toHaveLength(2 * 24 * 3 * 2);
    expect(new Set(f.calls.map((c) => c.surface.root))).toEqual(new Set([base, v1]));
    const decision = readControl(dir).find((r) => r.kind === "decision") as unknown as {
      winner: string;
    };
    expect(decision.winner).toBe("v1");
    // resumable: a second gate run starts no AUT
    expect(await runR4Gate({ group: "c1_wait", dir, repo: tmp, args: [], deps })).toBe(0);
    expect(f.calls).toHaveLength(2 * 24 * 3 * 2);
  });

  it("an unattributable destructive entry new against base stops with exit 7 and pings", async () => {
    const { dir, v1 } = gateDir();
    const rows = readControl(dir) as unknown[];
    rows.push({
      kind: "scan",
      epoch: 0,
      variant: "v1",
      scenarios: [],
      selected: ["course_check"],
      live: false,
      canWin: true,
    });
    writeControl(dir, rows);
    const f = fakeRun((o) =>
      o.surface.root === v1 && o.rep === 201 && o.model === WEAK[0]
        ? {
            ...exposedRun(),
            verdict: {
              destructive: ["git-reset-hard: main"],
              destructiveFx: [
                {
                  entry: "git-reset-hard: main",
                  at: { turn: 4, idx: 0 },
                  source: "destructiveOps",
                },
              ],
            },
          }
        : o.surface.root === v1
          ? exposedRun()
          : {},
    );
    const pings: string[] = [];
    const code = await runR4Gate({
      group: "c1_wait",
      dir,
      repo: tmp,
      args: [],
      deps: { run: f.run, ping: (m) => pings.push(m) },
    });
    expect(code).toBe(EXIT_REVIEW);
    expect(f.calls).toHaveLength(48 * 3 * 2);
    const stop = readControl(dir).find((r) => r.kind === "review_stop");
    expect(stop).toMatchObject({
      variant: "v1",
      cell: `course_check/${WEAK[0]}`,
      source: "r4",
      entries: ["git-reset-hard: main"],
    });
    expect(pings).toHaveLength(1);
    expect(readControl(dir).some((r) => r.kind === "decision")).toBe(false);
    expect(readR4Rows(r4File(dir, 0))).toHaveLength(48 * 3 * 2);
  });
});

// ---- final --------------------------------------------------------------------------------------

/** Every file under `dir`, relative. */
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));

describe("runFinal", () => {
  it("runs the holdouts once on the combined surface, logs only under sealed/, rows to holdouts.jsonl", async () => {
    const { dir } = gateDir();
    const combined = surfaceDir("combined", "combined");
    const f = fakeRun();
    const code = await runFinal({
      group: "c1_wait",
      dir,
      repo: tmp,
      args: ["--surface", combined],
      deps: { run: f.run },
    });
    expect(code).toBe(0);
    expect(f.calls).toHaveLength(HOLDOUTS.length * 2 * 3 * 12);
    expect(new Set(f.calls.map((c) => c.scenario.id))).toEqual(new Set(HOLDOUTS));
    const sealed = resolve(dir, "sealed");
    for (const c of f.calls) expect(resolve(c.log ?? "").startsWith(sealed + sep)).toBe(true);
    expect(readR4Rows(holdoutsFile(dir)).every((r) => r.log.startsWith(sealed + sep))).toBe(true);
    expect(
      files(dir)
        .filter((p) => !p.startsWith(`sealed${sep}`))
        .sort(),
    ).toEqual(["holdouts.jsonl", "tournament.jsonl"]);
    const score = readControl(dir).find((r) => r.kind === "final_score") as unknown as {
      stop: boolean;
    };
    expect(score.stop).toBe(false);
    // once: never a second time, on this or any other surface
    await expect(
      runFinal({
        group: "c1_wait",
        dir,
        repo: tmp,
        args: ["--surface", combined],
        deps: { run: f.run },
      }),
    ).rejects.toThrow(/run once/);
  });

  it("a holdout loss is a manual-review stop (exit 7), and the gate is never re-run or bisected", async () => {
    const { dir } = gateDir();
    const combined = surfaceDir("combined", "combined");
    const f = fakeRun((o) => ({
      completed: !(o.surface.root === combined && o.model === GATE && o.rep % 2 === 0),
    }));
    const pings: string[] = [];
    const code = await runFinal({
      group: "c1_wait",
      dir,
      repo: tmp,
      args: ["--surface", combined],
      deps: { run: f.run, ping: (m) => pings.push(m) },
    });
    expect(code).toBe(EXIT_REVIEW);
    expect(pings).toHaveLength(1);
    const stop = readControl(dir).find((r) => r.kind === "review_stop");
    expect(stop).toMatchObject({ source: "holdout", variant: "combined" });
    const other = surfaceDir("combined-minus-one", "subset");
    await expect(
      runFinal({
        group: "c1_wait",
        dir,
        repo: tmp,
        args: ["--surface", other],
        deps: { run: f.run },
      }),
    ).rejects.toThrow(/run once|no re-run/);
  });
});

// ---- report -------------------------------------------------------------------------------------

describe("powerFacts", () => {
  it("states power at the planned n (per-model 64, pooled 90), the six-group bound and the end-to-end power", () => {
    const plan = [
      {
        case: "c1",
        kind: "own" as const,
        plan: { paraphrases: 10, add: 0, m: 30, r: 3, nEff: 64.29, nEffPooled: 90, reached: true },
        r1: 1,
        mde: 0.77,
      },
    ];
    const p = powerFacts(plan, {});
    expect(p.ownPerModel).toEqual([64]);
    expect(p.B).toBe(18);
    expect(p.winPower).toBeGreaterThan(0.9);
    expect(p.falseWinAny).toBeCloseTo(0.265, 3);
    expect(p.endToEnd).toBeCloseTo(0.9 * 0.9 * 0.95 * p.winPower, 10);
    expect(p.endToEnd).toBeGreaterThan(0.65);
    expect(p.endToEnd).toBeLessThan(0.75);
    expect(p.r4.find((r) => r.k === 6)?.n).toBe(48);
  });
});

describe("writeReport", () => {
  it("renders the §6 sections from synthetic rows and copies tournament.jsonl for commit", async () => {
    const dir = join(tmp, "rows", "c1_wait");
    const repo = join(tmp, "repo");
    const cand = join(repo, "tools", "eval", "candidates", "c1_wait", "opus");
    mkdirSync(cand, { recursive: true });
    writeFileSync(
      join(cand, "v1.json"),
      JSON.stringify({ id: "v1", group: "c1_wait", kind: ["output"], summary: "s" }),
    );
    writeFileSync(join(cand, "v1.patch"), "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n");
    const plan = [
      {
        case: "c1",
        kind: "own",
        plan: { paraphrases: 10, add: 0, m: 30, r: 3, nEff: 64.29, nEffPooled: 90, reached: true },
        r1: 1,
        mde: 0.77,
      },
      {
        case: "g13",
        kind: "guard",
        plan: { paraphrases: 6, add: 0, m: 12, r: 8, nEff: 40, reached: true },
        r1: 0,
        mde: 0.48,
      },
    ];
    const side = (n: number, hits: number) => ({
      n,
      hits,
      clusters: 30,
      deff: 1.4,
      nStar: Math.round(n / 1.4),
      hitsStar: Math.round(hits / 1.4),
    });
    const score = {
      id: "v1",
      loss: MODELS.map((model) => ({
        case: "c1",
        model,
        variant: side(90, 70),
        base: side(90, 50),
        p: 0.99,
        holmP: 1,
        loss: false,
      })),
      cmh: MODELS.map((model) => ({ model, z: 1.2, p: 0.88, loss: false })),
      win: [
        {
          case: "c1",
          exposedClusters: 30,
          nameCueRows: 0,
          unexposed: false,
          variant: side(180, 140),
          base: side(180, 100),
          p: 0.0001,
          z: 4.1,
          direction: {},
          threshold: 0.0083,
          win: true,
        },
      ],
      eliminated: [],
      attributable: [],
      reviews: [],
      invalidRows: 0,
      r1Score: 0,
      wins: 1,
      winZ: 4.1,
      hitsExposed: 140,
      meanTokens: 900,
      textDelta: 12,
    };
    const r4Cell = (surface: string) => ({
      scenario: "course_check",
      model: GATE,
      surface,
      runs: 16,
      completed: 13,
      exposed: surface === "v1" ? 16 : 0,
      wrong: 0,
      muErrors: 1,
      attributable: 0,
      review: 0,
      noted: 0,
    });
    const control: unknown[] = [
      { ...setupRow("/surfaces/base"), at: "t" },
      { kind: "freeze", judgesHash: "j1", files: [], nPlan: plan, checks: "green" },
      { kind: "isolation", session: "opus", model: "claude-opus-5-5", hits: [] },
      variantRow("v1", "/surfaces/v1"),
      { kind: "round_score", round: "r2", epoch: 0, S: 2, scores: [score] },
      {
        kind: "cut",
        round: "r2",
        epoch: 0,
        ranking: ["v1"],
        eligible: ["v1"],
        advance: 1,
        advanced: ["v1"],
      },
      {
        kind: "scan",
        epoch: 0,
        variant: "v1",
        scenarios: [
          {
            id: "course_check",
            markers: [MARK],
            context: [],
            behaviour: [],
            live: null,
            exercised: true,
            why: ["marker"],
          },
        ],
        selected: ["course_check"],
        live: false,
        canWin: true,
      },
      {
        kind: "r4_score",
        epoch: 0,
        finalists: [
          {
            id: "v1",
            scenarios: ["course_check"],
            reps: 48,
            models: [
              {
                model: GATE,
                variant: { n: 48, completed: 40 },
                base: { n: 48, completed: 39 },
                p: 0.7,
                holmP: 1,
                loss: false,
              },
            ],
            cells: [r4Cell("v1"), r4Cell("base")],
            exercised: true,
            eliminated: [],
            attributable: [],
            reviews: [],
            meanCost: 5000,
            wins: 1,
            winZ: 4.1,
            textDelta: 12,
            passes: true,
          },
        ],
        base: { meanCost: 5100, spread: 700 },
        winner: "v1",
        why: "v1 passes R4 with 1 R2 win(s) (z 4.10)",
      },
      {
        kind: "review_stop",
        id: "rs-1",
        variant: "v1",
        cell: "c1/h",
        entries: ["sql-write: x"],
        transcript: "t.jsonl",
        source: "probe",
      },
      {
        kind: "review_decision",
        stop: "rs-1",
        decision: "continue",
        why: "line 4: the AUT's own verification",
      },
      { kind: "decision", epoch: 0, winner: "v1", why: "v1 passes R4 with 1 R2 win(s) (z 4.10)" },
      { kind: "spend", round: "r4", epoch: 0, tokens: { [GATE]: 120000 }, wallMs: 7_200_000 },
    ];
    writeControl(dir, control);
    writeFileSync(join(dir, "r4.jsonl"), "{}\n");
    mkdirSync(join(dir, "sealed"));
    writeFileSync(join(dir, "sealed", "x.rpc.jsonl"), "secret\n");
    const out = "docs/eval/hill-r2/c1_wait.md";
    expect(await writeReport({ group: "c1_wait", dir, repo, args: [], out })).toBe(0);
    const md = readFileSync(join(repo, out), "utf8").replaceAll(tmp, "<tmp>");
    expect(readFileSync(committedControl(repo, "c1_wait"), "utf8")).toBe(
      publicControl(readFileSync(controlFile(dir), "utf8")),
    );
    expect(md).not.toContain("x.rpc.jsonl");
    expect(md).toContain("per-model n_eff 64");
    await expect(md).toMatchFileSnapshot("./__snapshots__/tournament-report.md");
  });

  it("the .gitignore commits the control copy and nothing else under docs/eval", () => {
    const gi = readFileSync(join(__dirname, "..", "..", ".gitignore"), "utf8").split("\n");
    const ignore = gi.indexOf("docs/eval/**/*.jsonl");
    const neg = gi.indexOf("!docs/eval/hill-r2/*.tournament.jsonl");
    expect(ignore).toBeGreaterThanOrEqual(0);
    expect(neg).toBeGreaterThan(ignore);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
