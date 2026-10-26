// The runtime's load-bearing invariant: never two refreshes at once. The
// projection and the ingest are replaced by controlled deferreds, so the test
// observes real concurrency (peak in flight), not promise identity.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { rmFixtureDir } from "./_fs.js";

const gate = vi.hoisted(() => ({
  active: 0,
  peak: 0,
  started: [] as string[],
  waiting: [] as (() => void)[],
}));

async function held(label: string): Promise<void> {
  gate.started.push(label);
  gate.peak = Math.max(gate.peak, ++gate.active);
  await new Promise<void>((resolve) => gate.waiting.push(resolve));
  gate.active--;
}

vi.mock("../src/dashboard-data.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard-data.js")>()),
  loadDashboard: async () => {
    await held("project");
    return {} as never;
  },
}));
vi.mock("../src/sync.js", async (orig) => ({
  ...(await orig<typeof import("../src/sync.js")>()),
  syncEnabled: () => true,
  ambientIngest: async () => {
    await held("ingest");
    return { warnings: [] } as never;
  },
}));

const { createRuntime } = await import("../src/cli/tui/runtime.js");

/** Let queued microtasks run so a wrongly-started second refresh would show up. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};
const release = async (): Promise<void> => {
  gate.waiting.shift()?.();
  await settle();
};

describe("dashboard runtime serialization", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mu-dash-rt-"));
    openDb({ path: join(tmp, "a.db") }).close();
    gate.active = gate.peak = 0;
    gate.started = [];
    gate.waiting = [];
  });
  afterEach(() => rmFixtureDir(tmp));

  it("a different query waits for the in-flight refresh (ingest and projection): peak 1", async () => {
    const syncDb = openDb({ path: join(tmp, "a.db") });
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb, caller: null, syncEveryMs: 0 });
    try {
      const first = rt.refresh({ status: ["OPEN"] });
      const same = rt.refresh({ status: ["OPEN"] });
      const second = rt.refresh({ status: ["CLOSED"] });
      expect(same).toBe(first);
      await settle();
      expect(gate.started).toEqual(["ingest"]); // second has not started anything
      await release(); // first's ingest done -> first's projection
      expect(gate.started).toEqual(["ingest", "project"]);
      await release(); // first done -> second may begin
      await first;
      expect(gate.started).toEqual(["ingest", "project", "ingest"]);
      await release();
      await release();
      await second;
      expect(gate.started).toHaveLength(4);
      expect(gate.peak).toBe(1);
    } finally {
      await rt.close();
      syncDb.close();
    }
  });

  it("close waits for the in-flight refresh", async () => {
    const syncDb = openDb({ path: join(tmp, "a.db") });
    const rt = createRuntime({ dbPath: join(tmp, "a.db"), syncDb, caller: null, syncEveryMs: 0 });
    const run = rt.refresh({});
    await settle();
    let closed = false;
    const closing = rt.close().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    await release();
    await release();
    await run;
    await closing;
    expect(closed).toBe(true);
    syncDb.close();
  });
});
