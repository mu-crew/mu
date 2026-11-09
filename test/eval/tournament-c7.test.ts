// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// C7, the combined gate (spec §4.7): every group's winner on one surface, R4, holdouts once, and
// the bisection of a regression on the R4 scenarios only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExposureSpec } from "../../tools/eval/exposure.ts";
import type { Group } from "../../tools/eval/nextstep.ts";
import { controlFile, readControl, type SetupRow } from "../../tools/eval/tournament.ts";
import { HOLDOUTS, type VariantRow } from "../../tools/eval/tournament-build.ts";
import { bisectWinners, c7Dir, runCombined, setLabel } from "../../tools/eval/tournament-c7.ts";
import { type ScoredRow, scoreR4 } from "../../tools/eval/tournament-r4-score.ts";
import type { Surface } from "../../tools/eval/types.ts";
import { fakeRun, metrics, tool } from "./_r4-fakes.ts";

const WEAK = ["claude-haiku-5-5", "gemini-3.8-flash"];
const GATE = "claude-sonnet-5-5";
const MODELS = [...WEAK, GATE];
const SCEN = ["course_check", "multi_notes", "poll_wave"];
const MARK = "the worker's result follows below";
const SPEC: ExposureSpec = { markers: [MARK], contextMarkers: [], newNames: [], changedCalls: [] };

// ---- bisection on synthetic R4 rows -------------------------------------------------------------

/** R4 rows of a set: completion 0.8, or 0.4 on every model when `bad(set)`. Base at 0.8. */
function setRows(label: string, bad: boolean): ScoredRow[] {
  const out: ScoredRow[] = [];
  for (const model of MODELS)
    for (let k = 0; k < 48; k++)
      out.push({
        scenario: "course_check",
        model,
        rep: 201 + k,
        metrics: metrics(),
        verdict: {
          completed: k % 10 < (bad ? 4 : 8),
          wrong: [],
          destructive: [],
        },
        variant: label,
        exposure: [],
        destructiveFx: [],
      });
  return out;
}
const base = setRows("base", false);
const regressesWith = (bad: (set: string[]) => boolean) => async (set: string[]) => {
  const label = setLabel(set);
  const [f] = scoreR4({
    rows: [...base, ...setRows(label, bad(set))],
    finalists: [
      { id: label, scenarios: ["course_check"], reps: 48, wins: 1, winZ: 0, textDelta: 0 },
    ],
    models: MODELS,
    weak: WEAK,
    repFloor: 201,
  }).finalists;
  return f?.models.some((m) => m.loss) ?? false;
};

describe("bisectWinners", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];

  it("finds the one winner whose patch regresses R4, wherever it sits", async () => {
    for (const culprit of ids) {
      const b = await bisectWinners(
        ids,
        regressesWith((s) => s.includes(culprit)),
      );
      expect(b.culprit).toBe(culprit);
      expect(b.interaction).toBeNull();
      // ⌈log2 6⌉ halvings, at most two checks each
      expect(b.tested.length).toBeLessThanOrEqual(6);
    }
  });

  it("reports an interaction when no half regresses alone", async () => {
    const b = await bisectWinners(
      ids,
      regressesWith((s) => s.includes("a") && s.includes("f")),
    );
    expect(b.culprit).toBeNull();
    expect(b.interaction).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });
});

// ---- runCombined --------------------------------------------------------------------------------

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mu-c7-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function surfaceRoot(name: string): string {
  const root = join(tmp, "surfaces", name);
  mkdirSync(join(root, "skills", "mu"), { recursive: true });
  mkdirSync(join(root, "dist", "extension"), { recursive: true });
  writeFileSync(join(root, "dist", "cli.js"), "");
  writeFileSync(join(root, "dist", "extension", "mu-pi.js"), "");
  writeFileSync(join(root, "skills", "mu", "SKILL.md"), "---\nname: mu\ndescription: d\n---\n");
  return root;
}

const setupRow = (baseDir: string, group: Group): SetupRow => ({
  kind: "setup",
  group,
  baseSha: "abc123",
  baseDir,
  b0: { models: MODELS, providerExt: null, rows: MODELS.map((model) => ({ model, ok: true })) },
  models: { weak: WEAK, gate: GATE },
  providerExt: null,
  systemSha: "sys",
  rho: {},
  rhoPool: {},
  seed: "seed",
  holdouts: { ids: [...HOLDOUTS], note: "not run, not read" },
});

/** Three fast-mode groups with one winner each (v1, v2, v3), plus one where base stays. */
function world(): { root: string; repo: string; baseDir: string } {
  const root = join(tmp, "rows");
  const repo = join(tmp, "repo");
  const baseDir = surfaceRoot("base");
  const groups: [Group, string | null][] = [
    ["c1_wait", "v1"],
    ["c2_close", "v2"],
    ["c3_notes", null],
    ["c4_read", "v3"],
  ];
  for (const [group, id] of groups) {
    const dir = join(root, group);
    mkdirSync(dir, { recursive: true });
    const rows: unknown[] = [
      setupRow(baseDir, group),
      { kind: "freeze", judgesHash: "h", files: [], mode: "fast", nPlan: [], checks: "skipped" },
    ];
    if (id) {
      const patch = `diff --git a/src/${id}.ts b/src/${id}.ts\n`;
      const cand = join(repo, "tools", "eval", "candidates", group, "opus");
      mkdirSync(cand, { recursive: true });
      writeFileSync(join(cand, `${id}.json`), JSON.stringify({ id }));
      writeFileSync(join(cand, `${id}.patch`), patch);
      const v: VariantRow = {
        kind: "variant",
        id,
        session: "opus",
        manifest: { id, group, kind: ["output"], summary: id },
        patchSha: createHash("sha256").update(patch).digest("hex"),
        ref: "r",
        dir: surfaceRoot(id),
        spec: SPEC,
        rejectedContext: [],
        textDelta: 1,
        admission: { ok: true, failures: [] },
        goldenCompat: { broken: [] },
      };
      rows.push(v);
    }
    rows.push({
      kind: "decision",
      mode: "fast",
      epoch: 0,
      winner: id,
      why: "w",
      scores: id ? [{ id, winZ: id === "v3" ? 1.8 : 2.5 }] : [],
    });
    writeFileSync(controlFile(dir), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
  return { root, repo, baseDir };
}

/** A fake build: one surface dir per set, remembering which winners it holds. */
function fakeBuild() {
  const sets = new Map<string, string[]>();
  const builds: string[] = [];
  const build = (_b: string, _s: string, label: string, patches: readonly string[]) => {
    const dir = surfaceRoot(label.replace(/[^a-z0-9]+/gi, "-"));
    sets.set(
      dir,
      patches.map((p) => p.split("/").pop()?.replace(".patch", "") ?? ""),
    );
    builds.push(label);
    return { dir, built: { ok: true } };
  };
  return { build, sets, builds };
}

/** Variant goldens print the marker on two scenarios: no live scan step for an output variant. */
const traces = async (s: Surface, scenarios: readonly string[]) =>
  scenarios.map((id) => ({
    id: `r4:${id}`,
    ok: true,
    calls: [
      { argv: "mu wait", exit: 0, out: /v\d$/.test(s.root) && id !== "poll_wave" ? MARK : "x" },
    ],
  }));

const exposed = { toolCalls: [tool("t0", { output: MARK, turn: 0, idx: 0 })] };

describe("runCombined (tournament final --combined)", () => {
  it("combines every group's winner, runs R4 on their scenarios, then the holdouts once", async () => {
    const { root, repo } = world();
    const b = fakeBuild();
    const f = fakeRun((o) => (b.sets.has(o.surface.root) ? exposed : {}));
    const code = await runCombined({
      repo,
      root,
      groups: ["c1_wait", "c2_close", "c3_notes", "c4_read"],
      args: ["--scenarios", SCEN.join(",")],
      deps: {
        build: b.build,
        hash: () => "h",
        traces,
        run: f.run,
        paths: () => [],
        ping: () => {},
      },
    });
    expect(code).toBe(0);
    expect(b.builds).toEqual([setLabel(["v1", "v2", "v3"])]);
    const r4 = f.calls.filter((c) => !HOLDOUTS.includes(c.scenario.id));
    // 2 scenarios → 24 reps × 3 models × (combined + base)
    expect(r4).toHaveLength(2 * 24 * 3 * 2);
    expect(new Set(r4.map((c) => c.model))).toEqual(new Set(MODELS));
    const hold = f.calls.filter((c) => HOLDOUTS.includes(c.scenario.id));
    expect(hold).toHaveLength(HOLDOUTS.length * 2 * 3 * 12);
    const rows = readControl(c7Dir(root));
    expect(rows.find((r) => r.kind === "final_score")).toMatchObject({ stop: false });
    expect(rows.find((r) => r.kind === "c7_r4")).toMatchObject({ regressed: false });
  });

  it("on an R4 regression bisects the winners on R4 scenarios only, never the holdouts, and names the one to drop", async () => {
    const { root, repo } = world();
    const b = fakeBuild();
    const f = fakeRun((o) => {
      const set = b.sets.get(o.surface.root);
      const bad = set?.includes("v2") && o.model === GATE && o.rep % 2 === 0;
      return { ...(set ? exposed : {}), completed: !bad };
    });
    const pings: string[] = [];
    const code = await runCombined({
      repo,
      root,
      groups: ["c1_wait", "c2_close", "c3_notes", "c4_read"],
      args: ["--scenarios", SCEN.join(",")],
      deps: {
        build: b.build,
        hash: () => "h",
        traces,
        run: f.run,
        paths: () => [],
        ping: (m) => pings.push(m),
      },
    });
    expect(code).toBe(1);
    expect(f.calls.some((c) => HOLDOUTS.includes(c.scenario.id))).toBe(false);
    expect(existsSync(join(c7Dir(root), "sealed"))).toBe(false);
    expect(b.builds).toEqual([
      setLabel(["v1", "v2", "v3"]),
      setLabel(["v1", "v2"]),
      setLabel(["v1"]),
      setLabel(["v2"]),
    ]);
    const d = readControl(c7Dir(root)).find(
      (r) => r.kind === "decision" && (r as { regression?: boolean }).regression,
    );
    expect(d).toMatchObject({ drop: "v2", winner: null });
    expect(pings).toEqual(["C7 regression: drop v2"]);
    // base rows ran once, with the full set: the subsets add only their own runs
    expect(f.calls.filter((c) => !b.sets.has(c.surface.root))).toHaveLength(2 * 24 * 3);

    // re-run without the culprit: R4 passes, and the holdouts run once
    const again = await runCombined({
      repo,
      root,
      groups: ["c1_wait", "c2_close", "c3_notes", "c4_read"],
      args: ["--scenarios", SCEN.join(","), "--drop", "v2"],
      deps: {
        build: b.build,
        hash: () => "h",
        traces,
        run: f.run,
        paths: () => [],
        ping: () => {},
      },
    });
    expect(again).toBe(0);
    expect(f.calls.filter((c) => HOLDOUTS.includes(c.scenario.id))).toHaveLength(
      HOLDOUTS.length * 2 * 3 * 12,
    );
  });

  it("refuses changed judges in any group", async () => {
    const { root, repo } = world();
    await expect(
      runCombined({
        repo,
        root,
        groups: ["c1_wait"],
        args: [],
        deps: { hash: () => "other" },
      }),
    ).rejects.toThrow(/judges changed/);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
