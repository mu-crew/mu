import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MuRunner } from "../extension/delegate.js";
import muPi, {
  commandName,
  FRESH_COMMAND,
  LAST_TEXT_MAX_BYTES,
  LAST_TEXT_TRUNCATED,
  type MuPiCommandContext,
  type MuPiContext,
  promptsDir,
} from "../extension/mu-pi.js";
import { CtlUnknownOpError, ctlProbe, ctlRequest } from "../src/ctl/client.js";
import { CTL_OPS } from "../src/ctl/protocol.js";

type Handler = (event: unknown, ctx: MuPiContext) => unknown;

type Command = {
  description: string;
  handler: (a: string, c: MuPiCommandContext) => Promise<void>;
};

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const sendUserMessage = vi.fn(async (_t: string, _o?: unknown) => {});
  const ctx = {
    idle: true,
    isIdle: () => ctx.idle,
    hasPendingMessages: () => false,
    abort: vi.fn(),
  };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    sendUserMessage,
    registerCommand(name: string, c: Command) {
      commands.set(name, c);
    },
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn() },
  };
  const emit = async (event: string, extra: Record<string, unknown> = {}) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...extra }, ctx);
  };
  return { pi, ctx, emit, sendUserMessage, handlers, commands };
}

let dir: string;
let sock: string;
let fake: ReturnType<typeof fakePi>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mupi-"));
  sock = join(dir, "sub", "a.sock");
  process.env.MU_CTL_SOCK = sock;
  process.env.MU_MANAGED_AGENT = "1"; // spawn sets both; keeps mu_delegate out of these tests
  process.env.MU_AGENT_NAME = "worker-9";
  process.env.MU_WORKSTREAM = "ws";
  fake = fakePi();
  muPi(fake.pi);
});

afterEach(async () => {
  await fake.emit("session_shutdown");
  for (const k of ["MU_CTL_SOCK", "MU_MANAGED_AGENT", "MU_AGENT_NAME", "MU_WORKSTREAM"])
    delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

describe("mu pi extension", () => {
  it("serves no socket when MU_CTL_SOCK is unset (only prompts and the nudge)", async () => {
    const key = "MU_CTL_SOCK";
    delete process.env[key];
    const other = fakePi();
    muPi(other.pi);
    expect([...other.handlers.keys()].sort()).toEqual(
      ["agent_before_settle", "input", "resources_discover", "tool_call"].sort(),
    );
  });

  it("serves hello and status after session_start, socket mode 0600", async () => {
    await fake.emit("session_start");
    const hello = await ctlRequest(sock, { op: "hello" });
    expect(hello).toMatchObject({ v: 1, ok: true, agent: "worker-9", workstream: "ws" });
    // Run from source: ops reported, no build-time extVersion.
    expect(hello).toMatchObject({ ops: [...CTL_OPS] });
    expect(hello.ok && hello.extVersion).toBeUndefined();
    const probe = await ctlProbe(sock);
    expect(probe).toMatchObject({ kind: "ok", status: { state: "idle", runs: 0, pending: false } });
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });

  it("tracks busy / idle / runs from agent events", async () => {
    await fake.emit("session_start");
    await fake.emit("agent_start");
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ state: "busy", runs: 0 });
    await fake.emit("agent_settled");
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ state: "idle", runs: 1 });
  });

  it("send: plain when idle, followUp when busy, steer when asked", async () => {
    await fake.emit("session_start");
    expect(await ctlRequest(sock, { op: "send", text: "a" })).toMatchObject({ v: 1, ok: true });
    expect(fake.sendUserMessage).toHaveBeenLastCalledWith("a");
    fake.ctx.idle = false;
    await ctlRequest(sock, { op: "send", text: "b" });
    expect(fake.sendUserMessage).toHaveBeenLastCalledWith("b", { deliverAs: "followUp" });
    await ctlRequest(sock, { op: "send", text: "c", mode: "steer" });
    expect(fake.sendUserMessage).toHaveBeenLastCalledWith("c", { deliverAs: "steer" });
  });

  it("send replies with the status measured before dispatch (the wait baseline)", async () => {
    await fake.emit("session_start");
    // A run that starts and settles inside the dispatch must not move the baseline.
    fake.sendUserMessage.mockImplementationOnce(async () => {
      await fake.emit("agent_start");
      await fake.emit("agent_settled");
    });
    const r = await ctlRequest(sock, { op: "send", text: "a" });
    expect(r).toMatchObject({ v: 1, ok: true, state: "idle", runs: 0, pending: false });
    expect(r.ok && typeof r.since).toBe("number");
    expect(await ctlRequest(sock, { op: "wait", afterRuns: 0 })).toMatchObject({ runs: 1 });
  });

  it("wait {afterRuns:0} stays pending until agent_settled", async () => {
    await fake.emit("session_start");
    await fake.emit("agent_start");
    let settled = false;
    const p = ctlRequest(sock, { op: "wait", afterRuns: 0 }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    await fake.emit("agent_settled");
    expect(await p).toMatchObject({ v: 1, ok: true, state: "idle", runs: 1 });
  });

  it("wait {afterRuns:N} for a future N skips settles at or below N", async () => {
    await fake.emit("session_start");
    let settled = false;
    const p = ctlRequest(sock, { op: "wait", afterRuns: 1 }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 30));
    await fake.emit("agent_start");
    await fake.emit("agent_settled"); // runs 1: not past N
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    await fake.emit("agent_start");
    await fake.emit("agent_settled"); // runs 2
    expect(await p).toMatchObject({ v: 1, ok: true, state: "idle", runs: 2 });
  });

  it("wait resolves immediately when a run already settled past afterRuns", async () => {
    await fake.emit("session_start");
    await fake.emit("agent_start");
    await fake.emit("agent_settled");
    expect(await ctlRequest(sock, { op: "wait", afterRuns: 0 })).toMatchObject({ runs: 1 });
  });

  describe("lastText", () => {
    const assistant = (...content: unknown[]) => ({ role: "assistant", content });
    const run = async (messages: unknown[]) => {
      await fake.emit("agent_start");
      const p = ctlRequest(sock, { op: "wait", afterRuns: 0 });
      await new Promise((r) => setTimeout(r, 20));
      await fake.emit("agent_end", { messages });
      await fake.emit("agent_settled");
      return p;
    };

    it("wait carries the final assistant message's text parts only", async () => {
      await fake.emit("session_start");
      const r = await run([
        { role: "user", content: [{ type: "text", text: "q" }] },
        assistant({ type: "text", text: "early" }),
        assistant(
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "ans" },
          { type: "toolCall", id: "1", name: "bash", arguments: {} },
          { type: "text", text: "wer" },
        ),
      ]);
      expect(r).toMatchObject({ ok: true, runs: 1, lastText: "answer" });
      // An already-settled wait returns the same text.
      expect(await ctlRequest(sock, { op: "wait", afterRuns: 0 })).toMatchObject({
        lastText: "answer",
      });
    });

    it("is empty when the run ended with only tool calls or no agent_end", async () => {
      await fake.emit("session_start");
      const r = await run([assistant({ type: "toolCall", id: "1", name: "bash", arguments: {} })]);
      expect(r).toMatchObject({ ok: true, lastText: "" });
      await fake.emit("agent_start");
      const p = ctlRequest(sock, { op: "wait", afterRuns: 1 });
      await new Promise((r) => setTimeout(r, 20));
      await fake.emit("agent_settled");
      expect(await p).toMatchObject({ runs: 2, lastText: "" });
    });

    it("wait carries lastError when the run stopped on an API error, and drops it on the next clean run", async () => {
      await fake.emit("session_start");
      const r = await run([
        { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" },
      ]);
      expect(r).toMatchObject({ ok: true, lastText: "", lastError: "529 overloaded" });
      // A retry that recovered: the last agent_end is clean.
      await fake.emit("agent_start");
      const p = ctlRequest(sock, { op: "wait", afterRuns: 1 });
      await new Promise((r2) => setTimeout(r2, 20));
      await fake.emit("agent_end", { messages: [assistant({ type: "text", text: "ok" })] });
      await fake.emit("agent_settled");
      const clean = await p;
      expect(clean).toMatchObject({ lastText: "ok" });
      expect((clean as { lastError?: string }).lastError).toBeUndefined();
    });

    it("the last agent_end before the settle wins", async () => {
      await fake.emit("session_start");
      await fake.emit("agent_start");
      await fake.emit("agent_end", { messages: [assistant({ type: "text", text: "first" })] });
      await fake.emit("agent_end", { messages: [assistant({ type: "text", text: "second" })] });
      await fake.emit("agent_settled");
      expect(await ctlRequest(sock, { op: "wait", afterRuns: 0 })).toMatchObject({
        lastText: "second",
      });
    });

    it("caps a runaway answer at 64 KiB with the marker", async () => {
      await fake.emit("session_start");
      const r = await run([assistant({ type: "text", text: "x".repeat(70 * 1024) })]);
      const text = (r as { lastText?: string }).lastText ?? "";
      expect(text.endsWith(`\n${LAST_TEXT_TRUNCATED}`)).toBe(true);
      expect(text.length).toBe(LAST_TEXT_MAX_BYTES + 1 + LAST_TEXT_TRUNCATED.length);
    });
  });

  it("wait with timeoutMs replies timeout", async () => {
    await fake.emit("session_start");
    const r = await ctlRequest(sock, { op: "wait", afterRuns: 5, timeoutMs: 50 });
    expect(r).toEqual({ v: 1, ok: false, error: "timeout" });
  });

  it("abort calls ctx.abort", async () => {
    await fake.emit("session_start");
    expect(await ctlRequest(sock, { op: "abort" })).toMatchObject({ ok: true });
    expect(fake.ctx.abort).toHaveBeenCalledOnce();
  });

  describe("interrupt", () => {
    const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    const order: string[] = [];
    /** A busy pi whose abort settles the running turn ("old") on the next tick. */
    async function busyPi(settles = true): Promise<void> {
      order.length = 0;
      await fake.emit("session_start");
      await fake.emit("agent_start");
      fake.ctx.idle = false;
      fake.ctx.hasPendingMessages = () => true;
      fake.ctx.abort.mockImplementation(() => {
        order.push("abort");
        if (!settles) return;
        setTimeout(async () => {
          fake.ctx.idle = true;
          fake.ctx.hasPendingMessages = () => false;
          await fake.emit("agent_end", { messages: [assistant("old")] });
          order.push("settled");
          await fake.emit("agent_settled");
        }, 10);
      });
      fake.sendUserMessage.mockImplementation(async (t: string) => {
        order.push(`send:${t}`);
        fake.ctx.idle = false;
        await fake.emit("agent_start");
      });
    }

    it("busy: aborts, waits for settle, then sends the text as a new run", async () => {
      await busyPi();
      const r = await ctlRequest(sock, { op: "interrupt", text: "stop, do X" });
      expect(order).toEqual(["abort", "settled", "send:stop, do X"]);
      // A new run, not a queued follow-up or steer.
      expect(fake.sendUserMessage).toHaveBeenLastCalledWith("stop, do X");
      // runs: after the aborted run settled, before the send; pending: before the abort.
      expect(r).toMatchObject({ ok: true, wasBusy: true, pending: true, runs: 1 });
    });

    it("the returned runs is the wait baseline for the new run, not the aborted one", async () => {
      await busyPi();
      const r = await ctlRequest(sock, { op: "interrupt", text: "go" });
      const runs = (r as { runs?: number }).runs ?? -1;
      const p = ctlRequest(sock, { op: "wait", afterRuns: runs });
      await new Promise((res) => setTimeout(res, 20));
      await fake.emit("agent_end", { messages: [assistant("new")] });
      await fake.emit("agent_settled");
      expect(await p).toMatchObject({ ok: true, lastText: "new" });
    });

    it("idle: just sends", async () => {
      await fake.emit("session_start");
      const r = await ctlRequest(sock, { op: "interrupt", text: "hi" });
      expect(fake.ctx.abort).not.toHaveBeenCalled();
      expect(fake.sendUserMessage).toHaveBeenLastCalledWith("hi");
      expect(r).toMatchObject({ ok: true, wasBusy: false, pending: false, runs: 0 });
    });

    it("no settle within timeoutMs: replies timeout and sends nothing", async () => {
      await busyPi(false);
      const r = await ctlRequest(sock, { op: "interrupt", text: "x", timeoutMs: 50 });
      expect(r).toEqual({ v: 1, ok: false, error: "timeout" });
      expect(fake.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  it("rejects an unknown op and bad json without dying", async () => {
    await fake.emit("session_start");
    const err = await ctlRequest(sock, { op: "nope" } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CtlUnknownOpError);
    expect(err).toMatchObject({ op: "nope", ops: [...CTL_OPS] });
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ ok: true });
  });

  it("session_shutdown for a new session keeps the socket", async () => {
    await fake.emit("session_start");
    await fake.emit("session_shutdown", { reason: "new" });
    expect(existsSync(sock)).toBe(true);
  });

  it("session_shutdown removes the socket and is idempotent", async () => {
    await fake.emit("session_start");
    expect(existsSync(sock)).toBe(true);
    await fake.emit("session_shutdown");
    expect(existsSync(sock)).toBe(false);
    await fake.emit("session_shutdown");
  });

  describe("socket ownership", () => {
    const SHARED = Symbol.for("mu.pi.ctl");
    type G = { [SHARED]?: unknown };
    /** A second pi process: its own process-global state, same MU_CTL_SOCK. */
    function otherPi(run?: MuRunner) {
      const g = globalThis as G;
      const mine = g[SHARED];
      g[SHARED] = new Map();
      const other = fakePi();
      muPi(other.pi, run);
      g[SHARED] = mine;
      return other;
    }
    let stderr: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => stderr.mockRestore());

    it("a second pi leaves a live socket alone, and its quit does not delete it", async () => {
      await fake.emit("session_start");
      const ino = statSync(sock).ino;
      const nested = otherPi();
      await nested.emit("session_start");
      expect(statSync(sock).ino).toBe(ino);
      expect(String(stderr.mock.calls.at(-1)?.[0])).toMatch(/served by another pi/);
      expect(await ctlRequest(sock, { op: "hello" })).toMatchObject({ ok: true });
      // The nested pi has no server: its agent events never reach the socket.
      await nested.emit("agent_start");
      expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ state: "idle" });
      await nested.emit("session_shutdown", { reason: "quit" });
      expect(statSync(sock).ino).toBe(ino);
      expect(await ctlRequest(sock, { op: "hello" })).toMatchObject({ ok: true });
      // No temp names left behind in the socket dir.
      expect(readdirSync(dirname(sock))).toEqual(["a.sock"]);
    });

    /** A mu that says the parent agent owns an IN_PROGRESS task and dispatched an unrefuted one. */
    const busyMu = () =>
      vi.fn<MuRunner>(async (args) => {
        const [noun, verb] = args;
        if (noun === "task" && verb === "owned-by")
          return {
            code: 0,
            stdout: JSON.stringify({ items: [{ name: "t1", status: "IN_PROGRESS" }] }),
            stderr: "",
          };
        if (noun === "task" && verb === "notes")
          return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
        if (noun === "state")
          return {
            code: 0,
            stdout: JSON.stringify({ workstreamName: "ws", inProgress: [{ name: "t1" }] }),
            stderr: "",
          };
        return { code: 0, stdout: "", stderr: "" };
      });
    /** Run one prompt: input, a dispatching bash call, then settle; the settle results. */
    async function prompt(p: ReturnType<typeof fakePi>, ctx: object = p.ctx) {
      for (const h of p.handlers.get("input") ?? []) await h({ type: "input" }, p.ctx);
      const call = { toolName: "bash", input: { command: "mu task claim t2 -w ws --for w2" } };
      for (const h of p.handlers.get("tool_call") ?? []) await h(call, p.ctx);
      const out: unknown[] = [];
      for (const h of p.handlers.get("agent_before_settle") ?? [])
        out.push(
          await h({ type: "agent_before_settle", outcome: "completed" }, ctx as MuPiContext),
        );
      return out.filter((r) => r !== undefined);
    }
    const types = (rs: unknown[]) =>
      rs.flatMap((r) =>
        (r as { entries: { customType: string }[] }).entries.map((e) => e.customType),
      );

    it("a nested pi (socket already live) gets no close, refute or keep-driving nudge", async () => {
      await fake.emit("session_start");
      const run = busyMu();
      const nested = otherPi(run);
      await nested.emit("session_start");
      expect(await prompt(nested)).toEqual([]);
      expect(run).not.toHaveBeenCalled();
      expect(String(stderr.mock.calls.at(-1)?.[0])).toMatch(/nested pi: mu agent features off/);
    });

    /** Another runtime in THIS process (pi's /reload re-runs the factory). */
    function samePi(run: MuRunner) {
      const p = fakePi();
      muPi(p.pi, run);
      return p;
    }

    it("the agent pi (binds the socket) keeps its nudges, also after reload", async () => {
      const run = busyMu();
      const agent = samePi(run);
      await agent.emit("session_start");
      const all = ["mu-close-task", "mu-keep-driving", "mu-refute-brief"];
      expect(types(await prompt(agent)).sort()).toEqual(all);
      await agent.emit("session_shutdown", { reason: "reload" });
      const reloaded = samePi(run);
      await reloaded.emit("session_start", { reason: "reload" });
      expect(types(await prompt(reloaded)).sort()).toEqual(all);
    });

    it("a pi with no MU_CTL_SOCK (orchestrator) keeps all three nudges", async () => {
      const key = "MU_CTL_SOCK";
      delete process.env[key];
      const orch = samePi(busyMu());
      await orch.emit("session_start");
      const all = ["mu-close-task", "mu-keep-driving", "mu-refute-brief"];
      expect(types(await prompt(orch, { ...orch.ctx, hasUI: true })).sort()).toEqual(all);
    });

    it("a plain pi (no MU_CTL_SOCK, no MU_AGENT_NAME) keeps keep-driving and refute", async () => {
      for (const k of ["MU_CTL_SOCK", "MU_AGENT_NAME"]) delete process.env[k];
      const run = busyMu();
      const plain = samePi(run);
      await plain.emit("session_start");
      const rs = await prompt(plain, { ...plain.ctx, hasUI: true });
      expect(types(rs).sort()).toEqual(["mu-keep-driving", "mu-refute-brief"]);
      expect(run).toHaveBeenCalledWith(expect.arrayContaining(["notes"]));
    });

    it("no UI (pi -p, json): no close or refute nudge, keep-driving stays", async () => {
      const agent = samePi(busyMu());
      await agent.emit("session_start");
      const rs = await prompt(agent, { ...agent.ctx, hasUI: false, mode: "print" });
      expect(types(rs)).toEqual(["mu-keep-driving"]);
    });

    it("session_start rebinds a server whose socket file was deleted", async () => {
      await fake.emit("session_start");
      await fake.emit("agent_start");
      rmSync(sock);
      await fake.emit("session_start", { reason: "reload" });
      // Same process-global state: the run in flight is still reported.
      expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ state: "busy" });
    });

    it("quit leaves a path another pi took over", async () => {
      await fake.emit("session_start");
      rmSync(sock);
      const other = otherPi();
      await other.emit("session_start");
      const ino = statSync(sock).ino;
      await fake.emit("session_shutdown", { reason: "quit" });
      expect(statSync(sock).ino).toBe(ino);
      expect(await ctlRequest(sock, { op: "hello" })).toMatchObject({ ok: true });
      await other.emit("session_shutdown", { reason: "quit" });
      expect(existsSync(sock)).toBe(false);
    });

    it("takes over a stale socket file nobody serves", async () => {
      mkdirSync(dirname(sock), { recursive: true });
      const dead = createServer();
      await new Promise<void>((r) => dead.listen(sock, r));
      // Close without libuv's unlink: keep the file, drop the listener.
      const ino = statSync(sock).ino;
      const keep = join(dir, "keep");
      rmSync(keep, { force: true });
      linkSync(sock, keep);
      await new Promise<void>((r) => dead.close(() => r()));
      renameSync(keep, sock);
      expect(statSync(sock).ino).toBe(ino);
      await fake.emit("session_start");
      expect(statSync(sock).ino).not.toBe(ino);
      expect(await ctlRequest(sock, { op: "hello" })).toMatchObject({ ok: true });
    });
  });

  describe("fresh", () => {
    /**
     * Wire the fake like pi: sendUserMessage("/mu-fresh") runs the command;
     * newSession replaces the runtime (shutdown reason new, factory re-run,
     * session_start) and calls withSession, whose send starts a run.
     */
    function wirePi(opts: { startRun?: boolean } = {}) {
      const prompts: string[] = [];
      let current = fake;
      fake.sendUserMessage.mockImplementation(async (text: string) => {
        if (text !== `/${FRESH_COMMAND}`) return;
        const cmd = current.commands.get(FRESH_COMMAND);
        if (!cmd) throw new Error("command not registered");
        const cctx: MuPiCommandContext = {
          ...current.ctx,
          reload: async () => {},
          compact: () => {},
          newSession: async (o) => {
            await current.emit("session_shutdown", { reason: "new" });
            const next = fakePi();
            next.sendUserMessage.mockImplementation(
              fake.sendUserMessage.getMockImplementation() ?? (async () => {}),
            );
            muPi(next.pi);
            current = next;
            await next.emit("session_start", { reason: "new" });
            await o?.withSession?.({
              ...next.ctx,
              sendUserMessage: async (t: string) => {
                prompts.push(t);
                if (opts.startRun !== false) {
                  next.ctx.idle = false;
                  await next.emit("agent_start");
                }
              },
            });
            return { cancelled: false };
          },
        };
        void cmd.handler("", cctx);
      });
      return { prompts, now: () => current };
    }

    afterEach(async () => {
      // The replaced runtimes share one server; quit tears it down.
      await fake.emit("session_shutdown", { reason: "quit" });
    });

    it("registers the internal command and triggers it with expandPromptTemplates", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      expect(fake.commands.has(FRESH_COMMAND)).toBe(true);
      const r = await ctlRequest(sock, { op: "fresh", text: "hello" });
      expect(fake.sendUserMessage).toHaveBeenCalledWith(`/${FRESH_COMMAND}`, {
        expandPromptTemplates: true,
      });
      expect(w.prompts).toEqual(["hello"]);
      // Replied once the NEW session's run started.
      expect(r).toMatchObject({ v: 1, ok: true, state: "busy" });
    });

    it("keeps the socket across the session swap and serves the new runtime", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      await ctlRequest(sock, { op: "fresh", text: "a" });
      expect(existsSync(sock)).toBe(true);
      await w.now().emit("agent_settled");
      expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ state: "idle", runs: 1 });
      w.now().ctx.idle = true;
      await ctlRequest(sock, { op: "fresh", text: "b" });
      expect(w.prompts).toEqual(["a", "b"]);
    });

    it("refuses while busy unless force", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      fake.ctx.idle = false;
      await fake.emit("agent_start");
      expect(await ctlRequest(sock, { op: "fresh", text: "x" })).toEqual({
        v: 1,
        ok: false,
        error: "busy",
      });
      expect(w.prompts).toEqual([]);
      expect(await ctlRequest(sock, { op: "fresh", text: "y", force: true })).toMatchObject({
        ok: true,
      });
      expect(w.prompts).toEqual(["y"]);
    });

    it("replies ok when the send resolves without a run", async () => {
      await fake.emit("session_start");
      const w = wirePi({ startRun: false });
      expect(await ctlRequest(sock, { op: "fresh", text: "z" })).toMatchObject({ ok: true });
      expect(w.prompts).toEqual(["z"]);
    });

    it("the command typed by hand with nothing queued is a no-op", async () => {
      await fake.emit("session_start");
      const cmd = fake.commands.get(FRESH_COMMAND);
      const newSession = vi.fn();
      await cmd?.handler("", { ...fake.ctx, newSession } as unknown as MuPiCommandContext);
      expect(newSession).not.toHaveBeenCalled();
    });
  });

  describe("command", () => {
    /**
     * Wire the fake like pi: sendUserMessage("/mu-<name>") runs that
     * command with a command context whose reload / compact / newSession
     * behave like pi's (reload re-runs the factory, then session_start
     * reason reload; compact emits session_before_compact or errors).
     */
    function wirePi(opts: { compactError?: string; reloadRefuses?: boolean } = {}) {
      const calls: string[] = [];
      let current = fake;
      const impl = async (text: string) => {
        const cmd = [...current.commands.entries()].find(([n]) => text === `/${n}`)?.[1];
        if (!cmd) return;
        const cctx: MuPiCommandContext = {
          ...current.ctx,
          newSession: async () => {
            calls.push("newSession");
            await current.emit("session_shutdown", { reason: "new" });
            const next = fakePi();
            next.sendUserMessage.mockImplementation(impl);
            muPi(next.pi);
            current = next;
            await next.emit("session_start", { reason: "new" });
            return { cancelled: false };
          },
          reload: async () => {
            calls.push("reload");
            if (opts.reloadRefuses) return;
            await current.emit("session_shutdown", { reason: "reload" });
            const next = fakePi();
            next.sendUserMessage.mockImplementation(impl);
            muPi(next.pi);
            current = next;
            await next.emit("session_start", { reason: "reload" });
          },
          compact: (o) => {
            calls.push(`compact:${o?.customInstructions ?? ""}`);
            void (async () => {
              if (opts.compactError) {
                o?.onError?.(new Error(opts.compactError));
                return;
              }
              await current.emit("session_before_compact");
            })();
          },
        };
        void cmd.handler("", cctx);
      };
      fake.sendUserMessage.mockImplementation(impl);
      return { calls, now: () => current };
    }

    afterEach(async () => {
      await fake.emit("session_shutdown", { reason: "quit" });
    });

    it("registers mu-new / mu-reload / mu-compact and dispatches them with expandPromptTemplates", async () => {
      await fake.emit("session_start");
      wirePi();
      for (const n of ["new", "reload", "compact"] as const) {
        expect(fake.commands.has(commandName(n))).toBe(true);
      }
      await ctlRequest(sock, { op: "command", name: "reload" });
      expect(fake.sendUserMessage).toHaveBeenCalledWith("/mu-reload", {
        expandPromptTemplates: true,
      });
    });

    it("new: ctx.newSession, replies ok, socket survives", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      expect(await ctlRequest(sock, { op: "command", name: "new" })).toMatchObject({
        v: 1,
        ok: true,
      });
      expect(w.calls).toEqual(["newSession"]);
      expect(await ctlRequest(sock, { op: "status" })).toMatchObject({ ok: true });
    });

    it("reload: ctx.reload, replies after session_start reason reload", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      expect(await ctlRequest(sock, { op: "command", name: "reload" })).toMatchObject({ ok: true });
      expect(w.calls).toEqual(["reload"]);
      expect(await ctlRequest(sock, { op: "hello" })).toMatchObject({ ok: true });
    });

    it("reload that pi refuses quietly replies an error", async () => {
      await fake.emit("session_start");
      wirePi({ reloadRefuses: true });
      expect(await ctlRequest(sock, { op: "command", name: "reload" })).toMatchObject({
        ok: false,
        error: expect.stringContaining("did not reload"),
      });
    });

    it("compact: passes instructions, replies when compaction starts", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      expect(
        await ctlRequest(sock, { op: "command", name: "compact", instructions: "keep the API" }),
      ).toMatchObject({ ok: true });
      expect(w.calls).toEqual(["compact:keep the API"]);
    });

    it("compact: pi's error (Nothing to compact) is the reply", async () => {
      await fake.emit("session_start");
      wirePi({ compactError: "Nothing to compact (session too small)" });
      expect(await ctlRequest(sock, { op: "command", name: "compact" })).toEqual({
        v: 1,
        ok: false,
        error: "Nothing to compact (session too small)",
      });
    });

    it("refuses while busy unless force", async () => {
      await fake.emit("session_start");
      const w = wirePi();
      fake.ctx.idle = false;
      await fake.emit("agent_start");
      expect(await ctlRequest(sock, { op: "command", name: "new" })).toEqual({
        v: 1,
        ok: false,
        error: "busy",
      });
      expect(w.calls).toEqual([]);
      expect(await ctlRequest(sock, { op: "command", name: "new", force: true })).toMatchObject({
        ok: true,
      });
      expect(w.calls).toEqual(["newSession"]);
    });

    it("rejects an unknown command name", async () => {
      await fake.emit("session_start");
      wirePi();
      expect(await ctlRequest(sock, { op: "command", name: "tree" } as never)).toMatchObject({
        ok: false,
        error: "command must be one of new, reload, compact",
      });
    });

    it("the command typed by hand with nothing queued is a no-op", async () => {
      await fake.emit("session_start");
      const cmd = fake.commands.get(commandName("reload"));
      const reload = vi.fn();
      await cmd?.handler("", { ...fake.ctx, reload } as unknown as MuPiCommandContext);
      expect(reload).not.toHaveBeenCalled();
    });
  });
});

describe("recipe prompt templates", () => {
  it("serves every prompts/*.md through resources_discover", async () => {
    const h = fake.handlers.get("resources_discover") ?? [];
    expect(h).toHaveLength(1);
    const handler = h[0];
    if (!handler) throw new Error("unreachable");
    const r = (await handler(
      { type: "resources_discover", cwd: dir, reason: "startup" },
      fake.ctx,
    )) as {
      promptPaths?: string[];
    };
    const names = (r.promptPaths ?? []).map((p) => p.split("/").pop());
    expect(names).toContain("ultrathink.md");
    expect(names).toEqual(
      readdirSync(join(import.meta.dirname, "..", "prompts"))
        .filter((f) => f.endsWith(".md"))
        .sort(),
    );
  });

  it("finds prompts/ from both the source and the built layout", () => {
    const root = join(import.meta.dirname, "..");
    const want = join(root, "prompts");
    expect(promptsDir(`file://${join(root, "extension", "mu-pi.ts")}`)).toBe(want);
    expect(promptsDir(`file://${join(root, "dist", "extension", "mu-pi.js")}`)).toBe(want);
    expect(promptsDir("not-a-url")).toBeUndefined();
  });

  // pi parses the frontmatter as YAML: an unquoted value containing
  // ": " is a nested mapping, and pi drops the template (it did).
  it("every template's frontmatter values are YAML-safe", () => {
    const root = join(import.meta.dirname, "..");
    for (const f of readdirSync(join(root, "prompts"))) {
      const text = readFileSync(join(root, "prompts", f), "utf8");
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
      expect(front, f).toBeDefined();
      for (const line of (front ?? "").split("\n")) {
        const value = line.slice(line.indexOf(":") + 1).trim();
        const quoted = value.startsWith('"') && value.endsWith('"');
        expect(quoted || !value.includes(": "), `${f}: ${line}`).toBe(true);
      }
    }
  });

  // Same trap for the skill: an unquoted `description:` containing ": "
  // made pi report "Nested mappings are not allowed" and drop mu (3.8.0).
  it("the mu skill's frontmatter values are YAML-safe", () => {
    const root = join(import.meta.dirname, "..");
    const text = readFileSync(join(root, "skills", "mu", "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
    expect(front).toBeDefined();
    for (const line of (front ?? "").split("\n")) {
      if (/^\s/.test(line)) continue; // continuation of a block scalar
      const value = line.slice(line.indexOf(":") + 1).trim();
      const safe =
        (value.startsWith('"') && value.endsWith('"')) ||
        /^[>|][-+]?$/.test(value) ||
        !value.includes(": ");
      expect(safe, line).toBe(true);
    }
  });

  it("every template points at a recipe that exists", () => {
    const root = join(import.meta.dirname, "..");
    for (const f of readdirSync(join(root, "prompts"))) {
      const text = readFileSync(join(root, "prompts", f), "utf8");
      const m = /recipes\/([a-z-]+\.md)/.exec(text);
      expect(m, f).not.toBeNull();
      expect(existsSync(join(root, "skills", "mu", "recipes", m?.[1] ?? "")), f).toBe(true);
    }
  });
});
