import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_CANCEL_TOOL,
  DELEGATE_TOOL,
  type DelegateCtx,
  type DelegateTool,
  delegateEnabled,
  delegateMessage,
  type MuResult,
  type MuRunner,
  registerDelegate,
} from "../extension/delegate.js";
import muPi from "../extension/mu-pi.js";

const ENV_KEYS = ["MU_MANAGED_AGENT", "MU_DELEGATE", "MU_MUX", "MU_CTL_SOCK"] as const;
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
function fakeMu(opts: { ctl?: string } = {}) {
  const calls: string[][] = [];
  const waits = new Map<string, Deferred>();
  const run: MuRunner = (args, signal) => {
    calls.push([...args]);
    const [ns, verb, name] = args;
    if (ns !== "agent") return Promise.resolve(ok(""));
    switch (verb) {
      case "list":
        return Promise.resolve(ok({ agents: [{ name: "delegate-1" }] }));
      case "spawn":
        return Promise.resolve(
          ok({
            ctl: opts.ctl ?? "ok",
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
  const pi = {
    registerTool: (t: DelegateTool) => {
      tools.set(t.name, t);
    },
    sendMessage,
    on: (_e: "session_shutdown", h: (e: unknown, c: DelegateCtx) => unknown) => {
      shutdown.push(h);
    },
  };
  return { pi, tools, sendMessage, shutdown };
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

describe("delegateMessage", () => {
  it("words each CLI outcome", () => {
    expect(delegateMessage("d", { outcome: "done", lastText: "A" }, { closed: true })).toBe(
      "Delegate scratch/d finished. Pane closed.\n\nA",
    );
    expect(
      delegateMessage("d", { outcome: "empty", lastText: "" }, { closed: true }, "tail"),
    ).toContain("without a text answer");
    const t = delegateMessage("d", { outcome: "timeout" }, { closed: false, why: "evidence" });
    expect(t).toContain("still running");
    expect(t).toContain("mu agent wait d -w scratch --json");
  });
});
