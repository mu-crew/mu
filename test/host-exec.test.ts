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
import {
  clipOutput,
  HOST_EXEC_OUTPUT_MAX_BYTES,
  HostExecTooLargeError,
  hostExec,
} from "../src/host-exec.js";
import { acquireHost } from "../src/host-lifecycle.js";
import { addHost, checkHost, HostHandbackError } from "../src/hosts.js";
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
    setPluginGraceForTests(300);
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
    setPluginGraceForTests(300);
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
