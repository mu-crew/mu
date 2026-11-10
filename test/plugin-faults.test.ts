// Fault injection on plugin effects (plugins spec D4, D16): F1-F10 and F12,
// over the fake plugin's bound `reply` job kind and its deliveries. At every
// point replay yields exactly one effect (the fake backend counts the effects
// that really happened) and reconcile converges, or the effect stays unknown
// for a human where the rule table says so. F11 and F13 are P6d's.
//
// A crashed mu is a creator that is gone: the journal's owner seam names a
// pid that existed and exited (`deadPid`), and the plugin group it sent to is
// gone too once its session is closed.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { getCarrierJob, reserveCarrierJob } from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import { EffectHeldError, getEffect, setEffectOwnerForTests, writeEffect } from "../src/effects.js";
import { resolveHost } from "../src/host-provider.js";
import { addHost, HOST_GRACE_MS } from "../src/hosts.js";
import type { JobSpec } from "../src/jobs/types.js";
import { EffectFencedError } from "../src/plugins/errors.js";
import { type PluginJobKind, pluginJobRef } from "../src/plugins/job.js";
import { setPluginGraceForTests } from "../src/plugins/process.js";
import { narrowObject } from "../src/plugins/protocol.js";
import { resolveEffect, runEffect, setEffectTimeoutForTests } from "../src/plugins/reconcile.js";
import { addPlugin, closePluginSessions, pluginSession } from "../src/plugins/registry.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, jobSeams } from "./_plugin.js";

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
let kind: PluginJobKind;
let token: string;

/** A pid that existed and is gone now. */
function deadPid(): number {
  return Number(spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(patch: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  f = fakePlugin(dir, { seams: { ...jobSeams(patch), ...extra } });
  await addPlugin(db, "fake", f.argv);
  addHost(db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
  kind = resolveHost(db, "dev").jobKind as PluginJobKind;
  token =
    reserveCarrierJob(db, {
      workstream: "ws",
      name: "w",
      host: "dev",
      hostStop: null,
      plugin: { kind: kind.name, name: "fake" },
    })?.token ?? "";
}

const host = () => resolveHost(db, "dev");
const startParams = () => ({
  target: { job: { kind: "fakejob", key: token }, host: { name: "dev" } },
  key: token,
  spec: SPEC,
});
const jobCalls = (m: string) => f.calls().filter((c) => c.method === m);

/** The intent a crashed mu left: written by a gone creator to a gone plugin group. */
function crashedIntent(pgid = deadPid()) {
  setEffectOwnerForTests({ pid: deadPid(), start: null });
  writeEffect(
    db,
    {
      key: token,
      subject: { kind: "job", id: token },
      plugin: "fake",
      method: "job.start",
      params: startParams(),
      instance: "fake-1",
      pgid,
      pgidStart: null,
    },
    () =>
      db
        .prepare("UPDATE carrier_jobs SET launch = 'intent', instance = 'fake-1' WHERE token = ?")
        .run(token),
  );
  setEffectOwnerForTests(undefined);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpf-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(async () => {
  setEffectOwnerForTests(undefined);
  setEffectTimeoutForTests(undefined);
  setPluginGraceForTests(undefined);
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

describe("plugin faults (D16)", () => {
  it("F1: mu killed after the intent, before the call: the next touch claims it; none counts only under the gate", async () => {
    await setup();
    crashedIntent();
    const [r] = await kind.resolve(token);
    expect(r).toEqual({ state: "none" });
    expect(jobCalls("job.lookup")[0]?.params).toMatchObject({ key: token, fence: true });
    expect(getEffect(db, token)).toBeUndefined();
    expect(getCarrierJob(db, token)).toMatchObject({ launch: "none", job: null });
    expect(f.backend().starts).toBe(0);
  });

  it("F2: the plugin killed mid-call: unknown outcome, then resolved by the rule table once the creator is gone", async () => {
    await setup();
    f.set({ faults: { "job.start": ["exit"] } });
    const creator = { pid: deadPid(), start: null };
    setEffectOwnerForTests(creator);
    await expect(kind.start(host(), SPEC, token)).rejects.toThrow(/outcome unknown/);
    setEffectOwnerForTests(undefined);
    expect(getEffect(db, token)?.state).toBe("unknown");
    const [r] = await kind.resolve(token);
    expect(r).toEqual({ state: "none" });
    expect(f.backend().starts).toBe(0);
    expect(getCarrierJob(db, token)?.launch).toBe("none");
  });

  it("F3: mu killed after the effect, before its result: lookup returns it; one effect", async () => {
    await setup();
    crashedIntent();
    // The effect happened: the plugin got the persisted request.
    const s = await pluginSession(db, "fake");
    await s.call("job.start", startParams(), { kind: "effect", timeoutMs: 5000 }, narrowObject);
    const [r] = await kind.resolve(token);
    expect(r).toMatchObject({ state: "recorded", via: "lookup" });
    expect(f.backend().starts).toBe(1);
    expect(getCarrierJob(db, token)?.job).toBe("job-1");
  });

  it("F3 without lookup: a deduped resend returns it; one effect", async () => {
    await setup({
      start: { lookup: false, dedupe: { exact: true, windowMs: 60_000 }, fenceKey: false },
    });
    crashedIntent();
    const s = await pluginSession(db, "fake");
    await s.call("job.start", startParams(), { kind: "effect", timeoutMs: 5000 }, narrowObject);
    const [r] = await kind.resolve(token);
    expect(r).toMatchObject({ state: "recorded", via: "reply" });
    expect(f.backend().starts).toBe(1);
    expect(getCarrierJob(db, token)?.job).toBe("job-1");
  });

  it("F4: the reply lost (stdout closed): as F3", async () => {
    await setup();
    f.set({ faults: { "job.start": ["effectThenExit"] } });
    await expect(kind.start(host(), SPEC, token)).rejects.toThrow(/outcome unknown/);
    const [r] = await kind.resolve(token);
    expect(r).toMatchObject({ state: "recorded", via: "lookup" });
    expect(f.backend().starts).toBe(1);
    expect(getCarrierJob(db, token)?.job).toBe("job-1");
  });

  it("F5: a timeout, then a late reply: $/cancel, the group killed, the late reply ignored", async () => {
    await setup();
    setEffectTimeoutForTests(150);
    setPluginGraceForTests(100);
    f.set({ lateMs: 600, faults: { "job.start": ["late"] } });
    await expect(kind.start(host(), SPEC, token)).rejects.toThrow(/outcome unknown/);
    expect(f.calls().some((c) => c.method === "$/cancel")).toBe(true);
    await sleep(700);
    expect(getEffect(db, token)?.state).toBe("unknown");
    expect(getCarrierJob(db, token)?.job).toBeNull();
    expect(f.backend().starts).toBe(0);
  });

  it("F6: retryable twice, then success: one effect, one key, identical params", async () => {
    await setup();
    f.set({ faults: { "job.start": ["retryable", "retryable"] } });
    const r = await kind.start(host(), SPEC, token);
    expect(r.handle).toBe("job-1");
    expect(f.backend().starts).toBe(1);
    const sent = jobCalls("job.start").map(({ params: { deadline: _d, ...p } }) =>
      JSON.stringify(p),
    );
    expect(sent).toHaveLength(3);
    expect(new Set(sent).size).toBe(1);
    expect(getEffect(db, token)).toBeUndefined();
  });

  it("F7: mu SIGKILLed mid-call: the plugin sees EOF and exits within the grace; the next reconcile finds the effect", async () => {
    await setup();
    f.set({ lateMs: 50, eofDelayMs: 300, faults: { "job.start": ["late"] } });
    // A stand-in mu: starts the plugin in its own group and sends the persisted request.
    const driver = join(dir, "driver.mjs");
    writeFileSync(
      driver,
      `import { spawn } from "node:child_process";
       import { writeFileSync } from "node:fs";
       const [bin, cfg, out, params] = process.argv.slice(2);
       const p = spawn(bin, [cfg], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
       writeFileSync(out, String(p.pid));
       const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
       send({ id: 1, method: "initialize", params: { protocol: { min: 1, max: 1 }, mu: "5" } });
       send({ id: 2, method: "job.start", params: { ...JSON.parse(params), deadline: Date.now() + 10000 } });
       setInterval(() => {}, 1000);`,
    );
    const pidFile = join(dir, "plugin.pid");
    const mu = spawn(
      process.execPath,
      [driver, f.path, f.configPath, pidFile, JSON.stringify(startParams())],
      {
        stdio: "ignore",
      },
    );
    for (let i = 0; i < 250 && jobCalls("job.start").length === 0; i++) await sleep(20);
    const pgid = Number(spawnSync("cat", [pidFile], { encoding: "utf8" }).stdout);
    setEffectOwnerForTests({ pid: mu.pid ?? 0, start: null });
    writeEffect(db, {
      key: token,
      subject: { kind: "job", id: token },
      plugin: "fake",
      method: "job.start",
      params: startParams(),
      instance: "fake-1",
      pgid,
      pgidStart: null,
    });
    setEffectOwnerForTests(undefined);
    mu.kill("SIGKILL");
    const t0 = Date.now();
    const alive = () => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() - t0 < HOST_GRACE_MS + 1000) await sleep(20);
    expect(alive()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(HOST_GRACE_MS);
    const [r] = await kind.resolve(token);
    expect(r).toMatchObject({ state: "recorded", via: "lookup" });
    expect(f.backend().starts).toBe(1);
  });

  it("F8: two mu processes resolve one effect: one claim wins, the other refuses naming it", async () => {
    await setup();
    f.set({ faults: { "job.start": ["effectThenExit"] } });
    await expect(kind.start(host(), SPEC, token)).rejects.toThrow(/outcome unknown/);
    f.set({ lateMs: 300, faults: { "job.start": ["effectThenExit"], "job.lookup": ["late"] } });
    const first = kind.resolve(token);
    for (let i = 0; i < 100 && jobCalls("job.lookup").length === 0; i++) await sleep(10);
    setEffectOwnerForTests({ pid: process.pid, start: "another mu" });
    await expect(resolveEffect(db, token)).rejects.toThrow(EffectHeldError);
    await expect(resolveEffect(db, token)).rejects.toThrow(
      new RegExp(`resolved by pid ${process.pid}`),
    );
    setEffectOwnerForTests(undefined);
    expect((await first)[0]).toMatchObject({ state: "recorded", via: "lookup" });
    expect(f.backend().starts).toBe(1);
    expect(getEffect(db, token)).toBeUndefined();
  });

  it("F9: none while the creator lives, or inside inFlightMs, is unknown", async () => {
    await setup();
    f.set({ faults: { "job.start": ["exit"] } });
    await expect(kind.start(host(), SPEC, token)).rejects.toThrow(/outcome unknown/);
    // The creator (this process) lives.
    const [live] = await kind.resolve(token);
    expect(live).toMatchObject({ state: "unknown" });
    expect(jobCalls("job.lookup").at(-1)?.params).toMatchObject({ fence: false });
    expect(getEffect(db, token)?.state).toBe("unknown");
    expect(getCarrierJob(db, token)?.launch).toBe("intent");
  });

  it("F9: inside inFlightMs, with no fence, none is unknown", async () => {
    await setup({ start: { lookup: true, fenceKey: false, inFlightMs: 60_000 } });
    crashedIntent();
    const [r] = await kind.resolve(token);
    expect(r).toMatchObject({ state: "unknown" });
    expect(getEffect(db, token)?.state).toBe("unknown");
  });

  it("F10: the instance changed between intent and resolve: the ask, resend and stop refuse (stop-changed)", async () => {
    await setup();
    crashedIntent();
    await closePluginSessions();
    f.set({ instance: "fake-2" });
    const before = f.calls().length;
    await expect(kind.resolve(token)).rejects.toThrow(EffectFencedError);
    await expect(kind.resolve(token)).rejects.toThrow(/stop-changed/);
    expect(
      f
        .calls()
        .slice(before)
        .filter((c) => c.method.startsWith("job.")),
    ).toEqual([]);
    expect(getEffect(db, token)?.state).toBe("unknown");
    // A stop is fenced on the instance the job was started under.
    db.prepare("UPDATE carrier_jobs SET job = 'job-9' WHERE token = ?").run(token);
    const ref = pluginJobRef(db, token);
    if (ref === undefined) throw new Error("no ref");
    await expect(kind.stop(db, ref)).rejects.toThrow(EffectFencedError);
    expect(f.calls().some((c) => c.method === "job.stop")).toBe(false);
  });

  it("F12: a creator still in its call when a second verb resolves: the second refuses naming it; one result", async () => {
    await setup();
    f.set({ lateMs: 300, faults: { "job.start": ["late"] } });
    const started = kind.start(host(), SPEC, token);
    for (let i = 0; i < 100 && jobCalls("job.start").length === 0; i++) await sleep(10);
    await expect(resolveEffect(db, token)).rejects.toThrow(
      new RegExp(`in flight: its creator, pid ${process.pid}`),
    );
    expect((await started).handle).toBe("job-1");
    expect(f.backend().starts).toBe(1);
    expect(getEffect(db, token)).toBeUndefined();
    expect(getCarrierJob(db, token)?.job).toBe("job-1");
  });
});

describe("deliveries (D4): never resent past a newer one", () => {
  const channel = (receipt: string) => ({
    channel: {
      name: "fake",
      caps: {
        fence: "none",
        receipt,
        dedupe: { send: { exact: true, windowMs: 60_000 } },
        steer: "none",
        interrupt: "none",
        fresh: "none",
        answer: false,
        command: false,
        watch: "stream",
        settleText: "tied",
      },
    },
  });
  let agentId: number;
  const send = (msgId: string) =>
    runEffect(db, {
      key: `send:${msgId}`,
      subject: { kind: "delivery", agentId, msgId },
      plugin: "fake",
      method: "channel.send",
      params: {
        target: { host: { name: "dev" } },
        text: msgId,
        msgId,
        mode: "followUp",
        force: false,
      },
      narrow: narrowObject,
    });
  const prep = async (receipt: string) => {
    await setup({}, channel(receipt));
    ensureWorkstream(db, "ws");
    agentId = insertAgent(db, { name: "a1", workstream: "ws", cli: "x", paneId: "%1" }).incarnation;
  };

  it("an older delivery's deduped resend is refused once a newer one was written", async () => {
    await prep("none");
    f.set({ faults: { "channel.send": ["effectThenExit"] } });
    await expect(send("m1")).rejects.toThrow(/outcome unknown/);
    await send("m2");
    const r = await resolveEffect(db, "send:m1");
    expect(r).toMatchObject({ state: "unknown", reason: expect.stringMatching(/newer delivery/) });
    expect(
      f.calls().filter((c) => c.method === "channel.send" && c.params.msgId === "m1"),
    ).toHaveLength(1);
  });

  it("the newest unresolved delivery is resent once, deduped: one delivery", async () => {
    await prep("none");
    f.set({ faults: { "channel.send": ["effectThenExit"] } });
    await expect(send("m1")).rejects.toThrow(/outcome unknown/);
    expect(await resolveEffect(db, "send:m1")).toMatchObject({ state: "recorded", via: "reply" });
    expect(f.backend().deliveries).toBe(1);
  });

  it("receipt exact: accepted resolves without a resend; not-accepted stays unknown", async () => {
    await prep("exact");
    f.set({ faults: { "channel.send": ["effectThenExit", "exit"] } });
    await expect(send("m1")).rejects.toThrow(/outcome unknown/);
    expect(await resolveEffect(db, "send:m1")).toMatchObject({ state: "recorded", via: "receipt" });
    await expect(send("m2")).rejects.toThrow(/outcome unknown/);
    expect(await resolveEffect(db, "send:m2")).toMatchObject({
      state: "unknown",
      reason: "receipt: not-accepted",
    });
    expect(f.calls().filter((c) => c.method === "channel.send")).toHaveLength(2);
  });
});
