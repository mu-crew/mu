import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import muPi, {
  FRESH_COMMAND,
  type MuPiCommandContext,
  type MuPiContext,
} from "../extension/mu-pi.js";
import { ctlProbe, ctlRequest } from "../src/ctl/client.js";

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
  process.env.MU_AGENT_NAME = "worker-9";
  process.env.MU_WORKSTREAM = "ws";
  fake = fakePi();
  muPi(fake.pi);
});

afterEach(async () => {
  await fake.emit("session_shutdown");
  for (const k of ["MU_CTL_SOCK", "MU_AGENT_NAME", "MU_WORKSTREAM"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

describe("mu pi extension", () => {
  it("is a no-op when MU_CTL_SOCK is unset", async () => {
    const key = "MU_CTL_SOCK";
    delete process.env[key];
    const other = fakePi();
    muPi(other.pi);
    expect(other.handlers.size).toBe(0);
  });

  it("serves hello and status after session_start, socket mode 0600", async () => {
    await fake.emit("session_start");
    const hello = await ctlRequest(sock, { op: "hello" });
    expect(hello).toMatchObject({ v: 1, ok: true, agent: "worker-9", workstream: "ws" });
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

  it("wait resolves immediately when a run already settled past afterRuns", async () => {
    await fake.emit("session_start");
    await fake.emit("agent_start");
    await fake.emit("agent_settled");
    expect(await ctlRequest(sock, { op: "wait", afterRuns: 0 })).toMatchObject({ runs: 1 });
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

  it("rejects an unknown op and bad json without dying", async () => {
    await fake.emit("session_start");
    const r = await ctlRequest(sock, { op: "nope" } as never);
    expect(r).toMatchObject({ v: 1, ok: false });
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
      await cmd?.handler("", { ...fake.ctx, newSession } as MuPiCommandContext);
      expect(newSession).not.toHaveBeenCalled();
    });
  });
});
