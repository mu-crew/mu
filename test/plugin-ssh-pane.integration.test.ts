// The ssh example plugin's pane kind with real processes: a view that really runs the harness on
// the "host", and job.stop's proof against it (the view dies, the remote process stays: no pty,
// no hangup). The last suite uses a real sshd on loopback; it runs where `sshd` and `ssh-keygen`
// exist and REAL_SSHD_TEST=1 (the orchestrator's Linux box), and asserts the session traps against
// a client config that asks for a shared control master.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { SSH_EXAMPLE } from "./_plugin.js";
import { type FakeSsh, fakeSsh, PluginWire } from "./_ssh-pane.js";

let dir: string;
let wire: PluginWire | undefined;
const views: ChildProcess[] = [];
const pids: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mpsp-"));
});
afterEach(() => {
  wire?.close();
  wire = undefined;
  for (const v of views.splice(0)) killGroup(v.pid);
  for (const p of pids.splice(0)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {}
  }
  rmFixtureDir(dir);
});

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

const q = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect.fail(`timed out waiting for ${what}`);
}

/** Start the job and run its view like the multiplexer would: a detached shell. */
async function launch(
  w: PluginWire,
  xdg: string,
  key: string,
  spec: Record<string, unknown>,
  opts: { pty?: boolean } = {},
): Promise<{ handle: string; view: ChildProcess; pid: number }> {
  const m = await w.call(
    "job.start",
    PluginWire.params({ key, spec: { cwd: dir, env: {}, ...spec } }),
  );
  const { view, handle } = m.result as { view: { command: string }; handle: string };
  const child = opts.pty
    ? // The view on a real terminal, as in a pane: the command's session gets a controlling tty.
      spawn(
        "python3",
        ["-c", "import pty,sys; pty.spawn(['/bin/sh','-c',sys.argv[1]])", view.command],
        {
          detached: true,
          stdio: ["pipe", "ignore", "ignore"],
        },
      )
    : spawn("/bin/sh", ["-c", view.command], { detached: true, stdio: "ignore" });
  views.push(child);
  const pidFile = join(xdg, "mu-plugin-ssh", handle, "pid");
  await until(() => existsSync(pidFile), "the launch to record its pid");
  const pid = Number(readFileSync(pidFile, "utf8").split(" ")[0]);
  pids.push(pid);
  return { handle, view: child, pid };
}

const stop = (w: PluginWire, key: string, handle: string) =>
  w.call(
    "job.stop",
    PluginWire.params({ key, target: { host: { name: "box" }, job: { handle } } }),
  );
const status = async (w: PluginWire, key: string, handle: string) =>
  (
    await w.call(
      "job.status",
      PluginWire.params({ key, target: { host: { name: "box" }, job: { handle } } }),
    )
  ).result;

describe("a running remote job and its stop proof (stand-in ssh)", () => {
  let ssh: FakeSsh;
  beforeEach(() => {
    ssh = fakeSsh(dir, dir);
    wire = new PluginWire(ssh.argv);
  });

  it("running while the harness runs; a stop after the view died kills it and proves it; then ended", async () => {
    const w = wire ?? expect.fail("no wire");
    const { handle, view, pid } = await launch(w, ssh.xdg, "k1", { cmd: "sleep 300" });
    expect(await status(w, "k1", handle)).toEqual({ state: "running" });
    // The view dies (only its shell: the stand-in's remote shares its group); the remote process
    // does not notice, as with no hangup.
    view.kill("SIGKILL");
    await until(() => view.exitCode !== null || view.signalCode !== null, "the view to die");
    expect(alive(pid)).toBe(true);
    expect((await stop(w, "k1", handle)).result).toBeNull();
    expect(alive(pid)).toBe(false);
    expect(await status(w, "k1", handle)).toEqual({ state: "ended", exit: null });
    // Idempotent.
    expect((await stop(w, "k1", handle)).result).toBeNull();
  }, 30_000);

  it("a leader that already exited is proof with nothing to signal", async () => {
    const w = wire ?? expect.fail("no wire");
    const { handle, pid } = await launch(w, ssh.xdg, "k2", { cmd: "sleep 300" });
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid), "the leader to exit");
    expect((await stop(w, "k2", handle)).result).toBeNull();
  }, 30_000);

  it("a harness that ignores HUP and TERM is killed, and only then proven", async () => {
    const w = wire ?? expect.fail("no wire");
    const { handle, pid } = await launch(w, ssh.xdg, "k3", {
      cmd: "trap '' HUP TERM; while :; do sleep 1; done",
    });
    expect((await stop(w, "k3", handle)).result).toBeNull();
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it("the pane command stays in the checked process group on a tty, so a stop reaches a HUP-ignoring foreground command", async () => {
    const bash = ["/bin/bash", "/usr/bin/bash"].find((b) => existsSync(b));
    if (bash === undefined) return;
    const fg = fakeSsh(dir, dir, { foreground: true, shell: bash });
    wire?.close();
    const w = new PluginWire(fg.argv);
    wire = w;
    const pidFile = join(dir, "runner.pid");
    const { handle } = await launch(
      w,
      fg.xdg,
      "k5",
      {
        cmd: `sh -c 'trap "" HUP; echo $$ > ${pidFile}; exec sleep 300'`,
      },
      { pty: true },
    );
    await until(() => existsSync(pidFile), "the foreground command to start");
    const runner = Number(readFileSync(pidFile, "utf8"));
    pids.push(runner);
    expect((await stop(w, "k5", handle)).result).toBeNull();
    expect(alive(runner)).toBe(false);
  }, 60_000);

  const dash = existsSync("/bin/dash") ? it : it.skip;
  dash(
    "under dash a reaped leader with a live group member is no proof, and nothing is signalled",
    async () => {
      const d = fakeSsh(dir, dir, { sh: "/bin/dash" });
      wire?.close();
      const w = new PluginWire(d.argv);
      wire = w;
      // A group whose leader is gone: `sleep` keeps the leader's pgid.
      const g = spawn("/bin/sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!; echo $$"], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      g.stdout?.on("data", (c) => {
        out += c;
      });
      await new Promise((r) => g.on("close", r));
      const [member, leader] = out.trim().split("\n").map(Number);
      pids.push(member ?? 0);
      expect(alive(leader ?? 0)).toBe(false);
      const handle = `ssh-${"a".repeat(32)}`;
      mkdirSync(join(d.xdg, "mu-plugin-ssh", handle), { recursive: true });
      writeFileSync(
        join(d.xdg, "mu-plugin-ssh", handle, "pid"),
        `${leader} Thu Jan 1 00:00:00 2000\n`,
      );
      const m = await stop(w, "k6", handle);
      expect(m.result).toBeUndefined();
      expect(m.error).toMatchObject({ data: { kind: "retryable" } });
      expect(alive(member ?? 0)).toBe(true);
    },
    30_000,
  );

  it("the claim is atomic: a second launch of the same job runs nothing", async () => {
    const w = wire ?? expect.fail("no wire");
    const { handle } = await launch(w, ssh.xdg, "k4", { cmd: "sleep 300" });
    const m = await w.call(
      "job.start",
      PluginWire.params({ key: "k4", spec: { cmd: "true", cwd: dir, env: {} } }),
    );
    const again = spawn(
      "/bin/sh",
      ["-c", (m.result as { view: { command: string } }).view.command],
      {
        stdio: "ignore",
      },
    );
    const code = await new Promise((r) => again.on("close", r));
    expect(code).toBe(1);
    await stop(w, "k4", handle);
  }, 30_000);
});

/** sshd lives in sbin, often off a user's PATH. */
const SBIN = `${process.env.PATH ?? ""}:/usr/sbin:/usr/local/sbin`;
const haveSshd = (): boolean => {
  if (process.env.REAL_SSHD_TEST !== "1") return false;
  try {
    execFileSync("sh", ["-c", "command -v ssh-keygen ssh sshd"], {
      stdio: "ignore",
      env: { ...process.env, PATH: SBIN },
    });
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!haveSshd())("over a real sshd on loopback", () => {
  let sshd: ChildProcess | undefined;
  afterEach(() => {
    if (sshd?.pid !== undefined) killGroup(sshd.pid);
    sshd = undefined;
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
  }

  it("a PTY-backed view forwards ctl: traffic crosses the -L, no master is opened by the view, the stop proves", async () => {
    const keys = join(dir, "keys");
    mkdirSync(keys);
    const kg = (...a: string[]) => execFileSync("ssh-keygen", ["-q", "-N", "", ...a]);
    kg("-t", "ed25519", "-f", join(keys, "host"));
    kg("-t", "ed25519", "-f", join(keys, "user"));
    writeFileSync(join(keys, "authorized_keys"), readFileSync(join(keys, "user.pub")));
    const port = await freePort();
    const sshdPath = execFileSync("sh", ["-c", "command -v sshd"], {
      encoding: "utf8",
      env: { ...process.env, PATH: SBIN },
    }).trim();
    writeFileSync(
      join(keys, "sshd_config"),
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${join(keys, "host")}`,
        `AuthorizedKeysFile ${join(keys, "authorized_keys")}`,
        `PidFile ${join(keys, "sshd.pid")}`,
        "UsePAM no",
        "StrictModes no",
        "PasswordAuthentication no",
        "AllowStreamLocalForwarding yes",
        "AllowTcpForwarding yes",
      ].join("\n"),
    );
    sshd = spawn(sshdPath, ["-D", "-e", "-f", join(keys, "sshd_config")], {
      detached: true,
      stdio: "ignore",
    });
    const cm = join(dir, "cm");
    mkdirSync(cm);
    const clientConfig = join(keys, "ssh_config");
    writeFileSync(
      clientConfig,
      [
        "Host box",
        "  HostName 127.0.0.1",
        `  Port ${port}`,
        `  User ${userInfo().username}`,
        `  IdentityFile ${join(keys, "user")}`,
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking no",
        "  UserKnownHostsFile /dev/null",
        "  BatchMode yes",
        "  ControlMaster auto",
        `  ControlPath ${cm}/%C`,
        "  ControlPersist 60",
      ].join("\n"),
    );
    // sshd up: a plain ssh answers.
    await until(() => {
      try {
        execFileSync(
          "ssh",
          ["-F", clientConfig, "-o", "ControlMaster=no", "-o", "ControlPath=none", "box", "true"],
          {
            stdio: "ignore",
          },
        );
        return true;
      } catch {
        return false;
      }
    }, "sshd to accept");

    // The host side keeps its job state here, not under the real home: one namespace for the
    // plugin's start and stop.
    const xdg = join(dir, "xdg");
    process.env.MU_SSH_STATE_DIR = join(xdg, "mu-plugin-ssh");
    wire = new PluginWire([SSH_EXAMPLE, "ssh", "-F", clientConfig]);
    const local = join(dir, "local.sock");
    const remoteSock = join(dir, "remote.sock");
    // The "harness": a listener on the host's socket that answers a line with `pong`.
    const server = join(dir, "server.mjs");
    writeFileSync(
      server,
      `import { connect, createServer } from "node:net";
createServer((s) => s.on("data", () => s.end("pong\\n"))).listen(${JSON.stringify(remoteSock)});
`,
    );
    const { handle, view, pid } = await launch(
      wire,
      xdg,
      "real-1",
      { cmd: `${q(process.execPath)} ${q(server)}`, sockets: { local, remote: remoteSock } },
      { pty: true },
    );
    // The view's own connection carries the forward: a client through it reaches the listener.
    await until(() => existsSync(local), "the -L forward to bind");
    await until(() => existsSync(remoteSock), "the host listener to bind");
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect(local);
      let got = "";
      c.setEncoding("utf8");
      c.on("data", (d) => {
        got += d;
      });
      c.on("error", reject);
      c.on("close", () => resolve(got));
      c.write("ping\n");
    });
    expect(reply).toBe("pong\n");
    // Only the view has connected so far, and it asked for no shared master.
    expect(readdirSync(cm)).toEqual([]);
    // The status and stop calls use the user's ssh config (ControlMaster auto): they may open a
    // master of their own, which is cleaned up below, not asserted away.
    try {
      expect(await status(wire, "real-1", handle)).toEqual({ state: "running" });
      killGroup(view.pid);
      expect((await stop(wire, "real-1", handle)).result).toBeNull();
      expect(alive(pid)).toBe(false);
    } finally {
      try {
        execFileSync("ssh", ["-F", clientConfig, "-O", "exit", "box"], { stdio: "ignore" });
      } catch {}
      delete process.env.MU_SSH_STATE_DIR;
    }
  }, 60_000);
});
