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
import { addHost, listHostChannels, reserveHostChannel, runHostTemplate } from "../src/hosts.js";
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

  it("with no repo anywhere the repo step is skipped and passes; --root checks one", async () => {
    addHost(db, {
      name: "bare",
      shell: "s",
      exec: "sh -c {cmd}",
      fetch: "f",
      repo: null,
      max_sessions: null,
    });
    const a = await runCliJson(["host", "check", "bare", "--json"], dbPath);
    expect(a.exitCode).toBeNull();
    expect(a.data.ok).toBe(true);
    expect(a.data.steps.find((s: { step: string }) => s.step === "repo")).toMatchObject({
      ok: null,
    });
    const b = await runCliJson(
      ["host", "check", "bare", "--root", join(dir, "absent"), "--json"],
      dbPath,
    );
    expect(b.exitCode).toBe(5);
    expect(b.data.steps.find((s: { step: string }) => s.step === "repo")).toMatchObject({
      ok: false,
    });
  });

  it("a {cwd} exec template still runs without a repo: it gets `.`, the login directory", async () => {
    addHost(db, {
      name: "cwdexec",
      shell: "s",
      exec: "cd {cwd} && sh -c {cmd}",
      fetch: "f",
      repo: null,
      max_sessions: null,
    });
    const a = await runCliJson(["host", "check", "cwdexec", "--json"], dbPath);
    expect(a.data.steps.find((s: { step: string }) => s.step === "reachable")).toMatchObject({
      ok: true,
    });
    expect(a.exitCode).toBeNull();
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

  // finding_host_timeout_orphan_channel: a compound template forks (no tail-exec),
  // so killing only the shell would orphan the transport under a released lease.
  describe("a timed-out template takes its whole process group with it", () => {
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitFor = async (f: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
      return f();
    };

    it("backgrounded and piped descendants are dead and leave no late side effect before the channel is free", async () => {
      const pidFile = join(dir, "t.pid");
      const marker = join(dir, "late");
      addHost(db, {
        name: "orph",
        shell: "s",
        exec: "sh -c {cmd}",
        fetch: "f",
        repo: dir,
        max_sessions: 1,
      });
      const cmd = `sh -c 'echo $$ > ${pidFile}; sleep 1; echo x > ${marker}' & wait`;
      const r = await runHostTemplate(db, "orph", "exec", "first", { cmd }, { timeoutMs: 150 });
      expect(r.exitCode).toBeNull();
      const pid = Number(readFileSync(pidFile, "utf8"));
      // At the moment the channel is released, nothing of the template is left.
      expect(listHostChannels(db, "orph")).toEqual([]);
      expect(alive(pid)).toBe(false);
      await new Promise((res) => setTimeout(res, 1200));
      expect(existsSync(marker)).toBe(false);
      await reserveHostChannel(db, "orph", "second");
    });

    it("a fork-and-wait shape (`|| echo`, pipe to cat) is reaped too", async () => {
      const pidFile = join(dir, "p.pid");
      addHost(db, {
        name: "pipe",
        shell: "s",
        exec: `sh -c 'echo $$ > ${pidFile}; exec sleep 30' || echo failed >&2; echo {cmd} | cat >/dev/null`,
        fetch: "f",
        repo: dir,
        max_sessions: 1,
      });
      await runHostTemplate(db, "pipe", "exec", "h", { cmd: "x" }, { timeoutMs: 150 });
      expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    });

    it("a clean exit also reaps a background leftover", async () => {
      const pidFile = join(dir, "c.pid");
      addHost(db, {
        name: "clean",
        shell: "s",
        exec: `sh -c 'echo $$ > ${pidFile}; exec sleep 30' & while [ ! -s ${pidFile} ]; do :; done; echo {cmd}`,
        fetch: "f",
        repo: dir,
        max_sessions: 1,
      });
      const r = await runHostTemplate(db, "clean", "exec", "h", { cmd: "ok" });
      expect(r).toMatchObject({ exitCode: 0, stdout: "ok" });
      expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
    });

    // Needs the built CLI (hosts.ts imports with .js specifiers, so it cannot run from source here).
    it.runIf(existsSync(join(process.cwd(), "dist", "cli.js")))(
      "caller termination kills the group, not just the shell",
      async () => {
        const pidFile = join(dir, "k.pid");
        addHost(db, {
          name: "term",
          shell: "s",
          exec: `sh -c 'echo $$ > ${pidFile}; exec sleep 30' || echo failed >&2`,
          fetch: "f",
          repo: dir,
          max_sessions: 1,
        });
        const parent = spawn(
          "node",
          [join(process.cwd(), "dist", "cli.js"), "host", "check", "term"],
          {
            stdio: "ignore",
            env: { ...process.env, MU_DB_PATH: dbPath, MU_SYNC_DIR: "" },
          },
        );
        const closed = new Promise((res) => parent.once("close", res));
        try {
          expect(
            await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== ""),
          ).toBe(true);
          await new Promise((r) => setTimeout(r, 100));
          parent.kill("SIGTERM");
          await closed;
          expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
        } finally {
          parent.kill("SIGKILL");
          try {
            process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {}
        }
      },
      20_000,
    );
  });

  // finding_host_reap_exit_hook_gap: the shell exits at once but leaves a TERM-ignoring
  // descendant on redirected stdio, so mu is inside the reap grace window when it dies.
  // The slot must stay held for as long as that transport lives.
  describe.runIf(existsSync(join(process.cwd(), "dist", "cli.js")))(
    "caller death during the reap never frees a slot under a live transport",
    () => {
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const until = async (f: () => boolean): Promise<boolean> => {
        for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 25));
        return f();
      };

      it.each(["SIGINT", "SIGTERM", "SIGABRT", "SIGKILL"] as const)(
        "%s",
        async (sig) => {
          const pidFile = join(dir, "r.pid");
          addHost(db, {
            name: "reap",
            shell: "s",
            exec: `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 30' >/dev/null 2>&1 & while [ ! -s "${pidFile}" ]; do :; done; echo ready`,
            fetch: "f",
            repo: dir,
            max_sessions: 1,
          });
          const parent = spawn(
            process.execPath,
            [join(process.cwd(), "dist", "cli.js"), "host", "check", "reap"],
            { stdio: "ignore", env: { ...process.env, MU_DB_PATH: dbPath, MU_SYNC_DIR: "" } },
          );
          const closed = new Promise((res) => parent.once("close", res));
          let pid = 0;
          try {
            expect(
              await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""),
            ).toBe(true);
            pid = Number(readFileSync(pidFile, "utf8"));
            await new Promise((r) => setTimeout(r, 100));
            parent.kill(sig);
            await closed;
            if (sig === "SIGKILL") {
              // Nothing could clean up: the transport lives, so the slot is still held.
              expect(alive(pid)).toBe(true);
            } else {
              // The exit hook outlives the shell: the group is killed on the way out.
              expect(await until(() => !alive(pid))).toBe(true);
            }
            if (alive(pid)) {
              await expect(reserveHostChannel(db, "reap", "second")).rejects.toThrow(
                /max-sessions/,
              );
              process.kill(pid, "SIGKILL");
              expect(await until(() => !alive(pid))).toBe(true);
            }
            const lease = await reserveHostChannel(db, "reap", "second");
            expect(lease.host).toBe("reap");
          } finally {
            parent.kill("SIGKILL");
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        },
        20_000,
      );
    },
  );

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
