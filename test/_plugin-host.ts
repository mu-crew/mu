// A provider host from the fake plugin whose job kind's agents use its channel
// (`cloud`), and a multiplexer stub that records the views it opens (their
// commands never run). `pluginHostFixture()` installs its own beforeEach and
// afterEach: a temp DB, the stub, and the plugin sessions closed after.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { type SpawnAgentOptions, type SpawnedAgent, spawnAgent } from "../src/agents/spawn.js";
import { setLivenessPollForTests } from "../src/channels/compose.js";
import { type Db, openDb } from "../src/db.js";
import { acquireHost } from "../src/host-lifecycle.js";
import { type MuxBackend, setMuxForTests, tmuxBackend } from "../src/mux.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, providerSeams } from "./_plugin.js";

export const CLOUD = {
  name: "cloud",
  caps: {
    fence: "none",
    receipt: "exact",
    dedupe: { send: { exact: true, windowMs: 60_000 } },
    steer: "none",
    interrupt: "exact",
    fresh: "none",
    answer: false,
    command: false,
    watch: "stream",
    settleText: "tied",
  },
};

export interface PluginHost {
  db: Db;
  dir: string;
  f: FakePlugin;
  /** The views the stub opened, by pane id (deleted when killed). */
  panes: Map<string, { command: string }>;
  /** The fake backend's stops counted at each kill: a detached close stops first. */
  stopsAtKill: number[];
  stubMux(over?: Partial<MuxBackend>): void;
  /** Register the fake (its job seam patched by `job`) and acquire `box` from it. */
  setup(
    job?: Record<string, unknown>,
    config?: Record<string, unknown>,
    link?: Record<string, unknown>,
  ): Promise<void>;
  spawn(o?: Partial<SpawnAgentOptions>): Promise<SpawnedAgent>;
  calls(method: string): Array<{ method: string; params: Record<string, unknown> }>;
  /** From now on, every job.status answers ended. */
  ended(): void;
}

export function pluginHostFixture(): PluginHost {
  const h = {} as PluginHost;
  h.stubMux = (over = {}) => {
    let n = 0;
    setMuxForTests({
      ...tmuxBackend,
      runsShellCommand: true,
      spawnAgentWaitsReady: false,
      anchorsPanes: false,
      ensureSession: async () => ({ created: false }) as never,
      spawnAgent: async (o) => {
        const id = `%${++n}`;
        h.panes.set(id, { command: o.command });
        o.onPaneCreated?.(id);
        return id;
      },
      paneAlive: async (id) => h.panes.has(id),
      paneResult: async (id) => (h.panes.has(id) ? { state: "running" } : { state: "absent" }),
      killPane: async (id) => {
        h.stopsAtKill.push(h.f.backend().stops);
        h.panes.delete(id);
      },
      listPanes: async () => [...h.panes.keys()].map((paneId) => ({ paneId, command: "sh" })),
      capture: async () => "",
      ...over,
    });
  };
  h.setup = async (job = {}, config = {}, link = {}) => {
    const seams = { ...providerSeams({ channel: "cloud", ...job }, link), channel: CLOUD };
    h.f = fakePlugin(h.dir, { seams, turnMs: 30, ...config });
    await addPlugin(h.db, "fake", h.f.argv);
    await acquireHost(h.db, { name: "box", provider: "fake", params: {}, repo: "/work" });
  };
  h.spawn = (o = {}) =>
    spawnAgent(h.db, { name: "w1", workstream: "ws", host: "box", cli: "claude", ...o });
  h.calls = (m) => h.f.calls().filter((c) => c.method === m);
  h.ended = () => h.f.set({ replies: { "job.status": { state: "ended", exit: 0 } } });
  beforeEach(() => {
    h.dir = mkdtempSync(join(tmpdir(), "mpch-"));
    h.db = openDb({ path: join(h.dir, "mu.db") });
    ensureWorkstream(h.db, "ws");
    h.panes = new Map();
    h.stopsAtKill = [];
    h.stubMux();
  });
  afterEach(async () => {
    setLivenessPollForTests(undefined);
    setMuxForTests(undefined);
    await closePluginSessions();
    h.db.close();
    rmFixtureDir(h.dir);
  });
  return h;
}
