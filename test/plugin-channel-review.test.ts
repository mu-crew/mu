// The P6e1 review's repros and the orchestrator's rulings 1-5 (task p6e1_fix):
//   1. a plugin channel is resolved per DB: loading another DB's registration never routes
//      this DB's agent (its deliveries, its liveness) to that DB's adapter;
//   2. a view whose backend fails after it reported the pane rolls the spawn back (the job
//      stopped by its handle) and never commits a reattach; reattach refuses on a backend
//      that cannot run a view, and a view is never labelled the harness's own command;
//   3. composition is by the requested target: a missing reading, a foreign observation or a
//      stale gone verdict never decides liveness, the job's status does;
//   4. an at-start start's reply carries its opening baseline, runs 0, else its outcome is
//      unknown and its effect kept; later sends never carry firstPrompt;
//   5. a plugin's send ack is kept.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { spawnAgent } from "../src/agents/spawn.js";
import { getAgent, sendToAgent } from "../src/agents.js";
import { getCarrierJobByAgent, listCarrierJobs } from "../src/carrier-jobs.js";
import { composeChannel } from "../src/channels/compose.js";
import {
  agentChannel,
  channelNamed,
  channelTarget,
  deliver,
  readAgentStates,
  sentRun,
} from "../src/channels/index.js";
import type { ChannelImpl, ChannelObservation } from "../src/channels/types.js";
import { openDb } from "../src/db.js";
import { acquireHost } from "../src/host-lifecycle.js";
import { HostSpawnUnsupportedError } from "../src/hosts.js";
import { jobUp } from "../src/jobs/kinds.js";
import { loadPluginChannels, pluginChannel } from "../src/plugins/channel.js";
import { EffectOutcomeUnknownError, PluginRefusedError } from "../src/plugins/errors.js";
import { pluginJobKind, pluginJobRef } from "../src/plugins/job.js";
import { addPlugin, removePlugin } from "../src/plugins/registry.js";
import { type AgentTrack, rewatchOnPoll } from "../src/wait-latch.js";
import { ensureWorkstream } from "../src/workstream.js";
import { fakePlugin, providerSeams } from "./_plugin.js";
import { CLOUD, pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture();

const stopJob = async (incarnation: number) => {
  const r = getCarrierJobByAgent(h.db, incarnation);
  const ref = r === undefined ? undefined : pluginJobRef(h.db, r.token);
  if (ref === undefined) throw new Error("no job");
  await pluginJobKind(h.db, "fake")?.stop(h.db, ref);
};

describe("ruling 1: a plugin channel is resolved per DB", () => {
  it("loading another DB's channel of the same name never routes this DB's agent to it", async () => {
    await h.setup({}, { channelState: "busy" });
    const a = await h.spawn();
    await stopJob(a.incarnation);
    const targetA = channelTarget(h.db, a);
    expect((await readAgentStates([a], { db: h.db })).get("ws/w1")?.alive).toBe(false);
    const dirB = join(h.dir, "other");
    mkdirSync(dirB);
    const dbB = openDb({ path: join(dirB, "mu.db") });
    try {
      ensureWorkstream(dbB, "ws");
      const fB = fakePlugin(dirB, {
        seams: { ...providerSeams({ channel: "cloud" }), channel: CLOUD },
        channelState: "busy",
      });
      await addPlugin(dbB, "fake", fB.argv);
      await acquireHost(dbB, { name: "box", provider: "fake", params: {}, repo: "/work" });
      const b = await spawnAgent(dbB, { name: "w1", workstream: "ws", host: "box", cli: "claude" });
      channelTarget(dbB, b);
      expect((await agentChannel(targetA).readStates([a], {})).get("ws/w1")?.alive).toBe(false);
      expect((await readAgentStates([a], { db: h.db })).get("ws/w1")?.alive).toBe(false);
      await agentChannel(targetA)
        .send(targetA, "to A", {})
        .catch(() => {});
      expect(fB.backend().deliveries).toBe(0);
      expect(h.f.backend().deliveries).toBe(1);
    } finally {
      dbB.close();
    }
  });
});

describe("ruling 2: a failed view never passes for a spawned or reattached one", () => {
  it("a backend that fails after it reported the pane: the spawn fails and its job is stopped", async () => {
    await h.setup();
    h.stubMux({
      spawnAgent: async (o) => {
        h.panes.set("%failed-view", { command: o.command });
        o.onPaneCreated?.("%failed-view");
        await new Promise((r) => setTimeout(r, 25));
        h.panes.delete("%failed-view");
        throw new Error("view failed after creation");
      },
    });
    await expect(h.spawn()).rejects.toThrow(/view failed after creation/);
    expect(h.f.backend().stops).toBe(1);
    expect(listCarrierJobs(h.db)).toHaveLength(0);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
  });

  it("reattach never commits the pane of a view whose backend failed", async () => {
    await h.setup({ view: "detached" });
    const a = await h.spawn();
    h.panes.delete(a.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    h.stubMux({
      spawnAgent: async (o) => {
        o.onPaneCreated?.("%failed-reattach");
        await new Promise((r) => setTimeout(r, 25));
        throw new Error("reattach failed after creation");
      },
    });
    await expect(reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision })).rejects.toThrow(
      /reattach failed/,
    );
    expect(getAgent(h.db, "w1", "ws")?.paneId).toBe(a.paneId);
  });

  it("reattach refuses on a backend that cannot run a view; a view is never labelled cli-key", async () => {
    await h.setup({ view: "detached" });
    const sources: string[] = [];
    h.stubMux();
    const spawned = await h.spawn();
    h.panes.delete(spawned.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    h.stubMux({ runsShellCommand: false });
    await expect(
      reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision }),
    ).rejects.toBeInstanceOf(HostSpawnUnsupportedError);
    expect(h.calls("job.attach")).toHaveLength(0);
    const record = (o: { commandSource: string; onPaneCreated?: (id: string) => void }) => {
      sources.push(o.commandSource);
      o.onPaneCreated?.("%v");
      h.panes.set("%v", { command: "" });
      return Promise.resolve("%v");
    };
    h.stubMux({ spawnAgent: record as never });
    await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
    expect(sources).toEqual(["explicit"]);
  });
});

const declaration = { name: "cloud", caps: CLOUD.caps } as never;
const hostile = (patch: Partial<ChannelImpl>) =>
  composeChannel({ ...pluginChannel(h.db, "fake", declaration), ...patch });
const observation = (
  a: { workstreamName: string; name: string; incarnation: number; paneId: string },
  status: ChannelObservation["status"],
): ChannelObservation => ({
  workstream: a.workstreamName,
  name: a.name,
  agentId: a.incarnation,
  paneId: a.paneId,
  source: "plugin:fake",
  status,
  since: null,
  settled: false,
  runs: 0,
  incarnation: "inc-1",
});

describe("ruling 3: composition is by the requested target; the job's status decides", () => {
  it("a missing turn reading never kills a running detached job whose view is gone", async () => {
    await h.setup({ view: "detached" });
    const a = await h.spawn();
    h.panes.delete(a.paneId);
    const states = await hostile({ readTurns: async () => new Map() }).readStates([a], {});
    expect(states.get("ws/w1")?.alive).toBe(true);
    expect(h.calls("job.status").length).toBeGreaterThan(0);
  });

  it("a stale gone verdict from another view never kills a live target", async () => {
    await h.setup({ view: "detached" });
    const a = await h.spawn();
    const gone = await jobUp({ kind: "pane", viewPaneId: "%no-such-view" });
    if (gone === "up" || gone === "unknown") throw new Error("the test needs a gone view");
    const o = observation(a, gone);
    const ch = hostile({
      watch: async () => ({ initial: o, settled: Promise.resolve(o) }),
      lastRun: async () => o,
    });
    const w = await ch.watch(channelTarget(h.db, a), new AbortController().signal, {});
    expect(w?.initial.status).not.toBeNull();
    expect((await w?.settled)?.status).not.toBeNull();
    const last = await ch.lastRun(channelTarget(h.db, a), { afterRuns: 0, ms: 1000 });
    expect(last?.status).not.toBeNull();
  });

  it("a foreign observation never stands in for the ended target job", async () => {
    await h.setup({ view: "detached" });
    const a = await h.spawn();
    const b = await h.spawn({ name: "w2" });
    await stopJob(a.incarnation);
    const o = observation(b, "busy");
    const ch = hostile({
      watch: async () => ({ initial: o, settled: Promise.resolve(o) }),
      lastRun: async () => o,
    });
    const w = await ch.watch(channelTarget(h.db, a), new AbortController().signal, {});
    expect(w?.initial).toMatchObject({ name: "w1", status: null });
    expect((await w?.settled)?.status).toBeNull();
    const last = await ch.lastRun(channelTarget(h.db, a), { afterRuns: 0, ms: 1000 });
    expect(last).toMatchObject({ name: "w1", status: null });
  });
});

describe("ruling 4: an at-start start opens at runs 0; later sends never carry firstPrompt", () => {
  it("a start reply without its baseline is an unknown outcome, its effect kept", async () => {
    await h.setup({ firstTurn: "at-start" });
    h.f.set({
      replies: { "job.start": { view: { command: "sleep 1", env: {} }, handle: "job-x" } },
    });
    await expect(h.spawn({ firstPrompt: "begin" })).rejects.toBeInstanceOf(
      EffectOutcomeUnknownError,
    );
    expect(h.calls("channel.baseline")).toHaveLength(0);
    expect(
      (
        h.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE method = 'job.start'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("a start reply opening past runs 0 is an unknown outcome", async () => {
    await h.setup({ firstTurn: "at-start" });
    h.f.set({
      replies: {
        "job.start": {
          view: { command: "sleep 1", env: {} },
          handle: "job-x",
          baseline: { runs: 7, incarnation: "i" },
        },
      },
    });
    await expect(h.spawn({ firstPrompt: "begin" })).rejects.toBeInstanceOf(
      EffectOutcomeUnknownError,
    );
  });

  it("the first send after an at-start spawn carries firstPrompt false", async () => {
    await h.setup({ firstTurn: "at-start" });
    await h.spawn({ firstPrompt: "begin" });
    await sendToAgent(h.db, "w1", "second", { workstream: "ws" });
    expect(h.calls("channel.send")[0]?.params.firstPrompt).toBe(false);
  });
});

describe("ruling 5: the plugin's ack is kept", () => {
  it("a reply's ack reaches the SendResult and the run it started", async () => {
    await h.setup();
    const a = await h.spawn();
    h.f.set({ replies: { "channel.send": { channel: "cloud", ack: "none" } } });
    const sent = await deliver(channelTarget(h.db, a), "x", {});
    expect(sent.channelAck).toBe("none");
    expect(agentChannel(channelTarget(h.db, a)).sendRun(sent)?.ack).toBe("none");
    expect(sentRun(sent)).toEqual({});
  });
});

describe("round 2: a plugin channel's identity is (plugin, name); every lookup is scoped by its DB", () => {
  it("a second plugin declaring a channel name another plugin holds in this DB is refused", async () => {
    await h.setup();
    const a = await h.spawn();
    const target = channelTarget(h.db, a);
    const dir = join(h.dir, "other");
    mkdirSync(dir);
    const other = fakePlugin(
      dir,
      { seams: { ...providerSeams({ channel: "cloud" }), channel: CLOUD } },
      "other",
    );
    await expect(addPlugin(h.db, "other", other.argv)).rejects.toBeInstanceOf(PluginRefusedError);
    await agentChannel(target).send(target, "to A", {});
    expect(other.backend().deliveries).toBe(0);
    expect(h.f.backend().deliveries).toBe(1);
  });

  it("the row records the channel's plugin: a registration naming the same channel never takes its agent", async () => {
    await h.setup();
    const a = await h.spawn();
    expect(getAgent(h.db, "w1", "ws")?.channelPlugin).toBe("fake");
    // A colliding registration written past `mu plugin add` (an older DB): never an overwrite.
    h.db
      .prepare(
        "INSERT INTO plugins (name, argv_json, protocol, version, instance, seams_json, caps_json, schema_digest, added_at, checked_at) SELECT 'other', argv_json, protocol, version, instance, seams_json, caps_json, schema_digest, added_at, checked_at FROM plugins WHERE name = 'fake'",
      )
      .run();
    const target = channelTarget(h.db, a);
    await agentChannel(target).send(target, "to A", {});
    expect(h.f.backend().deliveries).toBe(1);
  });

  it("a closed DB handle never hides a live DB's streaming capability", async () => {
    await h.setup({ view: "detached" });
    await h.spawn();
    const track = () => ({ baseline: 0, needWatch: false }) as AgentTrack;
    const r = { status: "needs_input", source: "plugin:fake", runs: 1 } as Parameters<
      typeof rewatchOnPoll
    >[1];
    expect(rewatchOnPoll(track(), r, h.db)).toBe(true);
    const dbB = openDb({ path: join(h.dir, "second.db") });
    try {
      await addPlugin(dbB, "fake", h.f.argv);
      loadPluginChannels(dbB);
      dbB.close();
      expect(rewatchOnPoll(track(), r, h.db)).toBe(true);
      // Unscoped, a plugin name never resolves.
      expect(channelNamed("plugin:fake")).toBeUndefined();
    } finally {
      if (dbB.open) dbB.close();
    }
  });
});

describe("round 3: every registry read loads its DB's plugin channels; a load replaces the set", () => {
  it("a fresh DB handle resolves its plugin channel and its capabilities with no target built first", async () => {
    await h.setup();
    await h.spawn();
    const fresh = openDb({ path: h.db.name });
    try {
      expect(channelNamed("cloud", fresh)?.caps.watch).toBe("stream");
      const track = { baseline: 0, needWatch: false } as AgentTrack;
      const r = { status: "needs_input", source: "plugin:fake", runs: 1 } as Parameters<
        typeof rewatchOnPoll
      >[1];
      expect(rewatchOnPoll(track, r, fresh)).toBe(true);
    } finally {
      fresh.close();
    }
  });

  it("a removed plugin's channel disappears; a replacement under the same name resolves", async () => {
    const f = fakePlugin(h.dir, { seams: { channel: CLOUD } });
    await addPlugin(h.db, "fake", f.argv);
    loadPluginChannels(h.db); // the load a channel target runs
    expect(channelNamed("cloud", h.db, "fake")).toBeDefined();
    removePlugin(h.db, "fake");
    loadPluginChannels(h.db);
    expect(channelNamed("cloud", h.db)).toBeUndefined();
    const dir = join(h.dir, "other");
    mkdirSync(dir);
    const other = fakePlugin(dir, { seams: { channel: CLOUD } }, "other");
    await addPlugin(h.db, "other", other.argv);
    loadPluginChannels(h.db);
    expect(channelNamed("cloud", h.db)).toBe(channelNamed("cloud", h.db, "other"));
    expect(channelNamed("cloud", h.db)).toBeDefined();
    expect(channelNamed("cloud", h.db, "fake")).toBeUndefined();
  });
});
