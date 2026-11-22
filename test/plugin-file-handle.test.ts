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
import { CarrierJobKeptError, CarrierJobUnresolvedError } from "../src/agents/errors.js";
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
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

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
      s.onPaneCreated?.(id, FAKE_SERVER_IDENTITY);
      return id;
    },
  });
}

/** A view whose window opens and publishes, then the backend fails before reporting its id. */
function noIdView(pane = "%9"): void {
  h.stubMux({
    spawnAgent: async (s) => {
      h.panes.set(pane, { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      throw new Error("injected: no pane id");
    },
  });
}

/** A view that reports its id, then fails; the kill does not take (it survives). */
function survivingView(pane = "%9"): void {
  h.stubMux({
    spawnAgent: async (s) => {
      h.panes.set(pane, { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      s.onPaneCreated?.(pane, FAKE_SERVER_IDENTITY);
      throw new Error("injected: the view failed after its id");
    },
    killPane: async () => {},
  });
}

/** A detached file kind's agent whose view %1 is gone (its job runs, file-job-1 published). */
async function detachedWithGoneView(): Promise<void> {
  await h.setup({ ...FILE, view: "detached" });
  views({ handle: "file-job-1" });
  const a = await h.spawn();
  h.panes.delete(a.paneId);
}

async function reattach(): Promise<void> {
  const p = await previewReattach(h.db, "ws", "w1");
  await reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision });
}

const close = () => closeAgent(h.db, "w1", { workstream: "ws" });

/** As if the record were written before view tracking: its view column dropped, then upgraded. */
function legacyRecord(): void {
  const cols = h.db
    .prepare(
      "SELECT name FROM pragma_table_info('carrier_jobs') WHERE name IN ('wire_state', 'wire_rev', 'view_server')",
    )
    .all() as Array<{ name: string }>;
  for (const c of cols) h.db.exec(`ALTER TABLE carrier_jobs DROP COLUMN ${c.name}`);
  h.db.close();
  h.db = openDb({ path: join(h.dir, "mu.db") });
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

  // wire_close_unproven_view: the rollback's refusal was in memory only; a plain close after it
  // stopped the job and dropped record and file while %9, the dispatcher, still ran.
  it("a close after that rollback refuses too: the view is still unproven; --abandon-job drops it", async () => {
    await h.setup(FILE);
    h.stubMux({
      spawnAgent: async (s) => {
        h.panes.set("%9", { command: s.command });
        writeFileSync(jobFile(), "file-job-1\n");
        throw new Error("injected: no pane id");
      },
    });
    await expect(h.spawn()).rejects.toThrow(/no pane id/);
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    await expect(closeAgent(h.db, "w1", { workstream: "ws" })).rejects.toThrow(
      /its view \(the job's dispatcher\) opened with no pane id/,
    );
    expect(h.panes.has("%9")).toBe(true);
    expect(h.f.backend().stops).toBe(0);
    expect(existsSync(jobFile())).toBe(true);
    expect(record()).toMatchObject({ launch: "intent", job: "file-job-1" });
    await closeAgent(h.db, "w1", { workstream: "ws", abandonJob: true });
    expect(h.f.backend().stops).toBe(0);
    expect(record()).toBeUndefined();
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

// The one rule (ladder placement §10): a file kind's record and job file are retained until its
// view, the job's dispatcher, is PROVEN gone (proveViewGone); unknown always retains.
describe("the view rule", () => {
  // wire_close_spawn_stale_view: close snapshotted the record before its awaited host.status and
  // proved absence from that snapshot, while the spawn marked its view outside the agent lock;
  // the close released the record and the spawn then opened its dispatcher for nothing.
  it("a close racing the spawn: the record is fenced before the view can open, never after", async () => {
    await h.setup(FILE);
    let opened = 0;
    h.stubMux({
      spawnAgent: async (s) => {
        opened++;
        h.panes.set("%9", { command: s.command });
        writeFileSync(jobFile(), "file-job-1\n");
        s.onPaneCreated?.("%9", FAKE_SERVER_IDENTITY);
        return "%9";
      },
    });
    const lateAt = (m: string) => [...h.calls(m).map(() => "ok"), "late"];
    h.f.set({ lateMs: 400, faults: { "job.start": lateAt("job.start") } });
    const spawned = h.spawn().then(
      () => undefined,
      (e: unknown) => e,
    );
    for (let i = 0; i < 200 && h.calls("job.start").length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // The close's observation answers after the start does: the spawn reaches its view meanwhile.
    h.f.set({ faults: { "job.start": ["late"], "host.status": lateAt("host.status") } });
    await close();
    expect(await spawned).toBeInstanceOf(Error);
    expect(opened).toBe(0);
    expect(h.panes.size).toBe(0);
    expect(h.f.backend().stops).toBe(1);
    expect(record()).toBeUndefined();
  });

  // wire_reattach_unproven_view: reattach marked nothing before its mux call; a replacement view
  // opened with no id left the record proving only the previous (gone) pane.
  it("a reattach whose replacement opened with no pane id: a close refuses, all kept", async () => {
    await detachedWithGoneView();
    noIdView();
    await expect(reattach()).rejects.toThrow(/no pane id/);
    await expect(close()).rejects.toThrow(/opened with no pane id/);
    expect(h.panes.has("%9")).toBe(true);
    expect(h.f.backend().stops).toBe(0);
    expect(existsSync(jobFile())).toBe(true);
    expect(record()).toMatchObject({ job: "file-job-1" });
  });

  // wire_upgrade_unproven_view_default: the added column defaulted to "no view", so a record from
  // before it (the no-id failure on the merge base) closed with its dispatcher alive.
  it("a record from before view tracking is unknown after the upgrade: a close refuses", async () => {
    await h.setup(FILE);
    noIdView();
    await expect(h.spawn()).rejects.toThrow(/no pane id/);
    legacyRecord();
    await expect(close()).rejects.toThrow(/predates view tracking/);
    expect(h.f.backend().stops).toBe(0);
    expect(existsSync(jobFile())).toBe(true);
    expect(record()).toMatchObject({ launch: "intent", job: "file-job-1" });
  });

  const paths: Array<{ path: string; run: () => Promise<void> }> = [
    {
      path: "spawn rollback: view opened, no pane id",
      run: async () => {
        await h.setup(FILE);
        noIdView();
        await expect(h.spawn()).rejects.toThrow(/no pane id/);
      },
    },
    {
      path: "spawn rollback: view reported, survives its kill",
      run: async () => {
        await h.setup(FILE);
        survivingView();
        await expect(h.spawn()).rejects.toThrow(/after its id/);
      },
    },
    {
      path: "close after a rollback whose view had no pane id",
      run: async () => {
        await h.setup(FILE);
        noIdView();
        await h.spawn().catch(() => {});
        await expect(close()).rejects.toThrow(CarrierJobKeptError);
      },
    },
    {
      path: "close after a rollback whose view survived",
      run: async () => {
        await h.setup(FILE);
        survivingView();
        await h.spawn().catch(() => {});
        // The row keeps %9 (the row rule): its close refuses on the live pane first.
        await expect(close()).rejects.toThrow(/pane %9 is still alive/);
      },
    },
    {
      path: "reattach failure (no pane id), then close",
      run: async () => {
        await detachedWithGoneView();
        noIdView();
        await reattach().catch(() => {});
        await expect(close()).rejects.toThrow(CarrierJobKeptError);
      },
    },
    {
      path: "reattach failure (reported, survives its kill), then close",
      run: async () => {
        await detachedWithGoneView();
        survivingView();
        await reattach().catch(() => {});
        await expect(close()).rejects.toThrow(/%9 \(the job's dispatcher\) has no provenance/);
      },
    },
    {
      path: "a second reattach while the failed attempt's view is unproven",
      run: async () => {
        await detachedWithGoneView();
        noIdView();
        await reattach().catch(() => {});
        await expect(reattach()).rejects.toThrow(/opened with no pane id/);
        expect(h.calls("job.attach")).toHaveLength(1);
      },
    },
    {
      path: "recovery: the row reaped, the handle lost, then a no-row close",
      run: async () => {
        await detachedWithGoneView();
        noIdView();
        await reattach().catch(() => {});
        await reconcile(h.db, { workstream: "ws" });
        h.db.prepare("UPDATE carrier_jobs SET job = NULL").run();
        await expect(close()).rejects.toThrow(CarrierJobKeptError);
      },
    },
    {
      path: "upgrade: a record from before view tracking, then close",
      run: async () => {
        await h.setup(FILE);
        noIdView();
        await h.spawn().catch(() => {});
        legacyRecord();
        await expect(close()).rejects.toThrow(CarrierJobKeptError);
      },
    },
  ];
  it.each(paths)("$path: record, job file and view kept, nothing stopped", async ({ run }) => {
    await run();
    expect(h.panes.has("%9")).toBe(true);
    expect(h.f.backend().stops).toBe(0);
    expect(existsSync(jobFile())).toBe(true);
    expect(record()).toBeDefined();
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
