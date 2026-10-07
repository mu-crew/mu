// The nudges' agent_before_settle checks run in parallel behind one
// handler, so a settle waits for the slowest mu call, not their sum, and
// never for a `mu log` breadcrumb.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuResult, MuRunner } from "../extension/delegate.js";
import {
  type MuNudgeCtx,
  parallelSettle,
  registerCloseNudge,
  registerNudge,
  registerRefuteNudge,
} from "../extension/nudge.js";

type Handler = (event: unknown, ctx: MuNudgeCtx) => unknown;

const SKILL = "<!-- mu:keep-driving -->\nKeep driving.\n<!-- /mu:keep-driving -->";
const WORKER = { MU_AGENT_NAME: "w1", MU_WORKSTREAM: "ws" };
const json = (v: unknown): MuResult => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });

function answer(args: readonly string[]): MuResult {
  const [noun, verb] = args;
  if (noun === "state") return json({ workstreamName: "ws", inProgress: [{ name: "t1" }] });
  if (noun === "task" && verb === "owned-by")
    return json({ items: [{ name: "t1", status: "IN_PROGRESS" }] });
  if (noun === "task" && verb === "notes") return json({ items: [] });
  return json({});
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MU_NUDGE;
  delete process.env.MU_NUDGE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MU_NUDGE;
  else process.env.MU_NUDGE = saved;
});

/** All three nudges armed behind parallelSettle; mu calls are held until released. */
function setup() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
  };
  const calls: string[][] = [];
  const held: (() => void)[] = [];
  const run: MuRunner = (args) => {
    calls.push([...args]);
    // A breadcrumb never answers: a settle that awaited one would hang.
    if (args[0] === "log") return new Promise(() => {});
    return new Promise((resolve) => held.push(() => resolve(answer(args))));
  };
  const settle = parallelSettle(pi);
  registerNudge(settle.api, run, SKILL);
  registerCloseNudge(settle.api, run, WORKER);
  registerRefuteNudge(settle.api, run);
  settle.flush();
  const emit = async (event: string, extra: object = {}) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? [])
      last = await h({ type: event, ...extra }, { hasUI: true });
    return last;
  };
  return { handlers, calls, held, emit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("parallelSettle", () => {
  it("registers ONE agent_before_settle handler for the three nudges", () => {
    expect(setup().handlers.get("agent_before_settle")).toHaveLength(1);
  });

  it("starts every nudge's mu read at once and does not wait for the log breadcrumbs", async () => {
    const f = setup();
    await f.emit("input");
    await f.emit("tool_call", {
      toolName: "bash",
      input: { command: "mu task claim a -w ws --for w2 && mu task claim b -w ws --for w3" },
    });
    const settled = f.emit("agent_before_settle", { outcome: "completed", entries: [] });
    await flush();
    // state + owned-by + two notes reads, all in flight before any answers.
    expect(f.calls.map((c) => c.slice(0, 2).join(" ")).sort()).toEqual([
      "state --json",
      "task notes",
      "task notes",
      "task owned-by",
    ]);
    for (const release of f.held.splice(0)) release();
    const r = (await settled) as { entries: { customType: string }[]; continue?: boolean };
    // Every nudge's entry survives the merge (pi replaces entries per handler).
    expect(r.entries.map((e) => e.customType).sort()).toEqual([
      "mu-close-task",
      "mu-keep-driving",
      "mu-refute-brief",
    ]);
    expect(r.continue).toBe(true);
    // The breadcrumbs were still written, just not awaited.
    expect(f.calls.filter((c) => c[0] === "log")).toHaveLength(3);
  });

  it("returns undefined when no nudge fires", async () => {
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on(event: string, h: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
    };
    const settle = parallelSettle(pi);
    settle.api.on("agent_before_settle", () => undefined);
    settle.api.on("agent_before_settle", () => {
      throw new Error("boom");
    });
    settle.flush();
    const h = handlers.get("agent_before_settle")?.[0];
    expect(await h?.({ entries: [] }, {})).toBeUndefined();
  });
});
