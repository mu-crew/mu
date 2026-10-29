// `mu doctor`'s `lease-job` hint (spec 2026-10-28-lease-transport.md, § next, doctor):
// a carrier_jobs reservation whose agent is gone or was never bound, with its close
// command. A HINT: never a fail row, never a non-zero exit. Fast tier: in-process
// runCli, per-test temp DB and state dir, mocked tmux.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import {
  bindCarrierJobAgent,
  fillCarrierJob,
  markCarrierLaunch,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { openDb } from "../src/db.js";
import { leaseJobHints } from "../src/doctor-summary.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";

const STATE_KEY = "MU_STATE_DIR";
let dir: string;
let dbPath: string;
let mux: MuxHarness;
let savedState: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-lease-doctor-"));
  dbPath = join(dir, "mu.db");
  savedState = process.env[STATE_KEY];
  process.env[STATE_KEY] = dir;
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  const reserve = (name: string) => {
    const r = reserveCarrierJob(db, { workstream: "auth", name, host: "dev", hostStop: "s {job}" });
    if (r === undefined) throw new Error("reserved");
    markCarrierLaunch(db, r.token);
    return r;
  };
  // gone: bound to a row that was deleted, with a handle
  const gone = reserve("w-gone");
  const a = insertAgent(db, {
    name: "w-gone",
    workstream: "auth",
    paneId: "%1",
    host: "dev",
    reservation: gone.token,
  });
  bindCarrierJobAgent(db, gone.token, a.incarnation, "%1");
  fillCarrierJob(db, gone.token, "job-9");
  deleteAgent(db, "w-gone", "auth");
  // never bound, no handle
  reserve("w-never");
  // live: bound to a row that exists (no hint)
  const live = reserve("w-live");
  const b = insertAgent(db, {
    name: "w-live",
    workstream: "auth",
    paneId: "%2",
    host: "dev",
    reservation: live.token,
  });
  bindCarrierJobAgent(db, live.token, b.incarnation, "%2");
  fillCarrierJob(db, live.token, "job-2");
  db.close();
  mux = installMux("tmux", [
    ["-V", "tmux 3.4"],
    ["", ""],
  ]);
});

afterEach(() => {
  mux.restore();
  if (savedState === undefined) delete process.env[STATE_KEY];
  else process.env[STATE_KEY] = savedState;
  rmFixtureDir(dir);
});

describe("doctor lease-job hint", () => {
  it("lists reservations whose agent is gone or never bound, each with its close command", () => {
    const db = openDb({ path: dbPath });
    try {
      expect(leaseJobHints(db)).toEqual([
        expect.objectContaining({
          name: "w-gone",
          job: "job-9",
          close: "mu agent close w-gone -w auth",
        }),
        expect.objectContaining({
          name: "w-never",
          job: null,
          agentId: null,
          close: "mu agent close w-never -w auth",
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("the human doctor prints a hint row (not FAIL) and exits 0", async () => {
    const r = await runCli(["doctor"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toMatch(/lease-job\s+: .*hint/);
    expect(r.stdout).toContain(
      "auth/w-gone on dev: job job-9, agent gone: mu agent close w-gone -w auth",
    );
    expect(r.stdout).toContain("auth/w-never on dev: no job handle");
    expect(r.stdout).not.toContain("w-live on dev");
    expect(r.stdout).not.toMatch(/lease-job\s+: .*FAIL/);
  });

  it("--json carries the hints under housekeeping.leaseJobs and stays ok", async () => {
    const r = await runCliJson(["doctor", "--json"], dbPath);
    expect(r.doc.ok).toBe(true);
    const hints = (r.data as { housekeeping: { leaseJobs: { name: string; close: string }[] } })
      .housekeeping.leaseJobs;
    expect(hints.map((h) => h.name)).toEqual(["w-gone", "w-never"]);
  });
});
