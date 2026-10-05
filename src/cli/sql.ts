// mu — `mu sql` escape-hatch verb.
//
// Read OR write — `mu sql` is the explicit escape hatch. Single-statement
// path uses better-sqlite3's prepare() so we can distinguish read
// (.all() rows) from write (.run() change count). Multi-statement path
// uses db.exec() which handles BEGIN/COMMIT and multiple semicolon-
// separated statements but returns nothing structured.
//
// `--confirm-rows N` adds a transactional safety belt: if the actual
// affected-row count (FK cascades included) doesn't match N, the whole
// thing rolls back. Every write is captured as ops under one `sql.write`
// group, so `mu undo` reverts a whole `mu sql` call.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { emitJson, UsageError } from "../cli.js";
import type { Db } from "../db.js";
import { withCaptureSuppressed, withOpContext } from "../op-context.js";
import { muTable, pc } from "../output.js";

export async function cmdSql(
  db: Db,
  query: string,
  opts: { json?: boolean; confirmRows?: number } = {},
): Promise<void> {
  // ONE op context for the whole invocation. Without it every captured
  // row got its own random group and a null intent, so one multi-row
  // UPDATE showed up in `mu undo` as N separate "(no intent)" actions
  // and `mu log` fell back to printing the raw JSON payload. With it,
  // `mu undo` reverts the whole `mu sql` call as one action.
  withOpContext(db, { intent: "sql.write", group: "new" }, () => runSql(db, query, opts));
}

function runSql(db: Db, query: string, opts: { json?: boolean; confirmRows?: number }): void {
  // Read OR write — `mu sql` is the explicit escape hatch.
  //
  // Single-statement path uses better-sqlite3's prepare() so we can
  // distinguish read (.all() rows) from write (.run() change count).
  // Multi-statement path uses db.exec() which handles BEGIN/COMMIT and
  // multiple semicolon-separated statements but returns nothing
  // structured. We try prepare() first; if it throws the
  // 'more than one statement' SqliteError, we fall back to exec().
  // This keeps the simple case fast and well-typed while making
  // multi-statement migrations / cleanup scripts a one-shot.
  const trimmed = query.trim();
  // Capture the prepared statement so the single-statement path below
  // doesn't re-prepare (review_code_sql_double_prepare).
  let stmt: ReturnType<typeof db.prepare> | undefined;
  try {
    stmt = db.prepare(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/more than one statement/i.test(msg)) throw err;
  }

  if (stmt === undefined) {
    // Multi-statement. Note: scripts that contain their own BEGIN/COMMIT
    // fail under --confirm-rows (sqlite refuses nested transactions);
    // that's the price of an atomic confirm-or-rollback wrapper around
    // an opaque blob.
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      const actual = probeAffectedRows(db, trimmed, expected);
      runInTransaction(db, () => db.exec(trimmed));
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
    db.exec(trimmed);
    const n = countTopLevelStatements(trimmed);
    if (opts.json) {
      emitJson({ statements: n, multiStatement: true });
      return;
    }
    console.log(pc.dim(`ran ${n} statement${n === 1 ? "" : "s"}`));
    return;
  }

  const single = stmt;
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
    const actual = probeAffectedRows(db, trimmed, expected);
    const result = runInTransaction(db, () => single.run([]));
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
 * The --confirm-rows probe, shared by the single- and multi-statement
 * paths so the same statement always gets the same count. Runs `sql` in
 * a transaction, measures it, and ALWAYS rolls back; throws a UsageError
 * on a mismatch, otherwise returns the count for the caller to report
 * after it re-runs the SQL for real.
 *
 * The count is the total_changes() delta: every row the SQL changes,
 * INCLUDING rows removed by ON DELETE CASCADE (deleting a task also
 * deletes its edges and notes). It used to be cascades-included on the
 * multi path and `stmt.changes` (cascades excluded) on the single path,
 * so the same DELETE counted 1 alone and 2 with a `; SELECT 1` after it.
 * The cascade-inclusive number is the honest blast radius.
 *
 * Capture bookkeeping is NOT counted. A write to a portable table also
 * runs a capture trigger whose body is several statements (the op
 * INSERT plus the HLC clock UPDATEs), all of which total_changes()
 * counts, inflating the number ~5x. So the probe runs with capture
 * suppressed, and the `before` baseline is sampled INSIDE the
 * suppressed scope, after withCaptureSuppressed's own UPDATE on
 * _op_ctx. Suppressing is safe because the probe is always rolled back;
 * the caller re-runs with capture ON, so no uncaptured write commits.
 */
function probeAffectedRows(db: Db, sql: string, expected: number): number {
  db.exec("BEGIN IMMEDIATE");
  let actual: number;
  try {
    actual = withCaptureSuppressed(db, () => {
      const before = totalChanges(db);
      db.exec(sql);
      return totalChanges(db) - before;
    });
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {}
  }
  if (actual !== expected) {
    throw new UsageError(
      `expected ${expected} rows, would have affected ${actual} (rolled back). Re-run with --confirm-rows ${actual} if intentional.`,
    );
  }
  return actual;
}

function totalChanges(db: Db): number {
  return (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}

/** BEGIN, run `fn`, COMMIT; ROLLBACK and rethrow on failure. */
function runInTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn();
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw e;
  }
  db.exec("COMMIT");
  return result;
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
 * the verb (db.exec already ran successfully by then).
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
      // NO ambient sync on this path. `mu sql` is the escape hatch whose
      // no-surprise-mutations property is load-bearing: an operator
      // reading state with it must see the state as it is, not as it
      // becomes once a peer's segment lands between openDb and the query.
      // It is also the one verb whose result the operator diffs against
      // their own expectation, so an ambient ingest changing the row
      // count would read as a mu bug.
      return handle((db) => cmdSql(db, query, opts), this as Command, { ambientSync: false })();
    });
}
