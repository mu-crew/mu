// mu — task revisions: the `--if <rev>` fence for membership-changing and
// destructive task verbs.
//
// A task's revision is the newest `ops.seq` filed under the task's EXACT
// natural keys: the task (`<ws>/<id>`), its notes (`<ws>/<id>#<n>`) and
// both ends of its edges (`<blocker>-><blocked>`). Keys are compared whole,
// never with LIKE: `_` is a wildcard there, and task ids are full of it.
// Another workstream's ops, and a sibling task's, never move it. Ops that
// arrive by sync move it too, because the fence is read AFTER ingest, inside
// the mutation's transaction.
//
// Scope: tasks only. `workstreamRevision` (src/workstream.ts) keeps fencing
// teardown; agents get their own revision later.

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

/** Revision of every task of `workstream` that has ops (task id → seq). */
export function taskRevisions(db: Db, workstream: string): Map<string, number> {
  const out = new Map<string, number>();
  const prefix = `${workstream}/`;
  const bump = (key: string, seq: number): void => {
    if (!key.startsWith(prefix)) return; // an endpoint in another workstream
    const id = key.slice(prefix.length);
    if (seq > (out.get(id) ?? 0)) out.set(id, seq);
  };
  // key range [ws/, ws0): '0' is the byte after '/'. One seek per entity.
  const rows = db.prepare(
    `SELECT key, MAX(seq) AS seq FROM ops
      WHERE entity = ? AND key >= @lo AND key < @hi GROUP BY key`,
  );
  const range = { lo: prefix, hi: `${workstream}0` };
  for (const r of rows.all("task", range) as { key: string; seq: number }[]) bump(r.key, r.seq);
  for (const r of rows.all("note", range) as { key: string; seq: number }[]) {
    bump(r.key.slice(0, r.key.lastIndexOf("#")), r.seq);
  }
  for (const r of rows.all("edge", range) as { key: string; seq: number }[]) {
    const arrow = r.key.indexOf("->");
    if (arrow === -1) continue;
    bump(r.key.slice(0, arrow), r.seq);
    bump(r.key.slice(arrow + 2), r.seq);
  }
  return out;
}

/** The revision of one task (0 when it has no ops). Read only. */
export function taskRevision(db: Db, workstream: string, id: string): number {
  return taskRevisions(db, workstream).get(id) ?? 0;
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
