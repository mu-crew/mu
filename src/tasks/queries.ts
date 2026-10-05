// mu — task read/query primitives.

import type { Db } from "../db.js";
import { tryResolveWorkstreamId } from "../db.js";
import { lastClaimEventAt } from "../logs.js";
import {
  noteFromDb,
  type RawTaskNoteRow,
  type RawTaskRow,
  rowFromDb,
  SELECT_NOTE_COLS,
  SELECT_TASK_COLS,
  TASK_FROM_JOIN,
  type TaskNoteRow,
  type TaskRow,
  taskIdFor,
} from "./core.js";
import type { TaskStatus, TaskSubstate } from "./status.js";

export function getTask(db: Db, localId: string, workstream: string): TaskRow | undefined {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return undefined;
  const row = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.workstream_id = ? AND t.local_id = ?`,
    )
    .get(wsId, localId) as RawTaskRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

/**
 * The task's owner as (name, workstream), resolved through
 * `tasks.owner_id`. The owner's workstream can differ from the task's:
 * `task claim --for <ws>/<agent>` assigns an owner from another
 * workstream, and `TaskRow.ownerName` alone cannot say which.
 * Undefined when the task does not exist or has no owner.
 */
export function getTaskOwner(
  db: Db,
  localId: string,
  workstream: string,
): { name: string; workstreamName: string } | undefined {
  return db
    .prepare(
      `SELECT a.name AS name, aws.name AS workstreamName
         FROM tasks t
         JOIN workstreams tws ON tws.id = t.workstream_id
         JOIN agents a ON a.id = t.owner_id
         JOIN workstreams aws ON aws.id = a.workstream_id
        WHERE t.local_id = ? AND tws.name = ?`,
    )
    .get(localId, workstream) as { name: string; workstreamName: string } | undefined;
}

/**
 * List tasks. With no `workstream` arg returns every row — used by `mu sql`
 * and by tests; CLI surfaces always pass a workstream so users only see
 * their own.
 */
export interface ListTasksOptions {
  /** Filter to one or more lifecycle statuses. Omitted = all statuses. */
  status?: TaskStatus | readonly TaskStatus[];
  /** Filter to one or more substates (ANDed with `status`). */
  substate?: TaskSubstate | readonly TaskSubstate[];
}

/** Normalise a one-or-many filter option to an array (undefined = no filter). */
function asList<T extends string>(v: T | readonly T[] | undefined): readonly T[] | undefined {
  if (v === undefined) return undefined;
  return typeof v === "string" ? [v] : (v as readonly T[]);
}

export function listTasks(db: Db, workstream?: string, opts: ListTasksOptions = {}): TaskRow[] {
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? (opts.status as TaskStatus[])
        : [opts.status as TaskStatus];

  const where: string[] = [];
  const params: unknown[] = [];
  if (workstream !== undefined) {
    const wsId = tryResolveWorkstreamId(db, workstream);
    if (wsId === null) return [];
    where.push("t.workstream_id = ?");
    params.push(wsId);
  }
  if (statuses !== undefined) {
    where.push(`t.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const substates = asList(opts.substate);
  if (substates !== undefined && substates.length > 0) {
    where.push(`t.substate IN (${substates.map(() => "?").join(", ")})`);
    params.push(...substates);
  }
  const sql =
    where.length === 0
      ? `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} ORDER BY t.local_id`
      : `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE ${where.join(" AND ")} ORDER BY t.local_id`;
  const rows = db.prepare(sql).all(...params) as RawTaskRow[];
  return rows.map(rowFromDb);
}

// The three views (ready, blocked, goals) project tasks.* directly,
// so they expose v5 columns (id, workstream_id, owner_id). We wrap
// them with the same JOINs as TASK_FROM_JOIN to translate back to the
// operator-facing TaskRow shape (workstream + owner as TEXT names).
const VIEW_FROM_JOIN = (view: string) => `
  FROM ${view} v
  JOIN workstreams ws ON ws.id = v.workstream_id
  LEFT JOIN agents ag ON ag.id = v.owner_id
`;
const SELECT_VIEW_COLS = `
  v.id AS id,
  v.local_id AS local_id,
  ws.name AS workstream,
  v.title AS title,
  v.status AS status,
  v.substate AS substate,
  v.impact AS impact,
  v.effort_days AS effort_days,
  ag.name AS owner,
  v.created_at AS created_at,
  v.updated_at AS updated_at
`;

/** Options for listReady. The optional `statuses` filter composes
 *  on top of the `ready` view (which itself constrains to
 *  `status='OPEN'`); passing only OPEN is identical to today's no-
 *  filter shape, passing only non-OPEN values returns []. Exists so
 *  `mu task next --status` can mirror the multi-status flag shape
 *  shipped on `mu task list` (task_list_multi_status_union). */
export interface ListReadyOptions {
  status?: TaskStatus | readonly TaskStatus[];
  /** Substate filter; the `ready` view already excludes OPEN/parked. */
  substate?: TaskSubstate | readonly TaskSubstate[];
}

export function listReady(db: Db, workstream: string, opts: ListReadyOptions = {}): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? (opts.status as TaskStatus[])
        : [opts.status as TaskStatus];
  const where: string[] = ["v.workstream_id = ?"];
  const params: unknown[] = [wsId];
  if (statuses !== undefined && statuses.length > 0) {
    where.push(`v.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const substates = asList(opts.substate);
  if (substates !== undefined && substates.length > 0) {
    where.push(`v.substate IN (${substates.map(() => "?").join(", ")})`);
    params.push(...substates);
  }
  const rows = db
    .prepare(
      `SELECT ${SELECT_VIEW_COLS} ${VIEW_FROM_JOIN("ready")} WHERE ${where.join(" AND ")} ORDER BY v.local_id`,
    )
    .all(...params) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listBlocked(db: Db, workstream: string): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_VIEW_COLS} ${VIEW_FROM_JOIN("blocked")} WHERE v.workstream_id = ? ORDER BY v.local_id`,
    )
    .all(wsId) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listGoals(db: Db, workstream: string): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_VIEW_COLS} ${VIEW_FROM_JOIN("goals")} WHERE v.workstream_id = ? ORDER BY v.local_id`,
    )
    .all(wsId) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** All IN_PROGRESS tasks in a workstream, most-recently-touched first.
 *  Used by `mu state` to populate its in-progress slice; exposed as a
 *  named SDK helper so CLI renderers don't re-derive the row-shape
 *  conversion (review_code_raw_task_state_duplicate). */
export function listInProgress(db: Db, workstream: string): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.workstream_id = ? AND t.status = 'IN_PROGRESS' ORDER BY t.updated_at DESC`,
    )
    .all(wsId) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** CLOSED tasks in a workstream, most recently updated first, capped at
 *  `limit` (default 5). `updated_at` is a proxy for close time: there is
 *  no `closed_at` column, and a later note or edge change on a CLOSED
 *  task bumps `updated_at` (touchTask), moving it up. Used by `mu state`
 *  for its 'recent closed'
 *  slice; exposed as a named SDK helper so the CLI no longer needs the
 *  raw-row type that was duplicating RawTaskRow
 *  (review_code_raw_task_state_duplicate). */
export function listRecentClosed(db: Db, workstream: string, limit = 5): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.workstream_id = ? AND t.status = 'CLOSED' ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(wsId, limit) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** Optional filter knobs for `listNotes`. Default-everything-undefined
 *  preserves the historical "return every note, oldest-first" shape so
 *  every existing caller (cmdTaskShow's notes block, agents.test.ts)
 *  keeps working unchanged.
 *
 *  Filters compose multiplicatively when both apply (`since` AND
 *  `tail`): the timestamp filter is applied first, then `tail` slices
 *  the last N of what survived. The CLI surface (`mu task notes
 *  --tail / --since / --since-claim`) lives in src/cli/tasks/edit.ts;
 *  the mutex between `--since` and `--since-claim` is a CLI concern,
 *  not enforced here — if both arrive at the SDK, `since` wins (it's
 *  the explicit one) and `sinceClaim` is ignored. The auto-resolve
 *  for `sinceClaim` (look up the most recent `task claim` event in
 *  agent_logs) happens here so the SDK is self-contained for scripted
 *  callers. */
export interface ListNotesOptions {
  /** Print only the last N notes (after any timestamp filter). Must
   *  be a positive integer; a value of 0 returns no rows but is not
   *  an error here — CLI-side validation rejects `--tail 0`. */
  tail?: number;
  /** ISO-8601 cutoff: only notes with `created_at > since` survive.
   *  Any `Date.parse`-able value; it is normalised to `toISOString()`
   *  form (the stored shape) before the text comparison, so offsets
   *  and second-precision cutoffs compare as instants. */
  since?: string;
  /** When true and `since` is unset, look up the `created_at` of the
   *  most recent `task claim` event for this task and use it as the
   *  cutoff. Falls back to no filter when no claim event exists
   *  (equivalent to `--since-beginning`). */
  sinceClaim?: boolean;
}

/** List notes for a task. Operator-facing local_id; resolves to the
 *  surrogate task id via taskIdFor (with optional workstream scope).
 *
 *  Optional filters: see {@link ListNotesOptions}. Default behaviour
 *  (no opts) is unchanged — every note, oldest-first. */
export function listNotes(
  db: Db,
  taskLocalId: string,
  workstream: string,
  opts: ListNotesOptions = {},
): TaskNoteRow[] {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return [];
  // Resolve the cutoff once: explicit `since` wins; otherwise
  // `sinceClaim` resolves via lastClaimEventAt (null → no filter).
  // created_at is always `toISOString()` (UTC, millis, `Z`) and the
  // filter compares text, so normalise `since` to that same shape: a
  // raw `10:07:00Z` sorts after `10:07:00.411Z` ('Z' > '.') and an
  // offset like `+02:00` compares as local time. An unparseable value
  // passes through unchanged (the CLI rejects it before here).
  let cutoff: string | undefined = opts.since;
  if (cutoff !== undefined) {
    const ms = Date.parse(cutoff);
    if (!Number.isNaN(ms)) cutoff = new Date(ms).toISOString();
  }
  if (cutoff === undefined && opts.sinceClaim === true) {
    const at = lastClaimEventAt(db, workstream, taskLocalId);
    if (at !== null) cutoff = at;
  }
  const rows =
    cutoff !== undefined
      ? (db
          .prepare(
            `SELECT ${SELECT_NOTE_COLS} FROM task_notes n JOIN tasks t ON t.id = n.task_id
              WHERE n.task_id = ? AND n.created_at > ? ORDER BY n.id`,
          )
          .all(taskId, cutoff) as RawTaskNoteRow[])
      : (db
          .prepare(
            `SELECT ${SELECT_NOTE_COLS} FROM task_notes n JOIN tasks t ON t.id = n.task_id
              WHERE n.task_id = ? ORDER BY n.id`,
          )
          .all(taskId) as RawTaskNoteRow[]);
  const mapped = rows.map(noteFromDb);
  if (opts.tail !== undefined && opts.tail >= 0) {
    return opts.tail === 0 ? [] : mapped.slice(-opts.tail);
  }
  return mapped;
}

/**
 * All tasks currently owned by `agent` in a given workstream
 * (v5: agents.name is per-workstream unique). Sorted by local_id.
 *
 * Defaults to **excluding CLOSED** since the verb's purpose is "what
 * is X currently working on?" and a closed task is no longer being
 * worked on. closeTask intentionally preserves `owner` as a
 * historical record (so audit/notes can attribute decisions); pass
 * `{ includeClosed: true }` to surface that history.
 */
export function listTasksByOwner(
  db: Db,
  workstream: string,
  owner: string,
  opts: { includeClosed?: boolean } = {},
): TaskRow[] {
  // 'Live work' = not CLOSED. includeClosed re-includes CLOSED tasks
  // so historical attribution is recoverable.
  // Filter on the joined ag.name so the operator-facing owner string
  // still drives the lookup; FK is now via owner_id.
  const filter = opts.includeClosed ? "" : "AND t.status <> 'CLOSED'";
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const sql = `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
               WHERE ag.name = ? AND t.workstream_id = ? ${filter}
               ORDER BY t.local_id`;
  return (db.prepare(sql).all(owner, wsId) as RawTaskRow[]).map(rowFromDb);
}

/**
 * Cross-workstream variant of `listTasksByOwner`. Returns tasks owned
 * by ANY agent of the given name across every workstream. Used by
 * `mu task owned-by --all` for the genuine cross-workstream view
 * (audit / dashboards). The bare name is the join key, so two
 * distinct same-named agents in different workstreams contribute
 * their tasks to the same result list.
 */
export function listTasksByOwnerCrossWorkstream(
  db: Db,
  owner: string,
  opts: { includeClosed?: boolean } = {},
): TaskRow[] {
  const filter = opts.includeClosed ? "" : "AND t.status <> 'CLOSED'";
  const sql = `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
               WHERE ag.name = ? ${filter}
               ORDER BY ws.name, t.local_id`;
  return (db.prepare(sql).all(owner) as RawTaskRow[]).map(rowFromDb);
}
