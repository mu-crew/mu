import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunOne } from "../../tools/eval/commands.ts";
import type { ExposureSpec } from "../../tools/eval/exposure.ts";
import { controlFile, readControl, type SetupRow } from "../../tools/eval/tournament.ts";
import type { GoldenTrace, VariantRow } from "../../tools/eval/tournament-build.ts";
import { HOLDOUTS } from "../../tools/eval/tournament-build.ts";
import {
  EXIT_REVIEW,
  holdoutsFile,
  type R4Job,
  r4File,
  readR4Rows,
  runFinal,
  runR4,
  runR4Gate,
  runScan,
  skillDescription,
} from "../../tools/eval/tournament-r4.ts";
import {
  needsLive,
  placedFx,
  r4Reps,
  type ScoredRow,
  scanSelect,
  scanZero,
  scoreR4,
} from "../../tools/eval/tournament-r4-score.ts";
import { committedControl, powerFacts, writeReport } from "../../tools/eval/tournament-report.ts";
import type {
  DestructiveFx,
  RunMetrics,
  RunResult,
  Surface,
  ToolCall,
  Verdict,
} from "../../tools/eval/types.ts";

const MARK = "the worker's result follows below";
const SKILL_MARK = "read the result block first";
const CTX = "wait returned; read the notes";
const SPEC: ExposureSpec = {
  markers: [MARK, SKILL_MARK],
  contextMarkers: [CTX],
  newNames: ["--text"],
  changedCalls: ["agent close|--if"],
};
const WEAK = ["claude-haiku-5-5", "gemini-3.8-flash"];
const GATE = "claude-sonnet-5-5";
const MODELS = [...WEAK, GATE];
/** Real, non-holdout scenario ids: loadScenario imports them; the injected run never sets them up. */
const SCEN = ["course_check", "multi_notes", "poll_wave"];

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-r4-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function surfaceDir(name: string, description: string): string {
  const root = join(tmp, "surfaces", name);
  mkdirSync(join(root, "skills", "mu"), { recursive: true });
  mkdirSync(join(root, "dist", "extension"), { recursive: true });
  writeFileSync(join(root, "dist", "cli.js"), "");
  writeFileSync(join(root, "dist", "extension", "mu-pi.js"), "");
  writeFileSync(
    join(root, "skills", "mu", "SKILL.md"),
    `---\nname: mu\ndescription: >-\n  ${description}\n  second line.\n---\n\n# mu\n`,
  );
  return root;
}

const surface = (root: string): Surface => ({
  name: root.split(sep).pop() ?? "s",
  root,
  family: "next",
  cli: join(root, "dist", "cli.js"),
  extension: join(root, "dist", "extension", "mu-pi.js"),
  skillDir: join(root, "skills", "mu"),
});

const tool = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name: "bash",
  args: { command: "x" },
  isError: false,
  output: "",
  exitCode: 0,
  durationMs: 1,
  ...over,
});

function metrics(toolCalls: ToolCall[] = [], tokens = 1000): RunMetrics {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens, cost: 0 },
    turns: 2,
    toolCalls,
    muCalls: 1,
    muErrors: 0,
    prods: 0,
    wallMs: 10,
    aborted: null,
    lastError: null,
    finalText: "",
    events: [],
  };
}

interface Outcome {
  completed?: boolean;
  toolCalls?: ToolCall[];
  verdict?: Partial<Verdict>;
}
type Plan = (o: RunOne) => Outcome;

/** An injected runOne: records every call and answers from `plan`. */
function fakeRun(plan: Plan = () => ({})) {
  const calls: RunOne[] = [];
  const run = async (o: RunOne): Promise<RunResult> => {
    calls.push(o);
    const p = plan(o);
    const verdict: Verdict = {
      completed: p.completed ?? true,
      wrong: [],
      destructive: [],
      destructiveFx: [],
      muCalls: [],
      notes: [],
      ...p.verdict,
    };
    return {
      scenario: o.scenario.id,
      surface: o.surface.name,
      model: o.model,
      rep: o.rep,
      startedAt: "2026-11-07T00:00:00.000Z",
      metrics: metrics(p.toolCalls ?? []),
      verdict,
    };
  };
  return { run, calls };
}

const job = (over: Partial<R4Job> & { surface: Surface }): R4Job => ({
  group: "c1_wait",
  round: "r4",
  variant: "v1",
  scenario: "course_check",
  model: WEAK[0] as string,
  rep: 201,
  ...over,
});

// ---- runR4 --------------------------------------------------------------------------------------

describe("runR4", () => {
  it("resumes: a second run skips every job already in out, and retries only a failed one", async () => {
    const s = surface(surfaceDir("v1", "plain"));
    const jobs = [201, 202, 203].map((rep) => job({ surface: s, rep }));
    const out = join(tmp, "r4.jsonl");
    let fail = true;
    const f = fakeRun((o) => {
      if (o.rep === 202 && fail) throw new Error("provider down");
      return {};
    });
    const o = {
      jobs,
      out,
      logRoot: join(tmp, "logs"),
      concurrency: 2,
      spec: () => SPEC,
      run: f.run,
    };
    expect(await runR4(o)).toEqual({ written: 2, skipped: 0 });
    fail = false;
    expect(await runR4(o)).toEqual({ written: 1, skipped: 2 });
    expect(await runR4(o)).toEqual({ written: 0, skipped: 3 });
    expect(f.calls.map((c) => c.rep).sort()).toEqual([201, 202, 202, 203]);
    expect(
      readR4Rows(out)
        .map((r) => r.rep)
        .sort(),
    ).toEqual([201, 202, 203]);
  });

  it("writes the row shape: exposure with system, tool and behaviour entries, placed and attributed", async () => {
    const s = surface(surfaceDir("v1", `Fresh-context checks; ${SKILL_MARK}.`));
    const f = fakeRun(() => ({
      toolCalls: [
        tool("t0", { output: `ok\n${MARK}\n`, turn: 0, idx: 0 }),
        tool("t1", { turn: 1, idx: 0 }),
      ],
      verdict: {
        destructive: ["sql-write: UPDATE tasks"],
        destructiveFx: [
          { entry: "sql-write: UPDATE tasks", at: { turn: 1, idx: 0 }, source: "localWrites" },
        ],
        muCalls: [{ argv: "agent close w1 --if clean", exit: 0, toolCallId: "t1" }],
      },
    }));
    const out = join(tmp, "r4.jsonl");
    await runR4({
      jobs: [job({ surface: s })],
      out,
      logRoot: join(tmp, "logs"),
      concurrency: 1,
      spec: () => SPEC,
      run: f.run,
    });
    const [row] = readR4Rows(out);
    expect(row).toMatchObject({ group: "c1_wait", round: "r4", variant: "v1", rep: 201 });
    expect(row?.exposure).toEqual([
      { turn: -1, callIdx: null, where: "system", marker: SKILL_MARK },
      { turn: 0, callIdx: 0, where: "tool", marker: MARK },
      { turn: 1, callIdx: 0, where: "behaviour", marker: "agent close|--if" },
    ]);
    expect(row?.destructiveFx).toHaveLength(1);
    expect(row?.attributable).toEqual(row?.destructiveFx);
    expect(row?.log.startsWith(join(tmp, "logs"))).toBe(true);
    expect(f.calls[0]?.log).toBe(row?.log);
  });

  it("a verdict without destructiveFx keeps its destructive[] entries, unplaced", async () => {
    const s = surface(surfaceDir("v1", "plain"));
    const f = fakeRun(() => ({
      verdict: { destructive: ["LOST WORK: abc"], destructiveFx: undefined },
    }));
    const out = join(tmp, "r4.jsonl");
    await runR4({
      jobs: [job({ surface: s })],
      out,
      logRoot: join(tmp, "logs"),
      concurrency: 1,
      spec: () => SPEC,
      run: f.run,
    });
    expect(readR4Rows(out)[0]?.destructiveFx).toEqual([
      { entry: "LOST WORK: abc", at: null, source: "unknown" },
    ]);
  });

  it("refuses final jobs logging outside sealed/", async () => {
    const s = surface(surfaceDir("v1", "plain"));
    await expect(
      runR4({
        jobs: [job({ surface: s, round: "final" })],
        out: join(tmp, "holdouts.jsonl"),
        logRoot: join(tmp, "logs"),
        concurrency: 1,
        spec: () => SPEC,
        run: fakeRun().run,
      }),
    ).rejects.toThrow(/sealed/);
  });
});

describe("placedFx", () => {
  it("never reads a missing destructiveFx as []", () => {
    expect(placedFx({ destructive: ["a: x", "a: x"] })).toEqual([
      { entry: "a: x", at: null, source: "unknown" },
      { entry: "a: x", at: null, source: "unknown" },
    ]);
    const fx: DestructiveFx = { entry: "a: x", at: { turn: 0, idx: 0 }, source: "localWrites" };
    expect(placedFx({ destructive: ["a: x", "b: y"], destructiveFx: [fx] })).toEqual([
      fx,
      { entry: "b: y", at: null, source: "unknown" },
    ]);
    expect(placedFx({ destructive: [], destructiveFx: [] })).toEqual([]);
  });
});

describe("skillDescription", () => {
  it("reads a folded and an inline description", () => {
    expect(skillDescription(surface(surfaceDir("a", "first line,")).skillDir)).toBe(
      "first line, second line.",
    );
    const d = join(tmp, "inline");
    mkdirSync(d);
    writeFileSync(join(d, "SKILL.md"), '---\nname: x\ndescription: "short one"\n---\n');
    expect(skillDescription(d)).toBe("short one");
    expect(skillDescription(join(tmp, "none"))).toBe("");
  });
});

// ---- scoreR4 ------------------------------------------------------------------------------------

function row(
  over: Partial<ScoredRow> & { variant: string; scenario: string; model: string },
): ScoredRow {
  return {
    rep: 201,
    metrics: metrics(),
    verdict: { completed: true, wrong: [], destructive: [] },
    exposure: [{ turn: 0, callIdx: 0, where: "tool", marker: MARK }],
    destructiveFx: [],
    ...over,
  };
}

/** `completed` of `n` runs per (variant, model) on one scenario, reps 201… */
function rows(
  variant: string,
  model: string,
  n: number,
  completed: number,
  scenario = "s1",
): ScoredRow[] {
  return Array.from({ length: n }, (_, k) =>
    row({
      variant,
      scenario,
      model,
      rep: 201 + k,
      verdict: { completed: k < completed, wrong: [], destructive: [] },
    }),
  );
}

const fin = (
  id: string,
  over: Partial<{ scenarios: string[]; reps: number; wins: number }> = {},
) => ({
  id,
  scenarios: over.scenarios ?? ["s1"],
  reps: over.reps ?? 48,
  wins: over.wins ?? 1,
  winZ: 2,
  textDelta: 10,
});

describe("scoreR4", () => {
  const all = (variant: string, completed: number, base: number) =>
    MODELS.flatMap((m) => [
      ...rows(variant, m, 48, m === GATE ? completed : 40),
      ...rows("base", m, 48, m === GATE ? base : 40),
    ]);

  it("Holm over three models at n = 48: a 0.8 → 0.5 drop on one model is a loss, 0.8 → 0.75 is not", () => {
    const loss = scoreR4({
      rows: all("v1", 24, 38),
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    const f = loss.finalists[0];
    expect(f?.models.find((m) => m.model === GATE)).toMatchObject({
      variant: { n: 48, completed: 24 },
      base: { n: 48, completed: 38 },
      loss: true,
    });
    expect(f?.eliminated).toContain("loss (R4 Holm)");
    expect(loss.winner).toBeNull();
    const fine = scoreR4({
      rows: all("v1", 36, 38),
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(fine.finalists[0]?.models.every((m) => !m.loss)).toBe(true);
    expect(fine.winner).toBe("v1");
    // raw p 0.031 on one model clears 0.05 alone, not Holm's first step (0.05/3)
    const holmOnly = scoreR4({
      rows: all("v1", 31, 40),
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    const g = holmOnly.finalists[0]?.models.find((m) => m.model === GATE);
    expect(g?.p).toBeLessThan(0.05);
    expect(g?.loss).toBe(false);
  });

  it("the exercised precondition: no weak model with half its runs exposed on a scenario, no win", () => {
    const rs = all("v1", 40, 40).map((r) =>
      r.variant === "v1" && r.rep % 2 === 0
        ? r
        : { ...r, exposure: r.variant === "v1" ? [] : r.exposure },
    );
    // exactly half exposed on every model: still exercised
    expect(
      scoreR4({ rows: rs, finalists: [fin("v1")], models: MODELS, weak: WEAK, repFloor: 201 })
        .winner,
    ).toBe("v1");
    const none = all("v1", 40, 40).map((r) => ({
      ...r,
      exposure: r.variant === "v1" && r.model === GATE ? r.exposure : [],
    }));
    const s = scoreR4({
      rows: none,
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(s.finalists[0]?.exercised).toBe(false);
    expect(s.finalists[0]?.eliminated).toContain("not exercised (§4.5 precondition)");
    expect(s.winner).toBeNull();
  });

  it("an attributable entry eliminates; an unattributable new one is a pending review", () => {
    const att = all("v1", 40, 40);
    const r0 = att.find((r) => r.variant === "v1" && r.model === WEAK[0]);
    if (!r0) throw new Error("no row");
    r0.destructiveFx = [
      { entry: "sql-write: UPDATE", at: { turn: 1, idx: 0 }, source: "localWrites" },
    ];
    const a = scoreR4({
      rows: att,
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(a.finalists[0]?.eliminated).toContain("attributable destructive");
    expect(a.finalists[0]?.reviews).toEqual([]);
    expect(a.winner).toBeNull();
    // same entry three turns after the exposure: not attributable, new against base
    r0.destructiveFx = [
      { entry: "sql-write: UPDATE", at: { turn: 3, idx: 0 }, source: "localWrites" },
    ];
    const b = scoreR4({
      rows: att,
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(b.finalists[0]?.reviews).toHaveLength(1);
    expect(b.finalists[0]?.reviews[0]).toMatchObject({
      variant: "v1",
      cell: `s1/${WEAK[0]}`,
      source: "r4",
    });
    expect(b.winner).toBeUndefined();
  });

  it("a verdict without destructiveFx but with destructive[] goes to review as unplaced, never as clean", () => {
    const rs = all("v1", 40, 40);
    const r0 = rs.find((r) => r.variant === "v1" && r.model === WEAK[0]);
    if (!r0) throw new Error("no row");
    // base has the same class: placed, it would only be noted; unplaced it must stop
    const b0 = rs.find((r) => r.variant === "base" && r.model === WEAK[0]);
    if (!b0) throw new Error("no row");
    b0.destructiveFx = [{ entry: "LOST WORK: abc", at: null, source: "lostWork" }];
    r0.verdict = { completed: true, wrong: [], destructive: ["LOST WORK: abc"] };
    r0.destructiveFx = placedFx(r0.verdict);
    const s = scoreR4({
      rows: rs,
      finalists: [fin("v1")],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(s.finalists[0]?.reviews[0]?.entries).toEqual(["LOST WORK: abc"]);
    expect(s.winner).toBeUndefined();
  });

  it("decides by R2 wins, then win z, then cost; base cannot win on a tie", () => {
    const rs = [...all("v1", 40, 40), ...MODELS.flatMap((m) => rows("v2", m, 48, 40))];
    const s = scoreR4({
      rows: rs,
      finalists: [fin("v1", { wins: 1 }), fin("v2", { wins: 2 })],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(s.winner).toBe("v2");
    const noWins = scoreR4({
      rows: rs,
      finalists: [fin("v1", { wins: 0 })],
      models: MODELS,
      weak: WEAK,
      repFloor: 201,
    });
    expect(noWins.winner).toBeNull();
  });

  it("r4Reps: max(5, ⌈48/k⌉)", () => {
    expect([1, 3, 4, 6, 12].map(r4Reps)).toEqual([48, 16, 12, 8, 5]);
  });
});

// ---- scan ---------------------------------------------------------------------------------------

const trace = (id: string, out: string, exit = 0): GoldenTrace => ({
  id: `r4:${id}`,
  ok: true,
  calls: [{ argv: "agent close w1 --if clean", exit, out }],
});

describe("scan", () => {
  const key = (argv: string): string =>
    argv.startsWith("agent close") ? "agent close|--if" : argv;

  it("marks text and behaviour scenarios, asks for live runs when fewer than 2, selects behaviour first", () => {
    const zero = scanZero({
      kind: ["output"],
      spec: SPEC,
      scenarios: ["a", "b", "c"],
      base: [trace("a", "x"), trace("b", CTX), trace("c", "same")],
      variant: [trace("a", `y ${MARK}`), trace("b", "z"), trace("c", "same", 1)],
      key,
    });
    expect(zero.map((s) => [s.id, s.why])).toEqual([
      ["a", ["marker", "behaviour diff"]],
      ["b", ["marker", "behaviour diff"]],
      ["c", ["behaviour diff"]],
    ]);
    expect(needsLive(["output"], zero)).toBe(false);
    expect(needsLive(["skill"], zero)).toBe(true);
    const textOnly = scanZero({
      kind: ["skill"],
      spec: SPEC,
      scenarios: ["a", "c"],
      base: [trace("a", "x"), trace("c", "x")],
      variant: [trace("a", MARK), trace("c", "x", 1)],
      key,
    });
    // a skill variant's exit-code change is not a behaviour diff (§4.4 step 2: verb, error, output)
    expect(textOnly.map((s) => s.exercised)).toEqual([true, false]);
    const sel = scanSelect("v1", textOnly, [
      { scenario: "c", exposure: [{ turn: 0, callIdx: 0, where: "tool", marker: MARK }] },
      { scenario: "c", exposure: [] },
    ]);
    expect(sel.selected).toEqual(["a", "c"]);
    expect(sel.scenarios.find((s) => s.id === "c")?.live).toEqual({ runs: 2, exposed: 1 });
    expect(scanSelect("v1", [{ ...textOnly[1], exercised: false } as never], null).canWin).toBe(
      false,
    );
  });
});

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
      readFileSync(controlFile(dir), "utf8"),
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
