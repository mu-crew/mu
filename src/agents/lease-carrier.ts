// mu — the lease half of `spawn --host` (spec 2026-10-28-lease-transport.md,
// § agent spawn --host on a lease profile): the name fence every spawn passes
// (refuseReserved), the reservation taken before any carrier effect
// (reserveLeaseJob), the job file claimed inside the spawn lock
// (claimLeaseJobFile), the job handshake that fills the handle (awaitLeaseJob),
// the stop-first rollback (rollbackLeaseJob, releaseLeaseReservation) and the
// conservative resolution of a reservation with no handle
// (resolveEmptyReservation). spawn.ts holds only the call sites.
//
// A lease pane holds no host channel and its death is not the job's death: the
// `carrier_jobs` reservation is the durable pointer to the job, from before the
// pane opens until a stop (or an explicit abandon). Reads fail closed: only a
// missing job file means "no file"; an unreadable, empty or invalid one keeps the
// reservation and the tree. A reservation whose carrier may have been launched
// (`launch` = 'intent') and holds no handle is never released without
// `--abandon-job`: nothing mu can observe proves such a carrier will not publish.

import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgent } from "../agents.js";
import {
  abandonCarrierJob,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJob,
  getCarrierJobByName,
  noteCarrierJob,
  releaseCarrierJob,
  reserveCarrierJob,
} from "../carrier-jobs.js";
import { runStop } from "../carrier-stop.js";
import { carrierJobFilePath } from "../ctl/path.js";
import type { Db } from "../db.js";
import {
  type HostProfile,
  HostProfileError,
  JOB_HANDLE_RE,
  pidProvenGone,
  pidStart,
} from "../hosts.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import { isJsonMode } from "../output.js";
import { AgentDiedOnSpawnError, AgentExistsError, CarrierJobUnstoppedError } from "./errors.js";

export { CarrierJobUnstoppedError };

import { withAgentLock } from "./lock.js";

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

/** The job file held something that is not a handle (empty included). Exit 1 (rolled back; reservation and tree kept). */
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

/** The job file exists but cannot be read: not proof of no job. Exit 1 (rolled back; reservation and tree kept). */
export class LeaseJobUnreadableError extends Error {
  override readonly name = "LeaseJobUnreadableError";
  constructor(
    public readonly agentName: string,
    public readonly jobFile: string,
    public readonly detail: string,
  ) {
    super(say("carrier.job_unreadable", agentName, jobFile, detail));
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

export type JobFile =
  | { kind: "none" }
  | { kind: "handle"; job: string }
  | { kind: "invalid"; line: string }
  | { kind: "unreadable"; detail: string };

/**
 * One line, an opaque handle; mu parses nothing further. FAIL CLOSED: only ENOENT is
 * "no file". Any other read error is `unreadable`, and an empty file is `invalid` (the
 * carrier renames the file in whole, so a reader never sees it half-written).
 */
export function readJobFile(path: string): JobFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", detail: code ?? (e instanceof Error ? e.message : String(e)) };
  }
  const line = text.split("\n")[0]?.trim() ?? "";
  return JOB_HANDLE_RE.test(line) ? { kind: "handle", job: line } : { kind: "invalid", line };
}

const describeRead = (r: JobFile): string =>
  r.kind === "handle"
    ? `handle ${r.job}`
    : r.kind === "invalid"
      ? `${JSON.stringify(r.line.slice(0, 80))}, not a handle`
      : r.kind === "unreadable"
        ? `unreadable: ${r.detail}`
        : "absent";

/**
 * The name fence, for EVERY spawn (lease or not, `--worktree` or `--cwd`): refuse while
 * (workstream, name) holds a reservation other than `own`, naming it and the way out.
 */
export function refuseReserved(db: Db, workstream: string, name: string, own?: string): void {
  const r = getCarrierJobByName(db, workstream, name);
  if (r !== undefined && r.token !== own) throw new CarrierJobUnstoppedError(name, r);
}

/** A lease profile runs no command gates (a carrier's exit is not a gate result). Before any effect. */
export function assertLeaseSpawnable(profile: HostProfile, isGate: boolean): void {
  if (profile.transport === "lease" && isGate) {
    throw new HostProfileError(say("carrier.lease_gate", profile.name));
  }
}

/**
 * Reserve (workstream, name) for a lease spawn, BEFORE any carrier effect: under the
 * strict agent lock, refused while the name has a live agent row or any reservation.
 * The reservation records this process (pid + start time) as its creator.
 */
export async function reserveLeaseJob(
  db: Db,
  workstream: string,
  name: string,
  profile: HostProfile,
): Promise<CarrierJob> {
  return withAgentLock(db, workstream, name, async () => {
    if (getAgent(db, name, workstream) !== undefined) throw new AgentExistsError(name);
    refuseReserved(db, workstream, name);
    const r = reserveCarrierJob(db, {
      workstream,
      name,
      host: profile.name,
      hostStop: profile.stop ?? "",
      creatorPid: process.pid,
      creatorStart: pidStart(process.pid),
    });
    if (r !== undefined) return r;
    refuseReserved(db, workstream, name); // a parallel spawn's reservation landed first
    throw new Error(`carrier_jobs: reservation of ${workstream}/${name} not inserted`);
  });
}

/**
 * Inside the spawn lock, holding the name's reservation: make the fixed job path free,
 * so any file seen after the pane opens is this carrier's. A file already there can only
 * be an earlier, released or abandoned, reservation's: it is moved aside (never deleted)
 * and the move is logged. A move that fails throws (before launch). Returns the path.
 */
export function claimLeaseJobFile(db: Db, workstream: string, name: string): string {
  const path = leaseJobFile(db, workstream, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const read = readJobFile(path);
  if (read.kind === "none") return path;
  const aside = `${path}.stale-${Date.now()}`;
  renameSync(path, aside);
  try {
    emitEvent(
      db,
      workstream,
      "agent.spawn",
      `agent spawn ${name}: a job file of an earlier reservation (${describeRead(read)}) moved to ${aside}`,
    );
  } catch {
    // best-effort
  }
  return path;
}

/**
 * The job handshake: mandatory for a lease, independent of ctl, `--no-ctl` and
 * MU_SPAWN_CTL_MS. Waits for the job file and fills the handle into the reservation
 * (guarded by its token). A pane that dies first is AgentDiedOnSpawnError with its
 * scrollback; a live pane with no file by the deadline is LeaseJobTimeoutError; an
 * invalid or empty file is LeaseJobInvalidError and an unreadable one
 * LeaseJobUnreadableError (the rollback keeps the reservation and the tree for both).
 */
export async function awaitLeaseJob(
  db: Db,
  a: {
    name: string;
    token: string;
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
    if (read.kind === "unreadable") {
      throw new LeaseJobUnreadableError(a.name, a.jobFile, read.detail);
    }
    if (read.kind === "handle") {
      if (!fillCarrierJob(db, a.token, read.job)) {
        throw new Error(say("carrier.job_unrecorded", a.name, read.job));
      }
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

/**
 * What the lease rollback did: nothing was launched ("none"), the job is stopped and its
 * job file cleaned up ("stopped"), or the reservation and the tree are kept ("kept").
 */
export type LeaseRollback = "none" | "stopped" | "kept";

/**
 * Rollback steps 2-4, once the pane is killed, acting ONLY on the spawn's own
 * reservation (its token): never on the shared job file of another one. A reservation
 * never launched (`launch` = 'none') is "none". One launched with no handle re-reads the
 * job file: a handle is filled in (token-guarded) and stopped; no file, an unreadable or
 * an invalid one keeps the reservation (with the reason) and the tree. A failed stop or
 * a pane not proven gone keeps them too. A stop that succeeds unlinks the job file only
 * while it still holds that handle. Never throws; never releases (see
 * releaseLeaseReservation, after the tree's cleanup).
 */
export async function rollbackLeaseJob(
  db: Db,
  a: { workstream: string; name: string; token: string },
  paneGone: boolean,
): Promise<LeaseRollback> {
  const jobFile = leaseJobFile(db, a.workstream, a.name);
  const kept = (host: string, handle: string | null, why: string): LeaseRollback => {
    const line =
      handle === null
        ? say("carrier.rollback_reserved", a.name, a.workstream, host, why)
        : say("carrier.rollback_kept", a.name, a.workstream, host, handle, why);
    try {
      emitEvent(db, a.workstream, "agent.spawn_failed", `agent spawn rollback ${a.name}: ${line}`);
    } catch {
      // best-effort
    }
    if (!isJsonMode()) process.stderr.write(`${line}\n`);
    return "kept";
  };
  try {
    let job = getCarrierJob(db, a.token);
    if (job === undefined) return kept("?", null, "its reservation is gone");
    if (job.job === null) {
      if (job.launch === "none") return "none";
      const read = readJobFile(jobFile);
      if (read.kind === "none") {
        return kept(job.host, null, `no job handle in ${jobFile}; the carrier may still write one`);
      }
      if (read.kind !== "handle") {
        const reason = `the job file ${jobFile} is ${describeRead(read)}`;
        noteCarrierJob(db, job.token, reason);
        return kept(job.host, null, reason);
      }
      if (!fillCarrierJob(db, job.token, read.job)) {
        return kept(job.host, read.job, "the reservation holds another handle");
      }
      job = getCarrierJob(db, a.token);
      if (job?.job == null) return kept("?", read.job, "its reservation is gone");
    }
    const handle = job.job;
    // A launch whose pane id mux never reported: that pane was never killed.
    if (!paneGone || job.paneId === null) {
      return kept(job.host, handle, "its pane is not proven gone");
    }
    try {
      await runStop(db, job.host, handle, job.hostStop);
    } catch (e) {
      return kept(job.host, handle, `stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const now = readJobFile(jobFile);
    if (now.kind === "handle" && now.job === handle) rmSync(jobFile, { force: true });
    else if (now.kind !== "none") {
      return kept(job.host, handle, `stopped, but the job file ${jobFile} is ${describeRead(now)}`);
    }
    return "stopped";
  } catch (e) {
    return kept("?", null, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Release the spawn's reservation after the rollback's tree cleanup has run: when nothing
 * was launched ("none": still 'none' and empty) or its job was stopped ("stopped"; the job
 * file is cleaned up). Compare-and-set on token and handle. Never throws.
 */
export function releaseLeaseReservation(db: Db, token: string, outcome: LeaseRollback): void {
  try {
    const r = getCarrierJob(db, token);
    if (r === undefined) return;
    const ok =
      outcome === "stopped"
        ? r.job !== null
        : outcome === "none" && r.launch === "none" && r.job === null;
    if (ok) releaseCarrierJob(db, r);
  } catch {
    // best-effort: a kept reservation fails closed (the name stays fenced)
  }
}

/** What `resolveEmptyReservation` did, and the facts it decided on. */
export interface EmptyReservationResolution {
  released: boolean;
  abandoned: boolean;
  facts: string;
}

/**
 * Resolve a reservation that holds NO handle (close-by-name, `--abandon-job`). Without
 * abandon it is released only when its carrier was provably never launched: `launch`
 * 'none', no pane recorded, and its creator proven gone (pid + start time). Every other
 * case is unknown and refuses with the facts (launch, pane, creator, job file). With
 * `abandon` it is dropped with an event naming the host and the job file, which is left
 * in place so a late-published handle can still be found. Under the strict agent lock.
 */
export async function resolveEmptyReservation(
  db: Db,
  reservation: CarrierJob,
  opts: { abandon?: boolean } = {},
): Promise<EmptyReservationResolution> {
  const { workstream, name } = reservation;
  return withAgentLock(db, workstream, name, async () => {
    const r = getCarrierJob(db, reservation.token);
    if (r === undefined) return { released: false, abandoned: false, facts: "already released" };
    if (r.job !== null) {
      return { released: false, abandoned: false, facts: `holds job ${r.job}: stop it first` };
    }
    const jobFile = leaseJobFile(db, workstream, name);
    const creator =
      r.creatorPid === null
        ? "unknown"
        : pidProvenGone(r.creatorPid, r.creatorStart)
          ? "gone"
          : "not proven gone";
    let pane = "none";
    if (r.paneId !== null) {
      const alive = await activeMux()
        .then((m) => m.paneAlive(r.paneId ?? ""))
        .catch(() => undefined);
      pane = `${r.paneId} (${alive === undefined ? "unknown" : alive ? "alive" : "dead"})`;
    }
    const facts = `launch ${r.launch}, pane ${pane}, creator pid ${r.creatorPid ?? "?"} ${creator}, job file ${describeRead(readJobFile(jobFile))}${r.reason === null ? "" : `, ${r.reason}`}`;
    if (opts.abandon === true) {
      const abandoned = abandonCarrierJob(db, r);
      if (abandoned) {
        emitEvent(
          db,
          workstream,
          "agent.close",
          say("carrier.reservation_abandoned", name, r.host, jobFile, facts),
        );
      }
      return { released: abandoned, abandoned, facts };
    }
    if (r.launch !== "none" || r.paneId !== null || creator !== "gone") {
      return { released: false, abandoned: false, facts };
    }
    return { released: releaseCarrierJob(db, r), abandoned: false, facts };
  });
}
