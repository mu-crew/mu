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

import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import type { PluginSession } from "../src/plugins/client.js";
import { PluginCallError } from "../src/plugins/errors.js";
import {
  livePluginProcesses,
  resetTerminatingForTests,
  type StopTrace,
  setPluginGraceForTests,
  setPluginTapForTests,
  setSignalRaiseForTests,
  setStopTraceForTests,
} from "../src/plugins/process.js";
import { narrowLinkRun } from "../src/plugins/protocol.js";
import { addPlugin, closePluginSessions, pluginSession } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin } from "./_plugin.js";

// The bound, from the process manager's own trace of each stop (StopTrace), not from
// wall time around the test: a loaded host slows the plugin and the runner, never the
// structure. Each stop's time splits into the wait for the plugin (the grace's wait while
// the plugin had not exited) and mu's own (everything else from the signal, or the stop
// it joined, to the re-raise: the writes, the group kill, the pipes, the settling). One
// stop per plugin; the wait at most one grace (a plugin that ignores its stop holds it
// whole); mu's own a small fraction of a grace. An extra grace anywhere between the
// signal and the re-raise lands in one of the two and fails the cells it delays.
//
// Measured (LIFECYCLE_TIMES=<file> appends each cell's wait and own time) at GRACE 1000:
// idle, the wait 2-94 ms or 999-1002 ms when held, mu's own 0-13 ms; at load 30-90 (a
// concurrent fast gate, six runs), the wait at most 1002 ms and mu's own at most 60 ms.
const GRACE = 1000;
/** How late a grace timer may fire on a loaded host. */
const TIMER_LATE = GRACE / 2;
/** mu's own time in one stop. */
const MU_OWN_MAX = GRACE / 2;
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

/** The plugin ignores its stop: the grace runs whole (in every phase, from the signal). */
const holdsTheGrace = (b: Behaviour): boolean => b === "ignores shutdown" || b === "replies late";

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
/** When mu raised the signal again: the end of the stop, to the millisecond. */
let raisedAt: number;
let traces: StopTrace[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mplc-"));
  db = openDb({ path: join(dir, "mu.db") });
  f = fakePlugin(dir);
  await addPlugin(db, "fake", f.argv);
  raised = [];
  onTap = undefined;
  setPluginGraceForTests(GRACE);
  raisedAt = 0;
  setSignalRaiseForTests((sig) => {
    raisedAt ||= Date.now();
    raised.push(sig);
  });
  setPluginTapForTests((stream, text) => onTap?.(stream, text));
  traces = [];
  setStopTraceForTests((t) => traces.push(t));
});

afterEach(async () => {
  setPluginTapForTests(undefined);
  setStopTraceForTests(undefined);
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
    await until(() => raised.length > 0, GRACE * 2 + 5000);
    const mine = traces.filter((t) => pgids.includes(t.pgid));
    const [stop] = mine;
    if (stop === undefined) throw new Error("no stop traced");
    // The wait for the plugin: until its leader exited, or the grace ran out.
    const until_ = stop.by === "leader" && stop.leaderAt !== null ? stop.leaderAt : stop.graceTo;
    const pluginWait = Math.max(0, until_ - stop.graceFrom);
    // mu's own: from the signal (or the stop it joined) to the raise, less that wait.
    const own = raisedAt - Math.min(signalAt, stop.began) - pluginWait;
    const timesFile = process.env.LIFECYCLE_TIMES; // measuring: append each cell's times
    if (timesFile) appendFileSync(timesFile, `${phase} | ${behaviour} | ${pluginWait} | ${own}\n`);

    // No restart: one plugin, and after the signal only its stop reached it.
    expect(again).toBeInstanceOf(PluginCallError);
    expect((again as Error).message).toMatch(/mu is stopping \(it got SIGINT\)/);
    const calls = f.calls().map((c) => c.method);
    // (Signalled while starting, the handshake itself is never sent.)
    expect(calls.slice(base).filter((m) => m === "initialize")).toHaveLength(
      phase === "starting" ? 0 : 1,
    );
    for (const m of calls.slice(logAt)) expect(["$/cancel", "shutdown"]).toContain(m);
    // The bound: one stop sequence per plugin; it waits for the plugin at most one grace
    // (held whole only by a plugin that ignores its stop), and adds little of its own.
    expect(mine).toHaveLength(1);
    expect(pluginWait).toBeLessThanOrEqual(GRACE + TIMER_LATE);
    if (holdsTheGrace(behaviour)) {
      expect(stop.by).toBe("grace");
      expect(pluginWait).toBeGreaterThanOrEqual(GRACE - 20);
    }
    expect(own).toBeLessThan(MU_OWN_MAX);
    // Its cancel: the call's deadline began that one stop.
    if (phase === "its cancel") {
      expect(stop.why).toMatch(/no answer within 150 ms/);
      expect(stop.began - callStart).toBeGreaterThanOrEqual(CALL_TIMEOUT - 20);
    }
    // mu raises the signal only once the group is empty, and the signal began or joined
    // the stop.
    expect(raisedAt).toBeGreaterThanOrEqual(stop.gone);
    if (phase === "its cancel" || phase === "shutdown") {
      expect(stop.began).toBeLessThanOrEqual(signalAt);
    } else expect(stop.began).toBeGreaterThanOrEqual(signalAt);
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
    // A grace long enough for the slow exit on a loaded host; the trace says which ended it.
    setPluginGraceForTests(5000);
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
      process.emit("SIGINT");
      await call;
      await closePluginSessions();
      // One stop, ended by the plugin's own exit (not the kill), after its slow cleanup.
      const mine = traces.filter((t) => t.pgid === s.process.pgid);
      expect(mine).toHaveLength(1);
      const [stop] = mine;
      expect(stop?.by).toBe("leader");
      expect((stop?.leaderAt ?? 0) - (stop?.began ?? 0)).toBeGreaterThanOrEqual(140);
      expect(f.cleanExits()).toBe(exitsBefore + 1);
      expect(raised).toEqual([]); // the verb handles it
    } finally {
      process.off("SIGINT", onVerb);
    }
  });
});
