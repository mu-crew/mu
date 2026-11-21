// `mu host exec` (spec 2026-11-20-ladder-placement.md §6, §4.2): the outcome table, admission,
// the hand-back mapping, the output and deadline bounds and the metadata-only log op. Runs
// against the template link and the fake plugin's `slots: "self"` link. A real mule link and
// a real sshd are the orchestrator's (Linux) checks, not this file's.

import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execScript } from "../src/cli/host.js";
import { type Db, openDb } from "../src/db.js";
import { execGroupCapture } from "../src/exec-file.js";
import {
  clipOutput,
  HOST_EXEC_OUTPUT_MAX_BYTES,
  HostExecChangedError,
  HostExecTooLargeError,
  hostExec,
} from "../src/host-exec.js";
import { acquireHost } from "../src/host-lifecycle.js";
import { withHostView } from "../src/host-provider.js";
import { addHost, checkHost, HostHandbackError, removeHost } from "../src/hosts.js";
import { setPluginGraceForTests } from "../src/plugins/process.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, linkSeam, providerSeams } from "./_plugin.js";

let dir: string;
let home: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mhe-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  db = openDb({ path: join(dir, "mu.db") });
  // Count every admission row ever inserted: a row is released when the call ends.
  db.exec(`CREATE TABLE seen_channels (host TEXT);
    CREATE TRIGGER seen_ch AFTER INSERT ON host_channels BEGIN INSERT INTO seen_channels VALUES (NEW.host); END;`);
});

afterEach(async () => {
  setPluginGraceForTests(undefined);
  await closePluginSessions();
  db.close();
  rmFixtureDir(dir);
});

const admissions = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM seen_channels").get() as { n: number }).n;
const ops = (): string[] =>
  (db.prepare("SELECT payload FROM ops WHERE entity = 'host'").all() as { payload: string }[]).map(
    (r) => r.payload,
  );

function template(max_sessions: number | null = null): void {
  addHost(db, {
    name: "t",
    shell: "true",
    exec: `cd '${home}' && cd {cwd} && /bin/sh -c {cmd}`,
    fetch: "true",
    repo: null,
    max_sessions,
  });
}

async function plugin(
  config: Record<string, unknown> = {},
  seam: Record<string, unknown> = {},
  max_sessions: number | null = null,
): Promise<FakePlugin> {
  const f = fakePlugin(dir, { home, seams: linkSeam(seam), ...config });
  await addPlugin(db, "fake", f.argv);
  addHost(db, { name: "p", plugin: "fake", fetch: "true", repo: null, max_sessions });
  return f;
}

describe("host exec: the outcome table", () => {
  it("a link reply carries the link's code, stdout and stderr (template)", async () => {
    template();
    const r = await hostExec(db, "t", { script: "echo out; echo err >&2; exit 7" });
    expect(r).toMatchObject({
      host: "t",
      link: "template",
      exit: 7,
      partial: false,
      clipped: false,
      stdout: "out",
      stderr: "err",
    });
    expect(r.remote).toBeUndefined();
  });

  it("runs in --cwd", async () => {
    template();
    mkdirSync(join(home, "sub"));
    expect((await hostExec(db, "t", { script: "pwd", cwd: "sub" })).stdout).toMatch(/home\/sub$/);
  });

  it("a link reply through a plugin link", async () => {
    await plugin();
    const r = await hostExec(db, "p", { script: "echo hi; exit 4" });
    expect(r).toMatchObject({ link: "fake", exit: 4, stdout: expect.stringMatching(/^hi\n?$/) });
  });

  it("a hand-back throws HostHandbackError and runs nothing (plugin `human`)", async () => {
    const f = await plugin({ faults: { "link.exec": ["human"] } });
    await expect(hostExec(db, "p", { script: "touch ran" })).rejects.toBeInstanceOf(
      HostHandbackError,
    );
    expect(existsSync(join(home, "ran"))).toBe(false);
    // Nothing is retried: one link.exec reached the plugin.
    expect(f.calls().filter((c) => c.method === "link.exec")).toHaveLength(1);
  });

  it("no exit code: a deadline answers null, remote stopped (plugin) and exit stays null", async () => {
    setPluginGraceForTests(3000);
    await plugin();
    const r = await hostExec(db, "p", { script: "exec sleep 30", timeoutS: 1 });
    expect(r).toMatchObject({ exit: null, remote: "stopped" });
  });

  it("a template's no-exit says the remote command may still run", async () => {
    // The template link declares remoteOnTimeout unknown; the reply shape is pinned without the
    // 5 s kill grace by reading the declared cap the result reports.
    template();
    const { resolveHost } = await import("../src/host-provider.js");
    expect(resolveHost(db, "t").link.caps.remoteOnTimeout).toBe("unknown");
  });

  it("refused before any call: unknown host, nothing logged", async () => {
    await expect(hostExec(db, "nope", { script: "true" })).rejects.toThrow(/nope/);
    expect(ops()).toEqual([]);
    expect(admissions()).toBe(0);
  });

  it("refused before any call: too large, typed, nothing admitted, run or logged", async () => {
    template();
    await expect(hostExec(db, "t", { script: "x".repeat(200_000) })).rejects.toBeInstanceOf(
      HostExecTooLargeError,
    );
    await plugin();
    await expect(hostExec(db, "p", { script: "x".repeat(200_000) })).rejects.toBeInstanceOf(
      HostExecTooLargeError,
    );
    expect(admissions()).toBe(0);
    expect(ops()).toEqual([]);
  });

  it("refused before any call: a host at its cap runs nothing, logs nothing", async () => {
    template(1);
    db.prepare(
      `INSERT INTO host_channels (host, holder, kind, token, opened_at, pid) VALUES ('t', 'other', 'transient', 'tok', 0, ${process.pid})`,
    ).run();
    await expect(hostExec(db, "t", { script: "touch ran" })).rejects.toThrow();
    expect(existsSync(join(home, "ran"))).toBe(false);
    expect(ops()).toEqual([]);
  });
});

describe("host exec: handback mapping", () => {
  it("a legacy template's exit 3 is a hand-back (the documented exception)", async () => {
    template();
    await expect(hostExec(db, "t", { script: "exit 3" })).rejects.toBeInstanceOf(HostHandbackError);
    expect(ops()[0]).toContain("outcome=handback");
  });

  it("a template's other overlapping codes (7, 8, 255) are plain replies", async () => {
    template();
    for (const n of [7, 8, 255]) {
      expect((await hostExec(db, "t", { script: `exit ${n}` })).exit).toBe(n);
    }
  });

  it("a strict link's command exit arrives as 8 and is a reply, not a hand-back; 3 from a plugin is the plugin's reply, only `human` hands back", async () => {
    await plugin();
    expect((await hostExec(db, "p", { script: "exit 8" })).exit).toBe(8);
    // The adapter reads no code as a hand-back: the plugin says so with `human` (above).
    expect((await hostExec(db, "p", { script: "exit 3" })).exit).toBe(3);
  });
});

describe("host exec: admission", () => {
  it("a template link holds exactly one counted row for the call, released after", async () => {
    template(2);
    await hostExec(db, "t", { script: "true" });
    expect(admissions()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM host_channels").get()).toEqual({ n: 0 });
  });

  it("a slots:self link takes no row, even at a held cap", async () => {
    await plugin({}, {}, 1);
    db.prepare(
      `INSERT INTO host_channels (host, holder, kind, token, opened_at, pid) VALUES ('p', 'other', 'transient', 'tok', 0, ${process.pid})`,
    ).run();
    const before = admissions();
    expect((await hostExec(db, "p", { script: "echo ok" })).exit).toBe(0);
    expect(admissions()).toBe(before);
  });

  it("host check takes no row for a slots:self link and one for a template", async () => {
    await plugin();
    await checkHost(db, "p", {});
    expect(admissions()).toBe(0);
    template();
    await checkHost(db, "t", {});
    expect(admissions()).toBe(1);
  });
});

describe("host exec: bounds", () => {
  it("clipOutput keeps 1 MiB in all, splitting a share to each stream", () => {
    const cap = HOST_EXEC_OUTPUT_MAX_BYTES;
    expect(clipOutput("a", "b")).toEqual({ stdout: "a", stderr: "b", clipped: false });
    const both = clipOutput("o".repeat(cap), "e".repeat(cap));
    expect(both.clipped).toBe(true);
    expect(both.stdout.length).toBe(cap / 2);
    expect(both.stderr.length).toBe(cap / 2);
    const lopsided = clipOutput("o".repeat(cap * 2), "e".repeat(10));
    expect(lopsided.stderr.length).toBe(10);
    expect(lopsided.stdout.length).toBe(cap - 10);
  });

  it("a clipped success still reports the command's exit", async () => {
    template();
    const r = await hostExec(db, "t", {
      script: "head -c 1500000 /dev/zero | tr '\\0' x; exit 0",
    });
    expect(r.exit).toBe(0);
    expect(r.clipped).toBe(true);
    expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBe(
      HOST_EXEC_OUTPUT_MAX_BYTES,
    );
  });

  it("the default deadline is 600 s", async () => {
    const { HOST_EXEC_DEFAULT_TIMEOUT_S } = await import("../src/host-exec.js");
    expect(HOST_EXEC_DEFAULT_TIMEOUT_S).toBe(600);
  });
});

describe("host exec: the log op", () => {
  it("records host, link, exit, duration and command length, never the command or output", async () => {
    template();
    const secret = "SECRET-SENTINEL-1234";
    const r = await hostExec(db, "t", { script: `echo ${secret}; echo ${secret} >&2; exit 5` });
    expect(r.exit).toBe(5);
    const [op, ...rest] = ops();
    expect(rest).toEqual([]);
    expect(op).toMatch(/^host exec t link=template exit=5 duration=\d+ms cmd=\d+B$/);
    expect(op).toContain(`cmd=${Buffer.byteLength(`echo ${secret}; echo ${secret} >&2; exit 5`)}B`);
    const all = JSON.stringify(db.prepare("SELECT * FROM ops").all());
    expect(all).not.toContain(secret);
  });

  it("records a no-exit outcome", async () => {
    setPluginGraceForTests(3000);
    await plugin();
    await hostExec(db, "p", { script: "exec sleep 30", timeoutS: 1 });
    expect(ops()[0]).toMatch(/link=fake outcome=no-exit /);
  });
});

describe("host exec: the verb's command line", () => {
  it("one word is the script as given; several are quoted words", () => {
    expect(execScript(["ls | wc -l"])).toBe("ls | wc -l");
    expect(execScript(["printf", "%s", "a b"])).toBe("'printf' '%s' 'a b'");
  });
});

describe("host exec: a provider host (spec A review G3)", () => {
  async function provider(config: Record<string, unknown> = {}): Promise<FakePlugin> {
    const f = fakePlugin(dir, { home, seams: providerSeams(), ...config });
    await addPlugin(db, "fake", f.argv);
    await acquireHost(db, { name: "box", provider: "fake", params: { size: "s" }, repo: "/work" });
    return f;
  }

  it("runs through the provider's link and takes no admission row", async () => {
    await provider();
    const r = await hostExec(db, "box", { script: "echo hi; exit 4" });
    expect(r).toMatchObject({ host: "box", link: "fake", exit: 4 });
    expect(admissions()).toBe(0);
    expect(ops().at(-1)).toMatch(/^host exec box link=fake exit=4 /);
  });

  it("a plugin `human` error is the hand-back; the command's own 3 stays a result", async () => {
    await provider({ faults: { "link.exec": ["human"] } });
    await expect(hostExec(db, "box", { script: "true" })).rejects.toBeInstanceOf(HostHandbackError);
    expect((await hostExec(db, "box", { script: "exit 3" })).exit).toBe(3);
    expect(admissions()).toBe(0);
  });
});

describe("host exec round 2: review findings", () => {
  const execCalls = (f: FakePlugin): number =>
    f.calls().filter((c) => c.method === "link.exec").length;

  it("admission: a profile re-added as another link before admission runs on neither (slots:mu -> slots:self)", async () => {
    const a = await plugin({}, { slots: "mu" });
    const b = fakePlugin(dir, { home, seams: linkSeam({ slots: "self" }) }, "fake2");
    await addPlugin(db, "fake2", b.argv);
    const call = hostExec(db, "p", { script: "echo old" });
    // hostExec resolved its link and is awaiting admission: edit the profile now.
    removeHost(db, "p");
    addHost(db, { name: "p", plugin: "fake2", fetch: "true", repo: null, max_sessions: null });
    await expect(call).rejects.toBeInstanceOf(HostExecChangedError);
    expect(execCalls(a)).toBe(0);
    expect(execCalls(b)).toBe(0);
    expect(admissions()).toBe(0);
    expect(ops()).toEqual([]);
  });

  it("admission: a plugin profile re-added as a template runs nothing", async () => {
    const a = await plugin({}, { slots: "mu" });
    template();
    const call = hostExec(db, "p", { script: "touch ran" });
    removeHost(db, "p");
    db.prepare("UPDATE host_profiles SET name = 'p' WHERE name = 't'").run();
    await expect(call).rejects.toBeInstanceOf(HostExecChangedError);
    expect(execCalls(a)).toBe(0);
    expect(existsSync(join(home, "ran"))).toBe(false);
    expect(admissions()).toBe(0);
  });

  it("cwd counts toward the plugin's fit: refused, no request", async () => {
    const f = await plugin({}, { maxScriptBytes: 256 });
    await expect(
      hostExec(db, "p", { script: "true", cwd: "d".repeat(500) }),
    ).rejects.toBeInstanceOf(HostExecTooLargeError);
    expect(execCalls(f)).toBe(0);
    expect(ops()).toEqual([]);
  });

  it("the capture itself is bounded: the child is drained and the rest dropped", async () => {
    const r = await execGroupCapture(
      "/bin/sh",
      [
        "-c",
        "head -c 3000000 /dev/zero | tr '\\0' x; head -c 3000000 /dev/zero | tr '\\0' y >&2; exit 4",
      ],
      { maxStreamBytes: 1000 },
    );
    expect(r.exitCode).toBe(4);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1000);
    expect(r.stderr.length).toBe(1000);
  });

  it("a template command's loud output is clipped and flagged, exit kept", async () => {
    template();
    const r = await hostExec(db, "t", { script: "head -c 5000000 /dev/zero | tr '\\0' x; exit 6" });
    expect(r).toMatchObject({ exit: 6, clipped: true });
    expect(Buffer.byteLength(r.stdout)).toBe(HOST_EXEC_OUTPUT_MAX_BYTES);
  });

  it("the clip cuts at code points and never exceeds the bound", () => {
    const cap = HOST_EXEC_OUTPUT_MAX_BYTES;
    for (const prefix of ["", "a", "ab", "abc"]) {
      const r = clipOutput(prefix + "\u{1F600}".repeat(cap), "");
      expect(r.clipped).toBe(true);
      expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(cap);
      expect(r.stdout).not.toContain("\uFFFD");
    }
  });

  it.each(["unknown-outcome", "big"])(
    "no answer proves nothing: %s says `unknown` though the link declares stopped",
    async (fault) => {
      const f = await plugin({ faults: { "link.exec": [fault] } }, { remoteOnTimeout: "stopped" });
      const r = await hostExec(db, "p", { script: "true" });
      expect(r).toMatchObject({ exit: null, remote: "unknown" });
      expect(execCalls(f)).toBe(1);
    },
  );

  it("retry: a retryable refusal is an error after one request, never a resend", async () => {
    const f = await plugin({
      faults: { "link.exec": ["retryable", "retryable", "retryable", "retryable"] },
    });
    await expect(hostExec(db, "p", { script: "true" })).rejects.toThrow();
    expect(execCalls(f)).toBe(1);
  });

  it("retry: one retryable then a reply is not turned into a success", async () => {
    const f = await plugin({ faults: { "link.exec": ["retryable", "ok"] } });
    await expect(hostExec(db, "p", { script: "true" })).rejects.toThrow();
    expect(execCalls(f)).toBe(1);
  });

  it("the op: a dispatched failure is recorded by category, never its detail", async () => {
    await plugin({ faults: { "link.exec": ["permanent"] } });
    await expect(hostExec(db, "p", { script: "echo SECRET-SENTINEL" })).rejects.toThrow();
    const o = ops();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatch(/^host exec p link=fake outcome=error:permanent duration=\d+ms cmd=\d+B$/);
  });

  it("the op: no-answer is recorded as such", async () => {
    await plugin({ faults: { "link.exec": ["unknown-outcome"] } });
    await hostExec(db, "p", { script: "true" });
    expect(ops()[0]).toMatch(/outcome=no-answer /);
  });
});

describe("host exec follow-ups", () => {
  const execCalls = (f: FakePlugin): number =>
    f.calls().filter((c) => c.method === "link.exec").length;

  it("self dispatch: a profile replaced during the plugin's handshake is never dispatched to", async () => {
    const a = await plugin({ initDelayMs: 400 }, { slots: "self" });
    const b = fakePlugin(dir, { home, seams: linkSeam({ slots: "self" }) }, "fake2");
    await addPlugin(db, "fake2", b.argv);
    const call = hostExec(db, "p", { script: "echo old" });
    const settled = call.then(
      () => undefined,
      (e: unknown) => e,
    );
    for (let i = 0; i < 100 && a.calls().length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(a.calls().length).toBeGreaterThan(0); // the old link is mid-handshake
    removeHost(db, "p");
    addHost(db, { name: "p", plugin: "fake2", fetch: "true", repo: null, max_sessions: null });
    expect(await settled).toBeInstanceOf(HostExecChangedError);
    expect(execCalls(a)).toBe(0);
    expect(execCalls(b)).toBe(0);
    expect(admissions()).toBe(0);
  });

  it("host check counting: a template name re-added as slots:self during admission is not counted", async () => {
    template(1);
    const f = fakePlugin(dir, { home, seams: linkSeam({ slots: "self" }) });
    await addPlugin(db, "fake", f.argv);
    const call = withHostView(db, "t", "chk", async (h, lease) => ({
      slots: h.link.caps.slots,
      lease,
    }));
    removeHost(db, "t");
    addHost(db, { name: "t", plugin: "fake", fetch: "true", repo: null, max_sessions: 1 });
    const r = await call;
    expect(r.slots).toBe("self");
    expect(r.lease).toBeUndefined();
    expect(admissions()).toBe(0);
  });

  it("utf8 capture: the byte bound never splits a multibyte character", async () => {
    template();
    const r = await hostExec(db, "t", {
      script:
        "{ printf a; yes | while read -r _; do printf '\\360\\237\\230\\200'; done; } | head -c 2000000",
    });
    expect(r.clipped).toBe(true);
    expect(r.stdout).not.toContain("\uFFFD");
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(HOST_EXEC_OUTPUT_MAX_BYTES);
    expect(Buffer.byteLength(r.stdout)).toBeGreaterThan(HOST_EXEC_OUTPUT_MAX_BYTES - 4);
  });
});
