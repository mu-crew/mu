// The host policies (plugins spec D10, R8), over the fake plugin as a
// provider: the final-collect flag and its stop-generation compare-and-clear
// the in-life collect's backoff, and the deadline notice.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bumpStopGen, clearFinalCollect, getCarrierJob } from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import { acquireHost } from "../src/host-lifecycle.js";
import { deadlineNotice, IN_LIFE_BACKOFF_MAX_MS, inLifeCollect } from "../src/host-policy.js";
import { reserveProviderJob } from "../src/host-records.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { fakePlugin, providerSeams } from "./_plugin.js";

let dir: string;
let db: Db;

async function provider(config: Record<string, unknown> = {}) {
  const f = fakePlugin(dir, { seams: providerSeams(), ...config });
  await addPlugin(db, "fake", f.argv);
  return acquireHost(db, { name: "box", provider: "fake", params: {}, repo: null });
}
const reserve = (worktree = true) =>
  reserveProviderJob(db, "box", {
    workstream: "ws",
    name: "w",
    kind: "fakejob",
    plugin: "fake",
    worktree,
  })?.token ?? "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhpol-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "ws");
});

afterEach(async () => {
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

describe("the final-collect flag (D10, R8)", () => {
  it("is owed only by a --worktree job on a provider host", async () => {
    await provider();
    expect(getCarrierJob(db, reserve(true))?.finalOwed).toBe(true);
    db.prepare("DELETE FROM carrier_jobs").run();
    expect(getCarrierJob(db, reserve(false))?.finalOwed).toBe(false);
  });

  it("clears only under the stop generation read before the fetch: an older collect never clears a newer turn", async () => {
    await provider();
    const t = reserve();
    // A collect that started before any stop read no generation: it clears nothing.
    expect(getCarrierJob(db, t)?.stopGen).toBeNull();
    const g1 = bumpStopGen(db, t) ?? 0;
    const g2 = bumpStopGen(db, t) ?? 0;
    expect(g2).toBe(g1 + 1);
    // A collect that read g1, finishing after another stop: refused.
    expect(clearFinalCollect(db, t, g1)).toBe(false);
    expect(getCarrierJob(db, t)?.finalOwed).toBe(true);
    expect(clearFinalCollect(db, t, g2)).toBe(true);
    // Only forward: nothing sets it again, and a second clear changes nothing.
    expect(clearFinalCollect(db, t, g2)).toBe(false);
    expect(getCarrierJob(db, t)).toMatchObject({ finalOwed: false, stopGen: g2 });
  });
});

describe("in-life collects (D10)", () => {
  it("only on a host with idle reclaim or a deadline; failures back off from the poll interval, doubling to 5 minutes; never the flag", async () => {
    await provider({ hostFacts: { idleReclaimMs: 60_000 } });
    const t = reserve();
    let fail = true;
    const collect = async () => {
      if (fail) throw new Error("no answer");
    };
    const at = 1_000_000;
    expect(await inLifeCollect(db, t, collect, { pollMs: 1000, at })).toBe("failed");
    expect(getCarrierJob(db, t)).toMatchObject({ collectNextAt: at + 1000, collectDelayMs: 1000 });
    expect(await inLifeCollect(db, t, collect, { pollMs: 1000, at: at + 500 })).toBe("skipped");
    expect(await inLifeCollect(db, t, collect, { pollMs: 1000, at: at + 1000 })).toBe("failed");
    expect(getCarrierJob(db, t)?.collectDelayMs).toBe(2000);
    for (let i = 0; i < 12; i++)
      await inLifeCollect(db, t, collect, { pollMs: 1000, at: at + 10_000_000 * (i + 1) });
    expect(getCarrierJob(db, t)?.collectDelayMs).toBe(IN_LIFE_BACKOFF_MAX_MS);
    fail = false;
    expect(await inLifeCollect(db, t, collect, { pollMs: 1000, at: at + 1e9 })).toBe("collected");
    expect(getCarrierJob(db, t)).toMatchObject({
      collectNextAt: null,
      collectDelayMs: null,
      finalOwed: true,
    });
  });

  it("a host with neither idle reclaim nor a deadline gets none", async () => {
    await provider();
    const t = reserve();
    let ran = false;
    expect(
      await inLifeCollect(
        db,
        t,
        async () => {
          ran = true;
        },
        { pollMs: 1000 },
      ),
    ).toBe("skipped");
    expect(ran).toBe(false);
  });
});

describe("deadlineNotice (D10)", () => {
  it("names the deadline and whether the margin is reached", async () => {
    const at = Date.now();
    const rec = await provider({ hostFacts: { deadlineAt: at + 3_600_000 } });
    if (rec === undefined) throw new Error("no record");
    expect(deadlineNotice(rec, at)).toEqual({
      deadlineAt: at + 3_600_000,
      leftMs: 3_600_000,
      inMargin: false,
    });
    expect(deadlineNotice(rec, at + 3_100_000)?.inMargin).toBe(true);
    expect(deadlineNotice({ ...rec, deadline_at: null }, at)).toBeUndefined();
  });
});
