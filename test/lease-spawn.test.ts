// `agent spawn --host` on a LEASE profile (spec 2026-10-28-lease-transport.md,
// § agent spawn --host on a lease profile), fast tier. The pane is a carrier:
// the fake tmux's pane creation stands in for it (publishes the job file, then
// serves the stub ctl socket, or not, per `carrier`). `exec` and `stop` are sh
// shims that append to ONE order log, so rollback order is read from it. No real
// host, no real git, no mule: test/lease-spawn.integration.test.ts runs a real
// fake-carrier script on real tmux.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CarrierJobKeptError,
  CarrierJobUnstoppedError,
  defaultSpawnJobMs,
  LeaseJobInvalidError,
  LeaseJobTimeoutError,
  LeaseJobUnreadableError,
  refuseReserved,
  reserveLeaseJob,
  resolveEmptyReservation,
  setLeaseClockForTests,
} from "../src/agents/lease-carrier.js";
import { rollbackSpawn } from "../src/agents/spawn.js";
import {
  AgentDiedOnSpawnError,
  AgentLockBusyError,
  AgentSpawnStartupError,
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import {
  abandonCarrierJob,
  bindCarrierJobAgent,
  type CarrierJob,
  getCarrierJobByAgent,
  getCarrierJobByName,
  listCarrierJobs,
  markCarrierLaunch,
  recordCarrierPane,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { carrierJobFilePath, ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  getHost,
  HostProfileError,
  listHostChannels,
  runHostTemplate,
} from "../src/hosts.js";
import { listLogs } from "../src/logs.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { helloReply, withHello } from "./_ctl-ext.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const SHA = "a".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";
const STOP = (script: string) => `/bin/sh ${script} {job}`;

let dir: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let servers: Server[];
let orderLog: string;
let stopScript: string;
/** The channels held at the moment a pane was created. */
let atPane: string[][] | undefined;
/** What the fake carrier does when its pane opens. */
let carrier: {
  handle?: string;
  ctl: boolean;
  scrollback?: string;
  onPane?: () => void;
};
let saved: Record<string, string | undefined>;
/** Runs before every tmux call (a probe's boundary). */
let beforeTmux: ((args: readonly string[]) => Promise<void>) | undefined;
let now: number;

const ENV_KEYS = [
  "MU_SPAWN_CTL_MS",
  "MU_SPAWN_LIVENESS_MS",
  "MU_SPAWN_JOB_MS",
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
  "MU_AGENT_LOCK_TIMEOUT_MS",
];

const order = (): string[] =>
  existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n").filter(Boolean) : [];
const setStopExit = (code: number): void => writeFileSync(join(dir, "stop-exit"), String(code));
const channels = () => listHostChannels(db, "dev");
const jobFile = (name = "worker-1") => carrierJobFilePath("auth", name, dir);
const reservation = (name = "worker-1"): CarrierJob | undefined =>
  getCarrierJobByName(db, "auth", name);
/** The facts a kept, launched reservation of worker-1 must show. */
const expectKept = (over: Partial<CarrierJob> = {}): void =>
  expect(reservation()).toMatchObject({ host: "dev", launch: "intent", ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mls-"));
  db = openDb({ path: join(dir, "mu.db") });
  orderLog = join(dir, "order");
  servers = [];
  atPane = undefined;
  beforeTmux = undefined;
  carrier = { handle: "job-1", ctl: true };
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_SPAWN_CTL_MS = "300";
  process.env.MU_SPAWN_LIVENESS_MS = "0";
  process.env.MU_SPAWN_JOB_MS = "2000";
  process.env.MU_DB_PATH = join(dir, "mu.db");
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  setSleepForTests(async () => {});
  // A virtual clock: the job deadline is counted, never slept.
  now = 0;
  setLeaseClockForTests({
    now: () => now,
    delay: async (ms) => {
      now += ms;
      await new Promise((r) => setImmediate(r));
    },
  });
  setCommandResolverForTests(async (c) => ({ ok: false, binary: c, envVarChecked: "X" }));
  ensureWorkstream(db, "auth");
  const fakeExec = join(dir, "fake-exec.sh");
  writeFileSync(
    fakeExec,
    `#!/bin/sh
case "$1" in
  *'worktree add'*) echo "exec add" >> '${orderLog}'
    echo "MU_REPO $(printf /srv/repo | od -An -v -tx1 | tr -d ' \\n')"; echo "MU_WT ${SHA} ${WT}" ;;
  *'worktree remove'*) echo "exec rm" >> '${orderLog}'
    [ -f '${dir}/rm-fail' ] && { echo "MU_RM failed"; exit 1; }; echo "MU_RM removed" ;;
  *MU_CWD*) echo "exec cwd" >> '${orderLog}'; echo "MU_CWD /srv/repo" ;;
  *) echo "exec other" >> '${orderLog}' ;;
esac
`,
  );
  stopScript = join(dir, "fake-stop.sh");
  writeFileSync(
    stopScript,
    `#!/bin/sh
echo "stop $1" >> '${orderLog}'
code=$(cat '${dir}/stop-exit' 2>/dev/null || echo 0)
[ "$code" = 0 ] || echo "stop said no" >&2
exit "$code"
`,
  );
  chmodSync(fakeExec, 0o755);
  addHost(db, {
    name: "dev",
    transport: "lease",
    shell: "carrier J={job_file} L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `/bin/sh ${fakeExec} {cmd}`,
    stop: STOP(stopScript),
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: 1,
  });
  state = freshMockState();
  installCarrierTmux();
});

afterEach(async () => {
  mux.restore();
  resetSleep();
  setLeaseClockForTests(undefined);
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

async function serveCtl(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer((sock) => {
    const dec = new LineDecoder();
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (chunk: string) => {
      for (const line of dec.push(chunk)) {
        const req = JSON.parse(line) as { op: string };
        const status = { v: 1, ok: true, state: "idle", since: 1, runs: 1, pending: false };
        sock.end(encode(withHello(req, status, helloReply())));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
}

const isPaneCall = (a: readonly string[]): boolean =>
  ["new-session", "new-window", "split-window"].includes(a[0] ?? "");

/** tmux whose pane creation runs the fake carrier: job file first, then the ctl forward. */
function installCarrierTmux(): void {
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    await beforeTmux?.(args);
    const res = await fake(args);
    if (!isPaneCall(args)) return res;
    atPane = channels().map((c) => [c.holder, c.kind]);
    const name = args[args.indexOf("-n") + 1] ?? "";
    const pane = res.stdout.trim();
    if (carrier.handle !== undefined) {
      mkdirSync(dirname(jobFile(name)), { recursive: true });
      writeFileSync(jobFile(name), `${carrier.handle}\n`);
    }
    if (carrier.scrollback !== undefined) {
      const p = state.panes.get(pane);
      if (p) p.scrollback = carrier.scrollback;
    }
    if (carrier.ctl) await serveCtl(ctlSocketPath("auth", name, dir));
    carrier.onPane?.();
    return res;
  });
}
const spawn = (over: Partial<Parameters<typeof spawnAgent>[1]> = {}) =>
  spawnAgent(db, { name: "worker-1", workstream: "auth", host: "dev", ...over });
/** A reservation as a spawn leaves it once its carrier was launched (pane recorded). */
const launched = (paneId?: string, name = "worker-1"): CarrierJob => {
  const r = reserveCarrierJob(db, {
    workstream: "auth",
    name,
    host: "dev",
    hostStop: STOP(stopScript),
    creatorPid: process.pid,
  });
  if (r === undefined) throw new Error("reserved already");
  markCarrierLaunch(db, r.token);
  if (paneId !== undefined) recordCarrierPane(db, r.token, paneId);
  return r;
};
/** A pid that is certainly gone: a child that already exited. */
const deadPid = (): number => spawnSync("true").pid ?? 999_999;

describe("a lease spawn records its job and holds no channel", () => {
  it("the handshake fills the reservation (id + pane, admitted stop); no host_channels row at the pane or after", async () => {
    const a = await spawn({ cwd: "/srv/repo" });
    expect(a).toMatchObject({ host: "dev", ctl: "ok" });
    expect(getCarrierJobByAgent(db, a.incarnation)).toMatchObject({
      agentId: a.incarnation,
      paneId: a.paneId,
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      launch: "intent",
      job: "job-1",
      hostStop: STOP(stopScript),
      creatorPid: process.pid,
    });
    // Prepare's channel was transient: released before the pane, never bound to it.
    expect(atPane).toEqual([]);
    expect(channels()).toEqual([]);
    // The pane ran the template with {job_file} filled.
    const pane = mux.calls.find(isPaneCall)?.at(-1) ?? "";
    expect(pane).toContain(jobFile());
  });

  it("at --max-sessions 1 a host command is admitted while the worker lives (collect is not starved)", async () => {
    await spawn({ cwd: "/srv/repo" });
    const r = await runHostTemplate(db, "dev", "exec", "collect:auth/worker-1", {
      cmd: "MU_CWD",
      cwd: ".",
    });
    expect(r.exitCode).toBe(0);
    expect(channels()).toEqual([]);
  });

  it("the job handshake runs under --no-ctl and under MU_SPAWN_CTL_MS=0", async () => {
    const a = await spawn({ cwd: "/srv/repo", ctl: false });
    expect(a.ctl).toBe("skipped");
    expect(getCarrierJobByAgent(db, a.incarnation)?.job).toBe("job-1");
    process.env.MU_SPAWN_CTL_MS = "0";
    carrier = { handle: "job-2", ctl: false };
    const b = await spawn({ name: "worker-2", cwd: "/srv/repo" });
    expect(b.ctl).toBe("skipped");
    expect(getCarrierJobByAgent(db, b.incarnation)?.job).toBe("job-2");
  });

  it("MU_SPAWN_JOB_MS defaults to 30 s and is never 0", () => {
    delete process.env.MU_SPAWN_JOB_MS;
    expect(defaultSpawnJobMs()).toBe(30_000);
    for (const v of ["0", "-5", "x"]) {
      process.env.MU_SPAWN_JOB_MS = v;
      expect(defaultSpawnJobMs()).toBe(30_000);
    }
    process.env.MU_SPAWN_JOB_MS = "1200";
    expect(defaultSpawnJobMs()).toBe(1200);
  });
});

describe("handshake failures roll back", () => {
  it("a live pane with no job file by the deadline (even under --no-ctl): pane killed, no row, nothing stopped, reservation and tree KEPT", async () => {
    carrier = { ctl: false };
    // A stale file of an earlier, released reservation: moved aside inside the lock, never read as this job.
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "old-job\n");
    const err = await spawn({ worktree: true, ctl: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseJobTimeoutError);
    expect((err as Error).message).toContain("MU_SPAWN_JOB_MS");
    expect(now).toBeGreaterThanOrEqual(2000);
    expect(state.panes.size).toBe(0);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    // The carrier was launched and nothing proves it will not publish: nothing removed, nothing stopped.
    expect(order()).toEqual(["exec add"]);
    expectKept({ job: null });
    expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", cwd: WT }]);
    const aside = readdirSync(dirname(jobFile())).filter((f) => f.includes(".stale-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dirname(jobFile()), aside[0] ?? ""), "utf8")).toBe("old-job\n");
  });

  it("a pane that dies before writing the file: AgentDiedOnSpawnError with its scrollback, nothing stopped, reservation kept", async () => {
    // The carrier prints its error and exits: the pane is gone right after the first capture.
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      if (isPaneCall(args)) {
        const p = state.panes.get(res.stdout.trim());
        if (p) p.scrollback = "mule: no master for dev";
      }
      if (args[0] === "capture-pane") state.panes.delete(args[args.indexOf("-t") + 1] ?? "");
      return res;
    });
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDiedOnSpawnError);
    expect((err as Error).message).toContain("mule: no master for dev");
    expect((err as Error).message).toContain("before writing its job handle");
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    // Pane death is not carrier death (a non-exec wrapper's child may still publish):
    // the reservation and the tree are kept.
    expect(order()).toEqual(["exec add"]);
    expectKept({ job: null });
    // A late publication after the pane died is caught: the name stays fenced and the
    // reservation's job file holds the handle for the close.
    writeFileSync(jobFile(), "late-job\n");
    const again = await spawn({ cwd: "/srv/repo" }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(CarrierJobUnstoppedError);
    const r = await resolveEmptyReservation(db, reservation() as CarrierJob);
    expect(r.released).toBe(false);
    expect(r.facts).toContain("handle late-job");
    expect(readFileSync(jobFile(), "utf8")).toBe("late-job\n");
  });

  it("a job file that is not a handle: rolled back, the tree kept (a job may exist)", async () => {
    carrier = { handle: "not a handle!", ctl: false };
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseJobInvalidError);
    expect(order()).toEqual(["exec add"]);
    expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", cwd: WT }]);
    expectKept({ job: null });
    expect(reservation()?.reason).toContain("not a handle");
  });

  it("an EMPTY job file is not a handle either: reservation and tree kept", async () => {
    carrier = { handle: "", ctl: false };
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseJobInvalidError);
    expect(order()).toEqual(["exec add"]);
    expectKept({ job: null });
  });
});

describe("rollback after the handle: stop first, then the worktree", () => {
  it("a startup error after the handshake: kill, stop, THEN remove the worktree; the handle is deleted", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    carrier = { handle: "job-9", ctl: true, scrollback: "Error: invalid API key" };
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    expect(order()).toEqual(["exec add", "stop job-9", "exec rm"]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(existsSync(jobFile())).toBe(false);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listRemoteRecoveries(db)).toEqual([]);
  });

  it("a failed stop keeps the worktree and the carrier_jobs row, and says so", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    carrier = { handle: "job-9", ctl: true, scrollback: "Error: invalid API key" };
    setStopExit(1);
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    expect(order()).toEqual(["exec add", "stop job-9"]); // no removal
    expect(listCarrierJobs(db)).toMatchObject([{ name: "worker-1", job: "job-9", host: "dev" }]);
    expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", cwd: WT }]);
    const said = listLogs(db, { workstream: "auth" }).map((l) => l.payload);
    expect(said.some((p) => p.includes("job job-9 on dev was not stopped"))).toBe(true);
  });

  for (const code of [1, 3]) {
    it(`a handle written but not yet recorded, stop exit ${code}: persisted with the incarnation's fields first, tree kept`, async () => {
      const ac = new AbortController();
      // The spawn is aborted the moment the carrier has written its file: before the handshake reads it.
      carrier = { handle: "job-7", ctl: true, onPane: () => ac.abort() };
      setStopExit(code);
      const err = await spawn({ worktree: true, signal: ac.signal }).catch((e: unknown) => e);
      expect((err as Error).name).toBe("AbortError");
      expect(order()).toEqual(["exec add", "stop job-7"]);
      const [row, ...rest] = listCarrierJobs(db);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        launch: "intent",
        workstream: "auth",
        name: "worker-1",
        host: "dev",
        job: "job-7",
        hostStop: STOP(stopScript),
      });
      // The incarnation the spawn captured, though its agent row is gone now.
      expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
      expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", agentId: row?.agentId }]);
    });
  }

  it("a reread handle whose agent row reconcile already removed is still filled in before the stop", async () => {
    const r = launched("%77");
    const row = insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%77",
      host: "dev",
      reservation: r.token,
    });
    bindCarrierJobAgent(db, r.token, row.incarnation, "%77");
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "job-5\n");
    deleteAgent(db, "worker-1", "auth"); // reconcile's prune
    setStopExit(1);
    await rollbackSpawn(db, "worker-1", "%77", undefined, row.incarnation, "auth", undefined, {
      token: r.token,
    });
    expect(order()).toEqual(["stop job-5"]);
    expect(getCarrierJobByAgent(db, row.incarnation)).toMatchObject({ job: "job-5", host: "dev" });
    // task-spawn's rollback (no token) finds the reservation by the incarnation it owns.
    setStopExit(0);
    await rollbackSpawn(db, "worker-1", "%77", undefined, row.incarnation, "auth");
    expect(order()).toEqual(["stop job-5", "stop job-5"]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(existsSync(jobFile())).toBe(false);
  });
});

// The four reviewer-17 probes (lease_spawn_finalize_handle_lost, _invalid_pointer_erased,
// _read_error_removes_tree, _rollback_stops_replacement): each failed on b190f90a.
describe("reviewer probes: the job file is never an ownerless pointer", () => {
  // reviewer-23 (high_closing_an_unrelated_recovery): failed on 53b6f549, where close
  // removed the OLD recovery, stopped new-job and released the reservation.
  it("reviewer wrong-tree end-to-end: failed finalize at a new root cannot release its tree pointer by closing an older recovery", async () => {
    const prior = insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%old",
      host: "dev",
      cwd: "/old/root/worker-1",
      base: SHA,
      repo: "/old/root",
    });
    deleteAgent(db, "worker-1", "auth");
    carrier = { handle: "new-job", ctl: false };
    writeFileSync(join(dir, "rm-fail"), "1");
    db.exec(
      "CREATE TRIGGER deny_finalize BEFORE UPDATE OF pane_id ON agents BEGIN SELECT RAISE(ABORT, 'finalize failed'); END",
    );
    const err = await spawn({ worktree: true, root: "/srv/repo", ctl: false }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("finalize failed");
    expect(reservation()).toMatchObject({ job: "new-job", treePath: WT });
    expect(reservation()?.reason).toContain(WT);
    expect(listRemoteRecoveries(db).map((r) => r.agentId)).toEqual([prior.incarnation]);
    writeFileSync(
      join(dir, "fake-exec.sh"),
      `#!/bin/sh\ncase "$1" in\n *MU_STATE*) echo "MU_STATE clean ${SHA}";;\n *MU_RM*) echo "MU_RM removed";;\nesac\n`,
    );
    const result = await closeAgent(db, "worker-1", { workstream: "auth" }).catch(
      (e: unknown) => e,
    );
    expect(result).toBeInstanceOf(CarrierJobKeptError);
    expect((result as Error).message).toContain(WT);
    expect(reservation()?.reason).toContain(WT);
  });

  it("a stopped rollback that kept its tree: close-by-name closes THAT tree's recovery and only then releases", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    carrier = { handle: "job-9", ctl: true, scrollback: "Error: invalid API key" };
    writeFileSync(join(dir, "rm-fail"), "1");
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentSpawnStartupError);
    const kept = reservation();
    expect(kept).toMatchObject({ job: "job-9", treePath: WT });
    const recs = listRemoteRecoveries(db);
    expect(recs).toMatchObject([{ cwd: WT, agentId: kept?.treeAgentId }]);
    rmSync(join(dir, "rm-fail"));
    writeFileSync(
      join(dir, "fake-exec.sh"),
      `#!/bin/sh\ncase "$1" in\n *MU_STATE*) echo "MU_STATE clean ${SHA}";;\n *MU_RM*) echo "MU_RM removed";;\nesac\n`,
    );
    const res = await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(res.recovery).toEqual({ id: kept?.treeAgentId, deleted: true });
    expect(res.carrierJobs).toEqual([{ host: "dev", job: "job-9", action: "stopped" }]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("finalize failure and failed stop must not lose the only handle on respawn", async () => {
    carrier = { handle: "orphan-job", ctl: false };
    setStopExit(1);
    db.exec(
      "CREATE TRIGGER deny_insert BEFORE INSERT ON agents BEGIN SELECT RAISE(ABORT, 'finalize failed'); END",
    );
    const err = await spawn({ cwd: "/srv/repo", ctl: false }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("finalize failed");
    expect(order()).toEqual(["exec cwd", "stop orphan-job"]);
    expect(readFileSync(jobFile(), "utf8")).toBe("orphan-job\n");
    // No agent row was ever written, yet the reservation holds the handle.
    expectKept({ job: "orphan-job", agentId: null });
    db.exec("DROP TRIGGER deny_insert");
    setStopExit(0);
    carrier = { handle: "replacement-job", ctl: false };
    mux.restore();
    state = freshMockState();
    installCarrierTmux();
    const replacement = await spawn({ cwd: "/srv/repo", ctl: false }).catch((e: unknown) => e);
    expect(replacement).toBeInstanceOf(CarrierJobUnstoppedError);
    expect((replacement as Error).message).toContain("orphan-job");
    expect(readFileSync(jobFile(), "utf8")).toBe("orphan-job\n");
  });

  it("an invalid handle kept on rollback must not be erased on respawn", async () => {
    carrier = { handle: "unknown job!", ctl: false };
    await expect(spawn({ worktree: true, ctl: false })).rejects.toBeInstanceOf(
      LeaseJobInvalidError,
    );
    expect(readFileSync(jobFile(), "utf8")).toBe("unknown job!\n");
    mux.restore();
    state = freshMockState();
    installCarrierTmux();
    carrier = { handle: "new-job", ctl: false };
    const next = await spawn({ cwd: "/srv/repo", ctl: false }).catch((e: unknown) => e);
    expect(next).toBeInstanceOf(CarrierJobUnstoppedError);
    expect(mux.calls.filter(isPaneCall)).toEqual([]);
    expect(readFileSync(jobFile(), "utf8")).toBe("unknown job!\n");
  });

  it("an unreadable existing job file must keep the remote tree", async () => {
    carrier = { handle: "unreadable-job", ctl: false, onPane: () => chmodSync(jobFile(), 0) };
    const err = await spawn({ worktree: true, ctl: false }).catch((e: unknown) => e);
    chmodSync(jobFile(), 0o600);
    expect(err).toBeInstanceOf(LeaseJobUnreadableError);
    expect(order()).not.toContain("exec rm");
    expect(order()).toEqual(["exec add"]);
    expectKept({ job: null });
    expect(reservation()?.reason).toMatch(/unreadable: EACCES/);
    expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", cwd: WT }]);
  });

  it("rollback must not stop the replacement job from a reused name file", async () => {
    // The old spawn's reservation was abandoned; a replacement reserved the name and published.
    const old = launched("%77");
    const oldRow = insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%77",
      host: "dev",
      reservation: old.token,
    });
    deleteAgent(db, "worker-1", "auth");
    abandonCarrierJob(db, old);
    const fresh = launched("%88");
    insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%88",
      host: "dev",
      reservation: fresh.token,
    });
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "replacement-job\n");
    await rollbackSpawn(db, "worker-1", "%77", undefined, oldRow.incarnation, "auth", undefined, {
      token: old.token,
    });
    expect(order()).not.toContain("stop replacement-job");
    expect(existsSync(jobFile())).toBe(true);
    expect(reservation()).toMatchObject({ token: fresh.token, job: null });
  });
});

describe("the reservation: name-exclusive, before any effect", () => {
  it("two concurrent lease spawns of one name: exactly one reserves, the other refuses before any effect", async () => {
    carrier = { handle: "job-1", ctl: false };
    const [a, b] = await Promise.allSettled([
      spawn({ cwd: "/srv/repo", ctl: false }),
      spawn({ cwd: "/srv/repo", ctl: false }),
    ]);
    const outcomes = [a, b].map((r) => r.status);
    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    const lost = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    // Refused by the reservation, or (the winner already finalized) by its agent row.
    expect((lost.reason as Error).name).toMatch(/^(CarrierJobUnstoppedError|AgentExistsError)$/);
    expect(listCarrierJobs(db)).toHaveLength(1);
    expect(mux.calls.filter(isPaneCall)).toHaveLength(1);
    expect(order().filter((l) => l === "exec cwd")).toHaveLength(1);
  });

  it("a SIGKILLed spawn before launch (creator gone, launch none, no pane): close-by-name releases without abandon", async () => {
    const r = reserveCarrierJob(db, {
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      hostStop: STOP(stopScript),
      creatorPid: deadPid(),
    });
    if (r === undefined) throw new Error("not reserved");
    await expect(spawn({ cwd: "/srv/repo" })).rejects.toBeInstanceOf(CarrierJobUnstoppedError);
    const out = await resolveEmptyReservation(db, r);
    expect(out).toMatchObject({ released: true, abandoned: false });
    expect(out.facts).toMatch(/launch none, pane none, creator pid \d+ gone, job file absent/);
    expect(listCarrierJobs(db)).toEqual([]);
    await expect(spawn({ cwd: "/srv/repo" })).resolves.toMatchObject({ name: "worker-1" });
  });

  it("a launch with no pane recorded (creator SIGKILLed after the intent): refuses with facts; --abandon-job releases with an event", async () => {
    const r = launched();
    db.prepare("UPDATE carrier_jobs SET creator_pid = ? WHERE token = ?").run(deadPid(), r.token);
    const out = await resolveEmptyReservation(db, r);
    expect(out.released).toBe(false);
    expect(out.facts).toMatch(/launch intent, pane none, creator pid \d+ gone, job file absent/);
    expect(reservation()?.token).toBe(r.token);
    const live = await resolveEmptyReservation(db, launched(undefined, "worker-2"));
    expect(live.released).toBe(false);
    expect(live.facts).toContain("not proven gone"); // a live creator, too
    const gone = await resolveEmptyReservation(db, r, { abandon: true });
    expect(gone).toMatchObject({ released: true, abandoned: true });
    expect(reservation()).toBeUndefined();
    const said = listLogs(db, { workstream: "auth" }).map((l) => l.payload);
    const event = said.find((p) => p.includes("--abandon-job"));
    expect(event).toContain("on dev");
    expect(event).toContain(jobFile());
  });

  it("pane dead but carrier alive: a launched reservation is kept, whatever the pane says", async () => {
    const r = launched("%404"); // no such pane in the mock: dead
    db.prepare("UPDATE carrier_jobs SET creator_pid = ? WHERE token = ?").run(deadPid(), r.token);
    const out = await resolveEmptyReservation(db, r);
    expect(out.released).toBe(false);
    expect(out.facts).toContain("pane %404 (dead)");
    // ...and its carrier publishes later: still fenced, and the handle is found.
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "late-job\n");
    const again = await resolveEmptyReservation(db, r);
    expect(again.released).toBe(false);
    expect(again.facts).toContain("handle late-job");
  });

  it("a mux spawn rejected BEFORE submission (ensureSession fails): launch stays none and the rollback releases", async () => {
    mux.restore();
    mux = installMux("tmux", async (args) => ({
      stdout: "",
      stderr: "server exited unexpectedly",
      exitCode: args[0] === "has-session" ? 1 : 1,
    }));
    const err = await spawnAgent(db, {
      name: "worker-1",
      workstream: "scratch",
      host: "dev",
      cwd: "/srv/repo",
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TmuxError");
    expect(order()).toEqual(["exec cwd"]); // reserved and prepared, then ensureSession failed
    // Only ensureSession ran: no pane command was ever submitted.
    expect(mux.calls.filter((c) => isPaneCall(c) && c.includes("-P"))).toEqual([]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("a mux spawn rejected AFTER submission (non-zero tmux exit, no pane id): launch intent, the reservation is kept", async () => {
    mux.restore();
    const fake = mockTmux(state).executor;
    mux = installMux("tmux", async (args) => {
      const res = await fake(args);
      return isPaneCall(args) ? { stdout: res.stdout, stderr: "hook failed", exitCode: 1 } : res;
    });
    const err = await spawn({ cwd: "/srv/repo", ctl: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expectKept({ job: null, paneId: null });
    await expect(spawn({ cwd: "/srv/repo" })).rejects.toBeInstanceOf(CarrierJobUnstoppedError);
  });

  it("a remote prepare failure (before the pane) releases the reservation: nothing was launched", async () => {
    db.prepare("UPDATE host_profiles SET exec = 'false {cmd}' WHERE name = 'dev'").run();
    await expect(spawn({ cwd: "/srv/repo" })).rejects.toBeInstanceOf(Error);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(mux.calls.filter(isPaneCall)).toEqual([]);
  });

  it("a --cwd respawn of the name while the old tree's cleanup holds the reservation is refused", async () => {
    // A failed stop: the reservation (with its handle) and the tree are kept for the close.
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    carrier = { handle: "job-9", ctl: true, scrollback: "Error: invalid API key" };
    setStopExit(1);
    await expect(spawn({ worktree: true })).rejects.toBeInstanceOf(AgentSpawnStartupError);
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    carrier = { handle: "job-10", ctl: false };
    setStopExit(0);
    for (const over of [{ cwd: "/srv/repo" }, { cwd: "/srv/repo", host: undefined }]) {
      const err = await spawn({ ...over, ctl: false }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CarrierJobUnstoppedError);
    }
    expect(order()).toEqual(["exec add", "stop job-9"]);
    expect(reservation()?.job).toBe("job-9");
  });

  // reviewer-19 boundary probe (high_a_concurrent_lease_reservation_does): a lease
  // reservation of the name attempted at the tmux has-session boundary, after the
  // spawn's in-lock fence passed and before its pane command is submitted. On 41f1cfb8
  // it landed (the spawn held only the session lock) and `new-session … pi` ran under
  // the reserved name. Now the spawn holds the strict agent lock from fence to row: the
  // reservation cannot land, so no pane command ever runs beside a foreign reservation.
  // The reservation goes through reserveLeaseJob, its only production writer (a raw
  // INSERT that skips the lock is not a race any process can run). The lease shapes pin
  // that a lease spawn holds the lock across its pane call too.
  for (const shape of ["cwd", "lease", "lease-worktree"] as const) {
    it(`reviewer-19 boundary probe (${shape}): no reservation lands between the fence and the pane command`, async () => {
      process.env.MU_AGENT_LOCK_TIMEOUT_MS = "50";
      carrier = { handle: "job-1", ctl: false };
      const foreign: string[] = [];
      let attempt: Promise<unknown> | undefined;
      beforeTmux = async (args) => {
        if (args[0] === "has-session" && attempt === undefined) {
          attempt = reserveLeaseJob(db, "auth", "worker-1", getHost(db, "dev")).catch(
            (e: unknown) => e,
          );
          await attempt;
        }
        // A pane command submitted while a reservation other than the spawn's own exists.
        const r = reservation();
        if (isPaneCall(args) && r !== undefined && r.launch === "none") {
          foreign.push(args.join(" "));
        }
      };
      const err = await (shape === "cwd"
        ? spawnAgent(db, {
            name: "worker-1",
            workstream: "auth",
            command: "pi",
            cwd: dir,
            ctl: false,
          })
        : spawn(
            shape === "lease" ? { cwd: "/srv/repo", ctl: false } : { worktree: true, ctl: false },
          )
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeUndefined();
      expect(await attempt).toBeInstanceOf(AgentLockBusyError);
      expect(foreign).toEqual([]);
      expect(mux.calls.filter(isPaneCall)).toHaveLength(1);
      expect(listCarrierJobs(db)).toHaveLength(shape === "cwd" ? 0 : 1);
    });
  }

  it("a reservation that lands before the spawn's lock refuses it with zero pane calls", async () => {
    const r = reserveCarrierJob(db, {
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      hostStop: STOP(stopScript),
      creatorPid: process.pid,
    });
    expect(r).toBeDefined();
    for (const over of [{ cwd: dir }, { cwd: dir, tmuxSession: "mu-other" }]) {
      const err = await spawnAgent(db, {
        name: "worker-1",
        workstream: "auth",
        command: "pi",
        ...over,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CarrierJobUnstoppedError);
    }
    expect(mux.calls.filter(isPaneCall)).toEqual([]);
  });

  // reviewer-19 cleanup probe (medium_never_launched_rollback_releases): prepare made the
  // remote worktree, a pre-launch error (EISDIR: a directory at the ctl socket path) rolls
  // back with launch 'none', and the worktree removal fails. The placeholder recorded no
  // path (no remote_recovery record), so the reservation is the tree's only pointer: kept,
  // with the reason, and the name stays fenced. On 41f1cfb8 it was released.
  it("reviewer-19 cleanup probe: a never-launched rollback whose tree removal fails keeps the reservation", async () => {
    writeFileSync(join(dir, "rm-fail"), "");
    mkdirSync(ctlSocketPath("auth", "worker-1", dir), { recursive: true });
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toMatch(/EISDIR/);
    expect(order()).toEqual(["exec add", "exec rm"]);
    expect(mux.calls.filter(isPaneCall)).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    const kept = reservation();
    expect(kept).toMatchObject({ launch: "none", job: null, paneId: null });
    expect(kept?.reason).toContain(WT);
    // Fenced: neither a respawn nor a close-by-name drops it (the facts name the tree).
    rmFixtureDir(ctlSocketPath("auth", "worker-1", dir));
    const refused = await spawn({ cwd: "/srv/repo" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CarrierJobUnstoppedError);
    // The refusal names the kept tree and the way out, not a spawn in progress.
    expect((refused as CarrierJobUnstoppedError).reason).toContain(WT);
    expect((refused as Error).message).toContain(WT);
    expect((refused as Error).message).toContain("--abandon-job");
    expect((refused as Error).message).not.toMatch(/in progress/);
    db.prepare("UPDATE carrier_jobs SET creator_pid = ?").run(deadPid());
    const out = await resolveEmptyReservation(db, reservation() as CarrierJob);
    expect(out.released).toBe(false);
    expect(out.facts).toContain(WT);
  });

  it("a never-launched rollback whose tree removal succeeds releases the reservation", async () => {
    mkdirSync(ctlSocketPath("auth", "worker-1", dir), { recursive: true });
    await expect(spawn({ worktree: true })).rejects.toBeInstanceOf(Error);
    expect(order()).toEqual(["exec add", "exec rm"]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("a successful spawn's reservation survives reconcile/teardown/raw deletes of the agent row", async () => {
    const a = await spawn({ cwd: "/srv/repo" });
    db.prepare("DELETE FROM agents WHERE id = ?").run(a.incarnation);
    expect(reservation()).toMatchObject({ agentId: a.incarnation, job: "job-1" });
    await expect(spawn({ cwd: "/srv/repo" })).rejects.toBeInstanceOf(CarrierJobUnstoppedError);
  });
});

describe("refusals before any effect", () => {
  it("a respawn of a name with an unstopped job refuses, naming the handle and the close", async () => {
    process.env.MU_SPAWN_LIVENESS_MS = "1500";
    carrier = { handle: "job-9", ctl: true, scrollback: "Error: invalid API key" };
    setStopExit(1);
    await spawn({ cwd: "/srv/repo" }).catch(() => undefined);
    const before = order().length;
    const panes = mux.calls.filter(isPaneCall).length;
    const err = await spawn({ cwd: "/srv/repo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierJobUnstoppedError);
    expect((err as Error).message).toBe(
      "worker-1 has an unstopped job job-9 on dev: mu agent close worker-1",
    );
    expect(order().length).toBe(before);
    expect(mux.calls.filter(isPaneCall).length).toBe(panes);
    // The fence refuses any spawn of the name, and leaves the file the old job may name.
    writeFileSync(jobFile(), "job-9\n");
    expect(() => refuseReserved(db, "auth", "worker-1")).toThrow(CarrierJobUnstoppedError);
    const local = await spawnAgent(db, {
      name: "worker-1",
      workstream: "auth",
      command: "pi",
      cwd: dir,
    }).catch((e: unknown) => e);
    expect(local).toBeInstanceOf(CarrierJobUnstoppedError);
    expect(readFileSync(jobFile(), "utf8")).toBe("job-9\n");
    const r = await runCliJson(
      ["agent", "spawn", "worker-1", "-w", "auth", "--host", "dev", "--json"],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(4);
  });

  it("a lease profile refuses a command gate: exit 2, nothing touched", async () => {
    const err = await spawn({ command: "npm test" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostProfileError);
    expect((err as Error).message).toMatch(/lease profile.*no command gates/);
    expect(order()).toEqual([]);
    expect(mux.calls.filter(isPaneCall)).toEqual([]);
    expect(channels()).toEqual([]);
    const r = await runCliJson(
      ["agent", "spawn", "g-1", "-w", "auth", "--host", "dev", "--command", "npm test", "--json"],
      join(dir, "mu.db"),
    );
    expect(r.exitCode).toBe(2);
  });
});
