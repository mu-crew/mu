// mu — wait cursors: what a caller has already been handed.
//
// `wait_cursors` (machine-local) holds one row per (caller, typed ref):
// the last CONSUMED token. A token is `{incarnation, runs}`, the two columns
// the table has, and what it means depends on the ref kind:
//
//   agent     pi's process incarnation + the settled run count. A new
//             incarnation replaces the row; a stale one never suppresses
//             the run of a new process.
//   task      `closed` + the id of the task's newest note. A re-close
//             writes a newer note, so a reopened-and-closed task is news.
//   delegate  `delegate` + 1: a call reaches a terminal state once.
//
// A token is written only for an event the wait DELIVERED. Registering a
// ref or starting a wait never writes one, and a sibling that a `first`
// wait did not return stays unconsumed. Keys are typed, `<kind>:<ws>/<id>`:
// workstream names hold no `/`, so no two refs collide.

import type { Db } from "./db.js";

export interface CursorToken {
  incarnation: string;
  runs: number;
}

export type CursorKind = "task" | "agent" | "delegate";

export function cursorKey(kind: CursorKind, workstream: string, id: string): string {
  return `${kind}:${workstream}/${id}`;
}

/** The closed-task token: `noteId` is the task's newest note (0 for none). */
export const closedToken = (noteId: number): CursorToken => ({
  incarnation: "closed",
  runs: noteId,
});

export const DELEGATE_TOKEN: CursorToken = { incarnation: "delegate", runs: 1 };

/** Has this caller already consumed `token`'s event (or a later one)? */
export function isConsumed(cursor: CursorToken | undefined, token: CursorToken): boolean {
  return (
    cursor !== undefined && cursor.incarnation === token.incarnation && cursor.runs >= token.runs
  );
}

/** Every consumed token of `caller`, by key. Rows with no token are skipped. */
export function readCursors(db: Db, caller: string): Map<string, CursorToken> {
  const rows = db
    .prepare(
      "SELECT ref, incarnation, runs FROM wait_cursors WHERE caller = ? AND incarnation IS NOT NULL AND runs IS NOT NULL",
    )
    .all(caller) as { ref: string; incarnation: string; runs: number }[];
  return new Map(rows.map((r) => [r.ref, { incarnation: r.incarnation, runs: r.runs }]));
}

/**
 * Record consumed tokens, monotonically: within one incarnation `runs`
 * never goes down, and a different incarnation replaces the row. One short
 * write transaction; callable inside a larger one.
 */
export function recordCursors(
  db: Db,
  caller: string,
  entries: readonly { key: string; token: CursorToken }[],
): void {
  if (entries.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES (?, ?, ?, ?)
       ON CONFLICT (caller, ref) DO UPDATE
          SET incarnation = excluded.incarnation, runs = excluded.runs
        WHERE wait_cursors.incarnation IS NOT excluded.incarnation
           OR wait_cursors.runs IS NULL OR wait_cursors.runs < excluded.runs`,
  );
  db.transaction(() => {
    for (const e of entries) upsert.run(caller, e.key, e.token.incarnation, e.token.runs);
  }).immediate();
}
