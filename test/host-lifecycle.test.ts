// Provider hosts (plugins spec D1, D5, D6, D7 G3), over the fake plugin as a
// provider: `mu host acquire`/`drain`/`release`/`--abandon`, atomic admission,
// the release proof, the host identity a recovery pins, and the provider-host
// base rule (`link.push`, `RemoteBaseMissingError`).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { getCarrierJob } from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import { EffectHeldError, getEffect, setEffectOwnerForTests, writeEffect } from "../src/effects.js";
import {
  abandonHost,
  acquireHost,
  drainHost,
  observeHost,
  releaseHost,
} from "../src/host-lifecycle.js";
import { hostIdentity, resolveHost } from "../src/host-provider.js";
import {
  getHostRecord,
  HostDeadlineError,
  HostJobsFullError,
  HostReferencedError,
  HostStateError,
  reserveProviderJob,
} from "../src/host-records.js";
import { addHost, HostExistsError } from "../src/hosts.js";
import { listLogs } from "../src/logs.js";
import { EffectOutcomeUnknownError } from "../src/plugins/errors.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import {
  assertRecoveryUsable,
  listRemoteRecoveries,
  RemoteRecoveryRefusedError,
} from "../src/remote-recovery.js";
import { prepareProviderWorktree, RemoteBaseMissingError } from "../src/remote-worktree.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, providerSeams } from "./_plugin.js";

let dir: string;
let db: Db;
let f: FakePlugin;

/** A pid that existed and is gone now. */
const deadPid = (): number =>
  Number(spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());

async function setup(config: Record<string, unknown> = {}, seams = providerSeams()) {
  f = fakePlugin(dir, { seams, ...config });
  await addPlugin(db, "fake", f.argv);
}
const acquire = (name = "box") =>
  acquireHost(db, { name, provider: "fake", params: { size: "s" }, repo: "/work" });
const reserve = (name = "w", worktree = true) =>
  reserveProviderJob(db, "box", {
    workstream: "ws",
    name,
    kind: "fakejob",
    plugin: "fake",
    worktree,
  });
const events = () => listLogs(db, { limit: 100 }).map((l) => l.payload);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhl-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "ws");
});

afterEach(async () => {
  setEffectOwnerForTests(undefined);
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

describe("mu host acquire (D1)", () => {
  it("writes the record with its effect, records the facts, and logs it", async () => {
    await setup({ hostFacts: { maxJobs: 3, idleReclaimMs: 60_000 } });
    const rec = await acquire();
    expect(rec).toMatchObject({
      name: "box",
      provider: "fake",
      state: "ready",
      handle: "host-1",
      max_jobs: 3,
      idle_reclaim_ms: 60_000,
      repo: "/work",
      params_json: '{"size":"s"}',
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM effects").get()).toEqual({ n: 0 });
    expect(resolveHost(db, "box")).toMatchObject({ name: "box", record: { id: rec?.id } });
    expect(events().some((e) => e.startsWith("host acquire box"))).toBe(true);
  });

  it("a permanent error deletes the record: nothing happened", async () => {
    await setup({ faults: { "host.acquire": ["permanent"] } });
    await expect(acquire()).rejects.toThrow(/permanent/);
    expect(getHostRecord(db, "box")).toBeUndefined();
  });

  it("an unknown outcome stays acquiring; a re-run resolves the same key, never a second host", async () => {
    await setup({ faults: { "host.acquire": ["effectThenExit"] } });
    await expect(acquire()).rejects.toBeInstanceOf(EffectOutcomeUnknownError);
    expect(getHostRecord(db, "box")?.state).toBe("acquiring");
    const rec = await acquire();
    expect(rec).toMatchObject({ state: "ready", handle: "host-1" });
    expect(f.backend().acquires).toBe(1);
    const keys = f
      .calls()
      .filter((c) => c.method === "host.acquire")
      .map((c) => c.params.key);
    expect(f.calls().filter((c) => c.method === "host.lookup")[0]?.params.key).toBe(keys[0]);
  });

  it("a crashed acquire whose lookup proves none (creator and plugin gone, fenced) is deleted", async () => {
    await setup({ faults: { "host.acquire": ["exit"] } });
    setEffectOwnerForTests({ pid: deadPid(), start: null });
    await expect(acquire()).rejects.toBeInstanceOf(EffectOutcomeUnknownError);
    setEffectOwnerForTests(undefined);
    await closePluginSessions();
    expect(await acquire()).toBeUndefined();
    expect(getHostRecord(db, "box")).toBeUndefined();
    expect(f.backend().acquires ?? 0).toBe(0);
  });

  it("a name is a profile's or a record's: each refuses the other", async () => {
    await setup();
    addHost(db, {
      name: "dev",
      shell: "s",
      exec: "e {cmd}",
      fetch: "f",
      repo: null,
      max_sessions: null,
    });
    await expect(acquire("dev")).rejects.toBeInstanceOf(HostExistsError);
    await acquire();
    expect(() =>
      addHost(db, {
        name: "box",
        shell: "s",
        exec: "e {cmd}",
        fetch: "f",
        repo: null,
        max_sessions: null,
      }),
    ).toThrow(HostExistsError);
    await expect(acquire()).rejects.toBeInstanceOf(HostExistsError);
  });
});

describe("atomic admission (D6)", () => {
  it("a ready host reserves a job record by id; a --worktree one owes its final collect", async () => {
    await setup({ hostFacts: { maxJobs: 1 } });
    const rec = await acquire();
    const j = reserve();
    expect(j).toMatchObject({ hostId: rec?.id, finalOwed: true, plugin: "fake", kind: "fakejob" });
    expect(() => reserve("w2")).toThrow(HostJobsFullError);
    db.prepare("DELETE FROM carrier_jobs").run();
    expect(reserve("w3", false)).toMatchObject({ finalOwed: false });
  });

  it("inside the deadline margin a spawn refuses and the host drains", async () => {
    await setup({ hostFacts: { deadlineAt: Date.now() + 60_000 } });
    await acquire();
    expect(() => reserve()).toThrow(HostDeadlineError);
    expect(getHostRecord(db, "box")?.state).toBe("draining");
    expect(() => reserve()).toThrow(HostStateError);
  });

  it("a spawn and a release never both pass: each refuses after the other", async () => {
    await setup();
    await acquire();
    reserve();
    await drainHost(db, "box");
    await expect(releaseHost(db, "box")).rejects.toBeInstanceOf(HostReferencedError);
    expect(getHostRecord(db, "box")?.state).toBe("draining");
    db.prepare("DELETE FROM carrier_jobs").run();
    await releaseHost(db, "box");
    expect(() => reserve()).toThrow(HostStateError);
  });
});

describe("mu host release (D1)", () => {
  it("a ready host must be drained; the release waits for every agent, job and recovery record, listing owed collects", async () => {
    await setup();
    await acquire();
    await expect(releaseHost(db, "box")).rejects.toBeInstanceOf(HostStateError);
    reserve();
    insertAgent(db, { name: "a1", workstream: "ws", paneId: "%1", host: "box" });
    await drainHost(db, "box");
    const err = await releaseHost(db, "box").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostReferencedError);
    expect(String(err)).toMatch(/agents ws\/a1; job records ws\/w; final collect owed by ws\/w/);
    expect(f.backend().releases ?? 0).toBe(0);
  });

  it("a crash after the release intent is reissued and converges: one release", async () => {
    await setup({ faults: { "host.release": ["effectThenExit"] } });
    await acquire();
    await drainHost(db, "box");
    await expect(releaseHost(db, "box")).rejects.toBeInstanceOf(EffectOutcomeUnknownError);
    expect(getHostRecord(db, "box")?.state).toBe("releasing");
    await releaseHost(db, "box");
    expect(getHostRecord(db, "box")).toBeUndefined();
    expect(f.backend().releases).toBe(1);
    expect(events().some((e) => e.startsWith("host release box"))).toBe(true);
  });

  it("a gone status makes the host lost, and a lost host releases as it is", async () => {
    await setup();
    await acquire();
    f.set({ hostGone: "reclaimed" });
    expect(await observeHost(db, "box")).toEqual({ state: "gone", reason: "reclaimed" });
    expect(getHostRecord(db, "box")).toMatchObject({ state: "lost", reason: "reclaimed" });
    await releaseHost(db, "box");
    expect(getHostRecord(db, "box")).toBeUndefined();
  });
});

describe("mu host release --abandon (D1)", () => {
  it("refuses while an agent row names the host, or an effect on it has a live owner", async () => {
    await setup();
    const rec = await acquire();
    insertAgent(db, { name: "a1", workstream: "ws", paneId: "%1", host: "box" });
    expect(() => abandonHost(db, "box")).toThrow(HostReferencedError);
    db.prepare("DELETE FROM agents").run();
    writeEffect(db, {
      key: "live",
      subject: { kind: "host", id: String(rec?.id) },
      plugin: "fake",
      method: "host.release",
      params: {},
      instance: "fake-1",
      pgid: process.pid,
      pgidStart: null,
    });
    expect(() => abandonHost(db, "box")).toThrow(EffectHeldError);
    expect(getHostRecord(db, "box")).toBeDefined();
  });

  it("drops the host, its job records, recovery records and dead effects in one go, naming each", async () => {
    await setup({}, providerSeams({ outlivesHost: true }));
    await acquire();
    const j = reserve();
    db.prepare("UPDATE carrier_jobs SET job = 'job-9' WHERE token = ?").run(j?.token);
    setEffectOwnerForTests({ pid: deadPid(), start: null });
    writeEffect(db, {
      key: "dead",
      subject: { kind: "job", id: j?.token ?? "" },
      plugin: "fake",
      method: "job.stop",
      params: {},
      instance: "fake-1",
      pgid: deadPid(),
      pgidStart: null,
    });
    setEffectOwnerForTests(undefined);
    insertAgent(db, {
      name: "r1",
      workstream: "ws",
      paneId: "%2",
      host: "box",
      cwd: "/wt",
      base: "b".repeat(40),
      repo: "/work",
    });
    deleteAgent(db, "r1", "ws");
    expect(listRemoteRecoveries(db)).toHaveLength(1);
    const out = abandonHost(db, "box");
    expect(out).toMatchObject({ host: "box", effects: ["job.stop dead"], running: ["ws/w"] });
    expect(out.jobs[0]).toMatch(/ws\/w \(job job-9\) uncollected work lost/);
    expect(getHostRecord(db, "box")).toBeUndefined();
    expect(getCarrierJob(db, j?.token ?? "")).toBeUndefined();
    expect(getEffect(db, "dead")).toBeUndefined();
    expect(listRemoteRecoveries(db)).toEqual([]);
    expect(events().find((e) => e.includes("abandoned"))).toMatch(/possibly still running: ws\/w/);
    expect(f.backend().releases ?? 0).toBe(0);
  });
});

describe("the host identity a recovery pins (D5)", () => {
  it("is provider:<id>:<instance>; a name acquired again has a new id, so its recovery refuses", async () => {
    await setup();
    const rec = await acquire();
    expect(hostIdentity(db, "box")).toBe(`provider:${rec?.id}:fake-1`);
    expect(resolveHost(db, "box").link.fingerprint(resolveHost(db, "box"))).toBe(
      `provider:${rec?.id}:fake-1`,
    );
    insertAgent(db, {
      name: "r1",
      workstream: "ws",
      paneId: "%2",
      host: "box",
      cwd: "/wt",
      base: "b".repeat(40),
      repo: "/work",
    });
    deleteAgent(db, "r1", "ws");
    const [r] = listRemoteRecoveries(db);
    expect(r).toMatchObject({ hostIdentity: `provider:${rec?.id}:fake-1`, hostExec: null });
    if (r === undefined) throw new Error("no record");
    expect(() => assertRecoveryUsable(db, r)).not.toThrow();
    db.prepare("DELETE FROM hosts").run();
    await acquire();
    expect(() => assertRecoveryUsable(db, r)).toThrow(RemoteRecoveryRefusedError);
  });

  it("a file from before host_identity gets the column, its records backfilled from host_exec, and the new triggers", () => {
    addHost(db, {
      name: "dev",
      shell: "s",
      exec: "e {cmd}",
      fetch: "f",
      repo: null,
      max_sessions: null,
    });
    insertAgent(db, {
      name: "r1",
      workstream: "ws",
      paneId: "%2",
      host: "dev",
      cwd: "/wt",
      base: "b".repeat(40),
      repo: "/r",
    });
    deleteAgent(db, "r1", "ws");
    db.exec(`
      DROP TRIGGER remote_recovery_agent_del_v2;
      DROP TRIGGER remote_recovery_workstream_del_v2;
      ALTER TABLE remote_recovery DROP COLUMN host_identity;
      CREATE TRIGGER remote_recovery_agent_del_v2 AFTER DELETE ON agents BEGIN SELECT 1; END;
      CREATE TRIGGER remote_recovery_workstream_del_v2 BEFORE DELETE ON workstreams BEGIN SELECT 1; END;
    `);
    const path = db.name;
    db.close();
    db = openDb({ path });
    expect(listRemoteRecoveries(db)[0]).toMatchObject({
      hostExec: "e {cmd}",
      hostIdentity: "e {cmd}",
    });
    const sql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'remote_recovery%'",
      )
      .all() as { sql: string }[];
    expect(sql).toHaveLength(2);
    for (const t of sql) expect(t.sql).toContain("host_identity");
  });
});

describe("the provider-host base (D7 G3)", () => {
  let local: string;
  let remote: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  let home: string | undefined;

  beforeEach(() => {
    home = process.env.HOME;
    process.env.HOME = dir;
    local = join(dir, "local");
    remote = join(dir, "remote");
    mkdirSync(local);
    git(local, "init", "-q");
    git(
      local,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    );
  });

  afterEach(() => {
    process.env.HOME = home;
  });

  it("with push: a commit made after the acquire reaches the host, and the worktree starts from it", async () => {
    await setup({}, providerSeams({}, { push: true }));
    await acquire();
    git(
      local,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "two",
    );
    const sha = git(local, "rev-parse", "HEAD");
    const site = await prepareProviderWorktree(resolveHost(db, "box"), {
      workstream: "ws",
      name: "w",
      localRepo: local,
      root: remote,
    });
    expect(site.base).toBe(sha);
    expect(git(site.cwd, "rev-parse", "HEAD")).toBe(sha);
    expect(f.calls().find((c) => c.method === "link.push")?.params).toMatchObject({
      localRepo: local,
      remoteRepo: remote,
      rev: sha,
    });
  });

  it("without push: a repo that lacks the commit refuses, naming the sha and the repo", async () => {
    await setup();
    await acquire();
    const sha = git(local, "rev-parse", "HEAD");
    const err = await prepareProviderWorktree(resolveHost(db, "box"), {
      workstream: "ws",
      name: "w",
      localRepo: local,
      root: remote,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteBaseMissingError);
    expect(String(err)).toContain(sha);
    expect(String(err)).toContain(remote);
    expect(f.calls().some((c) => c.method === "link.push")).toBe(false);
  });
});
