// The plugin lifecycle under a terminating signal (plugins spec D13; the
// second review of P6b, task p6b_fix2): one table, every (phase the signal
// arrives in) x (how the plugin behaves). A "verb" drives a registered plugin
// through `pluginSession`, as mu's verbs do, and after the signal it carries on
// the way a verb with no signal handler would: it awaits what it started, then
// asks for the plugin again. Each cell holds:
//
// - no restart: one plugin process, and after the signal nothing but `$/cancel`
//   and `shutdown` reaches it; the verb's later ask is refused;
// - the bound: from the signal, at most one grace (and the call it was in,
//   its deadline plus that grace);
// - the group is empty once mu re-raises the signal;
// - the verb's exit: the signal raised again exactly once (mu dies by it).
//
// The signal is `process.emit`, with the runner's own listeners set aside and
// the re-raise recorded instead of delivered.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import type { PluginSession } from "../src/plugins/client.js";
import { PluginCallError } from "../src/plugins/errors.js";
import {
  livePluginProcesses,
  resetTerminatingForTests,
  setPluginGraceForTests,
  setPluginTapForTests,
  setSignalRaiseForTests,
} from "../src/plugins/process.js";
import { narrowLinkRun } from "../src/plugins/protocol.js";
import { addPlugin, closePluginSessions, pluginSession } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin } from "./_plugin.js";

const GRACE = 300;
const SLACK = 500;
const CALL_TIMEOUT = 150;

const PHASES = ["starting", "handshake", "idle", "in-flight", "its cancel", "shutdown"] as const;
type Phase = (typeof PHASES)[number];

const PLUGINS = {
  cooperative: {},
  "ignores cancel": { faults: { "link.exec": ["hang"] } },
  "ignores shutdown": { ignoreEof: true },
  "replies late": { ignoreEof: true, lateMs: 100, faults: { "link.exec": ["late"] } },
  detaches: { detachExec: true },
} as const;
type Behaviour = keyof typeof PLUGINS;

/** The plugin is still there to ignore its stop when the signal comes: the grace runs whole. */
const holdsTheGrace = (b: Behaviour, phase: Phase): boolean =>
  (b === "ignores shutdown" || b === "replies late") &&
  phase !== "its cancel" &&
  phase !== "shutdown";

const CELLS: Array<[Phase, Behaviour]> = PHASES.flatMap((p) =>
  (Object.keys(PLUGINS) as Behaviour[]).map((b) => [p, b] as [Phase, Behaviour]),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000): Promise<void> {
  for (const t0 = Date.now(); !fn(); await sleep(10)) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let saved: Array<(...a: unknown[]) => void>;
beforeAll(() => {
  saved = process.listeners("SIGINT") as Array<(...a: unknown[]) => void>;
  for (const l of saved) process.off("SIGINT", l);
});
afterAll(() => {
  for (const l of saved) process.on("SIGINT", l);
});

let dir: string;
let db: Db;
let f: FakePlugin;
let onTap: ((stream: string, text: string) => void) | undefined;
let raised: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mplc-"));
  db = openDb({ path: join(dir, "mu.db") });
  f = fakePlugin(dir);
  await addPlugin(db, "fake", f.argv);
  raised = [];
  onTap = undefined;
  setPluginGraceForTests(GRACE);
  setSignalRaiseForTests((sig) => raised.push(sig));
  setPluginTapForTests((stream, text) => onTap?.(stream, text));
});

afterEach(async () => {
  setPluginTapForTests(undefined);
  setSignalRaiseForTests(undefined);
  setPluginGraceForTests(undefined);
  resetTerminatingForTests();
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

const exec = (s: PluginSession, script: string, timeoutMs = 10_000) =>
  s.call(
    "link.exec",
    { target: { host: { name: "dev" } }, script, cwd: ".", timeoutMs },
    { kind: "effect", timeoutMs },
    narrowLinkRun,
  );

describe("a terminating signal, in every phase, against every plugin", () => {
  it.each(CELLS)("signal during %s, plugin %s", async (phase, behaviour) => {
    f.set({ ...PLUGINS[behaviour], ...(phase === "handshake" ? { initDelayMs: 3000 } : {}) });
    const base = f.calls().length; // the add's own handshake
    const runPid = join(dir, "run.pid");
    const script = `echo $$ > '${runPid}'; exec sleep 30`;
    let signalAt = 0;
    let logAt = 0;
    const signal = (): void => {
      if (signalAt !== 0) return;
      signalAt = Date.now();
      logAt = f.calls().length;
      process.emit("SIGINT");
    };
    let callStart = 0;
    let work: Promise<unknown>;

    if (phase === "starting") {
      const sp = pluginSession(db, "fake"); // spawned and tracked; no event has run yet
      signal();
      work = sp.then((s) => exec(s, script));
    } else if (phase === "handshake") {
      const sp = pluginSession(db, "fake");
      await until(() =>
        f
          .calls()
          .slice(base)
          .some((c) => c.method === "initialize"),
      );
      signal();
      work = sp.then((s) => exec(s, script));
    } else if (phase === "idle") {
      await pluginSession(db, "fake");
      signal();
      work = Promise.resolve();
    } else if (phase === "in-flight") {
      const s = await pluginSession(db, "fake");
      callStart = Date.now();
      work = exec(s, script);
      await until(() => f.calls().some((c) => c.method === "link.exec"));
      if (behaviour !== "ignores cancel" && behaviour !== "replies late") {
        await until(() => alive(Number(readFileSync(runPid, "utf8") || "0")), 3000).catch(() => {});
      }
      signal();
    } else if (phase === "its cancel") {
      const s = await pluginSession(db, "fake");
      onTap = (stream, text) => {
        if (stream === "in" && text.includes('"$/cancel"')) signal();
      };
      callStart = Date.now();
      work = exec(s, script, CALL_TIMEOUT);
    } else {
      await pluginSession(db, "fake");
      onTap = (stream, text) => {
        if (stream === "in" && text.includes('"shutdown"')) signal();
      };
      work = closePluginSessions();
    }

    const pgids = livePluginProcesses().map((p) => p.pgid);
    expect(pgids.length).toBeLessThanOrEqual(1);
    // The verb awaits what it started, then asks for the plugin again.
    await work.catch(() => undefined);
    const again = await pluginSession(db, "fake")
      .then((s) => exec(s, "echo after-the-signal"))
      .catch((e: unknown) => e);
    await until(() => raised.length > 0, GRACE + SLACK + 2000);
    const took = Date.now() - signalAt;

    // No restart: one plugin, and after the signal only its stop reached it.
    expect(again).toBeInstanceOf(PluginCallError);
    expect((again as Error).message).toMatch(/mu is stopping \(it got SIGINT\)/);
    const calls = f.calls().map((c) => c.method);
    // (Signalled while starting, the handshake itself is never sent.)
    expect(calls.slice(base).filter((m) => m === "initialize")).toHaveLength(
      phase === "starting" ? 0 : 1,
    );
    for (const m of calls.slice(logAt)) expect(["$/cancel", "shutdown"]).toContain(m);
    // The bound: one grace from the signal; the call's deadline plus one grace.
    expect(took).toBeLessThan(GRACE + SLACK);
    if (holdsTheGrace(behaviour, phase)) expect(took).toBeGreaterThanOrEqual(GRACE - 20);
    if (phase === "its cancel")
      expect(Date.now() - callStart).toBeLessThan(CALL_TIMEOUT + GRACE + SLACK);
    // The group is empty, and nothing of mu's still runs.
    for (const g of pgids) expect(alive(-g), `group ${g}`).toBe(false);
    expect(livePluginProcesses()).toEqual([]);
    // The verb's exit: mu dies by the signal, raised once.
    await sleep(30);
    expect(raised).toEqual(["SIGINT"]);
    expect(process.listeners("SIGINT")).toEqual([]);

    if (behaviour === "detaches") {
      // The run that left the group outlives it: what the contract suite reports. Cleaned up.
      try {
        process.kill(Number(readFileSync(runPid, "utf8")), "SIGKILL");
      } catch {}
    }
  });
});

describe("a verb that handles the signal and aborts its call (the reviewer's race)", () => {
  it("the abort joins the one stop: the plugin's slow, clean exit is waited for, not killed", async () => {
    // It answers the cancel at once, then takes 150 ms to exit on EOF.
    f.set({ replyOnCancel: true, eofDelayMs: 150 });
    const exitsBefore = f.cleanExits(); // the add's own handshake
    setPluginGraceForTests(1000);
    const ac = new AbortController();
    const onVerb = (): void => ac.abort();
    process.on("SIGINT", onVerb);
    try {
      const s = await pluginSession(db, "fake");
      const call = s
        .call(
          "link.exec",
          { target: { host: { name: "dev" } }, script: "sleep 30", cwd: ".", timeoutMs: 10_000 },
          { kind: "effect", timeoutMs: 10_000, signal: ac.signal },
          narrowLinkRun,
        )
        .catch((e: unknown) => e);
      await until(() => f.calls().some((c) => c.method === "link.exec"));
      const t0 = Date.now();
      process.emit("SIGINT");
      await call;
      await closePluginSessions();
      expect(f.cleanExits()).toBe(exitsBefore + 1);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(raised).toEqual([]); // the verb handles it
    } finally {
      process.off("SIGINT", onVerb);
    }
  });
});
