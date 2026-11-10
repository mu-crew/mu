// The AgentChannel contract (plugins spec D9, D16) run against the fake
// plugin's channel, as test/channel-contract.test.ts runs it against the
// built-ins: the declared capabilities, served by the registry under the
// channel's name and the readings' `plugin:<name>` source; reads through the
// one call path (readStates, baseline, receipt, lastRun) with runs and
// incarnation; a streaming watch (one per turn, a settled turn reported at once,
// `$/cancel {watchId}` on abort); runs dense (one more per settled turn); the
// deliveries' replies normalized (ChannelSendReply → today's SendResult); and
// the refusals of every capability it declares none.

import { describe, expect, it } from "vitest";
import {
  AgentAnswerUnsupportedError,
  AgentFreshNeedsCtlError,
  AgentSendUnsupportedError,
  AgentSteerUnsupportedError,
} from "../src/agents/errors.js";
import {
  agentChannel,
  channelNamed,
  channelTarget,
  deliver,
  readAgentStates,
  sentRun,
} from "../src/channels/index.js";
import { CLOUD, pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();

const live = async (config: Record<string, unknown> = {}) => {
  await h.setup({}, config);
  const a = await h.spawn();
  return { a, t: channelTarget(h.db, a) };
};

describe("the fake plugin's channel: the contract", () => {
  it("declares its capabilities once; the registry serves it by name and by its readings' source", async () => {
    const { t } = await live();
    const ch = agentChannel(t);
    expect(ch.name).toBe("cloud");
    expect(ch.caps).toEqual(CLOUD.caps);
    expect(ch.fence).toBe(false);
    expect(channelNamed("cloud")).toBe(ch);
    expect(channelNamed("plugin:fake")).toBe(ch);
  });

  it("reads: turn state with runs and incarnation, a baseline, exact receipts", async () => {
    const { a, t } = await live();
    const ch = agentChannel(t);
    expect((await readAgentStates([a], { db: h.db })).get("ws/w1")).toEqual({
      state: "needs_input",
      source: "plugin:fake",
      since: null,
      runs: 0,
      incarnation: "inc-1",
      alive: true,
    });
    expect(await ch.baseline(t)).toEqual({ runs: 0, incarnation: "inc-1" });
    const sent = await deliver(t, "one", { msgId: "m-1" });
    expect(sent.msgId).toBe("m-1");
    expect((await ch.receipt(t, "m-1")).state).toBe("accepted");
    expect((await ch.receipt(t, "m-other")).state).toBe("not-accepted");
  });

  it("a reply is normalized: its baseline is the wait's, its ack kept, --json today's SendResult", async () => {
    const { t } = await live();
    const sent = await deliver(t, "one", { msgId: "m-1" });
    expect(sent).toEqual({
      transport: "cloud",
      channelAck: "exact",
      runs: 0,
      incarnation: "inc-1",
      msgId: "m-1",
    });
    expect(sentRun(sent)).toEqual({ baseline: { runs: 0, incarnation: "inc-1" } });
  });

  it("watch streams: one settle per turn, runs dense, the settled turn's own text", async () => {
    const { t } = await live();
    const ch = agentChannel(t);
    for (const [i, text] of ["one", "two", "three"].entries()) {
      expect((await deliver(t, text, {})).runs).toBe(i);
      const w = await ch.watch(t, new AbortController().signal, { afterRuns: i });
      expect(await w?.settled).toMatchObject({
        settled: true,
        runs: i + 1,
        lastText: `done: ${text}`,
        status: "needs_input",
        source: "plugin:fake",
      });
    }
    // A turn past afterRuns that already settled is reported at once.
    const again = await ch.watch(t, new AbortController().signal, { afterRuns: 1 });
    expect(await again?.settled).toMatchObject({ settled: true, runs: 3 });
    expect((await ch.lastRun(t, { afterRuns: 2, ms: 2000 }))?.lastText).toBe("done: three");
    expect(await ch.lastRun(t, { afterRuns: 3, ms: 2000 })).toBeUndefined();
  });

  it("an aborted watch ends unknown and sends $/cancel {watchId}", async () => {
    const { t } = await live({ watchSilent: true });
    const stop = new AbortController();
    const w = await agentChannel(t).watch(t, stop.signal, {});
    stop.abort();
    expect((await w?.settled)?.status).toBe("unknown");
    expect(h.calls("$/cancel").some((c) => typeof c.params.watchId === "string")).toBe(true);
  });

  it("interrupt and abort (interrupt: exact) are effects; a busy turn is ended", async () => {
    const { t } = await live({ turnMs: 60_000 });
    const ch = agentChannel(t);
    await deliver(t, "long", {});
    const r = await ch.interrupt(t, "instead", { timeoutMs: 1000 });
    expect(r).toMatchObject({ transport: "cloud", wasBusy: true, runs: 1 });
    const ab = await ch.abort(t, { timeoutMs: 1000 });
    expect(ab).toMatchObject({ before: "busy", after: "idle", aborted: true, settled: true });
    expect(await ch.baseline(t)).toEqual({ runs: 2, incarnation: "inc-1" });
  });

  it("every capability it declares none refuses typed, nothing sent", async () => {
    const { t } = await live();
    const ch = agentChannel(t);
    await expect(deliver(t, "x", { mode: "steer" })).rejects.toBeInstanceOf(
      AgentSteerUnsupportedError,
    );
    await expect(deliver(t, "x", { fresh: true })).rejects.toBeInstanceOf(AgentFreshNeedsCtlError);
    await expect(ch.command(t, { name: "new" }, {})).rejects.toBeInstanceOf(
      AgentSendUnsupportedError,
    );
    await expect(ch.answer(t, ["1"], {})).rejects.toBeInstanceOf(AgentAnswerUnsupportedError);
    // fence none: a caller that needs a write guard is refused.
    await expect(deliver(t, "x", { ctlGuard: { beforeWrite: () => true } })).rejects.toBeInstanceOf(
      AgentSendUnsupportedError,
    );
    expect(h.calls("channel.send")).toHaveLength(0);
  });
});
