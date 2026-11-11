// Unresolved plugin effects that once had no way out (the final refutation of the
// plugins run, orchestrator rulings 1-3), over the fake plugin as a provider:
//   1. an unknown-outcome channel delivery is resolved by `mu agent check` through
//      the rule table (an exact receipt settles it), and dropped, its loss logged,
//      when its agent's row goes: it never blocks `mu plugin rm` for good;
//   2. reattaching a detached view moves the spawn receipts with the row's pane:
//      a replay still names the same incarnation, never "replaced";
//   3. an at-start `job.start` carrying the first prompt is the agent's first
//      delivery (seq 1): a newer delivery bars its deduped resend, and a new
//      delivery refuses while it is being resolved (D4, K8).

import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { getReceipt } from "../src/agents/receipts.js";
import { resolveFirstTurn } from "../src/agents/spawn-plugin.js";
import { savedIdentity, spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent } from "../src/agents.js";
import { channelTarget, deliver } from "../src/channels/index.js";
import { cmdAgentCheck } from "../src/cli/agents.js";
import { DeliveryResolvingError, effectOwner } from "../src/effects.js";
import { drainHost, releaseHost } from "../src/host-lifecycle.js";
import { listLogs } from "../src/logs.js";
import { EffectOutcomeUnknownError } from "../src/plugins/errors.js";
import { removePlugin } from "../src/plugins/registry.js";
import { addTask } from "../src/tasks/edit.js";
import { taskIdFor } from "../src/tasks.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const effects = () =>
  h.db.prepare("SELECT key, method, state, seq FROM effects ORDER BY created_at").all() as Array<{
    key: string;
    method: string;
    state: string;
    seq: number | null;
  }>;
/** The effect rows' writer and plugin group are gone (a crashed creator). */
const writerGone = () => {
  const dead = spawnSync("true").pid;
  h.db
    .prepare("UPDATE effects SET creator_pid = ?, creator_start = NULL, plugin_pgid = ?")
    .run(dead, dead);
  h.db.prepare("UPDATE carrier_jobs SET creator_pid = ?, creator_start = NULL").run(dead);
};

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => log.mockRestore());

describe("ruling 1: an unknown plugin delivery has a way out", () => {
  const unknownSend = async () => {
    await h.setup();
    const a = await h.spawn();
    h.f.set({ faults: { "channel.send": ["unknown-outcome"] } });
    await expect(deliver(channelTarget(h.db, a), "x", { msgId: "m-1" })).rejects.toBeInstanceOf(
      EffectOutcomeUnknownError,
    );
    h.f.set({ faults: {} });
    expect(effects()).toMatchObject([{ key: "delivery:m-1", state: "unknown" }]);
    expect(() => removePlugin(h.db, "fake")).toThrow(/effect delivery:m-1/);
    return a;
  };

  it("mu agent check resolves it by the exact receipt: the row goes", async () => {
    await unknownSend();
    h.f.set({ receiptAnswer: { state: "accepted", id: "m-1" } });
    await cmdAgentCheck(h.db, "w1", "m-1", { workstream: "ws" });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^accepted/));
    expect(effects()).toEqual([]);
  });

  it("a receipt that does not accept leaves it unknown, and check says so", async () => {
    await unknownSend();
    await expect(cmdAgentCheck(h.db, "w1", "m-1", { workstream: "ws" })).rejects.toThrow();
    expect(log).toHaveBeenCalledWith("not-accepted");
    expect(effects()).toMatchObject([{ key: "delivery:m-1", state: "unknown" }]);
  });

  it("a task spawn's replay resolves its unknown first send by the rule table", async () => {
    await h.setup();
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    const req = {
      spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
      task: "t1",
      text: "go",
    };
    h.f.set({ faults: { "channel.send": ["unknown-outcome"] } });
    expect((await spawnForTask(h.db, req)).state).toBe("unknown");
    const msgId = getReceipt(h.db, taskIdFor(h.db, "t1", "ws") ?? -1, "manual:t1")?.msgId;
    expect(effects()).toMatchObject([{ key: `delivery:${msgId}`, state: "unknown" }]);
    h.f.set({ faults: {}, receiptAnswer: { state: "accepted", id: msgId } });
    expect(await spawnForTask(h.db, req)).toMatchObject({ state: "sent", replay: true });
    expect(effects()).toEqual([]);
  });

  it("closing the agent drops it with the loss logged; plugin rm then goes through", async () => {
    await unknownSend();
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(effects()).toEqual([]);
    const lost = listLogs(h.db, { workstream: "ws" }).map((l) => l.payload);
    expect(lost.join("\n")).toMatch(
      /delivery outcome lost with agent w1: channel\.send delivery:m-1/,
    );
    await drainHost(h.db, "box");
    await releaseHost(h.db, "box");
    expect(() => removePlugin(h.db, "fake")).not.toThrow();
  });
});

describe("ruling 2: a detached view's reattach moves the spawn receipts", () => {
  it("a replay after the reattach names the same incarnation, never replaced", async () => {
    await h.setup({ view: "detached" });
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    const req = {
      spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
      task: "t1",
      text: "go",
    };
    expect((await spawnForTask(h.db, req)).state).toBe("sent");
    const tid = taskIdFor(h.db, "t1", "ws") ?? -1;
    const a = getAgent(h.db, "w1", "ws");
    if (a === undefined) throw new Error("no agent");
    h.panes.delete(a.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
    const now = getAgent(h.db, "w1", "ws");
    expect(now?.paneId).not.toBe(a.paneId);
    const rec = getReceipt(h.db, tid, "manual:t1");
    if (rec === undefined) throw new Error("no receipt");
    expect(rec.paneId).toBe(now?.paneId);
    expect(savedIdentity(h.db, rec)).toEqual({ agent: now });
    const replay = await spawnForTask(h.db, req);
    expect(replay).toMatchObject({ state: "sent", replay: true });
  });
});

describe("ruling 3: an at-start job.start is the agent's first delivery", () => {
  const unknownStart = async () => {
    await h.setup({
      firstTurn: "at-start",
      start: { lookup: false, fenceKey: false, dedupe: { exact: true, windowMs: 60_000 } },
    });
    h.f.set({ faults: { "job.start": ["unknown-outcome"] } });
    await expect(h.spawn({ firstPrompt: "FIRST" })).rejects.toThrow();
    h.f.set({ faults: {} });
    const a = getAgent(h.db, "w1", "ws");
    if (a === undefined) throw new Error("no placeholder");
    return a;
  };

  it("takes delivery seq 1 with the prompt's msg_id", async () => {
    const a = await unknownStart();
    expect(effects()).toMatchObject([{ method: "job.start", state: "unknown", seq: 1 }]);
    const row = h.db.prepare("SELECT delivery_seq FROM agents WHERE id = ?").get(a.incarnation);
    expect(row).toEqual({ delivery_seq: 1 });
  });

  it("a newer delivery bars the deduped resend of the first prompt", async () => {
    const a = await unknownStart();
    await deliver(channelTarget(h.db, a), "NEWER", { msgId: "m-2" });
    writerGone();
    const first = h.db.prepare("SELECT first_msg_id FROM carrier_jobs").get() as {
      first_msg_id: string;
    };
    const r = await resolveFirstTurn(h.db, a, first.first_msg_id);
    expect(r?.state).toBe("unreachable");
    expect(h.calls("job.start")).toHaveLength(1);
    expect(effects()).toMatchObject([{ method: "job.start", state: "unknown", seq: 1 }]);
  });

  it("a new delivery refuses while the first prompt's start is being resolved", async () => {
    const a = await unknownStart();
    const me = effectOwner();
    h.db
      .prepare("UPDATE effects SET state = 'resolving', resolver_pid = ?, resolver_start = ?")
      .run(me.pid, me.start);
    await expect(deliver(channelTarget(h.db, a), "NEWER", { msgId: "m-2" })).rejects.toBeInstanceOf(
      DeliveryResolvingError,
    );
    expect(h.calls("channel.send")).toHaveLength(0);
  });
});
