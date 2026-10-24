// mu — the **op context** SDK seam (docs/VOCABULARY.md § op context).
//
// Triggers capture reliably but blindly: they see a row change, not why
// it happened. Intent, grouping and actor are recovered by having the
// SDK write them into the one-row `op_ctx` table, which the stored
// triggers read as they stamp each op.
//
// ONE ASSIGNMENT PER PUBLIC SDK FUNCTION, not an emit per mutation.
// That is the whole reason this is cheap enough to apply everywhere: a
// cascade close touching 12 tasks sets the context once and gets 12
// correctly-labelled, correctly-grouped ops for free.
//
// WHY A SCOPED WRAPPER RATHER THAN A SETTER
// -----------------------------------------
// The obvious alternative is `setOpContext(db, {...})` called at the top
// of each SDK function. It was rejected: it leaks. Whatever intent was
// set last stays set for the rest of the process, so the NEXT mutation
// — possibly in a caller that never set a context, possibly in a
// finally-block cleanup after a throw — gets mislabelled with a stale
// intent. A wrong intent is worse than a null one, because `mu log`
// renders it as confident prose.
//
// `withOpContext(db, {...}, fn)` restores the previous context in a
// `finally`, so:
//   * a throw inside fn cannot leak the intent (tested),
//   * nesting is predictable — an inner context wins while it runs and
//     the outer one is exactly restored after,
//   * the context's lifetime is visible in the source as a block.
//
// Nested calls inherit the OUTER group by default, which is what makes
// grouping work without any caller threading a group id around:
// `closeTask` opening a group and calling `setTaskStatus` per cascaded
// child yields one group covering all of them. An inner call that wants
// its own group passes `group: "new"`.

import { randomUUID } from "node:crypto";
import { type Db, prepareCached } from "./db.js";

/** What an op context carries. All fields optional — a partial context
 *  is fine and a null intent is captured as null (fail safe). */
export interface OpContext {
  /** Semantic label, e.g. `task.close`. Human-grade: `mu log` renders
   *  prose from it. Use `<entity>.<verb>` with entities from
   *  docs/VOCABULARY.md. */
  intent?: string | undefined;
  /**
   * Intent to use ONLY when no enclosing context already set one.
   *
   * For shared internals that several public verbs funnel through.
   * `setTaskStatus` is the motivating case: called directly it is the
   * operator's action and should label itself, but called from
   * `closeTask` the OUTER verb is the operator-meaningful label and
   * must win. Without this, the inner call would report the mechanism
   * instead of the intent.
   *
   * Ignored when `intent` is also provided.
   */
  intentIfUnset?: string | undefined;
  /** Who caused it. Free text, same semantics as the old
   *  `agent_logs.source`: an agent name, "user", "system". */
  actor?: string | undefined;
  /**
   * Op grouping:
   *   - omitted   inherit the enclosing group, or start one if none.
   *   - "new"     force a fresh group even when nested.
   *   - <string>  use this exact group id.
   */
  group?: string | "new" | undefined;
}

interface CtxRow {
  group_id: string | null;
  actor: string | null;
  intent: string | null;
  applying: number;
}

/** The context at rest: what a row holds whenever no wrapper is active,
 *  and what a plain write from any connection is stamped with. */
const DEFAULT_CTX: CtxRow = { group_id: null, actor: null, intent: null, applying: 0 };

/** Read the current context. Exported for tests and for `mu doctor`. */
export function currentOpContext(db: Db): {
  groupId: string | null;
  actor: string | null;
  intent: string | null;
  applying: boolean;
} {
  const row = readCtx(db) ?? DEFAULT_CTX;
  return {
    groupId: row.group_id,
    actor: row.actor,
    intent: row.intent,
    applying: row.applying !== 0,
  };
}

function writeCtx(db: Db, row: CtxRow): void {
  prepareCached(
    db,
    `INSERT INTO op_ctx (id, group_id, actor, intent, applying)
     VALUES (1, @group_id, @actor, @intent, @applying)
     ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, actor = excluded.actor,
                                    intent = excluded.intent, applying = excluded.applying`,
  ).run(row);
}

function readCtx(db: Db): CtxRow | undefined {
  return prepareCached(
    db,
    "SELECT group_id, actor, intent, applying FROM op_ctx WHERE id = 1",
  ).get() as CtxRow | undefined;
}

/**
 * Run `fn` with `next(previous)` as the context row, then put the
 * context back. THE one place that writes `op_ctx`.
 *
 * Outermost call (no transaction open) OWNS the transaction:
 *
 *   BEGIN IMMEDIATE; write ctx; fn(); reset ctx to defaults; COMMIT
 *
 * `op_ctx` is a plain table in the file, shared by every connection, so
 * the context may only exist INSIDE a write transaction: other writers
 * wait on the lock instead of being stamped with this intent (or with
 * `applying = 1`, which would drop their ops), readers see the committed
 * defaults, and a throw or a crash rolls the context back with the data.
 * A throw in `fn` is ROLLBACK, which discards the context write too.
 *
 * Nested call (a transaction is already open, ours or a caller's): no
 * BEGIN/COMMIT; write, run, and restore the PREVIOUS row in a `finally`,
 * so an inner scope wins while it runs and the outer one is exactly
 * back after. better-sqlite3 `db.transaction()` calls inside `fn` become
 * savepoints and keep working.
 *
 * A readonly connection cannot stamp anything: `fn` just runs.
 */
function withCtxRow<T>(db: Db, next: (previous: CtxRow) => CtxRow, fn: () => T): T {
  if (db.readonly) return fn();

  if (db.inTransaction) {
    const previous = readCtx(db) ?? DEFAULT_CTX;
    const row = next(previous);
    // Hot path (ingest calls this once per op, already suppressed).
    if (sameCtx(row, previous)) return fn();
    writeCtx(db, row);
    try {
      return fn();
    } finally {
      // The context row lives in the transaction. If fn ended it (an
      // implicit ROLLBACK such as INSERT OR ROLLBACK, a RAISE(ROLLBACK)
      // trigger, SQLITE_FULL, or a raw COMMIT) the write below would
      // AUTOCOMMIT, publishing the outer context (even `applying = 1`)
      // to every other connection. So restore only inside a live
      // transaction; otherwise leave nothing but defaults behind. The
      // outermost scope reports the ended transaction.
      if (db.inTransaction) writeCtx(db, previous);
      else resetCommittedCtx(db);
    }
  }

  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    // At rest the row is defaults. Read it anyway (rather than assuming)
    // so a hand-edited row cannot leak into the scope's inheritance.
    writeCtx(db, next(DEFAULT_CTX));
    result = fn();
    if (!db.inTransaction) throw new CtxTransactionEndedError();
    writeCtx(db, DEFAULT_CTX);
  } catch (err) {
    if (db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    } else {
      // fn ended the transaction the context lives in. After a ROLLBACK
      // the row is already defaults and nothing is written; after a
      // COMMIT it was committed too, so put it back before anyone else
      // reads it.
      resetCommittedCtx(db);
    }
    throw err;
  }
  try {
    db.exec("COMMIT");
  } catch (err) {
    // A deferred FK violation fails COMMIT and leaves the transaction
    // open (still holding the lock, context row and all).
    if (db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw err;
  }
  return result;
}

/** Outside any transaction: make the committed context row defaults,
 *  writing (an autocommit, waiting on the lock like any writer) only if
 *  it is not already. A rolled-back scope needs no write at all. */
function resetCommittedCtx(db: Db): void {
  const row = readCtx(db);
  if (row !== undefined && sameCtx(row, DEFAULT_CTX)) return;
  writeCtx(db, DEFAULT_CTX);
}

/** Thrown when `fn` COMMITs or ROLLBACKs the transaction its op-context
 *  scope owns (a raw `COMMIT`, `END`, `ROLLBACK`). The scope cannot
 *  honour its contract after that, so it fails loudly. */
export class CtxTransactionEndedError extends Error {
  override readonly name = "CtxTransactionEndedError";
  constructor() {
    super(
      "an op-context scope's transaction was ended inside the scope (COMMIT/END/ROLLBACK); the scope owns that transaction",
    );
  }
}

const sameCtx = (a: CtxRow, b: CtxRow): boolean =>
  a.group_id === b.group_id &&
  a.actor === b.actor &&
  a.intent === b.intent &&
  a.applying === b.applying;

/**
 * Run `fn` with the given op context applied; see `withCtxRow` for the
 * transaction it owns and how the context is restored.
 *
 * Synchronous by design. Every mutating mu SDK function is synchronous
 * (better-sqlite3 is), so an async variant would only invite
 * interleaving two contexts on one connection — and, now that the scope
 * holds the write lock, would hold it across an await. Keeping this sync
 * makes both unrepresentable.
 */
export function withOpContext<T>(db: Db, ctx: OpContext, fn: () => T): T {
  return withCtxRow(
    db,
    (previous) => {
      const groupId =
        ctx.group === "new"
          ? randomUUID()
          : ctx.group !== undefined
            ? ctx.group
            : (previous.group_id ?? randomUUID());
      return {
        group_id: groupId,
        // An explicit undefined inherits; only a provided value overrides.
        actor: ctx.actor !== undefined ? ctx.actor : previous.actor,
        intent:
          ctx.intent !== undefined ? ctx.intent : (previous.intent ?? ctx.intentIfUnset ?? null),
        applying: previous.applying,
      };
    },
    fn,
  );
}

/**
 * Run `fn` with capture SUPPRESSED — the echo guard.
 *
 * Applying a peer's op writes to `tasks`, which fires the capture
 * trigger, which mints a NEW local op, which flushes to our segment and
 * propagates back to the peer, which applies it and echoes again. This
 * sets `applying = 1` so every trigger's `WHEN` clause short-circuits
 * and the ingest writes rows WITHOUT writing ops.
 *
 * It lives here rather than in the sync module because the flag is part
 * of the op-context contract the triggers read, and having exactly one
 * writer of it is the point. Outermost, it owns a transaction like
 * `withOpContext`, so `applying = 1` is never committed: a crash cannot
 * leave capture off, and no other connection can write while it is on.
 * The previous value comes back in a `finally` (nested) or by ROLLBACK
 * (outermost), so a throw mid-ingest cannot leave capture disabled, the
 * worst failure mode: silently dropping every later local change.
 */
export function withCaptureSuppressed<T>(db: Db, fn: () => T): T {
  return withCtxRow(db, (previous) => ({ ...previous, applying: 1 }), fn);
}
