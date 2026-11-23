// D15: lease and plugin job views are tmux-only for now (human decision 2026-11-23,
// wire_rex_presence_and_birth_aba). On Rex a spawn of either refuses before any effect: no
// reservation, no job.start, no job file, no Rex call, no row. A session profile and a
// local spawn on Rex are not refused. The guard is `refuseCarrierViewMux`, lifted per backend
// by its `carrierViews` flag.

import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobKeptError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { getReceipt } from "../src/agents/receipts.js";
import { resolveFirstTurn } from "../src/agents/spawn-plugin.js";
import { refuseRemoteSpawnMux, requireHostSpawn } from "../src/agents/spawn-remote.js";
import { getAgent, isPendingPaneId, spawnAgent, spawnForTask } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { cmdAgentCheck } from "../src/cli/agents.js";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, CarrierViewUnsupportedError } from "../src/hosts.js";
import { rexBackend } from "../src/mux.js";
import { RemotePrepareError } from "../src/remote-agent.js";
import { addTask } from "../src/tasks/edit.js";
import { taskIdFor } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { pluginHostFixture } from "./_plugin-host.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

/** Set: the registry reads as an earlier build's, whose Rex had carrier views. */
const earlierBuild = vi.hoisted(() => ({ on: false }));
vi.mock("../src/mux.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/mux.js")>();
  return {
    ...real,
    muxByName: (n: Parameters<typeof real.muxByName>[0]) =>
      earlierBuild.on && n === "rex"
        ? { ...real.rexBackend, carrierViews: true }
        : real.muxByName(n),
  };
});

const h = pluginHostFixture({ handshakeInProcess: true });
/** The plugin fixture's stub, as Rex: no carrier views. */
const asRex = () => h.stubMux({ name: "rex", carrierViews: rexBackend.carrierViews });

it("Rex has no carrier views today; tmux has them", async () => {
  const { tmuxBackend, herdrBackend } = await import("../src/mux.js");
  expect([tmuxBackend.carrierViews, rexBackend.carrierViews, herdrBackend.carrierViews]).toEqual([
    true,
    false,
    false,
  ]);
});

describe("a plugin job's view on Rex", () => {
  let files: string[] = [];
  const snapshot = () => {
    files = readdirSync(h.dir, { recursive: true }) as string[];
  };
  const nothing = () => {
    expect(h.calls("job.start")).toEqual([]);
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(h.panes.size).toBe(0);
    expect(readdirSync(h.dir, { recursive: true })).toEqual(files);
    expect(existsSync(leaseJobFile(h.db, "ws", "w1"))).toBe(false);
  };

  it("a spawn refuses before any effect, with a one-line typed exit 2", async () => {
    await h.setup({ view: "detached" });
    asRex();
    snapshot();
    const err = await h.spawn().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierViewUnsupportedError);
    expect(classifyError(err).exitCode).toBe(2);
    expect((err as Error).message).toMatch(
      /host box: a plugin job's view on rex refused before anything ran: lease and plugin job views require tmux for now \(rex support awaits instance-bound server identity\)/,
    );
    expect((err as Error).message).not.toMatch(/\n/);
    nothing();
  });

  it("a task spawn refuses before it journals an attempt", async () => {
    await h.setup();
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T", impact: 50, effortDays: 1 });
    asRex();
    snapshot();
    await expect(
      spawnForTask(h.db, {
        spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
        task: "t1",
        text: "begin",
      }),
    ).rejects.toBeInstanceOf(CarrierViewUnsupportedError);
    expect(h.db.prepare("SELECT * FROM spawn_receipts").all()).toEqual([]);
    nothing();
  });

  it("a detached view's reattach refuses before job.attach; the row keeps its pane", async () => {
    await h.setup({ view: "detached" });
    const a = await h.spawn();
    h.panes.delete(a.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    asRex();
    await expect(
      reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision }),
    ).rejects.toBeInstanceOf(CarrierViewUnsupportedError);
    expect(h.calls("job.attach")).toEqual([]);
    expect(h.panes.size).toBe(0);
    expect(getAgent(h.db, "w1", "ws")?.paneId).toBe(a.paneId);
  });
});

describe("a first turn's recovery on Rex (rex_first_turn_recovery_bypasses_refusal)", () => {
  it("mu agent check and the replay refuse before job.lookup: no view, the row stays pending", async () => {
    await h.setup({ firstTurn: "at-start" });
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    const spawnT1 = () =>
      spawnForTask(h.db, {
        spawn: { name: "w1", workstream: "ws", host: "box", cli: "claude" },
        task: "t1",
        text: "do t1",
      });
    // Started on tmux; its outcome unknown, the row a placeholder.
    expect((await spawnT1()).state).toBe("unknown");
    const msgId = getReceipt(h.db, taskIdFor(h.db, "t1", "ws") ?? -1, "manual:t1")?.msgId ?? "";
    const row = getAgent(h.db, "w1", "ws");
    if (row === undefined) throw new Error("no placeholder");
    expect(isPendingPaneId(row.paneId)).toBe(true);
    asRex();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const run of [
        () => cmdAgentCheck(h.db, "w1", msgId, { workstream: "ws" }),
        () => resolveFirstTurn(h.db, row, msgId),
        spawnT1,
      ]) {
        const err = await run().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(CarrierViewUnsupportedError);
        expect(classifyError(err).exitCode).toBe(2);
      }
    } finally {
      log.mockRestore();
    }
    expect(h.calls("job.lookup")).toEqual([]);
    expect(h.calls("job.attach")).toEqual([]);
    expect(h.f.backend().starts).toBe(1);
    expect(h.panes.size).toBe(0);
    expect(getAgent(h.db, "w1", "ws")?.paneId).toBe(row.paneId);
  });
});

describe("a release an earlier build proved on Rex (rex_legacy_release_trusts_unsafe_proof)", () => {
  it("close from any mux keeps the record, job file, reservation and row; never stops", async () => {
    const FILE = { handle: "file", start: { lookup: true, fenceKey: false } };
    await h.setup(FILE);
    const jobFile = leaseJobFile(h.db, "ws", "w1");
    // An earlier build: Rex views spawned and were "proven" gone by an absence on Rex.
    earlierBuild.on = true;
    try {
      h.stubMux({
        name: "rex",
        carrierViews: true,
        spawnAgent: async (o) => {
          h.panes.set("%1", { command: o.command });
          writeFileSync(jobFile, "file-job-1\n");
          o.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
          return "%1";
        },
      });
      await h.spawn();
      expect(getCarrierJobByName(h.db, "ws", "w1")?.viewServer).toMatch(/^rex:/);
      // A wrong-server miss: the live view reads absent; the stop then fails.
      h.panes.delete("%1");
      h.f.set({ faults: { "job.stop": ["permanent"] } });
      await expect(closeAgent(h.db, "w1", { workstream: "ws" })).rejects.toThrow();
    } finally {
      earlierBuild.on = false;
    }
    expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({ wireState: "released" });
    h.f.set({ faults: {} });
    const stops = h.f.backend().stops;
    // Today's build, on tmux (the active mux need not be Rex) and on Rex.
    for (const mux of [() => h.stubMux(), asRex]) {
      mux();
      const err = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CarrierJobKeptError);
      expect((err as Error).message).toMatch(/released on rex, which cannot prove it gone/);
    }
    expect(h.f.backend().stops).toBe(stops);
    expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({ job: "file-job-1" });
    expect(existsSync(jobFile)).toBe(true);
    expect(getAgent(h.db, "w1", "ws")).toBeDefined();
    // The operator's way out still drops it.
    await closeAgent(h.db, "w1", { workstream: "ws", abandonJob: true });
    expect(getCarrierJobByName(h.db, "ws", "w1")).toBeUndefined();
  });
});

describe("a host profile on Rex", () => {
  let dir: string;
  let db: Db;
  let mux: MuxHarness;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcvr-"));
    db = openDb({ path: join(dir, "mu.db") });
    ensureWorkstream(db, "auth");
    addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
    const profile = { exec: "true", fetch: "true", repo: "/srv/repo", max_sessions: 1 };
    addHost(db, {
      name: "lease",
      transport: "lease",
      shell: "carrier J={job_file} L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
      stop: "true {job}",
      ...profile,
    });
    addHost(db, {
      name: "session",
      shell: "echo L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
      ...profile,
    });
    mux = installMux("rex", []);
  });
  afterEach(() => {
    mux.restore();
    db.close();
    rmFixtureDir(dir);
  });

  it("a lease spawn refuses before any reservation, file, Rex call or row", async () => {
    const opts = { name: "worker-1", workstream: "auth", host: "lease" };
    for (const run of [
      () => spawnAgent(db, opts),
      () => spawnForTask(db, { spawn: opts, task: "t1", text: "begin" }),
    ]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CarrierViewUnsupportedError);
      expect((err as Error).message).toMatch(/host lease: a lease spawn on rex refused/);
    }
    expect(mux.calls).toEqual([]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(db.prepare("SELECT * FROM spawn_receipts").all()).toEqual([]);
    expect(readdirSync(dir).filter((f) => !f.startsWith("mu.db"))).toEqual([]);
  });

  it("a session profile passes both guards (rung 3 on Rex is not refused)", async () => {
    const opts = { name: "worker-1", workstream: "auth", host: "session" };
    await expect(refuseRemoteSpawnMux(db, opts)).resolves.toBeUndefined();
    await expect(requireHostSpawn(db, opts)).resolves.toMatchObject({ name: "session" });
    const err = await spawnAgent(db, opts).catch((e: unknown) => e);
    // Past every guard: the host's prepare ran (its stub exec answers no path).
    expect(err).toBeInstanceOf(RemotePrepareError);
  });
});
