// Worker mixes and the sampled live plan of the hook-harness cases (E1-E7, spec "Every harness
// first-class", U24). A case with a `mix` (E1, E3, E4, E6) takes its worker harnesses from the run
// (`--workers h1,h2`); its prompt, title and judge name the bound harnesses (Scenario.bind). The
// others keep their fixed crew (E2's refuter follows the AUT's model family, E5 is claude on dev,
// E7 a fixed mixed crew) and run under every AUT.
//
// The plan is which (AUT, case, mix) runs live: claude, codex and pi run all seven with each case's
// own mix; cursor-agent and Muse Code run four cases each with mixes chosen so that every harness
// orchestrates at least four runs and works in at least two, without the full cross product.
// `check --plan` proves exactly those rows at zero cost; docs/eval/every-harness.md lists their
// live commands.
import { AUT_HARNESSES, type AutHarness } from "./harness.ts";
import type { Scenario } from "./types.ts";

/** The harnesses `--workers` may name: the four hook harnesses (a mix case's judges read hooks; pi workers are E7's). */
export const MIX_HARNESSES = ["claude", "codex", "cursor-agent", "muse"] as const;
export type MixHarness = (typeof MIX_HARNESSES)[number];

/** `--workers h1,h2,...`: local hook harnesses, each named once per role. */
export function parseWorkers(v: string): string[] {
  const out = v
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (out.length === 0) throw new Error("--workers needs a comma-separated list of harnesses");
  for (const w of out) {
    const at = w.indexOf("@");
    if (at >= 0) {
      if (w.slice(0, at) === "muse")
        throw new Error(
          `--workers ${w}: a Muse Code worker on an ssh host is not supported (Muse clears its hooks' environment, so its hook entries name this machine's murmur state)`,
        );
      throw new Error(
        `--workers ${w}: --workers names local workers; remote workers are E5's and E7's fixed crews`,
      );
    }
    if (w === "pi")
      throw new Error(
        "--workers pi: a mix case's judges read the workers' hooks, and a pi worker reports through ctl (pi workers are E7's)",
      );
    if (!(MIX_HARNESSES as readonly string[]).includes(w))
      throw new Error(`--workers: ${JSON.stringify(w)} is not one of ${MIX_HARNESSES.join(", ")}`);
  }
  return out;
}

/**
 * One sentence a Muse Code AUT's prompts end with. Muse gets no mu Stop hook (D7: a Stop block
 * re-checks its answer without following the reason), so nothing resumes it between turns; it must
 * keep driving within its turn, as the skill's rule says.
 */
export const MUSE_DRIVE =
  "Nothing wakes you between turns: after you dispatch work, keep waiting for it with mu wait in this turn (run it again when it times out), and end your turn only when everything is done.";

/** The ids of the cases that take a mix, for a refusal's message. */
export const MIX_CASES = [
  "e1_dispatch_merge",
  "e3_review_gate",
  "e4_replacement_orchestrator",
  "e6_interrupt_resend",
];

/**
 * `scenario` for one run: bound to its AUT (and the model the rig gives it, when known) and, when
 * given, the worker mix (validated against the case's roles), and with a Muse AUT's prompts ending
 * in MUSE_DRIVE. Throws for `--workers` on a case with a fixed crew.
 */
export function bindScenario(
  scenario: Scenario,
  aut: string,
  workers?: readonly string[],
  model?: string,
): Scenario {
  const mix = scenario.hookHarnesses?.mix;
  if (workers !== undefined) {
    if (mix === undefined || scenario.bind === undefined)
      throw new Error(
        `${scenario.id} has a fixed worker crew; --workers applies to ${MIX_CASES.join(", ")}`,
      );
    if (workers.length !== mix.roles.length)
      throw new Error(
        `${scenario.id} takes ${mix.roles.length} workers (${mix.roles.join(", ")}), got ${workers.length}: ${workers.join(",")}`,
      );
    parseWorkers(workers.join(","));
  }
  const bound =
    scenario.bind === undefined
      ? scenario
      : scenario.bind({
          aut,
          ...(model !== undefined ? { model } : {}),
          ...(workers !== undefined ? { workers } : {}),
        });
  if (aut !== "muse") return bound;
  return {
    ...bound,
    prompt: `${bound.prompt} ${MUSE_DRIVE}`,
    ...(bound.replacement !== undefined
      ? {
          replacement: {
            ...bound.replacement,
            prompt: `${bound.replacement.prompt} ${MUSE_DRIVE}`,
          },
        }
      : {}),
  };
}

/** The env a bound case's scripts read: `EVAL_WORKERS=a,b` and `EVAL_W1`, `EVAL_W2`, ... per role. */
export function mixEnv(scenario: Scenario): Record<string, string> {
  const hs = scenario.hookHarnesses?.mix?.harnesses;
  if (hs === undefined) return {};
  const env: Record<string, string> = { EVAL_WORKERS: hs.join(",") };
  hs.forEach((h, i) => {
    env[`EVAL_W${i + 1}`] = h;
  });
  return env;
}

/** One live run of the plan: a case under an AUT, with a worker mix where the case takes one. */
export interface PlanRow {
  scenario: string;
  aut: AutHarness;
  /** The mix (`--workers`); absent: the case's own crew. */
  workers?: string[];
}

export const E_CASES = [
  "e1_dispatch_merge",
  "e2_cross_family_refuter",
  "e3_review_gate",
  "e4_replacement_orchestrator",
  "e5_remote_worker",
  "e6_interrupt_resend",
  "e7_mixed_crew",
];

/**
 * The every-harness live plan: claude, codex and pi run E1-E7 as written; cursor-agent and Muse
 * Code run a sample, each case with a mix that puts the harnesses no default mix uses (cursor-agent,
 * Muse) to work under another orchestrator.
 */
export const EVERY_HARNESS_PLAN: PlanRow[] = [
  ...(["claude", "codex", "pi"] as const).flatMap((aut) =>
    E_CASES.map((scenario) => ({ scenario, aut })),
  ),
  { scenario: "e1_dispatch_merge", aut: "cursor-agent", workers: ["muse", "codex"] },
  { scenario: "e3_review_gate", aut: "cursor-agent", workers: ["codex", "claude"] },
  { scenario: "e5_remote_worker", aut: "cursor-agent" },
  { scenario: "e6_interrupt_resend", aut: "cursor-agent", workers: ["cursor-agent", "muse"] },
  { scenario: "e1_dispatch_merge", aut: "muse", workers: ["cursor-agent", "claude"] },
  { scenario: "e3_review_gate", aut: "muse", workers: ["codex", "muse"] },
  { scenario: "e4_replacement_orchestrator", aut: "muse", workers: ["claude", "codex"] },
  { scenario: "e7_mixed_crew", aut: "muse" },
];

/** The plan's rows for these AUTs (all when none are named). */
export function planRows(only?: readonly string[]): PlanRow[] {
  return EVERY_HARNESS_PLAN.filter((r) => only === undefined || only.includes(r.aut));
}

/**
 * How often each harness orchestrates and works across `rows`, a worker counted once per run it
 * works in (the bound case's mix, else the base harness of each fixed-crew entry: `pi@dev` is pi).
 * `workersOf` gives a row's workers; mix.test.ts feeds it the bound scenarios.
 */
export function planCoverage(
  rows: PlanRow[],
  workersOf: (r: PlanRow) => string[],
): Record<AutHarness, { aut: number; worker: number }> {
  const out = Object.fromEntries(AUT_HARNESSES.map((h) => [h, { aut: 0, worker: 0 }])) as Record<
    AutHarness,
    { aut: number; worker: number }
  >;
  for (const r of rows) {
    out[r.aut].aut++;
    const seen = new Set(
      workersOf(r).flatMap((w) => AUT_HARNESSES.filter((h) => new RegExp(`^${h}\\b`).test(w))),
    );
    for (const h of seen) out[h].worker++;
  }
  return out;
}
