// mu — `mu db query` (alias `mu sql`): the SQL escape hatch.
//
// Read OR write. The single-statement path uses better-sqlite3's prepare()
// so we can tell a read (.all() rows) from a write (.run() change count);
// a script runs one statement at a time (runScript).
//
// Every write runs inside ONE op-context scope, which owns the
// transaction (src/op-context.ts): one `sql.write` group, atomic, and
// the context is never committed. The boundary is a POLICY, not a hunt for
// tricks: this verb never changes the schema or the connection, so no TEMP
// trigger, shadowing table, attached DB or PRAGMA can exist to subvert capture.
//
//   * No DDL of any kind (CREATE/DROP/ALTER, TEMP included), no ATTACH or
//     DETACH, and only a read-only PRAGMA allowlist. Someone who needs DDL
//     uses `mu db backup` / `forget`, or opens the file with sqlite3.
//   * SQLite, never a keyword scan of the text, decides what a statement
//     does: one `EXPLAIN` per statement (checkStatement). better-sqlite3 has
//     no authorizer callback, so the listing is the authority. It names
//     transaction control (AutoCommit / Savepoint: refused, the scope owns the
//     transaction), ATTACH/DETACH (`sqlite_attach` / `sqlite_detach`
//     calls), DDL (any write to a sqlite_master root page, main or temp) and
//     every table a program writes, trigger bodies included: op_ctx /
//     op_dying / ops / schema_version / machine_identity / sync_peers are
//     refused unless a MAIN `_cap_*` trigger writes them. That is capture
//     working. Also refused: a statement's own write to sqlite_sequence, and
//     an UPDATE of id/rowid on the four guarded tables (a table-less `Delete`).
//   * The one place that reads text is the PRAGMA allowlist, because SQLite
//     applies a PRAGMA when it COMPILES it (`PRAGMA foreign_keys=OFF` flips
//     the connection before any .run()) and its listing does not name the
//     pragma. It reads only the statement's FIRST tokens (a keyword at the
//     start of a statement cannot be an identifier), before the compile.
//
// `--confirm-rows N` adds a safety belt on top: if the actual
// affected-row count (FK cascades included) doesn't match N, the scope
// throws and its ROLLBACK undoes the whole thing.
//
// `-w` (or a managed worker's injected workstream) installs TEMP views
// `ready`, `blocked`, `blockers` for that workstream over the global ones
// (installScopedViews, mu's own DDL); `main.ready` is still reachable.

import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  captureBookkeepingChanges,
  GUARD_ALREADY_OWNED,
  GUARD_NEEDS_EVIDENCE,
  GUARD_NONPOSITIVE_ID,
  GUARD_OPEN_BLOCKERS,
} from "../capture.js";
import { emitJson, handle, injectedWorkstream, parseLines } from "../cli.js";
import { type Db, defaultDbPath, resolveWorkstreamId } from "../db.js";
import { currentOpContext, withOpContext } from "../op-context.js";
import { muTable, pc } from "../output.js";
import { RESULT_BYTES } from "../output-contract.js";
import { shellQuote, shellWord } from "../shell-quote.js";
import {
  CloseNeedsEvidenceError,
  TaskAlreadyOwnedError,
  TaskHasOpenBlockersError,
} from "../tasks.js";
import { CliExitError, SqlColumnError, UsageError } from "./handle.js";
import { jsonDocument, pageRecords, type RecordPage } from "./tasks/records.js";

type Statement = ReturnType<Db["prepare"]>;

export interface DbQueryOptions {
  /** JSON document (the default on the command line; `--table` turns it off). */
  json?: boolean;
  /** `--table`: the human table / prose instead of the JSON document. */
  table?: boolean;
  /** `--all`: every row whole, no 4 KB cap. */
  all?: boolean;
  confirmRows?: number;
  /** Scope `ready` / `blocked` / `blockers` to this workstream. Default: a
   *  managed worker's own, else the global views. */
  workstream?: string;
}

export async function cmdDbQuery(db: Db, query: string, opts: DbQueryOptions = {}): Promise<void> {
  try {
    const ws = opts.workstream ?? injectedWorkstream();
    if (ws !== undefined) installScopedViews(db, ws);
    await runQuery(db, query, opts);
  } catch (err) {
    throw teachColumnError(db, query, err);
  }
}

async function runQuery(db: Db, query: string, opts: DbQueryOptions): Promise<void> {
  // ONE op context for the whole invocation. Without it every captured
  // row got its own random group and a null intent, so one multi-row
  // UPDATE showed up in `mu log` as N separate "(no intent)" actions
  // and printed the raw JSON payload. With it, the whole call is one
  // action, in one transaction.
  //
  // A plain read skips the scope: it would take the write lock (and
  // wait behind every writer) to stamp nothing.
  const trimmed = query.trim();
  let stmt: Statement | undefined;
  try {
    stmt = prepare(db, trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/more than one statement/i.test(msg)) throw err;
  }
  if (stmt?.readonly === true) {
    runSql(db, trimmed, stmt, opts);
    return;
  }
  try {
    withOpContext(db, { intent: "sql.write", group: "new" }, () => runSql(db, trimmed, stmt, opts));
  } catch (err) {
    // The scope has rolled back by now. A local-write guard's RAISE (src/capture.ts)
    // becomes the same typed conflict (exit 4) the typed verbs throw.
    throw guardError(err);
  }
}

/** The typed error for a guard's RAISE, matched by its exact message
 *  (as `mapCloseGuard` in src/tasks/lifecycle.ts does); anything else unchanged. */
function guardError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : "";
  if (msg === GUARD_NEEDS_EVIDENCE) return new CloseNeedsEvidenceError();
  if (msg === GUARD_OPEN_BLOCKERS) return new TaskHasOpenBlockersError();
  if (msg === GUARD_ALREADY_OWNED) return new TaskAlreadyOwnedError();
  if (msg === GUARD_NONPOSITIVE_ID) {
    return new UsageError(
      "explicit non-positive ids are refused: omit the id and SQLite assigns one (rolled back)",
      { showHelp: false },
    );
  }
  return err;
}

// ─── scoped views ─────────────────────────────────────────────────────

/**
 * TEMP `ready`, `blocked` and `blockers` for workstream `ws`, shadowing
 * the global views on THIS connection only. SQLite views take no
 * parameters, so the resolved workstream id is a literal in the DDL; each
 * view keeps its global projection and its torn-down filtering because it
 * selects from `main.<view>`. No agent filter: ready and blocked tasks are
 * OPEN and so have no owner for it to match. Throws WorkstreamNotFoundError
 * (exit 3) for an unknown name.
 */
export function installScopedViews(db: Db, ws: string): void {
  db.exec(scopedViewsSql(resolveWorkstreamId(db, ws)));
}

/** The DDL `installScopedViews` runs; `mu db --shell` hands it to sqlite3. */
export function scopedViewsSql(wsId: number): string {
  const id = Math.trunc(wsId);
  if (!Number.isSafeInteger(id)) throw new Error(`not a workstream id: ${wsId}`);
  return `DROP VIEW IF EXISTS temp.ready;
DROP VIEW IF EXISTS temp.blocked;
DROP VIEW IF EXISTS temp.blockers;
CREATE TEMP VIEW ready AS SELECT * FROM main.ready WHERE workstream_id = ${id};
CREATE TEMP VIEW blocked AS SELECT * FROM main.blocked WHERE workstream_id = ${id};
CREATE TEMP VIEW blockers AS SELECT * FROM main.blockers
  WHERE task_id IN (SELECT id FROM main.tasks WHERE workstream_id = ${id});`;
}

// ─── PRAGMA allowlist ─────────────────────────────────────────────────

/** Read-only PRAGMAs that may take an argument: `PRAGMA table_info(tasks)`. */
const READ_PRAGMAS_WITH_ARG = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "foreign_key_check",
  "integrity_check",
  "quick_check",
]);
/** Read-only PRAGMAs that are only ever read bare: `PRAGMA user_version`
 *  (`= 3` or `(3)` would write the file header). */
const READ_PRAGMAS_BARE = new Set([
  "user_version",
  "foreign_keys",
  "busy_timeout",
  "database_list",
]);

interface Token {
  /** The word, or the unquoted text of a quoted name; the character for punctuation. */
  text: string;
  end: number;
}

/** The token at `from` (trivia already skipped), or undefined at the end. */
function tokenAt(sql: string, from: number): Token | undefined {
  const c = sql[from];
  if (c === undefined) return undefined;
  if (c === "'" || c === '"' || c === "`" || c === "[") {
    const closer = c === "[" ? "]" : c;
    let i = from + 1;
    let text = "";
    while (i < sql.length) {
      if (sql[i] === closer) {
        if (closer !== "]" && sql[i + 1] === closer) {
          text += closer;
          i += 2;
          continue;
        }
        break;
      }
      text += sql[i];
      i++;
    }
    return { text, end: i + 1 };
  }
  let i = from;
  while (i < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i] as string)) i++;
  return i === from ? { text: c, end: from + 1 } : { text: sql.slice(from, i), end: i };
}

/**
 * Refuse a PRAGMA that is not a read-only allowlisted one, BEFORE it is
 * compiled (compiling applies it). Looks only at the statement's first
 * tokens: an optional `EXPLAIN [QUERY PLAN]`, `PRAGMA`, `[schema.]name`, and
 * whether `=` or `(` follows. Any other statement is none of its business.
 */
function guardPragma(sql: string): void {
  const word = (i: number): Token | undefined => tokenAt(sql, skipTrivia(sql, i, false));
  let tok = tokenAt(sql, skipTrivia(sql, 0, true));
  if (tok?.text.toLowerCase() === "explain") {
    tok = word(tok.end);
    if (tok?.text.toLowerCase() === "query") tok = word(word(tok.end)?.end ?? tok.end); // QUERY PLAN
  }
  if (tok?.text.toLowerCase() !== "pragma") return;
  let name = word(tok.end);
  let after = word(name?.end ?? tok.end);
  if (after?.text === ".") {
    name = word(after.end);
    after = word(name?.end ?? after.end);
  }
  const lower = (name?.text ?? "").toLowerCase();
  const bare = after === undefined || after.text === ";";
  const call = after?.text === "(";
  if (
    (bare && (READ_PRAGMAS_BARE.has(lower) || READ_PRAGMAS_WITH_ARG.has(lower))) ||
    (call && READ_PRAGMAS_WITH_ARG.has(lower))
  ) {
    return;
  }
  throw new UsageError(
    `mu db query allows only read-only PRAGMAs (${[...READ_PRAGMAS_WITH_ARG, ...READ_PRAGMAS_BARE].join(", ")}), not PRAGMA ${name?.text ?? ""}; it never changes the connection or the file (use sqlite3 yourself for that)`,
    { showHelp: false },
  );
}

/** Compile `text`, after the PRAGMA allowlist. */
function prepare(db: Db, text: string): Statement {
  guardPragma(text);
  return db.prepare(text);
}

// ─── what a statement does, from SQLite's own listing ─────────────────

const USER_TRANSACTION_MESSAGE = "mu db query runs inside mu's transaction; remove BEGIN/COMMIT";
const PROTECTED_TABLES = new Set([
  "op_ctx",
  "op_dying",
  "ops",
  "schema_version",
  "machine_identity",
  "sync_peers",
]);
/** AUTOINCREMENT counters. Protected only as a statement's own target (see firstProtectedWrite). */
const SEQUENCE_TABLE = "sqlite_sequence";
/** Tables whose ids the capture INSERT guards check (src/capture.ts positiveIdGuard). */
const ID_GUARDED_TABLES = new Set(["workstreams", "tasks", "task_notes", "task_edges"]);
const ID_CHANGE = "id change of ";

interface ExplainRow {
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | null;
  p5: number;
}

/** Index past whitespace and comments from `i` (and `;` too when `semicolons`). */
function skipTrivia(sql: string, from: number, semicolons: boolean): number {
  let i = from;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (/\s/.test(c) || (semicolons && c === ";")) i++;
    else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else break;
  }
  return i;
}

/** Skip leading whitespace, `;` and comments: `prepare` accepts `; BEGIN` as one statement. */
const skipLeadingTrivia = (sql: string): string => sql.slice(skipTrivia(sql, 0, true));

/**
 * Throw if `statement` (one compiled statement) is transaction control, DDL,
 * ATTACH/DETACH, or writes mu's bookkeeping; see the file header. Fails
 * CLOSED: if SQLite cannot list the statement, the error propagates. The one
 * exception is a statement that is itself EXPLAIN, which never runs its body.
 */
export function checkStatement(db: Db, statement: string): void {
  const text = skipLeadingTrivia(statement);
  let rows: ExplainRow[];
  try {
    rows = prepare(db, `EXPLAIN ${text}`).all([]) as ExplainRow[];
  } catch (err) {
    if (/^explain\b/i.test(text)) return;
    throw err;
  }
  if (rows.some((r) => r.opcode === "AutoCommit" || r.opcode === "Savepoint")) {
    throw new UsageError(USER_TRANSACTION_MESSAGE, { showHelp: false });
  }
  if (rows.some((r) => r.opcode === "Function" && /^sqlite_(attach|detach)\(/.test(r.p4 ?? ""))) {
    throw new UsageError(
      "mu db query cannot ATTACH or DETACH a database: it works on this one only (open the file with sqlite3 yourself for that)",
      { showHelp: false },
    );
  }
  const refused = firstProtectedWrite(db, rows);
  if (refused === SCHEMA) {
    throw new UsageError(
      "mu db query cannot change the schema (no CREATE/DROP/ALTER, TEMP included): `mu db backup` first and edit a copy with sqlite3, or `mu db forget`",
      { showHelp: false },
    );
  }
  if (refused?.startsWith(ID_CHANGE) === true) {
    throw new UsageError(
      `mu db query cannot change the id of ${refused.slice(ID_CHANGE.length)}: ids are set once at INSERT (omit the id there); to renumber, DELETE and INSERT a new row`,
      { showHelp: false },
    );
  }
  if (refused === "sync_peers") {
    throw new UsageError(
      "mu db query cannot write sync_peers: those are sync watermarks, and a forged one skips peer ops for good (`mu sync --repair <peer>` re-reads a peer from the start)",
      { showHelp: false },
    );
  }
  if (refused !== undefined) {
    throw new UsageError(
      `mu db query cannot write ${refused}: it is mu's capture bookkeeping (op_ctx, op_dying, ops, schema_version, machine_identity, sqlite_sequence)`,
      { showHelp: false },
    );
  }
}

const SCHEMA = "the schema";

/** The first protected thing the listing writes (a bookkeeping table's name, or SCHEMA), if any. */
function firstProtectedWrite(db: Db, rows: readonly ExplainRow[]): string | undefined {
  const tableOfRoot = new Map<number, string>();
  for (const m of db
    .prepare("SELECT tbl_name, rootpage FROM main.sqlite_master WHERE rootpage > 0")
    .all() as { tbl_name: string; rootpage: number }[]) {
    tableOfRoot.set(m.rootpage, m.tbl_name);
  }
  // A trigger program may write the bookkeeping only when it is a MAIN `_cap_*`
  // trigger. The policy allows no other trigger to exist; asking the main
  // schema (and not the temp one) keeps that true if one ever does.
  const capTriggers = new Set(
    (
      db
        .prepare(
          "SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE '\\_cap\\_%' ESCAPE '\\'",
        )
        .all() as { name: string }[]
    ).map((t) => t.name),
  );
  const tempTriggers = new Set(
    (
      db.prepare("SELECT name FROM temp.sqlite_master WHERE type = 'trigger'").all() as {
        name: string;
      }[]
    ).map((t) => t.name),
  );
  let trusted = false; // the current program is a main capture trigger
  let mainProgram = true; // the statement's own program, not a trigger body
  let counterWrite: string | undefined; // reported last: DDL and bookkeeping win
  let sawWrite = false; // the main program already opened a write cursor
  const cursorTable = new Map<number, string>(); // main program: write cursor -> table
  for (const r of rows) {
    if (r.opcode === "Init") {
      const sub = r.p4 === null ? null : /^-- TRIGGER (.+)$/.exec(r.p4);
      mainProgram = sub === null;
      trusted =
        sub !== null && capTriggers.has(sub[1] as string) && !tempTriggers.has(sub[1] as string);
      continue;
    }
    // A rowid change is a Delete (no change count, no table name) of the row
    // and a re-Insert: the capture triggers only guard INSERT ids.
    if (r.opcode === "Delete" && mainProgram && r.p2 === 0 && r.p4 === null) {
      const table = cursorTable.get(r.p1);
      if (table !== undefined && ID_GUARDED_TABLES.has(table)) return ID_CHANGE + table;
    }
    // [root page, database index] a write opcode touches; main is database 0.
    let target: [number, number] | undefined;
    if (r.opcode === "OpenWrite") target = [r.p2, r.p3];
    else if (r.opcode === "Clear") target = [r.p1, r.p2];
    if (target === undefined) continue;
    const [root, dbIndex] = target;
    // Page 1 of ANY database is its sqlite_master: every CREATE/DROP/ALTER writes it.
    if (root === 1) return SCHEMA;
    if (dbIndex !== 0) continue;
    const name = tableOfRoot.get(root);
    if (name !== undefined && PROTECTED_TABLES.has(name) && !trusted) return name;
    // sqlite_sequence is also written by any AUTOINCREMENT insert, in the
    // main program, AFTER its own target. Only a statement whose FIRST write
    // is the counter table itself edits the counters.
    // (DDL on an AUTOINCREMENT table clears it first; report the schema write instead.)
    if (name === SEQUENCE_TABLE && mainProgram && !sawWrite) counterWrite = name;
    if (mainProgram) {
      sawWrite = true;
      // A table cursor's P4 is its column count; an index's is a key-info "k(...)".
      if (r.opcode === "OpenWrite" && name !== undefined && /^\d+$/.test(r.p4 ?? "")) {
        cursorTable.set(r.p1, name);
      }
    }
  }
  return counterWrite;
}

// ─── the wrong-column hint ────────────────────────────────────────────

/**
 * `no such column: x` becomes one line naming the columns of the tables the
 * query mentions, and the closest ones. SQL is never rewritten or retried.
 * Any other error comes back unchanged.
 */
function teachColumnError(db: Db, query: string, err: unknown): unknown {
  const msg = err instanceof Error ? err.message : "";
  const m = /^no such column: (.+)$/.exec(msg);
  if (m === null) return err;
  const wanted = (m[1] as string).split(".").pop() as string;
  const tables = new Map<string, string[]>();
  try {
    const names = db
      .prepare(
        "SELECT name FROM (SELECT name FROM main.sqlite_master WHERE type IN ('table','view') UNION SELECT name FROM temp.sqlite_master WHERE type = 'view') ORDER BY name",
      )
      .all() as { name: string }[];
    const words = new Set(query.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    for (const { name } of names) {
      if (!words.has(name.toLowerCase())) continue;
      const cols = db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as {
        name: string;
      }[];
      tables.set(
        name,
        cols.map((c) => c.name),
      );
    }
  } catch {
    return err;
  }
  const all = [...new Set([...tables.values()].flat())];
  const lower = wanted.toLowerCase();
  const near = all
    .filter((c) => {
      const cl = c.toLowerCase();
      return cl.includes(lower) || lower.includes(cl) || editDistance(cl, lower) <= 2;
    })
    .slice(0, 3);
  const mean = near.length > 0 ? ` (did you mean ${near.join(", ")}?)` : "";
  const cols =
    tables.size === 0
      ? "name a table to see its columns"
      : [...tables].map(([t, cs]) => `${t}(${cs.join(", ")})`).join("; ");
  return new SqlColumnError(`no such column: ${wanted}${mean}. columns: ${cols}`);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(
          (prev[j] as number) + 1,
          (row[j - 1] as number) + 1,
          (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * Run a multi-statement script one statement at a time, checking each
 * with `checkStatement` just before it runs. SQLite, not the
 * text, decides where a statement ends: a `;` outside strings, quoted
 * identifiers and comments is only a CANDIDATE end, and "incomplete
 * input" from prepare() means the statement goes on (a `CREATE TRIGGER`
 * body, whose inner `;` and `END` are not statements of their own).
 * No keyword is ever inspected.
 *
 * Checking per statement, in the scope's transaction, is what makes a
 * refusal safe: statements compile against the schema the earlier ones
 * built (a trigger on a table the script just created), and a refusal
 * throws, so the scope ROLLs BACK everything that ran before it.
 */
function runScript(db: Db, sql: string): void {
  let start = 0;
  const runOne = (text: string, stmt: Statement): void => {
    checkStatement(db, text);
    if (stmt.reader) stmt.all([]);
    else stmt.run([]);
  };
  for (const end of semicolonOffsets(sql)) {
    const text = sql.slice(start, end + 1);
    let stmt: Statement;
    try {
      stmt = prepare(db, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/incomplete input/i.test(msg)) continue; // statement continues past this `;`
      if (/no statements/i.test(msg)) {
        start = end + 1;
        continue;
      }
      throw err;
    }
    runOne(text, stmt);
    start = end + 1;
  }
  const rest = sql.slice(start);
  try {
    runOne(rest, prepare(db, rest));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no statements/i.test(msg)) throw err;
  }
}

/** Offsets of every `;` that is not inside a string, quoted identifier or comment. */
function semicolonOffsets(sql: string): number[] {
  const offsets: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const closer = c === "[" ? "]" : c;
      i++;
      while (i < sql.length) {
        if (sql[i] === closer) {
          if (closer !== "]" && sql[i + 1] === closer) {
            i += 2; // doubled quote
            continue;
          }
          break;
        }
        i++;
      }
      i++;
    } else {
      if (c === ";") offsets.push(i);
      i++;
    }
  }
  return offsets;
}

function runSql(db: Db, trimmed: string, stmt: Statement | undefined, opts: DbQueryOptions): void {
  // Read OR write — `mu sql` is the explicit escape hatch.
  //
  // Single-statement path uses better-sqlite3's prepare() so we can
  // distinguish read (.all() rows) from write (.run() change count).
  // Multi-statement path (runScript) runs semicolon-separated statements
  // one by one but returns nothing structured. We try prepare() first; if
  // it throws the 'more than one statement' SqliteError, we fall back.
  // This keeps the simple case fast and well-typed while making
  // multi-statement migrations / cleanup scripts a one-shot.
  // `cmdDbQuery` prepared the statement once (review_code_sql_double_prepare);
  // undefined means "more than one statement".
  if (stmt === undefined) {
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      const { actual } = runConfirmed(db, expected, () => runScript(db, trimmed));
      const n = countTopLevelStatements(trimmed);
      if (opts.json) {
        emitJson({
          statements: n,
          multiStatement: true,
          confirmRows: expected,
          actualRows: actual,
        });
        return;
      }
      console.log(
        pc.dim(
          `ran ${n} statement${n === 1 ? "" : "s"} (${actual} row${actual === 1 ? "" : "s"} affected)`,
        ),
      );
      return;
    }
    runScript(db, trimmed);
    const n = countTopLevelStatements(trimmed);
    if (opts.json) {
      emitJson({ statements: n, multiStatement: true });
      return;
    }
    console.log(pc.dim(`ran ${n} statement${n === 1 ? "" : "s"}`));
    return;
  }

  const single = stmt;
  checkStatement(db, trimmed);
  // better-sqlite3's prepared-statement metadata is the source of truth;
  // prefix guesses miss PRAGMA reads and comment-prefixed SELECTs.
  // `readonly` (not `reader`) decides whether --confirm-rows applies:
  // `reader` is also true for `UPDATE ... RETURNING`, which IS a write.
  if (opts.confirmRows !== undefined) {
    if (single.readonly) {
      throw new UsageError(
        "--confirm-rows is only meaningful on write statements (UPDATE / DELETE / INSERT / REPLACE)",
      );
    }
    const expected = opts.confirmRows;
    const { result, actual } = runConfirmed(db, expected, () => single.run([]));
    if (opts.json) {
      emitJson({
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
        confirmRows: expected,
        actualRows: actual,
      });
      return;
    }
    console.log(pc.dim(`${actual} row${actual === 1 ? "" : "s"} affected`));
    return;
  }
  if (single.reader) {
    const rows = single.all([]);
    if (opts.json) {
      // A read is paged to the result cap, with the way back. A write that
      // returns rows (UPDATE .. RETURNING) already ran and cannot be replayed
      // as a retrieval, so it prints every row, whole.
      const whole = opts.all === true || !single.readonly;
      emitJson(sqlRowsPayload(rows, whole, retrieveCommand(trimmed, opts)));
      return;
    }
    if (rows.length === 0) {
      console.log(pc.dim("(no rows)"));
      return;
    }
    const first = rows[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    // SQL is the escape hatch: every column is user-data of unknown
    // length. Divide the terminal width evenly across columns (subject
    // to a 12-char floor) so a single wide cell can't push the table
    // out to ~200 cols and break the TUI layout. cli-table3's
    // wordWrap:false (via muTable) truncates with … when a cell
    // exceeds its column width (tables_truncate_long_cols_audit).
    const termWidth = process.stdout.columns ?? 100;
    const padding = keys.length * 3 + 1; // 2-char cell padding + 1-char border per col
    const perCol = Math.max(12, Math.floor((termWidth - padding) / Math.max(1, keys.length)));
    const colWidths = keys.map(() => perCol);
    const table = muTable({
      head: keys.map((k) => pc.bold(k)),
      colWidths,
      style: { head: [] },
    });
    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      table.push(keys.map((k) => formatCell(obj[k])));
    }
    console.log(table.toString());
    console.log(pc.dim(`(${rows.length} row${rows.length === 1 ? "" : "s"})`));
    return;
  }
  const result = single.run([]);
  if (opts.json) {
    emitJson({
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    });
    return;
  }
  console.log(pc.dim(`${result.changes} row${result.changes === 1 ? "" : "s"} affected`));
}

/**
 * The --confirm-rows run, shared by the single- and multi-statement
 * paths so the same statement always gets the same count. Runs `exec`
 * ONCE, with capture ON, inside the op-context scope's transaction; the
 * scope COMMITs only when the count of THAT execution equals `expected`;
 * otherwise this throws a UsageError and the scope ROLLs BACK. There is no measure-then-rerun: a nondeterministic or
 * state-dependent statement (`WHERE abs(random()) % 2 = 0`) could pick
 * different rows on a second run and commit a count nobody confirmed.
 *
 * The count is the total_changes() delta: every row the SQL changes,
 * INCLUDING rows removed by ON DELETE CASCADE (deleting a task also
 * deletes its edges and notes). That is the honest blast radius, and it
 * is the same number whether the statement runs alone or in a script.
 *
 * Capture bookkeeping is NOT counted. Each captured row change also runs
 * a capture trigger whose body is several statements (the op INSERT
 * plus the HLC clock UPDATEs), all of which total_changes() counts.
 * captureBookkeepingChanges() derives that overhead from the ops this
 * call's group wrote, and it is subtracted from the delta.
 */
function runConfirmed<T>(db: Db, expected: number, exec: () => T): { result: T; actual: number } {
  const groupId = currentOpContext(db).groupId;
  const before = totalChanges(db);
  const result = exec();
  const delta = totalChanges(db) - before;
  const actual = groupId === null ? delta : delta - captureBookkeepingChanges(db, groupId);
  if (actual !== expected) {
    throw new UsageError(
      `expected ${expected} rows, would have affected ${actual} (rolled back). Re-run with --confirm-rows ${actual} if intentional.`,
    );
  }
  return { result, actual };
}

function totalChanges(db: Db): number {
  return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

/**
 * Count top-level SQL statements in `sql`, ignoring semicolons inside
 * single-quoted strings, double-quoted identifiers, line comments
 * (`-- ...`), and block comments (`/* ... *\/`). Used by `mu sql`'s
 * multi-statement path to report 'ran N statements'.
 *
 * Hand-rolled rather than pulling in a SQL parser — mu's escape hatch
 * is for human-typed scripts, not arbitrary SQL. The state machine
 * covers the cases we care about; pathological inputs (nested
 * comments, dollar-quoted strings, etc.) may miscount but won't crash
 * the verb (the script already ran successfully by then).
 */
export function countTopLevelStatements(sql: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let sawNonWs = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      // SQL-style escaped single quote: '' inside a string
      if (c === "'" && next === "'") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && next === '"') {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === ";") {
      if (sawNonWs) {
        count++;
        sawNonWs = false;
      }
      continue;
    }
    if (c !== undefined && /\S/.test(c)) sawNonWs = true;
  }
  if (sawNonWs) count++; // trailing statement without `;`
  return count;
}

/** The same read, uncapped: `mu db query '<sql>' [-w <effective ws>] --all`. */
function retrieveCommand(query: string, opts: DbQueryOptions): string {
  const ws = opts.workstream ?? injectedWorkstream();
  return [
    "mu db query",
    shellQuote(query),
    ...(ws === undefined ? [] : ["-w", shellWord(ws)]),
    "--all",
  ].join(" ");
}

/**
 * `{items, count, more, retrieve?}`: the collection shape task lists ship, over
 * rows of any shape (row keys untouched). Cells are never cut: rows are taken
 * whole while the FINAL document (envelope included) fits RESULT_BYTES, so one
 * row bigger than that yields zero items, `more`, and the way back.
 */
export function sqlRowsPayload(
  rows: readonly unknown[],
  whole: boolean,
  retrieve: string,
): { items: unknown[]; count: number; more: number; retrieve?: string } {
  const build = (page: RecordPage<unknown>): ReturnType<typeof sqlRowsPayload> => ({
    items: page.shown,
    count: page.shown.length,
    more: page.more,
    ...(page.more > 0 ? { retrieve } : {}),
  });
  const page = whole
    ? { shown: [...rows], more: 0 }
    : pageRecords(rows, (p) => Buffer.byteLength(jsonDocument(build(p))) + 1, RESULT_BYTES, 0);
  return build(page);
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return pc.dim("null");
  if (typeof v === "string") return v;
  return String(v);
}

// ─── read-only shell ──────────────────────────────────────────────────

/**
 * `mu db --shell`: the sqlite3 CLI on this DB, READ-ONLY and `-safe`
 * (no `.shell`, `.system`, `.open`), with the same scoped TEMP views as a
 * query. It is its own connection, so it cannot inherit the views of the
 * in-process one: they are replayed as `-cmd`. Plain sqlite3 starts with
 * foreign_keys=0 and no capture context, which is why it never writes.
 */
export async function cmdDbShell(db: Db, opts: { workstream?: string } = {}): Promise<void> {
  const ws = opts.workstream ?? injectedWorkstream();
  const args = ["-readonly", "-safe"];
  if (ws !== undefined) args.push("-cmd", scopedViewsSql(resolveWorkstreamId(db, ws)));
  args.push(defaultDbPath());
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("sqlite3", args, { stdio: "inherit" });
    child.once("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new UsageError("sqlite3 is not on PATH: install the sqlite3 CLI (3.42 or newer)", {
              showHelp: false,
            })
          : err,
      ),
    );
    child.once("close", (c, signal) => resolve(c ?? (signal === null ? 1 : 128)));
  });
  if (code !== 0) throw new CliExitError(code);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireDbQueryCommand is called by buildProgram() in src/cli.ts, after
// wireDbCommands has made the `db` namespace. `mu sql` is the same action
// under its old name (live hints and scripts name it).

const QUERY_HELP =
  "Run SQL against the live mu DB, in-process: reads and writes (captured as one `sql.write` group). Runs inside mu's transaction (BEGIN/COMMIT refused); mu's capture bookkeeping (op_ctx, ops) and every schema change (CREATE/DROP/ALTER, TEMP too), ATTACH/DETACH and PRAGMAs other than read-only ones are refused. With -w, the views ready/blocked/blockers cover that workstream only (main.ready is the global one). `no such column` lists the real columns.";

function wireQuery(cmd: Command): void {
  cmd
    .argument("<query>")
    .description(QUERY_HELP)
    // SQL line comments start with `--`; quoted queries like
    // `mu db query "-- comment\nSELECT 1"` must bind that token as the
    // required <query> argument rather than as an unknown CLI option.
    .allowUnknownOption(true)
    .option(
      "-w, --workstream <name>",
      "scope ready/blocked/blockers to this workstream (a spawned worker defaults to its own)",
    )
    .option("--json", "JSON document (the default here; accepted for symmetry with other verbs)")
    .option("--table", "print a human table / prose instead of the JSON document")
    .option(
      "--all",
      "no cap: every row, whole (a read over 4 KB says `more` and names this command)",
    )
    .option(
      "--confirm-rows <n>",
      "abort if the affected-row count (ON DELETE CASCADE rows included) differs from N (rollback)",
      parseLines,
    )
    .action(function (query: string) {
      const cmd = this as Command;
      const opts = cmd.opts() as DbQueryOptions;
      // JSON unless --table; an explicit --json wins (isJsonMode reads argv the same way).
      opts.json = opts.json === true || opts.table !== true;
      // `mu db -w a query ...`: the namespace's own -w is the same flag, in
      // another position. Honour it; two different names are a usage error.
      const outer =
        cmd.parent?.name() === "db"
          ? (cmd.parent.opts() as { workstream?: string }).workstream
          : undefined;
      if (outer !== undefined) {
        if (opts.workstream !== undefined && opts.workstream !== outer) {
          throw new UsageError(
            `-w/--workstream given twice (${outer} before the verb, ${opts.workstream} after); pass it once`,
            { showHelp: false },
          );
        }
        opts.workstream = outer;
      }
      // Ambient sync like every other verb: peer ops are ingested BEFORE
      // the query (so a read sees fresh state and nothing lands mid-query)
      // and this call's writes are flushed after, even when it throws.
      return handle((db) => cmdDbQuery(db, query, opts), this as Command)();
    });
}

export function wireDbQueryCommand(program: Command): void {
  const dbCmd = program.commands.find((c) => c.name() === "db");
  if (dbCmd === undefined) throw new Error("wireDbQueryCommand: wire the db namespace first");
  wireQuery(dbCmd.command("query"));
  wireQuery(program.command("sql"));
  // `db -w` belongs to `--shell` and `query`; any other subcommand takes none,
  // and commander would otherwise bind it to the namespace and drop it.
  dbCmd.hook("preAction", (thisCmd, leaf) => {
    if (leaf === thisCmd || leaf.name() === "query") return;
    if (thisCmd.opts().workstream !== undefined) {
      throw new UsageError(`\`db ${leaf.name()}\` takes no -w/--workstream; drop it`, {
        showHelp: false,
      });
    }
  });
  dbCmd
    .option("--shell", "open the sqlite3 CLI on this DB, read-only")
    .option(
      "-w, --workstream <name>",
      "with --shell: scope ready/blocked/blockers to this workstream",
    )
    .action(function () {
      const opts = (this as Command).opts() as { shell?: boolean; workstream?: string };
      if (opts.shell !== true) {
        throw new UsageError(
          "mu db takes a subcommand (query, backup, compact, forget) or --shell",
        );
      }
      return handle((db) => cmdDbShell(db, opts), this as Command)();
    });
}
