// mu — carrier_jobs: the RESERVATION of a lease agent's remote job, and its handle.
//
// A lease pane holds no ssh session and its death is not the job's death, so the
// pointer to the job lives in its own machine-local table: no FK, no trigger, no op,
// no sync. A lease spawn inserts the reservation BEFORE any carrier effect (before
// its pane opens): name-exclusive per (workstream, name), with an immutable spawn
// token every later write is guarded by. `launch` turns 'intent' just before the
// mux is asked for the pane (from then on a carrier may run); the pane id, the
// agent incarnation (finalize) and the handle (job handshake) fill in as they are
// known. While a reservation exists, every spawn of the name refuses.
//
// Agent deletion (close, reconcile prune, teardown, workstream delete, the reaper,
// raw `mu sql`) never touches it. It is released (deleted) only after a successful
// stop AND the job file's cleanup AND the tree's, by its creator's rollback when
// nothing was launched, or by an explicit abandon. `host_stop` is the stop template
// as it was admitted; a later stop runs from the current profile only if its `stop`
// is byte-identical (the twin of `host_exec` on a recovery record).
//
// The stop itself (`runStop`) lives in carrier-stop.ts, which needs the host
// channels; this file is the table and nothing else, so hosts.ts can read it.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

/** Whether a carrier may have been launched: 'none' until just before the mux is asked for the pane. */
export type CarrierLaunch = "none" | "intent";

export interface CarrierJob {
  /** The spawn's immutable token: every update and the release are guarded by it. */
  token: string;
  workstream: string;
  name: string;
  host: string;
  /** The profile's `stop` template, as admitted. */
  hostStop: string;
  launch: CarrierLaunch;
  /** The creating spawn's process (pid + start time where the platform has one). */
  creatorPid: number | null;
  creatorStart: string | null;
  /** The agent incarnation, bound at finalize; null before (or if finalize never ran). */
  agentId: number | null;
  /** The carrier's pane, recorded the moment the mux reports it. */
  paneId: string | null;
  /** The opaque handle the carrier wrote to its job file; null until the handshake reads it. */
  job: string | null;
  /** Why the reservation was kept without a handle (an unreadable or invalid job file), or for its tree. */
  reason: string | null;
  /**
   * The remote worktree a rollback kept the reservation for (`keepCarrierJobForTree`): its
   * path on `host` and the placeholder incarnation a recovery record of it would carry. A
   * close with no agent row releases the reservation only after THAT tree's close.
   */
  treePath: string | null;
  treeAgentId: number | null;
  createdAt: string;
  recordedAt: string | null;
}

interface Raw {
  token: string;
  workstream: string;
  name: string;
  host: string;
  host_stop: string;
  launch: CarrierLaunch;
  creator_pid: number | null;
  creator_start: string | null;
  agent_id: number | null;
  pane_id: string | null;
  job: string | null;
  reason: string | null;
  tree_path: string | null;
  tree_agent_id: number | null;
  created_at: string;
  recorded_at: string | null;
}

const toJob = (r: Raw): CarrierJob => ({
  token: r.token,
  workstream: r.workstream,
  name: r.name,
  host: r.host,
  hostStop: r.host_stop,
  launch: r.launch,
  creatorPid: r.creator_pid,
  creatorStart: r.creator_start,
  agentId: r.agent_id,
  paneId: r.pane_id,
  job: r.job,
  reason: r.reason,
  treePath: r.tree_path,
  treeAgentId: r.tree_agent_id,
  createdAt: r.created_at,
  recordedAt: r.recorded_at,
});

const now = (): string => new Date().toISOString();

/**
 * Reserve (workstream, name) for a lease spawn, in ONE statement: the row lands only
 * while no reservation of the name exists (the unique index is the second fence).
 * Undefined when the name is reserved already.
 */
export function reserveCarrierJob(
  db: Db,
  a: {
    workstream: string;
    name: string;
    host: string;
    hostStop: string;
    creatorPid?: number | null;
    creatorStart?: string | null;
  },
): CarrierJob | undefined {
  const token = randomUUID();
  try {
    const r = db
      .prepare(
        `INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, launch, creator_pid, creator_start, created_at)
         SELECT ?, ?, ?, ?, ?, 'none', ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM carrier_jobs WHERE workstream = ? AND name = ?)`,
      )
      .run(
        token,
        a.workstream,
        a.name,
        a.host,
        a.hostStop,
        a.creatorPid ?? null,
        a.creatorStart ?? null,
        now(),
        a.workstream,
        a.name,
      );
    if (r.changes !== 1) return undefined;
  } catch (err) {
    if ((err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") return undefined;
    throw err;
  }
  return getCarrierJob(db, token);
}

export function getCarrierJob(db: Db, token: string): CarrierJob | undefined {
  const r = db.prepare("SELECT * FROM carrier_jobs WHERE token = ?").get(token) as Raw | undefined;
  return r === undefined ? undefined : toJob(r);
}

/** The reservation bound to agent incarnation `agentId`, if any. */
export function getCarrierJobByAgent(db: Db, agentId: number): CarrierJob | undefined {
  const r = db.prepare("SELECT * FROM carrier_jobs WHERE agent_id = ?").get(agentId) as
    | Raw
    | undefined;
  return r === undefined ? undefined : toJob(r);
}

/** The reservation of (workstream, name): the one a spawn of the name refuses on. */
export function getCarrierJobByName(
  db: Db,
  workstream: string,
  name: string,
): CarrierJob | undefined {
  return listCarrierJobsByName(db, workstream, name)[0];
}

/** Every reservation of (workstream, name); more than one only from the rebuilt pre-reservation shape. */
export function listCarrierJobsByName(db: Db, workstream: string, name: string): CarrierJob[] {
  return (
    db
      .prepare(
        "SELECT * FROM carrier_jobs WHERE workstream = ? AND name = ? ORDER BY ordinal, id DESC",
      )
      .all(workstream, name) as Raw[]
  ).map(toJob);
}

/** Every reservation (doctor's `lease-job` hint reads these). */
export function listCarrierJobs(db: Db): CarrierJob[] {
  return (db.prepare("SELECT * FROM carrier_jobs ORDER BY id").all() as Raw[]).map(toJob);
}

/** The admitted profile's stop, before anything was launched under it. */
export function setCarrierJobStop(db: Db, token: string, hostStop: string): boolean {
  return (
    db
      .prepare(
        "UPDATE carrier_jobs SET host_stop = ? WHERE token = ? AND launch = 'none' AND job IS NULL",
      )
      .run(hostStop, token).changes === 1
  );
}

/** Written immediately before the mux is asked for the pane: from here a carrier may run. */
export function markCarrierLaunch(db: Db, token: string): boolean {
  return (
    db.prepare("UPDATE carrier_jobs SET launch = 'intent' WHERE token = ?").run(token).changes === 1
  );
}

/** The carrier's pane, the moment the mux reports it. Never overwrites another pane. */
export function recordCarrierPane(db: Db, token: string, paneId: string): boolean {
  return (
    db
      .prepare(
        "UPDATE carrier_jobs SET pane_id = ? WHERE token = ? AND (pane_id IS NULL OR pane_id = ?)",
      )
      .run(paneId, token, paneId).changes === 1
  );
}

/** Finalize: the agent incarnation (and its pane) the reservation belongs to. */
export function bindCarrierJobAgent(
  db: Db,
  token: string,
  agentId: number,
  paneId: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE carrier_jobs SET agent_id = ?, pane_id = ?
         WHERE token = ? AND (agent_id IS NULL OR agent_id = ?) AND (pane_id IS NULL OR pane_id = ?)`,
      )
      .run(agentId, paneId, token, agentId, paneId).changes === 1
  );
}

/**
 * The handle the carrier published, guarded by the token only: the reservation is the
 * name's, so a handle read from its job file is its job whatever became of the agent row.
 * Never overwrites a different handle; true when the row now holds `job`.
 */
export function fillCarrierJob(db: Db, token: string, job: string): boolean {
  db.prepare(
    "UPDATE carrier_jobs SET job = ?, reason = NULL, recorded_at = ? WHERE token = ? AND job IS NULL",
  ).run(job, now(), token);
  return getCarrierJob(db, token)?.job === job;
}

/** Why a reservation is kept without a handle (an unreadable or invalid job file). */
export function noteCarrierJob(db: Db, token: string, reason: string): void {
  db.prepare("UPDATE carrier_jobs SET reason = ? WHERE token = ?").run(reason, token);
}

/**
 * A rollback could not remove the remote worktree it prepared: the reservation is kept as
 * that tree's pointer, recording WHICH tree (path on the reservation's host, and the
 * placeholder incarnation) with the reason.
 */
export function keepCarrierJobForTree(
  db: Db,
  token: string,
  tree: { path: string; agentId: number; reason: string },
): void {
  db.prepare(
    "UPDATE carrier_jobs SET reason = ?, tree_path = ?, tree_agent_id = ? WHERE token = ?",
  ).run(tree.reason, tree.path, tree.agentId, token);
}

/**
 * Release exactly this reservation, compare-and-set on its token and handle (null
 * included): only after its stop succeeded and its job file and tree are cleaned up, or
 * by its creator when nothing was launched. False when it is gone or holds another
 * handle now.
 */
export function releaseCarrierJob(db: Db, job: CarrierJob): boolean {
  return (
    db.prepare("DELETE FROM carrier_jobs WHERE token = ? AND job IS ?").run(job.token, job.job)
      .changes === 1
  );
}

/**
 * Drop a reservation WITHOUT stopping its job (`agent close --abandon-job`): the only way
 * a launched one leaves without a stop. The caller emits the event naming host, handle
 * and job file, and leaves the file in place.
 */
export function abandonCarrierJob(db: Db, job: CarrierJob): boolean {
  return releaseCarrierJob(db, job);
}
