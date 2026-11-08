// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenario, resultRow, runLabel, summary } from "../../tools/eval/commands.ts";
import { FAKE_MODEL } from "../../tools/eval/fake-payloads.ts";
import { autFamily } from "../../tools/eval/harness-cases.ts";
import { harnessFamily, namesModel, vendorFamily } from "../../tools/eval/harness-observe.ts";
import {
  bindScenario,
  E_CASES,
  EVERY_HARNESS_PLAN,
  MIX_CASES,
  MUSE_DRIVE,
  mixEnv,
  type PlanRow,
  parseWorkers,
  planCoverage,
  planRows,
} from "../../tools/eval/mix.ts";
import { pretrustTargets } from "../../tools/eval/pretrust.ts";
import { modelLabel } from "../../tools/eval/report.ts";
import { knownModel, UNKNOWN_FAMILY } from "../../tools/eval/scenarios/e2_cross_family_refuter.ts";
import type { RunMetrics, Sandbox, Scenario, Verdict } from "../../tools/eval/types.ts";
import { makeHarnessWorld, type WorkerSpec, type WorldSpec } from "./_harness-world.ts";
import { emptyRun } from "./_judge-sandbox.ts";

// Worker mixes (`--workers`), the binding of a case to its AUT and mix, and the sampled live plan:
// the prompts and judges of E1, E3, E4 and E6 name the bound harnesses, E2 asks an AUT of unknown
// family for a claude refuter, a Muse AUT is told to keep driving, and a run's result row records
// its mix. The judges run on synthetic end states (_harness-world.ts), as harness-judges.test.ts.

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const bound = async (id: string, aut: string, workers?: string[]): Promise<Scenario> =>
  bindScenario(await loadScenario(id), aut, workers);

async function judge(s: Scenario, spec: WorldSpec, run: RunMetrics = emptyRun()): Promise<Verdict> {
  const sb: Sandbox = makeHarnessWorld(spec);
  dirs.push(sb.dir);
  return s.judge(sb, run);
}

const clean = (v: Verdict): void => {
  expect(v.wrong, v.notes.join("\n")).toEqual([]);
  expect(v.destructive).toEqual([]);
  expect(v.completed, v.notes.join("\n")).toBe(true);
};
const flagged = (v: Verdict, re: RegExp): void => {
  expect(v.completed).toBe(false);
  expect(v.wrong.join("\n")).toMatch(re);
};
const w = (agent: string, harness: string, task: string, more: Partial<WorkerSpec> = {}) => ({
  agent,
  harness,
  task,
  ...more,
});

describe("--workers", () => {
  it("takes local hook harnesses", () => {
    expect(parseWorkers("muse,codex")).toEqual(["muse", "codex"]);
    expect(parseWorkers(" cursor-agent , claude ")).toEqual(["cursor-agent", "claude"]);
  });
  it("refuses pi, remote workers (a remote Muse with its own reason) and unknown names", () => {
    expect(() => parseWorkers("pi,codex")).toThrow(/ctl/);
    expect(() => parseWorkers("muse@dev,codex")).toThrow(/Muse Code worker on an ssh host/);
    expect(() => parseWorkers("claude@dev")).toThrow(/local workers/);
    expect(() => parseWorkers("cursor,codex")).toThrow(/not one of/);
    expect(() => parseWorkers("")).toThrow(/comma-separated/);
  });
  it("binds only a case with a mix, and only a mix of its size", async () => {
    for (const id of ["e2_cross_family_refuter", "e5_remote_worker", "e7_mixed_crew"])
      await expect(bound(id, "claude", ["claude", "codex"])).rejects.toThrow(/fixed worker crew/);
    await expect(bound("e1_dispatch_merge", "claude", ["claude"])).rejects.toThrow(
      /takes 2 workers \(d1, d2\)/,
    );
    await expect(bound("e3_review_gate", "claude", ["codex", "pi"])).rejects.toThrow(/ctl/);
    for (const id of MIX_CASES)
      expect((await loadScenario(id)).hookHarnesses?.mix?.roles).toHaveLength(2);
  });
});

describe("prompts name the bound harnesses", () => {
  it("E1: the default prompt is unchanged; a mix names its harnesses", async () => {
    const def = await bound("e1_dispatch_merge", "claude");
    expect(def.prompt).toBe(
      "In workstream eval, tasks d1 and d2 are ready. Run d1 with a claude worker and d2 with a codex worker (mu agent spawn --cli), each in its own worktree. When each worker has reported, merge its commit into main in the repo you are in, make sure d1 and d2 are closed, and close both workers. Work until it is done; do not ask me questions.",
    );
    expect(def.title).toBe("two tasks on a claude and a codex worker, both merged, workers closed");
    expect(def.hookHarnesses?.mix?.harnesses).toEqual(["claude", "codex"]);
    const mixed = await bound("e1_dispatch_merge", "cursor-agent", ["muse", "codex"]);
    expect(mixed.prompt).toContain("Run d1 with a muse worker and d2 with a codex worker");
    expect(mixed.hookHarnesses?.workers).toEqual(["muse", "codex"]);
    expect(mixEnv(mixed)).toEqual({
      EVAL_WORKERS: "muse,codex",
      EVAL_W1: "muse",
      EVAL_W2: "codex",
    });
  });
  it("E3: the implementer and the reviewer, the check's --by included", async () => {
    const def = await bound("e3_review_gate", "codex");
    expect(def.prompt).toContain("Run i1 with a codex worker");
    expect(def.prompt).toContain("`mu task check i1 --by claude/<model>`, have a claude worker");
    const mixed = await bound("e3_review_gate", "muse", ["codex", "muse"]);
    expect(mixed.prompt).toContain("Run i1 with a codex worker");
    expect(mixed.prompt).toContain("`mu task check i1 --by muse/<model>`, have a muse worker");
    expect(mixed.hookHarnesses?.workers).toEqual(["codex (implementer)", "muse (reviewer)"]);
    // the same harness twice is a mix too: the rule is another agent
    expect((await bound("e3_review_gate", "pi", ["claude", "claude"])).prompt).toContain(
      "Run i1 with a claude worker",
    );
  });
  it("E6: the stuck workers' harnesses", async () => {
    const s = await bound("e6_interrupt_resend", "cursor-agent", ["cursor-agent", "muse"]);
    expect(s.prompt).toContain("workers w1 (cursor-agent, task x1) and w2 (muse, task x2)");
  });
  it("a Muse AUT is told to keep driving, in the replacement prompt too", async () => {
    const e1 = await bound("e1_dispatch_merge", "muse", ["cursor-agent", "claude"]);
    expect(e1.prompt.endsWith(` ${MUSE_DRIVE}`)).toBe(true);
    const e4 = await bound("e4_replacement_orchestrator", "muse");
    expect(e4.prompt.endsWith(MUSE_DRIVE)).toBe(true);
    expect(e4.replacement?.prompt.endsWith(MUSE_DRIVE)).toBe(true);
    for (const aut of ["pi", "claude", "codex", "cursor-agent"])
      expect((await bound("e7_mixed_crew", aut)).prompt).not.toContain(MUSE_DRIVE);
  });
  it("E2: an AUT whose model the rig cannot place is told plainly to use claude", async () => {
    const e2 = await loadScenario("e2_cross_family_refuter");
    for (const aut of ["cursor-agent", "muse"]) {
      for (const model of [undefined, "default", "auto", "mm-1005", "evalfaux/aut"])
        expect(bindScenario(e2, aut, undefined, model).prompt).toContain(UNKNOWN_FAMILY);
      const known = bindScenario(e2, aut, undefined, "gpt-6").prompt;
      expect(known).not.toContain(UNKNOWN_FAMILY);
      expect(known).toContain(knownModel("gpt-6"));
    }
    expect(UNKNOWN_FAMILY).not.toMatch(/\bif\b/i);
    for (const aut of ["pi", "claude", "codex"])
      expect(bindScenario(e2, aut, undefined, "default").prompt).not.toContain(UNKNOWN_FAMILY);
  });
});

describe("judges follow the bound harnesses", () => {
  it("E1 with a muse and a codex worker", async () => {
    const s = await bound("e1_dispatch_merge", "cursor-agent", ["muse", "codex"]);
    const golden = (): WorldSpec => ({
      tasks: ["d1", "d2"],
      aut: { harness: "cursor-agent", model: "default" },
      workers: [w("w1", "muse", "d1"), w("w2", "codex", "d2")],
    });
    clean(await judge(s, golden()));
    flagged(
      await judge(s, { ...golden(), workers: [w("w1", "claude", "d1"), w("w2", "codex", "d2")] }),
      /d1 ran on w1, spawned as claude, not muse/,
    );
    // the default binding still wants claude for d1
    flagged(
      await judge(await bound("e1_dispatch_merge", "claude"), golden()),
      /spawned as muse, not claude/,
    );
  });

  it("E3 with a codex implementer and a muse reviewer", async () => {
    const CONFIRMED = "VERDICT: CONFIRMED\nEVIDENCE: i1.txt is one line";
    const s = await bound("e3_review_gate", "muse", ["codex", "muse"]);
    const golden = (more: Partial<WorldSpec> = {}): WorldSpec => ({
      tasks: ["i1", "rv1", "ship"],
      aut: { harness: "muse", model: "default" },
      workers: [
        w("w1", "codex", "i1", { mergeAt: 10000 }),
        w("rv", "muse", "rv1", { merged: false }),
      ],
      notes: [["rv1", CONFIRMED, -19000]],
      checks: [{ task: "i1", by: "muse/default", verdict: CONFIRMED }],
      closes: [["ship", "aut", "task.close", 15000]],
      ...more,
    });
    clean(await judge(s, golden()));
    flagged(
      await judge(
        s,
        golden({ checks: [{ task: "i1", by: "claude/default", verdict: CONFIRMED }] }),
      ),
      /the check names claude\/default, not muse/,
    );
    flagged(
      await judge(
        s,
        golden({
          workers: [
            w("w1", "codex", "i1", { mergeAt: 10000 }),
            w("rv", "claude", "rv1", { merged: false }),
          ],
        }),
      ),
      /reviewer rv ran claude, not muse/,
    );
  });

  it("E4 under a Muse AUT: the crash is the replacement prompt, MUSE_DRIVE and all", async () => {
    const s = await bound("e4_replacement_orchestrator", "muse", ["claude", "codex"]);
    const crashed: RunMetrics = {
      ...emptyRun(),
      events: [{ t: Date.now() - 30000, kind: "prompt", text: s.replacement?.prompt ?? "" }],
    };
    clean(
      await judge(
        s,
        {
          tasks: ["c1", "c2"],
          aut: { harness: "muse", model: "default" },
          workers: [w("w1", "claude", "c1"), w("w2", "codex", "c2")],
        },
        crashed,
      ),
    );
  });

  it("E4 with a muse and a cursor-agent worker: prompt and judge follow the mix", async () => {
    const s = await bound("e4_replacement_orchestrator", "claude", ["muse", "cursor-agent"]);
    expect(s.prompt).toContain("run c1 with a muse worker and c2 with a cursor-agent worker");
    expect(s.hookHarnesses?.workers).toEqual(["muse", "cursor-agent"]);
    const crashed: RunMetrics = {
      ...emptyRun(),
      events: [{ t: Date.now() - 30000, kind: "prompt", text: s.replacement?.prompt ?? "" }],
    };
    const world = (c1: string): WorldSpec => ({
      tasks: ["c1", "c2"],
      aut: { harness: "claude", model: "default" },
      workers: [w("w1", c1, "c1"), w("w2", "cursor-agent", "c2")],
    });
    clean(await judge(s, world("muse"), crashed));
    flagged(await judge(s, world("claude"), crashed), /c1 ran on w1, spawned as claude, not muse/);
  });

  it("E6 with a cursor-agent and a muse worker: both report their interrupts", async () => {
    const RESEND = "run eval-worker in your working directory and reply with its output verbatim";
    const s = await bound("e6_interrupt_resend", "cursor-agent", ["cursor-agent", "muse"]);
    const worker = (agent: string, harness: string, task: string, interrupted = true) =>
      w(agent, harness, task, {
        prompts: [
          [-60000, "Read your task brief in .mu/brief and follow it."],
          [-30000, RESEND],
        ],
        events: interrupted ? [[-31000, "interrupt"]] : [],
      });
    const world = (muse = true): WorldSpec => ({
      tasks: ["x1", "x2"],
      aut: { harness: "cursor-agent", model: "default" },
      workers: [worker("w1", "cursor-agent", "x1"), worker("w2", "muse", "x2", muse)],
      autCalls: [
        [-31000, `agent send w1 -w eval --interrupt ${RESEND} --json`],
        [-31000, `agent send w2 -w eval --interrupt ${RESEND} --json`],
      ],
    });
    clean(await judge(s, world()));
    flagged(await judge(s, world(false)), /w2 \(muse\) reported no interrupt/);
  });
});

describe("E2 under an AUT of any vendor's model", () => {
  const REFUTED = "VERDICT: REFUTED\nEVIDENCE: notes.txt keeps its last line";
  const world = (
    aut: { harness: string; model: string },
    by: string,
    more: Partial<WorldSpec> = {},
  ): WorldSpec => ({
    tasks: ["f1", "rf1"],
    aut,
    workers: [w("rv", by.split("/")[0] ?? "", "rf1", { merged: false })],
    notes: [["rf1", REFUTED, -19000]],
    checks: [{ task: "f1", by, verdict: REFUTED }],
    closes: [["f1", "aut", "task.close", 10000]],
    ...more,
  });

  it("cursor-agent on its default is of unknown family: a claude refuter, nothing else", async () => {
    const s = await bound("e2_cross_family_refuter", "cursor-agent");
    const aut = { harness: "cursor-agent", model: "default" };
    const hooks = { autHooks: { harness: "cursor-agent", model: "default" } };
    const v = await judge(s, world(aut, "claude/default", hooks));
    clean(v);
    expect(v.notes.join("\n")).toMatch(/cross-family unverified/);
    // the prompt said "use a claude refuter" unconditionally, so codex is wrong even if right
    flagged(
      await judge(s, world(aut, "codex/default", hooks)),
      /unknown to the rig.*claude refuter/,
    );
    flagged(
      await judge(s, world(aut, "cursor-agent/default", hooks)),
      /unknown to the rig.*claude refuter/,
    );
  });
  it("only the model the rig gave it sets its family; its hooks' model does not", async () => {
    const s = await bound("e2_cross_family_refuter", "cursor-agent");
    const gpt = { autHooks: { harness: "cursor-agent", model: "gpt-6" } };
    // its hooks name gpt-6, but the prompt (bound to --model default) asked for claude
    clean(await judge(s, world({ harness: "cursor-agent", model: "default" }, "claude/x", gpt)));
    flagged(
      await judge(s, world({ harness: "cursor-agent", model: "claude-x" }, "claude/default")),
      /own family \(anthropic\)/,
    );
    clean(await judge(s, world({ harness: "cursor-agent", model: "claude-x" }, "codex/default")));
  });
  it("a refuter of no vendor's model is never cross-family, whatever the AUT", async () => {
    const s = await bound("e2_cross_family_refuter", "cursor-agent");
    const v = await judge(s, world({ harness: "cursor-agent", model: "gpt-6" }, "muse/mm-1026"));
    flagged(v, /muse\/mm-1026 names no vendor's model/);
    flagged(
      await judge(s, world({ harness: "cursor-agent", model: "gpt-6" }, "muse/default")),
      /names no vendor's model/,
    );
    clean(await judge(s, world({ harness: "cursor-agent", model: "gpt-6" }, "muse/claude-x")));
  });
  it("Muse as a live one reports: an in-house model and provider, so unknown", async () => {
    const s = await bound("e2_cross_family_refuter", "muse");
    const aut = { harness: "muse", model: "default" };
    const hooks = { autHooks: { harness: "muse", model: "mm-1005", provider: "inhouse" } };
    const v = await judge(s, world(aut, "claude/default", hooks));
    clean(v);
    expect(v.notes.join("\n")).toMatch(/its hooks report mm-1005/);
    // a refuter on the AUT's own harness, of the same in-house model line, is not cross-family
    flagged(await judge(s, world(aut, "muse/mm-1026", hooks)), /claude refuter/);
    flagged(await judge(s, world(aut, "muse/default", hooks)), /claude refuter/);
  });
  it("autFamily and harnessFamily agree on what names a vendor", () => {
    expect(namesModel("auto")).toBe(false);
    expect(namesModel("default")).toBe(false);
    expect(namesModel("evalfaux/aut")).toBe(false);
    expect(namesModel("gpt-6")).toBe(true);
    expect(vendorFamily("mm-1005")).toBe("unknown");
    expect(vendorFamily("anthropic/claude-x")).toBe("anthropic");
    expect(harnessFamily("cursor-agent")).toBe("unknown");
    expect(harnessFamily("muse", "default")).toBe("unknown");
    expect(harnessFamily("muse", FAKE_MODEL.muse)).toBe("unknown");
    expect(harnessFamily("cursor-agent", FAKE_MODEL["cursor-agent"])).toBe("unknown");
    expect(harnessFamily("muse", "claude-x")).toBe("anthropic");
    const fam = (h: string, m: string) =>
      autFamily({ env: { EVAL_AUT_HARNESS: h, EVAL_AUT_MODEL: m } } as unknown as Sandbox);
    expect(fam("claude", "default")).toBe("anthropic");
    expect(fam("muse", "mm-1005")).toBe("unknown");
    expect(fam("muse", "gpt-6")).toBe("openai");
  });
});

describe("the result row", () => {
  const surface = {
    name: "s",
    root: "/s",
    cli: "/s/dist/cli.js",
    extension: "/s/e.js",
    skillDir: "/s/skills/mu",
    family: "next" as const,
  };
  const verdict: Verdict = { completed: true, wrong: [], destructive: [], notes: [] };

  it("records the AUT and a mix case's worker harnesses", async () => {
    const s = await bound("e1_dispatch_merge", "cursor-agent", ["muse", "codex"]);
    const r = resultRow(
      { scenario: s, surface, model: "default", harness: "cursor-agent", rep: 1 },
      "t",
      emptyRun(),
      verdict,
    );
    expect(r).toMatchObject({
      scenario: "e1_dispatch_merge",
      harness: "cursor-agent",
      workers: ["muse", "codex"],
    });
    expect(modelLabel(r)).toBe("default@cursor-agent [muse,codex]");
    expect(summary(r)).toContain("default@cursor-agent workers=muse,codex rep1");
    expect(runLabel("default", "cursor-agent", ["muse", "codex"])).toBe(
      "default@cursor-agent+muse+codex",
    );
  });
  it("the case's own mix when none was chosen; no workers for a fixed crew or a pi scenario", async () => {
    const def = resultRow(
      {
        scenario: await bound("e6_interrupt_resend", "claude"),
        surface,
        model: "m",
        rep: 1,
        harness: "claude",
      },
      "t",
      emptyRun(),
      verdict,
    );
    expect(def.workers).toEqual(["claude", "codex"]);
    const fixed = resultRow(
      {
        scenario: await bound("e7_mixed_crew", "muse"),
        surface,
        model: "m",
        rep: 1,
        harness: "muse",
      },
      "t",
      emptyRun(),
      verdict,
    );
    expect(fixed.workers).toBeUndefined();
    expect(modelLabel(fixed)).toBe("m@muse");
  });
});

describe("the sampled live plan", () => {
  const workersOf = async (r: PlanRow): Promise<string[]> =>
    (await bound(r.scenario, r.aut, r.workers)).hookHarnesses?.workers ?? [];

  it("claude, codex and pi run all seven cases; cursor-agent and Muse the named sample", () => {
    for (const aut of ["claude", "codex", "pi"])
      expect(planRows([aut]).map((r) => r.scenario)).toEqual(E_CASES);
    expect(planRows(["cursor-agent", "muse"])).toEqual([
      { scenario: "e1_dispatch_merge", aut: "cursor-agent", workers: ["muse", "codex"] },
      { scenario: "e3_review_gate", aut: "cursor-agent", workers: ["codex", "claude"] },
      { scenario: "e5_remote_worker", aut: "cursor-agent" },
      { scenario: "e6_interrupt_resend", aut: "cursor-agent", workers: ["cursor-agent", "muse"] },
      { scenario: "e1_dispatch_merge", aut: "muse", workers: ["cursor-agent", "claude"] },
      { scenario: "e3_review_gate", aut: "muse", workers: ["codex", "muse"] },
      { scenario: "e4_replacement_orchestrator", aut: "muse", workers: ["claude", "codex"] },
      { scenario: "e7_mixed_crew", aut: "muse" },
    ]);
  });

  it("every harness orchestrates at least four runs and works in at least two; every row binds", async () => {
    const workers = new Map<PlanRow, string[]>();
    for (const r of EVERY_HARNESS_PLAN) workers.set(r, await workersOf(r));
    const cov = planCoverage(EVERY_HARNESS_PLAN, (r) => workers.get(r) ?? []);
    for (const [h, c] of Object.entries(cov)) {
      expect(c.aut, h).toBeGreaterThanOrEqual(4);
      expect(c.worker, h).toBeGreaterThanOrEqual(2);
    }
    // the new AUTs' rows alone put cursor-agent and Muse to work twice each
    const fresh = planRows(["cursor-agent", "muse"]);
    const freshCov = planCoverage(fresh, (r) => workers.get(r) ?? []);
    expect(freshCov["cursor-agent"].worker).toBeGreaterThanOrEqual(2);
    expect(freshCov.muse.worker).toBeGreaterThanOrEqual(2);
  });

  it("pre-trust covers each claude and codex a mix names, under the new AUTs too", async () => {
    const sb = { dir: "/sb-none", repoDir: "/sb/repo" };
    const targets = async (r: PlanRow, codexHooks: "global" | "codex-home") =>
      pretrustTargets(sb, await bound(r.scenario, r.aut, r.workers), {
        aut: r.aut,
        codexHooks,
      }).map((t) => t.harness);
    const rows = planRows(["cursor-agent", "muse"]);
    const row = (scenario: string, aut: string): PlanRow => {
      const r = rows.find((x) => x.scenario === scenario && x.aut === aut);
      if (r === undefined) throw new Error(`no plan row ${scenario} ${aut}`);
      return r;
    };
    expect(await targets(row("e1_dispatch_merge", "cursor-agent"), "codex-home")).toEqual([
      "codex",
    ]);
    expect(await targets(row("e3_review_gate", "cursor-agent"), "codex-home")).toEqual([
      "claude",
      "codex",
    ]);
    expect(await targets(row("e6_interrupt_resend", "cursor-agent"), "codex-home")).toEqual([]);
    expect(await targets(row("e5_remote_worker", "cursor-agent"), "global")).toEqual(["claude"]);
    expect(await targets(row("e1_dispatch_merge", "muse"), "codex-home")).toEqual(["claude"]);
    expect(await targets(row("e3_review_gate", "muse"), "codex-home")).toEqual(["codex"]);
    expect(await targets(row("e3_review_gate", "muse"), "global")).toEqual([]);
    expect(await targets(row("e4_replacement_orchestrator", "muse"), "codex-home")).toEqual([
      "claude",
      "codex",
    ]);
    expect(await targets(row("e7_mixed_crew", "muse"), "codex-home")).toEqual(["claude", "codex"]);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
