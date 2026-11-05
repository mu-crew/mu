// Leftovers in `mu agent list` (spec docs/specs/2026-11-04-lease-adopt.md § G4 mu_list), fast
// tier. A reaped lease agent (row gone, reservation + recovery kept) is a `lease-job`; any
// other remote recovery record is a `recovery`. Each `next` is a preview: reattach when the
// shared preflight is clear, else the close. The mu-side stop-failure record lifecycle too.
// Fake tmux; `stop` and `exec` are sh shims logging to one order log.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dropStopFailed,
  rollbackLeaseJob,
  stopLeaseReservation,
} from "../src/agents/lease-carrier.js";
import { markerPath } from "../src/agents/reattach-marker.js";
import { deleteAgent, insertAgent } from "../src/agents.js";
import {
  bindCarrierJobAgent,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJobByName,
  markCarrierLaunch,
  reserveCarrierJob,
} from "../src/carrier-jobs.js";
import { carrierJobFilePath } from "../src/ctl/path.js";
import { type Db, openDb } from "../src/db.js";
import * as execFile from "../src/exec-file.js";
import { addHost } from "../src/hosts.js";
import { listLeftovers } from "../src/leftovers.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { installMux, type MuxHarness } from "./_mux.js";
import { runCli, runCliJson } from "./_runCli.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

vi.mock("../src/exec-file.js", async (orig) => {
  const real = await orig<typeof import("../src/exec-file.js")>();
  return {
    ...real,
    execGroupCapture: vi.fn(real.execGroupCapture),
    execFileCapture: vi.fn(real.execFileCapture),
  };
});

const real = await vi.importActual<typeof import("../src/exec-file.js")>("../src/exec-file.js");
const BASE = "b".repeat(40);
const WT = "/home/u/.local/state/mu-next/remote-worktrees/auth/worker-1";

let dir: string;
let dbPath: string;
let db: Db;
let mux: MuxHarness;
let state: MockState;
let orderLog: string;
let stop: string;
let saved: Record<string, string | undefined>;
const ENV_KEYS = ["MU_DB_PATH", "MU_STATE_DIR", "MU_SYNC_DIR"];

const order = (): string[] =>
  existsSync(orderLog) ? readFileSync(orderLog, "utf8").trim().split("\n").filter(Boolean) : [];
const jobFile = () => carrierJobFilePath("auth", "worker-1", dir);
const record = (job: string) => `${jobFile()}.${job}.stop-failed`;
const reservation = (): CarrierJob => {
  const r = getCarrierJobByName(db, "auth", "worker-1");
  if (r === undefined) throw new Error("no reservation");
  return r;
};
const deadPid = (): number => spawnSync("true").pid ?? 999_999;
const leftovers = () => listLeftovers(db, "auth");
const REATTACH = "mu agent reattach worker-1 -w auth";
const CLOSE = "mu agent close worker-1 -w auth";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mlo-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  orderLog = join(dir, "order");
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.MU_DB_PATH = dbPath;
  process.env.MU_STATE_DIR = join(dir, "state");
  process.env.MU_SYNC_DIR = join(dir, "sync");
  const sh = (file: string, body: string): string => {
    writeFileSync(join(dir, file), `#!/bin/sh\n${body}\n`);
    return `/bin/sh ${join(dir, file)}`;
  };
  stop = `${sh("stop.sh", `echo "stop $1" >> '${orderLog}'`)} {job}`;
  addHost(db, {
    name: "dev",
    transport: "lease",
    shell: "carrier J={job_file} L={local_sock} R={remote_sock} C={cwd} {env} -- {cmd}",
    exec: `${sh("exec.sh", `echo "exec $*" >> '${orderLog}'`)} {cmd}`,
    stop,
    attach:
      "carrier --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}",
    fetch: "true",
    repo: "/srv/repo",
    max_sessions: 1,
  });
  state = freshMockState();
  mux = installMux("tmux", mockTmux(state).executor);
  vi.mocked(execFile.execGroupCapture).mockClear();
  vi.mocked(execFile.execFileCapture).mockClear();
});

afterEach(() => {
  mux.restore();
  vi.mocked(execFile.execGroupCapture).mockImplementation(real.execGroupCapture);
  vi.mocked(execFile.execFileCapture).mockImplementation(real.execFileCapture);
  db.close();
  rmFixtureDir(dir);
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A remote `--worktree` row of `name`, deleted: the trigger leaves its recovery record. */
function reapedTree(name: string, cwd: string): number {
  const row = insertAgent(db, {
    name,
    workstream: "auth",
    paneId: "%80",
    host: "dev",
    cwd,
    base: BASE,
    repo: "/srv/repo",
  });
  deleteAgent(db, name, "auth");
  return row.incarnation;
}

/**
 * A lease agent the reaper removed: its pane gone, its row deleted (a `--worktree` row leaves
 * a recovery record), its reservation (launched, bound, handle known) and job file kept.
 */
function reaped(over: { worktree?: boolean; job?: string } = {}): number {
  const r = reserveCarrierJob(db, {
    workstream: "auth",
    name: "worker-1",
    host: "dev",
    hostStop: stop,
    creatorPid: deadPid(),
  });
  if (r === undefined) throw new Error("reserved already");
  markCarrierLaunch(db, r.token);
  const row = insertAgent(db, {
    name: "worker-1",
    workstream: "auth",
    paneId: "%90",
    host: "dev",
    hostTransport: "lease",
    reservation: r.token,
    ...(over.worktree === false
      ? { cwd: "/srv/repo" }
      : { cwd: WT, base: BASE, repo: "/srv/repo" }),
  });
  const job = over.job ?? "job-1";
  bindCarrierJobAgent(db, r.token, row.incarnation, "%90");
  fillCarrierJob(db, r.token, job);
  mkdirSync(dirname(jobFile()), { recursive: true });
  writeFileSync(jobFile(), `${job}\n`);
  deleteAgent(db, "worker-1", "auth");
  return row.incarnation;
}

/** A pre-reservation-shape second reservation of worker-1 (legacy ordinal 1). */
const legacySecond = (agentId: number | null) =>
  db
    .prepare(
      "INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, launch, agent_id, created_at, ordinal) VALUES ('t2','auth','worker-1','dev','x','none',?,?,1)",
    )
    .run(agentId, new Date().toISOString());

describe("lease-job leftovers", () => {
  it("a reaped lease --worktree agent: one lease-job, its record folded in, next = the reattach preview", async () => {
    const agentId = reaped();
    expect(await leftovers()).toEqual([
      {
        kind: "lease-job",
        name: "worker-1",
        host: "dev",
        job: "job-1",
        agent_id: agentId,
        recovery_id: agentId,
        stop_failed: null,
        next: REATTACH,
      },
    ]);
  });

  it("a --cwd lease agent: no record to fold", async () => {
    const agentId = reaped({ worktree: false });
    expect(await leftovers()).toEqual([
      expect.objectContaining({ kind: "lease-job", agent_id: agentId, recovery_id: null }),
    ]);
  });

  const blocked: [string, () => void][] = [
    ["no attach template", () => db.prepare("UPDATE host_profiles SET attach = NULL").run()],
    [
      "a live previous pane",
      () => state.panes.set("%90", { windowId: "@1", paneId: "%90", command: "carrier" }),
    ],
    ["a conflicting job file", () => writeFileSync(jobFile(), "job-2\n")],
    [
      "a pending reattach marker",
      () => {
        const path = markerPath(db, "auth", "worker-1");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ job: "job-1", pid: 1 }));
      },
    ],
  ];
  for (const [what, block] of blocked) {
    it(`a blocker (${what}) gives the close preview`, async () => {
      reaped();
      block();
      expect((await leftovers()).map((l) => l.next)).toEqual([CLOSE]);
    });
  }

  it("two reservations (legacy ordinals): one leftover each, both the close preview; the record folds into the matching agent_id only", async () => {
    const agentId = reaped();
    legacySecond(agentId + 100);
    const out = await leftovers();
    expect(out.map((l) => [l.kind, l.agent_id, l.recovery_id, l.next])).toEqual([
      ["lease-job", agentId, agentId, CLOSE],
      ["lease-job", agentId + 100, null, CLOSE],
    ]);
  });

  it("another incarnation's record stays a separate recovery, with --recovery", async () => {
    const old = reapedTree("worker-1", `${WT}-old`);
    const agentId = reaped();
    expect((await leftovers()).map((l) => [l.kind, l.recovery_id, l.next])).toEqual([
      ["lease-job", agentId, REATTACH],
      ["recovery", old, `${CLOSE} --recovery ${old}`],
    ]);
    // Blocked with several records: the close names the folded one.
    db.prepare("UPDATE host_profiles SET attach = NULL").run();
    expect((await leftovers())[0]?.next).toBe(`${CLOSE} --recovery ${agentId}`);
  });
});

describe("recovery leftovers", () => {
  it("a bare record, also with a live agent of the name: close … --recovery <id>", async () => {
    const id = reapedTree("worker-2", "/home/u/wt/worker-2");
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%5", cli: "pi" });
    state.panes.set("%5", { windowId: "@1", paneId: "%5", command: "pi" });
    expect(await leftovers()).toEqual([
      {
        kind: "recovery",
        name: "worker-2",
        host: "dev",
        job: null,
        agent_id: id,
        recovery_id: id,
        stop_failed: null,
        next: `mu agent close worker-2 -w auth --recovery ${id}`,
      },
    ]);
  });

  it("a live agent's reservation and other workstreams are not listed", async () => {
    reaped();
    ensureWorkstream(db, "other");
    expect(await listLeftovers(db, "other")).toEqual([]);
    const r = reserveCarrierJob(db, {
      workstream: "other",
      name: "w",
      host: "dev",
      hostStop: stop,
    });
    if (r === undefined) throw new Error("reserved");
    markCarrierLaunch(db, r.token);
    const row = insertAgent(db, {
      name: "w",
      workstream: "other",
      paneId: "%6",
      host: "dev",
      hostTransport: "lease",
      reservation: r.token,
    });
    bindCarrierJobAgent(db, r.token, row.incarnation, "%6");
    fillCarrierJob(db, r.token, "job-6");
    expect(await listLeftovers(db, "other")).toEqual([]);
    expect((await leftovers()).map((l) => l.name)).toEqual(["worker-1"]);
  });
});

describe("stop_failed", () => {
  it("the record's line, escaped and cut with cut=", async () => {
    reaped();
    writeFileSync(record("job-1"), `job-1 x\t${"é".repeat(200)}\n`);
    const [l] = await leftovers();
    // "job-1 x\\t" is 9 chars once escaped, then 200: 160 kept, 49 cut.
    expect(l?.stop_failed).toBe(`job-1 x\\t${"é".repeat(151)} cut=49`);
    expect(JSON.stringify(l).length).toBeLessThan(400);
    writeFileSync(record("job-1"), "job-1 on dev not stopped: no control master\n");
    expect((await leftovers())[0]?.stop_failed).toBe("job-1 on dev not stopped: no control master");
  });

  it("a record of another id, by path or by content, is not shown and the file is kept", async () => {
    reaped();
    writeFileSync(record("job-9"), "job-9 on dev not stopped\n");
    expect((await leftovers())[0]?.stop_failed).toBeNull();
    writeFileSync(record("job-1"), "job-9 on dev not stopped\n");
    expect((await leftovers())[0]?.stop_failed).toBeNull();
    expect(existsSync(record("job-9"))).toBe(true);
    expect(existsSync(record("job-1"))).toBe(true);
  });

  it("after name reuse an old child's late write is not shown; a late delete removes only its own path", async () => {
    reaped({ job: "job-2" });
    writeFileSync(record("job-1"), "job-1 on dev not stopped: late\n");
    expect((await leftovers())[0]?.stop_failed).toBeNull();
    writeFileSync(record("job-2"), "job-2 on dev not stopped: mine\n");
    dropStopFailed(jobFile(), "job-1");
    expect(existsSync(record("job-1"))).toBe(false);
    expect((await leftovers())[0]?.stop_failed).toBe("job-2 on dev not stopped: mine");
  });
});

describe("record lifecycle (mu side)", () => {
  const seed = () => {
    writeFileSync(record("job-1"), "job-1 on dev not stopped: no control master\n");
    writeFileSync(record("job-9"), "job-9 other\n");
  };

  it("a stop removes the job's record, with no job file; another id's stays", async () => {
    reaped();
    rmSync(jobFile());
    seed();
    const close = await stopLeaseReservation(db, reservation());
    expect(close?.action).toBe("stopped");
    expect(order()).toContain("stop job-1");
    expect(existsSync(record("job-1"))).toBe(false);
    expect(existsSync(record("job-9"))).toBe(true);
  });

  it("a rollback's stop removes it", async () => {
    reaped();
    seed();
    const r = reservation();
    const out = await rollbackLeaseJob(
      db,
      { workstream: "auth", name: "worker-1", token: r.token },
      true,
    );
    expect(out).toBe("stopped");
    expect(existsSync(record("job-1"))).toBe(false);
    expect(existsSync(record("job-9"))).toBe(true);
  });

  it("an abandon keeps it", async () => {
    reaped();
    seed();
    const close = await stopLeaseReservation(db, reservation(), { abandon: true });
    expect(close?.action).toBe("abandon");
    expect(order()).toEqual([]);
    expect(existsSync(record("job-1"))).toBe(true);
  });
});

describe("agent list", () => {
  it("--json and bare carry data.leftovers; --table prints the section", async () => {
    const agentId = reaped();
    writeFileSync(record("job-1"), "job-1 on dev not stopped: no control master\n");
    const j = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    expect(j.exitCode, j.stderr).toBeNull();
    expect(j.data.leftovers).toEqual([
      expect.objectContaining({ kind: "lease-job", job: "job-1", next: REATTACH }),
    ]);
    expect(j.doc.next).toBeNull();
    const bare = await runCliJson(["agent", "list", "-w", "auth"], dbPath);
    expect(bare.data.leftovers).toEqual(j.data.leftovers);
    const t = await runCli(["agent", "list", "-w", "auth", "--table"], dbPath);
    expect(t.stdout).toContain("Leftovers (1)");
    expect(t.stdout).toContain(
      `  worker-1  lease-job on dev job=job-1 recovery=${agentId} stop failed: job-1 on dev not stopped: no control master  → ${REATTACH}`,
    );
  });

  it("runs no host command (an exec stub that throws)", async () => {
    reaped();
    writeFileSync(record("job-1"), "job-1 on dev not stopped\n");
    const boom = () => {
      throw new Error("a host command ran");
    };
    vi.mocked(execFile.execGroupCapture).mockImplementation(boom);
    vi.mocked(execFile.execFileCapture).mockImplementation(boom);
    expect((await leftovers()).map((l) => l.next)).toEqual([REATTACH]);
    const j = await runCliJson(["agent", "list", "-w", "auth", "--json"], dbPath);
    expect(j.exitCode, j.stderr).toBeNull();
    expect(j.data.leftovers).toHaveLength(1);
    expect(execFile.execGroupCapture).not.toHaveBeenCalled();
    expect(execFile.execFileCapture).not.toHaveBeenCalled();
    expect(order()).toEqual([]);
  });
});
