// `mu host check` against fake templates (sh -c): no ssh anywhere. The pi on
// PATH is a shim; the extension is a unix-socket server on the derived path.

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { helloReply, INC } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";
import { initGitRepo } from "./_git.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;
let bin: string;
let calls: string;
let servers: Server[];
let oldPath: string | undefined;
let oldShell: string | undefined;

function shim(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-host-check-"));
  dbPath = join(dir, "mu.db");
  bin = join(dir, "bin");
  calls = join(dir, "calls");
  mkdirSync(bin);
  initGitRepo(dir);
  db = openDb({ path: dbPath });
  servers = [];
  shim(
    "pi",
    'if [ "$1" = "--version" ]; then echo 0.99.1; elif [ "$1" = list ]; then echo "  npm:@mu-crew/mu"; fi',
  );
  oldPath = process.env.PATH;
  oldShell = process.env.SHELL;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.SHELL = "/bin/sh";
  // The fake "ssh": a local sh -c that records each invocation. Not ssh.
  addHost(db, {
    name: "dev",
    shell: "sh -c {cmd}",
    exec: `echo x >> ${calls}; sh -c {cmd}`,
    fetch: "true",
    repo: dir,
    max_sessions: 1,
  });
});

afterEach(async () => {
  process.env.PATH = oldPath;
  if (oldShell === undefined) {
    const k = "SHELL";
    delete process.env[k];
  } else process.env.SHELL = oldShell;
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmFixtureDir(dir);
});

const callCount = (): number =>
  existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0;

async function serveExtension(ws: string, agent: string, hello = helloReply()): Promise<void> {
  const p = ctlSocketPath(ws, agent, dir);
  mkdirSync(dirname(p), { recursive: true });
  const s = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (c: string) => {
      for (const line of dec.push(c)) {
        const req = JSON.parse(line) as { op: string };
        sock.write(
          encode(
            req.op === "hello"
              ? hello
              : {
                  v: 1,
                  ok: true,
                  state: "idle",
                  since: 1,
                  runs: 0,
                  pending: false,
                  incarnation: INC,
                },
          ),
        );
      }
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(p, () => r()));
}

describe("mu host check", () => {
  it("passes: reachable, repo, pi and the extension, each reported; the channel is freed", async () => {
    const r = await runCliJson(["host", "check", "dev", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.data.ok).toBe(true);
    expect(r.data.steps.map((s: { step: string; ok: boolean }) => [s.step, s.ok])).toEqual([
      ["reachable", true],
      ["repo", true],
      ["pi", true],
      ["extension", true],
    ]);
    expect(r.data.steps[2].detail).toContain("0.99.1");
    expect(db.prepare("SELECT COUNT(*) AS c FROM host_channels").get()).toEqual({ c: 0 });
    const human = await runCli(["host", "check", "dev"], dbPath);
    expect(human.stdout).toContain("pi");
  });

  it("with --agent: the socket answers through the forward (extension version, features)", async () => {
    await serveExtension("auth", "worker-1");
    const r = await runCliJson(
      ["host", "check", "dev", "--agent", "worker-1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const ctl = r.data.steps.find((s: { step: string }) => s.step === "ctl");
    expect(ctl).toMatchObject({ ok: true });
    expect(ctl.detail).toContain("3.99.0");
  });

  it("with --agent and no socket: fails on ctl, still one channel", async () => {
    const r = await runCliJson(
      ["host", "check", "dev", "--agent", "worker-1", "-w", "auth", "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(5);
    expect(r.data.steps.find((s: { step: string }) => s.step === "ctl")).toMatchObject({
      ok: false,
    });
  });

  it("unavailable: reports it, skips the rest, and never retries", async () => {
    addHost(db, {
      name: "down",
      shell: "s",
      exec: `echo x >> ${calls}; exit 255`,
      fetch: "f",
      repo: dir,
      max_sessions: null,
    });
    const r = await runCliJson(["host", "check", "down", "--json"], dbPath);
    expect(r.exitCode).toBe(5);
    expect(r.doc.ok).toBe(false);
    expect(r.data.steps.map((s: { step: string; ok: boolean | null }) => [s.step, s.ok])).toEqual([
      ["reachable", false],
      ["repo", null],
      ["pi", null],
      ["extension", null],
    ]);
    expect(callCount()).toBe(1);
  });

  it("a missing repo and a missing pi are each named", async () => {
    addHost(db, {
      name: "norepo",
      shell: "s",
      exec: "sh -c {cmd}",
      fetch: "f",
      repo: join(dir, "absent"),
      max_sessions: null,
    });
    const a = await runCliJson(["host", "check", "norepo", "--json"], dbPath);
    expect(a.exitCode).toBe(5);
    expect(a.data.steps.find((s: { step: string }) => s.step === "repo")).toMatchObject({
      ok: false,
    });
    shim("pi", "exit 127");
    const b = await runCliJson(["host", "check", "dev", "--json"], dbPath);
    expect(b.data.steps.find((s: { step: string }) => s.step === "pi")).toMatchObject({
      ok: false,
    });
  });

  it("a timeout is a failure of that step, not a hang", async () => {
    addHost(db, {
      name: "slow",
      shell: "s",
      exec: "sleep 5",
      fetch: "f",
      repo: dir,
      max_sessions: null,
    });
    const { checkHost } = await import("../src/hosts.js");
    const t = Date.now();
    const report = await checkHost(db, "slow", { timeoutMs: 200 });
    expect(Date.now() - t).toBeLessThan(3000);
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({ step: "reachable", ok: false });
  });

  it("at the cap: refused naming the holder, and the template is never run", async () => {
    db.prepare(
      "INSERT INTO host_channels (host, holder, kind, token, pid, opened_at) VALUES ('dev', 'exec:worker-9', 'transient', 't', ?, 'n')",
    ).run(process.pid);
    const r = await runCli(["host", "check", "dev"], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("exec:worker-9");
    expect(callCount()).toBe(0);
  });

  it("an unknown host is exit 3", async () => {
    expect((await runCli(["host", "check", "nope"], dbPath)).exitCode).toBe(3);
  });
});

const CLI = join(process.cwd(), "dist", "cli.js");
describe.runIf(existsSync(CLI))("cap across real processes", () => {
  it("two concurrent checks at max-sessions 1: one passes, one is refused naming a holder", async () => {
    addHost(db, {
      name: "slowok",
      shell: "s",
      exec: "sleep 0.6; sh -c {cmd}",
      fetch: "f",
      repo: dir,
      max_sessions: 1,
    });
    const run = (): Promise<{ code: number | null; err: string }> =>
      new Promise((res) => {
        const p = spawn("node", [CLI, "host", "check", "slowok"], {
          env: { ...process.env, MU_DB_PATH: dbPath, MU_SYNC_DIR: "" },
        });
        let err = "";
        p.stderr.on("data", (d) => {
          err += String(d);
        });
        p.on("close", (code) => res({ code, err }));
      });
    const [a, b] = await Promise.all([run(), run()]);
    const codes = [a.code, b.code].sort();
    expect(codes).toEqual([0, 4]);
    expect((a.code === 4 ? a : b).err).toContain("check:");
  }, 30_000);
});
