// The extension's `model` op: pi's setModel / setThinkingLevel, never a
// typed `/model`; status reports the session's model and thinking level.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import muPi, { type MuPiContext } from "../extension/mu-pi.js";
import { ctlRequest } from "../src/ctl/client.js";
import { CTL_OPS, INCARNATION_MISMATCH, parseModelRef } from "../src/ctl/protocol.js";

type Handler = (event: unknown, ctx: MuPiContext) => unknown;
type Model = { provider: string; id: string };

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const catalogue: Model[] = [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "openrouter", id: "meta/llama-4" },
  ];
  const state = { model: catalogue[0] as Model | undefined, level: "medium", auth: true };
  const ctx = {
    idle: true,
    isIdle: () => ctx.idle,
    hasPendingMessages: () => false,
    abort: vi.fn(),
    get model() {
      return state.model;
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        catalogue.find((m) => m.provider === provider && m.id === id),
    },
  };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    sendUserMessage: vi.fn(async () => {}),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn() },
    setModel: vi.fn(async (m: Model) => {
      if (!state.auth) return false;
      state.model = m;
      return true;
    }),
    getThinkingLevel: () => state.level,
    // pi clamps: the haiku stand-in has no xhigh.
    setThinkingLevel: vi.fn((l: string) => {
      state.level = l === "xhigh" && state.model?.id === "claude-haiku-4-5" ? "high" : l;
    }),
  };
  const emit = async (event: string, extra: Record<string, unknown> = {}) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...extra }, ctx);
  };
  return { pi, ctx, emit, state };
}

let dir: string;
let sock: string;
let fake: ReturnType<typeof fakePi>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mupim-"));
  sock = join(dir, "a.sock");
  process.env.MU_CTL_SOCK = sock;
  process.env.MU_MANAGED_AGENT = "1";
  fake = fakePi();
  muPi(fake.pi as never);
  await fake.emit("session_start");
});

afterEach(async () => {
  await fake.emit("session_shutdown");
  for (const k of ["MU_CTL_SOCK", "MU_MANAGED_AGENT"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

describe("protocol", () => {
  it("serves model; parseModelRef splits at the first slash", () => {
    expect(CTL_OPS).toContain("model");
    expect(parseModelRef("openrouter/meta/llama-4")).toEqual({
      provider: "openrouter",
      id: "meta/llama-4",
    });
    for (const bad of ["claude", "/x", "x/", ""]) expect(parseModelRef(bad)).toBeUndefined();
  });
});

describe("model op", () => {
  it("status reports the model and thinking level", async () => {
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({
      ok: true,
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "medium",
    });
  });

  it("switches model and effort through pi's API, not a slash command", async () => {
    const r = await ctlRequest(sock, {
      op: "model",
      model: "anthropic/claude-haiku-4-5",
      effort: "low",
    });
    expect(r).toMatchObject({
      ok: true,
      model: "anthropic/claude-haiku-4-5",
      thinkingLevel: "low",
    });
    expect(fake.pi.setThinkingLevel).toHaveBeenCalledWith("low");
    expect(fake.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({
      model: "anthropic/claude-haiku-4-5",
    });
  });

  it("works while busy and reports the clamped level; no effort leaves it alone", async () => {
    fake.ctx.idle = false;
    expect(
      await ctlRequest(sock, { op: "model", model: "anthropic/claude-haiku-4-5", effort: "xhigh" }),
    ).toMatchObject({ ok: true, thinkingLevel: "high" });
    fake.pi.setThinkingLevel.mockClear();
    expect(await ctlRequest(sock, { op: "model", model: "openrouter/meta/llama-4" })).toMatchObject(
      { ok: true, model: "openrouter/meta/llama-4" },
    );
    expect(fake.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("refuses a bad ref, an unknown model, a bad effort and a provider without auth", async () => {
    const ask = (req: Record<string, unknown>) =>
      ctlRequest(sock, { op: "model", ...req } as never);
    expect(await ask({ model: "claude" })).toMatchObject({
      ok: false,
      error: "model needs a string <provider>/<id>",
    });
    expect(await ask({ model: "anthropic/nope" })).toMatchObject({
      ok: false,
      error: "unknown model anthropic/nope",
    });
    expect(await ask({ model: "anthropic/claude-haiku-4-5", effort: "huge" })).toMatchObject({
      ok: false,
      error: "effort must be one of off, minimal, low, medium, high, xhigh, max",
    });
    fake.state.auth = false;
    expect(await ask({ model: "anthropic/claude-haiku-4-5" })).toMatchObject({
      ok: false,
      error: "no auth configured for anthropic",
    });
    expect(fake.state.model?.id).toBe("claude-sonnet-4-5");
  });

  it("refuses another incarnation before switching", async () => {
    expect(
      await ctlRequest(sock, {
        op: "model",
        model: "anthropic/claude-haiku-4-5",
        expectIncarnation: "old-proc",
      }),
    ).toMatchObject({ ok: false, error: INCARNATION_MISMATCH });
    expect(fake.pi.setModel).not.toHaveBeenCalled();
  });
});

describe("stale ctx", () => {
  it("status fails closed to busy when pi throws on read", async () => {
    fake.pi.getThinkingLevel = () => {
      throw new Error("stale");
    };
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({
      ok: true,
      state: "busy",
      pending: false,
    });
  });

  it("a session-switch shutdown drops the old ctx, so status never reads it", async () => {
    fake.ctx.hasPendingMessages = () => {
      throw new Error("stale");
    };
    await fake.emit("session_shutdown", { reason: "new" });
    expect(await ctlRequest(sock, { op: "status" })).toMatchObject({
      ok: true,
      state: "idle",
      pending: false,
    });
  });
});
