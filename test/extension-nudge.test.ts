import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuResult, MuRunOpts } from "../extension/mu-run.js";
import {
  keepDrivingRule,
  type MuNudgeCtx,
  NUDGE_MESSAGE_TYPE,
  parallelSettle,
  registerNudge,
  SETTLE_DRAIN_MS,
  SETTLE_WAIT_ARGS,
  type SettleWake,
} from "../extension/nudge.js";

const SKILL = readFileSync(join(import.meta.dirname, "..", "skills", "mu", "SKILL.md"), "utf8");

type Handler = (event: unknown, ctx: MuNudgeCtx) => unknown;

function fakePi(ctx: MuNudgeCtx = {}) {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return () => {};
    },
  };
  const emit = async (event: string, extra: Record<string, unknown> = {}) => {
    let last: unknown;
    for (const h of handlers.get(event) ?? []) last = await h({ type: event, ...extra }, ctx);
    return last;
  };
  return { pi, emit, handlers };
}

const out = (v: unknown, code = 0): MuResult => ({ code, stdout: JSON.stringify(v), stderr: "" });
const okWait = (data: Record<string, unknown>) =>
  out({ ok: true, data: { firing: { kind: "closed" }, exit: 0, ...data }, next: null });
const NOTHING = out({ ok: false, error: "WaitNothingError", message: "nothing", next: null }, 1);
const stateDoc = (needs: number) =>
  out({
    ok: true,
    data: {
      caller: "pi:s1",
      workstreams: [{ workstream: "ws", human_needs: Array(needs).fill({}) }],
    },
    next: null,
  });
const settled = { outcome: "completed" };

type Call = { args: string[]; signal?: AbortSignal; opts?: MuRunOpts };

/** A mu whose `wait` answers come from `waits` in order (a function may block on the signal). */
function fakeMu(waits: (MuResult | ((signal?: AbortSignal) => Promise<MuResult>))[], needs = 0) {
  const calls: Call[] = [];
  const run = async (
    args: readonly string[],
    signal?: AbortSignal,
    _stdin?: string,
    opts?: MuRunOpts,
  ): Promise<MuResult> => {
    calls.push({ args: [...args], ...(signal ? { signal } : {}), ...(opts ? { opts } : {}) });
    if (args[0] === "state") return stateDoc(needs);
    if (args[0] !== "wait") return out({ ok: true, data: {}, next: null });
    const next = waits.shift() ?? NOTHING;
    return typeof next === "function" ? next(signal) : next;
  };
  return { run, calls, waits: () => calls.filter((c) => c.args[0] === "wait") };
}

/** A wait that blocks until its signal aborts, then prints its interrupted snapshot (the drain). */
const blocking = (signal?: AbortSignal) =>
  new Promise<MuResult>((resolve) =>
    signal?.addEventListener("abort", () =>
      resolve(okWait({ firing: { kind: "interrupted" }, interrupted: true, exit: 143 })),
    ),
  );

const SESSION: MuNudgeCtx = { sessionManager: { getSessionId: () => "s1" } };
const flush = () => new Promise((r) => setTimeout(r, 0));

let saved: Record<string, string | undefined>;
const KEYS = ["MU_NUDGE", "MU_REMOTE", "MU_MANAGED_AGENT", "MU_WORKSTREAM", "MU_AGENT_NAME"];
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function setup(mu: ReturnType<typeof fakeMu>, ctx: MuNudgeCtx = SESSION, wake?: SettleWake) {
  const f = fakePi(ctx);
  registerNudge(f.pi, mu.run, SKILL, undefined, undefined, wake);
  return f;
}

type Settle = { entries?: { customType: string; content: string }[]; continue?: boolean };

describe("keep-driving rule source", () => {
  it("SKILL.md carries the markers and a non-empty paragraph", () => {
    const rule = keepDrivingRule(SKILL);
    expect(rule).toBeDefined();
    expect(rule).toMatch(/^\*\*While workers run, keep driving\.\*\*/);
    expect(rule).not.toContain("<!--");
  });

  it("is undefined without the markers, and then registers nothing", () => {
    expect(keepDrivingRule("no markers here")).toBeUndefined();
    const f = fakePi();
    registerNudge(f.pi, vi.fn(), "no markers here");
    expect(f.handlers.size).toBe(0);
  });
});

describe("the settle wait", () => {
  it("runs the one wait as this session, with a graceful drain; nothing owed lets the turn end", async () => {
    const mu = fakeMu([NOTHING]);
    const f = setup(mu);
    expect(await f.emit("agent_before_settle", settled)).toBeUndefined();
    const state = mu.calls.find((c) => c.args[0] === "state");
    expect(state?.args).toEqual(["state", "--me", "--all", "--full", "--json"]);
    expect(state?.opts?.env).toEqual({ MU_MANAGED_AGENT: undefined, PI_SESSION_ID: "s1" });
    const [w] = mu.waits();
    expect(w?.args).toEqual([...SETTLE_WAIT_ARGS]);
    expect(w?.args).toEqual(["wait", "--first", "--on-stall", "exit", "--json"]);
    expect(w?.opts).toEqual({ env: { PI_SESSION_ID: "s1" }, drainMs: SETTLE_DRAIN_MS });
  });

  it("an event continues the turn with the rule and the wait's own result", async () => {
    const mu = fakeMu([
      okWait({ firing: { kind: "closed", ref: { workstream: "ws", id: "t1" } } }),
    ]);
    const r = (await setup(mu).emit("agent_before_settle", settled)) as Settle;
    expect(r.continue).toBe(true);
    expect(r.entries).toHaveLength(1);
    expect(r.entries?.[0]?.customType).toBe(NUDGE_MESSAGE_TYPE);
    expect(r.entries?.[0]?.content).toContain(keepDrivingRule(SKILL) ?? "unreachable");
    expect(r.entries?.[0]?.content).toContain('"id":"t1"');
  });

  it("every completed settle waits again: no once-per-prompt latch, no dispatch to parse", async () => {
    const ev = okWait({});
    const mu = fakeMu([ev, ev, NOTHING]);
    const f = setup(mu);
    expect(await f.emit("agent_before_settle", settled)).toMatchObject({ continue: true });
    expect(await f.emit("agent_before_settle", settled)).toMatchObject({ continue: true });
    expect(await f.emit("agent_before_settle", settled)).toBeUndefined();
    expect(mu.waits()).toHaveLength(3);
  });

  it("a heartbeat timeout with work still owed waits again (and rereads the human stops)", async () => {
    const mu = fakeMu([okWait({ firing: { kind: "heartbeat" }, timedOut: true }), okWait({})]);
    expect(await setup(mu).emit("agent_before_settle", settled)).toMatchObject({ continue: true });
    expect(mu.waits()).toHaveLength(2);
    expect(mu.calls.filter((c) => c.args[0] === "state")).toHaveLength(2);
  });

  it("drained (everything already delivered) lets the turn end", async () => {
    const mu = fakeMu([okWait({ firing: { kind: "heartbeat" }, drained: true })]);
    expect(await setup(mu).emit("agent_before_settle", settled)).toBeUndefined();
  });

  it("an open human stop ends the turn before any wait", async () => {
    const mu = fakeMu([okWait({})], 1);
    expect(await setup(mu).emit("agent_before_settle", settled)).toBeUndefined();
    expect(mu.waits()).toHaveLength(0);
  });

  it("a human stop in the wait's result shows the result but does not continue", async () => {
    const mu = fakeMu([okWait({ humanNeeds: [{ workstream: "ws", id: "h1", reason: "spend" }] })]);
    const r = (await setup(mu).emit("agent_before_settle", settled)) as Settle;
    expect(r.continue).toBeUndefined();
    expect(r.entries?.[0]?.content).toContain("spend");
  });

  it.each([
    ["an error envelope", out({ ok: false, error: "MuxError", message: "boom", next: null }, 5)],
    ["no envelope", { code: 1, stdout: "", stderr: "crashed" }],
  ])("%s is shown, never treated as nothing owed, never continued", async (_n, res) => {
    const r = (await setup(fakeMu([res])).emit("agent_before_settle", settled)) as Settle;
    expect(r.continue).toBeUndefined();
    expect(r.entries?.[0]?.content).toMatch(/mu wait failed \(exit [15]\): .*(boom|crashed)/);
  });

  it("an unreadable human-stop read is shown and nothing waits", async () => {
    const mu = fakeMu([okWait({})]);
    const run: typeof mu.run = (args, ...rest) =>
      args[0] === "state"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "x" })
        : mu.run(args, ...rest);
    const f = fakePi(SESSION);
    registerNudge(f.pi, run, SKILL);
    const r = (await f.emit("agent_before_settle", settled)) as Settle;
    expect(r.entries?.[0]?.content).toContain("could not read");
    expect(mu.waits()).toHaveLength(0);
  });

  it("a managed orchestrator reads each identity's human stops apart", async () => {
    Object.assign(process.env, { MU_MANAGED_AGENT: "1", MU_WORKSTREAM: "ws", MU_AGENT_NAME: "o" });
    const mu = fakeMu([NOTHING]);
    await setup(mu).emit("agent_before_settle", settled);
    expect(mu.calls.filter((c) => c.args[0] === "state").map((c) => c.opts?.env)).toEqual([
      { PI_SESSION_ID: undefined },
      { MU_MANAGED_AGENT: undefined, PI_SESSION_ID: "s1" },
    ]);
  });

  it("no caller identity (no session, not managed): nothing runs", async () => {
    const mu = fakeMu([okWait({})]);
    expect(await setup(mu, {}).emit("agent_before_settle", settled)).toBeUndefined();
    expect(mu.calls).toHaveLength(0);
  });

  it.each(["aborted", "error"])("outcome %s: no wait", async (outcome) => {
    const mu = fakeMu([okWait({})]);
    expect(await setup(mu).emit("agent_before_settle", { outcome })).toBeUndefined();
    expect(mu.calls).toHaveLength(0);
  });

  it("a nested pi or a held settle runs nothing", async () => {
    const mu = fakeMu([okWait({})]);
    const f = fakePi(SESSION);
    registerNudge(f.pi, mu.run, SKILL, () => true);
    registerNudge(f.pi, mu.run, SKILL, undefined, () => "blocked");
    expect(await f.emit("agent_before_settle", settled)).toBeUndefined();
    expect(mu.calls).toHaveLength(0);
  });

  it.each(["MU_NUDGE=0", "MU_REMOTE=1"])("%s registers nothing", (kv) => {
    const [k, v] = kv.split("=");
    process.env[k ?? ""] = v;
    const f = fakePi();
    registerNudge(f.pi, vi.fn(), SKILL);
    expect(f.handlers.size).toBe(0);
  });
});

describe("cancelling the settle wait", () => {
  /** A settle blocked in its wait, with the hooks a cancel can come from. */
  function blocked() {
    let onInput: ((d: string) => undefined) | undefined;
    const off = vi.fn();
    let onWake: (() => void) | undefined;
    const wakeOff = vi.fn();
    const ctx: MuNudgeCtx = {
      ...SESSION,
      ui: {
        onTerminalInput: (h) => {
          onInput = h;
          return off;
        },
      },
    };
    const mu = fakeMu([blocking]);
    const f = setup(mu, ctx, (w) => {
      onWake = w;
      return wakeOff;
    });
    const settling = f.emit("agent_before_settle", settled);
    return {
      f,
      mu,
      settling,
      key: (d: string) => onInput?.(d),
      wake: () => onWake?.(),
      off,
      wakeOff,
    };
  }

  it.each([
    ["Esc", (b: ReturnType<typeof blocked>) => b.key("\u001b")],
    ["Esc (kitty)", (b: ReturnType<typeof blocked>) => b.key("\u001b[27u")],
    ["typed input", (b: ReturnType<typeof blocked>) => b.f.emit("input")],
    ["a dialog", (b: ReturnType<typeof blocked>) => b.f.emit("ui_prompt_start")],
    ["shutdown", (b: ReturnType<typeof blocked>) => b.f.emit("session_shutdown")],
    ["a delegate answer", (b: ReturnType<typeof blocked>) => b.wake()],
  ])("%s aborts only the owned wait, which drains; the turn may end", async (_n, act) => {
    const b = blocked();
    await flush();
    expect(b.mu.waits()).toHaveLength(1);
    expect(b.mu.waits()[0]?.signal?.aborted).toBe(false);
    await act(b);
    expect(await b.settling).toBeUndefined();
    expect(b.mu.waits()[0]?.signal?.aborted).toBe(true);
    expect(b.mu.waits()).toHaveLength(1); // not waited again
    expect(b.off).toHaveBeenCalledTimes(1);
    expect(b.wakeOff).toHaveBeenCalledTimes(1);
  });

  it("other keys never cancel and are never consumed", async () => {
    const b = blocked();
    await flush();
    expect(b.key("a")).toBeUndefined();
    expect(b.mu.waits()[0]?.signal?.aborted).toBe(false);
    b.wake();
    await b.settling;
  });

  it("a cancel after the wait finished touches no later wait", async () => {
    const mu = fakeMu([okWait({}), blocking]);
    const f = setup(mu);
    await f.emit("agent_before_settle", settled);
    await f.emit("input"); // nothing running: a no-op
    const next = f.emit("agent_before_settle", settled);
    await flush();
    expect(mu.waits()[1]?.signal?.aborted).toBe(false);
    await f.emit("input");
    expect(await next).toBeUndefined();
  });
});

describe("parallelSettle keeps a consumed receipt", () => {
  it("a wait event consumed while an answer queued still reaches the transcript", async () => {
    let late: "answer" | undefined;
    const mu = fakeMu([
      okWait({ firing: { kind: "closed", ref: { workstream: "ws", id: "t9" } } }),
    ]);
    const run: typeof mu.run = async (args, ...rest) => {
      const r = await mu.run(args, ...rest);
      if (args[0] === "wait") late = "answer"; // an answer queued during the wait
      return r;
    };
    const handlers: Handler[] = [];
    const on = (e: string, h: Handler) => (e === "agent_before_settle" ? handlers.push(h) : 0);
    const settle = parallelSettle({ on }, () => late);
    registerNudge(settle.api, run, SKILL, undefined, () => late);
    settle.flush();
    const r = (await handlers[0]?.({ entries: [], ...settled }, SESSION)) as Settle;
    expect(r.continue).toBeUndefined(); // the answer's turn comes first
    expect(r.entries?.[0]?.content).toContain('"id":"t9"');
  });

  it("a late hold drops the wait's continuation, never its entries", async () => {
    const handlers: Handler[] = [];
    let late: "answer" | "blocked" | undefined;
    const settle = parallelSettle({ on: (_e: string, h: Handler) => handlers.push(h) }, () => late);
    settle.api.on("agent_before_settle", () => ({
      entries: ["event"],
      continue: true,
      receipt: true,
    }));
    settle.flush();
    for (const h of ["answer", "blocked"] as const) {
      late = h;
      expect(await handlers[0]?.({ entries: ["prior"] }, {})).toEqual({
        entries: ["prior", "event"],
      });
    }
    late = undefined;
    expect(await handlers[0]?.({ entries: [] }, {})).toEqual({
      entries: ["event"],
      continue: true,
    });
  });
});
