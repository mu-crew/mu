import { type ChildProcess, execFileSync, spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeAgent } from "../src/agents/close.js";
import {
  getReceipt,
  requestSha,
  reserveReceipt,
  transitionReceipt,
} from "../src/agents/receipts.js";
import { spawnAgent } from "../src/agents/spawn.js";
import { spawnForTask } from "../src/agents/task-spawn.js";
import { getAgent, sendToAgent } from "../src/agents.js";
import { listCarrierJobs } from "../src/carrier-jobs.js";
import { classifyError } from "../src/cli/handle.js";
import { ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { acquireHost } from "../src/host-lifecycle.js";
import { addHost, HostHandbackError, HostProfileError, listHostChannels } from "../src/hosts.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";
import { addPlugin, closePluginSessions } from "../src/plugins/registry.js";
import { reconcile } from "../src/reconcile.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { taskIdFor } from "../src/tasks/core.js";
import { addTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { waitForEvents } from "../src/wait.js";
import { ctlAgentHooks } from "../src/wait-ctl.js";
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
let paneLive: boolean;
let runs: number;
let onWait: (() => void) | undefined;
let requests: string[];
let dispatch: ChildProcess | undefined;
let onKill: (() => void) | undefined;
const sockets = new Set<Socket>();
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
  paneLive = false;
  runs = 0;
  onWait = undefined;
  requests = [];
  dispatch = undefined;
  onKill = undefined;
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
  const muleBin = join(dir, "bin", "mule");
  writeFileSync(
    muleBin,
    `#!${process.execPath}
const {existsSync, readFileSync, writeFileSync} = require('node:fs');
const root = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const up = !existsSync(root + '/master-down');
if (args.includes('list')) {
  console.log(JSON.stringify({items: [{name: 'box', master: up}]}));
} else if (!up) {
  console.error('Open the SSH master');
  process.exitCode = 3;
} else if (args.includes('ls')) {
  const jobs = JSON.parse(readFileSync(root + '/jobs', 'utf8'));
  const prefix = args[args.indexOf('--key-prefix') + 1];
  console.log(JSON.stringify({items: jobs.filter(j => j.key.startsWith(prefix)), unreachable: []}));
} else if (args.includes('rm')) {
  const path = root + '/jobs';
  const id = args.at(-1);
  const jobs = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(jobs.filter(j => j.id !== id)));
} else process.exitCode = 2;
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "jobs"), "[]");
  vi.stubEnv("MULE_PI_BIN", muleBin);
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
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const decoder = new LineDecoder();
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of decoder.push(chunk)) {
          const req = JSON.parse(line);
          requests.push(req.op);
          if (req.op === "wait" && runs <= req.afterRuns) {
            onWait?.();
            continue;
          }
          socket.end(
            encode(
              withHello(req, {
                ...(req.op === "wait" ? { ended: "settled" } : {}),
                v: 1,
                ok: true,
                state: "idle",
                since: 1,
                runs,
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
    paneLive = true;
    opts.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
    return "%1";
  });
  setMuxForTests({
    ...tmuxBackend,
    spawnAgent: pane,
    serverIdentity: async () => FAKE_SERVER_IDENTITY,
    paneAlive: async () => paneLive,
    paneResult: async () => (paneLive ? { state: "running" } : { state: "absent" }),
    panePid: async () => dispatch?.pid,
    listPanes: async () => (paneLive ? [{ paneId: "%1", command: "pi" }] : []),
    killPane: async () => {
      paneLive = false;
      onKill?.();
    },
  });
});

afterEach(async () => {
  process.chdir(cwd);
  if (dispatch !== undefined && dispatch.exitCode === null && dispatch.signalCode === null) {
    dispatch.kill();
    await once(dispatch, "close");
  }
  setMuxForTests(undefined);
  for (const socket of sockets) socket.destroy();
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

const workstream = { workstream: "crew" };
const collect = () => collectRemoteAgent(db, { ...workstream, name: "worker-1", repo: local });
const close = () => closeAgent(db, "worker-1", workstream);
const down = () => writeFileSync(join(dir, "master-down"), "");
const up = () => unlinkSync(join(dir, "master-down"));

it.each(["launch", "ctl", "handback"])("rolls back after failed %s", async (failure) => {
  vi.stubEnv("MU_SPAWN_CTL_MS", "80");
  pane.mockImplementationOnce(async (opts) => {
    if (failure === "handback") mule.set({ faults: { "link.exec": ["ok", "human"] } });
    if (failure !== "ctl") throw new Error("local launch failed");
    paneLive = true;
    opts.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
    return "%1";
  });
  await expect(spawnAgent(db, spawn)).rejects.toThrow(
    failure === "ctl" ? /ctl|control socket/i : /local launch failed/,
  );
  expect(paneLive).toBe(false);
  expect(getAgent(db, "worker-1", "crew")).toBeUndefined();
  expect(existsSync(tree)).toBe(failure === "handback");
  if (failure === "handback") {
    expect(listRemoteRecoveries(db)).toEqual([expect.objectContaining({ cwd: tree, host: "box" })]);
  } else expect(listRemoteRecoveries(db)).toEqual([]);
});

it("keeps the tree and records recovery when ctl rollback cannot verify the jobs stopped", async () => {
  vi.stubEnv("MU_SPAWN_CTL_MS", "80");
  let saved = "";
  pane.mockImplementationOnce(async (opts) => {
    const job = {
      key: `${opts.env.MULE_PI_JOB_PREFIX}session.call`,
      id: "123abc",
      host: "box",
      state: "running",
    };
    saved = JSON.stringify([job]);
    writeFileSync(join(dir, "jobs"), saved);
    down(); // master drops: mule ls/rm fail during rollback
    paneLive = true;
    opts.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
    return "%1";
  });
  await expect(spawnAgent(db, spawn)).rejects.toThrow();
  expect(paneLive).toBe(false);
  expect(getAgent(db, "worker-1", "crew")).toBeUndefined();
  expect(existsSync(tree)).toBe(true);
  expect(readFileSync(join(dir, "jobs"), "utf8")).toBe(saved);
  expect(listRemoteRecoveries(db)).toEqual([expect.objectContaining({ cwd: tree, host: "box" })]);
  up();
  await expect(close()).resolves.toMatchObject({ recovery: { deleted: true } });
  expect(readFileSync(join(dir, "jobs"), "utf8")).toBe("[]");
  expect(existsSync(tree)).toBe(false);
});

it("refuses dirty or uncollected work without killing local pi, then collects and closes", async () => {
  await spawnAgent(db, spawn);
  writeFileSync(join(tree, "work.txt"), "new work");
  await expect(close()).rejects.toMatchObject({ reason: "dirty" });
  expect(paneLive).toBe(true);
  git(tree, "add", "work.txt");
  git(tree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "work");
  await expect(close()).rejects.toMatchObject({ reason: "uncollected" });
  expect(paneLive).toBe(true);
  const head = git(tree, "rev-parse", "HEAD");
  await expect(collect()).resolves.toMatchObject({ head, changed: true });
  await expect(close()).resolves.toMatchObject({
    deletedRow: true,
    worktree: { action: "removed" },
  });
  expect(paneLive).toBe(false);
  expect(existsSync(tree)).toBe(false);
  expect(listRemoteRecoveries(db)).toEqual([]);
});

function queueJobs() {
  const prefix = pane.mock.calls[0]?.[0].env.MULE_PI_JOB_PREFIX;
  const unrelated = { key: "someone-else.call", id: "123def", host: "box", state: "running" };
  writeFileSync(
    join(dir, "jobs"),
    JSON.stringify([
      { key: `${prefix}session.call`, id: "123abc", host: "box", state: "running" },
      unrelated,
    ]),
  );
  return () => expect(JSON.parse(readFileSync(join(dir, "jobs"), "utf8"))).toEqual([unrelated]);
}

it("waits for an in-flight local dispatch before scanning jobs during ctl rollback", async () => {
  vi.stubEnv("MU_SPAWN_CTL_MS", "80");
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  pane.mockImplementationOnce(async (opts) => {
    // The local client may be finishing its last dispatch after the pane is gone.
    dispatch = spawnChild(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      detached: true,
      stdio: "ignore",
    });
    onKill = () =>
      setTimeout(() => {
        const job = {
          key: `${opts.env.MULE_PI_JOB_PREFIX}session.call`,
          id: "123abc",
          host: "box",
          state: "running",
        };
        writeFileSync(join(dir, "jobs"), JSON.stringify([job]));
        dispatch?.kill();
        finish();
      }, 450);
    paneLive = true;
    opts.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
    return "%1";
  });
  await expect(spawnAgent(db, spawn)).rejects.toThrow(/ctl|control socket/i);
  await finished;
  expect(readFileSync(join(dir, "jobs"), "utf8")).toBe("[]");
  expect(existsSync(tree)).toBe(false);
});

it.each(["fresh", "replayed"])(
  "rolls back the implicit mule tree and jobs for a %s unsent task spawn",
  async (mode) => {
    const task = "t1";
    const text = "Do the task";
    const key = "manual:t1";
    addTask(db, { ...workstream, localId: task, title: text });
    const taskId = taskIdFor(db, task, spawn.workstream);
    if (taskId === null) throw new Error("missing task fixture");
    const closeBeforeClaim = () =>
      closeTask(db, task, { ...workstream, evidence: "completed elsewhere" });
    let onlyUnrelated: (() => void) | undefined;
    if (mode === "replayed") {
      // A worker and its journal survived, but the task closed before claim.
      const agent = await spawnAgent(db, spawn);
      onlyUnrelated = queueJobs();
      reserveReceipt(db, {
        ...workstream,
        taskId,
        attemptKey: key,
        name: agent.name,
        requestSha: requestSha({ ...spawn, text, nextFree: false }),
        msgId: "test-msg",
      });
      transitionReceipt(db, taskId, key, "pane", {
        agentId: agent.incarnation,
        paneId: agent.paneId,
      });
      closeBeforeClaim();
    } else {
      const launch = pane.getMockImplementation();
      if (launch === undefined) throw new Error("missing pane fixture");
      pane.mockImplementationOnce(async (opts) => {
        const id = await launch(opts);
        onlyUnrelated = queueJobs();
        closeBeforeClaim();
        return id;
      });
    }

    await expect(spawnForTask(db, { task, text, spawn })).rejects.toThrow(/closed/i);
    expect(requests).not.toContain("send");
    expect(getReceipt(db, taskId, key)?.state).toBe("failed");
    expect(pane).toHaveBeenCalledOnce();
    expect(paneLive).toBe(false);
    expect(getAgent(db, spawn.name, spawn.workstream)).toBeUndefined();
    expect(onlyUnrelated).toBeDefined();
    onlyUnrelated?.();
    expect(existsSync(tree)).toBe(false);
    expect(listRemoteRecoveries(db)).toEqual([]);
  },
);

it("waits for a slow local dispatch before stopping only the worker's jobs", async () => {
  await spawnAgent(db, spawn);
  dispatch = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const child = dispatch;
  let onlyUnrelated: (() => void) | undefined;
  onKill = () => {
    setTimeout(() => {
      onlyUnrelated = queueJobs();
      child.kill();
    }, 450);
  };
  await close();
  expect(onlyUnrelated).toBeDefined();
  onlyUnrelated?.();
  expect(existsSync(tree)).toBe(false);
});

it.each(["close", "rollback"])(
  "refuses recovery after %s while the local dispatch group is still exiting",
  async (mode) => {
    dispatch = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const child = dispatch;
    await once(child, "spawn");
    const pid = child.pid;
    if (pid === undefined) throw new Error("missing dispatch PID");
    if (mode === "rollback") {
      vi.stubEnv("MU_SPAWN_CTL_MS", "80");
      pane.mockImplementationOnce(async (opts) => {
        paneLive = true;
        opts.onPaneCreated?.("%1", FAKE_SERVER_IDENTITY);
        return "%1";
      });
      await expect(spawnAgent(db, spawn)).rejects.toThrow(/ctl|control socket/i);
    } else {
      await spawnAgent(db, spawn);
    }
    const onlyUnrelated = queueJobs();
    const saved = readFileSync(join(dir, "jobs"), "utf8");
    const expectRetry = async () => {
      const err: unknown = await close().catch((err: unknown) => err);
      expect(classifyError(err)).toEqual({ label: "conflict", exitCode: 4 });
      expect(err).toMatchObject({
        message: /still exiting.*retry/i,
        remaining: expect.arrayContaining([-pid]),
      });
      expect(paneLive).toBe(false);
      expect(existsSync(tree)).toBe(true);
      expect(readFileSync(join(dir, "jobs"), "utf8")).toBe(saved);
    };
    if (mode === "close") await expectRetry();
    expect(getAgent(db, spawn.name, spawn.workstream)).toBeUndefined();
    await expectRetry();
    const exited = once(child, "exit");
    child.kill();
    await exited;
    await expect(close()).resolves.toMatchObject({ recovery: { deleted: true } });
    onlyUnrelated();
    expect(existsSync(tree)).toBe(false);
  },
);

it("hands back close on a dropped master and later stops the jobs from recovery", async () => {
  await spawnAgent(db, spawn);
  const onlyUnrelated = queueJobs();
  const savedJobs = readFileSync(join(dir, "jobs"), "utf8");
  down();
  await expect(close()).rejects.toBeInstanceOf(HostHandbackError);
  expect(paneLive).toBe(false);
  expect(getAgent(db, "worker-1", "crew")).toBeUndefined();
  expect(readFileSync(join(dir, "jobs"), "utf8")).toBe(savedJobs);
  expect(existsSync(tree)).toBe(true);
  expect(listRemoteRecoveries(db)).toEqual([expect.objectContaining({ cwd: tree })]);
  up();
  await expect(close()).resolves.toMatchObject({ recovery: { deleted: true } });
  onlyUnrelated();
  expect(existsSync(tree)).toBe(false);
});

it("hands back a wait mid-turn without reaping the local worker, then observes the same run", async () => {
  await spawnAgent(db, spawn);
  const row = getAgent(db, "worker-1", "crew");
  const wait = () =>
    waitForEvents(db, [{ kind: "agent", id: "worker-1", workstream: "crew", afterRuns: 0 }], {
      ...ctlAgentHooks(db),
      callers: [],
      eventScope: "refs",
      stuckAfterMs: 0,
      timeoutMs: 1000,
      pollMs: 30,
    });
  onWait = down;
  await expect(wait()).rejects.toBeInstanceOf(HostHandbackError);
  await expect(reconcile(db, workstream)).resolves.toMatchObject({ prunedGhosts: 0 });
  expect(getAgent(db, "worker-1", "crew")).toEqual(row);
  expect(listRemoteRecoveries(db)).toEqual([]);
  up();
  runs = 1;
  await expect(wait()).resolves.toMatchObject({ event: { kind: "settled" } });
});

it.each([false, true])(
  "refuses prompt delivery before writing to ctl (fresh=%s)",
  async (fresh) => {
    await spawnAgent(db, spawn);
    down();
    const send = () => sendToAgent(db, "worker-1", "work", { ...workstream, fresh, force: true });
    const op = fresh ? "fresh" : "send";
    await expect(send()).rejects.toMatchObject({ handback: true, message: /SSH master/ });
    expect(requests).not.toContain(op);
    up();
    await expect(send()).resolves.toMatchObject({ transport: "ctl" });
    expect(requests).toContain(op);
  },
);

it.each(["template", "other plugin", "provider", "other harness", "orchestrator"])(
  "refuses %s before a tree, pane or reservation",
  async (kind) => {
    let req = spawn;
    const error = HostProfileError;
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
