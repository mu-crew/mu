// `agent spawn --host` (v_remote_spawn, part A): the PANE is the transport.
// The local pane runs the profile's filled `shell` template (which starts the
// remote pi and forwards its ctl socket to the derived local path); pane death
// is agent death. Fake sh templates stand in for ssh (the exec template only
// records what it was asked and answers canned lines), the mux is the fake
// tmux harness, and a real unix-socket server stands in for the extension.
// No real host, no real git: test/remote-spawn.integration.test.ts has those.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rollbackSpawn } from "../src/agents/spawn.js";
import { respawnCommand } from "../src/agents/transport.js";
import {
  AgentCtlUnreachableError,
  AgentDiedOnSpawnError,
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  SpawnReceiptConflictError,
  setCommandResolverForTests,
  spawnAgent,
  spawnForTask,
} from "../src/agents.js";
import { ctlProbe } from "../src/ctl/client.js";
import { ctlSocketPath, MAX_SOCK_PATH, remoteCtlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  HostChannelBusyError,
  HostNotFoundError,
  HostProfileError,
  HostSpawnUnsupportedError,
  listHostChannels,
} from "../src/hosts.js";
import { listLogs } from "../src/logs.js";
import { reconcile } from "../src/reconcile.js";
import { LOCAL_ONLY_ENV, RemotePrepareError } from "../src/remote-agent.js";
import { stateSnapshot } from "../src/state.js";
import { claimTask } from "../src/tasks/claim.js";
import { addTask } from "../src/tasks/edit.js";
import { getTask } from "../src/tasks.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream, teardownWorkstream, workstreamRevision } from "../src/workstream.js";
import { helloReply, INC, withHello } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson, runCliWire } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const SHA = "a".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";

let dir: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let servers: Server[];
let execLog: string;
let modeFile: string;
let extensionOn: boolean;
/** The channels held at the moment a pane was created. */
let atPane: string[][] | undefined;
let saved: Record<string, string | undefined>;

const ENV_KEYS = [
  "MU_SPAWN_CTL_MS",
  "MU_SPAWN_LIVENESS_MS",
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
];

/** What the fake exec template was asked, in order (the remote command text). */
const execCalls = (): string[] =>
  readdirSync(execLog)
    .sort((a, b) => Number(a) - Number(b))
    .map((f) => readFileSync(join(execLog, f), "utf8"));
const setMode = (m: string): void => writeFileSync(modeFile, m);
const channels = () => listHostChannels(db, "dev");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrs-"));
  db = openDb({ path: join(dir, "mu.db") });
  execLog = join(dir, "execlog");
  modeFile = join(dir, "mode");
  mkdirSync(execLog);
  servers = [];
  extensionOn = true;
  atPane = undefined;
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_SPAWN_CTL_MS = "300";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  // The local machine's own paths: none of them may reach the remote side.
  process.env.MU_DB_PATH = join(dir, "mu.db");
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  setSleepForTests(async () => {});
  // The remote binary is not on the LOCAL PATH: the pre-flight check must be skipped.
  setCommandResolverForTests(async (c) => ({
    ok: false,
    binary: c.trim().split(/\s+/)[0] ?? c,
    envVarChecked: "MU_PI_COMMAND",
  }));
  ensureWorkstream(db, "auth");
  addTask(db, { localId: "t1", workstream: "auth", title: "T", impact: 50, effortDays: 1 });
  const fakeExec = join(dir, "fake-exec.sh");
  writeFileSync(
    fakeExec,
    `#!/bin/sh
n=$(ls '${execLog}' | wc -l)
printf '%s' "$1" > '${execLog}'/$n
mode=$(cat '${modeFile}' 2>/dev/null || echo ok)
case "$1" in
  *MU_STATE*) echo "MU_STATE clean ${SHA}" ;;
  *MU_RM*) echo "MU_RM removed" ;;
  *'worktree add'*)
    [ "$mode" = addfail ] && { echo boom >&2; exit 3; }
    [ "$mode" = noise ] && { echo garbage; exit 0; }
    echo "MU_WT ${SHA} ${WT}" ;;
  *'worktree remove'*) exit 0 ;;
  *MU_CWD*) [ "$mode" = cwdfail ] && { echo "no such dir" >&2; exit 1; }; echo "MU_CWD /srv/repo/sub" ;;
esac
`,
  );
  chmodSync(fakeExec, 0o755);
  addHost(db, {
    name: "dev",
    shell: "echo L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `/bin/sh ${fakeExec} {cmd}`,
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: 1,
  });
  // The same templates with no cap: a full host's own admission refusal cannot mask a rollback guard.
  addHost(db, {
    name: "free",
    shell: "echo L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `/bin/sh ${fakeExec} {cmd}`,
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: null,
  });
  state = freshMockState();
  installTmux();
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  resetCommandResolverForTests();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function serveExtension(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string };
        sock.end(
          encode(
            withHello(
              req,
              { v: 1, ok: true, state: "idle", since: 1, runs: 7, pending: false },
              helloReply(),
            ),
          ),
        );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

const isPaneCall = (a: readonly string[]): boolean =>
  ["new-session", "new-window", "split-window"].includes(a[0] ?? "");

/** tmux whose pane creation snapshots the channels and "forwards" the socket (as the template would). */
function installTmux(): void {
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    const res = await fake(args);
    if (isPaneCall(args)) {
      atPane = channels().map((c) => [c.holder, c.kind]);
      // The window is named after the agent.
      const name = args[args.indexOf("-n") + 1];
      if (extensionOn && name !== undefined) await serveExtension(ctlSocketPath("auth", name, dir));
    }
    return res;
  });
}

const paneCall = (): readonly string[] => {
  const c = mux.calls.find(isPaneCall);
  if (c === undefined) throw new Error("no pane was created");
  return c;
};
/** The command the pane was created with: `exec env -u ... /bin/sh -c '<filled template>'`. */
const paneCommand = (): string => paneCall().at(-1) ?? "";
/** The filled shell template itself, un-quoted from the `sh -c` word. */
const filled = (): string =>
  execFileSync(
    "/bin/sh",
    ["-c", `f() { printf %s "$3"; }; f ${paneCommand().slice(paneCommand().indexOf("/bin/sh"))}`],
    {
      encoding: "utf8",
    },
  );

const spawn = (over: Partial<Parameters<typeof spawnAgent>[1]> = {}) =>
  spawnAgent(db, { name: "worker-1", workstream: "auth", host: "dev", ...over });

describe("refusals before any effect", () => {
  it("herdr cannot run a host's shell template: one line naming the gap, nothing touched", async () => {
    mux.restore();
    mux = installMux("herdr", []);
    const err = await spawn().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostSpawnUnsupportedError);
    expect((err as Error).message).toMatch(/herdr/);
    expect((err as Error).message).not.toContain("\n");
    expect(mux.calls).toEqual([]);
    expect(execCalls()).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(channels()).toEqual([]);
  });

  it("an unknown host profile is a not-found, with nothing created", async () => {
    await expect(spawn({ host: "nope" })).rejects.toBeInstanceOf(HostNotFoundError);
    expect(mux.calls).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });

  it("--root names a LOCAL repo: refused with --host", async () => {
    const err = await spawn({ worktree: true, root: "/x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostProfileError);
    expect((err as Error).message).toMatch(/--root/);
    expect(execCalls()).toEqual([]);
    expect(channels()).toEqual([]);
  });
});

describe("the pane is the transport", () => {
  it("runs the filled shell template; the remote gets the five identity vars and never a local path", async () => {
    const a = await spawn({ cwd: "~/proj" });
    // The tmux server's own MU_* (another agent's DB, sync dir, ctl socket, identity) is unset for the transport.
    expect(paneCommand().startsWith("exec env ")).toBe(true);
    for (const k of LOCAL_ONLY_ENV) expect(paneCommand()).toContain(`-u ${k} `);
    const local = ctlSocketPath("auth", "worker-1", dir);
    const remote = remoteCtlSocketPath("auth", "worker-1", process.getuid?.() ?? 0);
    const cmd = filled();
    expect(cmd).toContain(`L='${local}'`);
    expect(cmd).toContain(`R='${remote}'`);
    // The cwd is the one the exec step resolved on the remote, not what was typed.
    expect(cmd).toContain("C='/srv/repo/sub'");
    for (const kv of [
      "MU_MANAGED_AGENT='1'",
      "MU_AGENT_NAME='worker-1'",
      "MU_WORKSTREAM='auth'",
      `MU_CTL_SOCK='${remote}'`,
      "MU_REMOTE='1'",
    ]) {
      expect(cmd).toContain(kv);
    }
    expect(cmd).toContain("-- 'pi'");
    // Neither the template text nor the pane's env carries the local DB, state or sync dir.
    const all = mux.calls
      .map((c) => c.join(" "))
      .join("\n")
      .replaceAll(local, "")
      .replace(/ -u MU_[A-Z_]+/g, ""); // the `env -u` words only UNSET them
    for (const k of ["MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR", dir]) {
      expect(all).not.toContain(k);
    }
    // The LOCAL pane gets no cwd: the remote path is never the local mux's.
    expect(paneCall()).not.toContain("-c");
    expect(a).toMatchObject({ host: "dev", cwd: "/srv/repo/sub", base: null, ctl: "ok" });
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({ host: "dev", cwd: "/srv/repo/sub" });
  });

  it("without --cwd the remote cwd is the profile's repo, resolved remotely", async () => {
    await spawn();
    const [only, ...rest] = execCalls();
    expect(rest).toEqual([]);
    expect(only).toContain("MU_CWD");
    expect(only).toContain("/srv/repo");
  });

  it("--worktree: one remote exec makes a detached worktree and records host, path and base", async () => {
    const a = await spawn({ worktree: true, from: "main" });
    const [only, ...rest] = execCalls();
    expect(rest).toEqual([]);
    expect(only).toContain("worktree add --detach");
    expect(only).toContain("remote-worktrees/auth/worker-1");
    expect(only).toContain("main^{commit}");
    expect(only).toContain("/srv/repo");
    expect(a).toMatchObject({ host: "dev", cwd: WT, base: SHA });
    expect(getAgent(db, "worker-1", "auth")).toMatchObject({ host: "dev", cwd: WT, base: SHA });
    // The remote path is not a local worktree: the local registry has no row for it.
    expect(db.prepare("SELECT COUNT(*) AS c FROM worktrees").get()).toEqual({ c: 0 });
    expect(filled()).toContain(`C='${WT}'`);
  });

  it("quotes the agent's remote command as one word, and the cwd survives a real sh (tilde, apostrophe, space)", async () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "it's here"), { recursive: true });
    await spawn({ command: "pi --approve 'x y'", cwd: "~/it's here" });
    expect(filled()).toContain(`-- 'pi --approve '"'"'x y'"'"''`);
    expect(getAgent(db, "worker-1", "auth")?.command).toBe("pi --approve 'x y'");
    // The logged remote command, run by a real sh, resolves that very directory.
    const out = execFileSync("/bin/sh", ["-c", execCalls()[0] ?? ""], {
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "" },
    });
    expect(out.trim()).toBe(`MU_CWD ${join(home, "it's here")}`);
  });

  it("the row keeps the user's command (not the filled template), so a respawn keeps --host", async () => {
    const a = await spawn({ worktree: true, command: "pi --approve" });
    const row = getAgent(db, a.name, "auth");
    expect(row?.command).toBe("pi --approve");
    expect(row && respawnCommand(row)).toContain("--host dev");
    expect(row && respawnCommand(row)).toContain("--worktree");
    const plain = insertAgent(db, {
      name: "loc-1",
      workstream: "auth",
      paneId: "%90",
      command: "pi",
      commandSource: "cli-key",
    });
    expect(respawnCommand(plain)).not.toContain("--host");
  });
});

describe("mu state reads the registry, not notes", () => {
  it("remote workers are the agents with a host: agent, host, remote cwd, base", async () => {
    insertAgent(db, { name: "loc-1", workstream: "auth", paneId: "%90" });
    await spawn({ worktree: true });
    const snap = await stateSnapshot(db, { workstreams: ["auth"], caller: null });
    expect(
      snap.workstreams[0]?.agents
        ?.filter((a) => a.host !== null)
        .map((a) => ({ name: a.name, host: a.host, cwd: a.cwd, base: a.base })),
    ).toEqual([{ name: "worker-1", host: "dev", cwd: WT, base: SHA }]);
  });
});

describe("the channel lease", () => {
  it("is reserved BEFORE the pane opens (cap 1 holds), bound to the agent's id and pane after", async () => {
    const a = await spawn({ worktree: true });
    // At pane creation the spawn already held the single slot, and its exec had finished.
    expect(atPane).toEqual([["spawn:auth/worker-1", "transient"]]);
    expect(channels()).toMatchObject([
      {
        holder: "spawn:auth/worker-1",
        kind: "attached",
        agent_id: a.incarnation,
        pane_id: a.paneId,
      },
    ]);
  });

  it("a second spawn at the cap is refused naming the holder, and creates no remote worktree", async () => {
    await spawn({ worktree: true });
    const before = execCalls().length;
    const err = await spawn({ name: "worker-2", worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostChannelBusyError);
    expect((err as Error).message).toContain("spawn:auth/worker-1");
    expect(execCalls().length).toBe(before);
    expect(getAgent(db, "worker-2", "auth")).toBeUndefined();
    expect(channels()).toHaveLength(1);
  });

  it("agent close frees it (pane death is transport death)", async () => {
    await spawn();
    expect(channels()).toHaveLength(1);
    await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(channels()).toEqual([]);
    // ...and the next spawn at cap 1 is admitted.
    await spawn({ name: "worker-2" });
    expect(channels()).toHaveLength(1);
  });

  it("closing a remote agent never touches a LOCAL worktree row that shares its path string", async () => {
    const { registerWorktree, getWorktreeAt } = await import("../src/worktree.js");
    const a = await spawn({ worktree: true });
    registerWorktree(db, {
      path: WT,
      agent: "worker-1",
      workstream: "auth",
      root: "/nowhere",
      base: SHA,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const r = await closeAgent(db, a.name, { workstream: "auth" }).catch((e: unknown) => e);
    expect(r).not.toBeInstanceOf(Error);
    expect(getWorktreeAt(db, WT)).toBeDefined();
  });

  it("workstream teardown (its own row DELETE) frees it", async () => {
    const a = await spawn();
    expect(channels()).toHaveLength(1);
    // The fake tmux has no kill-session: the session kill takes its panes with it.
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) => {
      if (args[0] !== "kill-session") return fake(args);
      state.panes.delete(a.paneId);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await teardownWorkstream(db, {
      workstream: "auth",
      ifRevision: workstreamRevision(db, "auth"),
    });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(channels()).toEqual([]);
  });

  it("reconcile pruning a vanished pane frees it", async () => {
    const a = await spawn();
    state.panes.delete(a.paneId);
    await reconcile(db, { workstream: "auth" });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(channels()).toEqual([]);
  });

  it("a pane that died on its own is reclaimed by the next admission (liveness probe)", async () => {
    const a = await spawn({ cwd: "/srv/repo" });
    state.panes.delete(a.paneId); // the template's process is gone; the row is not yet reaped
    await spawn({ name: "worker-2" });
    expect(channels().map((c) => c.holder)).toEqual(["spawn:auth/worker-2"]);
  });
});

describe("failure rolls back only what this spawn made", () => {
  it("a failed exec: no row, no pane, the slot is free again", async () => {
    setMode("addfail");
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemotePrepareError);
    expect((err as Error).message).toContain("exit 3");
    expect((err as Error).message).toContain("boom");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(mux.calls.filter(isPaneCall)).toEqual([]);
    expect(channels()).toEqual([]);
  });

  it("an exec that prints no answer is an error, not a guessed path", async () => {
    setMode("noise");
    await expect(spawn({ worktree: true })).rejects.toBeInstanceOf(RemotePrepareError);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(channels()).toEqual([]);
  });

  it("an unreachable remote cwd fails before any pane", async () => {
    setMode("cwdfail");
    await expect(spawn({ cwd: "/nope" })).rejects.toBeInstanceOf(RemotePrepareError);
    expect(state.panes.size).toBe(0);
    expect(channels()).toEqual([]);
  });

  it("a pane that dies during the handshake: pane gone, lease freed, remote worktree removed (HEAD-guarded)", async () => {
    extensionOn = false;
    process.env.MU_SPAWN_LIVENESS_MS = "1500"; // the pane check rides on the handshake ticks
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      if (isPaneCall(args)) state.panes.clear(); // the template exits at once
      return res;
    });
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDiedOnSpawnError);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(channels()).toEqual([]);
    const calls = execCalls();
    expect(calls).toHaveLength(2);
    const rm = calls[1] ?? "";
    expect(rm).toContain("status --porcelain");
    expect(rm).toContain("worktree remove --force");
    expect(rm).toContain(SHA); // only while the remote HEAD is still the recorded base
    expect(rm).toContain(WT);
  });

  it("a replaced agent's remote worktree is left alone (identity-bound removal)", async () => {
    const a = await spawn({ worktree: true });
    // Same name, another incarnation now: the staged descriptor is not this row's.
    await closeAgent(db, "worker-1", { workstream: "auth" });
    const b = await spawn({ cwd: "/srv/repo" });
    const before = execCalls().length;
    await rollbackSpawn(
      db,
      "worker-1",
      undefined,
      {
        path: WT,
        base: SHA,
        root: "/srv/repo",
        createdAt: "x",
        incarnation: a.incarnation,
        host: "dev",
      },
      a.incarnation,
      "auth",
    );
    expect(execCalls().length).toBe(before); // no removal was run
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(b.incarnation);
    expect(channels()).toMatchObject([{ agent_id: b.incarnation }]);
  });
});

describe("rollback guards on an uncapped host (the cap cannot mask them)", () => {
  const free = () => listHostChannels(db, "free");
  const stagedFor = (incarnation: number) => ({
    path: WT,
    base: SHA,
    root: "/srv/repo",
    createdAt: "x",
    incarnation,
    host: "free",
  });
  /** tmux whose kill-pane does nothing: the pane stays alive. */
  const installStubbornTmux = (): void => {
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) =>
      args[0] === "kill-pane" ? { stdout: "", stderr: "", exitCode: 0 } : fake(args),
    );
  };

  it("a pane that fails to open frees the lease the spawn passed to rollback", async () => {
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) =>
      isPaneCall(args) ? { stdout: "", stderr: "no server", exitCode: 1 } : fake(args),
    );
    await expect(spawn({ host: "free", worktree: true })).rejects.toThrow();
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(free()).toEqual([]);
  });

  it("a replaced incarnation's remote worktree is not removed", async () => {
    const a = await spawn({ host: "free", worktree: true });
    await closeAgent(db, "worker-1", { workstream: "auth" });
    const b = await spawn({ host: "free", cwd: "/srv/repo" });
    const before = execCalls().length;
    await rollbackSpawn(db, "worker-1", undefined, stagedFor(a.incarnation), a.incarnation, "auth");
    expect(execCalls().length).toBe(before);
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(b.incarnation);
    expect(free()).toMatchObject([{ agent_id: b.incarnation }]);
  });

  it("a pane that survives the kill: row, channel and remote worktree all stay", async () => {
    const a = await spawn({ host: "free", worktree: true });
    installStubbornTmux();
    const before = execCalls().length;
    await rollbackSpawn(db, "worker-1", a.paneId, stagedFor(a.incarnation), a.incarnation, "auth");
    expect(execCalls().length).toBe(before); // nothing removed while the pane may be live
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(a.incarnation);
    expect(free()).toMatchObject([{ agent_id: a.incarnation, pane_id: a.paneId }]);
    expect(state.panes.has(a.paneId)).toBe(true);
    expect(
      listLogs(db, { workstream: "auth" }).some((l) => l.payload.includes("not proven gone")),
    ).toBe(true);
  });
});

describe("task-bound remote spawn goes through spawnForTask", () => {
  const req = (over: Record<string, unknown> = {}) => ({
    task: "t1",
    text: "do the thing",
    spawn: { name: "worker-1", workstream: "auth", host: "dev", worktree: true },
    ...over,
  });

  it("claims for THAT agent and sends the reserved msgId through the forwarded socket", async () => {
    const out = await spawnForTask(db, req());
    const agent = getAgent(db, "worker-1", "auth");
    expect(out).toMatchObject({ state: "sent", replay: false });
    expect(getTask(db, "t1", "auth")).toMatchObject({ ownerId: agent?.incarnation });
    expect(out.receipt).toMatchObject({
      agentId: agent?.incarnation,
      paneId: agent?.paneId,
      incarnation: INC,
    });
    expect(agent).toMatchObject({ host: "dev", cwd: WT, base: SHA });
  });

  it("replaying the attempt spawns nothing and execs nothing; the same key under another host conflicts", async () => {
    await spawnForTask(db, req());
    const before = { exec: execCalls().length, panes: state.panes.size };
    const again = await spawnForTask(db, req());
    expect(again).toMatchObject({ state: "sent", replay: true });
    expect({ exec: execCalls().length, panes: state.panes.size }).toEqual(before);
    addHost(db, {
      name: "other",
      shell: "true",
      exec: "true",
      fetch: "true",
      repo: "/r",
      max_sessions: null,
    });
    await expect(
      spawnForTask(db, req({ spawn: { name: "worker-1", workstream: "auth", host: "other" } })),
    ).rejects.toBeInstanceOf(SpawnReceiptConflictError);
    await expect(
      spawnForTask(db, req({ spawn: { name: "worker-1", workstream: "auth" } })),
    ).rejects.toBeInstanceOf(SpawnReceiptConflictError);
  });

  it("an unreachable forward is UNSENT: claim released, pane killed, lease freed, remote worktree removed", async () => {
    extensionOn = false;
    const err = await spawnForTask(db, req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentCtlUnreachableError);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(getTask(db, "t1", "auth")).toMatchObject({ ownerId: null, status: "OPEN" });
    expect(state.panes.size).toBe(0);
    expect(channels()).toEqual([]);
    const rm = execCalls().find((c) => c.includes("status --porcelain"));
    expect(rm).toContain(WT);
    expect(rm).toContain(SHA);
  });

  it("without --worktree an unsent failure still frees the lease", async () => {
    extensionOn = false;
    await expect(
      spawnForTask(db, req({ spawn: { name: "worker-1", workstream: "auth", host: "dev" } })),
    ).rejects.toBeInstanceOf(AgentCtlUnreachableError);
    expect(channels()).toEqual([]);
    expect(execCalls().some((c) => c.includes("status --porcelain"))).toBe(false);
  });

  it("a claim someone else already holds stops before any exec", async () => {
    insertAgent(db, { name: "other", workstream: "auth", paneId: "%99" });
    await claimTask(db, "t1", { workstream: "auth", agentName: "other" });
    await expect(spawnForTask(db, req())).rejects.toThrow();
    expect(execCalls()).toEqual([]);
    expect(channels()).toEqual([]);
  });
});

describe("the CLI", () => {
  const dbPath = (): string => join(dir, "mu.db");

  it("--host reaches spawn: the JSON agent names its host, cwd and base", async () => {
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev", "--worktree", "--json"],
      dbPath(),
    );
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({ agent: { host: "dev", cwd: WT, base: SHA } });
  });

  it("agent show prints the host; the close applies", async () => {
    await spawn({ worktree: true });
    const shown = await runCliWire(["agent", "show", "worker-1", "-w", "auth"], dbPath());
    expect(shown.stdout).toMatch(/host\s+: dev/);
    const preview = await runCliJson(
      ["agent", "close", "worker-1", "-w", "auth", "--json"],
      dbPath(),
    );
    const closed = await runCliJson(
      ["agent", "close", "worker-1", "-w", "auth", "--if", String(preview.data.revision), "--json"],
      dbPath(),
    );
    expect(closed.data).toMatchObject({ deletedRow: true });
  });

  it("--host with --root is a usage error (exit 2) before any effect", async () => {
    const r = await runCliJson(
      [
        "agent",
        "spawn",
        "worker-1",
        "-w",
        "auth",
        "--host",
        "dev",
        "--worktree",
        "--root",
        "/x",
        "--json",
      ],
      dbPath(),
    );
    expect(r.exitCode).toBe(2);
    expect(execCalls()).toEqual([]);
  });

  it("an unknown host is exit 3", async () => {
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "nope", "--json"],
      dbPath(),
    );
    expect(r.exitCode).toBe(3);
  });

  it("a failing remote exec is exit 5 (substrate), not a generic 1", async () => {
    setMode("addfail");
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev", "--worktree", "--json"],
      dbPath(),
    );
    expect(r.exitCode).toBe(5);
  });
});

describe("the socket paths", () => {
  it("remote path is /tmp/mu-<uid>/<ws>/<agent>.sock, hashed past the 103-byte limit", () => {
    expect(remoteCtlSocketPath("big", "worker-1", 501)).toBe("/tmp/mu-501/big/worker-1.sock");
    const p = remoteCtlSocketPath("w".repeat(50), "a".repeat(50), 501);
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(MAX_SOCK_PATH);
    expect(p).toMatch(/^\/tmp\/mu-501\/h\/[0-9a-f]{16}\.sock$/);
  });

  /** A socket file with no listener: what a dead forward leaves behind. */
  async function leftoverSocket(path: string): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    const live = join(dir, "live.sock");
    const s = createServer();
    await new Promise<void>((res) => s.listen(live, () => res()));
    linkSync(live, path); // second name survives node's unlink on close
    await new Promise<void>((res) => s.close(() => res()));
  }

  it("a leftover forwarded socket probes as refused, never ok; deleteAgent unlinks only its own", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", cli: "pi" });
    const mine = ctlSocketPath("auth", "worker-1", dir);
    const other = ctlSocketPath("auth", "worker-2", dir);
    await leftoverSocket(mine);
    await leftoverSocket(other);
    expect((await ctlProbe(mine, 500)).kind).toBe("refused");
    expect(deleteAgent(db, "worker-1", "auth")).toBe(true);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
