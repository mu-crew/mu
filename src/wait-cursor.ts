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
// The settle lane (pi's settle wait, `MU_WAIT_SETTLE=1`) keeps its own
// delegate cursor under the same caller, `settle|delegate:<ws>/<id>`: the
// answer reached the transcript. A shell `mu wait` writes only the plain key,
// the settle lane only its own, so each sees every answer once.
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

/** The cursor key of an agent's DONE mark (src/wait-owed.ts): nothing is owed for the agent any more. */
export const doneKey = (workstream: string, name: string): string =>
  `done|${cursorKey("agent", workstream, name)}`;

export const DELEGATE_TOKEN: CursorToken = { incarnation: "delegate", runs: 1 };

/** The settle lane's cursor key of a delegate call (see the file comment). */
export const settleKey = (workstream: string, callId: string): string =>
  `settle|${cursorKey("delegate", workstream, callId)}`;

/**
 * The settle lane's adoption mark: bit 1 of SQLite's `PRAGMA user_version`, which mu uses for
 * nothing else (the schema stamp is its own table): a header field, so no row any table counts, and
 * an older mu reads the file as before. Bit 0 marks a pre-release build of the lane that kept one
 * key per call (`delegate` + 2 = shown in the transcript).
 */
const SETTLE_LANE_BIT = 2;
const PRE_RELEASE_LANE_BIT = 1;

const userVersion = (db: Db): number => db.pragma("user_version", { simple: true }) as number;

/** openDb's check (src/db.ts schemaIsCurrent): a DB this build has not adopted is upgraded. */
export const settleLaneAdopted = (db: Db): boolean => (userVersion(db) & SETTLE_LANE_BIT) !== 0;

/**
 * Once per DB, inside openDb's upgrade transaction (so before any wait of this build): every
 * delegate answer an older mu consumed (one key for the shell and the settle alike) counts as
 * shown in the transcript too, so the lane never replays history. Idempotent.
 */
export function adoptSettleLane(db: Db): void {
  const v = userVersion(db);
  if ((v & SETTLE_LANE_BIT) !== 0) return;
  const preRelease = (v & PRE_RELEASE_LANE_BIT) !== 0;
  // The pre-release build's `delegate` + 2 was the settle's; its later + 1 a shell wait's alone.
  db.prepare(
    `INSERT OR IGNORE INTO wait_cursors (caller, ref, incarnation, runs)
       SELECT caller, 'settle|' || ref, incarnation, runs FROM wait_cursors
        WHERE ref LIKE 'delegate:%' AND incarnation = ? AND runs >= ?`,
  ).run(DELEGATE_TOKEN.incarnation, preRelease ? 2 : DELEGATE_TOKEN.runs);
  if (preRelease)
    db.prepare(
      "UPDATE wait_cursors SET runs = ? WHERE incarnation = ? AND runs > ? AND (ref LIKE 'delegate:%' OR ref LIKE 'settle|delegate:%')",
    ).run(DELEGATE_TOKEN.runs, DELEGATE_TOKEN.incarnation, DELEGATE_TOKEN.runs);
  db.pragma(`user_version = ${v | SETTLE_LANE_BIT}`);
}

/**
 * The call ids of `calls` (terminal, `caller`'s) whose answer the settle lane has not delivered
 * into `caller`'s transcript. A read.
 */
export function settleOwed(
  db: Db,
  caller: string,
  calls: readonly { workstream: string; callId: string }[],
): string[] {
  const cursors = readCursors(db, caller);
  return calls.flatMap((c) =>
    isConsumed(cursors.get(settleKey(c.workstream, c.callId)), DELEGATE_TOKEN) ? [] : [c.callId],
  );
}

/** The reserved caller of the stall-log marks: no caller is spelled like it (`<ws>/<agent>`, `pi:<s>`). */
const STALL_LOG_CALLER = "mu:agent.stall";

/**
 * Log a task's stall once per owner identity: `emit` runs only when no wait, in any process, has
 * logged this task stalled on this (registry row, pi incarnation, run count) before. The mark is a
 * `stall-log|task:<ws>/<id>` row under a reserved caller (machine-local, like the `agent.stall` op
 * itself). One short immediate transaction: check, mark and emit together.
 */
export function logStallOnce(
  db: Db,
  task: { workstream: string; id: string },
  id: { agentId: number; incarnation: string; runs: number },
  emit: () => void,
): void {
  const key = `stall-log|${cursorKey("task", task.workstream, task.id)}`;
  const token = { incarnation: `${id.agentId}|${id.incarnation}`, runs: id.runs };
  db.transaction(() => {
    const row = db
      .prepare("SELECT incarnation, runs FROM wait_cursors WHERE caller = ? AND ref = ?")
      .get(STALL_LOG_CALLER, key) as CursorToken | undefined;
    if (isConsumed(row, token)) return;
    recordCursors(db, STALL_LOG_CALLER, [{ key, token }]);
    emit();
  }).immediate();
}

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
