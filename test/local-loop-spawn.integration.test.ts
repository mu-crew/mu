import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawnAgent } from "../src/agents/spawn.js";
import { getAgent } from "../src/agents.js";
import { listCarrierJobs } from "../src/carrier-jobs.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { acquireHost } from "../src/host-lifecycle.js";
import {
  addHost,
  HostProfileError,
  HostSpawnUnsupportedError,
  listHostChannels,
} from "../src/hosts.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import { withHello } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";
import { type FakePlugin, fakePlugin, linkSeam, providerSeams } from "./_plugin.js";
import { FAKE_SERVER_IDENTITY } from "./_verbs-mock.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000 }).trim();

let dir: string;
let local: string;
let remote: string;
let tree: string;
let cwd: string;
let db: Db;
let server: Server | undefined;
let pane: ReturnType<typeof vi.fn<typeof tmuxBackend.spawnAgent>>;
let mule: FakePlugin;
const spawn = { name: "worker-1", workstream: "crew", mule: "box", command: "pi" };

beforeEach(async () => {
  cwd = process.cwd();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mlp-")));
  local = join(dir, "local");
  remote = join(dir, "remote repo");
  tree = join(dir, ".local/state/mu-next/remote-worktrees/crew/worker-1");
  mkdirSync(local);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("MU_SPAWN_LIVENESS_MS", "0");
  vi.stubEnv("MU_SPAWN_CTL_MS", "2000");
  vi.stubEnv("MU_STATE_DIR", join(dir, "state"));
  vi.stubEnv("MU_PI_CHANNEL", "hooks");
  server = undefined;
  db = openDb({ path: join(dir, "mu.db") });
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
  git(remote, "config", "user.useConfigOnly", "true");
  process.chdir(local);
  mule = fakePlugin(dir, { seams: linkSeam({ fetch: false, push: true }) }, "mule");
  await addPlugin(db, "mule", mule.argv);
  addHost(db, {
    name: "box",
    plugin: "mule",
    repo: remote,
    fetch: "git fetch -q {cwd} HEAD",
    max_sessions: 1,
  });
  pane = vi.fn(async (opts) => {
    expect(existsSync(tree)).toBe(true);
    expect(listHostChannels(db, "box")).toEqual([]);
    const sock = ctlSocketPath("crew", "worker-1", dir);
    expect(opts.env?.MU_CTL_SOCK).toBe(sock);
    server = createServer((socket) => {
      const decoder = new LineDecoder();
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of decoder.push(chunk)) {
          socket.end(
            encode(
              withHello(JSON.parse(line), {
                v: 1,
                ok: true,
                state: "idle",
                since: 1,
                runs: 0,
                pending: false,
              }),
            ),
          );
        }
      });
    });
    const listener = server;
    await new Promise<void>((resolve, reject) =>
      listener.once("error", reject).listen(sock, resolve),
    );
    opts.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
    return "%1";
  });
  setMuxForTests({
    ...tmuxBackend,
    spawnAgent: pane,
    serverIdentity: async () => FAKE_SERVER_IDENTITY,
  });
});

afterEach(async () => {
  process.chdir(cwd);
  setMuxForTests(undefined);
  if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
  await closePluginSessions();
  db.close();
  vi.unstubAllEnvs();
  rmFixtureDir(dir);
});

it("starts local pi on ctl after preparing a remote tree and collects its commit", async () => {
  const base = git(local, "rev-parse", "HEAD");
  const agent = await spawnAgent(db, spawn);
  expect(agent).toMatchObject({
    ctl: "ok",
    channel: "ctl",
    host: "box",
    cwd: tree,
    base,
    repo: remote,
  });
  expect(getAgent(db, "worker-1", "crew")).toMatchObject({
    host: "box",
    cwd: tree,
    base,
    repo: remote,
  });
  expect(pane).toHaveBeenCalledOnce();
  expect(pane).toHaveBeenCalledWith(
    expect.objectContaining({
      command: `pi --mule 'box:${tree}'`,
      cwd: local,
      env: expect.objectContaining({
        MU_DB_PATH: db.name,
        MU_STATE_DIR: join(dir, "state"),
        MU_PI_CHANNEL: "",
      }),
    }),
  );
  expect(pane.mock.calls[0]?.[0].env?.MU_REMOTE).not.toBe("1");
  expect(mule.calls().filter(({ method }) => /^(link|job)\./.test(method))).toEqual([
    expect.objectContaining({
      method: "link.exec",
      params: expect.objectContaining({ target: { host: { name: "box" } } }),
    }),
  ]);
  expect(listHostChannels(db, "box")).toEqual([]);
  expect(listCarrierJobs(db)).toEqual([]);
  expect(git(tree, "rev-parse", "HEAD")).toBe(base);
  git(
    tree,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "work",
    "--allow-empty",
  );
  const head = git(tree, "rev-parse", "HEAD");
  expect(
    await collectRemoteAgent(db, { workstream: "crew", name: "worker-1", repo: local }),
  ).toMatchObject({ head, changed: true });
  expect(git(local, "rev-parse", "refs/mu/collect/crew/worker-1")).toBe(head);
  expect(getAgent(db, "worker-1", "crew")?.collectedHead).toBe(head);
});

it.each(["template", "other plugin", "provider", "herdr", "other harness", "orchestrator"])(
  "refuses %s before a tree, pane or reservation",
  async (kind) => {
    let req = spawn;
    let error: typeof HostProfileError | typeof HostSpawnUnsupportedError = HostProfileError;
    let other: FakePlugin | undefined;
    if (kind === "template") {
      addHost(db, {
        name: "plain",
        repo: remote,
        shell: "true",
        exec: "true",
        fetch: "true",
        max_sessions: 1,
      });
      req = { ...req, mule: "plain" };
    } else if (kind === "other plugin" || kind === "provider") {
      other = fakePlugin(dir, { seams: kind === "provider" ? providerSeams() : linkSeam() });
      await addPlugin(db, "fake", other.argv);
      if (kind === "provider")
        await acquireHost(db, { name: "plain", provider: "fake", params: {}, repo: remote });
      else addHost(db, { name: "plain", repo: remote, plugin: "fake", max_sessions: 1 });
      req = { ...req, mule: "plain" };
    } else if (kind === "herdr") {
      error = HostSpawnUnsupportedError;
      setMuxForTests({
        ...tmuxBackend,
        name: kind,
        spawnAgent: pane,
        runsShellCommand: false,
        carrierViews: false,
      });
    }
    const calls = mule.calls();
    const otherCalls = other?.calls();
    await expect(
      spawnAgent(db, {
        ...req,
        ...(kind === "other harness" ? { cli: "claude", command: "claude" } : {}),
        ...(kind === "orchestrator" ? { orchestrator: true } : {}),
      }),
    ).rejects.toBeInstanceOf(error);
    expect(pane).not.toHaveBeenCalled();
    expect(mule.calls()).toEqual(calls);
    expect(other?.calls()).toEqual(otherCalls);
    expect(getAgent(db, "worker-1", "crew")).toBeUndefined();
    expect(listCarrierJobs(db)).toEqual([]);
    expect(listHostChannels(db, req.mule)).toEqual([]);
    expect(existsSync(tree)).toBe(false);
  },
);
