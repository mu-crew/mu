// `agent spawn --host` on a LEASE profile (spec 2026-10-28-lease-transport.md,
// § agent spawn --host on a lease profile), fast tier. The pane is a carrier:
// the fake tmux's pane creation stands in for it (publishes the job file, then
// serves the stub ctl socket, or not, per `carrier`). `exec` and `stop` are sh
// shims that append to ONE order log, so rollback order is read from it. No real
// host, no real git, no mule: test/lease-spawn.integration.test.ts runs a real
// fake-carrier script on real tmux.

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
import {
  CarrierJobUnstoppedError,
  claimLeaseJobFile,
  defaultSpawnJobMs,
  LeaseJobInvalidError,
  LeaseJobTimeoutError,
  setLeaseClockForTests,
} from "../src/agents/lease-carrier.js";
import { rollbackSpawn } from "../src/agents/spawn.js";
import {
  AgentDiedOnSpawnError,
  AgentSpawnStartupError,
  deleteAgent,
  getAgent,
  insertAgent,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents.js";
import { getCarrierJob, listCarrierJobs } from "../src/carrier-jobs.js";
import { carrierJobFilePath, ctlSocketPath } from "../src/ctl/path.js";
import { encode, LineDecoder } from "../src/ctl/protocol.js";
import { type Db, openDb } from "../src/db.js";
import { addHost, HostProfileError, listHostChannels, runHostTemplate } from "../src/hosts.js";
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
let now: number;

const ENV_KEYS = [
  "MU_SPAWN_CTL_MS",
  "MU_SPAWN_LIVENESS_MS",
  "MU_SPAWN_JOB_MS",
  "MU_DB_PATH",
  "MU_STATE_DIR",
  "MU_SYNC_DIR",
];

const order = (): string[] =>
  existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n").filter(Boolean) : [];
const setStopExit = (code: number): void => writeFileSync(join(dir, "stop-exit"), String(code));
const channels = () => listHostChannels(db, "dev");
const jobFile = (name = "worker-1") => carrierJobFilePath("auth", name, dir);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mls-"));
  db = openDb({ path: join(dir, "mu.db") });
  orderLog = join(dir, "order");
  servers = [];
  atPane = undefined;
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
  *'worktree remove'*) echo "exec rm" >> '${orderLog}'; echo "MU_RM removed" ;;
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

describe("a lease spawn records its job and holds no channel", () => {
  it("the handshake records carrier_jobs (id + pane, admitted stop); no host_channels row at the pane or after", async () => {
    const a = await spawn({ cwd: "/srv/repo" });
    expect(a).toMatchObject({ host: "dev", ctl: "ok" });
    expect(getCarrierJob(db, a.incarnation)).toMatchObject({
      agentId: a.incarnation,
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      job: "job-1",
      hostStop: STOP(stopScript),
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
    expect(getCarrierJob(db, a.incarnation)?.job).toBe("job-1");
    process.env.MU_SPAWN_CTL_MS = "0";
    carrier = { handle: "job-2", ctl: false };
    const b = await spawn({ name: "worker-2", cwd: "/srv/repo" });
    expect(b.ctl).toBe("skipped");
    expect(getCarrierJob(db, b.incarnation)?.job).toBe("job-2");
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
  it("a live pane with no job file by the deadline (even under --no-ctl): pane killed, no row, tree removed, nothing stopped", async () => {
    carrier = { ctl: false };
    // A stale file of an earlier, stopped incarnation: removed inside the lock, never read as this job.
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "old-job\n");
    const err = await spawn({ worktree: true, ctl: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseJobTimeoutError);
    expect((err as Error).message).toContain("MU_SPAWN_JOB_MS");
    expect(now).toBeGreaterThanOrEqual(2000);
    expect(state.panes.size).toBe(0);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(order()).toEqual(["exec add", "exec rm"]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(listRemoteRecoveries(db)).toEqual([]);
  });

  it("a pane that dies before writing the file: AgentDiedOnSpawnError with its scrollback, nothing stopped", async () => {
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
    expect(order()).toEqual(["exec add", "exec rm"]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("a job file that is not a handle: rolled back, the tree kept (a job may exist)", async () => {
    carrier = { handle: "not a handle!", ctl: false };
    const err = await spawn({ worktree: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseJobInvalidError);
    expect(order()).toEqual(["exec add"]);
    expect(listRemoteRecoveries(db)).toMatchObject([{ name: "worker-1", cwd: WT }]);
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

  it("a reread handle whose agent row reconcile already removed is still persisted before the stop", async () => {
    const row = insertAgent(db, {
      name: "worker-1",
      workstream: "auth",
      paneId: "%77",
      host: "dev",
    });
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "job-5\n");
    deleteAgent(db, "worker-1", "auth"); // reconcile's prune
    setStopExit(1);
    await rollbackSpawn(db, "worker-1", "%77", undefined, row.incarnation, "auth", undefined, {
      host: "dev",
      stop: STOP(stopScript),
    });
    expect(order()).toEqual(["stop job-5"]);
    expect(getCarrierJob(db, row.incarnation)).toMatchObject({ job: "job-5", host: "dev" });
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
    // The in-lock check refuses too, and leaves the file the old job may name.
    writeFileSync(jobFile(), "job-9\n");
    expect(() => claimLeaseJobFile(db, "auth", "worker-1")).toThrow(CarrierJobUnstoppedError);
    expect(existsSync(jobFile())).toBe(true);
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
