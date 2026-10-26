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
} from "../extension/nudge.js";

type Handler = (event: unknown, ctx: MuNudgeCtx) => unknown;

const SKILL = "<!-- mu:keep-driving -->\nKeep driving.\n<!-- /mu:keep-driving -->";
const WORKER = { MU_AGENT_NAME: "w1", MU_WORKSTREAM: "ws" };
const json = (v: unknown): MuResult => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data: v, next: null }),
  stderr: "",
});

function answer(args: readonly string[]): MuResult {
  const [noun, verb] = args;
  if (noun === "state") return json({ workstreams: [] });
  if (noun === "wait") return json({ firing: { kind: "closed" }, exit: 0 });
  if (noun === "task" && verb === "owned-by")
    return json({ items: [{ id: "t1", status: "IN_PROGRESS" }] });
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

/** Both nudges armed behind parallelSettle; mu calls are held until released. */
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
    // The human-stop read answers at once; the wait and owned-by are held.
    if (args[0] === "state") return Promise.resolve(answer(args));
    return new Promise((resolve) => held.push(() => resolve(answer(args))));
  };
  const settle = parallelSettle(pi);
  registerNudge(settle.api, run, SKILL);
  registerCloseNudge(settle.api, run, WORKER);
  settle.flush();
  const emit = async (event: string, extra: object = {}) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) {
      const r = await h(
        { type: event, ...extra },
        { hasUI: true, sessionManager: { getSessionId: () => "s1" } },
      );
      if (r !== undefined) last = r;
    }
    return last;
  };
  return { handlers, calls, held, emit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("parallelSettle", () => {
  it("registers ONE working agent_before_settle handler, then a no-op reporter per nudge", () => {
    // 1 merged handler + 2 reporters that only rethrow a nudge's error.
    expect(setup().handlers.get("agent_before_settle")).toHaveLength(3);
  });

  it("runs the settle wait and the close read at once and does not wait for the log breadcrumb", async () => {
    const f = setup();
    await f.emit("input");
    const settled = f.emit("agent_before_settle", { outcome: "completed", entries: [] });
    await flush();
    // the wait + owned-by, both in flight before either answers.
    expect(f.held).toHaveLength(2);
    expect(
      f.calls
        .filter((c) => c[0] !== "state")
        .map((c) => c.slice(0, 2).join(" "))
        .sort(),
    ).toEqual(["task owned-by", "wait --first"]);
    for (const release of f.held.splice(0)) release();
    const r = (await settled) as { entries: { customType: string }[]; continue?: boolean };
    // Every nudge's entry survives the merge (pi replaces entries per handler).
    expect(r.entries.map((e) => e.customType).sort()).toEqual(["mu-close-task", "mu-keep-driving"]);
    expect(r.continue).toBe(true);
    // The close nudge's breadcrumb was still written, just not awaited.
    expect(f.calls.filter((c) => c[0] === "log")).toHaveLength(1);
  });

  it("re-reads the hold after the slowest nudge: blocked drops continuations, a wake or input drops all", async () => {
    const handlers: Handler[] = [];
    let late: "wake" | "blocked" | undefined;
    const yielded: string[] = [];
    const settle = parallelSettle({ on: (_e: string, h: Handler) => handlers.push(h) }, () => late);
    settle.api.on("agent_before_settle", () => ({
      entries: ["go"],
      continue: true,
      yielded: () => yielded.push("go"),
    }));
    settle.api.on("agent_before_settle", () => ({
      entries: ["info"],
      yielded: () => yielded.push("info"),
    }));
    settle.flush();
    late = "blocked";
    expect(await handlers[0]?.({ entries: [] }, {})).toEqual({ entries: ["info"] });
    expect(yielded).toEqual(["go"]);
    late = "wake";
    expect(await handlers[0]?.({ entries: [] }, {})).toBeUndefined();
    expect(yielded).toEqual(["go", "go", "info"]);
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
