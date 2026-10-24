import { describe, expect, it } from "vitest";
import { MetricsCollector } from "../../tools/eval/events.ts";
import {
  deliveries,
  inside,
  isWaitCall,
  lastJson,
  native,
  prodWrong,
  stops,
  waitWindows,
} from "../../tools/eval/lifecycle.ts";
import type { RunMetrics, Sandbox } from "../../tools/eval/types.ts";

function observe(events: unknown[], clock: number[]): RunMetrics {
  let i = 0;
  const c = new MetricsCollector(() => clock[Math.min(i, clock.length - 1)] ?? 0);
  for (const e of events) {
    c.push(e);
    i++;
  }
  return c.result({ wallMs: 0, prods: 0, aborted: null });
}

const start = (id: string, command: string) => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: "bash",
  args: { command },
});
const end = (id: string) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "bash",
  isError: false,
  result: { content: [{ type: "text", text: "ok" }] },
});

describe("lifecycle observer", () => {
  const run = observe(
    [
      { type: "agent_start" },
      start("w", "mu task wait t1 -w eval --first"),
      {
        type: "message_start",
        message: { role: "custom", customType: "mu-delegate", content: "VERDICT: REFUTED claim-1" },
      },
      end("w"),
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Waiting." }] },
      },
      { type: "agent_end" },
      { type: "agent_settled" },
    ],
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  it("records timestamped events and custom deliveries", () => {
    expect(run.events.map((e) => [e.t, e.kind])).toEqual([
      [1, "agent_start"],
      [2, "tool_start"],
      [3, "delegate_msg"],
      [4, "tool_end"],
      [5, "assistant_text"],
      [6, "agent_end"],
      [7, "agent_settled"],
    ]);
    expect(deliveries(run, /claim-1/)).toHaveLength(1);
  });

  it("finds wait windows and what arrived inside them", () => {
    const ws = waitWindows(run);
    expect(ws.map((w) => [w.start, w.end])).toEqual([[2, 4]]);
    expect(inside(3, ws)).toBe(true);
    expect(inside(5, ws)).toBe(false);
  });

  it("a stop is an agent_end before the work was done", () => {
    expect(stops(run, 100)).toHaveLength(1);
    expect(stops(run, 5)).toHaveLength(0);
    // work never finished: the last agent_end is the run's own end, not a stop
    expect(stops(run, Number.POSITIVE_INFINITY)).toHaveLength(0);
  });

  it("recognises wait command words, not quoted prose", () => {
    const c = (command: string) =>
      run.toolCalls[0] && isWaitCall({ ...run.toolCalls[0], args: { command } });
    expect(c("mu wait a b")).toBe(true);
    expect(c("x; mu agent wait w1 --after-runs 2")).toBe(true);
    expect(c("mu task note t 'we will mu wait later'")).toBe(false);
    expect(c("mu task note t waiting")).toBe(false);
  });

  it("native guarantees: note on 3x, wrong on next", () => {
    const sb = (family: string) => ({ env: { EVAL_SURFACE_FAMILY: family } }) as unknown as Sandbox;
    expect(native(sb("3x"), "mid-wait delivery", false, "0/12").wrong).toEqual([]);
    expect(native(sb("3x"), "mid-wait delivery", false, "0/12").notes[0]).toContain("N/A baseline");
    expect(native(sb("next"), "mid-wait delivery", false, "0/12").wrong).toHaveLength(1);
    expect(native(sb("next"), "mid-wait delivery", true, "12/12").wrong).toEqual([]);
  });

  it("prodWrong and lastJson", () => {
    expect(prodWrong({ ...run, prods: 1 })).toHaveLength(1);
    expect(prodWrong(run)).toEqual([]);
    expect(lastJson('noise {bad\n{"a":1,"b":{"c":2}}')).toEqual({ a: 1, b: { c: 2 } });
    expect(lastJson("")).toBeNull();
  });
});
