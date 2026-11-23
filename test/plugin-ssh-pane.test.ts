// The ssh example plugin's `pane` job kind (ladder placement spec §A, rung 3 over plain ssh):
// the view it builds (the session traps), and its close proof: a stop that cannot prove the
// remote job gone fails, so mu keeps the tree and the job record; a proof lets the close finish.
// The wire tests talk to the plugin directly; the contract tests run spawn and close through mu
// with a stub multiplexer and a stand-in ssh (test/_ssh-pane.ts). Nothing reaches a real host.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { getAgent, sendToAgent } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../src/ctl/path.js";
import { addHost } from "../src/hosts.js";
import { addPlugin } from "../src/plugins/registry.js";
import { waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
import { SSH_EXAMPLE } from "./_plugin.js";
import { pluginHostFixture } from "./_plugin-host.js";
import { type CtlServed, type FakeSsh, fakeSsh, PluginWire, serveCtl } from "./_ssh-pane.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";
import { agentRef } from "./_wait-fixtures.js";

const h = pluginHostFixture();
const idOf = (handle: string) => handle.split("@")[0] ?? "";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

let ssh: FakeSsh;
let wire: PluginWire | undefined;
let servers: Server[];

beforeEach(() => {
  ssh = fakeSsh(h.dir, h.dir);
  servers = [];
});
afterEach(async () => {
  wire?.close();
  wire = undefined;
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

const start = (key: string, spec: Record<string, unknown> = {}) =>
  (wire ?? expect.fail("no wire")).call(
    "job.start",
    PluginWire.params({
      key,
      spec: { cmd: "pi", cwd: "/work/tree", env: { MU_REMOTE: "1" }, ...spec },
    }),
  );
const result = (m: Record<string, unknown>) =>
  (m.result as { view: { command: string }; handle: string }) ?? expect.fail(JSON.stringify(m));

describe("the pane kind's declaration and its view", () => {
  it("declares a bound reply job honouring command, env and sockets, full-access only", async () => {
    wire = new PluginWire(ssh.argv);
    const init = await wire.call("initialize", { protocol: { min: 1, max: 1 } });
    const seams = (init.result as { seams: { job: unknown } }).seams;
    expect(seams.job).toMatchObject({
      kind: "pane",
      view: "bound",
      handle: "reply",
      honours: { command: true, env: true, sockets: true, roles: ["full-access"] },
    });
  });

  it("the view disables the control master before the user's ssh words, forwards ctl, and is interactive", async () => {
    wire = new PluginWire([...ssh.argv, "-o", "ControlMaster=auto", "-J", "jump"]);
    const m = await start("key-1", { sockets: { local: "/l/ctl.sock", remote: "/r/ctl.sock" } });
    const { view, handle } = result(m);
    const cmd = view.command;
    // ssh keeps the first value of an option: ours must come before the user's.
    expect(cmd.indexOf("'ControlMaster=no'")).toBeGreaterThan(-1);
    expect(cmd.indexOf("'ControlMaster=no'")).toBeLessThan(cmd.indexOf("'ControlMaster=auto'"));
    expect(cmd).toContain("'ControlPath=none'");
    expect(cmd).toContain("'StreamLocalBindUnlink=yes'");
    expect(cmd).toContain("'ExitOnForwardFailure=yes'");
    expect(cmd).toContain("'-L' '/l/ctl.sock:/r/ctl.sock'");
    expect(cmd.indexOf("'-J' 'jump'")).toBeGreaterThan(cmd.indexOf("'-L'"));
    expect(cmd).toMatch(/'box' '-t' 'exec \/bin\/sh -c /);
    expect(view).not.toHaveProperty("stdin");
    expect(handle).toMatch(/^ssh-[0-9a-f]{32}@h(:[\w.-]+)+$/);
    // A pure function of the key: a repeat is the same reply, another key another handle.
    expect(
      result(await start("key-1", { sockets: { local: "/l/ctl.sock", remote: "/r/ctl.sock" } })),
    ).toEqual({ view, handle });
    expect(result(await start("key-2")).handle).not.toBe(handle);
  });

  it("no sockets, no -L; the env travels as `env K=V` on the host", async () => {
    wire = new PluginWire(ssh.argv);
    const cmd = result(await start("k", { env: { MU_REMOTE_KEY: "a'b" } })).view.command;
    expect(cmd).not.toContain("'-L'");
    expect(cmd).toContain("MU_REMOTE_KEY=");
  });

  it("refuses what ssh -L or the shell cannot carry, with no remote call", async () => {
    wire = new PluginWire(ssh.argv);
    const colon = await start("k", { sockets: { local: "/a:b/s", remote: "/r/s" } });
    expect(colon.error).toMatchObject({ data: { kind: "permanent" } });
    const name = await start("k", { env: { "BAD-NAME": "1" } });
    expect(name.error).toMatchObject({ data: { kind: "permanent" } });
    expect(ssh.invocations()).toEqual([]);
  });

  it("job.lookup proves nothing started: start has no remote effect", async () => {
    wire = new PluginWire(ssh.argv);
    const m = await wire.call("job.lookup", PluginWire.params({ key: "k", fence: 1 }));
    expect(m.result).toEqual({ none: true });
    expect(ssh.invocations()).toEqual([]);
  });
});

describe("job.stop answers only on proof", () => {
  const stop = (handle: string) =>
    (wire ?? expect.fail("no wire")).call(
      "job.stop",
      PluginWire.params({ key: "k", target: { host: { name: "box" }, job: { handle } } }),
    );

  it("a job whose launch never ran: the stop claims the job, so proof; a repeat is proof; the launch can never run after", async () => {
    wire = new PluginWire(ssh.argv);
    const { view, handle } = result(await start("k"));
    expect((await stop(handle)).result).toBeNull();
    expect((await stop(handle)).result).toBeNull();
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", idOf(handle), "stopped"))).toBe(true);
    // The late view finds the job claimed and runs nothing.
    let status = 0;
    try {
      execFileSync("/bin/sh", ["-c", view.command], { stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
  });

  it("an unreachable host is no proof: an error, and nothing claimed on the host", async () => {
    wire = new PluginWire(ssh.argv);
    const { handle } = result(await start("k"));
    ssh.down();
    const m = await stop(handle);
    expect(m.result).toBeUndefined();
    expect(m.error).toMatchObject({ data: { kind: "retryable" } });
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", idOf(handle)))).toBe(false);
  });

  it("a claimed job whose pid was never recorded is no proof", async () => {
    wire = new PluginWire(ssh.argv);
    const { handle } = result(await start("k"));
    mkdirSync(join(ssh.xdg, "mu-plugin-ssh", idOf(handle)), { recursive: true });
    const m = await stop(handle);
    expect(m.error).toMatchObject({
      data: { kind: "retryable" },
      message: expect.stringContaining("no pid recorded"),
    });
  }, 15_000);

  it("an ssh that exits 0 without running the stop script is no proof: no receipt, an error", async () => {
    wire = new PluginWire(ssh.argv);
    const noop = join(h.dir, "bin", "noop-ssh");
    writeFileSync(noop, "#!/bin/sh\nexit 0\n");
    chmodSync(noop, 0o755);
    const { handle } = result(await start("k"));
    wire.close();
    wire = new PluginWire([SSH_EXAMPLE, noop]);
    const m = await stop(handle);
    expect(m.result).toBeUndefined();
    expect(m.error).toMatchObject({ data: { kind: "retryable" } });
    // A receipt for another job does not count either.
    const other = join(h.dir, "bin", "other-ssh");
    writeFileSync(
      other,
      "#!/bin/sh\necho 'mu-plugin-ssh-receipt ssh-00000000000000000000000000000000 gone'\nexit 0\n",
    );
    chmodSync(other, 0o755);
    wire.close();
    wire = new PluginWire([SSH_EXAMPLE, other]);
    expect((await stop(handle)).error).toMatchObject({ data: { kind: "retryable" } });
  });

  it("start and stop in sessions with different XDG_STATE_HOME use the same state namespace", async () => {
    wire = new PluginWire(ssh.argv);
    const { view, handle } = result(await start("k"));
    ssh.xdgAt(join(h.dir, "xdg-a"));
    // The late launch runs under A; the stop under B must still fence it where the launch looks.
    ssh.xdgAt(join(h.dir, "xdg-b"));
    expect((await stop(handle)).result).toBeNull();
    ssh.xdgAt(join(h.dir, "xdg-a"));
    let status = 0;
    try {
      execFileSync("/bin/sh", ["-c", view.command], { stdio: "pipe" });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
    expect(existsSync(join(h.dir, "xdg-b"))).toBe(false);
  });

  const lateView = (view: string) => {
    try {
      execFileSync("/bin/sh", ["-c", view], { stdio: "pipe" });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  it("the handle binds the namespace of the start: a stop through a session with another HOME fences it there", async () => {
    wire = new PluginWire(ssh.argv);
    const { view, handle } = result(await start("k"));
    // Another account home for every later session (a startup file that sets HOME on a tty).
    const other = join(h.dir, "other-home");
    mkdirSync(other);
    const sshB = fakeSsh(join(h.dir, "b"), other);
    wire.close();
    wire = new PluginWire(sshB.argv);
    expect((await stop(handle)).result).toBeNull();
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", idOf(handle), "stopped"))).toBe(true);
    expect(existsSync(join(other, ".local"))).toBe(false);
    expect(lateView(view.command)).toBe(1);
  });

  it("the handle binds the namespace of the start: a plugin process with another MU_SSH_STATE_DIR still fences it there", async () => {
    const dirA = join(realpathSync(h.dir), "state-a");
    const dirB = join(realpathSync(h.dir), "state-b");
    process.env.MU_SSH_STATE_DIR = dirA;
    try {
      wire = new PluginWire(ssh.argv);
      const { view, handle } = result(await start("k"));
      wire.close();
      process.env.MU_SSH_STATE_DIR = dirB;
      wire = new PluginWire(ssh.argv);
      expect((await stop(handle)).result).toBeNull();
      expect(existsSync(join(dirA, idOf(handle), "stopped"))).toBe(true);
      expect(existsSync(dirB)).toBe(false);
      expect(lateView(view.command)).toBe(1);
    } finally {
      delete process.env.MU_SSH_STATE_DIR;
    }
  });

  describe("the state root is resolved on the host at start", () => {
    // A handle carries at most 128 bytes: the real root must be short.
    const shortDir = () => {
      const d = mkdtempSync(join(realpathSync("/tmp"), "sp-"));
      cleanup.push(d);
      return d;
    };
    const cleanup: string[] = [];
    afterEach(() => {
      for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const stopOk = async (handle: string) => (await stop(handle)).result;

    it("a symlink at ~/.local/state: the handle names the real root; launch and stop both work", async () => {
      const real = shortDir();
      mkdirSync(join(h.dir, ".local"), { recursive: true });
      symlinkSync(real, join(h.dir, ".local", "state"));
      wire = new PluginWire(ssh.argv);
      const { view, handle } = result(await start("k", { cmd: "true", cwd: h.dir }));
      expect(handle).toContain(`@o:${real.slice(1).replaceAll("/", ":")}`);
      expect(lateView(view.command)).toBe(0);
      expect(existsSync(join(real, "mu-plugin-ssh", idOf(handle), "pid"))).toBe(true);
      expect(await stopOk(handle)).toBeNull();
    });

    it("a symlinked MU_SSH_STATE_DIR: the handle names its target", async () => {
      const real = shortDir();
      const link = join(realpathSync(h.dir), "link-over");
      symlinkSync(real, link);
      process.env.MU_SSH_STATE_DIR = link;
      try {
        wire = new PluginWire(ssh.argv);
        const { view, handle } = result(await start("k", { cmd: "true", cwd: h.dir }));
        expect(handle).toContain(`@o:${real.slice(1).replaceAll("/", ":")}`);
        expect(lateView(view.command)).toBe(0);
        expect(await stopOk(handle)).toBeNull();
      } finally {
        delete process.env.MU_SSH_STATE_DIR;
      }
    });

    it("a root ending in whitespace is refused, not trimmed into another directory", async () => {
      const odd = join(realpathSync(h.dir), "sp ");
      process.env.MU_SSH_STATE_DIR = odd;
      try {
        wire = new PluginWire(ssh.argv);
        const m = await start("k");
        expect(m.result).toBeUndefined();
        expect(m.error).toBeDefined();
      } finally {
        delete process.env.MU_SSH_STATE_DIR;
      }
    });

    it("a path a startup banner prints before the reply is not the root", async () => {
      const banner = join(realpathSync(h.dir), "banner-sh");
      writeFileSync(banner, '#!/bin/sh\necho /banner\nexec /bin/sh "$@"\n');
      chmodSync(banner, 0o755);
      const want = shortDir();
      process.env.MU_SSH_STATE_DIR = want;
      try {
        ssh = fakeSsh(h.dir, h.dir, { sh: banner });
        wire = new PluginWire(ssh.argv);
        const { handle } = result(await start("k"));
        expect(handle).toContain(`@o:${want.slice(1).replaceAll("/", ":")}`);
      } finally {
        delete process.env.MU_SSH_STATE_DIR;
      }
    });

    it("a truncated root reply is refused", async () => {
      const cut = join(realpathSync(h.dir), "cut-sh");
      writeFileSync(cut, '#!/bin/sh\necho "mu-plugin-ssh-root 99 /tmp/x"\n');
      chmodSync(cut, 0o755);
      ssh = fakeSsh(h.dir, h.dir, { sh: cut });
      wire = new PluginWire(ssh.argv);
      expect((await start("k")).error).toMatchObject({ data: { kind: "retryable" } });
    });

    it("a stop whose state root is gone is no proof and creates nothing", async () => {
      const root = shortDir();
      process.env.MU_SSH_STATE_DIR = join(root, "r");
      try {
        wire = new PluginWire(ssh.argv);
        const { handle } = result(await start("k"));
        rmSync(join(root, "r"), { recursive: true });
        const m = await stop(handle);
        expect(m.result).toBeUndefined();
        expect(m.error).toMatchObject({ data: { kind: "retryable" } });
        expect(existsSync(join(root, "r"))).toBe(false);
      } finally {
        delete process.env.MU_SSH_STATE_DIR;
      }
    });

    it("a root that cannot be resolved is refused: no handle", async () => {
      const file = join(realpathSync(h.dir), "a-file");
      writeFileSync(file, "");
      process.env.MU_SSH_STATE_DIR = join(file, "sub");
      try {
        wire = new PluginWire(ssh.argv);
        const m = await start("k");
        expect(m.result).toBeUndefined();
        expect(m.error).toMatchObject({ data: { kind: "retryable" } });
      } finally {
        delete process.env.MU_SSH_STATE_DIR;
      }
    });
  });

  it("refuses a handle that is not ours before any ssh", async () => {
    wire = new PluginWire(ssh.argv);
    const m = await stop("x; rm -rf /");
    expect(m.error).toMatchObject({ data: { kind: "permanent" } });
    expect(ssh.invocations()).toEqual([]);
  });
});

describe("through mu: spawn, close, and the proof a close waits for", () => {
  let remote: string;
  let cwd: string;
  let served: CtlServed | undefined;
  beforeEach(async () => {
    served = undefined;
    remote = join(h.dir, "remote");
    mkdirSync(remote);
    remote = realpathSync(remote);
    git(remote, "init", "-q");
    git(remote, "commit", "-q", "--allow-empty", "-m", "one");
    // The caller's checkout IS the host's repo: --from HEAD names a commit the host has.
    cwd = process.cwd();
    process.chdir(remote);
    process.env.MU_SPAWN_CTL_MS = "3000";
    await addPlugin(h.db, "ssh", ssh.argv);
    addHost(h.db, { name: "box", plugin: "ssh", fetch: "true", repo: remote, max_sessions: null });
    let n = 0;
    h.stubMux({
      spawnAgent: async (o) => {
        const id = `%${++n}`;
        h.panes.set(id, { command: o.command });
        if (o.cli === "pi") {
          served = await serveCtl(
            o.command,
            remoteCtlSocketPath("ws", o.name, process.getuid?.() ?? 0),
            servers,
            h.dir,
          );
        }
        o.onPaneCreated?.(id, FAKE_SERVER_IDENTITY);
        return id;
      },
      // The fixture's kill reads the fake plugin's backend: there is none here.
      killPane: async (id) => {
        h.panes.delete(id.paneId);
      },
    });
  });
  afterEach(() => {
    process.chdir(cwd);
    process.env.MU_SPAWN_CTL_MS = "0";
  });

  it("the fixture listens privately and checks the whole -L argument", async () => {
    const view = (spec: string) => `exec ssh '-L' '${spec}' 'box'`;
    const rem = "/tmp/mu-fixture-never-bound/x.sock";
    const a = join(h.dir, "a");
    const b = join(h.dir, "b");
    await expect(
      serveCtl(view(`${join(a, "l.sock")}:${rem}.wrong`), rem, servers, a),
    ).rejects.toThrow();
    await serveCtl(view(`${join(a, "l.sock")}:${rem}`), rem, servers, a);
    await serveCtl(view(`${join(b, "l.sock")}:${rem}`), rem, servers, b);
    // Two fixtures with one remote address stay apart, and neither binds that address.
    expect(existsSync(rem)).toBe(false);
  });

  it("spawn hands the ssh view the ctl forward, then close with proof leaves no row, record, tree or socket", async () => {
    const a = await h.spawn({ cli: "pi", cwd: remote, worktree: true });
    expect(a).toMatchObject({ ctl: "ok" });
    const row = getAgent(h.db, "w1", "ws") ?? expect.fail("no row");
    const view = [...h.panes.values()][0]?.command ?? "";
    const remoteSock = remoteCtlSocketPath("ws", "w1", process.getuid?.() ?? 0);
    expect(view).toContain("'ControlPath=none'");
    expect(view).toContain(`${ctlSocketPath("ws", "w1", h.dir)}:${remoteSock}`);
    expect(existsSync(row.cwd ?? "")).toBe(true);
    const job = getCarrierJobByName(h.db, "ws", "w1") ?? expect.fail("no job record");
    expect(job.job).toMatch(/^ssh-[0-9a-f]{32}@h(:[\w.-]+)+$/);

    // Send and wait go over the view's forwarded ctl socket, through the channel the row recorded.
    expect(row.cli).toBe("pi");
    const before = served?.forwarded() ?? 0;
    const sent = await sendToAgent(h.db, "w1", "do it", { workstream: "ws" });
    expect(sent).toMatchObject({ transport: "ctl", runs: 1 });
    const waited = await waitForEvents(h.db, [{ ...agentRef("w1", "ws"), afterRuns: 0 }], {
      ...ctlAgentHooks(h.db),
      sync: false,
      pollMs: 20,
      timeoutMs: 5000,
      callers: [],
    });
    expect(waited.event).toMatchObject({ kind: "settled", runs: 1 });
    expect(served?.ops).toEqual(expect.arrayContaining(["send", "wait"]));
    expect(served?.forwarded()).toBeGreaterThan(before);

    const closed = await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(closed).toMatchObject({ killedPane: true, deletedRow: true });
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(existsSync(row.cwd ?? "")).toBe(false);
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", idOf(job.job ?? "?"), "stopped"))).toBe(true);
  });

  it("no proof, no cleanup: an unreachable host keeps the tree and the record; the retry with proof finishes", async () => {
    await h.spawn({ cli: "pi", cwd: remote, worktree: true });
    const row = getAgent(h.db, "w1", "ws") ?? expect.fail("no row");
    ssh.down();
    const err = await closeAgent(h.db, "w1", { workstream: "ws" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // The record, the tree and the name are kept: the stop could not prove the job gone.
    expect(listCarrierJobs(h.db)).toHaveLength(1);
    expect(existsSync(row.cwd ?? "")).toBe(true);
    expect(getCarrierJobByName(h.db, "ws", "w1")).toMatchObject({ treePath: row.cwd });

    ssh.up();
    await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(existsSync(row.cwd ?? "")).toBe(false);
  });
});
