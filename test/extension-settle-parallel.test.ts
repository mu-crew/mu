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
    for (const h of handlers.get(event) ?? []) {
      const r = await h({ type: event, ...extra }, { hasUI: true });
      if (r !== undefined) last = r;
    }
    return last;
  };
  return { handlers, calls, held, emit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("parallelSettle", () => {
  it("registers ONE working agent_before_settle handler, then a no-op reporter per nudge", () => {
    // 1 merged handler + 3 reporters that only rethrow a nudge's error.
    expect(setup().handlers.get("agent_before_settle")).toHaveLength(4);
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
    const handlers: Handler[] = [];
    const settle = parallelSettle({ on: (_e: string, h: Handler) => handlers.push(h) });
    settle.api.on("agent_before_settle", () => undefined);
    settle.flush();
    expect(await handlers[0]?.({ entries: [] }, {})).toBeUndefined();
  });

  it("a throwing nudge still reaches pi's error path; the others still deliver", async () => {
    const handlers: Handler[] = [];
    const settle = parallelSettle({ on: (_e: string, h: Handler) => handlers.push(h) });
    settle.api.on("agent_before_settle", () => ({ entries: ["a"] }));
    settle.api.on("agent_before_settle", () => {
      throw new Error("boom");
    });
    settle.api.on("agent_before_settle", async () => {
      throw new Error("bang");
    });
    settle.flush();
    // pi's emitBoundary: await each handler in order, report a throw via
    // emitError and go on, take entries from each result.
    const emitBoundary = async () => {
      const reported: string[] = [];
      let entries: unknown[] = [];
      for (const h of handlers) {
        try {
          const r = (await h({ entries }, {})) as { entries?: unknown[] } | undefined;
          if (r?.entries !== undefined) entries = r.entries;
        } catch (err) {
          reported.push((err as Error).message);
        }
      }
      return { reported, entries };
    };
    expect(await emitBoundary()).toEqual({ reported: ["boom", "bang"], entries: ["a"] });
    // Each settle reports its own errors (the nudges throw again here).
    expect((await emitBoundary()).reported).toEqual(["boom", "bang"]);
  });
});
