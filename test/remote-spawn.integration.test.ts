// `agent spawn --host --worktree --task` end to end (v_remote_spawn, part A) on
// a REAL tmux server and REAL git, with no real host. The profile's templates
// are local: `exec` is `sh -c`, and `shell` runs a node "fake ssh" that starts
// the remote pi (a ctl-serving shim at the REMOTE socket path) and proxies the
// derived LOCAL socket to it, as `ssh -L` would. "Remote" HOME is a temp dir.
// Needs $TMUX (the suite's private server); skips without it.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCtlUnreachableError,
  closeAgent,
  getAgent,
  spawnAgent,
  spawnForTask,
} from "../src/agents.js";
import { CTL_FEATURES, CTL_OPS } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, HostChannelBusyError, listHostChannels } from "../src/hosts.js";
import { LOCAL_ONLY_ENV } from "../src/remote-agent.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { killSession, tmux } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { gitIn, initGitRepo } from "./_git.js";
import { tmuxIntegrationAvailable } from "./_mux.js";

const describeIfTmux = tmuxIntegrationAvailable() ? describe : describe.skip;

/** The "remote pi": serves $MU_CTL_SOCK like the extension and records what it was given. */
const PI_SHIM = `
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const sock = process.env.MU_CTL_SOCK;
fs.mkdirSync(path.dirname(sock), { recursive: true });
fs.writeFileSync(process.env.SEEN, JSON.stringify({ pid: process.pid, cwd: process.cwd(), env: process.env }));
const hello = { v: 1, ok: true, ops: ${JSON.stringify([...CTL_OPS])}, features: ${JSON.stringify([...CTL_FEATURES])}, incarnation: "inc-it", extVersion: "3.99.0" };
net.createServer((c) => {
  let buf = "";
  c.on("error", () => {});
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      c.write(JSON.stringify(req.op === "hello" ? hello : { v: 1, ok: true, state: "idle", since: 1, runs: 3, pending: false, incarnation: "inc-it" }) + "\\n");
    }
  });
}).listen(sock);
setInterval(() => {}, 1000);
`;

/** The "ssh": args are <local sock> <remote sock> <cwd> -- KEY='v'... <cmd>. Runs the command with ONLY those vars, proxies local->remote. */
const FAKE_SSH = `
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
fs.writeFileSync(process.env.PANE_SEEN, JSON.stringify(process.env));
const [local, remote, cwd, , ...rest] = process.argv.slice(2);
const cmd = rest.pop();
const env = { PATH: process.env.PATH, HOME: process.env.HOME, SEEN: process.env.SEEN };
for (const w of rest) { const i = w.indexOf("="); env[w.slice(0, i)] = w.slice(i + 1); }
fs.mkdirSync(path.dirname(local), { recursive: true });
fs.rmSync(local, { force: true });
net.createServer((c) => {
  const up = net.connect(remote);
  up.on("error", () => c.destroy());
  c.on("error", () => up.destroy());
  c.pipe(up); up.pipe(c);
}).listen(local);
const child = spawn("/bin/sh", ["-c", cmd], { cwd, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`;

let dir: string;
let home: string;
let repo: string;
let db: Db;
let ws: string;
let saved: Record<string, string | undefined>;

const ENV_KEYS = ["HOME", "SEEN", "MU_SPAWN_CTL_MS", "MU_SPAWN_LIVENESS_MS"];
const channels = () => listHostChannels(db, "dev");
const seen = (): { pid: number; cwd: string; env: Record<string, string> } =>
  JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const wtRoot = () => join(home, ".local", "state", "mu-next", "remote-worktrees", ws);

function addDevHost(piCommand = `node ${join(dir, "pishim.js")}`): { command: string } {
  addHost(db, {
    name: "dev",
    // The pane gets the tmux SERVER's env, so the fake remote's HOME is spelled in the template.
    shell: `exec env HOME=${home} SEEN=${join(dir, "seen.json")} PANE_SEEN=${join(dir, "pane-seen.json")} ${process.execPath} ${join(dir, "fakessh.js")} {local_sock} {remote_sock} {cwd} -- {env} {cmd}`,
    exec: "sh -c {cmd}",
    fetch: "true",
    repo,
    max_sessions: 1,
  });
  return { command: piCommand };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mrsi-")));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  initGitRepo(repo);
  writeFileSync(join(dir, "pishim.js"), PI_SHIM);
  writeFileSync(join(dir, "fakessh.js"), FAKE_SSH);
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = home; // the "remote" user's home: worktrees land under it
  process.env.SEEN = join(dir, "seen.json");
  process.env.MU_SPAWN_CTL_MS = "3000";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  db = openDb({ path: join(dir, "mu.db") });
  ws = `rsi${process.pid}x${Math.floor(Math.random() * 1e6)}`.slice(0, 32);
  ensureWorkstream(db, ws);
  addTask(db, { localId: "t1", workstream: ws, title: "T", impact: 50, effortDays: 1 });
});

afterEach(async () => {
  try {
    await killSession(`mu-${ws}`);
  } catch {}
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const req = (command: string) => ({
  task: "t1",
  text: "do the thing",
  // An opaque wrapper around pi names its CLI: an omitted --cli with a non-pi command is a gate.
  spawn: { name: "worker-1", workstream: ws, host: "dev", cli: "pi", worktree: true, command },
});

describeIfTmux("remote spawn (real tmux, real git, fake ssh)", () => {
  it("the transport pane's own process env carries none of the tmux server's local MU_* variables", async () => {
    const planted = LOCAL_ONLY_ENV.filter((k) => k !== "MU_STATE_DIR");
    for (const k of planted) await tmux(["set-environment", "-g", k, `foreign-${k}`]);
    try {
      const { command } = addDevHost();
      await spawnForTask(db, req(command));
      const pane = JSON.parse(readFileSync(join(dir, "pane-seen.json"), "utf8")) as Record<
        string,
        string
      >;
      expect(
        Object.keys(pane).filter((k) => (LOCAL_ONLY_ENV as readonly string[]).includes(k)),
      ).toEqual([]);
    } finally {
      for (const k of planted) await tmux(["set-environment", "-gu", k]).catch(() => {});
    }
  }, 30_000);

  it("--host --worktree --task: detached remote worktree, forwarded ctl, claim, delivery, only identity env", async () => {
    const { command } = addDevHost();
    const out = await spawnForTask(db, req(command));
    expect(out).toMatchObject({ state: "sent", replay: false });

    // The worktree: detached, at the repo's HEAD, under the remote user's state dir.
    const head = gitIn(repo, "rev-parse", "HEAD");
    const path = join(wtRoot(), "worker-1");
    expect(gitIn(path, "rev-parse", "HEAD")).toBe(head);
    expect(gitIn(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD"); // detached
    const agent = getAgent(db, "worker-1", ws);
    expect(agent).toMatchObject({ host: "dev", cwd: path, base: head });
    expect(getTask(db, "t1", ws)).toMatchObject({ ownerId: agent?.incarnation });
    expect(out.receipt).toMatchObject({ state: "sent", incarnation: "inc-it", transport: "ctl" });

    // The remote pi started IN the worktree and was given exactly the five identity vars:
    // never the local DB, state or sync dir (and not the test's own MU_* either).
    const s = seen();
    expect(s.cwd).toBe(path);
    const mu = Object.keys(s.env)
      .filter((k) => k.startsWith("MU_"))
      .sort();
    expect(mu).toEqual([
      "MU_AGENT_NAME",
      "MU_CTL_SOCK",
      "MU_MANAGED_AGENT",
      "MU_REMOTE",
      "MU_WORKSTREAM",
    ]);
    expect(s.env.MU_WORKSTREAM).toBe(ws);
    expect(s.env.MU_CTL_SOCK).toMatch(/^\/tmp\/mu-\d+\//);

    // The lease rides this pane.
    expect(channels()).toMatchObject([
      { kind: "attached", agent_id: agent?.incarnation, pane_id: agent?.paneId },
    ]);
  }, 30_000);

  it("pane death IS transport death: close kills the remote pi's group and frees the cap-1 slot", async () => {
    const { command } = addDevHost();
    await spawnForTask(db, req(command));
    const pid = seen().pid;
    expect(alive(pid)).toBe(true);
    await closeAgent(db, "worker-1", { workstream: ws });
    await until(() => !alive(pid), "the remote pi to die with its pane");
    expect(channels()).toEqual([]);
    // The next agent at cap 1 is admitted (its worktree is another name).
    const b = await spawnAgent(db, {
      name: "worker-2",
      workstream: ws,
      host: "dev",
      cli: "pi",
      command: `node ${join(dir, "pishim.js")}`,
    });
    expect(b.ctl).toBe("ok");
    expect(channels()).toHaveLength(1);
  }, 30_000);

  it("cap 1: spawn's exec and shell never overlap, and a second spawn is refused before touching the host", async () => {
    const { command } = addDevHost();
    await spawnForTask(db, req(command)); // exec + shell both ran under the one slot
    const err = await spawnAgent(db, {
      name: "worker-2",
      workstream: ws,
      host: "dev",
      cli: "pi",
      worktree: true,
      command,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostChannelBusyError);
    expect(existsSync(join(wtRoot(), "worker-2"))).toBe(false);
    expect(getAgent(db, "worker-2", ws)).toBeUndefined();
  }, 30_000);

  it("a remote pi that never answers: UNSENT, and the rollback removes ONLY its own worktree", async () => {
    process.env.MU_SPAWN_CTL_MS = "800";
    addDevHost();
    // Another worktree under the same root that this spawn did not make.
    const other = join(wtRoot(), "other");
    mkdirSync(wtRoot(), { recursive: true });
    gitIn(repo, "worktree", "add", "--detach", other, "HEAD");
    const err = await spawnForTask(db, req("sleep 30")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
    expect(getAgent(db, "worker-1", ws)).toBeUndefined();
    expect(getTask(db, "t1", ws)).toMatchObject({ ownerId: null, status: "OPEN" });
    expect(existsSync(join(wtRoot(), "worker-1"))).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(gitIn(repo, "worktree", "list")).not.toContain("worker-1");
    expect(channels()).toEqual([]);
  }, 30_000);

  it("a worktree whose remote HEAD moved is left alone by the rollback (never destroys work)", async () => {
    process.env.MU_SPAWN_CTL_MS = "1500";
    addDevHost();
    // The "remote pi" commits into its worktree, then never serves a socket.
    const mover = `sh -c 'git -c user.email=t@t -c user.name=t commit -q --allow-empty -m moved && sleep 30'`;
    const err = await spawnForTask(db, req(mover)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
    const path = join(wtRoot(), "worker-1");
    expect(existsSync(path)).toBe(true);
    expect(gitIn(path, "log", "--format=%s", "-1")).toBe("moved");
    expect(getAgent(db, "worker-1", ws)).toBeUndefined();
    expect(channels()).toEqual([]);
  }, 30_000);

  it("the exec-made worktree path survives git: a second spawn of a used name refuses instead of reusing it", async () => {
    const { command } = addDevHost();
    await spawnForTask(db, req(command));
    // A clean close removes the worktree (v_remote_collect); a leftover at the path is made by hand.
    await closeAgent(db, "worker-1", { workstream: ws });
    expect(existsSync(join(wtRoot(), "worker-1"))).toBe(false);
    gitIn(repo, "worktree", "add", "--detach", join(wtRoot(), "worker-1"));
    const err = await spawnAgent(db, {
      name: "worker-1",
      workstream: ws,
      host: "dev",
      cli: "pi",
      worktree: true,
      command,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("already exists");
    expect(getAgent(db, "worker-1", ws)).toBeUndefined();
    expect(channels()).toEqual([]);
    // The first worktree is untouched.
    expect(existsSync(join(wtRoot(), "worker-1"))).toBe(true);
  }, 30_000);
});
