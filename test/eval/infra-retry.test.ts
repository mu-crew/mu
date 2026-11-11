// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Failed probe rows (tools/eval/infra-retry.ts, f_rig_infra_retry_2): every failed row (a seed
// exit, a lead-in timeout, a rig throw) is retried up to 2 times, each try under its own claim. A
// row failing every try is invalid, whatever its stderr says; only when base's row of the same
// pairing failed every try too is the pairing dropped from both sides. Over 10% of a variant's
// clusters dropped: undecided, never a win.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadInFault, rowFailure } from "../../tools/eval/infra-retry.ts";
import type { NextCase, ProbeRow } from "../../tools/eval/nextstep.ts";
import type { Surface } from "../../tools/eval/types.ts";

const box = vi.hoisted(() => ({
  made: 0,
  fail: null as string | null,
  /** Lead-in records of run n (from 1), one per step. */
  lead: null as ((n: number, cmds: string[]) => unknown[]) | null,
  leadRuns: 0,
}));
vi.mock("../../tools/eval/sandbox.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/sandbox.ts")>()),
  createSandbox: async () => {
    box.made++;
    if (box.fail !== null) throw new Error(box.fail);
    return {
      dir: "/nonexistent",
      env: {},
      binDir: "/nonexistent/bin",
      repoDir: "/nonexistent/repo",
      workerDir: "/nonexistent/workers",
      tmuxSocket: "/nonexistent/sock",
      dbPath: "/nonexistent/mu.db",
      surface: { name: "stub", root: "/nonexistent", cli: "", extension: "", skillDir: "" },
      close: async () => {},
    };
  },
}));
vi.mock("../../tools/eval/ops.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/ops.ts")>()),
  maxSeq: () => 0,
}));
vi.mock("../../tools/eval/nextstep-exec.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/nextstep-exec.ts")>()),
  runLeadIn: async (_sb: unknown, steps: { cmd: string }[]) => {
    box.leadRuns++;
    return (
      box.lead?.(
        box.leadRuns,
        steps.map((s) => s.cmd),
      ) ?? []
    );
  },
}));
vi.mock("../../tools/eval/cold-help.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/cold-help.ts")>()),
  surfaceVocab: () => new Set<string>(),
}));
vi.mock("../../tools/eval/cold-guess.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/cold-guess.ts")>()),
  buildId: () => "9.9.9+abcdef0",
}));

const { runNext } = await import("../../tools/eval/nextstep.ts");
const { NEXT_CASES } = await import("../../tools/eval/nextstep-cases.ts");
const { scoreRound, BASE, cut, decideFast } = await import("../../tools/eval/tournament-score.ts");
const { infraLine } = await import("../../tools/eval/tournament-report.ts");
const { cellRows, GEMINI, HAIKU, prompt, rng, SONNET, spec } = await import(
  "./_tournament-rows.ts"
);

const TMUX_FAIL =
  "sandbox: tmux new-session failed (1): error connecting to /tmp/mu-eval-x/sock (Resource temporarily unavailable)";
const GIT_128 =
  "seed failed (128): mu workstream init auth\nfatal: Unable to create '/tmp/x/.git/index.lock': File exists.";
const OWN_FAIL = "seed failed (1): mu workstream init auth\nerror: unknown option '--json'";
// c3: claudeopus55-multiline's row, exit 128 with nothing on stderr
const EMPTY_128 = "seed failed (128): mu workstream init auth\n";
// the reviewer's case: the variant's own mux call breaks, with mu's TmuxError text
const OWN_TMUX =
  "seed failed (128): mu workstream init auth\nmu: tmux new-session -d -s x failed (exit 1)";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-infra-retry-"));
  box.made = 0;
  box.fail = null;
  box.lead = null;
  box.leadRuns = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function surface(): Surface {
  const root = join(tmp, "surface");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "cli.js"), "");
  return { name: "v", root, cli: join(root, "dist", "cli.js"), extension: "", skillDir: "" };
}

const first = NEXT_CASES[0];
if (!first) throw new Error("no nextstep case");
const real: NextCase = first;

/** The first case with a scripted seed: `fails(n)` says whether try n (from 1) throws, and with what. */
function fakeCase(fails: (n: number) => string | null): { c: NextCase; tries: () => number } {
  let n = 0;
  const c: NextCase = {
    ...real,
    seed: async () => {
      n++;
      const err = fails(n);
      if (err !== null) throw new Error(err);
      return {};
    },
    // the real lead-in for the lint, without its preconditions; runLeadIn is stubbed
    leadIn: (sb, st, v) => real.leadIn(sb, st, v).map(({ cmd }) => ({ cmd })),
  };
  return { c, tries: () => n };
}

async function run(c: NextCase, reps = 1): Promise<ProbeRow[]> {
  const out = join(tmp, "probe.jsonl");
  const s = surface();
  const rows: ProbeRow[] = [];
  await runNext({
    jobs: Array.from({ length: reps }, (_, i) => ({
      round: "r1" as const,
      group: c.group,
      surfaceLabel: "v1",
      surface: s,
      // no scripted reply: the row ends at the model turn with a model error, a scored miss
      model: "evalfaux/none",
      caseId: c.id,
      arm: "none" as const,
      paraphrase: c.paraphrases[0]?.id ?? "p1",
      rep: i + 1,
    })),
    out,
    promptDir: join(tmp, "prompts"),
    concurrency: 1,
    modelConcurrency: 1,
    cases: [c],
    infraBackoffMs: [0, 0],
    onRow: (r) => rows.push(r),
  });
  return rows;
}

describe("infra retry: runNext", () => {
  it("a seed that exits 128 with empty stderr once is retried and the row is scored", async () => {
    const { c, tries } = fakeCase((n) => (n === 1 ? EMPTY_128 : null));
    const [r] = await run(c);
    expect(tries()).toBe(2);
    expect(box.made).toBe(2);
    expect(r?.invalid).toBe(false);
    expect(r?.infraFail).toBeUndefined();
    expect(r?.infraRetries).toBe(1);
    expect(r?.modelError).toContain("no scripted reply");
  });

  it("a lead-in step that times out once is retried and the row is scored", async () => {
    const { c } = fakeCase(() => null);
    box.lead = (n, cmds) =>
      cmds.map((cmd, i) => ({
        cmd,
        exit: n === 1 && i === 0 ? 137 : 0,
        killed: n === 1 && i === 0,
        output: "",
        start: 0,
        end: 0,
        limitMs: 120_000,
      }));
    const [r] = await run(c);
    expect(box.leadRuns).toBe(2);
    expect(r?.invalid).toBe(false);
    expect(r?.leadInFault).toBeUndefined();
    expect(r?.leadInExits.every((e) => e === 0)).toBe(true);
    expect(r?.infraRetries).toBe(1);
    expect(r?.infraFail).toBeUndefined();
  });

  it("a lead-in that times out on every try is invalid after 3 tries", async () => {
    const { c } = fakeCase(() => null);
    box.lead = (_n, cmds) =>
      cmds.map((cmd) => ({
        cmd,
        exit: 137,
        killed: true,
        output: "",
        start: 0,
        end: 0,
        limitMs: 120_000,
      }));
    const [r] = await run(c);
    expect(box.leadRuns).toBe(3);
    expect(r?.invalid).toBe(true);
    expect(r?.infraRetries).toBe(2);
    expect(r?.infraFail).toContain("timed out after 120 s");
  });

  it("a seed failing on tmux stderr every try is invalid, labelled host, not excused", async () => {
    const { c, tries } = fakeCase(() => OWN_TMUX);
    const rows = await run(c, 3);
    // every row retries: stderr never decides, and no case stops being retried
    expect(tries()).toBe(9);
    expect(rows.map((r) => r.invalid)).toEqual([true, true, true]);
    expect(rows.map((r) => r.infraRetries)).toEqual([2, 2, 2]);
    expect(rows.every((r) => r.infraHost === true && r.infraFail?.includes("tmux"))).toBe(true);
  });

  it("a sandbox that always throws is a failed row after 3 tries, never a missing one", async () => {
    box.fail = TMUX_FAIL;
    const { c } = fakeCase(() => null);
    const [r] = await run(c);
    expect(box.made).toBe(3);
    expect(r?.invalid).toBe(true);
    expect(r?.infraRetries).toBe(2);
    expect(r?.infraFail).toContain("tmux new-session failed");
  });
});

describe("infra retry: classification", () => {
  it("reads the row's own record; the host label never decides", () => {
    expect(rowFailure({ why: [`seed invalid: ${EMPTY_128}`] })).toMatchObject({ host: false });
    expect(rowFailure({ why: [`seed invalid: ${GIT_128}`] })).toMatchObject({ host: true });
    expect(rowFailure({ why: [`seed invalid: ${OWN_FAIL}`] })).toMatchObject({ host: false });
    // c2 clean-default: the variant's output broke the seed's own check, no exit code: no retry
    expect(rowFailure({ why: ['seed invalid: seed: no revision in {"ok":true}'] })).toBeNull();
    expect(rowFailure({ why: ["lead-in invalid: worker-1 not registered"] })).toBeNull();
    expect(rowFailure({ why: [], rigError: `rig error: ${TMUX_FAIL}` })).toMatchObject({
      host: true,
    });
  });

  it("a lead-in timeout is a fault unless the step asked to be killed; an exit is not", () => {
    const rec = { cmd: "mu wait w", killed: true, limitMs: 120_000 };
    expect(leadInFault([rec], [false])).toContain("timed out after 120 s");
    expect(leadInFault([rec], [true])).toBeUndefined();
    expect(leadInFault([{ ...rec, killed: false }], [false])).toBeUndefined();
  });
});

describe("infra retry: scoring", () => {
  const setup = { models: { weak: [HAIKU, GEMINI], gate: SONNET }, rho: {}, rhoPool: {} };
  const score = (rows: ProbeRow[]) =>
    scoreRound({
      round: "r1",
      group: "c1_wait",
      rows,
      variants: [{ id: "v1", spec, textDelta: 0 }],
      setup,
      headline: ["h1"],
      headlineAny: ["h1"],
      nameCues: [],
      prompt,
      fast: true,
      fastZ: 1.65,
    })[0];
  const cell = (surface: string, caseId: string, p: number, seed: number) =>
    cellRows({
      surface,
      caseId,
      models: [HAIKU, GEMINI, SONNET],
      p,
      r: 1,
      rand: rng(seed),
      round: "r1",
    });
  const failed: Partial<ProbeRow> = {
    invalid: true,
    hit: false,
    infraFail: `seed invalid: ${OWN_TMUX}`,
    infraHost: true,
    infraRetries: 2,
    leadInExits: [],
    why: [`seed invalid: ${OWN_TMUX}`],
  };
  /** The first `n` rows (90 clusters, one row each) failed every try. */
  const fail = (rows: ProbeRow[], n = 1): ProbeRow[] =>
    rows.map((r, i) => (i < n ? { ...r, ...failed } : r));
  const base = cell(BASE, "h1", 0.3, 1);
  const v = cell("v1", "h1", 0.9, 2);

  it("a variant failing every try on tmux stderr while base ran is OUT (the reviewer's case)", () => {
    expect(score([...base, ...v])?.wins).toBe(1);
    const s = score([...base, ...fail(v)]);
    expect(s?.eliminated).toContain("invalid lead-in");
    expect(s?.infra).toMatchObject({ failedRows: 1, droppedPairings: 0, retries: 2 });
  });

  it("variant and base failing every try on one pairing drop it from both sides", () => {
    const clean = score([...base, ...v]);
    const s = score([...fail(base), ...fail(v)]);
    expect(s?.eliminated).toEqual([]);
    expect(s?.invalidRows).toBe(0);
    expect(s?.wins).toBe(1);
    expect(s?.infra).toMatchObject({
      failedRows: 1,
      droppedPairings: 1,
      droppedClusters: 1,
      clusters: 90,
    });
    expect(s?.infra.dropped).toEqual([`h1|${HAIKU}|a0|p0|1: both failed every try`]);
    const w = s?.win[0];
    expect(w?.variant.n).toBe((clean?.win[0]?.variant.n ?? 0) - 1);
    expect(w?.base.n).toBe((clean?.win[0]?.base.n ?? 0) - 1);
    expect(s && infraLine(s)).toBe(
      "Infra: 2 retries, 0 rows recovered by a retry, 1 rows failed every try (invalid unless base's failed too), 1 pairings dropped from both sides (base's row failed every try) in 1 of 90 clusters",
    );
    // a recovered row is counted, and scored
    const rec = score([...base, ...v.map((r, i) => (i === 0 ? { ...r, infraRetries: 1 } : r))]);
    expect(rec?.infra).toMatchObject({ retries: 1, recovered: 1, failedRows: 0 });
  });

  it("over 10% of the clusters dropped: UNDECIDED, not a win", () => {
    // 9 of 90 is 10%: still decided
    const at9 = score([...fail(base, 9), ...v]);
    expect(at9?.infra.undecided).toBeUndefined();
    expect(at9?.wins).toBe(1);
    const s = score([...fail(base, 10), ...fail(v, 10)]);
    expect(s?.infra.droppedClusters).toBe(10);
    expect(s?.infra.undecided).toContain("10 of 90 clusters");
    expect(s?.wins).toBe(0);
    expect(s?.win.every((w) => !w.win)).toBe(true);
    expect(s && infraLine(s)).toContain("UNDECIDED (no win)");
    const d = decideFast(s ? [s] : []);
    expect(d.winner).toBeNull();
    expect(d.why).toContain("undecided");
    expect(cut("r1", s ? [s] : []).eligible).toEqual([]);
  });

  it("a losing case whose rows fail every try (tmux stderr) no longer hides the loss", () => {
    // the reviewer's exploit: v1 wins h1 and loses h2 (5% vs 95%); its h2 rows carry tmux stderr
    const rows = [...base, ...v, ...cell(BASE, "h2", 0.95, 3)];
    const h2 = cell("v1", "h2", 0.05, 4);
    const honest = score([...rows, ...h2]);
    expect(honest?.eliminated.length).toBeGreaterThan(0);
    const s = score([...rows, ...fail(h2, h2.length)]);
    expect(s?.eliminated).toEqual(expect.arrayContaining(["loss (per-case Holm)"]));
    expect(s?.infra.droppedPairings).toBe(0);
    expect(decideFast(s ? [s] : []).winner).toBeNull();
  });
});

// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
