// The ssh example plugin's `pane` job kind (ladder placement spec §A, rung 3 over plain ssh):
// the view it builds (the session traps), and its close proof: a stop that cannot prove the
// remote job gone fails, so mu keeps the tree and the job record; a proof lets the close finish.
// The wire tests talk to the plugin directly; the contract tests run spawn and close through mu
// with a stub multiplexer and a stand-in ssh (test/_ssh-pane.ts). Nothing reaches a real host.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import { getAgent } from "../src/agents.js";
import { getCarrierJobByName, listCarrierJobs } from "../src/carrier-jobs.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../src/ctl/path.js";
import { addHost } from "../src/hosts.js";
import { addPlugin } from "../src/plugins/registry.js";
import { pluginHostFixture } from "./_plugin-host.js";
import { type FakeSsh, fakeSsh, PluginWire, serveCtl } from "./_ssh-pane.js";

const h = pluginHostFixture();
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
    expect(handle).toMatch(/^ssh-[0-9a-f]{32}$/);
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
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", handle, "stopped"))).toBe(true);
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
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", handle))).toBe(false);
  });

  it("a claimed job whose pid was never recorded is no proof", async () => {
    wire = new PluginWire(ssh.argv);
    const { handle } = result(await start("k"));
    mkdirSync(join(ssh.xdg, "mu-plugin-ssh", handle), { recursive: true });
    const m = await stop(handle);
    expect(m.error).toMatchObject({
      data: { kind: "retryable" },
      message: expect.stringContaining("no pid recorded"),
    });
  }, 15_000);

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
  beforeEach(async () => {
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
        if (o.cli === "pi") await serveCtl(ctlSocketPath("ws", o.name, h.dir), servers);
        o.onPaneCreated?.(id);
        return id;
      },
      // The fixture's kill reads the fake plugin's backend: there is none here.
      killPane: async (id) => {
        h.panes.delete(id);
      },
    });
  });
  afterEach(() => {
    process.chdir(cwd);
    process.env.MU_SPAWN_CTL_MS = "0";
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
    expect(job.job).toMatch(/^ssh-[0-9a-f]{32}$/);

    const closed = await closeAgent(h.db, "w1", { workstream: "ws" });
    expect(closed).toMatchObject({ killedPane: true, deletedRow: true });
    expect(getAgent(h.db, "w1", "ws")).toBeUndefined();
    expect(listCarrierJobs(h.db)).toEqual([]);
    expect(existsSync(row.cwd ?? "")).toBe(false);
    expect(existsSync(join(ssh.xdg, "mu-plugin-ssh", job.job ?? "?", "stopped"))).toBe(true);
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
