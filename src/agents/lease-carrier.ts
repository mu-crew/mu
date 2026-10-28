// mu — the lease half of `spawn --host` (spec 2026-10-28-lease-transport.md,
// § agent spawn --host on a lease profile): the refusals before any effect
// (assertLeaseSpawnable), the job file claimed inside the spawn lock
// (claimLeaseJobFile), the job handshake that records the carrier's handle
// (awaitLeaseJob) and the stop-first rollback (rollbackLeaseJob). spawn.ts
// holds only the call sites.
//
// A lease pane holds no host channel and its death is not the job's death: the
// handle the carrier wrote to `{job_file}` is the only way to stop the job, so
// it is persisted (`carrier_jobs`) before anything can delete the agent row,
// and only a successful stop deletes it.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  deleteCarrierJobAfterStop,
  getCarrierJob,
  insertCarrierJob,
  persistCarrierJob,
  unstoppedJobOfGoneAgent,
} from "../carrier-jobs.js";
import { runStop } from "../carrier-stop.js";
import { carrierJobFilePath } from "../ctl/path.js";
import type { Db } from "../db.js";
import { type HostProfile, HostProfileError, JOB_HANDLE_RE } from "../hosts.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import { isJsonMode } from "../output.js";
import { AgentDiedOnSpawnError } from "./errors.js";

/** A name whose older incarnation's job was never stopped: its handle is the last pointer. Exit 4. */
export class CarrierJobUnstoppedError extends Error {
  override readonly name = "CarrierJobUnstoppedError";
  constructor(
    public readonly agentName: string,
    public readonly handle: string,
    public readonly host: string,
  ) {
    super(say("carrier.job_unstopped", agentName, handle, host));
  }
}

/** The carrier's pane stayed alive and wrote no handle within MU_SPAWN_JOB_MS. Exit 1 (rolled back). */
export class LeaseJobTimeoutError extends Error {
  override readonly name = "LeaseJobTimeoutError";
  constructor(
    public readonly agentName: string,
    public readonly host: string,
    public readonly budgetMs: number,
    public readonly jobFile: string,
  ) {
    super(say("carrier.job_timeout", agentName, host, budgetMs, jobFile));
  }
}

/** The job file held something that is not a handle. Exit 1 (rolled back; the tree is kept). */
export class LeaseJobInvalidError extends Error {
  override readonly name = "LeaseJobInvalidError";
  constructor(
    public readonly agentName: string,
    public readonly jobFile: string,
    public readonly line: string,
  ) {
    super(say("carrier.job_invalid", agentName, jobFile, line));
  }
}

const DEFAULT_SPAWN_JOB_MS = 30_000;

type LeaseClock = { now(): number; delay(ms: number): Promise<void> };
const realClock: LeaseClock = { now: () => Date.now(), delay: (ms) => delay(ms) };
let clock = realClock;

/** TEST SEAM: drive the job handshake on a virtual clock (deadlines counted, not elapsed). */
export function setLeaseClockForTests(c: LeaseClock | undefined): void {
  clock = c ?? realClock;
}

/** Cadence of the job-file stat (no fork). */
const JOB_STAT_INTERVAL_MS = 50;
/** Cadence of the pane check (capture + liveness: ~2 forks). */
const JOB_PANE_INTERVAL_MS = 250;

/** The job handshake's budget: `MU_SPAWN_JOB_MS`, default 30 s. Never 0: a lease always waits for its handle. */
export function defaultSpawnJobMs(): number {
  const parsed = Number.parseInt(process.env.MU_SPAWN_JOB_MS ?? "", 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_SPAWN_JOB_MS : parsed;
}

/** The job file of (workstream, name), beside the agent's ctl socket (the DB's directory). */
export function leaseJobFile(db: Db, workstream: string, name: string): string {
  return carrierJobFilePath(workstream, name, dirname(db.name));
}

type JobFile =
  | { kind: "none" }
  | { kind: "handle"; job: string }
  | { kind: "invalid"; line: string };

/** One line, an opaque handle; mu parses nothing further. A missing or empty file is none (the carrier renames it in whole). */
export function readJobFile(path: string): JobFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { kind: "none" };
  }
  if (text === "") return { kind: "none" };
  const line = text.split("\n")[0]?.trim() ?? "";
  return JOB_HANDLE_RE.test(line) ? { kind: "handle", job: line } : { kind: "invalid", line };
}

/**
 * Refusals of a lease spawn before any effect: a command gate (mapping a carrier's exit to
 * a gate result is out of scope), and a name with an older incarnation's unstopped job.
 */
export function assertLeaseSpawnable(
  db: Db,
  workstream: string,
  name: string,
  profile: HostProfile,
  isGate: boolean,
): void {
  if (profile.transport !== "lease") return;
  if (isGate) throw new HostProfileError(say("carrier.lease_gate", profile.name));
  refuseUnstopped(db, workstream, name);
}

function refuseUnstopped(db: Db, workstream: string, name: string): void {
  const old = unstoppedJobOfGoneAgent(db, workstream, name);
  if (old !== undefined) throw new CarrierJobUnstoppedError(name, old.job, old.host);
}

/**
 * Inside the spawn lock, with the name owned: remove a leftover job file so any file seen
 * after the pane opens is this carrier's, unless an older incarnation's handle is still
 * unstopped (then refuse: that job must never lose its last pointer). Returns the path.
 */
export function claimLeaseJobFile(db: Db, workstream: string, name: string): string {
  refuseUnstopped(db, workstream, name);
  const path = leaseJobFile(db, workstream, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  return path;
}

/**
 * The job handshake: mandatory for a lease, independent of ctl, `--no-ctl` and
 * MU_SPAWN_CTL_MS. Waits for the job file, records the handle in ONE statement guarded by
 * the row's id + pane, and returns it. A pane that dies first is AgentDiedOnSpawnError
 * with its scrollback; a live pane with no file by the deadline is LeaseJobTimeoutError.
 */
export async function awaitLeaseJob(
  db: Db,
  a: {
    workstream: string;
    name: string;
    agentId: number;
    paneId: string;
    profile: HostProfile;
    jobFile: string;
    command: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const budget = defaultSpawnJobMs();
  const deadline = clock.now() + budget;
  let lastPaneCheck = Number.NEGATIVE_INFINITY;
  let scrollback: string | undefined;
  for (;;) {
    a.signal?.throwIfAborted();
    const read = readJobFile(a.jobFile);
    if (read.kind === "invalid") throw new LeaseJobInvalidError(a.name, a.jobFile, read.line);
    if (read.kind === "handle") {
      const recorded = insertCarrierJob(db, {
        agentId: a.agentId,
        paneId: a.paneId,
        workstream: a.workstream,
        name: a.name,
        host: a.profile.name,
        job: read.job,
        hostStop: a.profile.stop ?? "",
      });
      if (!recorded) throw new Error(say("carrier.job_unrecorded", a.name, a.workstream, read.job));
      return read.job;
    }
    const atDeadline = clock.now() >= deadline;
    if (atDeadline || clock.now() - lastPaneCheck >= JOB_PANE_INTERVAL_MS) {
      lastPaneCheck = clock.now();
      const mux = await activeMux();
      // Capture every check and keep the last good buffer: a gone pane cannot be captured.
      scrollback =
        (await mux.capture(a.paneId, { lines: 50 }).catch(() => undefined)) ?? scrollback;
      // A file written just before the pane ended still wins: re-read before calling it dead.
      if (!(await mux.paneAlive(a.paneId)) && readJobFile(a.jobFile).kind === "none") {
        throw new AgentDiedOnSpawnError(
          a.name,
          a.paneId,
          scrollback,
          a.command,
          `before writing its job handle (up to ${budget}ms after spawn)`,
          a.profile.name,
        );
      }
    }
    if (atDeadline) throw new LeaseJobTimeoutError(a.name, a.profile.name, budget, a.jobFile);
    await clock.delay(Math.min(JOB_STAT_INTERVAL_MS, Math.max(1, deadline - clock.now())));
  }
}

/** What the lease rollback did: nothing to stop, the job is stopped, or it (and the tree) is kept. */
export type LeaseRollback = "none" | "stopped" | "kept";

/**
 * Rollback steps 2-4, once the pane is killed. The handle is the incarnation's recorded
 * `carrier_jobs` row, else (a spawn on a lease profile, `carrier` set) the job file read
 * again: the carrier writes it before dispatch, so a job that might exist has a file. A
 * re-read handle is persisted FIRST (captured incarnation, the admitted profile's stop; no
 * agent guard, so a row reconcile already removed cannot lose it), then stopped. A failed
 * stop, a pane not proven gone, or a file that is not a handle keeps the handle and says
 * so: the caller then keeps the worktree. "none": no handle, nothing was dispatched.
 * Never throws.
 */
export async function rollbackLeaseJob(
  db: Db,
  a: {
    workstream: string;
    name: string;
    incarnation: number | undefined;
    /** The admitted lease profile of a spawn that ran its carrier. */
    carrier?: { host: string; stop: string };
  },
  paneGone: boolean,
): Promise<LeaseRollback> {
  const kept = (host: string, handle: string, why: string): LeaseRollback => {
    const line = say("carrier.rollback_kept", a.name, a.workstream, host, handle, why);
    try {
      emitEvent(db, a.workstream, "agent.spawn_failed", `agent spawn rollback ${a.name}: ${line}`);
    } catch {
      // best-effort
    }
    if (!isJsonMode()) process.stderr.write(`${line}\n`);
    return "kept";
  };
  const jobFile = leaseJobFile(db, a.workstream, a.name);
  const host = a.carrier?.host ?? "?";
  try {
    let job = a.incarnation === undefined ? undefined : getCarrierJob(db, a.incarnation);
    if (job === undefined) {
      if (a.carrier === undefined) return "none";
      const read = readJobFile(jobFile);
      if (read.kind === "none") return "none";
      if (read.kind === "invalid") {
        return kept(host, JSON.stringify(read.line), "its job file holds no valid handle");
      }
      const found = { workstream: a.workstream, name: a.name, host, job: read.job };
      if (a.incarnation !== undefined) {
        persistCarrierJob(db, { ...found, agentId: a.incarnation, hostStop: a.carrier.stop });
        job = getCarrierJob(db, a.incarnation);
      }
      // No incarnation (the row was never written): the job file stays the only pointer.
      job ??= { ...found, agentId: -1, hostStop: a.carrier.stop, recordedAt: "" };
    }
    if (!paneGone) return kept(job.host, job.job, "its pane is not proven gone");
    try {
      await runStop(db, job.host, job.job, job.hostStop);
    } catch (e) {
      return kept(job.host, job.job, `stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (job.agentId !== -1) deleteCarrierJobAfterStop(db, job);
    const now = readJobFile(jobFile);
    if (now.kind === "handle" && now.job === job.job) rmSync(jobFile, { force: true });
    return "stopped";
  } catch (e) {
    return kept(host, "?", e instanceof Error ? e.message : String(e));
  }
}
