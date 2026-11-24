// Final collect after a crash, through a real Git worktree and fetch (D10, F13).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { getCarrierJob, recordJobTree } from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import { acquireHost, drainHost, releaseHost } from "../src/host-lifecycle.js";
import { resolveHost } from "../src/host-provider.js";
import { getHostRecord, HostReferencedError, reserveProviderJob } from "../src/host-records.js";
import type { JobSpec } from "../src/jobs/types.js";
import type { PluginJobKind } from "../src/plugins/job.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { copyGitFixture, gitIn as git } from "./_git.js";
import { type FakePlugin, fakePlugin, providerSeams } from "./_plugin.js";

const SPEC: JobSpec = {
  workstream: "ws",
  name: "w",
  harness: "claude",
  role: "full-access",
  cmd: "claude",
  commandSource: "cli-key",
  cwd: "/r",
  env: {},
};

let dir: string;
let db: Db;
let f: FakePlugin;

async function provider() {
  f = fakePlugin(dir, { seams: providerSeams() });
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

describe("F13: a settle, then a crash before the final collect", () => {
  let local: string;
  let wt: string;
  let token: string;

  beforeEach(async () => {
    await provider();
    const rr = join(dir, "rr");
    mkdirSync(rr);
    copyGitFixture(rr);
    const base = git(rr, "rev-parse", "HEAD");
    wt = join(dir, "wt");
    git(rr, "worktree", "add", "-q", "--detach", wt, base);
    local = join(dir, "local");
    mkdirSync(local);
    copyGitFixture(local);
    token = reserve();
    const view = resolveHost(db, "box");
    await (view.jobKind as PluginJobKind).start(view, SPEC, token);
    const a = insertAgent(db, {
      reservation: token,
      name: "w",
      workstream: "ws",
      paneId: "%1",
      host: "box",
      cwd: wt,
      base,
      repo: rr,
    });
    recordJobTree(db, token, { path: wt, base, agentId: a.incarnation, collectRepo: local });
    // The turn settled with a commit; then mu crashed and the row was reaped.
    writeFileSync(join(wt, "f"), "x");
    git(wt, "add", "f");
    git(wt, "commit", "-q", "-m", "work");
    deleteAgent(db, "w", "ws");
  });

  it("the flag stays set: a collect before the stop, a read or a settle never clears it; release waits", async () => {
    const [rec] = listRemoteRecoveries(db);
    const r = await collectRemoteAgent(db, {
      workstream: "ws",
      name: "w",
      repo: local,
      recoveryId: rec?.agentId ?? 0,
    });
    expect(r.changed).toBe(true);
    expect(getCarrierJob(db, token)?.finalOwed).toBe(true);
    await drainHost(db, "box");
    const err = await releaseHost(db, "box").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostReferencedError);
    expect(String(err)).toMatch(/final collect owed by ws\/w/);
  });

  it("the next close stops the job, runs the final collect from collect_repo, then closes the tree", async () => {
    const head = git(wt, "rev-parse", "HEAD");
    const r = await closeAgent(db, "w", { workstream: "ws", force: true });
    expect(f.backend().stops).toBe(1);
    expect(git(local, "rev-parse", "refs/mu/collect/ws/w")).toBe(head);
    expect(getCarrierJob(db, token)).toBeUndefined();
    expect(r.carrierJobs).toEqual([{ host: "box", job: "job-1", action: "stopped" }]);
    expect(r.recovery).toMatchObject({ deleted: true });
    expect(listRemoteRecoveries(db)).toEqual([]);
    await drainHost(db, "box");
    await releaseHost(db, "box");
    expect(getHostRecord(db, "box")).toBeUndefined();
  });

  it("a final collect that cannot run keeps the record and the tree, after the stop", async () => {
    db.prepare("UPDATE carrier_jobs SET collect_repo = NULL").run();
    await expect(closeAgent(db, "w", { workstream: "ws" })).rejects.toThrow(
      /final collect is owed/,
    );
    expect(getCarrierJob(db, token)).toMatchObject({ finalOwed: true, stopGen: 1 });
    expect(listRemoteRecoveries(db)).toHaveLength(1);
    // mu agent collect, after the stop, clears it.
    const [rec] = listRemoteRecoveries(db);
    await collectRemoteAgent(db, {
      workstream: "ws",
      name: "w",
      repo: local,
      recoveryId: rec?.agentId ?? 0,
    });
    expect(getCarrierJob(db, token)?.finalOwed).toBe(false);
  });
});
