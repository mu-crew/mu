// `agent close` of a LEASE agent (spec 2026-10-28-lease-transport.md, § agent close,
// § No agent row left), fast tier. The pane is a fake-tmux pane; `stop` and `exec` are
// sh shims appending to ONE order log, and the mux wrapper logs the kill and the
// liveness probe of the agent's pane there too, so the close order is read from it.
// No real host, no real git, no mule.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CarrierJobKeptError,
  CarrierJobUnresolvedError,
  CarrierJobUnstoppedError,
} from "../src/agents/lease-carrier.js";
import {
  type AgentRow,
  closeAgent,
  deleteAgent,
  getAgent,
  insertAgent,
  previewClose,
} from "../src/agents.js";
import { applyOp, type Op } from "../src/apply.js";
import {
  bindCarrierJobAgent,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJobByName,
  listCarrierJobs,
  markCarrierLaunch,
  noteCarrierJob,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { CarrierStopFailedError, CarrierStopRefusedError } from "../src/carrier-stop.js";
import { cmdDbQuery } from "../src/cli/db-query.js";
import { carrierJobFilePath, ctlSocketPath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { addHost, HostHandbackError } from "../src/hosts.js";
import { listLogs } from "../src/logs.js";
import { reconcile } from "../src/reconcile.js";
import { collectRemoteAgent } from "../src/remote-collect.js";
import { listRemoteRecoveries } from "../src/remote-recovery.js";
import { agentRevision, RevisionMismatchError } from "../src/revision.js";
import { teardownWorkstream, workstreamRevision } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

const BASE = "b".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";
const STOP = (script: string) => `/bin/sh ${script} {job}`;

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let orderLog: string;
let stopScript: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR"];

const order = (): string[] =>
  existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n").filter(Boolean) : [];
const log = (line: string): void => writeFileSync(orderLog, `${line}\n`, { flag: "a" });
const setStopExit = (code: number): void => writeFileSync(join(dir, "stop-exit"), String(code));
const jobFile = (name = "worker-1") => carrierJobFilePath("auth", name, dir);
const writeJobFile = (handle: string, name = "worker-1"): void => {
  mkdirSync(dirname(jobFile(name)), { recursive: true });
  writeFileSync(jobFile(name), `${handle}\n`);
};
const reservation = (name = "worker-1"): CarrierJob | undefined =>
  getCarrierJobByName(db, "auth", name);
const close = (over: Partial<Parameters<typeof closeAgent>[2]> = {}) =>
  closeAgent(db, "worker-1", { workstream: "auth", ...over });
const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mlc-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  orderLog = join(dir, "order");
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_DB_PATH = dbPath;
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  const fakeExec = join(dir, "fake-exec.sh");
  writeFileSync(
    fakeExec,
    `#!/bin/sh
case "$1" in
  *MU_RM*) echo "exec rm" >> '${orderLog}'; echo "MU_RM removed" ;;
  *MU_STATE*) echo "exec observe" >> '${orderLog}'; echo "MU_STATE clean ${BASE}" ;;
  *) echo "exec other" >> '${orderLog}' ;;
esac
`,
  );
  chmodSync(fakeExec, 0o755);
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
  const fake = mockTmux(state).executor;
  mux = installMux("tmux", async (args) => {
    const target = args[args.indexOf("-t") + 1] ?? "";
    if (args[0] === "kill-pane") log(`kill ${target}`);
    if (args[0] === "display-message") log(`alive? ${target}`);
    return fake(args);
  });
});

afterEach(() => {
  mux.restore();
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A pane the fake tmux knows (alive until killed). */
function pane(id: string): string {
  state.panes.set(id, { windowId: "@1", paneId: id, command: "carrier" });
  return id;
}

/**
 * A lease agent as a finished spawn leaves it: the reservation (launched, bound to the
 * row and its pane), the row, and (unless `handle` is null) the handle in the
 * reservation and the job file. `worktree`: a `--worktree` row (remote cwd, base, repo).
 */
function leaseAgent(
  over: {
    name?: string;
    handle?: string | null;
    worktree?: boolean;
    paneId?: string;
    fill?: boolean;
  } = {},
): { row: AgentRow; r: CarrierJob } {
  const name = over.name ?? "worker-1";
  const paneId = pane(over.paneId ?? "%5");
  const r = reserveCarrierJob(db, {
    workstream: "auth",
    name,
    host: "dev",
    hostStop: STOP(stopScript),
    creatorPid: process.pid,
  });
  if (r === undefined) throw new Error("reserved already");
  markCarrierLaunch(db, r.token);
  const row = insertAgent(db, {
    name,
    workstream: "auth",
    paneId,
    host: "dev",
    reservation: r.token,
    ...(over.worktree === true ? { cwd: WT, base: BASE, repo: "/srv/repo" } : { cwd: "/srv/repo" }),
  });
  bindCarrierJobAgent(db, r.token, row.incarnation, paneId);
  const handle = over.handle === undefined ? "job-1" : over.handle;
  if (handle !== null) {
    writeJobFile(handle, name);
    if (over.fill !== false) fillCarrierJob(db, r.token, handle);
  }
  return { row, r };
}

describe("close of a live lease agent: stop after the liveness proof, before the tree", () => {
  it("order by log: kill, liveness proof, stop, then the worktree rule; everything is gone after", async () => {
    leaseAgent({ worktree: true });
    mkdirSync(dirname(ctlSocketPath("auth", "worker-1", dir)), { recursive: true });
    writeFileSync(ctlSocketPath("auth", "worker-1", dir), "");
    const res = await close();
    expect(order()).toEqual(["kill %5", "alive? %5", "stop job-1", "exec observe", "exec rm"]);
    expect(res).toMatchObject({
      killedPane: true,
      deletedRow: true,
      worktree: { action: "removed" },
      carrierJobs: [{ host: "dev", job: "job-1", action: "stopped" }],
    });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(listCarrierJobs(db)).toEqual([]);
    expect(existsSync(jobFile())).toBe(false);
    expect(existsSync(ctlSocketPath("auth", "worker-1", dir))).toBe(false);
    expect(listRemoteRecoveries(db)).toEqual([]);
    const said = listLogs(db, { workstream: "auth" }).map((l) => l.payload);
    expect(said).toContainEqual(expect.stringContaining("job job-1 on dev stopped"));
  });

  it("a --cwd lease agent: kill, liveness, stop; no host command for a tree", async () => {
    leaseAgent();
    await close();
    expect(order()).toEqual(["kill %5", "alive? %5", "stop job-1"]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("a stop that exits 1 keeps the agent row and the reservation, names stderr; a retry closes", async () => {
    const { row } = leaseAgent({ worktree: true });
    setStopExit(1);
    const err = await failure(close());
    expect(err).toBeInstanceOf(CarrierStopFailedError);
    expect((err as Error).message).toContain("stop said no");
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(row.incarnation);
    expect(reservation()).toMatchObject({ job: "job-1", agentId: row.incarnation });
    expect(existsSync(jobFile())).toBe(true);
    expect(order()).not.toContain("exec observe");
    setStopExit(0);
    await close();
    expect(order().slice(-3)).toEqual(["stop job-1", "exec observe", "exec rm"]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("exit 3 is a hand-back: HostHandbackError, agent row and reservation kept; the CLI says human needed", async () => {
    leaseAgent();
    setStopExit(3);
    expect(await failure(close())).toBeInstanceOf(HostHandbackError);
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(reservation()?.job).toBe("job-1");
    const rev = agentRevision(db, "auth", "worker-1");
    const r = await runCliJson(
      ["agent", "close", "worker-1", "-w", "auth", "--if", String(rev), "--json"],
      dbPath,
    );
    expect(r.exitCode).toBe(5);
    expect(r.doc).toMatchObject({ ok: false, data: { handback: true, template: "stop" } });
    expect(reservation()?.job).toBe("job-1");
  });

  it("--force does not skip the stop", async () => {
    leaseAgent();
    setStopExit(1);
    expect(await failure(close({ force: true }))).toBeInstanceOf(CarrierStopFailedError);
    expect(order()).toContain("stop job-1");
    expect(reservation()?.job).toBe("job-1");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });

  it("--abandon-job drops the handle WITHOUT a stop, with an event naming host and handle; the job file stays", async () => {
    leaseAgent({ worktree: true });
    setStopExit(1);
    const res = await close({ abandonJob: true });
    expect(order()).not.toContainEqual(expect.stringMatching(/^stop/));
    expect(order()).toEqual(["kill %5", "alive? %5", "exec observe", "exec rm"]);
    expect(res.carrierJobs).toEqual([{ host: "dev", job: "job-1", action: "abandon" }]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(readFileSync(jobFile(), "utf8")).toBe("job-1\n");
    const event = listLogs(db, { workstream: "auth" })
      .map((l) => l.payload)
      .find((p) => p.includes("--abandon-job"));
    expect(event).toContain("on dev");
    expect(event).toContain("job job-1");
  });

  it("a session agent's close is unchanged: no stop, no carrier_jobs read", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: pane("%9"), cwd: dir });
    const res = await close();
    expect(order()).toEqual(["kill %9", "alive? %9"]);
    expect(res.carrierJobs).toBeUndefined();
  });

  it("a stopped job whose job file now names another handle keeps the reservation and refuses", async () => {
    leaseAgent({ worktree: true });
    writeJobFile("job-2");
    expect(await failure(close())).toBeInstanceOf(CarrierJobKeptError);
    expect(order()).toEqual(["kill %5", "alive? %5", "stop job-1"]);
    expect(reservation()?.job).toBe("job-1");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
  });
});

describe("close before the handshake recorded the handle", () => {
  it("reads the job file at the derived path, fills the handle, and stops it", async () => {
    leaseAgent({ handle: "job-7", fill: false });
    expect(reservation()?.job).toBeNull();
    const res = await close();
    expect(order()).toEqual(["kill %5", "alive? %5", "stop job-7"]);
    expect(res.carrierJobs).toEqual([{ host: "dev", job: "job-7", action: "stopped" }]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(existsSync(jobFile())).toBe(false);
  });

  it("neither handle nor file: refuses `spawn in progress`, keeps everything", async () => {
    const { row } = leaseAgent({ handle: null });
    const err = await failure(close());
    expect(err).toBeInstanceOf(CarrierJobUnresolvedError);
    expect((err as Error).message).toMatch(/spawn in progress/);
    expect((err as Error).message).toContain("--abandon-job");
    expect(order()).not.toContainEqual(expect.stringMatching(/^stop/));
    expect(getAgent(db, "worker-1", "auth")?.incarnation).toBe(row.incarnation);
    expect(reservation()?.launch).toBe("intent");
    const cli = await runCliJson(
      [
        "agent",
        "close",
        "worker-1",
        "-w",
        "auth",
        "--if",
        String(agentRevision(db, "auth", "worker-1")),
        "--json",
      ],
      dbPath,
    );
    expect(cli.exitCode).toBe(4);
  });

  it("an invalid job file is noted and refuses; nothing stopped, nothing removed", async () => {
    leaseAgent({ handle: null, worktree: true });
    mkdirSync(dirname(jobFile()), { recursive: true });
    writeFileSync(jobFile(), "not a handle!\n");
    expect(await failure(close())).toBeInstanceOf(CarrierJobUnresolvedError);
    expect(order()).toEqual(["kill %5", "alive? %5"]);
    expect(reservation()?.reason).toContain("not a handle");
  });

  it("a lease agent whose reservation a raw delete removed refuses while its job file names a job", async () => {
    leaseAgent();
    db.prepare("DELETE FROM carrier_jobs").run();
    const err = await failure(close());
    expect(err).toBeInstanceOf(CarrierJobUnresolvedError);
    expect((err as Error).message).toContain("job-1");
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    await close({ abandonJob: true });
    expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
  });
});

describe("agentRevision includes the handle", () => {
  it("a preview taken before the handle landed fails --if; nothing is killed or stopped", async () => {
    const { r } = leaseAgent({ handle: null });
    const before = await previewClose(db, "worker-1", { workstream: "auth" });
    expect(before.carrierJob).toMatchObject({ host: "dev", job: null, launch: "intent" });
    fillCarrierJob(db, r.token, "job-1");
    expect(agentRevision(db, "auth", "worker-1")).not.toBe(before.revision);
    expect(await failure(close({ ifRevision: before.revision }))).toBeInstanceOf(
      RevisionMismatchError,
    );
    expect(order()).toEqual([]);
    const after = await previewClose(db, "worker-1", { workstream: "auth" });
    expect(after.carrierJob?.job).toBe("job-1");
    await close({ ifRevision: after.revision });
    expect(order()).toContain("stop job-1");
  });

  it("the handle's absence counts too: a reservation removed under a preview moves it", () => {
    leaseAgent();
    const rev = agentRevision(db, "auth", "worker-1");
    db.prepare("DELETE FROM carrier_jobs").run();
    expect(agentRevision(db, "auth", "worker-1")).not.toBe(rev);
  });
});

describe("every deletion path keeps the handle; close-by-name then stops it", () => {
  const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
  const tombstone = (key: string): Op => ({
    hlc: formatHlc({ wallMs: 2_000_000_000_000 + 9_000_000, counter: 0, machineId: PEER }),
    machineId: PEER,
    groupId: `g-${key}`,
    actor: "peer",
    intent: "workstream.teardown",
    entity: "workstream",
    key,
    op: "del",
    payload: "{}",
  });
  const sql = async (q: string): Promise<void> => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmdDbQuery(db, q, { write: true });
    } finally {
      out.mockRestore();
    }
  };
  const paths: [string, () => Promise<unknown>][] = [
    ["reconcile prune", () => reconcile(db, { workstream: "auth" })],
    [
      "teardown",
      () =>
        teardownWorkstream(db, { workstream: "auth", ifRevision: workstreamRevision(db, "auth") }),
    ],
    ["workstream delete", async () => applyOp(db, tombstone("auth"))],
    ["raw mu sql --write DELETE", () => sql("DELETE FROM agents")],
  ];
  for (const worktree of [false, true]) {
    for (const [what, remove] of paths) {
      it(`${what} (${worktree ? "--worktree" : "--cwd"}): the reservation survives, close-by-name stops it`, async () => {
        const { row } = leaseAgent({ worktree });
        state.panes.delete("%5"); // the carrier's pane died (kill -9)
        await remove();
        writeFileSync(orderLog, ""); // the deletion path's own pane probes are not the close's
        expect(getAgent(db, "worker-1", "auth")).toBeUndefined();
        expect(reservation()).toMatchObject({ job: "job-1", agentId: row.incarnation });
        const p = await previewClose(db, "worker-1", { workstream: "auth" });
        expect(p.kind).toBe(worktree ? "recovery" : "lease-job");
        expect(p.carrierJob?.job).toBe("job-1");
        const res = await close({ ifRevision: p.revision });
        expect(order()).toEqual(
          worktree ? ["stop job-1", "exec observe", "exec rm"] : ["stop job-1"],
        );
        expect(res.carrierJobs).toEqual([{ host: "dev", job: "job-1", action: "stopped" }]);
        expect(listCarrierJobs(db)).toEqual([]);
        expect(listRemoteRecoveries(db)).toEqual([]);
        expect(existsSync(jobFile())).toBe(false);
      });
    }
  }

  it("a by-name stop that fails keeps the reservation AND the recovery record; nothing is removed", async () => {
    leaseAgent({ worktree: true });
    deleteAgent(db, "worker-1", "auth");
    setStopExit(1);
    expect(await failure(close())).toBeInstanceOf(CarrierStopFailedError);
    expect(order()).toEqual(["stop job-1"]);
    expect(reservation()?.job).toBe("job-1");
    expect(listRemoteRecoveries(db)).toHaveLength(1);
  });

  it("a changed stop template refuses the by-name stop, naming the handle; nothing runs", async () => {
    leaseAgent();
    deleteAgent(db, "worker-1", "auth");
    db.prepare("UPDATE host_profiles SET stop = 'other {job}' WHERE name = 'dev'").run();
    const err = await failure(close());
    expect(err).toBeInstanceOf(CarrierStopRefusedError);
    expect((err as Error).message).toContain("job-1");
    expect(order()).toEqual([]);
    expect(reservation()?.job).toBe("job-1");
  });

  it("the CLI closes by name with -w (exit 0) and with --abandon-job drops it", async () => {
    leaseAgent({ name: "worker-2", paneId: "%6" });
    deleteAgent(db, "worker-2", "auth");
    const preview = await runCliJson(
      ["agent", "close", "worker-2", "-w", "auth", "--json"],
      dbPath,
    );
    expect(preview.data).toMatchObject({ kind: "lease-job", carrierJob: { job: "job-1" } });
    const rev = (preview.data as { revision: number }).revision;
    setStopExit(1);
    const failed = await runCliJson(
      ["agent", "close", "worker-2", "-w", "auth", "--if", String(rev), "--json"],
      dbPath,
    );
    expect(failed.exitCode).toBe(5);
    const r = await runCliJson(
      ["agent", "close", "worker-2", "-w", "auth", "--abandon-job", "--if", String(rev), "--json"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(r.data).toMatchObject({ carrierJobs: [{ job: "job-1", action: "abandon" }] });
    expect(reservation("worker-2")).toBeUndefined();
  });

  it("agent collect <name> never stops a job", async () => {
    leaseAgent();
    deleteAgent(db, "worker-1", "auth");
    await failure(collectRemoteAgent(db, { workstream: "auth", name: "worker-1", repo: dir }));
    expect(order()).toEqual([]);
    expect(reservation()?.job).toBe("job-1");
  });
});

describe("close-by-name of a reservation with no handle", () => {
  it("never launched, creator proven gone: released without a stop or --abandon-job", async () => {
    const dead = spawnSync("true").pid ?? 999_999;
    reserveCarrierJob(db, {
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      hostStop: STOP(stopScript),
      creatorPid: dead,
    });
    const res = await close();
    expect(res.carrierJobs).toEqual([{ host: "dev", job: null, action: "unlaunched" }]);
    expect(order()).toEqual([]);
    expect(listCarrierJobs(db)).toEqual([]);
  });

  it("launched (intent) with no handle: refuses with the facts; --abandon-job drops it, the file left", async () => {
    const r = reserveCarrierJob(db, {
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      hostStop: STOP(stopScript),
      creatorPid: process.pid,
    });
    if (r === undefined) throw new Error("reserved");
    markCarrierLaunch(db, r.token);
    const err = await failure(close());
    expect(err).toBeInstanceOf(CarrierJobUnresolvedError);
    expect((err as Error).message).toMatch(/launch intent, pane none, creator pid \d+/);
    expect(reservation()?.token).toBe(r.token);
    await close({ abandonJob: true });
    expect(listCarrierJobs(db)).toEqual([]);
    expect(order()).toEqual([]);
  });

  it("launched, then the carrier published late: close-by-name fills the handle and stops it", async () => {
    const r = reserveCarrierJob(db, {
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      hostStop: STOP(stopScript),
      creatorPid: process.pid,
    });
    if (r === undefined) throw new Error("reserved");
    markCarrierLaunch(db, r.token);
    writeJobFile("late-1");
    await close();
    expect(order()).toEqual(["stop late-1"]);
    expect(listCarrierJobs(db)).toEqual([]);
    expect(existsSync(jobFile())).toBe(false);
  });
});

describe("a reservation kept for a tree its never-launched rollback could not remove", () => {
  const keptForTree = (): CarrierJob => {
    const r = reserveCarrierJob(db, {
      workstream: "auth",
      name: "worker-1",
      host: "dev",
      hostStop: STOP(stopScript),
      creatorPid: process.pid,
    });
    if (r === undefined) throw new Error("reserved already");
    noteCarrierJob(db, r.token, `remote worktree ${WT} on dev was not removed`);
    return r;
  };

  it("a respawn's refusal names the kept tree and --abandon-job, not a spawn in progress", () => {
    keptForTree();
    const err = new CarrierJobUnstoppedError("worker-1", reservation() as CarrierJob);
    expect(err.reason).toContain(WT);
    expect(err.message).toContain(WT);
    expect(err.message).toContain("--abandon-job");
    expect(err.message).not.toMatch(/in progress/);
  });

  it("close-by-name refuses naming the tree; --abandon-job releases it with the event", async () => {
    keptForTree();
    const err = await failure(close());
    expect(err).toBeInstanceOf(CarrierJobUnresolvedError);
    expect((err as Error).message).toContain(WT);
    expect((err as Error).message).toContain("--abandon-job");
    expect((err as Error).message).not.toMatch(/in progress/);
    const res = await close({ abandonJob: true });
    expect(res.carrierJobs).toEqual([{ host: "dev", job: null, action: "abandon" }]);
    expect(listCarrierJobs(db)).toEqual([]);
  });
});
