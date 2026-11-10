// mu — the lease half of `spawn --host` (spec 2026-10-28-lease-transport.md,
// § agent spawn --host on a lease profile): the name fence every spawn passes
// (refuseReserved), the reservation taken before any carrier effect
// (reserveLeaseJob), the job file claimed inside the spawn lock
// (claimLeaseJobFile), the stop-first rollback (rollbackLeaseJob, releaseLeaseReservation) and the
// conservative resolution of a reservation with no handle
// (resolveEmptyReservation). spawn.ts holds only the call sites. The job's own
// effects and reads (the handshake, the stop, the attach command) belong to the
// lease job kind, src/jobs/lease.ts.
//
// A lease pane holds no host channel and its death is not the job's death: the
// `carrier_jobs` reservation is the durable pointer to the job, from before the
// pane opens until a stop (or an explicit abandon). Reads fail closed: only a
// missing job file means "no file"; an unreadable, empty or invalid one keeps the
// reservation and the tree. A reservation whose carrier may have been launched
// (`launch` = 'intent') and holds no handle is never released without
// `--abandon-job`: nothing mu can observe proves such a carrier will not publish.

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
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
import { carrierJobFilePath } from "../ctl/path.js";
import type { Db } from "../db.js";
import { closePluginJob } from "../host-policy.js";
import { type HostProfile, HostProfileError, pidProvenGone, pidStart } from "../hosts.js";
import { describeRead, type JobFile, leaseJobRef, leaseKind, readJobFile } from "../jobs/lease.js";
import { viewPresent } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import { isJsonMode } from "../output.js";
import {
  AgentExistsError,
  CarrierJobKeptError,
  CarrierJobUnresolvedError,
  CarrierJobUnstoppedError,
} from "./errors.js";

// The job handshake moved to the lease job kind (src/jobs/lease.ts); its names stay importable here.
export {
  awaitLeaseJob,
  defaultSpawnJobMs,
  describeRead,
  type JobFile,
  LeaseJobInvalidError,
  LeaseJobTimeoutError,
  LeaseJobUnreadableError,
  readJobFile,
  setLeaseClockForTests,
} from "../jobs/lease.js";
export { CarrierJobKeptError, CarrierJobUnresolvedError, CarrierJobUnstoppedError };

import { withAgentLock } from "./lock.js";

/** The job file of (workstream, name), beside the agent's ctl socket (the DB's directory). */
export function leaseJobFile(db: Db, workstream: string, name: string): string {
  return carrierJobFilePath(workstream, name, dirname(db.name));
}

/**
 * The stop-failure record a carrier writes beside the job file when its signal-path stop
 * gives up (spec 2026-11-04-lease-adopt.md, contract 2). Its path names the job, so mu
 * reads or removes only the record of the handle it holds.
 */
export const stopFailedPath = (jobFile: string, job: string): string =>
  `${jobFile}.${job}.stop-failed`;

/** Remove `job`'s record once mu has proven that job stopped or reattached. Best effort. */
export function dropStopFailed(jobFile: string, job: string): void {
  try {
    rmSync(stopFailedPath(jobFile, job), { force: true });
  } catch {}
}

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
      await leaseKind.stop(db, leaseJobRef({ ...job, job: handle }), {
        agent: { name: job.name, ws: job.workstream },
      });
    } catch (e) {
      return kept(job.host, handle, `stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    dropStopFailed(jobFile, handle);
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
 * The facts of a reservation that holds NO handle (launch, pane, creator, job file,
 * reason), and whether its carrier was provably never launched: `launch` 'none', no
 * pane recorded, no reason noted (a rollback that kept it for a remote tree it could
 * not remove), and its creator proven gone (pid + start time). Read only.
 */
export async function describeEmptyReservation(
  db: Db,
  r: CarrierJob,
): Promise<{ facts: string; unlaunched: boolean }> {
  const jobFile = leaseJobFile(db, r.workstream, r.name);
  const creator =
    r.creatorPid === null
      ? "unknown"
      : pidProvenGone(r.creatorPid, r.creatorStart)
        ? "gone"
        : "not proven gone";
  let pane = "none";
  if (r.paneId !== null) {
    const alive = await viewPresent(r.paneId).catch(() => undefined);
    pane = `${r.paneId} (${alive === undefined ? "unknown" : alive ? "alive" : "dead"})`;
  }
  const facts = `launch ${r.launch}, pane ${pane}, creator pid ${r.creatorPid ?? "?"} ${creator}, job file ${describeRead(readJobFile(jobFile))}${r.reason === null ? "" : `, ${r.reason}`}`;
  const unlaunched =
    r.launch === "none" && r.paneId === null && r.reason === null && creator === "gone";
  return { facts, unlaunched };
}

/**
 * Resolve a reservation that holds NO handle (close-by-name, `--abandon-job`). Without
 * abandon it is released only when its carrier was provably never launched
 * (`describeEmptyReservation`). Every other case is unknown and refuses with the facts.
 * With `abandon` it is dropped with an event naming the host and the job file, which is
 * left in place so a late-published handle can still be found. Under the strict agent lock.
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
    const { facts, unlaunched } = await describeEmptyReservation(db, r);
    if (opts.abandon === true) {
      const abandoned = abandonCarrierJob(db, r);
      if (abandoned) emitAbandoned(db, r, facts);
      return { released: abandoned, abandoned, facts };
    }
    if (!unlaunched) return { released: false, abandoned: false, facts };
    return { released: releaseCarrierJob(db, r), abandoned: false, facts };
  });
}

function emitAbandoned(db: Db, r: CarrierJob, facts: string): void {
  emitEvent(
    db,
    r.workstream,
    "agent.close",
    say(
      "carrier.reservation_abandoned",
      r.name,
      r.host,
      leaseJobFile(db, r.workstream, r.name),
      facts,
    ),
  );
}

/**
 * What step 4 of a lease close decided for the name's reservation: its job `stopped`
 * (exit 0 of the stop template), `abandon` (`--abandon-job`: no stop; dropped at once,
 * with its event), or `unlaunched` (no handle and provably never launched: nothing to
 * stop). A stopped or unlaunched reservation is released by `releaseLeaseClose`, only
 * after the job file and the tree are dealt with.
 */
export interface LeaseClose {
  reservation: CarrierJob;
  /** `kept`: a plugin job on a lost host whose final collect is owed (src/host-policy.ts): its record stays. */
  action: "stopped" | "abandon" | "unlaunched" | "kept";
  /** What the abandon event names (the handle, or the empty reservation's facts). */
  facts: string;
}

/**
 * Step 4 of `agent close` on a lease agent, and of a close of a name whose agent row is
 * gone (spec § agent close, § No agent row left). The caller holds the agent lock and,
 * for a live agent, has proven its pane gone. A reservation with a handle runs `stop`
 * (the lease kind's stop, `runStop`): exit 0 is the proof; exit 3 is `HostHandbackError` and any other failure
 * `CarrierStopFailedError` (a changed or gone profile `CarrierStopRefusedError`), each
 * thrown with the reservation kept. One with no handle yet reads the job file (once a
 * carrier may have been launched): a handle is filled in, token-guarded, then stopped;
 * an unreadable or invalid file is noted and refuses; no file is released only when
 * provably never launched, else refuses with the facts (`CarrierJobUnresolvedError`:
 * a spawn in progress, or a carrier that may still publish). `--abandon-job` stops
 * nothing. Undefined when the reservation is already gone.
 */
export async function stopLeaseReservation(
  db: Db,
  reservation: CarrierJob,
  opts: { abandon?: boolean } = {},
): Promise<LeaseClose | undefined> {
  let r = getCarrierJob(db, reservation.token);
  if (r === undefined) return undefined;
  // A plugin job record is its kind's to stop (plugins spec D1, D10).
  if (r.plugin !== null) return closePluginJob(db, r, opts);
  const ws = r.workstream;
  if (opts.abandon === true) {
    // Dropped now, with its event: the tree's close may still refuse (a host gone for
    // good), and the handle must not block it. The job file is left in place.
    const facts =
      r.job !== null
        ? `job ${r.job}${r.reason === null ? "" : `, ${r.reason}`}`
        : (await describeEmptyReservation(db, r)).facts;
    if (!abandonCarrierJob(db, r)) {
      throw new CarrierJobKeptError(r.name, ws, r.host, "the reservation changed during the close");
    }
    emitAbandoned(db, r, facts);
    return { reservation: r, action: "abandon", facts };
  }
  if (r.job === null) {
    const jobFile = leaseJobFile(db, ws, r.name);
    // Before the launch intent no carrier of this reservation ran: a file there is not its.
    const read: JobFile = r.launch === "intent" ? readJobFile(jobFile) : { kind: "none" };
    if (read.kind === "handle") {
      if (!fillCarrierJob(db, r.token, read.job)) {
        throw new CarrierJobUnresolvedError(r.name, ws, r.host, `the reservation changed`);
      }
      r = getCarrierJob(db, r.token);
      if (r?.job == null) return undefined;
    } else if (read.kind !== "none") {
      const why = `the job file ${jobFile} is ${describeRead(read)}`;
      noteCarrierJob(db, r.token, why);
      throw new CarrierJobUnresolvedError(r.name, ws, r.host, why);
    } else {
      const { facts, unlaunched } = await describeEmptyReservation(db, r);
      if (!unlaunched) {
        const forTree = r.launch === "none" && r.paneId === null && r.reason !== null;
        throw new CarrierJobUnresolvedError(r.name, ws, r.host, facts, forTree);
      }
      return { reservation: r, action: "unlaunched", facts };
    }
  }
  const handle = r.job;
  await leaseKind.stop(db, leaseJobRef({ ...r, job: handle }), { agent: { name: r.name, ws } });
  // Proven stopped: its record goes now, whether or not a job file is left to clean.
  dropStopFailed(leaseJobFile(db, ws, r.name), handle);
  return { reservation: r, action: "stopped", facts: `job ${handle}` };
}

/**
 * After the stop, before the tree is touched: the job file goes only while it holds the
 * stopped handle (absent is fine). Anything else there (another handle, an invalid or
 * unreadable file) may name a job still running: the reservation is kept and the close
 * refuses (`CarrierJobKeptError`). An abandon leaves the file in
 * place, so a late-published handle can still be found.
 */
export function cleanLeaseJobFile(db: Db, close: LeaseClose): void {
  if (close.action !== "stopped") return;
  const r = close.reservation;
  const jobFile = leaseJobFile(db, r.workstream, r.name);
  const now = readJobFile(jobFile);
  if (now.kind === "none") return;
  if (now.kind === "handle" && now.job === r.job) {
    rmSync(jobFile, { force: true });
    return;
  }
  throw new CarrierJobKeptError(
    r.name,
    r.workstream,
    r.host,
    `job ${r.job} is stopped, but the job file ${jobFile} is ${describeRead(now)}`,
  );
}

/**
 * Last step of a lease close, once the job file and the tree are dealt with: release the
 * reservation, compare-and-set on its token and the handle it was closed with (an abandon
 * was released at its decision). A reservation that changed meanwhile (a handle landed)
 * refuses with it kept.
 */
export function releaseLeaseClose(db: Db, close: LeaseClose): void {
  if (close.action === "abandon" || close.action === "kept") return;
  const r = close.reservation;
  if (!releaseCarrierJob(db, r)) {
    if (getCarrierJob(db, r.token) === undefined) return;
    throw new CarrierJobKeptError(
      r.name,
      r.workstream,
      r.host,
      "the reservation changed during the close (a job handle landed)",
    );
  }
}
