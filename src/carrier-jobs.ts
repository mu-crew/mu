// mu — carrier_jobs: the handle of the remote job a lease agent's carrier dispatched.
//
// A lease pane holds no ssh session and its death is not the job's death, so the
// handle lives in its own machine-local table: no FK, no trigger, no op, no sync.
// Agent deletion (close, reconcile prune, teardown, workstream delete, the reaper,
// raw `mu sql`) never touches it. Only a successful stop, or an explicit abandon,
// deletes it. `host_stop` is the stop template as it was when the handle was
// recorded; a later stop runs from the current profile only if its `stop` is
// byte-identical (the twin of `host_exec` on a recovery record).
//
// The stop itself (`runStop`) lives in carrier-stop.ts, which needs the host
// channels; this file is the table and nothing else, so hosts.ts can read it.

import type { Db } from "./db.js";

export interface CarrierJob {
  agentId: number;
  workstream: string;
  name: string;
  host: string;
  /** The opaque handle the carrier wrote to its job file. */
  job: string;
  /** The profile's `stop` template when the handle was recorded. */
  hostStop: string;
  recordedAt: string;
}

interface Raw {
  agent_id: number;
  workstream: string;
  name: string;
  host: string;
  job: string;
  host_stop: string;
  recorded_at: string;
}

const toJob = (r: Raw): CarrierJob => ({
  agentId: r.agent_id,
  workstream: r.workstream,
  name: r.name,
  host: r.host,
  job: r.job,
  hostStop: r.host_stop,
  recordedAt: r.recorded_at,
});

/**
 * Record the handle of agent incarnation `agentId`, in ONE statement guarded by the
 * incarnation: the row only lands while a live agent row has this id AND this pane.
 * False when the guard fails (the agent is gone or replaced) or the incarnation
 * already has a handle (never overwritten).
 */
export function insertCarrierJob(
  db: Db,
  a: {
    agentId: number;
    paneId: string;
    workstream: string;
    name: string;
    host: string;
    job: string;
    hostStop: string;
  },
): boolean {
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO carrier_jobs (agent_id, workstream, name, host, job, host_stop, recorded_at)
         SELECT a.id, ?, ?, ?, ?, ?, ? FROM agents a WHERE a.id = ? AND a.pane_id = ?`,
      )
      .run(
        a.workstream,
        a.name,
        a.host,
        a.job,
        a.hostStop,
        new Date().toISOString(),
        a.agentId,
        a.paneId,
      ).changes === 1
  );
}

/**
 * Record a handle for an incarnation whose agent row may already be going (rollback
 * persists a re-read handle BEFORE anything can delete the row). No agent guard:
 * the caller holds the incarnation's id from the spawn. Never overwrites.
 */
export function persistCarrierJob(db: Db, j: Omit<CarrierJob, "recordedAt">): boolean {
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO carrier_jobs (agent_id, workstream, name, host, job, host_stop, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(j.agentId, j.workstream, j.name, j.host, j.job, j.hostStop, new Date().toISOString())
      .changes === 1
  );
}

export function getCarrierJob(db: Db, agentId: number): CarrierJob | undefined {
  const r = db.prepare("SELECT * FROM carrier_jobs WHERE agent_id = ?").get(agentId) as
    | Raw
    | undefined;
  return r === undefined ? undefined : toJob(r);
}

/** The newest handle recorded for (workstream, name): a name can have an older incarnation's unstopped one. */
export function getCarrierJobByName(
  db: Db,
  workstream: string,
  name: string,
): CarrierJob | undefined {
  const r = db
    .prepare(
      "SELECT * FROM carrier_jobs WHERE workstream = ? AND name = ? ORDER BY agent_id DESC LIMIT 1",
    )
    .get(workstream, name) as Raw | undefined;
  return r === undefined ? undefined : toJob(r);
}

/** Every unstopped handle of (workstream, name), newest first. */
export function listCarrierJobsByName(db: Db, workstream: string, name: string): CarrierJob[] {
  return (
    db
      .prepare(
        "SELECT * FROM carrier_jobs WHERE workstream = ? AND name = ? ORDER BY agent_id DESC",
      )
      .all(workstream, name) as Raw[]
  ).map(toJob);
}

/** Every recorded handle (doctor's `lease-job` hint reads these). */
export function listCarrierJobs(db: Db): CarrierJob[] {
  return (db.prepare("SELECT * FROM carrier_jobs ORDER BY agent_id").all() as Raw[]).map(toJob);
}

/**
 * Delete exactly this handle, compare-and-set on its content, AFTER its stop succeeded.
 * False when it was already gone or is another handle now.
 */
export function deleteCarrierJobAfterStop(db: Db, job: CarrierJob): boolean {
  return (
    db
      .prepare("DELETE FROM carrier_jobs WHERE agent_id = ? AND job = ? AND host = ?")
      .run(job.agentId, job.job, job.host).changes === 1
  );
}

/**
 * Drop a handle WITHOUT stopping its job (`agent close --abandon-job`): the only way a row
 * leaves without a successful stop. The caller emits the event naming host and handle.
 */
export function abandonCarrierJob(db: Db, job: CarrierJob): boolean {
  return deleteCarrierJobAfterStop(db, job);
}
