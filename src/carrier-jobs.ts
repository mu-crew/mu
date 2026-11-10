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
// stop AND the job file's cleanup AND the tree's (a close with no agent row releases
// it before the recovery tree's close, unless it was kept as one tree's pointer: a
// refusing tree must not fence the name), by its creator's rollback when
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
  /** The profile's `stop` template, as admitted; null for a plugin job (its fence is `instance`). */
  hostStop: string | null;
  /** The job kind (null: lease) and, for a plugin kind, the plugin and its instance at start. */
  kind: string | null;
  plugin: string | null;
  instance: string | null;
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
  /**
   * The id of the workstream the bound agent row lived in, stamped by the bind (a torn-down
   * and re-created workstream gets a new id); null before the bind, or on a reservation
   * older than the column. Reattach refuses unless it is the live workstream's.
   */
  workstreamId: number | null;
  createdAt: string;
  recordedAt: string | null;
  /** A provider host's record (`hosts.id`); null on a static host. */
  hostId: number | null;
  /** The tree's base and the local repo collects fetch into (a provider-host job). */
  treeBase: string | null;
  collectRepo: string | null;
  /** The final collect is owed (D10); `stopGen` counts the stops and losses, `collectNextAt` an in-life retry. */
  finalOwed: boolean;
  stopGen: number | null;
  collectNextAt: number | null;
  collectDelayMs: number | null;
}

interface Raw {
  token: string;
  workstream: string;
  name: string;
  host: string;
  host_stop: string | null;
  kind: string | null;
  plugin: string | null;
  instance: string | null;
  launch: CarrierLaunch;
  creator_pid: number | null;
  creator_start: string | null;
  agent_id: number | null;
  pane_id: string | null;
  job: string | null;
  reason: string | null;
  tree_path: string | null;
  tree_agent_id: number | null;
  workstream_id: number | null;
  created_at: string;
  recorded_at: string | null;
  host_id: number | null;
  tree_base: string | null;
  collect_repo: string | null;
  final_owed: number;
  stop_gen: number | null;
  collect_next_at: number | null;
  collect_delay_ms: number | null;
}

const toJob = (r: Raw): CarrierJob => ({
  token: r.token,
  workstream: r.workstream,
  name: r.name,
  host: r.host,
  hostStop: r.host_stop,
  kind: r.kind,
  plugin: r.plugin,
  instance: r.instance,
  launch: r.launch,
  creatorPid: r.creator_pid,
  creatorStart: r.creator_start,
  agentId: r.agent_id,
  paneId: r.pane_id,
  job: r.job,
  reason: r.reason,
  treePath: r.tree_path,
  treeAgentId: r.tree_agent_id,
  workstreamId: r.workstream_id,
  createdAt: r.created_at,
  recordedAt: r.recorded_at,
  hostId: r.host_id,
  treeBase: r.tree_base,
  collectRepo: r.collect_repo,
  finalOwed: r.final_owed === 1,
  stopGen: r.stop_gen,
  collectNextAt: r.collect_next_at,
  collectDelayMs: r.collect_delay_ms,
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
    /** A lease job's admitted stop template; null for a plugin job. */
    hostStop: string | null;
    /** A plugin job's kind and plugin (absent: a lease job). */
    plugin?: { kind: string; name: string };
    creatorPid?: number | null;
    creatorStart?: string | null;
  },
): CarrierJob | undefined {
  const token = randomUUID();
  try {
    const r = db
      .prepare(
        `INSERT INTO carrier_jobs (token, workstream, name, host, host_stop, kind, plugin, launch, creator_pid, creator_start, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM carrier_jobs WHERE workstream = ? AND name = ?)`,
      )
      .run(
        token,
        a.workstream,
        a.name,
        a.host,
        a.hostStop,
        a.plugin?.kind ?? null,
        a.plugin?.name ?? null,
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

/**
 * A plugin job's launch (`launching`, D1): written with its `job.start` effect, in the effect's
 * transaction, recording the instance the start goes to (the job's stop fence).
 */
export function markPluginJobLaunch(db: Db, token: string, instance: string): boolean {
  return (
    db
      .prepare(
        "UPDATE carrier_jobs SET launch = 'intent', instance = ? WHERE token = ? AND plugin IS NOT NULL AND job IS NULL",
      )
      .run(instance, token).changes === 1
  );
}

/** A plugin job's start proven never to have happened (D4): back to unlaunched, its reason kept. */
export function unlaunchPluginJob(db: Db, token: string, reason: string): boolean {
  return (
    db
      .prepare(
        "UPDATE carrier_jobs SET launch = 'none', reason = ? WHERE token = ? AND plugin IS NOT NULL AND job IS NULL",
      )
      .run(reason, token).changes === 1
  );
}

/**
 * The remote worktree a provider-host spawn prepared for the job, written before its start:
 * its path and base, and the local checkout collects fetch into (D5, D10).
 */
export function recordJobTree(
  db: Db,
  token: string,
  t: { path: string; base: string; agentId: number; collectRepo: string },
): boolean {
  return (
    db
      .prepare(
        "UPDATE carrier_jobs SET tree_path = ?, tree_base = ?, tree_agent_id = ?, collect_repo = ? WHERE token = ?",
      )
      .run(t.path, t.base, t.agentId, t.collectRepo, token).changes === 1
  );
}

/** The job record owing the final collect of the tree at `path` on `host`, if any (D10). */
export function owingJobOfTree(db: Db, host: string, path: string): CarrierJob | undefined {
  const r = db
    .prepare("SELECT * FROM carrier_jobs WHERE host = ? AND tree_path = ? AND final_owed = 1")
    .get(host, path) as Raw | undefined;
  return r === undefined ? undefined : toJob(r);
}

/** The job stopped, or was lost with its host: no turn can follow (D10). The new generation. */
export function bumpStopGen(db: Db, token: string): number | undefined {
  const r = db
    .prepare(
      "UPDATE carrier_jobs SET stop_gen = COALESCE(stop_gen, 0) + 1 WHERE token = ? RETURNING stop_gen",
    )
    .get(token) as { stop_gen: number } | undefined;
  return r?.stop_gen;
}

/**
 * The final collect done: cleared only while the stop generation is the one the collect read
 * before it fetched (D10 compare-and-clear). Nothing ever sets the flag again.
 */
export function clearFinalCollect(db: Db, token: string, stopGen: number): boolean {
  return (
    db
      .prepare(
        "UPDATE carrier_jobs SET final_owed = 0 WHERE token = ? AND final_owed = 1 AND stop_gen = ?",
      )
      .run(token, stopGen).changes === 1
  );
}

/** An in-life collect's retry time and its backoff (D10); nulls clear both. */
export function setCollectNextAt(
  db: Db,
  token: string,
  at: number | null,
  delayMs: number | null,
): void {
  db.prepare(
    "UPDATE carrier_jobs SET collect_next_at = ?, collect_delay_ms = ? WHERE token = ?",
  ).run(at, delayMs, token);
}

/** Every job record naming plugin `name` (`mu plugin rm` refuses over them). */
export function carrierJobsOfPlugin(db: Db, name: string): CarrierJob[] {
  return (
    db.prepare("SELECT * FROM carrier_jobs WHERE plugin = ? ORDER BY id").all(name) as Raw[]
  ).map(toJob);
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

/**
 * Finalize: the agent incarnation (and its pane) the reservation belongs to, and the
 * workstream generation that row lives in (`workstream_id`, NULL when no such row of this
 * workstream exists), read in the same statement.
 */
export function bindCarrierJobAgent(
  db: Db,
  token: string,
  agentId: number,
  paneId: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE carrier_jobs SET agent_id = ?, pane_id = ?,
           workstream_id = (SELECT a.workstream_id FROM agents a JOIN workstreams w ON w.id = a.workstream_id
                             WHERE a.id = ? AND w.name = carrier_jobs.workstream)
         WHERE token = ? AND (agent_id IS NULL OR agent_id = ?) AND (pane_id IS NULL OR pane_id = ?)`,
      )
      .run(agentId, paneId, agentId, token, agentId, paneId).changes === 1
  );
}

/** Reattach and its rollback: move the reservation between incarnations, compare-and-set on
 *  token, handle and the old pair (`bindCarrierJobAgent` refuses a stale `agent_id` on purpose).
 *  `workstream_id` stays: the reattach installs into the generation it was bound in. */
export function rebindCarrierJobAgent(
  db: Db,
  r: { token: string; job: string },
  from: { agentId: number; paneId: string },
  to: { agentId: number; paneId: string },
): boolean {
  const sql =
    "UPDATE carrier_jobs SET agent_id = ?, pane_id = ? WHERE token = ? AND job = ? AND agent_id = ? AND pane_id = ?";
  return (
    db.prepare(sql).run(to.agentId, to.paneId, r.token, r.job, from.agentId, from.paneId)
      .changes === 1
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
