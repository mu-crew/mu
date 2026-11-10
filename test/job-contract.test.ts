// The job contract (plugins spec D8, D16): one suite over the built-in kinds
// (`pane`, `lease`, `gate`) and the fake plugin's bound `reply` kind through
// the job adapter (src/plugins/job.ts).
//
// Every kind: legal declared capabilities, `honours` (built-ins all), a status
// that never throws for "cannot tell", and honour or refuse at spawn (a
// requested field the kind lacks refuses before any effect; a declared one
// passes). A start-capable kind (the plugin's) also: start and lookup agree,
// a deduped resend makes one effect, the stop is idempotent and proven by
// status, lookup and status never throw, attach gives a view, the canary
// never crosses, and the plugin exits on EOF.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobSpecUnsupportedError, requireHostSpawn } from "../src/agents/spawn-remote.js";
import { getCarrierJob, reserveCarrierJob } from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import { getEffect, setEffectOwnerForTests, writeEffect } from "../src/effects.js";
import { resolveHost } from "../src/host-provider.js";
import { addHost } from "../src/hosts.js";
import { gateKind } from "../src/jobs/gate.js";
import { leaseKind } from "../src/jobs/lease.js";
import { paneKind } from "../src/jobs/pane.js";
import { HONOURS_ALL, HONOURS_DEFAULT, type JobKind, type JobSpec } from "../src/jobs/types.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { type PluginJobKind, pluginJobRef } from "../src/plugins/job.js";
import { narrowSeams } from "../src/plugins/protocol.js";
import { addPlugin, closePluginSessions, removePlugin } from "../src/plugins/registry.js";
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
  env: { MU_AGENT_NAME: "w" },
};

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mjc-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(async () => {
  setMuxForTests(undefined);
  setEffectOwnerForTests(undefined);
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

/** A spawn's options on host `dev` (no harness probe recorded: none refuses). */
const spawnOn = (o: Record<string, unknown> = {}) =>
  ({ name: "w", workstream: "ws", host: "dev", cli: "claude", ...o }) as Parameters<
    typeof requireHostSpawn
  >[1];

/** The kind's declaration as the wire carries a job seam. */
const asSeam = (k: JobKind) => ({
  job: { kind: k.name, ...k.caps, start: k.caps.start ?? { lookup: false, fenceKey: false } },
});

/** The multiplexer cannot answer: every probe throws. */
const muxCannotTell = () => {
  const boom = async () => {
    throw new Error("mux down");
  };
  setMuxForTests({ ...tmuxBackend, paneAlive: boom, paneResult: boom });
};

interface Impl {
  name: string;
  kind(db: Db, dir: string): Promise<JobKind>;
}

const BUILTINS: Impl[] = [
  { name: "pane", kind: async () => paneKind },
  { name: "lease", kind: async () => leaseKind },
  { name: "gate", kind: async () => gateKind },
];

async function fakeKind(
  db: Db,
  dir: string,
  patch: Record<string, unknown> = {},
): Promise<{ f: FakePlugin; kind: PluginJobKind }> {
  const f = fakePlugin(dir, { seams: jobSeams(patch) });
  await addPlugin(db, "fake", f.argv);
  addHost(db, { name: "dev", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
  return { f, kind: resolveHost(db, "dev").jobKind as PluginJobKind };
}

const IMPLS: Impl[] = [
  ...BUILTINS,
  { name: "plugin (bound, reply)", kind: async (d, x) => (await fakeKind(d, x)).kind },
];

describe.each(IMPLS)("the job contract: $name", (impl) => {
  it("declares legal capabilities, and what it honours", async () => {
    const k = await impl.kind(db, dir);
    expect(narrowSeams(asSeam(k)).ok).toBe(true);
    expect(k.caps.view).toBe("bound");
    // A built-in declares none: it honours every field. A plugin's default is HONOURS_DEFAULT.
    expect(k.caps.honours ?? HONOURS_ALL).toEqual(
      impl.name.startsWith("plugin") ? HONOURS_DEFAULT : HONOURS_ALL,
    );
  });

  it("status never throws for cannot tell: it is unknown", async () => {
    const k = await impl.kind(db, dir);
    muxCannotTell();
    const l = await k.status(db, {
      kind: k.name,
      viewPaneId: "%9",
      key: "nokey",
      handle: "no-such-job",
      host: { name: "dev" },
    });
    expect(l.state).toBe("unknown");
  });
});

describe("honour or refuse at spawn (G4)", () => {
  it("a built-in kind honours every field: role, --command and sockets pass the honour step", async () => {
    addHost(db, {
      name: "dev",
      shell: "true",
      exec: "{cmd}",
      fetch: "true",
      repo: null,
      max_sessions: null,
    });
    setMuxForTests({ ...tmuxBackend, runsShellCommand: true });
    await expect(
      requireHostSpawn(db, spawnOn({ role: "read-only", command: "claude --x", cli: "pi" })),
    ).resolves.toMatchObject({ name: "dev" });
  });

  it.each([
    ["role read-only", { role: "read-only" }, "role"],
    ["a --command", { command: "claude --model x" }, "command"],
    ["the sockets of a pi agent", { cli: "pi" }, "sockets"],
  ])("a plugin kind without it refuses %s before any effect", async (_n, o, field) => {
    const { f } = await fakeKind(db, dir);
    const err = await requireHostSpawn(db, spawnOn(o)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobSpecUnsupportedError);
    expect((err as JobSpecUnsupportedError).field).toBe(field);
    expect(f.calls().filter((c) => c.method.startsWith("job."))).toEqual([]);
  });

  it("a plugin kind that declares them passes the honour step (spawn itself waits for P6e)", async () => {
    await fakeKind(db, dir, { honours: HONOURS_ALL });
    const err = await requireHostSpawn(
      db,
      spawnOn({ role: "read-only", command: "c", cli: "pi" }),
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(JobSpecUnsupportedError);
    expect(String(err)).toMatch(/does not drive yet/);
  });
});

describe("the job contract: plugin (bound, reply) effects", () => {
  let f: FakePlugin;
  let kind: PluginJobKind;
  let token: string;

  beforeEach(async () => {
    process.env.MU_PLUGIN_CANARY = "canary-7f3e";
    ({ f, kind } = await fakeKind(db, dir));
    const r = reserveCarrierJob(db, {
      workstream: "ws",
      name: "w",
      host: "dev",
      hostStop: null,
      plugin: { kind: kind.name, name: "fake" },
    });
    token = r?.token ?? "";
  });

  afterEach(() => {
    const key = "MU_PLUGIN_CANARY";
    delete process.env[key];
  });

  const host = () => resolveHost(db, "dev");

  it("start: the reply's handle fills the record, the row is gone; lookup's found equals the reply", async () => {
    const started = await kind.start(host(), SPEC, token);
    expect(started.handle).toMatch(/^job-/);
    expect(getCarrierJob(db, token)).toMatchObject({
      job: started.handle,
      launch: "intent",
      instance: "fake-1",
      kind: "fakejob",
      plugin: "fake",
    });
    expect(getEffect(db, token)).toBeUndefined();
    expect(await kind.lookup(host(), token, { fence: false })).toEqual({ found: started });
    // The params the plugin got are the persisted ones, the whole JobSpec under the key.
    const sent = f.calls().find((c) => c.method === "job.start")?.params;
    expect(sent).toMatchObject({ key: token, spec: SPEC });
  });

  it("lookup and status never throw: an unknown key is none, an unknown handle unknown", async () => {
    expect(await kind.lookup(host(), "never", { fence: false })).toEqual({ none: true });
    f.set({ faults: { "job.lookup": ["ok", "exit"] } });
    expect(await kind.lookup(host(), "never", { fence: false })).toHaveProperty("unknown");
  });

  it("a deduped resend of the persisted bytes returns the first result and makes one effect", async () => {
    // A kind keyed by dedupe alone (no lookup), its declaration re-recorded.
    f.set({
      seams: jobSeams({
        start: { lookup: false, dedupe: { exact: true, windowMs: 60_000 }, fenceKey: false },
      }),
    });
    await addPlugin(db, "fake", f.argv);
    kind = resolveHost(db, "dev").jobKind as PluginJobKind;
    f.set({ faults: { "job.start": ["effectThenExit"] } });
    await expect(kind.start(host(), SPEC, token)).rejects.toThrow(/outcome unknown/);
    expect(getEffect(db, token)?.state).toBe("unknown");
    const [r] = await kind.resolve(token);
    expect(r).toMatchObject({ state: "recorded", via: "reply" });
    expect(f.backend().starts).toBe(1);
    const sends = f
      .calls()
      .filter((c) => c.method === "job.start")
      .map((c) => {
        const { deadline: _d, ...p } = c.params;
        return JSON.stringify(p);
      });
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe(sends[0]);
    expect(getCarrierJob(db, token)?.job).toBe("job-1");
  });

  it("stop is idempotent and proven by status; attach gives a view", async () => {
    await kind.start(host(), SPEC, token);
    const ref = pluginJobRef(db, token);
    if (ref === undefined) throw new Error("no ref");
    expect(await kind.status(db, ref)).toEqual({ state: "running" });
    expect(await kind.attach(db, ref)).toMatchObject({ command: "sleep 600" });
    await kind.stop(db, ref);
    await kind.stop(db, ref);
    expect(f.backend().stops).toBe(1);
    expect(await kind.status(db, ref)).toEqual({ state: "ended", exit: 0 });
  });

  it("mu plugin rm refuses while a job record or an effect names the plugin", async () => {
    await closePluginSessions();
    expect(() => removePlugin(db, "fake")).toThrow(/job ws\/w/);
    db.prepare("DELETE FROM carrier_jobs").run();
    db.prepare("DELETE FROM host_profiles").run();
    writeEffect(db, {
      key: "e1",
      subject: { kind: "job", id: "gone" },
      plugin: "fake",
      method: "job.stop",
      params: {},
      instance: "fake-1",
      pgid: 1,
      pgidStart: null,
    });
    expect(() => removePlugin(db, "fake")).toThrow(/effect e1/);
  });

  it("the canary never crosses, and the plugin exits on EOF", async () => {
    await kind.start(host(), SPEC, token);
    expect(JSON.stringify(f.calls())).not.toContain("canary-7f3e");
    const before = f.cleanExits();
    await closePluginSessions();
    expect(f.cleanExits()).toBe(before + 1);
  });
});
