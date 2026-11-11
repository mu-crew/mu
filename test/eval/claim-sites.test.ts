// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Every AUT claim site (tools/eval/claim.ts) holds its claim while the unit runs: a claim spy per
// site. The fake muzzle counts held claims, and createSandbox is replaced by a spy that records
// the claims held when the unit starts its sandbox, then stops the unit. Dropping the claim at any
// site leaves `held` at 0 (or asks muzzle for nothing), so that site's test fails.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROW_SLOTS, type RowKind } from "../../tools/eval/claim.ts";
import type { Surface } from "../../tools/eval/types.ts";
import { type FakeMuzzle, fakeMuzzle, resetFakeMuzzle } from "./_fake-muzzle.ts";

const spy = vi.hoisted(() => ({
  muzzle: null as { held: number } | null,
  sandboxes: [] as { held: number }[],
  designers: [] as { held: number }[],
}));

vi.mock("../../tools/eval/sandbox.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/sandbox.ts")>()),
  REAL_PI: "fake-real-pi",
  createSandbox: async () => {
    spy.sandboxes.push({ held: spy.muzzle?.held ?? 0 });
    throw new Error("spy: sandbox stopped");
  },
}));

// the surface's help and vocabulary without running its CLI
vi.mock("../../tools/eval/cold-help.ts", async (orig) => ({
  ...(await orig<typeof import("../../tools/eval/cold-help.ts")>()),
  surfaceVocab: () => new Set<string>(),
  helpBundle: () => "help",
}));

// `node <cli> --version` (buildId) and the designer's pi, in-process
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: ((cmd: string, args: readonly string[], opts: unknown) =>
      args?.[1] === "--version"
        ? "9.9.9\n"
        : (real.execFileSync as (...a: unknown[]) => unknown)(
            cmd,
            args,
            opts,
          )) as typeof real.execFileSync,
    spawn: ((cmd: string, ...rest: unknown[]) => {
      if (cmd !== "fake-real-pi") return (real.spawn as (...a: unknown[]) => unknown)(cmd, ...rest);
      spy.designers.push({ held: spy.muzzle?.held ?? 0 });
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 0));
      return child as unknown as ChildProcess;
    }) as typeof real.spawn,
  };
});

const { runNext, runNextCheck } = await import("../../tools/eval/nextstep.ts");
const { NEXT_CASES } = await import("../../tools/eval/nextstep-cases.ts");
const { runCold, runColdCheck } = await import("../../tools/eval/cold-guess.ts");
const { INTENTS } = await import("../../tools/eval/cold-intents.ts");
const { runCheck, runMatrix } = await import("../../tools/eval/commands.ts");
const { runDesigner } = await import("../../tools/eval/tournament-design.ts");
const { collectGoldenTraces } = await import("../../tools/eval/tournament-build.ts");
const { main } = await import("../../tools/eval/main.ts");

let tmp: string;
let m: FakeMuzzle;
let saved: Record<string, string | undefined>;

function fakeSurface(): Surface {
  const root = join(tmp, "surface");
  mkdirSync(join(root, "dist", "extension"), { recursive: true });
  mkdirSync(join(root, "skills", "mu"), { recursive: true });
  writeFileSync(join(root, "dist", "cli.js"), "");
  writeFileSync(join(root, "dist", "extension", "mu-pi.js"), "");
  writeFileSync(join(root, "skills", "mu", "SKILL.md"), "---\nname: mu\n---\n");
  writeFileSync(join(root, ".ref"), "abcdef0123\n");
  return {
    name: "s",
    root,
    family: "next",
    cli: join(root, "dist", "cli.js"),
    extension: join(root, "dist", "extension", "mu-pi.js"),
    skillDir: join(root, "skills", "mu"),
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-claim-sites-"));
  // claim mode: a (fake) muzzle and no outer claim, whatever wraps this test run
  saved = { MUZZLE_SLOTS: process.env.MUZZLE_SLOTS, EVAL_MUZZLE_BIN: process.env.EVAL_MUZZLE_BIN };
  const k = "MUZZLE_SLOTS";
  delete process.env[k];
  process.env.EVAL_MUZZLE_BIN = "fake-muzzle";
  m = fakeMuzzle();
  spy.muzzle = m;
  spy.sandboxes = [];
  spy.designers = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetFakeMuzzle();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

/** Every sandbox started under a claim, and every claim was of `kind`'s rule and weight. */
function expectClaimed(kind: RowKind, sandboxes: number): void {
  expect(spy.sandboxes).toHaveLength(sandboxes);
  for (const s of spy.sandboxes) expect(s.held).toBeGreaterThanOrEqual(1);
  expect(m.args.length).toBeGreaterThanOrEqual(sandboxes);
  for (const a of m.args)
    expect(a.slice(0, 5)).toEqual([
      "run",
      "--rule",
      `mu-eval-${kind}`,
      "--slots",
      String(ROW_SLOTS[kind]),
    ]);
  expect(m.held).toBe(0);
}

const c0 = NEXT_CASES[0];
const intent = INTENTS.find((i) => i.families.includes("next"));
if (!c0 || !intent) throw new Error("no nextstep case or next intent");

describe("claim sites: pooled rows", () => {
  it("runNext: each probe row", async () => {
    const surface = fakeSurface();
    const jobs = [1, 2, 3].map((rep) => ({
      round: "check" as const,
      group: "c1_wait" as const,
      surfaceLabel: "base",
      surface,
      model: "evalfaux/golden",
      caseId: c0.id,
      arm: "none" as const,
      paraphrase: c0.paraphrases[0]?.id ?? "",
      rep,
    }));
    const r = await runNext({
      jobs,
      out: join(tmp, "p.jsonl"),
      promptDir: join(tmp, "prompts"),
      concurrency: 2,
      modelConcurrency: 1,
      infraBackoffMs: [0, 0],
    });
    // a sandbox that never comes up is a failed row: each row tries 3 times, each try claimed, then
    // is written failed every try (infra-retry.ts)
    expect(r.written).toBe(3);
    expectClaimed("probe", 9);
  });

  it("runNextCheck: each check row", async () => {
    await expect(
      runNextCheck(fakeSurface(), { cases: [c0], concurrency: 1, log: () => {} }),
    ).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("probe", 1);
  });

  it("runCold: each guess", async () => {
    // an evalfaux model with no scripted reply stops before the sandbox: the claim is still asked
    const rows = await runCold({
      surfaces: [{ label: "base", surface: fakeSurface() }],
      models: ["evalfaux/none"],
      reps: 2,
      intents: [intent.id],
      concurrency: 2,
      out: join(tmp, "cold.jsonl"),
    });
    expect(rows).toHaveLength(2);
    expect(m.args).toHaveLength(2);
    expectClaimed("guess", 0);
  });

  it("runColdCheck: each scripted guess", async () => {
    await expect(runColdCheck(fakeSurface(), [intent.id], 1)).rejects.toThrow(
      "spy: sandbox stopped",
    );
    expectClaimed("guess", 1);
  });

  it("runMatrix: each AUT run", async () => {
    const res = await runMatrix({
      surfaces: [fakeSurface()],
      models: ["evalfaux/aut"],
      scenarios: ["course_check"],
      reps: 2,
      concurrency: 2,
      budgetTokens: 1e9,
      out: join(tmp, "m.jsonl"),
      root: tmp,
    });
    expect(res).toEqual([]);
    expectClaimed("aut", 2);
  });
});

describe("claim sites: single units", () => {
  it("runCheck: each scripted AUT run", async () => {
    await expect(
      runCheck({
        surface: fakeSurface(),
        scenarios: ["course_check"],
        includeUnderscore: false,
        family: "next",
        preflight: false,
        verbose: false,
        root: tmp,
      }),
    ).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("aut", 1);
  });

  it("runCheck --preflight: the ssh shim sandbox", async () => {
    await expect(
      runCheck({
        surface: fakeSurface(),
        scenarios: [],
        includeUnderscore: false,
        family: "next",
        preflight: true,
        verbose: false,
        root: tmp,
      }),
    ).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("probe", 1);
  });

  it("runDesigner: the designer's pi", async () => {
    const pack = join(tmp, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "BRIEF.md"), "brief\n");
    const r = await runDesigner({
      group: "c1_wait",
      model: "m",
      session: "s1",
      pack,
      designersDir: join(tmp, "designers"),
    });
    expect(r.code).toBe(0);
    expect(spy.designers).toEqual([{ held: 1 }]);
    expect(m.args.map((a) => a[2])).toEqual(["mu-eval-design"]);
  });

  it("main run: the one AUT run", async () => {
    const s = fakeSurface();
    await expect(
      main(["run", "course_check", "--surface", `${s.root}:next`, "--model", "evalfaux/aut"]),
    ).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("aut", 1);
  });

  it("main selftest: the selftest's AUT", async () => {
    const s = fakeSurface();
    await expect(main(["selftest", "--surface", s.root])).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("aut", 1);
  });
});

describe("claim sites: tournament build's golden traces", () => {
  it("playCase per nextstep golden", async () => {
    await expect(collectGoldenTraces(fakeSurface(), { cases: [c0], intents: [] })).rejects.toThrow(
      "spy: sandbox stopped",
    );
    expectClaimed("probe", 1);
  });

  it("guessEffect per cold-guess golden", async () => {
    await expect(
      collectGoldenTraces(fakeSurface(), { cases: [], intents: [intent] }),
    ).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("guess", 1);
  });

  it("runOne per R4 golden", async () => {
    await expect(
      collectGoldenTraces(fakeSurface(), { cases: [], intents: [], scenarios: ["course_check"] }),
    ).rejects.toThrow("spy: sandbox stopped");
    expectClaimed("aut", 1);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
