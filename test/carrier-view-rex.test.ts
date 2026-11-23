// D15: lease and plugin job views are tmux-only for now (human decision 2026-11-23,
// wire_rex_presence_and_birth_aba). On Rex a spawn of either refuses before any effect: no
// reservation, no job.start, no job file, no Rex call, no row. A session profile and a
// local spawn on Rex are not refused. The guard is `refuseCarrierViewMux`, lifted per backend
// by its `carrierViews` flag.

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { refuseRemoteSpawnMux, requireHostSpawn } from "../src/agents/spawn-remote.js";
import { getAgent, spawnAgent, spawnForTask } from "../src/agents.js";
import { listCarrierJobs } from "../src/carrier-jobs.js";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, CarrierViewUnsupportedError } from "../src/hosts.js";
import { rexBackend } from "../src/mux.js";
import { RemotePrepareError } from "../src/remote-agent.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { pluginHostFixture } from "./_plugin-host.js";

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
