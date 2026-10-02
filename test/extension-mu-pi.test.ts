import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import muPi, { type MuPiContext } from "../extension/mu-pi.js";
import { ctlProbe, ctlRequest } from "../src/ctl/client.js";

type Handler = (event: unknown, ctx: MuPiContext) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sendUserMessage = vi.fn(async () => {});
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
  };
  const emit = async (event: string) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx);
  };
  return { pi, ctx, emit, sendUserMessage, handlers };
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

  it("session_shutdown removes the socket and is idempotent", async () => {
    await fake.emit("session_start");
    expect(existsSync(sock)).toBe(true);
    await fake.emit("session_shutdown");
    expect(existsSync(sock)).toBe(false);
    await fake.emit("session_shutdown");
  });
});
