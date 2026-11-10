// The host provider contract (plugins spec D6, D16): one suite over the
// built-in `static` provider and the fake plugin's provider through the
// provider adapter (src/plugins/provider.ts).
//
// Every provider: legal declared capabilities, typed refusals, and a status
// that never throws for "cannot tell". The plugin's also: acquire and lookup
// agree, a deduped resend of the persisted bytes makes one effect, release is
// idempotent, `gone` is reported for a released or reclaimed host, a changed
// instance refuses before anything is sent, and the canary never crosses.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { getEffect, setEffectOwnerForTests } from "../src/effects.js";
import { acquireHost } from "../src/host-lifecycle.js";
import {
  type Call,
  type HostProvider,
  resolveHost,
  StaticHostError,
  staticProvider,
} from "../src/host-provider.js";
import { getHostRecord } from "../src/host-records.js";
import { EffectOutcomeUnknownError } from "../src/plugins/errors.js";
import { acquireKey, type PluginHostProvider, pluginProvider } from "../src/plugins/provider.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, providerSeams } from "./_plugin.js";

let dir: string;
let db: Db;

const call = (): Call => ({ deadline: Date.now() + 5000, signal: new AbortController().signal });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhc-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(async () => {
  setEffectOwnerForTests(undefined);
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

const legalCaps = (p: HostProvider) => {
  const a = p.caps.acquire;
  expect(typeof a.lookup).toBe("boolean");
  expect(typeof a.fenceKey).toBe("boolean");
  if (a.dedupe !== undefined) expect(a.dedupe.windowMs).toBeGreaterThan(0);
};

describe("the host provider contract: static", () => {
  it("declares legal capabilities; status is up with no round trip; acquire, lookup and release refuse, typed", async () => {
    legalCaps(staticProvider);
    expect(await staticProvider.status("dev", call())).toEqual({ state: "up", handle: "dev" });
    await expect(staticProvider.acquire({}, "k", call())).rejects.toBeInstanceOf(StaticHostError);
    await expect(staticProvider.lookup("k", { fence: false }, call())).rejects.toBeInstanceOf(
      StaticHostError,
    );
    await expect(staticProvider.release("dev", "k", call())).rejects.toBeInstanceOf(
      StaticHostError,
    );
  });
});

describe("the host provider contract: plugin", () => {
  let f: FakePlugin;
  const provider = (): PluginHostProvider => resolveHost(db, "box").provider as PluginHostProvider;
  const acquire = () =>
    acquireHost(db, { name: "box", provider: "fake", params: { size: "s" }, repo: "/work" });

  beforeEach(async () => {
    process.env.MU_PLUGIN_CANARY = "canary-h0st";
    f = fakePlugin(dir, { seams: providerSeams(), hostFacts: { maxJobs: 2 } });
    await addPlugin(db, "fake", f.argv);
  });

  afterEach(() => {
    const key = "MU_PLUGIN_CANARY";
    delete process.env[key];
  });

  it("declares legal capabilities: lookup, exact dedupe, fenceKey", () => {
    const p = pluginProvider(db, "fake", "box");
    legalCaps(p);
    expect(p.caps.acquire).toMatchObject({ lookup: true, fenceKey: true });
  });

  it("acquire records the facts; lookup's found equals them; the params cross under the key", async () => {
    const rec = await acquire();
    expect(rec).toMatchObject({
      state: "ready",
      handle: "host-1",
      max_jobs: 2,
      instance: "fake-1",
    });
    const sent = f.calls().find((c) => c.method === "host.acquire")?.params ?? {};
    expect(sent).toMatchObject({ params: { size: "s" }, target: { host: { name: "box" } } });
    const key = String(sent.key);
    expect(await provider().lookup(key, { fence: false }, call())).toEqual({
      found: { handle: "host-1", maxJobs: 2 },
    });
    expect(getEffect(db, key)).toBeUndefined();
  });

  it("status and lookup never throw for cannot tell: unknown", async () => {
    await acquire();
    f.set({ faults: { "host.status": ["exit"], "host.lookup": ["exit"] } });
    expect((await provider().status("host-1", call())).state).toBe("unknown");
    expect(await provider().lookup("never", { fence: false }, call())).toHaveProperty("unknown");
    expect(await provider().lookup("never", { fence: false }, call())).toEqual({ none: true });
  });

  it("a deduped resend of the persisted bytes returns the first result and makes one effect", async () => {
    f.set({
      seams: {
        ...providerSeams(),
        host: {
          acquire: { lookup: false, dedupe: { exact: true, windowMs: 60_000 }, fenceKey: false },
        },
      },
      faults: { "host.acquire": ["effectThenExit"] },
    });
    await addPlugin(db, "fake", f.argv);
    const key = acquireKey();
    await expect(
      pluginProvider(db, "fake", "box").acquire({ size: "s" }, key, call()),
    ).rejects.toBeInstanceOf(EffectOutcomeUnknownError);
    expect(getHostRecord(db, "box")?.state).toBe("acquiring");
    const [r] = await provider().resolve();
    expect(r).toMatchObject({ state: "recorded", via: "reply" });
    expect(f.backend().acquires).toBe(1);
    const sends = f
      .calls()
      .filter((c) => c.method === "host.acquire")
      .map(({ params: { deadline: _d, ...p } }) => JSON.stringify(p));
    expect(sends).toHaveLength(2);
    expect(sends[1]).toBe(sends[0]);
    expect(getHostRecord(db, "box")).toMatchObject({ state: "ready", handle: "host-1" });
  });

  it("release is idempotent; a released or reclaimed host is gone", async () => {
    await acquire();
    expect(await provider().status("host-1", call())).toMatchObject({
      state: "up",
      handle: "host-1",
    });
    f.set({ hostGone: "reclaimed by its idle window" });
    expect(await provider().status("host-1", call())).toEqual({
      state: "gone",
      reason: "reclaimed by its idle window",
    });
    f.set({ hostGone: undefined });
    db.prepare("UPDATE hosts SET state = 'draining'").run();
    await provider().release("host-1", "", call());
    expect(getHostRecord(db, "box")).toBeUndefined();
    // The provider's release again (a reissue after a crash) changes nothing.
    const again = pluginProvider(db, "fake", "box");
    expect(f.backend().releases).toBe(1);
    await expect(again.release("host-1", "", call())).resolves.toBeUndefined();
    expect(f.backend().releases).toBe(1);
  });

  it("a changed instance refuses the status read before sending: unknown, never a throw", async () => {
    await acquire();
    db.prepare("UPDATE hosts SET instance = 'other'").run();
    const before = f.calls().filter((c) => c.method === "host.status").length;
    expect((await provider().status("host-1", call())).state).toBe("unknown");
    expect(f.calls().filter((c) => c.method === "host.status")).toHaveLength(before);
  });

  it("the canary never crosses, and the plugin exits on EOF", async () => {
    await acquire();
    expect(JSON.stringify(f.calls())).not.toContain("canary-h0st");
    const before = f.cleanExits();
    await closePluginSessions();
    expect(f.cleanExits()).toBe(before + 1);
  });
});
