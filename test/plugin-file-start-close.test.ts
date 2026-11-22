// wire_close_unlaunched_crosses_start_intent: a close decided "unlaunched" on the record after
// the spawn claimed its job file and before job.start wrote its intent; the start's intent then
// moved only `launch`, and the close's delete (token, null handle, same wire_rev) went through
// with the start's RPC in flight. The intent is now a wire transition: the close's release on
// the older revision refuses, and the record outlives the in-flight start.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { CarrierJobKeptError } from "../src/agents/errors.js";
import { leaseJobFile } from "../src/agents/lease-carrier.js";
import { getCarrierJobByName } from "../src/carrier-jobs.js";
import { getEffect } from "../src/effects.js";
import { pluginHostFixture } from "./_plugin-host.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

const latch = () => {
  let signal: () => void = () => {};
  const wait = new Promise<void>((r) => {
    signal = r;
  });
  return { signal, wait };
};
const startBefore = latch();
const letStart = latch();
const closeDecided = latch();
const letClose = latch();

// Pause at the production boundaries only: before job.start's effect is written, and after the
// close decided "unlaunched" (before it releases). SQL and results are untouched.
vi.mock("../src/plugins/reconcile.js", async (original) => {
  const real = await original<typeof import("../src/plugins/reconcile.js")>();
  return {
    ...real,
    runEffect: async (...args: Parameters<typeof real.runEffect>) => {
      if (args[1].method === "job.start") {
        startBefore.signal();
        await letStart.wait;
      }
      return real.runEffect(...args);
    },
  };
});
vi.mock("../src/host-policy.js", async (original) => {
  const real = await original<typeof import("../src/host-policy.js")>();
  return {
    ...real,
    closePluginJob: async (...args: Parameters<typeof real.closePluginJob>) => {
      const result = await real.closePluginJob(...args);
      if (result?.action === "unlaunched") {
        closeDecided.signal();
        await letClose.wait;
      }
      return result;
    },
  };
});

const h = pluginHostFixture({ handshakeInProcess: true });

it("an unlaunched close decided before job.start's intent cannot drop the record", async () => {
  await h.setup({ handle: "file", start: { lookup: true, fenceKey: false }, view: "detached" });
  // The view publishes the handle as the job's dispatcher would.
  h.stubMux({
    spawnAgent: async (s) => {
      h.panes.set("%9", { command: s.command });
      writeFileSync(leaseJobFile(h.db, "ws", "w1"), "file-job-1\n");
      s.onPaneCreated?.("%9", FAKE_SERVER_IDENTITY);
      return "%9";
    },
  });
  const gate = join(h.dir, "start-gate");
  h.f.set({ gate, faults: { "job.start": ["gated"] } });
  const record = () => getCarrierJobByName(h.db, "ws", "w1");
  const spawning = h.spawn().catch((e: unknown) => e);
  try {
    await startBefore.wait;
    const claimed = record();
    expect(claimed).toMatchObject({ wireState: "claimed", launch: "none", job: null });
    const closing = closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
    await closeDecided.wait;
    letStart.signal();
    await expect.poll(() => h.calls("job.start").length).toBe(1);
    expect(record()).toMatchObject({ launch: "intent", job: null });
    const intentRev = record()?.wireRev;
    expect(getEffect(h.db, claimed?.token ?? "")).toMatchObject({ state: "pending" });
    letClose.signal();
    const closed = await closing;
    expect(record()).toBeDefined();
    expect(closed).toBeInstanceOf(CarrierJobKeptError);
    // How: the intent moved the record's revision, so the close's release compared a stale one.
    expect(intentRev).not.toBe(claimed?.wireRev);
  } finally {
    letStart.signal();
    letClose.signal();
    writeFileSync(gate, "go");
  }
  // The start completes and the spawn dispatches its view from the intent's revision.
  expect(await spawning).toMatchObject({ name: "w1" });
  expect(record()).toMatchObject({ wireState: "bound" });
  expect(h.f.backend()).toMatchObject({ starts: 1, stops: 0 });
}, 15_000);
