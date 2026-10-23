// mu — op capture: SQLite triggers that record every change to a
// portable table as an op, inside the SAME TRANSACTION as the mutation.
//
// WHY TRIGGERS AND NOT HAND-EMITTED OPS
// -------------------------------------
// Capture fires inside the same transaction as the row change, in the
// same file. So capture is ATOMIC with the change: the two cannot
// drift, not even on power loss mid-write. Either both landed or
// neither did.
//
// Hand-emitted ops (an `emitOp(...)` next to each mutation) were
// rejected because they can be FORGOTTEN. A forgotten op is no
// longer "sync missed something" — sync, rebuild and history are
// ALL projections of this one log, so one missing op is silent
// corruption of all of them at once. A future SDK function that mutates
// `tasks` must not be ABLE to skip capture. Triggers make that
// structural rather than a convention someone has to remember.
//
// WHY THE TRIGGERS LIVE IN THE DB FILE (and what that costs)
// ----------------------------------------------------------
// The triggers are ordinary main-schema triggers, stored in the file.
// So a plain write from ANY connection, `sqlite3` included, is captured:
// a safety net, not a supported path (plain sqlite3 defaults to
// foreign_keys=0, so cascades are skipped; mu writes go through the SDK).
//
// Per-invocation context (intent / actor / group / the echo guard) lives
// in `op_ctx`, a one-row MAIN table. 3.x kept it in a per-connection
// TEMP table, which a main trigger cannot reference; with it in main,
// two connections share one row, and that needs two rules:
//
//   * ONLY the context wrappers (src/op-context.ts) write `op_ctx`, and
//     they do it inside a transaction THEY OWN: BEGIN IMMEDIATE, set the
//     row, run, reset it, COMMIT. The row is therefore never committed
//     with a context in it: a concurrent writer blocks on the lock
//     instead of being stamped with someone else's intent (or, worse,
//     `applying = 1`, which would silently drop its ops), and a crash
//     rolls the context back with everything else.
//   * The triggers read `applying` with COALESCE(..., 0): a missing row
//     captures with no context rather than capturing nothing.
//
// Consequences of persistence:
//
//   * The trigger set is versioned. `schema_version.capture_version`
//     stamps the revision (CAPTURE_VERSION below); `installCapture`
//     replaces every `_cap_*` trigger and the stamp in ONE BEGIN
//     IMMEDIATE when the stamp is older, refuses (the caller throws
//     SchemaTooNewError) when it is newer, and does nothing, taking no
//     lock, when equal. Change a generator => bump CAPTURE_VERSION
//     (test/capture-persistent.test.ts pins the DDL's sha256).
//   * Stored trigger text equals the generated text exactly (no IF NOT
//     EXISTS, no trailing `;`), so `captureTriggersCurrent` and doctor
//     can compare sqlite_master against the generator.
//   * Triggers run on whatever SQLite opens the file, so they abort with
//     a clear message below 3.42 (`unixepoch('subsec')` would mint
//     zero-time HLCs there) instead of writing corrupt ops.
//   * A main trigger may INSERT into a qualified-or-not main table; the
//     `_op_dying` stash became the main table `op_dying` for the same
//     reason as `op_ctx` (a main trigger cannot see temp tables).
//
// SEMANTIC PARTIAL UPDATES — ONLY CHANGED COLUMNS
// -----------------------------------------------
// The UPDATE triggers compare `NEW.<col> IS NOT OLD.<col>` per column
// and build the payload from just the columns that actually changed, so
// `task.close` carries `{"status":"CLOSED"}` and nothing else. This is
// the single detail that makes per-field merge FREE: "apply in HLC
// order" then converges without column version vectors.
//
// Dumping the whole row instead would look identical in every
// single-machine test and silently regress the design from field-level
// to row-level last-writer-wins. mu runs autonomous agent crews, so a
// devserver crew closing a task while the operator edits that task's
// impact on a laptop is concurrent multi-machine writing BY
// CONSTRUCTION. Field-level merge keeps both edits; row-level LWW
// discards one at random. `IS NOT` (not `<>`) because `<>` is NULL for
// a NULL operand, which would drop every set-to-NULL and
// NULL-to-a-value transition — e.g. releasing a claim
// (`owner_id -> NULL`) would never be captured.

import { createHash } from "node:crypto";

// TYPE-ONLY import: db.ts imports this module, so a value import would
// be a runtime cycle (and an import cycle here shows up as `node
// dist/cli.js` printing nothing at all). `typeof PORTABLE_TABLES` is a
// type position, so this is erased at compile time.
import type { PORTABLE_TABLES } from "./db.js";

/** Sentinel key segment for a natural key whose parent row could not be
 *  resolved. Should be unreachable — the dying-ancestor stash below
 *  exists precisely so cascades can still resolve — but a capture that
 *  records a degraded key is strictly better than one that records
 *  nothing, so this FAILS SAFE rather than failing silent. */
const UNRESOLVED = "<unresolved>";

// ─── Revision, SQLite floor, context tables ──────────────────────────

/**
 * The revision of the trigger set stored in the file, stamped in
 * `schema_version.capture_version`. BUMP IT whenever any generator in
 * this file changes the SQL it emits: an older stamp makes the next
 * writable `openDb` replace every capture trigger (one BEGIN IMMEDIATE,
 * with the stamp), and a newer stamp makes it refuse (SchemaTooNewError)
 * instead of running triggers it cannot vouch for.
 * test/capture-persistent.test.ts pins the sha256 of the generated DDL,
 * so forgetting the bump fails a test.
 *
 * Separate from CURRENT_SCHEMA_VERSION on purpose: that number says
 * "tables and columns are incompatible" and refuses older DBs outright;
 * a capture revision is upgradeable in place, so it must not be folded
 * into it (an older schema number is refused before any trigger work).
 */
export const CAPTURE_VERSION = 1;

/** Lowest SQLite that mints correct HLCs: `unixepoch('subsec')` arrived
 *  in 3.42; before it the call yields NULL and every op gets a zero-time
 *  HLC. */
export const MIN_SQLITE = { major: 3, minor: 42 } as const;

/** True when `version` ("3.41.2") is below MIN_SQLITE. Numeric per part,
 *  never a string compare ("3.9" > "3.42" as text). */
export function sqliteTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((p) => Number.parseInt(p, 10) || 0);
  return major < MIN_SQLITE.major || (major === MIN_SQLITE.major && minor < MIN_SQLITE.minor);
}

/** The same test, inside SQL: every EMITTING trigger runs it first, so a
 *  connection on an old SQLite (a stray `sqlite3` binary) aborts the
 *  write instead of minting zero-time HLCs. */
const SQLITE_TOO_OLD_SQL = (() => {
  const v = "sqlite_version()";
  const afterMajor = `substr(${v}, instr(${v}, '.') + 1)`;
  const major = `CAST(${v} AS INTEGER)`;
  const minor = `CAST(${afterMajor} AS INTEGER)`;
  return `(${major} < ${MIN_SQLITE.major} OR (${major} = ${MIN_SQLITE.major} AND ${minor} < ${MIN_SQLITE.minor}))`;
})();

const SQLITE_TOO_OLD_MESSAGE = `mu: SQLite >= ${MIN_SQLITE.major}.${MIN_SQLITE.minor} required (unixepoch subsec)`;

// ─── The op context tables ────────────────────────────────────────────
//
// `op_ctx` and `op_dying` are MAIN tables created by applySchema
// (src/db.ts), because a main trigger cannot reference the temp schema.
//
//   op_ctx     the **op context** (docs/VOCABULARY.md): group_id /
//              actor / intent / applying, plus `now_ms`, a scratchpad
//              holding "now" for the current trigger firing. The HLC
//              advance compares `now` against `last_wall` and reuses the
//              SAME `now` to write it; calling unixepoch() twice could
//              straddle a millisecond boundary and mint a non-monotonic
//              pair. Exactly ONE row, id = 1, seeded with defaults, so a
//              mutation outside any SDK context is still CAPTURED, just
//              with a null intent. Fail safe, never fail silent. Only
//              src/op-context.ts writes the context columns, inside a
//              transaction it owns; at rest they are always defaults.
//
//   op_dying   natural keys of rows that are mid-DELETE: see the DELETE
//              section below. Keyed by (kind, id). Empty at rest: each
//              stash row is removed by an AFTER DELETE trigger.

// ─── Shared SQL fragments ─────────────────────────────────────────────

/** Echo guard. Every trigger carries it. `applying = 1` means we are
 *  INGESTING a peer's op, where writing a fresh local op would be an
 *  echo that propagates back and never terminates. v2-sync sets it. */
const NOT_APPLYING = "COALESCE((SELECT applying FROM op_ctx WHERE id = 1), 0) = 0";

/** Advance the persisted HLC by one tick, then read it back formatted.
 *  Mirrors `nextHlc` in src/hlc.ts EXACTLY — same monotonic rule (if
 *  now > last_wall take now with counter 0, else hold the wall and step
 *  the counter) and same `%015d.%06d.%s` serialization. It is
 *  reimplemented in SQL rather than called from JS because a trigger
 *  cannot call back into JS, and the whole point is that capture
 *  happens inside the mutation's transaction.
 *
 *  Kept honest by test/capture.test.ts, which asserts the SQL-minted
 *  HLC parses with `parseHlc` and interleaves monotonically with
 *  JS-minted ones. If the format changes in one place the other fails. */
const ADVANCE_CLOCK = `
  SELECT RAISE(ABORT, '${SQLITE_TOO_OLD_MESSAGE}') WHERE ${SQLITE_TOO_OLD_SQL};
  UPDATE op_ctx SET now_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = 1;
  UPDATE machine_identity
     SET last_wall    = MAX(last_wall, (SELECT now_ms FROM op_ctx WHERE id = 1)),
         last_counter = CASE WHEN (SELECT now_ms FROM op_ctx WHERE id = 1) > last_wall
                             THEN 0 ELSE last_counter + 1 END
   WHERE id = 1;`;

/** The just-advanced HLC, formatted. Must be read AFTER ADVANCE_CLOCK. */
const HLC = `(SELECT printf('%015d.%06d.%s', last_wall, last_counter, machine_id)
                FROM machine_identity WHERE id = 1)`;

/** Column list shared by every op INSERT. */
const OP_COLS = "(hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)";

/** The context/identity columns, in OP_COLS order after `hlc`.
 *  `group_id` falls back to a per-op random hex string so the column is
 *  never NULL: an op outside any SDK context is its own group of one,
 *  which is exactly right. */
const OP_CTX_VALUES = `
  (SELECT machine_id FROM machine_identity WHERE id = 1),
  COALESCE((SELECT group_id FROM op_ctx WHERE id = 1), lower(hex(randomblob(8)))),
  (SELECT actor  FROM op_ctx WHERE id = 1),
  (SELECT intent FROM op_ctx WHERE id = 1)`;

/** ISO-8601 wall time, matching what the SDK writes elsewhere.
 *  Advisory only — `hlc` is the ordering key, this is for humans. */
const CREATED_AT = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// ─── Natural keys ─────────────────────────────────────────────────────
//
// `ops.key` is ALWAYS the natural key, never a surrogate id. This is
// exactly why mu's keys don't collide across machines the way an
// AUTOINCREMENT rowid would: two machines both minting `tasks.id = 7`
// is inevitable and meaningless, whereas `demo/fix-auth` denotes the
// same task everywhere.
//
//   workstream   <name>                        demo
//   task         <workstream>/<local_id>       demo/fix-auth
//   note         <workstream>/<local_id>#<id>  demo/fix-auth#12
//   edge         <blocker> -> <blocked>        demo/a->demo/b
//
// Notes keep their surrogate `id` as a suffix because a note has no
// natural identity of its own — same author and text twice is two
// notes. Notes are append-only and never edited, so the suffix only
// needs to be locally unique, and `<task-key>#<id>` is.

/** Workstream name for a workstream id, or the dying-stash value if the
 *  workstream row is already gone (FK cascade). */
const wsKey = (idExpr: string): string => `COALESCE(
  (SELECT w.name FROM workstreams w WHERE w.id = ${idExpr}),
  (SELECT d.key FROM op_dying d WHERE d.kind = 'workstream' AND d.id = ${idExpr}),
  '${UNRESOLVED}')`;

/** `<workstream>/<local_id>` for a task id, falling back to the dying
 *  stash when the task row itself is already gone. */
const taskKey = (idExpr: string): string => `COALESCE(
  (SELECT ${wsKey("t.workstream_id")} || '/' || t.local_id
     FROM tasks t WHERE t.id = ${idExpr}),
  (SELECT d.key FROM op_dying d WHERE d.kind = 'task' AND d.id = ${idExpr}),
  '${UNRESOLVED}')`;

// ─── Per-table trigger DDL ────────────────────────────────────────────

/** Build the changed-columns-only payload expression for an UPDATE.
 *
 *  Nests one CASE per column around a `json_insert` so a column lands
 *  in the payload only when it actually changed:
 *
 *    CASE WHEN NEW.impact IS NOT OLD.impact
 *         THEN json_insert(<inner>, '$.impact', NEW.impact)
 *         ELSE <inner> END
 *
 *  With six columns and one change that yields a 1-key object. */
function changedPayload(cols: readonly string[]): string {
  let expr = "'{}'";
  for (const col of cols) {
    expr = `CASE WHEN NEW.${col} IS NOT OLD.${col}
                 THEN json_insert(${expr}, '$.${col}', NEW.${col})
                 ELSE ${expr} END`;
  }
  return expr;
}

/** Whole-row payload for an INSERT: an insert changes every column by
 *  definition, so there is nothing to diff against. */
function fullPayload(cols: readonly string[]): string {
  const pairs = cols.map((c) => `'${c}', NEW.${c}`).join(", ");
  return `json_object(${pairs})`;
}

/** Whole-row payload for a DELETE, from `OLD.*`.
 *
 *  Tombstones are normally EMPTY (`'{}'`): the key identifies the row
 *  and the puts before it describe it, so carrying the body again would
 *  just bloat the log. Notes are the exception, and the reason is their
 *  key.
 *
 *  A note's key embeds its rowid (`<ws>/<task>#<id>`), which is NOT
 *  portable — a rebuild, a v8/v9 reprojection, or any path that
 *  reinserts a note assigns a fresh one (see src/drift.ts, which
 *  deliberately matches notes on the task-key PREFIX for exactly this
 *  reason). When that happens the historical `put` stays under the old
 *  key while a later `del` is emitted under the current one, and
 *  nothing joins the two.
 *
 *  A reader folding the puts for a key to reconstruct a tombstoned row
 *  would see `{}` for a note in that state (drift-641). A
 *  self-describing note tombstone closes that hole: the op that removed
 *  the row also carries what the row WAS, so nothing depends on finding
 *  a matching put. */
function fullOldPayload(cols: readonly string[]): string {
  const pairs = cols.map((c) => `'${c}', OLD.${c}`).join(", ");
  return `json_object(${pairs})`;
}

/** A note tombstone's payload. The full row only when the log holds no
 *  put under the same key (a reprojection gave the note a new rowid, so
 *  a fold of the puts could not find it: drift-641); otherwise `{}`,
 *  because apply's delete reads the content from that put.
 *  Without this, every workstream teardown wrote each note a second time. */
function noteTombstonePayload(keyExpr: string, cols: readonly string[]): string {
  return `CASE WHEN EXISTS (
      SELECT 1 FROM ops WHERE entity = 'note' AND key = ${keyExpr} AND op = 'put'
    ) THEN '{}' ELSE ${fullOldPayload(cols)} END`;
}

/** `WHEN` clause restricting an UPDATE trigger to real changes. A
 *  no-op UPDATE (SET x = x, or rewriting identical values) produces NO
 *  op at all, which keeps the log free of churn that would otherwise
 *  make every `mu log` read noisy and every sync flush bigger. */
function anyChanged(cols: readonly string[]): string {
  return cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join("\n        OR ");
}

/** Emit one op. `keyExpr`/`payloadExpr` are SQL expressions. */
function emitOp(
  entity: string,
  opKind: "put" | "del",
  keyExpr: string,
  payloadExpr: string,
): string {
  return `${ADVANCE_CLOCK}
  INSERT INTO ops ${OP_COLS} VALUES (
    ${HLC},${OP_CTX_VALUES},
    '${entity}',
    ${keyExpr},
    '${opKind}',
    ${payloadExpr},
    ${CREATED_AT}
  );`;
}

/** Columns captured per portable table. Deliberately EXCLUDES surrogate
 *  ids and FK columns that are already encoded in the natural key
 *  (`tasks.workstream_id`, `task_notes.task_id`, the edge endpoints),
 *  because shipping a peer our local rowids would be worse than
 *  useless. Changing one of those would re-key the row, which no op
 *  can express, so KEY_COLUMNS below refuses it instead. `tasks.owner_id` IS captured: it is an FK into the
 *  machine-local `agents` table, so it never syncs (see
 *  MACHINE_LOCAL_TABLES), but it must still be captured for local
 *  history of a claim/release. */
const CAPTURED_COLUMNS = {
  workstreams: ["name", "created_at", "torn_down_at"],
  tasks: [
    "local_id",
    "title",
    "status",
    "substate",
    "impact",
    "effort_days",
    "scored",
    "dispatch_host",
    "owner_id",
    "created_at",
    "updated_at",
  ],
  task_notes: ["author", "content", "created_at", "kind"],
  task_edges: ["created_at"],
} as const satisfies Record<(typeof PORTABLE_TABLES)[number], readonly string[]>;

/** Columns that make up (or resolve to) each table's natural key.
 *
 *  An UPDATE of one of these moves the row to a different `ops.key`
 *  (`a/t1` -> `b/t1`), and every op already in the log stays filed under
 *  the old key. The UPDATE triggers above diff only CAPTURED_COLUMNS, so
 *  such an update used to emit NOTHING: no tombstone for the old key, no
 *  put for the new one. Sync, rebuild and `mu doctor` then disagree
 *  with the live row. Children re-key with it (a task's notes and edges
 *  embed its key), so capturing a move would mean re-emitting a subtree.
 *
 *  Natural keys are immutable instead: apply (NEVER_APPLY)
 *  already never writes these columns, and a raw
 *  `mu sql` UPDATE is refused here with an explicit error rather than
 *  committing a row the log cannot explain. The guard is NOT gated on
 *  the echo guard: no mu path re-keys a row, ingest included. */
const KEY_COLUMNS = {
  workstreams: ["name"],
  tasks: ["workstream_id", "local_id"],
  task_notes: ["id", "task_id"],
  task_edges: ["from_task_id", "to_task_id"],
} as const satisfies Record<(typeof PORTABLE_TABLES)[number], readonly string[]>;

/** One stored trigger. `sql` is exactly the text SQLite keeps in
 *  sqlite_master (`CREATE TRIGGER <name> … END`, no `;`), so the stored
 *  trigger can be compared to the generator byte for byte. */
export interface CaptureTrigger {
  name: string;
  sql: string;
}

/** `CREATE TRIGGER <name>\n<rest>\nEND`. `rest` is the timing/event/WHEN
 *  header followed by `BEGIN … ` up to (not including) END. */
function trigger(name: string, rest: string): CaptureTrigger {
  return { name, sql: `CREATE TRIGGER ${name}\n${rest.trim()}\nEND` };
}

/** BEFORE UPDATE trigger refusing a natural-key change on `table`. */
function keyGuard(table: keyof typeof KEY_COLUMNS): CaptureTrigger {
  const cols = KEY_COLUMNS[table];
  const msg =
    `mu: ${table}.${cols.join("/")} is part of the natural key that every op is filed under; ` +
    "changing it would desync the ops log and sync. " +
    "Add a new row (mu task add / mu workstream init) instead of moving or renaming one.";
  return trigger(
    `_cap_${table}_key`,
    `BEFORE UPDATE OF ${cols.join(", ")} ON ${table}
  WHEN ${anyChanged(cols)}
BEGIN
  SELECT RAISE(ABORT, '${msg.replaceAll("'", "''")}');`,
  );
}

/** Existing-row predicate for the BEFORE INSERT guard: the row `NEW` would
 *  collide with, by surrogate id or by natural key.
 *
 *  SQLite reports NEW.id / NEW.rowid = -1 for an omitted id (the real one is
 *  assigned after BEFORE triggers), so -1 cannot be told from an explicit -1.
 *  The id check skips it: otherwise one raw `id = -1` row would make every
 *  later omitted-id insert look like a collision. An explicit -1 REPLACE is
 *  then caught only by the natural-key check. */
const INSERT_COLLISION = {
  workstreams: "SELECT 1 FROM workstreams WHERE (NEW.id <> -1 AND id = NEW.id) OR name = NEW.name",
  tasks:
    "SELECT 1 FROM tasks WHERE (NEW.id <> -1 AND id = NEW.id) OR (workstream_id = NEW.workstream_id AND local_id = NEW.local_id)",
  task_notes: "SELECT 1 FROM task_notes WHERE NEW.id <> -1 AND id = NEW.id",
  // task_edges has a composite key, so its hidden rowid is a second identity.
  // (The other three tables' `id` IS the rowid.)
  task_edges:
    "SELECT 1 FROM task_edges WHERE (NEW.rowid <> -1 AND rowid = NEW.rowid) OR (from_task_id = NEW.from_task_id AND to_task_id = NEW.to_task_id)",
} as const satisfies Record<keyof typeof KEY_COLUMNS, string>;

/** BEFORE INSERT trigger refusing an insert that collides with an existing
 *  row's id or natural key. `INSERT OR REPLACE` would otherwise delete that
 *  row without firing the DELETE trigger (no tombstone) and re-file it under
 *  a new key. It also aborts `INSERT OR IGNORE` (BEFORE triggers run before
 *  constraints), so mu inserts with `WHERE NOT EXISTS` instead. */
function insertGuard(table: keyof typeof KEY_COLUMNS): CaptureTrigger {
  const msg =
    `mu: ${table} row already exists; replacing it would change the natural key that every op is filed under ` +
    "and leave no tombstone in the ops log. DELETE it, then INSERT, or add a new row.";
  return trigger(
    `_cap_${table}_insguard`,
    `BEFORE INSERT ON ${table}
  WHEN EXISTS (${INSERT_COLLISION[table]})
BEGIN
  SELECT RAISE(ABORT, '${msg.replaceAll("'", "''")}');`,
  );
}

/** The id column each table's INSERT guard and id check read. `NEW.rowid`
 *  for task_edges: its key is composite, so the hidden rowid is the id. */
const ID_EXPR = {
  workstreams: "NEW.id",
  tasks: "NEW.id",
  task_notes: "NEW.id",
  task_edges: "NEW.rowid",
} as const satisfies Record<keyof typeof KEY_COLUMNS, string>;

/** AFTER INSERT trigger refusing an explicit id <= 0 (local writes only).
 *
 *  BEFORE triggers report -1 for an omitted id, so the BEFORE guard above
 *  cannot tell an explicit -1 from an omission. By AFTER INSERT SQLite has
 *  assigned the real id (always positive for an omitted one), so an id <= 0
 *  here was named by the writer. Refusing them keeps -1 free to mean
 *  "omitted" in the guard, and aborts the statement, rolling back the row
 *  and the op the capture trigger just minted. */
function positiveIdGuard(table: keyof typeof KEY_COLUMNS): CaptureTrigger {
  return trigger(
    `_cap_${table}_posid`,
    `AFTER INSERT ON ${table}
  WHEN ${NOT_APPLYING} AND ${ID_EXPR[table]} <= 0
BEGIN
  SELECT RAISE(ABORT, 'mu: explicit non-positive ids are refused');`,
  );
}

/** BEFORE UPDATE trigger: a note's kind is set once at INSERT. A change
 *  would sync as a `{kind}`-only put that no peer can match to a row (a
 *  note's identity is its content), so local writes refuse it. Gated on
 *  `applying = 0`: ingest accepts what the log says, and a RAISE there
 *  would roll back the segment and stall sync. */
const NOTE_KIND_GUARD = trigger(
  "_cap_task_notes_kind",
  `BEFORE UPDATE OF kind ON task_notes
  WHEN ${NOT_APPLYING} AND NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'mu: task_notes.kind is set once when the note is written; add a new note instead of changing it.');`,
);

/**
 * THE DELETE SUBTLETY
 * -------------------
 * Every other op can resolve its natural key lazily, because the row is
 * still there. DELETE cannot: by the time anything downstream looks,
 * the row is gone. So the key is captured INLINE, in the trigger, while
 * the row still exists.
 *
 * That alone is not enough, because of FK CASCADE. Empirically (this
 * was the thing most worth checking): SQLite FK `ON DELETE CASCADE`
 * DOES fire triggers on the cascaded child rows — and it does so
 * regardless of the `recursive_triggers` pragma, which governs only
 * trigger-initiated recursion, not FK actions. Good: destroying a
 * workstream captures its tasks, notes and edges without any explicit
 * walk in the SDK.
 *
 * The trap is ORDERING. With AFTER DELETE triggers, cascaded children
 * fire after the parent row is already deleted, so joining to the
 * parent to build the child's key yields nothing:
 *
 *   DELETE FROM workstreams WHERE id = 1
 *     -> edge  op key "<unresolved>-><unresolved>"
 *     -> note  op key "<unresolved>#100"
 *     -> task  op key "<unresolved>/t1"
 *
 * Two mechanisms fix it together:
 *
 *   1. BEFORE DELETE, not AFTER. The row and its ancestors are all
 *      still present when the trigger body runs, so `OLD.*` plus a
 *      normal join resolves the key.
 *   2. The `op_dying` stash. BEFORE DELETE fixes the FIRST level only:
 *      cascade children still fire after their parent's row is gone.
 *      So each parent's BEFORE DELETE trigger records its own natural
 *      key into `op_dying` before emitting, and the child key
 *      resolvers (`wsKey` / `taskKey`) consult the stash when the live
 *      join misses. SQLite fires a cascade's child AFTER DELETE triggers
 *      before the parent's, so the parent's AFTER DELETE trigger removes
 *      its stash row (`_cap_*_undie`): the table is empty at rest even
 *      when a plain connection did the delete. INSERT OR REPLACE keyed
 *      on (kind, id) covers a row whose stash outlived a crashed delete
 *      (the rollback removes it too, so this is belt and braces).
 *
 * The alternative — having the parent trigger emit ops for its whole
 * subtree and suppressing the cascade triggers — also works and was
 * prototyped, but it duplicates the subtree walk in SQL four times and
 * breaks the moment a new FK is added. The stash is smaller and
 * self-maintaining.
 */
const DYING_STASH = (kind: "workstream" | "task", keyExpr: string): string =>
  `INSERT OR REPLACE INTO op_dying (kind, id, key) VALUES ('${kind}', OLD.id, ${keyExpr});`;

/** Emitting trigger: `timing event ON table WHEN guard [AND extra]`. */
function emitting(
  name: string,
  header: string,
  extraWhen: string | undefined,
  body: string,
): CaptureTrigger {
  const when = extraWhen === undefined ? NOT_APPLYING : `${NOT_APPLYING}\n  AND (${extraWhen})`;
  return trigger(
    name,
    `${header}
  WHEN ${when}
BEGIN
  ${body}`,
  );
}

/** Every capture trigger, in creation order. Pure. */
function buildTriggers(): CaptureTrigger[] {
  const wsCols = CAPTURED_COLUMNS.workstreams;
  const taskCols = CAPTURED_COLUMNS.tasks;
  const noteCols = CAPTURED_COLUMNS.task_notes;
  const edgeCols = CAPTURED_COLUMNS.task_edges;

  const taskKeyNew = `${wsKey("NEW.workstream_id")} || '/' || NEW.local_id`;
  const taskKeyOld = `${wsKey("OLD.workstream_id")} || '/' || OLD.local_id`;
  const noteKeyNew = `${taskKey("NEW.task_id")} || '#' || NEW.id`;
  const noteKeyOld = `${taskKey("OLD.task_id")} || '#' || OLD.id`;
  const edgeKeyNew = `${taskKey("NEW.from_task_id")} || '->' || ${taskKey("NEW.to_task_id")}`;
  const edgeKeyOld = `${taskKey("OLD.from_task_id")} || '->' || ${taskKey("OLD.to_task_id")}`;

  const tables = ["workstreams", "tasks", "task_notes", "task_edges"] as const;
  return [
    // natural-key guards (see KEY_COLUMNS)
    ...tables.map(keyGuard),
    ...tables.map(insertGuard),
    ...tables.map(positiveIdGuard),
    NOTE_KIND_GUARD,
    // The singleton op_ctx row must survive: the HLC clock reads
    // `now_ms` from it, and a missing row would NULL last_wall.
    trigger(
      "_cap_op_ctx_nodelete",
      `BEFORE DELETE ON op_ctx
BEGIN
  SELECT RAISE(ABORT, 'mu: op_ctx is the op context row; it is never deleted.');`,
    ),

    // workstreams
    emitting(
      "_cap_workstreams_ins",
      "AFTER INSERT ON workstreams",
      undefined,
      emitOp("workstream", "put", "NEW.name", fullPayload(wsCols)),
    ),
    emitting(
      "_cap_workstreams_upd",
      "AFTER UPDATE ON workstreams",
      anyChanged(wsCols),
      emitOp("workstream", "put", "NEW.name", changedPayload(wsCols)),
    ),
    emitting(
      "_cap_workstreams_del",
      "BEFORE DELETE ON workstreams",
      undefined,
      `${DYING_STASH("workstream", "OLD.name")}
  ${emitOp("workstream", "del", "OLD.name", "'{}'")}`,
    ),
    undieTrigger("workstreams", "workstream"),

    // tasks
    emitting(
      "_cap_tasks_ins",
      "AFTER INSERT ON tasks",
      undefined,
      emitOp("task", "put", taskKeyNew, fullPayload(taskCols)),
    ),
    emitting(
      "_cap_tasks_upd",
      "AFTER UPDATE ON tasks",
      anyChanged(taskCols),
      emitOp("task", "put", taskKeyNew, changedPayload(taskCols)),
    ),
    emitting(
      "_cap_tasks_del",
      "BEFORE DELETE ON tasks",
      undefined,
      `${DYING_STASH("task", taskKeyOld)}
  ${emitOp("task", "del", taskKeyOld, "'{}'")}`,
    ),
    undieTrigger("tasks", "task"),

    // task_notes
    emitting(
      "_cap_task_notes_ins",
      "AFTER INSERT ON task_notes",
      undefined,
      emitOp("note", "put", noteKeyNew, fullPayload(noteCols)),
    ),
    emitting(
      "_cap_task_notes_upd",
      "AFTER UPDATE ON task_notes",
      anyChanged(noteCols),
      emitOp("note", "put", noteKeyNew, changedPayload(noteCols)),
    ),
    emitting(
      "_cap_task_notes_del",
      "BEFORE DELETE ON task_notes",
      undefined,
      emitOp("note", "del", noteKeyOld, noteTombstonePayload(noteKeyOld, noteCols)),
    ),

    // task_edges
    emitting(
      "_cap_task_edges_ins",
      "AFTER INSERT ON task_edges",
      undefined,
      emitOp("edge", "put", edgeKeyNew, fullPayload(edgeCols)),
    ),
    emitting(
      "_cap_task_edges_upd",
      "AFTER UPDATE ON task_edges",
      anyChanged(edgeCols),
      emitOp("edge", "put", edgeKeyNew, changedPayload(edgeCols)),
    ),
    emitting(
      "_cap_task_edges_del",
      "BEFORE DELETE ON task_edges",
      undefined,
      emitOp("edge", "del", edgeKeyOld, "'{}'"),
    ),
  ];
}

/** AFTER DELETE: drop this row's `op_dying` stash entry. SQLite fires a
 *  cascade's child AFTER triggers before the parent's, and every child
 *  key was resolved in a BEFORE trigger, so nothing needs the entry any
 *  more. Keeps `op_dying` empty at rest, whoever did the delete. */
function undieTrigger(table: string, kind: "workstream" | "task"): CaptureTrigger {
  return emitting(
    `_cap_${table}_undie`,
    `AFTER DELETE ON ${table}`,
    undefined,
    `DELETE FROM op_dying WHERE kind = '${kind}' AND id = OLD.id;`,
  );
}

/** The capture triggers, built once at module load. */
export const CAPTURE_TRIGGERS: readonly CaptureTrigger[] = buildTriggers();

/** Every capture trigger as `CREATE TRIGGER …;` statements, in order. */
export const CAPTURE_TRIGGER_DDL = CAPTURE_TRIGGERS.map((t) => `${t.sql};`).join("\n\n");

/**
 * How many `total_changes()` the capture triggers themselves added while
 * stamping the ops of `groupId`. `mu sql --confirm-rows` subtracts this
 * from its delta so it can count user rows on the SAME capture-on run it
 * commits (no probe-then-rerun).
 *
 * Mirrors the trigger bodies above: every `emitOp` is exactly 3 changes
 * (the `op_ctx.now_ms` UPDATE, the `machine_identity` UPDATE, the ops
 * INSERT), and every workstream/task tombstone also writes 2 stash rows
 * (`DYING_STASH` in, `undieTrigger` out). Change a trigger body and this
 * must change too; test/sql-capture.test.ts pins it with cascading
 * deletes.
 */
export function captureBookkeepingChanges(db: CaptureDb, groupId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS ops,
              COALESCE(SUM(op = 'del' AND entity IN ('workstream', 'task')), 0) AS stashed
         FROM ops WHERE group_id = ?`,
    )
    .get(groupId) as { ops: number; stashed: number };
  return 3 * row.ops + 2 * row.stashed;
}

// ─── Installation ─────────────────────────────────────────────────────

/** Names of the stored capture triggers (`_cap_` prefix; `_` escaped
 *  because it is a LIKE wildcard). */
const STORED_TRIGGERS_SQL =
  "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_cap\\_%' ESCAPE '\\' ORDER BY name";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** sha256 over `name\nsql\n` of each trigger, sorted by name. */
function checksum(triggers: readonly CaptureTrigger[]): string {
  const sorted = [...triggers].sort((a, b) => (a.name < b.name ? -1 : 1));
  return sha256(sorted.map((t) => `${t.name}\n${t.sql}\n`).join(""));
}

/** Checksum of the triggers this build would install. */
export const GENERATED_TRIGGER_CHECKSUM = checksum(CAPTURE_TRIGGERS);

/** The capture revision stamped in this file: 0 when the stamp is
 *  missing (a DB from before the column existed), null when there is no
 *  schema_version row at all (a fresh file). */
export function storedCaptureVersion(db: CaptureDb): number | null {
  const cols = db.prepare("SELECT name FROM pragma_table_info('schema_version')").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "capture_version")) {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .get();
    return hasTable === undefined ? null : 0;
  }
  const row = db.prepare("SELECT capture_version FROM schema_version WHERE id = 1").get() as
    | { capture_version: number }
    | undefined;
  return row === undefined ? null : row.capture_version;
}

/** What `mu doctor` reports: the stamp, and the checksum of the trigger
 *  SQL actually stored in the file next to the one this build generates. */
export function captureTriggerChecksums(db: CaptureDb): { stored: string; generated: string } {
  const stored = db.prepare(STORED_TRIGGERS_SQL).all() as CaptureTrigger[];
  return { stored: checksum(stored), generated: GENERATED_TRIGGER_CHECKSUM };
}

/** True when the stored triggers are byte-for-byte what this build
 *  generates (same names, same SQL). */
export function captureTriggersCurrent(db: CaptureDb): boolean {
  const { stored, generated } = captureTriggerChecksums(db);
  return stored === generated;
}

/** Thrown by `installCapture` when the file's capture stamp is NEWER than
 *  this build's: a later mu wrote triggers this one cannot vouch for, and
 *  replacing them would silently downgrade every other machine's rules.
 *  openDb turns it into SchemaTooNewError. */
export class CaptureTooNewError extends Error {
  override readonly name = "CaptureTooNewError";
  constructor(public readonly stored: number) {
    super(`capture revision ${stored} is newer than this build's ${CAPTURE_VERSION}`);
  }
}

/**
 * Make the capture triggers in this file current. Called once by
 * `openDb` on every non-readonly open, after the schema is applied.
 *
 *   stamp == CAPTURE_VERSION  nothing: no DDL, no write lock.
 *   stamp  > CAPTURE_VERSION  CaptureTooNewError; the file is untouched.
 *   stamp  < CAPTURE_VERSION  (or missing) drop every `_cap_*` trigger,
 *                             create the generated set, seed `op_ctx`,
 *                             and stamp: ONE BEGIN IMMEDIATE, so no
 *                             connection ever sees half a trigger set
 *                             and a crash leaves the old set and the old
 *                             stamp together. The stamp is re-read under
 *                             the lock: a concurrent opener that won the
 *                             race makes this a no-op, and a newer one
 *                             is still refused.
 */
export function installCapture(db: CaptureDb): void {
  if (db.inTransaction) throw new Error("installCapture must run outside a transaction");
  const quick = storedCaptureVersion(db);
  if (quick === CAPTURE_VERSION) return;
  if (quick !== null && quick > CAPTURE_VERSION) throw new CaptureTooNewError(quick);

  db.exec("BEGIN IMMEDIATE");
  try {
    const locked = storedCaptureVersion(db);
    if (locked !== null && locked > CAPTURE_VERSION) throw new CaptureTooNewError(locked);
    if (locked !== CAPTURE_VERSION) {
      const cols = db.prepare("SELECT name FROM pragma_table_info('schema_version')").all() as {
        name: string;
      }[];
      if (!cols.some((c) => c.name === "capture_version")) {
        db.exec("ALTER TABLE schema_version ADD COLUMN capture_version INTEGER NOT NULL DEFAULT 0");
      }
      const old = db.prepare(STORED_TRIGGERS_SQL).all() as { name: string }[];
      for (const t of old) db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);
      for (const t of CAPTURE_TRIGGERS) db.exec(t.sql);
      db.prepare("INSERT OR IGNORE INTO op_ctx (id) VALUES (1)").run();
      db.prepare("UPDATE schema_version SET capture_version = ? WHERE id = 1").run(CAPTURE_VERSION);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

/** The slice of better-sqlite3's Database that capture needs. Declared
 *  structurally rather than importing `Db` from db.ts, because db.ts
 *  imports THIS module — a nominal import would be a cycle, and an
 *  import cycle here silently breaks `node dist/cli.js`. */
export interface CaptureDb {
  readonly inTransaction: boolean;
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: readonly unknown[]): unknown;
    get(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
  };
}

/** One `mu doctor` row for the capture layer: the SQLite in use (>= 3.42),
 *  the capture revision stamped in the file, and the sha256 of the stored
 *  trigger SQL against the generated DDL. `sqliteVersion` is injectable
 *  for tests. Shared by `mu doctor` and the TUI's doctor card. */
export function captureDoctorCheck(
  db: CaptureDb,
  sqliteVersion?: string,
): { status: "ok" | "warn" | "fail"; detail: string } {
  const version =
    sqliteVersion ?? (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  const stamp = storedCaptureVersion(db);
  const { stored, generated } = captureTriggerChecksums(db);
  const short = generated.slice(0, 12);
  if (sqliteTooOld(version)) {
    return {
      status: "fail",
      detail: `sqlite ${version} is below ${MIN_SQLITE.major}.${MIN_SQLITE.minor}: capture triggers abort every write`,
    };
  }
  if (stamp !== CAPTURE_VERSION) {
    return {
      status: "fail",
      detail: `capture ${stamp ?? "unstamped"} (code expects ${CAPTURE_VERSION}); sqlite ${version}`,
    };
  }
  if (stored !== generated) {
    return {
      status: "fail",
      detail: `capture ${stamp}; stored trigger checksum ${stored.slice(0, 12)} differs from generated ${short} (edited behind mu's back?); sqlite ${version}`,
    };
  }
  return { status: "ok", detail: `capture ${stamp}, triggers ${short}, sqlite ${version}` };
}
