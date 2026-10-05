import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_STATUS_KEY,
  DELEGATE_TOOL,
  type DelegateCtx,
  type DelegateTool,
  delegateEnabled,
  delegateMax,
  delegateMessage,
  delegateStatus,
  formatElapsed,
  labelStem,
  type MuResult,
  type MuRunner,
  PENDING_CHANNEL,
  registerDelegate,
} from "../extension/delegate.js";
import muPi from "../extension/mu-pi.js";

const ENV_KEYS = [
  "MU_MANAGED_AGENT",
  "MU_DELEGATE",
  "MU_DELEGATE_MAX",
  "MU_MUX",
  "MU_CTL_SOCK",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.MU_MUX = "tmux"; // a mux "is detected" without probing the host
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ok = (stdout: unknown): MuResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout),
  stderr: "",
});

type Deferred = { resolve: (r: MuResult) => void; signal?: AbortSignal };

/** A fake `mu`: records argv, answers spawn/list/send/read/close, holds waits open. */
type Override = (args: readonly string[]) => Promise<MuResult> | undefined;

function fakeMu(
  opts: {
    ctl?: string;
    workspace?: string;
    on?: Record<string, Override>;
    /** `mu task <verb>` overrides; default `task show` finds the task in ws `crew`. */
    task?: Record<string, Override>;
  } = {},
) {
  const calls: string[][] = [];
  const waits = new Map<string, Deferred>();
  const run: MuRunner = (args, signal) => {
    calls.push([...args]);
    const [ns, verb, name] = args;
    if (ns === "task") {
      const o = opts.task?.[verb ?? ""]?.(args);
      if (o) return o;
      if (verb === "show") {
        const ref = String(name);
        const [ws, local] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
        const wi = args.indexOf("-w");
        const workstreamName = ws ?? (wi >= 0 ? args[wi + 1] : "crew");
        return Promise.resolve(ok({ task: { name: local, workstreamName } }));
      }
      return Promise.resolve(ok("{}"));
    }
    if (ns !== "agent") return Promise.resolve(ok(""));
    const o = opts.on?.[verb ?? ""]?.(args);
    if (o) return o;
    switch (verb) {
      case "list":
        return Promise.resolve(ok({ agents: [{ name: "delegate-1" }] }));
      case "spawn":
        return Promise.resolve(
          ok({
            ctl: opts.ctl ?? "ok",
            workspace: opts.workspace ? { path: opts.workspace } : null,
            nextSteps: [{ intent: "Attach the pane", command: `tmux attach -t mu-scratch` }],
          }),
        );
      case "wait":
        return new Promise((resolve) => {
          waits.set(name ?? "", { resolve, ...(signal ? { signal } : {}) });
        });
      case "read":
        return Promise.resolve(ok("last pane lines\n"));
      default:
        return Promise.resolve(ok("{}"));
    }
  };
  return { run, calls, waits };
}

function fakePi() {
  const tools = new Map<string, DelegateTool>();
  const shutdown: Array<(e: unknown, c: DelegateCtx) => unknown> = [];
  const sendMessage = vi.fn(async (_m: unknown, _o?: unknown) => {});
  const emitted: { channel: string; data: unknown }[] = [];
  const pi = {
    events: { emit: (channel: string, data: unknown) => void emitted.push({ channel, data }) },
    registerTool: (t: DelegateTool) => {
      tools.set(t.name, t);
    },
    sendMessage,
    on: (_e: "session_shutdown", h: (e: unknown, c: DelegateCtx) => unknown) => {
      shutdown.push(h);
    },
  };
  return { pi, tools, sendMessage, shutdown, emitted };
}

function sentText(p: { sendMessage: { mock: { calls: unknown[][] } } }): string {
  const m = p.sendMessage.mock.calls[0]?.[0] as { content?: string } | undefined;
  return m?.content ?? "";
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function tool(p: ReturnType<typeof fakePi>, name = DELEGATE_TOOL): DelegateTool {
  const t = p.tools.get(name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

describe("registration guards", () => {
  it("registers mu_delegate and mu_delegate_cancel in an unmanaged pi", () => {
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    expect([...p.tools.keys()]).toEqual([DELEGATE_TOOL, DELEGATE_CANCEL_TOOL]);
  });

  it("is hidden inside a mu-managed agent (no helper-spawns-helper)", () => {
    process.env.MU_MANAGED_AGENT = "1";
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    expect(p.tools.size).toBe(0);
  });

  it("delegateEnabled is false under MU_MANAGED_AGENT (agents and the pis nested in them)", () => {
    expect(delegateEnabled({ MU_MANAGED_AGENT: "1", TMUX: "/tmp/x,1,0" })).toBe(false);
  });

  it("is hidden by the MU_DELEGATE=0 kill switch", () => {
    process.env.MU_DELEGATE = "0";
    expect(delegateEnabled()).toBe(false);
  });

  it("is hidden when no mux is in reach", () => {
    expect(delegateEnabled({ PATH: "/nonexistent" })).toBe(false);
    expect(delegateEnabled({ PATH: "/nonexistent", TMUX: "/tmp/x,1,0" })).toBe(true);
  });

  it("the default export carries it (not optional)", () => {
    const p = fakePi();
    muPi({ ...p.pi, on: () => {}, sendUserMessage: () => {}, registerCommand: () => {} });
    // A real runner would shell out; registration alone must not.
    expect(p.tools.has(DELEGATE_TOOL)).toBe(true);
  });
});

describe("mu_delegate", () => {
  it("returns at once with the name, then delivers the answer as a follow-up and closes the pane", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const res = await tool(p).execute("t1", { task: "find X", brief: "You are terse." });
    // delegate-1 is taken in the list: the next free name.
    expect(res.content[0]?.text).toContain("scratch/delegate-2");
    expect(res.content[0]?.text).toContain("tmux attach -t mu-scratch");
    expect(mu.calls.find((c) => c[1] === "spawn")).toEqual([
      "agent",
      "spawn",
      "delegate-2",
      "-w",
      "scratch",
      "--json",
      "--cwd",
      process.cwd(),
    ]);
    expect(mu.calls.find((c) => c[1] === "send")?.[3]).toBe("You are terse.\n\nfind X");
    expect(p.sendMessage).not.toHaveBeenCalled();

    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "X is 42" }] }));
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = p.sendMessage.mock.calls[0] ?? [];
    expect(msg).toMatchObject({ customType: "mu-delegate", display: true });
    expect((msg as { content: string }).content).toContain("X is 42");
    expect(opts).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("with runs in the send reply, drops the concurrent wait for --after-runs after the send", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const mu = fakeMu({ on: { send: () => Promise.resolve(ok({ transport: "ctl", runs: 0 })) } });
    const run: MuRunner = (args, signal) => {
      if (args[1] === "wait") signals.push(signal);
      return mu.run(args, signal);
    };
    const p = fakePi();
    registerDelegate(p.pi, run);
    await tool(p).execute("t", { task: "x" });
    const send = mu.calls.findIndex((c) => c[1] === "send");
    const waits = mu.calls.flatMap((c, i) => (c[1] === "wait" ? [i] : []));
    expect(mu.calls[send]).toContain("--json");
    expect(waits).toHaveLength(2);
    const [plainAt = -1, afterAt = -1] = waits;
    expect(plainAt).toBeLessThan(send);
    expect(mu.calls[plainAt]).not.toContain("--after-runs");
    expect(signals[0]?.aborted).toBe(true);
    expect(afterAt).toBeGreaterThan(send);
    const wait = mu.calls[afterAt] ?? [];
    expect(wait[wait.indexOf("--after-runs") + 1]).toBe("0");
    expect(signals[1]?.aborted).toBe(false);
  });

  it("without runs in the send reply (older mu or extension) keeps the wait started before the send", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const mu = fakeMu({ on: { send: () => Promise.resolve(ok({ transport: "ctl" })) } });
    const run: MuRunner = (args, signal) => {
      if (args[1] === "wait") signals.push(signal);
      return mu.run(args, signal);
    };
    const p = fakePi();
    registerDelegate(p.pi, run);
    await tool(p).execute("t", { task: "x" });
    const send = mu.calls.findIndex((c) => c[1] === "send");
    const waits = mu.calls.flatMap((c, i) => (c[1] === "wait" ? [i] : []));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThan(send);
    expect(mu.calls[waits[0] ?? -1]).not.toContain("--after-runs");
    expect(signals[0]?.aborted).toBe(false);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "old" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toContain("old");
  });

  it("cwd and timeout reach spawn and wait; the timeout is named in the message", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", cwd: "/tmp", timeout: 90 });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn.slice(spawn.indexOf("--cwd"), spawn.indexOf("--cwd") + 2)).toEqual([
      "--cwd",
      "/tmp",
    ]);
    const wait = mu.calls.find((c) => c[1] === "wait") ?? [];
    expect(wait[wait.indexOf("--timeout") + 1]).toBe("90");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "timeout" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toContain("still running after 90s");
  });

  it("workspace: true spawns with --workspace (no --cwd) and reports the checkout path", async () => {
    const mu = fakeMu({ workspace: "/ws/scratch/delegate-2" });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const res = await tool(p).execute("t", { task: "x", workspace: true, cwd: "/ignored" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn).toContain("--workspace");
    expect(spawn).not.toContain("--cwd");
    expect(res.content[0]?.text).toContain("Workspace: /ws/scratch/delegate-2");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "edited" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toContain("Workspace: /ws/scratch/delegate-2");
  });

  it("parallel calls get distinct names", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const [a, b] = await Promise.all([
      tool(p).execute("a", { task: "one" }),
      tool(p).execute("b", { task: "two" }),
    ]);
    expect(a.content[0]?.text).toContain("delegate-2");
    expect(b.content[0]?.text).toContain("delegate-3");
  });

  it("past MU_DELEGATE_MAX a call is queued, and starts when a slot frees", async () => {
    process.env.MU_DELEGATE_MAX = "2";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      // All three start before any spawn resolves, as parallel tool calls do.
      const [a, b, c] = await Promise.all([
        tool(p).execute("a", { task: "one" }),
        tool(p).execute("b", { task: "two" }),
        tool(p).execute("c", { task: "three" }),
      ]);
      expect(a.content[0]?.text).toContain("Delegated to");
      expect(b.content[0]?.text).toContain("Delegated to");
      expect(c.content[0]?.text).toContain("Queued as queued-1");
      expect(c.details).toMatchObject({ queued: true, position: 1 });
      const spawns = () => mu.calls.filter((x) => x[1] === "spawn");
      expect(spawns()).toHaveLength(2);
      // An answer frees a slot: the queued call spawns, with the caller's cwd.
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 5; i++) await flush();
      expect(spawns()).toHaveLength(3);
      expect(spawns()[2]).toContain("--cwd");
      expect(mu.calls.some((x) => x[1] === "send" && x.includes("three"))).toBe(true);
      // Its answer names the handle the model was given, so a batch of
      // answers still maps back to the calls.
      const third = String(spawns()[2]?.[2]);
      mu.waits.get(third)?.resolve(ok({ agents: [{ outcome: "done", lastText: "z" }] }));
      for (let i = 0; i < 4; i++) await flush();
      const texts = p.sendMessage.mock.calls.map((x) => (x[0] as { content: string }).content);
      expect(texts.some((t) => t.includes(`${third} (queued as queued-1) finished`))).toBe(true);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("the queue holds four caps' worth; past it, refuse", async () => {
    process.env.MU_DELEGATE_MAX = "2";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      // 2 running + 8 queued (4 x 2) = 10 accepted; the 11th is refused.
      const results = await Promise.allSettled(
        Array.from({ length: 11 }, (_, i) => tool(p).execute(String(i), { task: `t${i}` })),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === "fulfilled")).toHaveLength(10);
      expect(statuses[10]).toBe("rejected");
      const queued = results
        .slice(0, 10)
        .filter(
          (r) => r.status === "fulfilled" && (r.value.details as { queued?: boolean }).queued,
        );
      expect(queued).toHaveLength(8);
      const err = (results[10] as PromiseRejectedResult).reason as Error;
      expect(err.message).toContain("8 queued (MU_DELEGATE_MAX=2)");
      expect(err.message).toContain("issue the rest as answers arrive");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("mu_delegate_cancel drops a queued call before it starts", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      const q = await tool(p).execute("b", { task: "two" });
      expect(q.content[0]?.text).toContain("queued-1");
      const r = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "queued-1" });
      expect(r.content[0]?.text).toContain("never started");
      expect(mu.calls.some((x) => x[1] === "abort")).toBe(false);
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 5; i++) await flush();
      expect(mu.calls.filter((x) => x[1] === "spawn")).toHaveLength(1);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("a queued call that fails to start reports it as a follow-up", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      let n = 0;
      const mu = fakeMu({
        on: {
          spawn: () =>
            ++n === 2 ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : undefined,
        },
      });
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two" });
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      for (let i = 0; i < 6; i++) await flush();
      const texts = p.sendMessage.mock.calls.map((c) => (c[0] as { content: string }).content);
      expect(
        texts.some(
          (t) => t.includes("Queued delegate queued-1 could not start") && t.includes("boom"),
        ),
      ).toBe(true);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("session_shutdown names queued calls as never started", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two" });
      const notify = vi.fn();
      for (const h of p.shutdown) await h({}, { hasUI: true, ui: { notify } });
      expect(notify.mock.calls[0]?.[0]).toContain("queued, never started: queued-1");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("a failed spawn frees its slot", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      let fail = true;
      const mu = fakeMu({
        on: {
          spawn: () =>
            fail ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : undefined,
        },
      });
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await expect(tool(p).execute("a", { task: "one" })).rejects.toThrow("boom");
      fail = false;
      const b = await tool(p).execute("b", { task: "two" });
      expect(b.content[0]?.text).toContain("Delegated to"); // a free slot, not queued
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("delegateMax: default 16; ignores junk", () => {
    expect(delegateMax({})).toBe(16);
    expect(delegateMax({ MU_DELEGATE_MAX: "4" })).toBe(4);
    expect(delegateMax({ MU_DELEGATE_MAX: "0" })).toBe(16);
    expect(delegateMax({ MU_DELEGATE_MAX: "x" })).toBe(16);
  });

  it("keep: true leaves the pane open", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", keep: true });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    expect(sentText(p)).toContain("Pane kept (keep: true)");
  });

  it("a died delegate keeps its pane as evidence and carries the pane tail", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve({ ...ok({ agents: [{ outcome: "died" }] }), code: 6 });
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    const content = sentText(p);
    expect(content).toContain("died");
    expect(content).toContain("last pane lines");
  });

  it("an API error keeps the pane, names the error, and counts as failed in the footer", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const setStatus = vi.fn();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setStatus } };
    await tool(p).execute("t", { task: "x" }, undefined, undefined, ctx);
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "error", lastError: "529 overloaded" }] }));
    await flush();
    await flush();
    expect(mu.calls.some((c) => c[1] === "close")).toBe(false);
    expect(mu.calls.some((c) => c[1] === "read")).toBe(false); // the error is the evidence
    const content = sentText(p);
    expect(content).toContain("stopped on an API error");
    expect(content).toContain("529 overloaded");
    expect(content).toContain("re-issue the call, or record the check as UNVERIFIED");
    expect(content).toContain("mu agent close delegate-2 -w scratch");
    expect(setStatus.mock.calls.at(-1)).toEqual([DELEGATE_STATUS_KEY, "1 failed"]);
  });

  it("a failed delegate leaves the footer once its pane is gone", async () => {
    let listed: { name: string }[] = [{ name: "delegate-1" }];
    const mu = fakeMu({
      on: { list: () => Promise.resolve(ok({ agents: listed })) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const setStatus = vi.fn();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setStatus } };
    await tool(p).execute("t", { task: "x" }, undefined, undefined, ctx);
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "error", lastError: "Connection error." }] }));
    await flush();
    await flush();
    expect(setStatus.mock.calls.at(-1)?.[1]).toBe("1 failed");
    // The model closed it from bash; the next call's listing no longer has it.
    listed = [{ name: "delegate-1" }];
    await tool(p).execute("u", { task: "y" }, undefined, undefined, ctx);
    expect(setStatus.mock.calls.some((c) => c[1] === "1 delegate running")).toBe(true);
    expect(setStatus.mock.calls.at(-1)?.[1]).not.toContain("failed");
  });

  it("throws (a normal tool error) when the control socket is not ok", async () => {
    const p = fakePi();
    registerDelegate(p.pi, fakeMu({ ctl: "missing" }).run);
    await expect(tool(p).execute("t", { task: "x" })).rejects.toThrow(/control socket is missing/);
  });

  it("session_shutdown names exactly the delegates still in flight", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" });
    await tool(p).execute("b", { task: "two" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "z" }] }));
    await flush();
    await flush();
    const notify = vi.fn();
    for (const h of p.shutdown) await h({ reason: "quit" }, { hasUI: true, ui: { notify } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatch(/^1 delegate still running: delegate-3\./);
    expect(mu.waits.get("delegate-3")?.signal?.aborted).toBe(true);
  });

  it("mu_delegate_cancel aborts, closes, and suppresses the follow-up", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const res = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    expect(mu.calls.some((c) => c[1] === "abort" && c[2] === "delegate-2")).toBe(true);
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    expect(res.content[0]?.text).toContain("Pane closed");
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "late" }] }));
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled();
  });
});

describe("errors and corner cases", () => {
  const deferred = () => {
    let resolve!: (r: MuResult) => void;
    const promise = new Promise<MuResult>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const fail = (stderr: string): MuResult => ({ code: 1, stdout: "", stderr });

  it("a label names the delegate, numbered when taken", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const [a, b] = await Promise.all([
      tool(p).execute("a", { task: "x", label: "Code Review" }),
      tool(p).execute("b", { task: "y", label: "code review" }),
    ]);
    expect(a.content[0]?.text).toContain("scratch/delegate-code-review.");
    expect(b.content[0]?.text).toContain("scratch/delegate-code-review-2.");
  });

  it("an invalid timeout is refused, not silently an hour", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    for (const timeout of [0, -1, Number.NaN, "60"])
      await expect(tool(p).execute("t", { task: "x", timeout })).rejects.toThrow(
        /timeout must be a positive number/,
      );
    expect(mu.calls.some((c) => c[1] === "spawn")).toBe(false);
  });

  it("the follow-up details carry the answer and run time for machine readers", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "42" }] }));
    await flush();
    await flush();
    const msg = p.sendMessage.mock.calls[0]?.[0] as { details: Record<string, unknown> };
    expect(msg.details).toMatchObject({ outcome: "done", answer: "42", closed: true });
    expect(typeof msg.details.elapsedMs).toBe("number");
  });

  it("a cwd that is not a directory fails before anything spawns", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", cwd: "/nonexistent/xyz" })).rejects.toThrow(
      /is not a directory/,
    );
    expect(mu.calls.some((c) => c[1] === "spawn")).toBe(false);
  });

  it("defaults cwd to the session's ctx.cwd", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" }, undefined, undefined, { cwd: "/tmp" });
    const spawn = mu.calls.find((c) => c[1] === "spawn") ?? [];
    expect(spawn[spawn.indexOf("--cwd") + 1]).toBe("/tmp");
  });

  it("a failed send closes the pane, says so, and frees the name", async () => {
    let sends = 0;
    const mu = fakeMu({
      on: { send: () => (sends++ === 0 ? Promise.resolve(fail("boom")) : undefined) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x" })).rejects.toThrow(/boom.*Pane closed/);
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    const again = await tool(p).execute("t2", { task: "y" });
    expect(again.content[0]?.text).toContain("delegate-2");
  });

  it("an abort signal during spawn takes the new pane down", async () => {
    const ac = new AbortController();
    const mu = fakeMu({
      on: {
        spawn: () => {
          ac.abort();
          return undefined; // the default ok answer
        },
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x" }, ac.signal)).rejects.toThrow();
    expect(mu.calls.some((c) => c[1] === "close" && c[2] === "delegate-2")).toBe(true);
    expect(mu.calls.some((c) => c[1] === "send")).toBe(false);
  });

  it("a delivery failure becomes a follow-up, not an unhandled rejection", async () => {
    const mu = fakeMu({ on: { read: () => Promise.reject(new Error("read exploded")) } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "died" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toMatch(/delivering its answer failed: read exploded/);
  });

  it("cancel whose abort fails keeps the delegate tracked and delivers an answer that landed meanwhile", async () => {
    const ab = deferred();
    const mu = fakeMu({ on: { abort: () => ab.promise } });
    const p = fakePi();
    const setStatus = vi.fn();
    registerDelegate(p.pi, mu.run);
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setStatus } };
    await tool(p).execute("t", { task: "x" }, undefined, undefined, ctx);
    const cancel = tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    await flush();
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "late" }] }));
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled(); // parked while the abort is in flight
    ab.resolve(fail("agent gone"));
    await expect(cancel).rejects.toThrow(/agent gone/);
    await flush();
    await flush();
    expect(sentText(p)).toContain("late");
    expect(setStatus.mock.calls.at(-1)).toEqual([DELEGATE_STATUS_KEY, undefined]);
  });

  it("cancel whose abort fails before any answer keeps waiting (footer stays)", async () => {
    const mu = fakeMu({ on: { abort: () => Promise.resolve(fail("nope")) } });
    const p = fakePi();
    const setStatus = vi.fn();
    registerDelegate(p.pi, mu.run);
    const ctx = { hasUI: true, ui: { notify: vi.fn(), setStatus } };
    await tool(p).execute("t", { task: "x" }, undefined, undefined, ctx);
    await expect(
      tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" }),
    ).rejects.toThrow(/nope/);
    expect(setStatus.mock.calls.at(-1)).toEqual([DELEGATE_STATUS_KEY, "1 delegate running"]);
    mu.waits
      .get("delegate-2")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: "still here" }] }));
    await flush();
    await flush();
    expect(sentText(p)).toContain("still here");
  });

  it("a successful cancel drops an answer that its own abort settled", async () => {
    const ab = deferred();
    const mu = fakeMu({ on: { abort: () => ab.promise } });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    const cancel = tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-2" });
    await flush();
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "empty" }] }));
    await flush();
    ab.resolve(ok("{}"));
    await cancel;
    await flush();
    expect(p.sendMessage).not.toHaveBeenCalled();
  });
});

describe("murmur pending report", () => {
  const counts = (p: ReturnType<typeof fakePi>) =>
    p.emitted
      .filter((e) => e.channel === PENDING_CHANNEL)
      .map((e) => (e.data as { source: string; count: number }).count);

  it("reports running + queued delegates, and zero before the last answer is delivered", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" });
    await tool(p).execute("b", { task: "two" }); // queued behind the cap
    expect(counts(p)).toEqual([1, 2]);
    expect(p.emitted[0]?.data).toEqual({ source: DELEGATE_TOOL, count: 1 });

    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    await flush();
    // The queued one took the freed slot: still one outstanding.
    expect(counts(p).at(-1)).toBe(1);

    const name = mu.calls.filter((c) => c[1] === "spawn").at(-1)?.[2] ?? "";
    const before = p.sendMessage.mock.calls.length;
    let atDelivery: number | undefined;
    p.sendMessage.mockImplementationOnce(async () => {
      atDelivery = counts(p).at(-1);
    });
    mu.waits.get(name)?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
    await flush();
    await flush();
    expect(p.sendMessage.mock.calls.length).toBe(before + 1);
    // Zero is out BEFORE the follow-up that re-runs the parent, so the
    // settle after that run is the one murmur may call done.
    expect(atDelivery).toBe(0);
  });

  it("reports zero when a session shutdown drops the watchers", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("a", { task: "one" });
    for (const h of p.shutdown) h({}, {});
    expect(counts(p)).toEqual([1, 0]);
  });
});

describe("footer status", () => {
  const uiCtx = () => {
    const setStatus = vi.fn();
    return { setStatus, ctx: { hasUI: true, ui: { notify: vi.fn(), setStatus } } };
  };
  const last = (f: ReturnType<typeof vi.fn>) => f.mock.calls.at(-1);

  it("counts running delegates and clears when the last answer arrives", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const { setStatus, ctx } = uiCtx();
    await tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, "1 delegate running"]);
    await tool(p).execute("b", { task: "two" }, undefined, undefined, ctx);
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, "2 delegates running"]);
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "x" }] }));
    await flush();
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, "1 delegate running"]);
    await tool(p, DELEGATE_CANCEL_TOOL).execute(
      "c",
      { name: "delegate-3" },
      undefined,
      undefined,
      ctx,
    );
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, undefined]);
  });

  it("shows a call as starting the moment it is made, then running once its pane is up", async () => {
    let releaseSpawn: (r: MuResult) => void = () => {};
    const mu = fakeMu({
      on: {
        spawn: () =>
          new Promise<MuResult>((res) => {
            releaseSpawn = res;
          }),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const { setStatus, ctx } = uiCtx();
    const call = tool(p).execute("a", { task: "one" }, undefined, undefined, ctx);
    await flush();
    // The spawn has not returned: the footer already shows the call.
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, "1 starting"]);
    releaseSpawn(ok({ ctl: "ok", nextSteps: [] }));
    await call;
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, "1 delegate running"]);
  });

  it("a spawn that fails while starting clears the footer", async () => {
    const mu = fakeMu({
      on: { spawn: () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    const { setStatus, ctx } = uiCtx();
    await expect(
      tool(p).execute("a", { task: "one" }, undefined, undefined, ctx),
    ).rejects.toThrow();
    expect(last(setStatus)).toEqual([DELEGATE_STATUS_KEY, undefined]);
  });

  it("works without a UI ctx (print mode, tests)", async () => {
    const p = fakePi();
    registerDelegate(p.pi, fakeMu().run);
    await expect(tool(p).execute("a", { task: "x" })).resolves.toBeDefined();
  });

  it("delegateStatus words the counts", () => {
    expect(delegateStatus(0)).toBeUndefined();
    expect(delegateStatus(1)).toBe("1 delegate running");
    expect(delegateStatus(3)).toBe("3 delegates running");
    expect(delegateStatus(0, 2)).toBe("2 starting");
    expect(delegateStatus(3, 1)).toBe("3 delegates running, 1 starting");
    expect(delegateStatus(16, 0, 4)).toBe("16 delegates running, 4 queued");
    expect(delegateStatus(2, 0, 0, 1)).toBe("2 delegates running, 1 failed");
  });
});

describe("delegateMessage", () => {
  it("words each CLI outcome", () => {
    expect(delegateMessage("d", { outcome: "done", lastText: "A" }, { closed: true })).toBe(
      "Delegate scratch/d finished. Pane closed.\n\nA",
    );
    expect(
      delegateMessage("d", { outcome: "empty", lastText: "" }, { closed: true }, { tail: "tail" }),
    ).toContain("without a text answer");
    const t = delegateMessage("d", { outcome: "timeout" }, { closed: false, why: "evidence" });
    expect(t).toContain("still running");
    expect(t).toContain("will not arrive here");
    expect(t).toContain("mu agent wait d -w scratch --json");
  });

  it("names the run time when given", () => {
    expect(
      delegateMessage(
        "d",
        { outcome: "done", lastText: "A" },
        { closed: true },
        { elapsedMs: 185_000 },
      ),
    ).toBe("Delegate scratch/d finished after 3m 05s. Pane closed.\n\nA");
  });

  it("formatElapsed", () => {
    expect(formatElapsed(42_400)).toBe("42s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});

describe("record", () => {
  const notes = (mu: ReturnType<typeof fakeMu>) =>
    mu.calls.filter((c) => c[0] === "task" && c[1] === "note");
  const settle = async () => {
    for (let i = 0; i < 6; i++) await flush();
  };
  const answer = [
    "I read src/x.ts.",
    "VERDICT: early draft",
    "more thinking",
    "VERDICT: CONFIRMED (sev med) src/x.ts:12 skips the check",
    "EVIDENCE: npm test -> 1 failed",
    "EVIDENCE: grep -n check src/x.ts -> nothing",
  ].join("\n");

  it("a done answer writes one note: REFUTER header, then the tail from the last VERDICT", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", {
      task: "refute f1",
      label: "ref1",
      record: { task: "f1", workstream: "audit" },
    });
    expect(mu.calls.find((c) => c[0] === "task" && c[1] === "show")).toEqual([
      "task",
      "show",
      "f1",
      "-w",
      "audit",
      "--json",
    ]);
    mu.waits.get("delegate-ref1")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    const ns = notes(mu);
    expect(ns).toHaveLength(1);
    const [, , id, w, ws, a, author, text = ""] = ns[0] ?? [];
    expect([id, w, ws, a, author]).toEqual(["f1", "-w", "audit", "--author", "delegate-ref1"]);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^REFUTER ref1 \(delegate-ref1, \d+s\):$/);
    expect(lines.slice(1)).toEqual([
      "VERDICT: CONFIRMED (sev med) src/x.ts:12 skips the check",
      "EVIDENCE: npm test -> 1 failed",
      "EVIDENCE: grep -n check src/x.ts -> nothing",
    ]);
    expect(sentText(p)).toContain("Recorded on audit/f1 as a note");
    expect(sentText(p)).toContain(answer); // the answer still arrives in full
  });

  it("a qualified ws/task names the workstream; the note goes there", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "audit/f2" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(notes(mu)[0]?.slice(0, 5)).toEqual(["task", "note", "f2", "-w", "audit"]);
  });

  it("an answer without a VERDICT line records its tail as NO VERDICT LINE", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "f1" } });
    const long = `${"a".repeat(3000)}END`;
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    await settle();
    const text = notes(mu)[0]?.at(-1) ?? "";
    const [head, second = "", ...rest] = text.split("\n");
    expect(head).toMatch(/^REFUTER r \(delegate-r, /);
    expect(second.startsWith("NO VERDICT LINE:")).toBe(true);
    const body = [second, ...rest].join("\n");
    expect(body.endsWith("END")).toBe(true);
    expect(body.length).toBeLessThan(1600);
    expect(notes(mu)[0]?.slice(2, 5)).toEqual(["f1", "-w", "crew"]);
  });

  it("caps a long verdict tail at about 4000 chars, marked [truncated]", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "f1" } });
    const long = `VERDICT: CONFIRMED\n${"EVIDENCE: x\n".repeat(800)}`;
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: long }] }));
    await settle();
    const text = notes(mu)[0]?.at(-1) ?? "";
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("[truncated]");
  });

  it.each(["timeout", "died", "empty", "error"])(
    "outcome %s records a no-verdict note",
    async (outcome) => {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("t", { task: "x", label: "r", record: { task: "f1" } });
      mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome, lastError: "overloaded" }] }));
      await settle();
      expect(notes(mu)).toHaveLength(1);
      expect(notes(mu)[0]?.at(-1)).toBe(`REFUTER r: no verdict (${outcome})`);
    },
  );

  it("a cancelled delegate records a no-verdict note", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "f1" } });
    await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "delegate-r" });
    expect(notes(mu)[0]?.at(-1)).toBe("REFUTER r: no verdict (cancelled)");
  });

  it("a done answer that is only whitespace records a no-verdict note (empty)", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "f1" } });
    mu.waits
      .get("delegate-r")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: " \n\t\n " }] }));
    await settle();
    expect(notes(mu)).toHaveLength(1);
    expect(notes(mu)[0]?.at(-1)).toBe("REFUTER r: no verdict (empty)");
  });

  it("cancelling a queued delegate records a no-verdict note on its task", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      await tool(p).execute("b", { task: "two", label: "r", record: { task: "f9" } });
      const c = await tool(p, DELEGATE_CANCEL_TOOL).execute("c", { name: "queued-1" });
      expect(notes(mu)).toEqual([
        [
          "task",
          "note",
          "f9",
          "-w",
          "crew",
          "--author",
          "queued-1",
          "REFUTER r: no verdict (cancelled)",
        ],
      ]);
      expect(c.content[0]?.text).toContain("never started. Recorded on crew/f9 as a note.");
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("an unknown task fails the call before anything spawns", async () => {
    const mu = fakeMu({
      task: {
        show: () =>
          Promise.resolve({
            code: 3,
            stdout: JSON.stringify({ error: "TaskNotFoundError", message: "no such task: nope" }),
            stderr: "",
          }),
      },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(
      tool(p).execute("t", { task: "x", record: { task: "nope", workstream: "audit" } }),
    ).rejects.toThrow(/record.*nope.*no such task/);
    expect(mu.calls.some((c) => c[1] === "spawn" || c[1] === "list")).toBe(false);
  });

  it("a record without a task name is refused", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await expect(tool(p).execute("t", { task: "x", record: {} })).rejects.toThrow(/record\.task/);
    expect(mu.calls).toHaveLength(0);
  });

  it("a failed note write still delivers the answer and says why recording failed", async () => {
    const mu = fakeMu({
      task: { note: () => Promise.resolve({ code: 1, stdout: "", stderr: "db locked" }) },
    });
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r", record: { task: "f1" } });
    mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(p.sendMessage).toHaveBeenCalledTimes(1);
    const text = sentText(p);
    expect(text).toContain(answer);
    expect(text).toMatch(/Recording on crew\/f1 failed.*db locked/);
    expect(text).not.toContain("Recorded on");
  });

  it("a queued delegate records too", async () => {
    process.env.MU_DELEGATE_MAX = "1";
    try {
      const mu = fakeMu();
      const p = fakePi();
      registerDelegate(p.pi, mu.run);
      await tool(p).execute("a", { task: "one" });
      const q = await tool(p).execute("b", { task: "two", label: "r", record: { task: "f9" } });
      expect(q.content[0]?.text).toContain("queued-1");
      mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: "y" }] }));
      await settle();
      expect(notes(mu)).toHaveLength(0); // the first had no record
      mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
      await settle();
      expect(notes(mu)).toHaveLength(1);
      expect(notes(mu)[0]?.slice(2, 5)).toEqual(["f9", "-w", "crew"]);
    } finally {
      const k = "MU_DELEGATE_MAX";
      delete process.env[k];
    }
  });

  it("without record, no task verb is called", async () => {
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x" });
    mu.waits.get("delegate-2")?.resolve(ok({ agents: [{ outcome: "done", lastText: answer }] }));
    await settle();
    expect(mu.calls.some((c) => c[0] === "task")).toBe(false);
    expect(sentText(p)).not.toContain("Recorded on");
  });
});

describe("labelStem", () => {
  it("makes a valid agent-name stem or nothing", () => {
    expect(labelStem("Review PR #12")).toBe("review-pr-12");
    expect(labelStem("  --  ")).toBeUndefined();
    expect(labelStem(7)).toBeUndefined();
    expect(labelStem("a".repeat(40))).toHaveLength(20);
    expect(labelStem("abcdefghijklmnopqrs-tuv")).toBe("abcdefghijklmnopqrs");
  });
});
