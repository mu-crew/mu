// Every plugin reply is checked against its request, and every call naming a
// recorded job, host or effect is fenced on its instance (plugins spec D4,
// D8, D13; the P6c ruling). One table per rule, run through the real entry
// points: the job adapter's calls and the reconciler's.
//
// Replies: a missing field, an id that does not echo the request's, a foreign
// target, or only an extra one, is `unknown`: an effect stays journaled and
// nothing is recorded. Fence: under a changed instance nothing is sent.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { getCarrierJob, reserveCarrierJob } from "../src/carrier-jobs.js";
import { type Db, openDb } from "../src/db.js";
import {
  type EffectIntent,
  getEffect,
  setEffectOwnerForTests,
  writeEffect,
} from "../src/effects.js";
import { resolveHost } from "../src/host-provider.js";
import { addHost } from "../src/hosts.js";
import type { JobSpec } from "../src/jobs/types.js";
import { EffectFencedError } from "../src/plugins/errors.js";
import { type PluginJobKind, pluginJobRef, stopKey } from "../src/plugins/job.js";
import { resolveEffect } from "../src/plugins/reconcile.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
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
const VIEW = { command: "sleep 600", env: {} };
const CHANNEL = {
  name: "fake",
  caps: {
    fence: "none",
    receipt: "exact",
    steer: "none",
    interrupt: "none",
    fresh: "none",
    answer: false,
    command: false,
    watch: "stream",
    settleText: "tied",
  },
};

let dir: string;
let db: Db;
let f: FakePlugin;
let kind: PluginJobKind;
let token: string;
let agent: { workstream: string; name: string; incarnation: number };

const deadPid = () =>
  Number(spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());

async function setup(job: Record<string, unknown> = {}) {
  f = fakePlugin(dir, {
    seams: {
      ...jobSeams(job),
      channel: CHANNEL,
      host: { acquire: { lookup: true, fenceKey: true } },
    },
  });
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
  ensureWorkstream(db, "ws");
  const a = insertAgent(db, { name: "a1", workstream: "ws", cli: "x", paneId: "%1" });
  agent = { workstream: "ws", name: "a1", incarnation: a.incarnation };
}

/** A row a crashed mu left (gone creator, gone plugin group): claimable at once. */
function seed(over: Partial<EffectIntent> & Pick<EffectIntent, "key" | "method" | "subject">) {
  setEffectOwnerForTests({ pid: deadPid(), start: null });
  writeEffect(db, {
    plugin: "fake",
    params: { target: { agent, host: { name: "dev" } } },
    instance: "fake-1",
    pgid: deadPid(),
    pgidStart: null,
    ...over,
  });
  setEffectOwnerForTests(undefined);
  return over.key;
}
const seedStart = () =>
  seed({
    key: token,
    method: "job.start",
    subject: { kind: "job", id: token },
    params: {
      target: { job: { kind: "fakejob", key: token }, host: { name: "dev" } },
      key: token,
      spec: SPEC,
    },
  });
const seedDelivery = (method: string, msgId: string) =>
  seed({
    key: `${method}:${msgId}`,
    method,
    subject: { kind: "delivery", agentId: agent.incarnation, msgId },
    params: { target: { agent, host: { name: "dev" } }, msgId, text: "x", timeoutMs: 1 },
  });
const seedHost = (method: string) =>
  seed({
    key: `h:${method}`,
    method,
    subject: { kind: "host", id: "1" },
    params: { target: { host: { name: "dev" } }, key: `h:${method}` },
  });

const sent = (m: string) => f.calls().filter((c) => c.method === m).length;
const ref = () => {
  const r = pluginJobRef(db, token);
  if (r === undefined) throw new Error("no job ref");
  return r;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpr-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(async () => {
  setEffectOwnerForTests(undefined);
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

/** [name, method answered, its reply, the seam patch, the entry point; it asserts unknown and the effect kept]. */
type Row = [string, string, unknown, Record<string, unknown>, () => Promise<void>];

const kept = (key: string) => expect(getEffect(db, key)?.state).toBe("unknown");

const REPLIES: Row[] = [
  [
    "job.start: a reply kind's reply without its handle",
    "job.start",
    { view: VIEW },
    {},
    async () => {
      await expect(kind.start(resolveHost(db, "dev"), SPEC, token)).rejects.toThrow(
        /outcome unknown/,
      );
      kept(token);
      expect(getCarrierJob(db, token)?.job).toBeNull();
    },
  ],
  [
    "job.start: a reply without its view",
    "job.start",
    { handle: "job-1" },
    {},
    async () => {
      await expect(kind.start(resolveHost(db, "dev"), SPEC, token)).rejects.toThrow(
        /outcome unknown/,
      );
      kept(token);
    },
  ],
  [
    "job.lookup (the adapter's): a reply kind's found without its view",
    "job.lookup",
    { found: { handle: "job-7" } },
    {},
    async () => {
      expect(await kind.lookup(resolveHost(db, "dev"), token, { fence: false })).toHaveProperty(
        "unknown",
      );
    },
  ],
  [
    "job.lookup (the reconciler's): a reply kind's found without its view",
    "job.lookup",
    { found: { handle: "job-7" } },
    {},
    async () => {
      expect((await kind.resolve(seedStart() ?? ""))[0]).toMatchObject({ state: "unknown" });
      kept(token);
      expect(getCarrierJob(db, token)?.job).toBeNull();
    },
  ],
  [
    "job.lookup: a file kind's found without its handle",
    "job.lookup",
    { found: { view: VIEW } },
    { handle: "file", start: { lookup: true, fenceKey: true } },
    async () => {
      seedStart();
      expect((await kind.resolve(token))[0]).toMatchObject({ state: "unknown" });
      kept(token);
    },
  ],
  [
    "job.status: a reading without its state",
    "job.status",
    { exit: 0 },
    {},
    async () => {
      await kind.start(resolveHost(db, "dev"), SPEC, token);
      expect((await kind.status(db, ref())).state).toBe("unknown");
    },
  ],
  [
    "job.attach: a view without its command",
    "job.attach",
    { env: {} },
    {},
    async () => {
      await kind.start(resolveHost(db, "dev"), SPEC, token);
      await expect(kind.attach(db, ref())).rejects.toThrow(/no answer/);
    },
  ],
  [
    "job.stop: a reply other than null",
    "job.stop",
    { stopped: true },
    {},
    async () => {
      await kind.start(resolveHost(db, "dev"), SPEC, token);
      await expect(kind.stop(db, ref())).rejects.toThrow(/outcome unknown/);
      kept(stopKey(token));
    },
  ],
  [
    "channel.receipt: accepted, but for another msgId",
    "channel.receipt",
    { state: "accepted", id: "other-message" },
    {},
    async () => {
      const key = seedDelivery("channel.send", "m1");
      expect(await resolveEffect(db, key)).toMatchObject({ state: "unknown" });
      kept(key);
    },
  ],
  [
    "channel.receipt: accepted, with no msgId",
    "channel.receipt",
    { state: "accepted" },
    {},
    async () => {
      const key = seedDelivery("channel.send", "m1");
      expect(await resolveEffect(db, key)).toMatchObject({ state: "unknown" });
      kept(key);
    },
  ],
  [
    "channel.readStates: another agent idle, the asked one absent (an abort)",
    "channel.readStates",
    { "other/agent": { state: "idle", runs: 0, incarnation: "elsewhere" } },
    {},
    async () => {
      const key = seedDelivery("channel.abort", "m1");
      expect(await resolveEffect(db, key)).toMatchObject({ state: "unknown" });
      kept(key);
    },
  ],
  [
    "channel.readStates: nothing for the asked agent",
    "channel.readStates",
    {},
    {},
    async () => {
      const key = seedDelivery("channel.abort", "m1");
      expect(await resolveEffect(db, key)).toMatchObject({ state: "unknown" });
      kept(key);
    },
  ],
  [
    "host.lookup: a found host without its handle",
    "host.lookup",
    { found: { maxJobs: 2 } },
    {},
    async () => {
      const key = seedHost("host.acquire") ?? "";
      expect(await resolveEffect(db, key)).toMatchObject({ state: "unknown" });
      kept(key);
    },
  ],
];

describe("a reply is checked against its request: a failing one is unknown, never success", () => {
  it.each(REPLIES)("%s", async (_name, method, reply, job, entry) => {
    await setup(job);
    f.set({ replies: { [method]: reply } });
    await entry();
  });

  it("channel.readStates: the asked agent's reading counts, extra targets are ignored", async () => {
    await setup();
    f.set({
      replies: {
        "channel.readStates": {
          "ws/a1": { state: "idle", since: null, runs: 0, incarnation: "i" },
          "other/agent": { state: "running" },
        },
      },
    });
    const key = seedDelivery("channel.abort", "m1");
    expect(await resolveEffect(db, key)).toMatchObject({ state: "recorded", via: "idle" });
    expect(getEffect(db, key)).toBeUndefined();
  });
});

/** [name, the method that must not be sent, the entry point under a changed instance]. */
type FenceRow = [string, string, () => Promise<unknown>, "refuses" | "unknown"];

const FENCED: FenceRow[] = [
  ["job.status", "job.status", async () => kind.status(db, ref()), "unknown"],
  ["job.attach", "job.attach", async () => kind.attach(db, ref()), "refuses"],
  ["job.stop", "job.stop", async () => kind.stop(db, ref()), "refuses"],
  [
    "job.lookup (the adapter's, of a recorded job)",
    "job.lookup",
    async () => kind.lookup(resolveHost(db, "dev"), token, { fence: false }),
    "refuses",
  ],
];

const RESEEDED: Array<[string, string, () => string | undefined]> = [
  ["job.start's lookup", "job.lookup", () => seedStart()],
  ["a delivery's receipt", "channel.receipt", () => seedDelivery("channel.send", "m1")],
  ["an abort's readStates", "channel.readStates", () => seedDelivery("channel.abort", "m1")],
  ["host.release's reissue", "host.release", () => seedHost("host.release")],
];

describe("every call naming a recorded job, host or effect is fenced on its instance", () => {
  const changeInstance = async () => {
    await closePluginSessions();
    f.set({ instance: "fake-2" });
  };

  it.each(FENCED)("%s: nothing sent under another instance", async (_n, method, entry, how) => {
    await setup();
    await kind.start(resolveHost(db, "dev"), SPEC, token);
    await changeInstance();
    const before = sent(method);
    if (how === "refuses") await expect(entry()).rejects.toThrow(EffectFencedError);
    else
      expect(await entry()).toMatchObject({
        state: "unknown",
        reason: expect.stringMatching(/instance/),
      });
    expect(sent(method)).toBe(before);
  });

  it.each(RESEEDED)(
    "the reconciler's %s: refused, nothing sent, the effect kept",
    async (_n, method, seedIt) => {
      await setup();
      const key = seedIt() ?? "";
      await changeInstance();
      await expect(resolveEffect(db, key)).rejects.toThrow(/stop-changed/);
      expect(sent(method)).toBe(0);
      kept(key);
    },
  );
});
