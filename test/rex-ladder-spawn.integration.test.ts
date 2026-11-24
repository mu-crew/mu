// Real Rex and an isolated zsh rc. The stand-ins observe only fixture inputs;
// no live mule connection, SSH host, credentials, or model calls are needed.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnAgent } from "../src/agents/spawn.js";
import { getAgent } from "../src/agents.js";
import { ctlSocketPath, remoteCtlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { addHost } from "../src/hosts.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { shellQuote } from "../src/shell-quote.js";
import { helloReply } from "./_ctl-ext.js";
import { pollUntil } from "./_env.js";
import { freshWorkstream } from "./_fixture.js";
import { rmFixtureDir } from "./_fs.js";
import { fakePlugin, linkSeam } from "./_plugin.js";
import { startTestRex } from "./_server-registry.js";

const available =
  existsSync("/bin/zsh") &&
  spawnSync("rex", ["version"], {
    stdio: "ignore",
    timeout: 2000,
    killSignal: "SIGKILL",
  }).status === 0;

// The transport double records the filled template's socket arguments before
// starting the pi double, which listens at the template's local forward path
// (the fixture does not test SSH itself). For a local loop, pi binds its env path.
const shim = `
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const [mode, ...args] = process.argv.slice(2);
const seen = Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]));
seen.PATH = seen.PATH?.split(path.delimiter)[0];
fs.writeFileSync(path.join(__dirname, mode + '.json'), JSON.stringify({ args, seen, cwd: process.cwd() }));
if (mode === 'pi') {
  const sock = args[0]?.startsWith('/') ? args[0] : seen.MU_CTL_SOCK;
  fs.mkdirSync(path.dirname(sock), {recursive: true});
  net.createServer(c => {
    c.setEncoding('utf8');
    let buf = '';
    c.on('error', () => {});
    c.on('data', chunk => {
      buf += chunk;
      if (!buf.includes('\\n')) return;
      const req = JSON.parse(buf.trim());
      c.end(JSON.stringify(req.op === 'hello' ? hello : {
        v: 1, ok: true, state: 'idle', since: 1, runs: 0, pending: false, incarnation: hello.incarnation,
      }) + '\\n');
    });
  }).listen(sock);
  // A backstop if the pane or test server is terminated ungracefully.
  setTimeout(() => process.exit(1), 15_000).unref();
}
`;

describe.skipIf(!available)("ladder spawn through a real Rex shell rc", () => {
  let dir: string;
  let prevCwd: string;
  let db: Db | undefined;
  let rex: ReturnType<typeof startTestRex> | undefined;
  let command: string;
  let state: string;
  let ws: string;
  const name = "worker-1";
  const read = (mode: "pi" | "transport") =>
    JSON.parse(readFileSync(join(dir, `${mode}.json`), "utf8"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, timeout: 5000, killSignal: "SIGKILL" });

  beforeEach(async () => {
    prevCwd = process.cwd();
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mu-rex-ladder space-")));
    state = join(dir, "state 'local'");
    ws = freshWorkstream("rex");
    const hostile = {
      MU_DB_PATH: join(dir, "wrong.db"),
      MU_STATE_DIR: join(dir, "wrong-state"),
      MU_SYNC_DIR: join(dir, "wrong-sync"),
      MU_CTL_SOCK: join(dir, "wrong.sock"),
      MU_WORKSTREAM: "wrong-workstream",
      MU_AGENT_NAME: "wrong-worker",
      MU_MANAGED_AGENT: "0",
      MU_AGENT_CLI: "wrong-cli",
      MU_HOST: "wrong-host",
      MU_REMOTE: "1",
      MU_ORCHESTRATOR: "1",
      MU_REMOTE_KEY: "wrong-key",
      MU_PI_CHANNEL: "hooks",
      MU_MUX: "tmux",
      MU_REX_SERVER: `unix://${join(dir, "wrong-rex.sock")}`,
      PI_CODING_AGENT_SESSION_DIR: join(dir, "wrong-pi-sessions"),
    };
    const credentials = { SSH_AUTH_SOCK: join(dir, "login.sock"), LOGIN_MARKER: "from-rc" };
    writeFileSync(
      join(dir, ".zshrc"),
      [
        ...Object.entries({ ...hostile, ...credentials }).map(
          ([key, value]) => `export ${key}=${shellQuote(value)}`,
        ),
        `export PATH=${shellQuote(join(dir, "bin"))}:"$PATH"`,
      ].join("\n"),
    );
    const keys = [...Object.keys(hostile), ...Object.keys(credentials), "MU_AGENT", "PATH"];
    const file = join(dir, "fixture.cjs");
    writeFileSync(
      file,
      `const keys = ${JSON.stringify(keys)};\nconst hello = ${JSON.stringify(helloReply())};\n${shim}`,
    );
    command = `${shellQuote(process.execPath)} ${shellQuote(file)}`;
    writeFileSync(join(dir, "init.lua"), "");
    vi.stubEnv("HOME", dir);
    vi.stubEnv("ZDOTDIR", dir);
    vi.stubEnv("REX_CONFIG", join(dir, "init.lua"));
    vi.stubEnv("SHELL", "/bin/zsh");
    vi.stubEnv("MU_AGENT", "inherited-agent");
    rex = startTestRex();
    const { address } = rex;
    await pollUntil(
      () =>
        spawnSync(
          "rex",
          ["-S", address, "--autostart=false", "api", "call", "server.version", "{}"],
          {
            stdio: "ignore",
            timeout: 1000,
            killSignal: "SIGKILL",
          },
        ).status === 0,
      { attempts: 60, description: "private Rex server did not start" },
    );
    vi.stubEnv("MU_AGENT", undefined);
    vi.stubEnv("MU_MUX", "rex");
    vi.stubEnv("MU_REX_SERVER", address);
    vi.stubEnv("MU_STATE_DIR", state);
    vi.stubEnv("MU_SPAWN_LIVENESS_MS", "0");
    vi.stubEnv("MU_SPAWN_CTL_MS", "2000");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    db = openDb({ path: join(dir, "local db.sqlite") });
  }, 12_000);

  afterEach(async () => {
    process.chdir(prevCwd);
    try {
      await rex?.stop();
    } finally {
      rex = undefined;
      await closePluginSessions();
      db?.close();
      db = undefined;
      vi.unstubAllEnvs();
      rmFixtureDir(dir);
    }
  });

  it("runs --mule with the local DB and ctl, and the chosen workspace as one argument", async () => {
    if (!db) throw new Error("missing test DB");
    const local = join(dir, "local");
    const remote = join(dir, "remote repo");
    mkdirSync(local);
    git(local, "init", "-q");
    git(
      local,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base",
      "--allow-empty",
    );
    git(dir, "clone", "-q", local, remote);
    const mule = fakePlugin(dir, { seams: linkSeam({ push: true }) }, "mule");
    await addPlugin(db, "mule", mule.argv);
    addHost(db, { name: "box", plugin: "mule", repo: remote, max_sessions: 1 });
    process.chdir(local);

    const agent = await spawnAgent(db, {
      name,
      workstream: ws,
      mule: "box",
      cli: "pi",
      piSessionDir: join(dir, "pi-sessions"),
      command: `exec ${command} pi`,
    });
    const tree = join(dir, ".local", "state", "mu-next", "remote-worktrees", ws, name);
    expect(read("pi")).toMatchObject({
      args: ["--mule", `box:${tree}`],
      cwd: local,
      seen: {
        LOGIN_MARKER: "from-rc",
        SSH_AUTH_SOCK: join(dir, "login.sock"),
        PATH: join(dir, "bin"),
        MU_DB_PATH: db.name,
        MU_STATE_DIR: state,
        MU_SYNC_DIR: "",
        PI_CODING_AGENT_SESSION_DIR: join(dir, "pi-sessions"),
        MU_CTL_SOCK: ctlSocketPath(ws, name, dirname(db.name)),
        MU_WORKSTREAM: ws,
        MU_AGENT_NAME: name,
        MU_MANAGED_AGENT: "1",
        MU_AGENT_CLI: "pi",
        MU_HOST: "",
        MU_AGENT: "",
        MU_REMOTE: "",
        MU_ORCHESTRATOR: "",
        MU_REMOTE_KEY: "",
        MU_PI_CHANNEL: "",
        MU_MUX: "rex",
        MU_REX_SERVER: rex?.address,
      },
    });
    expect(agent).toMatchObject({ ctl: "ok", channel: "ctl", host: "box", cwd: tree });
    expect(getAgent(db, name, ws)).toMatchObject({ hostTransport: "local-loop" });
  });

  it.skipIf(!existsSync("/bin/tcsh"))("refuses tcsh before launching a worker", async () => {
    if (!db) throw new Error("missing test DB");
    vi.stubEnv("SHELL", "/bin/tcsh");

    await expect(
      spawnAgent(db, { name, workstream: ws, cli: "pi", command: `exec ${command} pi` }),
    ).rejects.toThrow(/Rex.*\/bin\/tcsh.*SHELL=\/bin\/sh/);
    expect(getAgent(db, name, ws)).toBeUndefined();
    expect(existsSync(join(dir, "pi.json"))).toBe(false);
  });

  it("runs a session template with clean local routing and the selected remote identity and sockets", async () => {
    if (!db) throw new Error("missing test DB");
    addHost(db, {
      name: "box",
      repo: dir,
      exec: "sh -c {cmd}",
      fetch: "true",
      max_sessions: 1,
      shell: `${command} transport {local_sock} {remote_sock} {cwd} && cd {cwd} && exec env {env} /bin/sh -c {cmd} pi-fixture {local_sock}`,
    });
    const agent = await spawnAgent(db, {
      name,
      workstream: ws,
      host: "box",
      cli: "pi",
      command: `exec ${command} pi "$1"`,
    });
    const local = ctlSocketPath(ws, name, dirname(db.name));
    const remote = remoteCtlSocketPath(ws, name, process.getuid?.() ?? 0);
    const transport = read("transport");
    expect(transport.args).toEqual([local, remote, dir]);
    expect(transport.seen).toMatchObject({
      LOGIN_MARKER: "from-rc",
      SSH_AUTH_SOCK: join(dir, "login.sock"),
      PATH: join(dir, "bin"),
      PI_CODING_AGENT_SESSION_DIR: null,
    });
    expect(
      Object.entries(transport.seen).filter(([k, v]) => k.startsWith("MU_") && v !== null),
    ).toEqual([]);
    expect(read("pi")).toMatchObject({
      cwd: dir,
      seen: {
        MU_DB_PATH: null,
        MU_STATE_DIR: null,
        PI_CODING_AGENT_SESSION_DIR: null,
        MU_HOST: null,
        MU_CTL_SOCK: remote,
        MU_REMOTE: "1",
        MU_MANAGED_AGENT: "1",
        MU_WORKSTREAM: ws,
        MU_AGENT_NAME: name,
      },
    });
    expect(agent).toMatchObject({ ctl: "ok", channel: "ctl", host: "box" });
  });
});
