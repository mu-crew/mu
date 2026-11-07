import { describe, expect, it } from "vitest";
import { isMuCall, MetricsCollector, splitLf } from "../../tools/eval/events.ts";

const usage = (total: number, cost: number) => ({
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const assistant = (extra: Record<string, unknown>) => ({ role: "assistant", ...extra });

const EVENTS: unknown[] = [
  { type: "response", command: "prompt", success: true },
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "message_end",
    message: assistant({ content: [{ type: "text", text: "plan" }], usage: usage(18, 0.5) }),
  },
  {
    type: "tool_execution_start",
    toolCallId: "a",
    toolName: "bash",
    args: { command: "mu task list -w x" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "a",
    toolName: "bash",
    isError: true,
    durationMs: 12,
    result: { content: [{ type: "text", text: "boom\n\nCommand exited with code 3" }] },
  },
  { type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "ls -la" } },
  {
    type: "tool_execution_end",
    toolCallId: "b",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "files" }] },
  },
  { type: "tool_execution_start", toolCallId: "c", toolName: "mu_delegate", args: { prompt: "p" } },
  {
    type: "tool_execution_end",
    toolCallId: "c",
    toolName: "mu_delegate",
    isError: false,
    result: { content: [{ type: "text", text: "ok" }] },
  },
  { type: "turn_end" },
  { type: "turn_end" },
  {
    type: "message_end",
    message: assistant({
      content: [],
      usage: usage(7, 0.25),
      stopReason: "error",
      errorMessage: "529 overloaded_error",
    }),
  },
  {
    type: "message_end",
    message: assistant({ content: [{ type: "text", text: "all done" }], usage: usage(4, 0) }),
  },
  { type: "message_end", message: { role: "user", content: "ignored", usage: usage(999, 9) } },
  { type: "turn_end" },
  { type: "agent_settled", aborted: false },
];

describe("MetricsCollector", () => {
  it("derives every RunMetrics field from the event stream", () => {
    let t = 1000;
    const c = new MetricsCollector(() => t);
    for (const e of EVENTS) {
      t += 10;
      c.push(e);
    }
    const r = c.result({ wallMs: 77, prods: 1, aborted: null });
    expect(r.usage).toEqual({
      input: 30,
      output: 15,
      cacheRead: 6,
      cacheWrite: 3,
      total: 29,
      cost: 0.75,
    });
    expect(r.turns).toBe(3);
    expect(r.toolCalls.map((x) => x.name)).toEqual(["bash", "bash", "mu_delegate"]);
    expect(r.toolCalls[0]).toMatchObject({ id: "a", isError: true, exitCode: 3, durationMs: 12 });
    expect(r.toolCalls[1]).toMatchObject({ isError: false, exitCode: 0, durationMs: null });
    expect(r.toolCalls[2]?.exitCode).toBeNull();
    expect(r.muCalls).toBe(2);
    expect(r.muErrors).toBe(1);
    expect(r.prods).toBe(1);
    expect(r.wallMs).toBe(77);
    expect(r.aborted).toBeNull();
    expect(r.lastError).toBe("529 overloaded_error");
    expect(r.finalText).toBe("all done");
    expect(c.isSettled()).toBe(true);
  });

  it("tracks settled state and activity; responses do not count as activity", () => {
    let t = 0;
    const c = new MetricsCollector(() => t);
    t = 5;
    c.push({ type: "response" });
    expect(c.lastActivity()).toBe(0);
    c.push({ type: "agent_settled" });
    expect(c.isSettled()).toBe(true);
    t = 9;
    c.push({ type: "agent_start" });
    expect(c.isSettled()).toBe(false);
    expect(c.lastActivity()).toBe(9);
    c.push("junk");
    c.push(null);
    expect(c.lastActivity()).toBe(9);
  });
});

describe("MetricsCollector turn and idx", () => {
  const tc = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
  const start = (id: string) => ({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "bash",
    args: { command: "ls" },
  });
  const end = (id: string) => ({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "bash",
    isError: false,
    result: { content: [] },
  });
  it("places each call at its assistant message (every assistant message counts) and its block position", () => {
    const c = new MetricsCollector(() => 1);
    for (const e of [
      {
        type: "message_end",
        message: assistant({ content: [{ type: "text", text: "thinking" }] }),
      },
      {
        type: "message_end",
        message: assistant({ content: [{ type: "text", text: "go" }, tc("p"), tc("q")] }),
      },
      // pi may run them in any order; the place comes from the block, not the start order
      start("q"),
      start("p"),
      end("p"),
      end("q"),
      { type: "message_end", message: { role: "user", content: "x" } },
      { type: "message_end", message: assistant({ content: [tc("r")] }) },
      start("r"),
      end("r"),
    ])
      c.push(e);
    const r = c.result({ wallMs: 0, prods: 0, aborted: null });
    const at = Object.fromEntries(r.toolCalls.map((x) => [x.id, [x.turn, x.idx]]));
    expect(at).toEqual({ q: [1, 1], p: [1, 0], r: [2, 0] });
  });
  it("a call no block names takes the next place in the latest message; none before any message", () => {
    const c = new MetricsCollector(() => 1);
    c.push(start("early"));
    c.push({ type: "message_end", message: assistant({ content: [tc("a")] }) });
    c.push(start("a"));
    c.push(start("ghost"));
    const r = c.result({ wallMs: 0, prods: 0, aborted: null });
    expect(r.toolCalls[0]).not.toHaveProperty("turn");
    expect(r.toolCalls.slice(1).map((x) => [x.turn, x.idx])).toEqual([
      [0, 0],
      [0, 1],
    ]);
  });
});

describe("isMuCall", () => {
  it("matches mu in command position and mu_delegate only", () => {
    expect(isMuCall("bash", { command: "mu task list" })).toBe(true);
    expect(isMuCall("bash", { command: "cd x && mu agent list" })).toBe(true);
    expect(isMuCall("bash", { command: "echo $(mu state)" })).toBe(true);
    expect(isMuCall("bash", { command: "npm run emu test" })).toBe(false);
    expect(isMuCall("bash", { command: "ls" })).toBe(false);
    expect(isMuCall("mu_delegate", {})).toBe(true);
    expect(isMuCall("read", { command: "mu x" })).toBe(false);
  });
});

describe("splitLf", () => {
  it("splits only on LF and keeps U+2028 inside a line", () => {
    const { lines, rest } = splitLf('{"a":"x\u2028y"}\r\n{"b":1}\n{"c"');
    expect(lines).toEqual(['{"a":"x\u2028y"}', '{"b":1}']);
    expect(rest).toBe('{"c"');
  });
});
