import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuResult } from "../extension/delegate.js";
import {
  dispatchedTasks,
  type MuNudgeCtx,
  NUDGE_LOG_KIND,
  REFUTE_NUDGE_MESSAGE_TYPE,
  registerRefuteNudge,
} from "../extension/nudge.js";

type Handler = (event: unknown, ctx: MuNudgeCtx) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
  };
  const emit = async (event: string, extra: Record<string, unknown> = {}) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...extra }, {});
    return last;
  };
  return { pi, emit, handlers };
}

const bash = (command: string) => ({ toolName: "bash", toolCallId: "t1", input: { command } });
const notes = (...contents: string[]): MuResult => ({
  code: 0,
  stdout: JSON.stringify({ items: contents.map((content) => ({ author: "x", content })) }),
  stderr: "",
});
const BRIEF = "GOAL: do it\nDONE WHEN: tests pass";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MU_NUDGE;
  delete process.env.MU_NUDGE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MU_NUDGE;
  else process.env.MU_NUDGE = saved;
});

/** `byTask` maps "<ws>/<id>" to that task's `mu task notes --json`. */
function setup(byTask: Record<string, MuResult>) {
  const f = fakePi();
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "task" && args[1] === "notes") {
      const w = args.indexOf("-w");
      const ws = w >= 0 ? args[w + 1] : "";
      return byTask[`${ws}/${args[2]}`] ?? { code: 3, stdout: "", stderr: "no such task" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  registerRefuteNudge(f.pi, run);
  return { ...f, run };
}

type Settle = {
  entries: { type: string; customType: string; content: string; display: boolean }[];
  continue?: boolean;
};

describe("dispatchedTasks", () => {
  it.each([
    ["mu task claim build -w auth --for worker-1", [{ ws: "auth", id: "build" }]],
    ["mu task claim auth/build --for worker-1", [{ ws: "auth", id: "build" }]],
    ["mu task claim --for worker-1 -w auth build", [{ ws: "auth", id: "build" }]],
    ["mu task claim -f auth/worker-1 build --workstream=auth", [{ ws: "auth", id: "build" }]],
    [
      "mu task claim --evidence 'brief refuted ok' --for w1 build -w auth",
      [{ ws: "auth", id: "build" }],
    ],
    ["mu task claim build --for w1", [{ ws: "", id: "build" }]],
    [
      "mu task claim a -w x --for w1 && mu agent send w1 -w x 'go' && mu task claim b -w y --for w2",
      [
        { ws: "x", id: "a" },
        { ws: "y", id: "b" },
      ],
    ],
    // Separators inside quotes are part of the word, before and after --for.
    [
      "mu task claim --evidence 'brief | refuted' --for w1 build -w auth",
      [{ ws: "auth", id: "build" }],
    ],
    [
      'mu task claim --evidence "brief && refuted" --for w1 build -w auth',
      [{ ws: "auth", id: "build" }],
    ],
    [
      "mu task claim --evidence 'brief; refuted' --for w1 build -w auth",
      [{ ws: "auth", id: "build" }],
    ],
    ["mu task claim build --for w1 --evidence 'a || b; c' -w auth", [{ ws: "auth", id: "build" }]],
    [
      "mu task claim a --for w1 --evidence 'x; y' -w p; mu task claim b --for w2 -w q | cat",
      [
        { ws: "p", id: "a" },
        { ws: "q", id: "b" },
      ],
    ],
  ])("%s", (cmd, want) => {
    expect(dispatchedTasks(cmd)).toEqual(want);
  });

  it.each([
    "mu task claim build -w auth --self",
    "mu agent send worker-1 -w auth --fresh 'x'",
    "mu task claim build -w scratch --for helper",
    "echo mu task claim build --for w1",
    "echo 'x; mu task claim build --for w1 -w auth'",
  ])("not a task dispatch: %s", (cmd) => {
    expect(dispatchedTasks(cmd)).toEqual([]);
  });
});

describe("registerRefuteNudge", () => {
  it("(a) dispatching an unrefuted task: one visible message, no continue", async () => {
    const { emit, run } = setup({ "auth/build": notes(BRIEF) });
    await emit("tool_call", bash("mu task claim build -w auth --for worker-1"));
    const r = (await emit("agent_before_settle", { outcome: "completed" })) as Settle;
    expect(r.continue).toBeUndefined();
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      type: "custom_message",
      customType: REFUTE_NUDGE_MESSAGE_TYPE,
      display: true,
    });
    expect(r.entries[0]?.content).toContain("auth/build");
    expect(r.entries[0]?.content).toContain("REFUTE-EXEMPT: <why>");
    expect(run.mock.calls[0]?.[0]).toEqual(["task", "notes", "build", "-w", "auth", "--json"]);
    const log = run.mock.calls.find((c) => c[0][0] === "log")?.[0];
    expect(log).toEqual(["log", "-w", "auth", "--kind", NUDGE_LOG_KIND, "refute: auth/build"]);
  });

  it("lists every unrefuted task in one message", async () => {
    const { emit } = setup({
      "x/a": notes(BRIEF),
      "y/b": notes(BRIEF),
      "y/c": notes("REFUTE-EXEMPT: rename"),
    });
    await emit("tool_call", bash("mu task claim a -w x --for w1 && mu task claim b -w y --for w2"));
    await emit("tool_call", bash("mu task claim c -w y --for w3"));
    const r = (await emit("agent_before_settle", { outcome: "completed" })) as Settle;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.content).toContain("x/a, y/b");
    expect(r.entries[0]?.content).not.toContain("y/c");
  });

  it.each([
    ["a REFUTER note", "REFUTER brief-build (delegate-x, 3m):\nVERDICT: build AMEND: y"],
    ["a VERDICT line", "VERDICT: build CONFIRMED: brief holds"],
    ["a REFUTE-EXEMPT note", "REFUTE-EXEMPT: docs-only move"],
  ])("(b) %s: no nudge", async (_, note) => {
    const { emit } = setup({ "auth/build": notes(BRIEF, note) });
    await emit("tool_call", bash("mu task claim build -w auth --for worker-1"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });

  it("(e) markers mentioned mid-line in prose still nudge", async () => {
    const prose =
      "CHANGE: check for a REFUTER/VERDICT note or a REFUTE-EXEMPT: <why> note; see VERDICT: below";
    const { emit } = setup({ "auth/build": notes(prose) });
    await emit("tool_call", bash("mu task claim build -w auth --for worker-1"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
  });

  it("(c) fires at most once per prompt; a new input re-arms it", async () => {
    const { emit } = setup({ "auth/build": notes(BRIEF), "auth/docs": notes(BRIEF) });
    await emit("tool_call", bash("mu task claim build -w auth --for worker-1"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
    await emit("tool_call", bash("mu task claim docs -w auth --for worker-2"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    await emit("input", { text: "go on", source: "interactive" });
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    await emit("tool_call", bash("mu task claim docs -w auth --for worker-2"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeDefined();
  });

  it("(d) MU_NUDGE=0: registers nothing", () => {
    process.env.MU_NUDGE = "0";
    const f = fakePi();
    registerRefuteNudge(f.pi, vi.fn());
    expect(f.handlers.size).toBe(0);
  });

  it("review_* tasks are exempt: no notes read, no nudge", async () => {
    const { emit, run } = setup({});
    await emit("tool_call", bash("mu task claim review_build -w auth --for reviewer-1"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("a failing notes read: no nudge for that task", async () => {
    const { emit } = setup({});
    await emit("tool_call", bash("mu task claim build -w auth --for worker-1"));
    expect(await emit("agent_before_settle", { outcome: "completed" })).toBeUndefined();
  });

  it.each(["aborted", "error"])("outcome %s: no nudge", async (outcome) => {
    const { emit, run } = setup({ "auth/build": notes(BRIEF) });
    await emit("tool_call", bash("mu task claim build -w auth --for worker-1"));
    expect(await emit("agent_before_settle", { outcome })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("works without the keep-driving markers (independent of registerNudge)", () => {
    const f = fakePi();
    registerRefuteNudge(f.pi, vi.fn());
    expect(f.handlers.size).toBeGreaterThan(0);
  });
});
