import { describe, expect, it } from "vitest";
import { MetricsCollector } from "../../tools/eval/events.ts";
import {
  deliveries,
  firstDispatch,
  inside,
  isWaitCall,
  lastJson,
  native,
  prodWrong,
  snapshotStates,
  stops,
  stopsWhileWorking,
  waitedClosed,
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
const end = (id: string, text = "ok", isError = false) => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "bash",
  isError,
  result: { content: [{ type: "text", text }] },
});
const agentEnd = { type: "agent_end" };

const agentStart = () => ({ type: "agent_start" });

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
    expect(native(sb("3x"), "mid-wait delivery", false, "0/12").na).toEqual([
      "mid-wait delivery (0/12)",
    ]);
    expect(native(sb("next"), "mid-wait delivery", false, "0/12").na).toEqual([]);
    expect(native(sb("3x"), "mid-wait delivery", true, "12/12").na).toEqual([]);
    expect(native(sb("next"), "mid-wait delivery", false, "0/12").wrong).toHaveLength(1);
    expect(native(sb("next"), "mid-wait delivery", true, "12/12").wrong).toEqual([]);
  });

  it("prodWrong and lastJson", () => {
    expect(prodWrong({ ...run, prods: 1 })).toHaveLength(1);
    expect(prodWrong(run)).toEqual([]);
    expect(lastJson('noise {bad\n{"a":1,"b":{"c":2}}')).toEqual({ a: 1, b: { c: 2 } });
    expect(lastJson("")).toBeNull();
  });

  it("a stop window opens at the first dispatch of ANY kind, not only `agent send`", () => {
    const stopAfter = (dispatch: unknown[]) =>
      stopsWhileWorking(observe([agentStart(), ...dispatch, agentEnd], [1, 2, 3, 4, 5, 6]), 100)
        .length;
    const delegate = [
      {
        type: "tool_execution_start",
        toolCallId: "d",
        toolName: "mu_delegate",
        args: { label: "c1" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "d",
        toolName: "mu_delegate",
        isError: false,
        result: { content: [] },
      },
    ];
    expect(stopAfter(delegate)).toBe(1);
    expect(stopAfter([start("s", "mu agent spawn w1 -w eval --send 'go'"), end("s")])).toBe(1);
    expect(stopAfter([start("s", "mu agent send w1 -w eval go"), end("s")])).toBe(1);
    // no dispatch yet: nothing is running, a stop is not a stop
    expect(stopAfter([start("s", "mu task list -w eval"), end("s")])).toBe(0);
    expect(firstDispatch(observe([start("s", "ls"), end("s")], [1, 2]))).toBeNull();
  });

  it("waitedClosed reads the ref from the wait call's own output", () => {
    const run = observe(
      [
        start("a", "mu task wait mx-fast -w eval --first --json"),
        end("a", '{"all":[{"name":"mx-fast","status":"CLOSED"}]}'),
        start("b", "mu task wait mx-race -w eval --timeout 2"),
        end("b", "Timed out\n  • mx-race (IN_PROGRESS)", true),
        start("c", "sleep 14; echo 'mu task wait gate' mx-slow (CLOSED)"),
        end("c", "gate (CLOSED)"),
      ],
      [1, 2, 3, 4, 5, 6],
    );
    expect(waitedClosed(run, "mx-fast")).toBe(true);
    expect(waitedClosed(run, "mx-fast", 3)).toBe(false);
    expect(waitedClosed(run, "mx-race")).toBe(false);
    expect(waitedClosed(run, "gate")).toBe(false);
    expect(waitedClosed(run, "mx")).toBe(false);
  });

  it("snapshotStates finds task states anywhere in a snapshot", () => {
    const st = snapshotStates({
      interrupted: true,
      tasks: {
        items: [
          { name: "i1", status: "IN_PROGRESS" },
          { name: "i2", status: "CLOSED" },
        ],
      },
    });
    expect([...st]).toEqual([
      ["i1", "IN_PROGRESS"],
      ["i2", "CLOSED"],
    ]);
    expect(snapshotStates({ tasks: "i1 i2" }).size).toBe(0);
  });
});
