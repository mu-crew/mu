// The review of P6b (task p6b_fix): containment, signals, one grace, trust at
// every use, UTF-8 frames and the check hand-back (plugins spec D13, D14, D11).
// Each block is one finding's regression test, run against the fake plugin and
// its hostile modes (test/_fake-plugin.mjs).

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { resolveHost } from "../src/host-provider.js";
import { addHost, checkHost, HANDED_BACK, HOST_GRACE_MS } from "../src/hosts.js";
import { type PluginSession, startPlugin } from "../src/plugins/client.js";
import { EffectOutcomeUnknownError, PluginRefusedError } from "../src/plugins/errors.js";
import {
  livePluginProcesses,
  resetTerminatingForTests,
  setPluginGraceForTests,
  setPluginTapForTests,
  setSignalRaiseForTests,
} from "../src/plugins/process.js";
import { encodeMessage, narrowLinkRun } from "../src/plugins/protocol.js";
import { addPlugin, closePluginSessions, pluginSession } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin } from "./_plugin.js";

const GRACE = 300;
/** Scheduling slack on a loaded host. */
const SLACK = 400;

let dir: string;
let f: FakePlugin;
let s: PluginSession | undefined;
let tapped: Array<{ stream: string; text: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpct-"));
  f = fakePlugin(dir);
  tapped = [];
  setPluginTapForTests((stream, text) => tapped.push({ stream, text }));
});

afterEach(async () => {
  setPluginTapForTests(undefined);
  setPluginGraceForTests(undefined);
  setSignalRaiseForTests(undefined);
  resetTerminatingForTests();
  await s?.shutdown();
  s = undefined;
  await closePluginSessions();
  rmFixtureDir(dir);
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const groupGone = (pgid: number): boolean => !alive(-pgid);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  for (const t0 = Date.now(); !fn(); await sleep(20)) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
  }
}

async function start(
  config: Record<string, unknown> = {},
  graceMs = GRACE,
): Promise<PluginSession> {
  f.set(config);
  s = await startPlugin("fake", f.argv, { graceMs });
  return s;
}

const exec = (p: PluginSession, script: string, timeoutMs = 10_000) =>
  p.call(
    "link.exec",
    { target: { host: { name: "dev" } }, script, cwd: ".", timeoutMs },
    { kind: "effect", timeoutMs },
    narrowLinkRun,
  );

const sentMethods = () =>
  tapped
    .filter((t) => t.stream === "in")
    .map((t) => JSON.parse(t.text) as { method: string; params?: { id?: number } });

describe("a signal mu receives (HIGH: bare SIGINT)", () => {
  let saved: Array<(...a: unknown[]) => void>;

  beforeEach(() => {
    // The test runner's own SIGINT listeners stand for "no verb listens".
    saved = process.listeners("SIGINT") as Array<(...a: unknown[]) => void>;
    for (const l of saved) process.off("SIGINT", l);
  });

  afterEach(() => {
    for (const l of saved) process.on("SIGINT", l);
  });

  it("sends $/cancel and shutdown, allows one grace, kills the group, then raises the signal again", async () => {
    const raised: string[] = [];
    setSignalRaiseForTests((sig) => raised.push(sig));
    const p = await start({ ignoreEof: true, faults: { "link.exec": ["hang"] } });
    const call = exec(p, "true").catch((e: unknown) => e);
    await until(() => f.calls().some((c) => c.method === "link.exec"));
    const t0 = Date.now();
    process.emit("SIGINT");
    expect(await call).toBeInstanceOf(EffectOutcomeUnknownError);
    await until(() => raised.length > 0);
    const took = Date.now() - t0;
    expect(raised).toEqual(["SIGINT"]);
    expect(took).toBeGreaterThanOrEqual(GRACE - 20);
    expect(took).toBeLessThan(GRACE + SLACK);
    const sent = sentMethods();
    expect(sent.find((m) => m.method === "$/cancel")?.params).toEqual({ id: 2 });
    expect(sent.some((m) => m.method === "shutdown")).toBe(true);
    expect(f.calls().some((c) => c.method === "$/cancel")).toBe(true); // the plugin got it
    expect(groupGone(p.process.pgid)).toBe(true);
    expect(process.listeners("SIGINT")).toEqual([]); // nothing of mu's left listening
  });

  it("a plugin that honours EOF ends the grace early", async () => {
    const raised: string[] = [];
    setSignalRaiseForTests((sig) => raised.push(sig));
    const p = await start({ faults: { "link.exec": ["hang"] } }, 5000);
    const call = exec(p, "true").catch((e: unknown) => e);
    await until(() => f.calls().some((c) => c.method === "link.exec"));
    const t0 = Date.now();
    process.emit("SIGINT");
    await call;
    await until(() => raised.length > 0);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a verb that listens handles the signal: the plugins stop, mu does not raise it", async () => {
    const raised: string[] = [];
    setSignalRaiseForTests((sig) => raised.push(sig));
    let verb = 0;
    const onVerb = (): void => {
      verb++;
    };
    process.on("SIGINT", onVerb);
    try {
      const p = await start({ faults: { "link.exec": ["hang"] } });
      const call = exec(p, "true").catch((e: unknown) => e);
      await until(() => f.calls().some((c) => c.method === "link.exec"));
      process.emit("SIGINT");
      await call;
      await until(() => groupGone(p.process.pgid));
      await sleep(50);
      expect(verb).toBe(1);
      expect(raised).toEqual([]);
      expect(f.calls().some((c) => c.method === "$/cancel")).toBe(true);
    } finally {
      process.off("SIGINT", onVerb);
    }
  });
});

describe("the group, not the leader (HIGH: helpers outlive a leader's exit)", () => {
  it("a leader that exits mid-call takes its helpers with it, and the call ends at once", async () => {
    const p = await start({ faults: { "link.exec": ["exitWithHelper"] } });
    const t0 = Date.now();
    const err = await exec(p, "true", 8000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect((err as Error).message).toMatch(/the plugin exited \(9\)/);
    expect(Date.now() - t0).toBeLessThan(1500);
    const helper = Number(readFileSync(`${f.configPath}.helper`, "utf8"));
    expect(alive(helper)).toBe(false);
    expect(groupGone(p.process.pgid)).toBe(true);
    expect(livePluginProcesses()).toEqual([]);
  });
});

/**
 * The plugin-side no-detach rule with a call in flight (D13): every process the plugin
 * runs stays in its group, and on stdin EOF it exits within the grace leaving none of them.
 */
async function inFlightNoDetach(argv: string[], pidFile: string) {
  const [cmd, ...args] = argv;
  const child = spawn(cmd ?? "", args, { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const leader = child.pid ?? 0;
  child.stdout?.resume();
  const send = (m: Record<string, unknown>) => child.stdin?.write(encodeMessage(m));
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocol: { min: 1, max: 1 }, mu: "5" },
  });
  const script = `echo $$ > '${pidFile}'; exec sleep 30`;
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "link.exec",
    params: {
      target: { host: { name: "dev" } },
      script,
      cwd: ".",
      timeoutMs: 30_000,
      deadline: Date.now() + 30_000,
    },
  });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const runPid = Number(readFileSync(pidFile, "utf8"));
  const { execFileSync } = await import("node:child_process");
  const table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const tree = new Set([leader]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (pid !== undefined && ppid !== undefined && tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  tree.delete(leader);
  const detached = table
    .filter(([pid, , pgid]) => pid !== undefined && tree.has(pid) && pgid !== leader)
    .map(([pid]) => pid);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const t0 = Date.now();
  child.stdin?.end();
  await Promise.race([exited, sleep(HOST_GRACE_MS)]);
  const exitMs = Date.now() - t0;
  await sleep(50);
  const survivors = [...tree].filter(alive);
  for (const pid of [leader, ...tree]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  child.stdout?.destroy();
  return { runPid, descendants: [...tree], detached, exitMs, survivors };
}

describe("the no-detach rule with a call in flight (HIGH: the fake's runs detached)", () => {
  it("the fake keeps its runs in its group and leaves none on EOF", async () => {
    const r = await inFlightNoDetach(f.argv, join(dir, "run.pid"));
    expect(r.descendants).toContain(r.runPid);
    expect(r.detached).toEqual([]);
    expect(r.exitMs).toBeLessThan(HOST_GRACE_MS);
    expect(r.survivors).toEqual([]);
  });

  it("the check reports a plugin whose runs leave its group", async () => {
    f.set({ detachExec: true });
    const r = await inFlightNoDetach(f.argv, join(dir, "run.pid"));
    expect(r.detached).toContain(r.runPid);
  });
});

describe("one grace, owned by the process manager (MEDIUM: cancel took three)", () => {
  it("a call past its deadline: $/cancel, one grace, the group killed", async () => {
    // A grace long against the slack: two graces cannot pass for one.
    const grace = 800;
    const p = await start({ ignoreEof: true, faults: { "link.exec": ["hang"] } }, grace);
    const t0 = Date.now();
    await expect(exec(p, "true", 100)).rejects.toBeInstanceOf(EffectOutcomeUnknownError);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(100 + grace - 20);
    expect(took).toBeLessThan(100 + grace + SLACK);
    expect(groupGone(p.process.pgid)).toBe(true);
  });

  it("a stop of a plugin that ignores EOF takes one grace", async () => {
    const p = await start({ ignoreEof: true });
    const t0 = Date.now();
    await p.shutdown();
    expect(Date.now() - t0).toBeLessThan(GRACE + SLACK);
  });

  it("the link adds no grace of its own: a link.exec timeout ends within timeout + one grace", async () => {
    setPluginGraceForTests(GRACE);
    const db: Db = openDb({ path: join(dir, "mu.db") });
    try {
      await addPlugin(db, "fake", f.argv);
      addHost(db, { name: "box", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
      f.set({ faults: { "link.exec": ["hang"] } });
      const h = resolveHost(db, "box");
      const t0 = Date.now();
      const r = await h.link.exec(h, { script: "true", cwd: ".", timeoutMs: 100 }, { holder: "t" });
      expect(r.exitCode).toBeNull();
      expect(Date.now() - t0).toBeLessThan(100 + GRACE + SLACK);
      // The cancel killed the plugin, not the session: the next call starts it again.
      const again = await h.link.exec(
        h,
        { script: "echo again", cwd: ".", timeoutMs: 5000 },
        { holder: "t" },
      );
      expect(again.stdout).toBe("again\n");
    } finally {
      db.close();
    }
  });
});

describe("trust at every use (HIGH)", () => {
  it("a registered executable made writable by others is refused when a session starts", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      await addPlugin(db, "fake", f.argv);
      const before = f.calls().length;
      chmodSync(f.path, 0o777);
      const err = await pluginSession(db, "fake").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PluginRefusedError);
      expect((err as Error).message).toMatch(/group- or world-writable/);
      expect(f.calls()).toHaveLength(before); // never ran
    } finally {
      db.close();
    }
  });

  it("a plugin that broke the protocol stays refused for the invocation", async () => {
    const db = openDb({ path: join(dir, "mu.db") });
    try {
      await addPlugin(db, "fake", f.argv);
      f.set({ faults: { "link.exec": ["malformed"] } });
      const one = await pluginSession(db, "fake");
      await exec(one, "true").catch(() => undefined);
      expect(await pluginSession(db, "fake")).toBe(one);
    } finally {
      db.close();
    }
  });
});

describe("UTF-8 frames (MEDIUM: invalid bytes were repaired)", () => {
  it("a reply with a byte that is not UTF-8 is an invalid frame", async () => {
    const p = await start({ faults: { "link.exec": ["badUtf8"] } });
    const err = await exec(p, "true").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect((err as Error).message).toMatch(/invalid message \(not UTF-8\)/);
    expect(p.process.poisoned).toBe(true);
  });

  it("a multi-byte character split across chunks is still whole", async () => {
    const p = await start();
    expect((await exec(p, "printf 'λ%.0s' $(seq 1 30000)")).stdout).toBe("λ".repeat(30000));
  });
});

describe("a check's hand-back (low)", () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb({ path: join(dir, "mu.db") });
    await addPlugin(db, "fake", f.argv);
    addHost(db, { name: "box", plugin: "fake", fetch: "true", repo: null, max_sessions: null });
  });

  afterEach(() => {
    db.close();
  });

  it("a `human` answer is the template runner's handback step, and host check skips the rest", async () => {
    f.set({ faults: { "link.checkSteps": ["human"] } });
    const report = await checkHost(db, "box");
    expect(report.ok).toBe(false);
    const steps = report.steps.map((x) => [x.step, x.ok]);
    expect(steps.slice(0, 2)).toEqual([
      ["fake:checks", null],
      ["handback", false],
    ]);
    expect(report.steps.find((x) => x.step === "handback")?.detail).toMatch(
      /touch your security key/,
    );
    for (const x of report.steps.slice(2)) {
      if (x.step === "handback") continue;
      expect(x, x.step).toMatchObject({ ok: null, detail: HANDED_BACK });
    }
    expect(f.calls().filter((c) => c.method === "link.exec")).toEqual([]);
  });

  it("a plugin's own `handback` step keeps its name", async () => {
    f.set({
      checkSteps: [
        { step: "reachable", ok: null, detail: HANDED_BACK },
        { step: "handback", ok: false, detail: "reachable: touch the key" },
      ],
    });
    const h = resolveHost(db, "box");
    const steps = await h.link.checkSteps?.(
      { db, host: h, phase: "reach", timeoutMs: 5000 },
      { holder: "t" },
    );
    expect(steps?.map((x) => x.step)).toEqual(["fake:reachable", "handback"]);
  });
});
