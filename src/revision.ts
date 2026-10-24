// mu — task revisions: the `--if <rev>` fence for membership-changing and
// destructive task verbs.
//
// A task's revision is DERIVED from current state, never counted: a hash
// of the task row's portable fields, the owner, every incoming and outgoing
// edge (each endpoint as `<workstream>/<local_id>`) and the number of
// notes. It is computed on read (show / list / delete preview) and again
// inside the guarded write's transaction, after sync ingest. No write path
// has to remember to bump anything, so none can miss: a local verb, a peer
// op applied under capture suppression, a cascade (a synced blocker delete
// drops the edge without an edge op) or a rebuild all move it by changing
// the state it hashes. Lookups are exact (`=`), never LIKE: `_` is a
// wildcard there, and task ids are full of it. Another workstream's tasks
// and sibling tasks never move it.
//
// The revision is a 48-bit integer taken from SHA-256, so it fits a JSON
// number and `--if <int>`. An absent task is revision 0.
//
// Scope: tasks only. `workstreamRevision` (src/workstream.ts) keeps fencing
// teardown; agents get their own revision later.

import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import type { HasNextSteps, NextStep } from "./output.js";

/** A guarded verb was given a revision that no longer matches. Exit 4,
 *  nothing was done. One stderr line naming the fresh preview
 *  (`inlineNext`); JSON carries `expected_rev` / `current_rev`. */
export class RevisionMismatchError extends Error implements HasNextSteps {
  override readonly name = "RevisionMismatchError";
  readonly inlineNext = true;
  constructor(
    public readonly subject: string,
    public readonly expectedRev: number,
    public readonly currentRev: number,
    /** The read-only command that prints the current revision. */
    public readonly previewCommand: string,
  ) {
    super(
      `${subject} changed since preview (rev ${expectedRev} → ${currentRev}); preview again: ${previewCommand}`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [{ intent: "Preview again", command: this.previewCommand }];
  }
}

/** Throws when a supplied `expected` differs from `current`. `undefined`
 *  (no `--if`) always passes. */
export function assertRevision(
  expected: number | undefined,
  current: number,
  ctx: { subject: string; previewCommand: string },
): void {
  if (expected === undefined || expected === current) return;
  throw new RevisionMismatchError(ctx.subject, expected, current, ctx.previewCommand);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface TaskStateRow {
  id: number;
  local_id: string;
  title: string;
  status: string;
  substate: string;
  impact: number;
  effort_days: number;
  scored: number;
  dispatch_host: string | null;
  kind: string;
  wave: string | null;
  created_at: string;
  updated_at: string;
  owner: string | null;
}

/** Revision of every task of `workstream` (task id → revision), or of the
 *  one task `only` names. Read only. */
function derive(db: Db, workstream: string, only?: string): Map<string, number> {
  const idFilter = only === undefined ? "" : " AND t.local_id = @only";
  const params: Record<string, string> = { ws: workstream };
  if (only !== undefined) params.only = only;
  const tasks = db
    .prepare(
      `SELECT t.id, t.local_id, t.title, t.status, t.substate, t.impact, t.effort_days,
              t.scored, t.dispatch_host, t.kind, t.wave, t.created_at, t.updated_at,
              CASE WHEN a.id IS NULL THEN NULL ELSE aws.name || '/' || a.name END AS owner
         FROM tasks t
         JOIN workstreams w ON w.id = t.workstream_id
         LEFT JOIN agents a ON a.id = t.owner_id
         LEFT JOIN workstreams aws ON aws.id = a.workstream_id
        WHERE w.name = @ws${idFilter}`,
    )
    .all(params) as TaskStateRow[];
  const byRow = new Map<number, { row: TaskStateRow; blockers: string[]; dependents: string[] }>();
  for (const row of tasks) byRow.set(row.id, { row, blockers: [], dependents: [] });
  if (byRow.size === 0) return new Map();

  // Both directions of every edge touching a task of this workstream. An
  // edge from another workstream lands on the local end (the sync apply
  // path accepts one), whichever endpoint the op key names first.
  const edges = db
    .prepare(
      `SELECT e.from_task_id AS fid, e.to_task_id AS tid,
              fw.name || '/' || f.local_id AS fkey, tw.name || '/' || t.local_id AS tkey
         FROM task_edges e
         JOIN tasks f ON f.id = e.from_task_id JOIN workstreams fw ON fw.id = f.workstream_id
         JOIN tasks t ON t.id = e.to_task_id   JOIN workstreams tw ON tw.id = t.workstream_id
        WHERE (fw.name = @ws${only === undefined ? "" : " AND f.local_id = @only"})
           OR (tw.name = @ws${only === undefined ? "" : " AND t.local_id = @only"})`,
    )
    .all(params) as { fid: number; tid: number; fkey: string; tkey: string }[];
  for (const e of edges) {
    byRow.get(e.tid)?.blockers.push(e.fkey);
    byRow.get(e.fid)?.dependents.push(e.tkey);
  }

  const notes = new Map<number, number>();
  const noteRows = db
    .prepare(
      `SELECT n.task_id AS id, COUNT(*) AS n
         FROM task_notes n
         JOIN tasks t ON t.id = n.task_id
         JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = @ws${idFilter} GROUP BY n.task_id`,
    )
    .all(params) as { id: number; n: number }[];
  for (const r of noteRows) notes.set(r.id, r.n);

  const out = new Map<string, number>();
  for (const [rowId, { row, blockers, dependents }] of byRow) {
    const { id: _rowid, ...fields } = row;
    // Canonical edge order (endpoint id, then kind), so the hash never
    // depends on the order SQLite returned the rows in.
    const edgeList: [string, string][] = [
      ...blockers.map((k): [string, string] => [k, "blocker"]),
      ...dependents.map((k): [string, string] => [k, "dependent"]),
    ];
    edgeList.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]));
    const digest = createHash("sha256")
      .update(JSON.stringify([fields, edgeList, notes.get(rowId) ?? 0]))
      .digest();
    out.set(row.local_id, digest.readUIntBE(0, 6));
  }
  return out;
}

/** Revision of every task of `workstream` (task id → revision). Read only. */
export function taskRevisions(db: Db, workstream: string): Map<string, number> {
  return derive(db, workstream);
}

/** The revision of one task (0 when it does not exist). Read only. */
export function taskRevision(db: Db, workstream: string, id: string): number {
  return derive(db, workstream, id).get(id) ?? 0;
}

/** Throw `RevisionMismatchError` when `expected` is not the task's revision.
 *  The task being absent is not this guard's business: the verb's own
 *  not-found (or no-op) handling runs instead. `verb` picks the preview. */
export function assertTaskRevision(
  db: Db,
  workstream: string,
  id: string,
  expected: number | undefined,
  previewCommand = `mu task show ${id} -w ${workstream}`,
): void {
  if (expected === undefined) return;
  const exists = db
    .prepare(
      `SELECT 1 FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = ? AND t.local_id = ?`,
    )
    .get(workstream, id);
  if (!exists) return;
  assertRevision(expected, taskRevision(db, workstream, id), {
    subject: `task ${id}`,
    previewCommand,
  });
}

/** Run `fn` with the task's revision checked in the SAME write transaction.
 *  Without `expected` it just runs `fn` (no new transaction). With it, the
 *  whole of `fn` (every edge of a multi-blocker block) sits behind ONE
 *  check, so a batch cannot invalidate its own fence. */
export function withTaskFence<T>(
  db: Db,
  workstream: string,
  id: string,
  expected: number | undefined,
  fn: () => T,
  previewCommand?: string,
): T {
  if (expected === undefined) return fn();
  return db
    .transaction(() => {
      assertTaskRevision(db, workstream, id, expected, previewCommand);
      return fn();
    })
    .immediate();
}
