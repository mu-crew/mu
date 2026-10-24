// mu — `mu sql` escape-hatch verb.
//
// Read OR write — `mu sql` is the explicit escape hatch. Single-statement
// path uses better-sqlite3's prepare() so we can distinguish read
// (.all() rows) from write (.run() change count). Multi-statement path
// runs the statements one at a time (runScript) and returns nothing
// structured.
//
// Every write runs inside ONE op-context scope, which owns the
// transaction (src/op-context.ts): one `sql.write` group, atomic, and
// the context is never committed. So the SQL may not control the
// transaction itself: BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT /
// RELEASE are refused up front (END is COMMIT's alias; running any of
// them would end the transaction the context lives in). SQLite itself
// recognises them (see refuseTransactionControl), statement by statement;
// the text is never scanned for keywords.
//
// `--confirm-rows N` adds a safety belt on top: if the actual
// affected-row count (FK cascades included) doesn't match N, the scope
// throws and its ROLLBACK undoes the whole thing.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import {
  captureBookkeepingChanges,
  GUARD_ALREADY_OWNED,
  GUARD_NEEDS_EVIDENCE,
  GUARD_OPEN_BLOCKERS,
} from "../capture.js";
import { emitJson, UsageError } from "../cli.js";
import type { Db } from "../db.js";
import { currentOpContext, withOpContext } from "../op-context.js";
import { muTable, pc } from "../output.js";
import {
  CloseNeedsEvidenceError,
  TaskAlreadyOwnedError,
  TaskHasOpenBlockersError,
} from "../tasks.js";

export async function cmdSql(
  db: Db,
  query: string,
  opts: { json?: boolean; confirmRows?: number } = {},
): Promise<void> {
  // ONE op context for the whole invocation. Without it every captured
  // row got its own random group and a null intent, so one multi-row
  // UPDATE showed up in `mu log` as N separate "(no intent)" actions
  // and printed the raw JSON payload. With it, the whole `mu sql` call
  // is one action, in one transaction.
  //
  // A plain read skips the scope: it would take the write lock (and
  // wait behind every writer) to stamp nothing.
  const trimmed = query.trim();
  let stmt: ReturnType<typeof db.prepare> | undefined;
  try {
    stmt = db.prepare(trimmed);
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

/** The typed conflict for a guard's RAISE, matched by its exact message
 *  (as `mapCloseGuard` in src/tasks/lifecycle.ts does); anything else unchanged. */
function guardError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : "";
  if (msg === GUARD_NEEDS_EVIDENCE) return new CloseNeedsEvidenceError();
  if (msg === GUARD_OPEN_BLOCKERS) return new TaskHasOpenBlockersError();
  if (msg === GUARD_ALREADY_OWNED) return new TaskAlreadyOwnedError();
  return err;
}

const USER_TRANSACTION_MESSAGE = "mu sql runs inside mu's transaction; remove BEGIN/COMMIT";

/**
 * Throw if `statement` (one compiled statement) is BEGIN / COMMIT / END /
 * ROLLBACK [TO] / SAVEPOINT / RELEASE. SQLite answers, not a keyword
 * scan: it compiles exactly these to an `AutoCommit` or `Savepoint`
 * opcode, so a table or column named `begin` or `commit` can neither
 * hide one nor be mistaken for one.
 */
function refuseTransactionControl(db: Db, statement: string): void {
  let ops: { opcode: string }[];
  try {
    ops = db.prepare(`EXPLAIN ${statement}`).all() as { opcode: string }[];
  } catch {
    return; // EXPLAIN EXPLAIN ...: never transaction control
  }
  if (ops.some((r) => r.opcode === "AutoCommit" || r.opcode === "Savepoint")) {
    throw new UsageError(USER_TRANSACTION_MESSAGE);
  }
}

/**
 * Run a multi-statement script one statement at a time, checking each
 * with `refuseTransactionControl` just before it runs. SQLite, not the
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
  const runOne = (text: string, stmt: ReturnType<typeof db.prepare>): void => {
    refuseTransactionControl(db, text);
    if (stmt.reader) stmt.all([]);
    else stmt.run([]);
  };
  for (const end of semicolonOffsets(sql)) {
    const text = sql.slice(start, end + 1);
    let stmt: ReturnType<typeof db.prepare>;
    try {
      stmt = db.prepare(text);
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
    runOne(rest, db.prepare(rest));
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

function runSql(
  db: Db,
  trimmed: string,
  stmt: ReturnType<typeof db.prepare> | undefined,
  opts: { json?: boolean; confirmRows?: number },
): void {
  // Read OR write — `mu sql` is the explicit escape hatch.
  //
  // Single-statement path uses better-sqlite3's prepare() so we can
  // distinguish read (.all() rows) from write (.run() change count).
  // Multi-statement path (runScript) runs semicolon-separated statements
  // one by one but returns nothing structured. We try prepare() first; if
  // it throws the 'more than one statement' SqliteError, we fall back.
  // This keeps the simple case fast and well-typed while making
  // multi-statement migrations / cleanup scripts a one-shot.
  // `cmdSql` prepared the statement once (review_code_sql_double_prepare);
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
  refuseTransactionControl(db, trimmed);
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
      emitJson(rows);
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

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return pc.dim("null");
  if (typeof v === "string") return v;
  return String(v);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireSqlCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { handle, JSON_OPT, parseLines } from "../cli.js";

export function wireSqlCommand(program: Command): void {
  program
    .command("sql <query>")
    .description("Run a SQL query against the live mu DB (SELECT / UPDATE / DELETE all allowed)")
    // SQL line comments start with `--`; quoted queries like
    // `mu sql "-- comment\nSELECT 1"` must bind that token as the
    // required <query> argument rather than as an unknown CLI option.
    .allowUnknownOption(true)
    .option(...JSON_OPT)
    .option(
      "--confirm-rows <n>",
      "abort if the affected-row count (ON DELETE CASCADE rows included) differs from N (rollback)",
      parseLines,
    )
    .action(function (query: string) {
      const opts = (this as Command).opts() as { json?: boolean; confirmRows?: number };
      // Ambient sync like every other verb: peer ops are ingested BEFORE
      // the query (so a read sees fresh state and nothing lands mid-query)
      // and this call's writes are flushed after, even when it throws.
      return handle((db) => cmdSql(db, query, opts), this as Command)();
    });
}
