// The protocol core against the fake plugin (plugins spec D13, D14): framing,
// broken plugins, typed errors and retries, timeouts and cancel, the EOF and
// no-detach rules, the plugin's environment and the secret canary.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyError } from "../src/cli/handle.js";
import { HOST_GRACE_MS } from "../src/hosts.js";
import { type PluginSession, startPlugin } from "../src/plugins/client.js";
import {
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
} from "../src/plugins/errors.js";
import { setPluginTapForTests } from "../src/plugins/process.js";
import { encodeMessage, MAX_MESSAGE_BYTES, narrowLinkRun } from "../src/plugins/protocol.js";
import { LOCAL_ONLY_ENV } from "../src/remote-agent.js";
import { withEnv } from "./_env.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin } from "./_plugin.js";

let dir: string;
let f: FakePlugin;
let s: PluginSession | undefined;
let tapped: Array<{ stream: string; text: string }>;

const GRACE = 150;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mppr-"));
  f = fakePlugin(dir);
  tapped = [];
  setPluginTapForTests((stream, text) => tapped.push({ stream, text }));
});

afterEach(async () => {
  setPluginTapForTests(undefined);
  await s?.shutdown();
  s = undefined;
  rmFixtureDir(dir);
});

async function start(config: Record<string, unknown> = {}): Promise<PluginSession> {
  f.set(config);
  s = await startPlugin("fake", f.argv, { graceMs: GRACE });
  return s;
}

const groupGone = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};

const exec = (
  p: PluginSession,
  script = "echo hi",
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
) =>
  p.call(
    "link.exec",
    { target: { host: { name: "dev" } }, script, cwd: ".", timeoutMs: 5000 },
    {
      kind: "effect",
      timeoutMs: opts.timeoutMs ?? 5000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    narrowLinkRun,
  );

const read = (p: PluginSession, timeoutMs = 5000) =>
  p.call(
    "link.exec",
    { target: { host: { name: "dev" } }, script: "true", cwd: ".", timeoutMs: 5000 },
    { kind: "read", timeoutMs },
    narrowLinkRun,
  );

const execCalls = () => f.calls().filter((c) => c.method === "link.exec");

describe("calls and framing", () => {
  it("a call carries the params, a fresh deadline and a request id; the reply is the result", async () => {
    const p = await start();
    const before = Date.now();
    expect(await exec(p)).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "", partial: false });
    const [c] = execCalls();
    expect(c?.params).toMatchObject({
      target: { host: { name: "dev" } },
      script: "echo hi",
      cwd: ".",
      timeoutMs: 5000,
    });
    expect(c?.params.deadline).toBeGreaterThanOrEqual(before + 5000);
    const sent = tapped
      .filter((t) => t.stream === "in")
      .map((t) => JSON.parse(t.text) as { id?: number; method: string });
    expect(sent.map((m) => m.method)).toEqual(["initialize", "link.exec"]);
    expect(sent[1]?.id).toBe(2);
  });

  it("mu never writes a message over 1 MiB", () => {
    expect(() => encodeMessage({ big: "x".repeat(MAX_MESSAGE_BYTES) })).toThrow(
      /over 1048576 bytes/,
    );
  });

  it.each([
    ["malformed", /invalid message \(not JSON\)/],
    ["big", /a message over 1 MiB/],
    ["request", /invalid message .*no id on a plugin's notification/],
    ["noId", /an error with no id/],
    ["badResult", /invalid result/],
  ] as const)("a %s reply breaks the plugin for the invocation", async (fault, re) => {
    const p = await start({ faults: { "link.exec": [fault] } });
    const err = await exec(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect((err as Error).message).toMatch(re);
    expect(classifyError(err).exitCode).toBe(1);
    // Broken: the next call is never sent, and the group is reaped.
    const next = await exec(p).catch((e: unknown) => e);
    expect(next).toBeInstanceOf(PluginCallError);
    expect((next as PluginCallError).kind).toBe("permanent");
    expect(execCalls()).toHaveLength(1);
    await p.shutdown();
    expect(groupGone(p.process.pgid)).toBe(true);
  });

  it("an invalid reply to a read is an unknown answer (exit 5), not an unknown outcome", async () => {
    const p = await start({ faults: { "link.exec": ["malformed"] } });
    const err = await read(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginAnswerUnknownError);
    expect(classifyError(err).exitCode).toBe(5);
  });

  it("only stderr's first line is kept, and only to name a failure", async () => {
    const p = await start({ stderr: "first line", faults: { "link.exec": ["exit"] } });
    const err = await exec(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect((err as Error).message).toMatch(/the plugin exited \(9\): first line/);
  });
});

describe("typed errors and retries", () => {
  it("retryable twice, then success: three sends of the identical params", async () => {
    const p = await start({ faults: { "link.exec": ["retryable", "retryable"] } });
    expect((await exec(p)).exitCode).toBe(0);
    const calls = execCalls();
    expect(calls).toHaveLength(3);
    const strip = (c: (typeof calls)[number]) => ({ ...c.params, deadline: 0 });
    expect(new Set(calls.map((c) => JSON.stringify(strip(c)))).size).toBe(1);
    const ids = tapped
      .filter((t) => t.stream === "in" && t.text.includes("link.exec"))
      .map((t) => (JSON.parse(t.text) as { id: number }).id);
    expect(new Set(ids).size).toBe(3); // a fresh envelope id per send
  });

  it("retryable four times: three retries, then exit 5", async () => {
    const p = await start({
      faults: { "link.exec": ["retryable", "retryable", "retryable", "retryable"] },
    });
    const err = await exec(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginCallError);
    expect((err as PluginCallError).kind).toBe("retryable");
    expect(classifyError(err).exitCode).toBe(5);
    expect(execCalls()).toHaveLength(4);
  });

  it.each([
    ["permanent", 5],
    ["human", 5],
  ] as const)("%s is never retried (exit %i)", async (kind, code) => {
    const p = await start({ faults: { "link.exec": [kind] } });
    const err = await exec(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginCallError);
    expect((err as PluginCallError).kind).toBe(kind);
    expect(classifyError(err).exitCode).toBe(code);
    if (kind === "human") expect((err as PluginCallError).remedy).toBe("touch your security key");
    expect(execCalls()).toHaveLength(1);
  });

  it("unknown-outcome is an unknown effect (exit 1) and a read's unknown answer, never retried", async () => {
    const p = await start({ faults: { "link.exec": ["unknown-outcome", "unknown-outcome"] } });
    await expect(exec(p)).rejects.toBeInstanceOf(EffectOutcomeUnknownError);
    await expect(read(p)).rejects.toBeInstanceOf(PluginAnswerUnknownError);
    expect(execCalls()).toHaveLength(2);
  });
});

describe("timeouts and cancel", () => {
  it("past the deadline: $/cancel, the grace, the group killed; no answer", async () => {
    const p = await start({ faults: { "link.exec": ["hang"] } });
    const t0 = Date.now();
    const err = await exec(p, "echo hi", { timeoutMs: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect((err as Error).message).toMatch(
      /no answer within 100 ms; cancelled, and the plugin was killed/,
    );
    // The fake exits on the stop's EOF, which ends the one grace early.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(Date.now() - t0).toBeLessThan(100 + GRACE + 400);
    const cancel = tapped.find((t) => t.stream === "in" && t.text.includes("$/cancel"));
    expect(JSON.parse(cancel?.text ?? "{}")).toEqual({
      jsonrpc: "2.0",
      method: "$/cancel",
      params: { id: 2 },
    });
    expect(groupGone(p.process.pgid)).toBe(true);
    await expect(exec(p)).rejects.toBeInstanceOf(PluginCallError);
  });

  it("a late reply during the stop is ignored, and neither answers the call nor cuts the grace short", async () => {
    f.set({ ignoreEof: true, lateMs: 150, faults: { "link.exec": ["late"] } });
    s = await startPlugin("fake", f.argv, { graceMs: 600 });
    const t0 = Date.now();
    const err = await exec(s, "echo hi", { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50 + 600 - 20);
    // The late reply arrived and was ignored: it broke nothing, and answered nothing.
    expect(tapped.some((t) => t.stream === "out" && t.text.includes('"exitCode":0'))).toBe(true);
    expect(s.process.broken).toMatch(/no answer within 50 ms/);
    expect(s.process.poisoned).toBe(false);
    expect(groupGone(s.process.pgid)).toBe(true);
  });

  it("a call aborted before it is written is a definite not-sent error, and the plugin stays usable", async () => {
    const p = await start();
    const ac = new AbortController();
    ac.abort();
    const err = await exec(p, "echo effect", { signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginCallError);
    expect((err as PluginCallError).kind).toBe("permanent");
    expect((err as Error).message).toMatch(/not sent: cancelled before it was sent/);
    expect(classifyError(err).exitCode).toBe(5);
    expect(execCalls()).toEqual([]);
    expect(f.calls().map((c) => c.method)).toEqual(["initialize"]); // no $/cancel, no stop
    expect((await exec(p, "echo still")).stdout).toBe("still\n");
  });

  it("an abort (a verb's SIGINT) takes the same path", async () => {
    const p = await start({ faults: { "link.exec": ["hang"] } });
    const ac = new AbortController();
    const pending = exec(p, "echo hi", { signal: ac.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(EffectOutcomeUnknownError);
    expect((err as Error).message).toMatch(/cancelled; cancelled, and the plugin was killed/);
    expect(groupGone(p.process.pgid)).toBe(true);
  });

  it("a read past its deadline is an unknown answer", async () => {
    const p = await start({ faults: { "link.exec": ["hang"] } });
    await expect(read(p, 50)).rejects.toBeInstanceOf(PluginAnswerUnknownError);
  });
});

describe("process rules", () => {
  it("shutdown: the request, stdin closed, the plugin exits; nothing of its group is left", async () => {
    const p = await start();
    await p.shutdown();
    expect(f.calls().map((c) => c.method)).toEqual(["initialize", "shutdown"]);
    expect(groupGone(p.process.pgid)).toBe(true);
  });

  it("a plugin that ignores EOF is killed after the grace", async () => {
    const p = await start({ ignoreEof: true });
    const t0 = Date.now();
    await p.shutdown();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(GRACE);
    expect(groupGone(p.process.pgid)).toBe(true);
  });

  it("the plugin gets mu's environment without the local-only mu variables", async () => {
    const dump = join(dir, "env.json");
    const set = async (keys: readonly string[], fn: () => Promise<void>): Promise<void> => {
      const [k, ...rest] = keys;
      if (k === undefined) return fn();
      return withEnv(k, "/planted", () => set(rest, fn));
    };
    await set(LOCAL_ONLY_ENV, async () => {
      const p = await start({ envDump: dump });
      await p.shutdown();
    });
    const env = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    for (const k of [...LOCAL_ONLY_ENV, "MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.PATH).toBe(process.env.PATH);
  });
});

/**
 * The plugin-side rules, for any plugin (D13): on stdin EOF it exits within the grace, and
 * it leaves nothing behind: its process group is empty and nothing holds its stdout.
 */
async function eofAndNoDetach(
  argv: string[],
): Promise<{ exitMs: number; groupEmpty: boolean; stdoutClosed: boolean }> {
  const [cmd, ...args] = argv;
  const child = spawn(cmd ?? "", args, { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const pgid = child.pid ?? 0;
  const replied = new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
  const stdoutClosed = new Promise<boolean>((resolve) =>
    child.stdout?.once("end", () => resolve(true)),
  );
  child.stdout?.resume();
  child.stdin?.write(
    encodeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocol: { min: 1, max: 1 }, mu: "5" },
    }),
  );
  await replied;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const t0 = Date.now();
  child.stdin?.end(); // what mu's death (SIGKILL included) leaves the plugin
  await Promise.race([exited, new Promise((r) => setTimeout(r, HOST_GRACE_MS))]);
  const exitMs = Date.now() - t0;
  const closed = await Promise.race([
    stdoutClosed,
    new Promise<boolean>((r) => setTimeout(() => r(false), 200)),
  ]);
  const groupEmpty = groupGone(pgid);
  if (!groupEmpty) process.kill(-pgid, "SIGKILL");
  child.stdout?.destroy();
  return { exitMs, groupEmpty, stdoutClosed: closed };
}

describe("the EOF and no-detach rules (the plugin's side)", () => {
  it("the fake exits on stdin EOF within the grace and leaves nothing behind", async () => {
    const r = await eofAndNoDetach(f.argv);
    expect(r.exitMs).toBeLessThan(HOST_GRACE_MS);
    expect(r).toMatchObject({ groupEmpty: true, stdoutClosed: true });
  });

  it("the check catches a plugin that detaches a helper (setsid)", async () => {
    const pidFile = join(dir, "helper.pid");
    f.set({ detach: pidFile });
    const r = await eofAndNoDetach(f.argv);
    try {
      expect(r.stdoutClosed).toBe(false);
    } finally {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    }
  });

  it("mu's own reap does not wait on a helper that holds stdout", async () => {
    const pidFile = join(dir, "helper.pid");
    const p = await start({ detach: pidFile });
    try {
      expect((await exec(p)).exitCode).toBe(0);
      await p.shutdown();
      expect(groupGone(p.process.pgid)).toBe(true);
    } finally {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    }
  });
});

describe("the secret canary (D14)", () => {
  const canary = `canary-${process.pid}-${Date.now()}`;
  const seen = (): boolean => tapped.some((t) => t.text.includes(canary));

  it("never appears in a message or on stderr", async () => {
    await withEnv("MU_PLUGIN_CANARY", canary, async () => {
      const p = await start();
      await exec(p, "echo hi");
      await p.shutdown();
    });
    expect(tapped.length).toBeGreaterThan(0);
    expect(seen()).toBe(false);
  });

  it("the check catches a plugin that leaks it", async () => {
    await withEnv("MU_PLUGIN_CANARY", canary, async () => {
      const p = await start({ leakCanary: true });
      await exec(p, "echo hi");
      await p.shutdown();
    });
    expect(seen()).toBe(true);
  });
});
