// mu — `mu sql` escape-hatch verb.
//
// Read OR write — `mu sql` is the explicit escape hatch. Single-statement
// path uses better-sqlite3's prepare() so we can distinguish read
// (.all() rows) from write (.run() change count). Multi-statement path
// uses db.exec() which handles multiple semicolon-separated statements
// but returns nothing structured.
//
// Every write runs inside ONE op-context scope, which owns the
// transaction (src/op-context.ts): one `sql.write` group, atomic, and
// the context is never committed. So the SQL may not control the
// transaction itself: BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT /
// RELEASE are refused up front (END is COMMIT's alias; running any of
// them would end the transaction the context lives in).
//
// `--confirm-rows N` adds a safety belt on top: if the actual
// affected-row count (FK cascades included) doesn't match N, the scope
// throws and its ROLLBACK undoes the whole thing.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { captureBookkeepingChanges } from "../capture.js";
import { emitJson, UsageError } from "../cli.js";
import type { Db } from "../db.js";
import { currentOpContext, withOpContext } from "../op-context.js";
import { muTable, pc } from "../output.js";

export async function cmdSql(
  db: Db,
  query: string,
  opts: { json?: boolean; confirmRows?: number } = {},
): Promise<void> {
  refuseTransactionControl(query);
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
  withOpContext(db, { intent: "sql.write", group: "new" }, () => runSql(db, trimmed, stmt, opts));
}

const USER_TRANSACTION_MESSAGE = "mu sql runs inside mu's transaction; remove BEGIN/COMMIT";

/** Refuse any top-level statement that is transaction control. */
function refuseTransactionControl(sql: string): void {
  for (const keyword of topLevelKeywords(sql)) {
    if (TRANSACTION_KEYWORDS.has(keyword)) throw new UsageError(USER_TRANSACTION_MESSAGE);
  }
}

const TRANSACTION_KEYWORDS: ReadonlySet<string> = new Set([
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/**
 * The first keyword (upper-cased) of every top-level statement in `sql`.
 * Skips strings, quoted identifiers and comments. A `CREATE [TEMP]
 * TRIGGER` statement runs to the `END` that closes its body, so the
 * `;` and `END` inside a trigger (or a `CASE … END`) are not statements
 * of their own and cannot cause a false refusal.
 */
export function topLevelKeywords(sql: string): string[] {
  const keywords: string[] = [];
  let words: string[] = []; // words of the current statement, upper-case
  let caseDepth = 0;
  let inTriggerBody = false;
  const endStatement = (): void => {
    words = [];
    caseDepth = 0;
    inTriggerBody = false;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
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
      if (words.length === 0) words.push("?"); // a statement that starts with a literal
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j] as string)) j++;
      const word = sql.slice(i, j).toUpperCase();
      i = j;
      if (words.length === 0) keywords.push(word);
      words.push(word);
      if (words[0] === "CREATE" && words.includes("TRIGGER")) {
        if (word === "BEGIN") inTriggerBody = true;
        else if (inTriggerBody && word === "CASE") caseDepth++;
        else if (inTriggerBody && word === "END") {
          if (caseDepth > 0) caseDepth--;
          else inTriggerBody = false;
        }
      }
      continue;
    }
    if (c === ";") {
      if (!inTriggerBody) endStatement();
      i++;
      continue;
    }
    i++;
  }
  return keywords;
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
  // Multi-statement path uses db.exec() which handles BEGIN/COMMIT and
  // multiple semicolon-separated statements but returns nothing
  // structured. We try prepare() first; if it throws the
  // 'more than one statement' SqliteError, we fall back to exec().
  // This keeps the simple case fast and well-typed while making
  // multi-statement migrations / cleanup scripts a one-shot.
  // `cmdSql` prepared the statement once (review_code_sql_double_prepare);
  // undefined means "more than one statement".
  if (stmt === undefined) {
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      const { actual } = runConfirmed(db, expected, () => db.exec(trimmed));
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
