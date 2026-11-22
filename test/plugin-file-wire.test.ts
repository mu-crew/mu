// The open lease-wire findings of review_lease_wire_followups_2 (and pane_file_view_provenance_aba),
// end to end over the fake plugin's `handle: "file"` kind and a stub multiplexer, with gated
// plugin replies for the interleavings. One invariant: the record and the job file stay until
// the view (the job's dispatcher) is proven gone; a live view never outlives its record.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobKeptError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { previewReattach, reattachAgent } from "../src/agents/reattach.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { addHost } from "../src/hosts.js";
import { fakePlugin, jobSeams } from "./_plugin.js";
import { registerFixturePlugin } from "./_plugin-handshake.js";
import { CLOUD, pluginHostFixture } from "./_plugin-host.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

const h = pluginHostFixture({ handshakeInProcess: true });
const FILE = { handle: "file", start: { lookup: true, fenceKey: false } };
const jobFile = () => leaseJobFile(h.db, "ws", "w1");
const record = () => getCarrierJobByName(h.db, "ws", "w1");
const close = () => closeAgent(h.db, "w1", { workstream: "ws" });
const livePanes = () => [...h.panes.keys()];

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => err.mockRestore());

/** The invariant, as the end state must show it: a live view keeps its record and its file. */
function expectRetainedWhileLive(): void {
  if (livePanes().length === 0) return;
  expect({ record: record() !== undefined, file: existsSync(jobFile()) }).toEqual({
    record: true,
    file: true,
  });
}

// wire_stale_spawn_claims_replacement_file: a static plugin spawn awaits its remote prepare
// between reserving the name and claiming the job file; a close released it meanwhile and a
// replacement published. The stale spawn then moved the replacement's live file aside.
it("a spawn released during its prepare never moves its replacement's job file", async () => {
  h.f = fakePlugin(h.dir, {
    seams: { ...jobSeams({ channel: "cloud", ...FILE }), channel: CLOUD },
  });
  await registerFixturePlugin(h.db, h.f);
  addHost(h.db, { name: "box", plugin: "fake", fetch: "true", repo: h.dir, max_sessions: null });
  const gate = join(h.dir, "gate");
  h.f.set({ gate, faults: { "link.exec": ["gated"] } });
  h.stubMux({
    spawnAgent: async (s) => {
      h.panes.set("%9", { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      s.onPaneCreated?.("%9", FAKE_SERVER_IDENTITY);
      return "%9";
    },
  });
  const stale = h.spawn().catch((e: unknown) => e);
  try {
    await expect.poll(() => h.calls("link.exec").length).toBe(1);
    await expect(close()).resolves.toMatchObject({ carrierJobs: [{ action: "unlaunched" }] });
    const replacement = await h.spawn();
    expect(replacement.paneId).toBe("%9");
  } finally {
    writeFileSync(gate, "go");
  }
  expect(await stale).toBeInstanceOf(Error);
  expect(h.panes.has("%9")).toBe(true);
  expect(record()).toMatchObject({ job: "file-job-1", wireState: "bound", paneId: "%9" });
  expect(readFileSync(jobFile(), "utf8")).toBe("file-job-1\n");
  const siblings = readdirSync(dirname(jobFile())).filter((n) => n.includes(".stale-"));
  expect(siblings.filter((n) => n.startsWith(basename(jobFile())))).toEqual([]);
});

// wire_rollback_reattach_proof_race: the rollback proved the view gone and awaited job.stop
// without the agent lock; a same-process reattach opened %2 meanwhile, and the rollback then
// dropped the record and the file with %2 alive. Now one of them wins the record's revision.
it("a rollback and a concurrent reattach: never a live view without its record and file", async () => {
  await h.setup({ ...FILE, view: "detached" });
  const gate = join(h.dir, "gate");
  h.f.set({ gate, faults: { "job.stop": ["gated"] } });
  let n = 0;
  h.stubMux({
    spawnAgent: async (s) => {
      const id = `%${++n}`;
      h.panes.set(id, { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      s.onPaneCreated?.(id, FAKE_SERVER_IDENTITY);
      if (n === 1) throw new Error("injected: the view failed after its id");
      return id;
    },
  });
  const spawning = h.spawn().catch((e: unknown) => e);
  let reattached: unknown;
  try {
    await expect.poll(() => h.calls("job.stop").length).toBe(1);
    expect(h.panes.has("%1")).toBe(false);
    reattached = await previewReattach(h.db, "ws", "w1")
      .then((p) => reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision }))
      .catch((e: unknown) => e);
  } finally {
    writeFileSync(gate, "go");
  }
  expect(await spawning).toMatchObject({ message: /after its id/ });
  expectRetainedWhileLive();
  // The rollback began releasing first: the reattach refuses and opens no view.
  expect(reattached).toMatchObject({ message: expect.stringMatching(/releasing it/) });
  expect(h.panes.has("%2")).toBe(false);
  expect({ record: record(), file: existsSync(jobFile()) }).toEqual({
    record: undefined,
    file: false,
  });
});

// wire_view_proof_wrong_mux_server (fast tier; the real-tmux twin is
// plugin-file-view-server.integration.test.ts): a close from another mux server proved the view
// absent there and stopped the job, dropping the record and the file of a live dispatcher.
it("a close from another mux server proves nothing: the job, record and file stay", async () => {
  await h.setup({ ...FILE, view: "detached" });
  const a = `${process.pid}|1`; // a live server process: it cannot be proven gone
  h.stubMux({
    spawnAgent: async (s) => {
      h.panes.set("%1", { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      s.onPaneCreated?.("%1", a);
      return "%1";
    },
    serverIdentity: async () => a,
  });
  await h.spawn();
  expect(record()).toMatchObject({ viewServer: `tmux:${a}`, paneId: "%1" });
  const onA = new Map(h.panes);
  h.panes.clear(); // server B: no such pane
  h.stubMux({ serverIdentity: async () => undefined });
  await expect(close()).rejects.toThrow(CarrierJobKeptError);
  await expect(close()).rejects.toThrow(/which this mu does not drive/);
  expect(h.f.backend().stops).toBe(0);
  expect(existsSync(jobFile())).toBe(true);
  expect(record()).toBeDefined();
  expect(onA.has("%1")).toBe(true);
});

// wire_tmux_identity_not_atomic (fast tier; the real-tmux twin is
// plugin-file-view-server.integration.test.ts): the server that answers after a view's birth is
// not the one the pane was created on. The record binds the creation call's own answer, never
// a later sample, and a close routed to the later server proves nothing.
it("a view is bound to the server its creation call reported, not one sampled after", async () => {
  await h.setup({ ...FILE, view: "detached" });
  const born = `${process.pid}|1`; // a live server process: it cannot be proven gone
  h.stubMux({
    spawnAgent: async (s) => {
      h.panes.set("%1", { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      s.onPaneCreated?.("%1", born);
      return "%1";
    },
    serverIdentity: async () => "22|2", // the server answering any later call
  });
  await h.spawn();
  expect(record()).toMatchObject({ wireState: "bound", paneId: "%1", viewServer: `tmux:${born}` });
  h.panes.clear(); // the later server has no such pane
  await expect(close()).rejects.toThrow(/which this mu does not drive/);
  expect(h.f.backend().stops).toBe(0);
  expect(existsSync(jobFile())).toBe(true);
});

// pane_file_view_provenance_aba: a reattach interrupted once its view reported %1 on a restarted
// server: the record names that view and that server together, never the old server's identity.
it("a reattach on a restarted server reusing %1: the record binds the new view, close refuses", async () => {
  await h.setup({ ...FILE, view: "detached" });
  let server = "999999|1"; // A: its process is gone once restarted
  let n = 0;
  h.stubMux({
    spawnAgent: async (s) => {
      n++;
      h.panes.set("%1", { command: s.command });
      writeFileSync(jobFile(), "file-job-1\n");
      s.onPaneCreated?.("%1", server);
      if (n === 2) throw new Error("injected: interrupted after its id");
      return "%1";
    },
    serverIdentity: async () => server,
    killPane: async () => {}, // the interrupted view survives
  });
  await h.spawn();
  h.panes.clear(); // A restarted as B: A's %1 is gone
  server = `${process.pid}|2`;
  await expect(
    previewReattach(h.db, "ws", "w1").then((p) =>
      reattachAgent(h.db, "ws", "w1", { ifRevision: p.revision }),
    ),
  ).rejects.toThrow(/interrupted/);
  expect(record()).toMatchObject({ paneId: "%1", viewServer: `tmux:${server}` });
  await expect(close()).rejects.toThrow(/is alive/);
  expect(h.f.backend().stops).toBe(0);
  expect(existsSync(jobFile())).toBe(true);
  expectRetainedWhileLive();
});
