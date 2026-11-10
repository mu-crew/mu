// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Host-noise rows (tools/eval/infra-retry.ts, f_rig_infra_retry): a seed or sandbox that fails on
// the host is retried, each try under its own claim; still failing on tmux/git stderr the row is
// infra-invalid and scoring drops its cluster from both sides, so the variant is still decided. A
// variant whose own command breaks the seed on every try stays invalid: OUT, as before.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { infraSuspect, leadInFault } from "../../tools/eval/infra-retry.ts";
import type { NextCase, ProbeRow } from "../../tools/eval/nextstep.ts";
import type { Surface } from "../../tools/eval/types.ts";

const box = vi.hoisted(() => ({ made: 0, fail: null as string | null }));
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
  runLeadIn: async () => [],
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
const { scoreRound, BASE } = await import("../../tools/eval/tournament-score.ts");
const { infraLine } = await import("../../tools/eval/tournament-report.ts");
const { cellRows, GEMINI, HAIKU, prompt, rng, SONNET, spec } = await import(
  "./_tournament-rows.ts"
);

const TMUX_FAIL =
  "sandbox: tmux new-session failed (1): error connecting to /tmp/mu-eval-x/sock (Resource temporarily unavailable)";
const GIT_128 =
  "seed failed (128): mu workstream init auth\nfatal: Unable to create '/tmp/x/.git/index.lock': File exists.";
const OWN_FAIL = "seed failed (1): mu workstream init auth\nerror: unknown option '--json'";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-infra-retry-"));
  box.made = 0;
  box.fail = null;
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
  it("a seed that fails with exit 128 once is retried and the row is scored", async () => {
    const { c, tries } = fakeCase((n) => (n === 1 ? GIT_128 : null));
    const [r] = await run(c);
    expect(tries()).toBe(2);
    expect(box.made).toBe(2);
    expect(r?.invalid).toBe(false);
    expect(r?.infra).toBeUndefined();
    expect(r?.infraRetries).toBe(1);
    expect(r?.modelError).toContain("no scripted reply");
  });

  it("a sandbox that always fails on tmux is retried twice, then written infra-invalid", async () => {
    box.fail = TMUX_FAIL;
    const { c } = fakeCase(() => null);
    const [r] = await run(c);
    expect(box.made).toBe(3);
    expect(r?.invalid).toBe(true);
    expect(r?.infraRetries).toBe(2);
    expect(r?.infra).toContain("tmux new-session failed");
  });

  it("a variant whose own command breaks the seed on every try stays invalid, not infra", async () => {
    const { c, tries } = fakeCase(() => OWN_FAIL);
    const rows = await run(c, 3);
    // two rows reproduce it on every try; the third is not retried
    expect(tries()).toBe(3 + 3 + 1);
    expect(rows.map((r) => r.invalid)).toEqual([true, true, true]);
    expect(rows.map((r) => r.infra)).toEqual([undefined, undefined, undefined]);
    expect(rows.map((r) => r.infraRetries)).toEqual([2, 2, undefined]);
  });
});

describe("infra retry: classification", () => {
  it("reads the row's own record", () => {
    // c3: exit 128 with no stderr is suspect but not host-named: still failing it is the variant's
    expect(
      infraSuspect({ why: ["seed invalid: seed failed (128): mu workstream init auth\n"] }),
    ).toMatchObject({ host: false });
    expect(infraSuspect({ why: [`seed invalid: ${GIT_128}`] })).toMatchObject({ host: true });
    expect(infraSuspect({ why: ["seed invalid: seed failed (137): mu agent spawn w\n"] })).toEqual(
      expect.objectContaining({ host: true }),
    );
    // c2 clean-default: the variant's output broke the seed's own check, no exit code: not suspect
    expect(infraSuspect({ why: ['seed invalid: seed: no revision in {"ok":true}'] })).toBeNull();
    expect(infraSuspect({ why: ["lead-in invalid: worker-1 not registered"] })).toBeNull();
    expect(infraSuspect({ why: [], rigError: `rig error: ${TMUX_FAIL}` })).toMatchObject({
      host: true,
    });
  });

  it("a lead-in timeout is a fault unless the step asked to be killed", () => {
    const rec = { cmd: "mu wait w", exit: 137, killed: true, output: "", limitMs: 120_000 };
    expect(leadInFault([rec], [false])).toContain("timed out after 120 s");
    expect(leadInFault([rec], [true])).toBeUndefined();
    const git = { ...rec, killed: false, exit: 128, output: "fatal: not a git repository" };
    expect(leadInFault([git], [false])).toContain("exit 128");
    expect(leadInFault([{ ...git, exit: 1 }], [false])).toBeUndefined();
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
  const r1 = (surface: string, p: number, seed: number) =>
    cellRows({
      surface,
      caseId: "h1",
      models: [HAIKU, GEMINI, SONNET],
      p,
      r: 1,
      rand: rng(seed),
      round: "r1",
    });
  const at = (rows: ProbeRow[], over: Partial<ProbeRow>): ProbeRow[] =>
    rows.map((r, i) => (i === 0 ? { ...r, ...over, hit: false } : r));

  it("an infra-invalid row drops its cluster from both sides; the variant is still decided", () => {
    const base = r1(BASE, 0.3, 1);
    const v = r1("v1", 0.9, 2);
    const clean = score([...base, ...v]);
    expect(clean?.wins).toBe(1);
    const infra = { invalid: true, infra: TMUX_FAIL, infraRetries: 2, leadInExits: [] };
    const s = score([...base, ...at(v, infra)]);
    expect(s?.eliminated).toEqual([]);
    expect(s?.invalidRows).toBe(0);
    expect(s?.wins).toBe(1);
    expect(s?.infra).toEqual({ retries: 2, excludedRows: 1, droppedClusters: 1 });
    // the report and the control file (round_score, decision) carry the counts
    expect(s && infraLine(s)).toBe(
      "Infra: 2 retries, 1 rows infra-invalid (left out), 1 cluster pairings dropped from both sides",
    );
    // both sides lost the pairing: one weak-model row each
    const w = s?.win[0];
    expect(w?.variant.n).toBe((clean?.win[0]?.variant.n ?? 0) - 1);
    expect(w?.base.n).toBe((clean?.win[0]?.base.n ?? 0) - 1);
    // an infra-invalid base row drops the same pairing from the variant
    const b = score([...at(base, infra), ...v]);
    expect(b?.infra).toEqual({ retries: 0, excludedRows: 0, droppedClusters: 1 });
    expect(b?.win[0]?.variant.n).toBe(w?.variant.n);
  });

  it("a row the variant's own command broke on every try eliminates, as today", () => {
    const own = {
      invalid: true,
      infraRetries: 2,
      leadInExits: [],
      why: [`seed invalid: ${OWN_FAIL}`],
    };
    const s = score([...r1(BASE, 0.3, 1), ...at(r1("v1", 0.9, 2), own)]);
    expect(s?.eliminated).toContain("invalid lead-in");
    expect(s?.infra.retries).toBe(2);
    expect(s?.infra.excludedRows).toBe(0);
  });
});

// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
