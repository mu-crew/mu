// The D15 file handle (ladder placement spec §10, §5; spec A round 2's lease-recovery and
// self-admit-close findings), over the fake plugin's `handle: "file"` kind. mu claims the job
// file before `job.start`, `JobSpec.jobFile` names it, and mu reads it from the local file
// before the spawn returns; lookup by key comes second and `none` never acts. Every later path
// that finds a launched record with no handle (rollback, a close after a restart, a no-row
// close) reads the file first, then the unresolved start or the lookup, and never infers
// "no job" from an absent file. The stub multiplexer stands in for the view: it publishes the
// handle into the job file when the pane opens (or not, per test). Nothing reaches a host.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobUnresolvedError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { getAgent } from "../src/agents.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { openDb } from "../src/db.js";
import { PluginCallError } from "../src/plugins/errors.js";
import { reconcile } from "../src/reconcile.js";
import { addTask, claimTask, getTask, listNotes } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { pluginHostFixture } from "./_plugin-host.js";

const h = pluginHostFixture({ handshakeInProcess: true });
const FILE = { handle: "file", start: { lookup: true, fenceKey: false } };
const jobFile = () => leaseJobFile(h.db, "ws", "w1");
const record = () => getCarrierJobByName(h.db, "ws", "w1");
/** The job handle a call's target names. */
const handleOf = (c: { params: Record<string, unknown> } | undefined) =>
  (c?.params.target as { job?: { handle?: string } } | undefined)?.job?.handle;

/** The stub's views publish `handle` into the job file as their pane opens (undefined: never). */
function views(o: { handle?: string; dies?: boolean } = {}): void {
  let n = 0;
  h.stubMux({
    spawnAgent: async (s) => {
      const id = `%${++n}`;
      if (o.dies !== true) h.panes.set(id, { command: s.command });
      if (o.handle !== undefined) writeFileSync(jobFile(), `${o.handle}\n`);
      s.onPaneCreated?.(id);
      return id;
    },
  });
}

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  log.mockRestore();
  err.mockRestore();
});

describe("spawn", () => {
  it("claims the job file, sends its path in JobSpec, and records the handle from it", async () => {
    await h.setup(FILE);
    views({ handle: "file-job-1" });
    await h.spawn();
    const [start] = h.calls("job.start");
    expect(start?.params.spec).toHaveProperty("jobFile", jobFile());
    expect(record()?.job).toBe("file-job-1");
    // From the local file: no lookup by key.
    expect(h.calls("job.lookup")).toHaveLength(0);
  });

  it("a kind of another handle gets no jobFile (an older plugin may reject the field)", async () => {
    await h.setup();
    await h.spawn();
    const [start] = h.calls("job.start");
    expect(start?.params.spec).not.toHaveProperty("jobFile");
  });

  it("a view that dies before publishing: found by key, then stopped by that handle", async () => {
    await h.setup(FILE);
    views({ dies: true });
    await expect(h.spawn()).rejects.toThrow(/before writing its job handle/);
    expect(h.calls("job.lookup")).toHaveLength(1);
    expect(h.f.backend().stops).toBe(1);
    expect(record()).toBeUndefined();
  });

  it("a relative DB path still sends an absolute jobFile, the path every later read derives", async () => {
    h.db.close();
    h.db = openDb({ path: relative(process.cwd(), join(h.dir, "mu.db")) });
    ensureWorkstream(h.db, "ws");
    await h.setup(FILE);
    views({ handle: "file-job-1" });
    await h.spawn();
    const spec = h.calls("job.start")[0]?.params.spec as { jobFile?: string } | undefined;
    expect(isAbsolute(spec?.jobFile ?? "")).toBe(true);
    expect(spec?.jobFile).toBe(resolve(h.dir, "carrier", "ws", "w1.job"));
    expect(jobFile()).toBe(spec?.jobFile);
    expect(record()?.job).toBe("file-job-1");
  });

  it("a view opened with no pane id reported is not proven gone: nothing stopped, all kept", async () => {
    await h.setup(FILE);
    h.stubMux({
      spawnAgent: async (s) => {
        // The window opens and its view publishes, then the backend fails before the id.
        h.panes.set("%9", { command: s.command });
        writeFileSync(jobFile(), "file-job-1\n");
        throw new Error("injected: no pane id");
      },
    });
    await expect(h.spawn()).rejects.toThrow(/no pane id/);
    expect(h.panes.has("%9")).toBe(true);
    expect(h.f.backend().stops).toBe(0);
    expect(existsSync(jobFile())).toBe(true);
    expect(record()).toMatchObject({ launch: "intent", job: "file-job-1" });
  });

  it("a lookup's none is no proof: the record and its reason are kept, nothing stopped", async () => {
    await h.setup(FILE);
    h.f.set({ replies: { "job.lookup": { none: true } } });
    views({ dies: true });
    await expect(h.spawn()).rejects.toThrow(/before writing its job handle/);
    expect(h.f.backend().stops).toBe(0);
    expect(record()).toMatchObject({ launch: "intent", job: null });
    await expect(closeAgent(h.db, "w1", { workstream: "ws" })).rejects.toThrow(
      /job file .* is absent, and lookup by key found no claim yet/,
    );
    expect(record()).toBeDefined();
    // The view published late: the next close stops that handle, the file first.
    writeFileSync(jobFile(), "file-job-1\n");
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.f.backend().stops).toBe(1);
    expect(record()).toBeUndefined();
    expect(existsSync(jobFile())).toBe(false);
  });
});

describe("recovery", () => {
  it("a lost job.start answer: no view opened; the rollback resolves it by key and stops the job", async () => {
    await h.setup(FILE);
    h.f.set({ faults: { "job.start": ["effectThenExit"] } });
    await expect(h.spawn()).rejects.toThrow(/outcome unknown/);
    expect(h.panes.size).toBe(0);
    expect(h.calls("job.lookup")).toHaveLength(1);
    expect(h.f.backend().stops).toBe(1);
    expect(record()).toBeUndefined();
  });

  it("death after the file's publish, before the DB fill: the reaper parks, a no-row close stops by the file with the master down", async () => {
    await h.setup(FILE);
    views({ handle: "file-job-1" });
    const a = await h.spawn();
    addTask(h.db, { localId: "t1", workstream: "ws", title: "T1", impact: 50, effortDays: 1 });
    await claimTask(h.db, "t1", { agentName: "w1", workstream: "ws" });
    // As if mu died between the view's publish and recording the handle.
    h.db.prepare("UPDATE carrier_jobs SET job = NULL").run();
    h.panes.delete(a.paneId);
    await reconcile(h.db, { workstream: "ws" });
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(getTask(h.db, "t1", "ws")).toMatchObject({ status: "OPEN", substate: "parked" });
    expect(listNotes(h.db, "t1", "ws").at(-1)?.content).toMatch(
      /its job \(no handle recorded yet\) on box may still run/,
    );
    // The master is down: any lookup hands back. The local file needs none.
    h.f.set({ faults: { "job.lookup": ["human", "human"] } });
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.calls("job.lookup")).toHaveLength(0);
    const [stop] = h.calls("job.stop");
    expect(handleOf(stop)).toBe("file-job-1");
    expect(record()).toBeUndefined();
    expect(existsSync(jobFile())).toBe(false);
  });

  it("death between the view's keyed claim and its publish: a no-row close finds it by key", async () => {
    await h.setup(FILE);
    views({ handle: "file-job-1" });
    const a = await h.spawn();
    h.db.prepare("UPDATE carrier_jobs SET job = NULL").run();
    h.panes.delete(a.paneId);
    await reconcile(h.db, { workstream: "ws" });
    rmSync(jobFile()); // claimed on the host, never published
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(h.calls("job.lookup")).toHaveLength(1);
    expect(h.f.backend().stops).toBe(1);
    expect(record()).toBeUndefined();
  });

  it("a lost start answer with the master down: close hands back, never calling the job absent", async () => {
    await h.setup(FILE);
    h.f.set({ faults: { "job.start": ["effectThenExit"], "job.lookup": ["human", "human"] } });
    await expect(h.spawn()).rejects.toThrow(/outcome unknown/);
    await expect(closeAgent(h.db, "w1", { workstream: "ws" })).rejects.toMatchObject({
      name: "PluginCallError",
      kind: "human",
    });
    expect(h.f.backend().stops).toBe(0);
    expect(record()).toMatchObject({ launch: "intent", job: null });
  });
  it("no file and a lookup that hands back (the master dropped): close is human needed, record kept", async () => {
    await h.setup(FILE);
    h.f.set({ faults: { "job.lookup": ["human", "human"] } });
    views({ dies: true });
    await expect(h.spawn()).rejects.toThrow(/before writing its job handle/);
    expect(record()).toMatchObject({ launch: "intent", job: null });
    const e = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PluginCallError);
    expect(e).not.toBeInstanceOf(CarrierJobUnresolvedError);
    expect(e).toMatchObject({ kind: "human", remedy: "touch your security key" });
    expect(h.f.backend().stops).toBe(0);
    expect(record()).toMatchObject({ launch: "intent", job: null });
  });
});

describe("job.attach", () => {
  it("a detached file kind's new view gets its job file again", async () => {
    await h.setup({ ...FILE, view: "detached" });
    views({ handle: "file-job-1" });
    const a = await h.spawn();
    h.panes.delete(a.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
    const [attach] = h.calls("job.attach");
    expect(attach?.params.jobFile).toBe(jobFile());
    expect(handleOf(attach)).toBe("file-job-1");
  });

  it("a reply kind's attach carries no new field", async () => {
    await h.setup({ view: "detached" });
    const a = await h.spawn();
    h.panes.delete(a.paneId);
    const p = await previewReattach(h.db, "ws", "w1");
    await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
    const [attach] = h.calls("job.attach");
    expect(Object.keys(attach?.params ?? {}).sort()).toEqual(["deadline", "target"]);
  });
});
