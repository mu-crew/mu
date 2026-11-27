// Edge cases from the release review (fix-mu-extension): a nested pi's inherited session id,
// an empty answer whose record failed, a settle that consumed an answer while its pane closed,
// and a session that shut down while a queued call was starting.

import { afterEach, describe, expect, it } from "vitest";
import { type MuResult, registerDelegate } from "../extension/delegate.js";
import { getDelegateCall, listDelegates } from "../src/delegates.js";
import {
  type FakeMu,
  failed,
  fakeMu,
  fakePi,
  flush,
  installDelegateEnv,
  ok,
  tool,
} from "./_delegate-fixtures.js";

installDelegateEnv();

const ticks = async (n = 8) => {
  for (let i = 0; i < n; i++) await flush();
};
const ctx = { sessionManager: { getSessionId: () => "s1" } };
const wakes = (p: ReturnType<typeof fakePi>) =>
  p.sendMessage.mock.calls.filter(
    (c) => (c[0] as { details?: { wake?: unknown } }).details?.wake !== undefined,
  );

/** A gate a fake verb waits on until `open()`. */
function gate() {
  let open = () => {};
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

/** `mu.run`, with the first call matching `hold` held until its gate opens. */
function holding(mu: FakeMu, hold: (args: readonly string[]) => boolean) {
  const g = gate();
  let held = false;
  const run = (args: readonly string[], ...rest: unknown[]): Promise<MuResult> => {
    const go = () => (mu.run as (...a: unknown[]) => Promise<MuResult>)(args, ...rest);
    if (!held && hold(args)) {
      held = true;
      return g.p.then(go);
    }
    return go();
  };
  return { run, open: g.open, held: () => held };
}

describe("a nested pi never takes its parent's PI_SESSION_ID", () => {
  const key = "PI_SESSION_ID";
  afterEach(() => {
    delete process.env[key];
  });

  it("a call with no session of its own registers under a local caller", async () => {
    process.env[key] = "parent";
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    await tool(p).execute("t", { task: "x", label: "r" });
    expect(listDelegates(mu.db)[0]?.caller).toMatch(/^pi:local-/);
  });

  it("session_start with no session of its own adopts nothing of the parent's", async () => {
    process.env[key] = "parent";
    const mu = fakeMu();
    const p = fakePi();
    registerDelegate(p.pi, mu.run);
    for (const h of p.handlers.get("session_start") ?? []) await h({}, {});
    expect(mu.calls.some((c) => c.includes("pi:parent"))).toBe(false);
  });
});

it("an empty answer whose record failed keeps its pane", async () => {
  const mu = fakeMu();
  const run = (args: readonly string[], ...rest: unknown[]): Promise<MuResult> =>
    args[0] === "delegates" && args[1] === "finish"
      ? Promise.resolve(failed(1, "Error", "disk full"))
      : (mu.run as (...a: unknown[]) => Promise<MuResult>)(args, ...rest);
  const p = fakePi();
  registerDelegate(p.pi, run);
  await tool(p).execute("t", { task: "x", label: "r" });
  mu.waits.get("delegate-r")?.resolve(ok({ agents: [{ outcome: "empty" }] }));
  await ticks();
  expect(mu.calls.some((c) => c[0] === "agent" && c[1] === "close")).toBe(false);
  expect(mu.registry.has("delegate-r")).toBe(true);
});

describe("a settle that consumed the answer while its pane closed", () => {
  async function closing() {
    const mu = fakeMu();
    // Hold the close preview: the answer is durable, its owed entry not yet made.
    const h = holding(mu, (a) => a[0] === "agent" && a[1] === "close");
    const p = fakePi();
    const handle = registerDelegate(p.pi, h.run);
    await tool(p).execute("t", { task: "x", label: "r" }, undefined, undefined, ctx);
    mu.waits
      .get("delegate-r")
      ?.resolve(ok({ agents: [{ outcome: "done", lastText: "the answer" }] }));
    await ticks();
    expect(h.held()).toBe(true);
    const callId = listDelegates(mu.db)[0]?.callId ?? "";
    return { mu, p, handle, callId, open: h.open };
  }

  it("shown by the settle: not owed after the close, no wake", async () => {
    const { p, handle, callId, open } = await closing();
    handle.delivered([callId]);
    open();
    await ticks();
    await new Promise((r) => setImmediate(r));
    expect(wakes(p)).toHaveLength(0);
  });

  it("a wait started after the finish found nothing owed: no wake", async () => {
    const { p, handle, open } = await closing();
    await new Promise((r) => setTimeout(r, 2));
    handle.delivered({ before: Date.now() });
    open();
    await ticks();
    await new Promise((r) => setImmediate(r));
    expect(wakes(p)).toHaveLength(0);
  });
});

describe("shutdown while a queued call starts", () => {
  const key = "MU_DELEGATE_MAX";

  it("drained before its row was durable: refused, never spawned, no follow-up", async () => {
    process.env[key] = "1";
    const mu = fakeMu();
    // The second register (the queued call) is held.
    let registers = 0;
    const h = holding(mu, (a) => a[0] === "delegates" && a[1] === "register" && ++registers === 2);
    const p = fakePi();
    registerDelegate(p.pi, h.run);
    await tool(p).execute("a", { task: "one", label: "a" }, undefined, undefined, ctx);
    const queued = tool(p).execute("b", { task: "two", label: "b" }, undefined, undefined, ctx);
    await ticks();
    // a answers: the slot frees and drain takes b off the queue, waiting for its row.
    mu.waits.get("delegate-a")?.resolve(ok({ agents: [{ outcome: "done", lastText: "A" }] }));
    await ticks();
    for (const s of p.shutdown) await s({ reason: "quit" }, { hasUI: false });
    const sent = p.sendMessage.mock.calls.length;
    h.open();
    await queued.catch(() => {});
    await ticks();
    expect(mu.calls.some((c) => c[1] === "spawn" && c[2] === "delegate-b")).toBe(false);
    const b = listDelegates(mu.db).find((c) => c.request.label === "b");
    expect(b?.state).toBe("refused");
    expect(p.sendMessage.mock.calls.length).toBe(sent);
  });

  it("shut down during its spawn: the pane is closed and the call cancelled", async () => {
    process.env[key] = "1";
    const mu = fakeMu();
    let spawns = 0;
    const h = holding(mu, (a) => a[0] === "agent" && a[1] === "spawn" && ++spawns === 2);
    const p = fakePi();
    registerDelegate(p.pi, h.run);
    await tool(p).execute("a", { task: "one", label: "a" }, undefined, undefined, ctx);
    await tool(p).execute("b", { task: "two", label: "b" }, undefined, undefined, ctx);
    mu.waits.get("delegate-a")?.resolve(ok({ agents: [{ outcome: "done", lastText: "A" }] }));
    await ticks();
    expect(h.held()).toBe(true);
    for (const s of p.shutdown) await s({ reason: "quit" }, { hasUI: false });
    h.open();
    await ticks(12);
    expect(mu.registry.has("delegate-b")).toBe(false); // its pane was closed
    const b = listDelegates(mu.db).find((c) => c.request.label === "b");
    expect(getDelegateCall(mu.db, b?.callId ?? "")?.state).toBe("cancelled");
    expect(mu.calls.some((c) => c[1] === "wait" && c[2] === "delegate-b")).toBe(false);
  });
});
