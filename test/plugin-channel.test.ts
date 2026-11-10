// The plugin channel adapter and the plugin spawn path (plugins spec D3, D8, D9,
// D13), over the fake plugin as a provider whose job kind's agents use its
// channel. The multiplexer is a stub that records the views it opens: their
// commands never run. What holds:
//   - a spawn on a provider host starts the job (the whole JobSpec) before a
//     read-only view, records the kind's channel, and refuses before any effect
//     what it cannot honour; an at-start kind's first prompt goes only with job.start;
//   - deliveries go only through effects; capabilities refuse typed, nothing written;
//   - a plugin channel never decides liveness (the P4 review's plants): an ended job
//     reads dead whatever the plugin's turn state says;
//   - a mid-turn death ends an open watch dead (the stream itself: channel-contract-plugin);
//   - a row naming no registered channel is a typed error;
//   - a detached job survives its view: reconcile keeps it, close stops it first,
//     reattach opens a new view on the same row.

import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import {
  AgentAnswerUnsupportedError,
  AgentFreshNeedsCtlError,
  AgentSteerUnsupportedError,
} from "../src/agents/errors.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { JobSpecUnsupportedError } from "../src/agents/spawn-remote.js";
import { type AgentRow, getAgent, insertAgent } from "../src/agents.js";
import { getCarrierJobByAgent, listCarrierJobs } from "../src/carrier-jobs.js";
import { setLivenessPollForTests } from "../src/channels/compose.js";
import {
  agentChannel,
  ChannelUnknownError,
  channelTarget,
  deliver,
  readAgentStates,
} from "../src/channels/index.js";
import { addHost, HostSpawnUnsupportedError } from "../src/hosts.js";
import { EffectOutcomeUnknownError } from "../src/plugins/errors.js";
import { reconcile } from "../src/reconcile.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();
const { setup, spawn, calls, ended } = {
  setup: (...a: Parameters<typeof h.setup>) => h.setup(...a),
  spawn: (...a: Parameters<typeof h.spawn>) => h.spawn(...a),
  calls: (m: string) => h.calls(m),
  ended: () => h.ended(),
};
const effects = () => (h.db.prepare("SELECT COUNT(*) AS n FROM effects").get() as { n: number }).n;
const seq = (a: AgentRow) =>
  (
    h.db.prepare("SELECT delivery_seq AS s FROM agents WHERE id = ?").get(a.incarnation) as {
      s: number;
    }
  ).s;

describe("the plugin spawn path (D8)", () => {
  it("starts the job with the JobSpec, then a read-only view; the row takes the kind's channel", async () => {
    await setup();
    const a = await spawn();
    expect(a.channel).toBe("cloud");
    expect(a.host).toBe("box");
    const spec = calls("job.start")[0]?.params.spec as Record<string, unknown>;
    expect(spec).toMatchObject({
      workstream: "ws",
      name: "w1",
      harness: "claude",
      role: "full-access",
      commandSource: "cli-key",
      cwd: "/work",
      env: { MU_AGENT_NAME: "w1", MU_WORKSTREAM: "ws", MU_MANAGED_AGENT: "1" },
    });
    expect(spec.sockets).toBeUndefined();
    expect(spec.firstPrompt).toBeUndefined();
    expect(h.panes.get(a.paneId)?.command).toBe("exec </dev/null; sleep 600");
    const job = getCarrierJobByAgent(h.db, a.incarnation);
    expect(job).toMatchObject({
      job: "job-1",
      paneId: a.paneId,
      plugin: "fake",
      instance: "fake-1",
    });
    // Readiness is the channel's baseline.
    expect(calls("channel.baseline")).toHaveLength(1);
    expect(effects()).toBe(0);
  });

  it("a --plugin profile's agent: the cwd resolved over the plugin's link, then the job", async () => {
    await setup();
    addHost(h.db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
    const a = await spawn({ host: "dev", cwd: h.dir });
    expect(a.channel).toBe("cloud");
    expect(calls("link.exec")).toHaveLength(1);
    expect((calls("job.start")[0]?.params.spec as { cwd?: string } | undefined)?.cwd).toBe(
      realpathSync(h.dir),
    );
    expect(getCarrierJobByAgent(h.db, a.incarnation)).toMatchObject({ host: "dev", job: "job-1" });
  });

  it("refuses before any effect what the kind cannot honour, or a view the backend cannot run", async () => {
    await setup();
    await expect(spawn({ role: "read-only" })).rejects.toBeInstanceOf(JobSpecUnsupportedError);
    h.stubMux({ runsShellCommand: false });
    await expect(spawn()).rejects.toBeInstanceOf(HostSpawnUnsupportedError);
    expect(calls("job.start")).toHaveLength(0);
    expect(listCarrierJobs(h.db)).toHaveLength(0);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
  });

  it("at-start: the first prompt goes only with job.start, and never as a send", async () => {
    await setup({ firstTurn: "at-start" });
    await expect(spawn()).rejects.toMatchObject({ field: "prompt" });
    expect(calls("job.start")).toHaveLength(0);
    const a = await spawn({ firstPrompt: "begin" });
    const start = calls("job.start")[0]?.params.spec as {
      firstPrompt: { text: string; msgId: string };
    };
    expect(start.firstPrompt.text).toBe("begin");
    expect(a.firstSend).toMatchObject({
      transport: "cloud",
      runs: 0,
      msgId: start.firstPrompt.msgId,
    });
    expect(calls("channel.send")).toHaveLength(0);
    expect(calls("channel.baseline")).toHaveLength(0); // the start's baseline is readiness
    const rec = h.db
      .prepare("SELECT first_msg_id AS m, first_inc AS i FROM carrier_jobs WHERE agent_id = ?")
      .get(a.incarnation);
    expect(rec).toEqual({ m: start.firstPrompt.msgId, i: "inc-1" });
  });

  it("a failure after the start stops the job by its handle and rolls the spawn back", async () => {
    await setup();
    h.f.set({ faults: { "channel.baseline": ["permanent"] } });
    h.stubMux({
      spawnAgent: async () => {
        throw new Error("no pane");
      },
    });
    await expect(spawn()).rejects.toThrow(/no pane/);
    expect(h.f.backend().stops).toBe(1);
    expect(listCarrierJobs(h.db)).toHaveLength(0);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
  });
});

describe("deliveries go only through effects (D4, D13)", () => {
  it("a send is a channel.send effect with the full target; the row's delivery_seq rises", async () => {
    await setup();
    const a = await spawn();
    const sent = await deliver(channelTarget(h.db, a), "do it", {});
    expect(sent).toMatchObject({ transport: "cloud", runs: 0, incarnation: "inc-1" });
    const p = calls("channel.send")[0]?.params as Record<string, unknown>;
    expect(p).toMatchObject({
      target: {
        agent: { workstream: "ws", name: "w1", incarnation: a.incarnation },
        job: { kind: "fakejob", handle: "job-1" },
        host: { name: "box", handle: "host-1", instance: "fake-1" },
      },
      text: "do it",
      mode: "followUp",
      force: false,
      firstPrompt: false,
    });
    expect(seq(a)).toBe(1);
    expect(effects()).toBe(0);
  });

  it("a capability that is none refuses typed, before anything is written", async () => {
    await setup();
    const a = await spawn();
    const t = channelTarget(h.db, a);
    await expect(deliver(t, "x", { mode: "steer" })).rejects.toBeInstanceOf(
      AgentSteerUnsupportedError,
    );
    await expect(deliver(t, "x", { fresh: true })).rejects.toBeInstanceOf(AgentFreshNeedsCtlError);
    await expect(agentChannel(t).answer(t, ["1"], {})).rejects.toBeInstanceOf(
      AgentAnswerUnsupportedError,
    );
    expect(seq(a)).toBe(0);
    expect(calls("channel.send")).toHaveLength(0);
  });

  it("an unknown outcome leaves the effect for the rule table", async () => {
    await setup();
    const a = await spawn();
    h.f.set({ faults: { "channel.send": ["unknown-outcome"] } });
    await expect(deliver(channelTarget(h.db, a), "x", {})).rejects.toBeInstanceOf(
      EffectOutcomeUnknownError,
    );
    expect(effects()).toBe(1);
  });
});

describe("a plugin channel never decides liveness (the P4 review's plants)", () => {
  it("an ended job reads dead whatever turn state the plugin reports; unknown is never a death", async () => {
    await setup({}, { channelState: "busy" });
    const a = await spawn();
    const t = channelTarget(h.db, a);
    const key = "ws/w1";
    expect((await readAgentStates([a], { db: h.db })).get(key)).toMatchObject({
      state: "busy",
      source: "plugin:fake",
      alive: true,
      runs: 0,
      incarnation: "inc-1",
    });
    h.f.set({ replies: { "job.status": { state: "unknown", reason: "cannot tell" } } });
    expect((await readAgentStates([a], { db: h.db })).get(key)?.alive).toBe(true);
    ended();
    expect((await readAgentStates([a], { db: h.db })).get(key)?.alive).toBe(false);
    expect((await agentChannel(t).readStates([a], {})).get(key)?.alive).toBe(false);
  });

  it("a watch or last run of an ended job is a dead agent, never the plugin's busy or idle", async () => {
    await setup({}, { channelState: "idle" });
    const a = await spawn();
    const t = channelTarget(h.db, a);
    await deliver(t, "one", {});
    await new Promise((r) => setTimeout(r, 60));
    ended();
    const w = await agentChannel(t).watch(t, new AbortController().signal, { afterRuns: 0 });
    expect(w?.initial.status).toBeNull();
    expect((await w?.settled)?.status).toBeNull();
    const last = await agentChannel(t).lastRun(t, { afterRuns: 0, ms: 2000 });
    expect(last?.status).toBeNull();
  });

  it("a job that dies mid-turn ends the open watch dead", async () => {
    await setup({}, { watchSilent: true });
    setLivenessPollForTests(20);
    const a = await spawn();
    const t = channelTarget(h.db, a);
    const w = await agentChannel(t).watch(t, new AbortController().signal, {});
    ended();
    expect((await w?.settled)?.status).toBeNull();
  });
});

describe("a channel no one provides (D5, D9)", () => {
  it("a verb refuses typed; a read is unknown", async () => {
    const a = insertAgent(h.db, {
      name: "x",
      workstream: "ws",
      cli: "claude",
      paneId: "%9",
      channel: "nosuch",
    });
    expect(getAgent(h.db, "x", "ws")?.channel).toBe("nosuch");
    expect(() => agentChannel(channelTarget(h.db, a))).toThrow(ChannelUnknownError);
    expect((await readAgentStates([a], { db: h.db })).get("ws/x")).toMatchObject({
      state: "unknown",
      reason: "channel nosuch is not registered",
    });
  });
});

describe("views (D3)", () => {
  it("bound: close kills the view, then stops the job; the row and record go", async () => {
    await setup();
    const a = await spawn();
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.stopsAtKill).toEqual([0]);
    expect(h.f.backend().stops).toBe(1);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(getCarrierJobByAgent(h.db, a.incarnation)).toBeUndefined();
  });

  it("detached: reconcile keeps a row whose view is gone while its job runs; an ended job's goes", async () => {
    await setup({ view: "detached" });
    const a = await spawn();
    h.panes.delete(a.paneId);
    expect((await reconcile(h.db, { workstream: "ws" })).prunedGhosts).toBe(0);
    expect(getAgent(h.db, "w1", "ws")).toBeDefined();
    ended();
    expect((await reconcile(h.db, { workstream: "ws" })).prunedGhosts).toBe(1);
  });

  it("detached: close stops the job before it kills the view", async () => {
    await setup({ view: "detached" });
    await spawn();
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.stopsAtKill).toEqual([1]);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
  });

  it("detached: reattach opens a new view by job.attach; the row keeps its incarnation", async () => {
    await setup({ view: "detached" });
    const a = await spawn();
    h.panes.delete(a.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    const r = await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
    expect(calls("job.attach")).toHaveLength(1);
    const now = getAgent(h.db, "w1", "ws");
    expect(now?.incarnation).toBe(a.incarnation);
    expect(now?.paneId).toBe(r.pane_id);
    expect(now?.paneId).not.toBe(a.paneId);
    expect(getCarrierJobByAgent(h.db, a.incarnation)?.paneId).toBe(r.pane_id);
    expect(h.panes.get(r.pane_id)?.command).toBe("exec </dev/null; sleep 600");
  });
});
