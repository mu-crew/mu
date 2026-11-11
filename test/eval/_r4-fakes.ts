// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// An injected runOne and its metrics, for the R4, final and C7 gate tests.
import type { RunOne } from "../../tools/eval/commands.ts";
import type { RunMetrics, RunResult, ToolCall, Verdict } from "../../tools/eval/types.ts";

export const tool = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name: "bash",
  args: { command: "x" },
  isError: false,
  output: "",
  exitCode: 0,
  durationMs: 1,
  ...over,
});

export function metrics(toolCalls: ToolCall[] = [], tokens = 1000): RunMetrics {
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

export interface Outcome {
  completed?: boolean;
  toolCalls?: ToolCall[];
  verdict?: Partial<Verdict>;
}
export type Plan = (o: RunOne) => Outcome;

/** An injected runOne: records every call and answers from `plan`. */
export function fakeRun(plan: Plan = () => ({})) {
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
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
