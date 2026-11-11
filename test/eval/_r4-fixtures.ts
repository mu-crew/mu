// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Shared fixtures of the R4 gate tests (tournament-r4.test.ts, tournament-r4-gate.test.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { ExposureSpec } from "../../tools/eval/exposure.ts";
import type { GoldenTrace } from "../../tools/eval/tournament-build.ts";
import type { ScoredRow } from "../../tools/eval/tournament-r4-score.ts";
import type { Surface } from "../../tools/eval/types.ts";
import { metrics } from "./_r4-fakes.ts";

export const MARK = "the worker's result follows below";
export const SKILL_MARK = "read the result block first";
export const CTX = "wait returned; read the notes";
export const SPEC: ExposureSpec = {
  markers: [MARK, SKILL_MARK],
  contextMarkers: [CTX],
  newNames: ["--text"],
  changedCalls: ["agent close|--if"],
};
export const WEAK = ["claude-haiku-5-5", "gemini-3.8-flash"];
export const GATE = "claude-sonnet-5-5";
export const MODELS = [...WEAK, GATE];
/** Real, non-holdout scenario ids: loadScenario imports them; the injected run never sets them up. */
export const SCEN = ["course_check", "multi_notes", "poll_wave"];

/** A built-looking surface `name` under `tmp/surfaces`: dist stubs and a SKILL.md with `description`. */
export function surfaceDir(tmp: string, name: string, description: string): string {
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

export const surface = (root: string): Surface => ({
  name: root.split(sep).pop() ?? "s",
  root,
  family: "next",
  cli: join(root, "dist", "cli.js"),
  extension: join(root, "dist", "extension", "mu-pi.js"),
  skillDir: join(root, "skills", "mu"),
});

export function row(
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
export function rows(
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

export const fin = (
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

export const trace = (id: string, out: string, exit = 0): GoldenTrace => ({
  id: `r4:${id}`,
  ok: true,
  calls: [{ argv: "agent close w1 --if clean", exit, out }],
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
