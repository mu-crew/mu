// `mu sql` and `mu log --kind` against the op capture layer, in-process.
//
// f_cli_sql_write_no_opctx: a `mu sql` write had no op context, so each
//   changed row became its own random op group with a null intent.
// f_cli_sql_confirm_rows: --confirm-rows counted cascades on the
//   multi-statement path but not the single one, and refused
//   `UPDATE ... RETURNING` as "not a write".
// f_cli_log_kind_synced: `mu log --kind task` wrote a prose op under a
//   projectable entity, which then broke `mu rebuild` and peer ingest.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDbQuery } from "../src/cli/db-query.js";
import { classifyError, UsageError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { renderOpLine } from "../src/log-render.js";
import { appendLog, LogKindReservedError, listLogs } from "../src/logs.js";
import { currentOpContext } from "../src/op-context.js";
import { rebuildInto } from "../src/rebuild.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { envelopeData } from "./_envelope.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-sql-capture-"));
  db = openDb({ path: join(dir, "mu.db") });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  ensureWorkstream(db, "w");
  for (const id of ["a", "b", "c"]) {
    addTask(db, { workstream: "w", localId: id, title: id, impact: 10, effortDays: 1 });
  }
  // c blocks b: deleting c cascades one edge row.
  addBlockEdge(db, "w", "b", "c");
});

afterEach(() => {
  logSpy.mockRestore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

interface OpRow {
  group_id: string;
  intent: string | null;
  entity: string;
  key: string;
}

const opsAfter = (seq: number): OpRow[] =>
  db
    .prepare("SELECT group_id, intent, entity, key FROM ops WHERE seq > ? ORDER BY seq")
    .all(seq) as OpRow[];

const maxSeq = (): number =>
  (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM ops").get() as { n: number }).n;

const lastJson = (): Record<string, unknown> => envelopeData(logSpy.mock.calls.at(-1)?.[0]);

describe("mu sql writes share one op context", () => {
  it("a multi-row UPDATE is one sql.write group", async () => {
    const seq = maxSeq();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 33");
    const rows = opsAfter(seq);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    expect(rows.every((r) => r.intent === "sql.write")).toBe(true);
  });

  it("a multi-statement script is one group too", async () => {
    const seq = maxSeq();
    await cmdDbQuery(
      db,
      "UPDATE tasks SET impact = 40 WHERE local_id = 'a'; UPDATE tasks SET impact = 41 WHERE local_id = 'b'",
    );
    const rows = opsAfter(seq);
    expect(rows.map((r) => r.key)).toEqual(["w/a", "w/b"]);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });

  it("two mu sql calls are two groups", async () => {
    const seq = maxSeq();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 50 WHERE local_id = 'a'");
    await cmdDbQuery(db, "UPDATE tasks SET impact = 51 WHERE local_id = 'a'");
    expect(new Set(opsAfter(seq).map((r) => r.group_id)).size).toBe(2);
  });

  it("mu log renders the write as prose, not raw JSON", async () => {
    const seq = maxSeq();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 33 WHERE local_id = 'a'");
    const [row] = listLogs(db, { since: seq });
    if (!row) throw new Error("expected one log row");
    const line = renderOpLine(row);
    expect(line).toBe("sql write a task impact=33");
    expect(line).not.toContain("{");
  });

  it("leaves no context behind for the next mutation", async () => {
    await cmdDbQuery(db, "UPDATE tasks SET impact = 60 WHERE local_id = 'a'");
    const seq = maxSeq();
    db.prepare("UPDATE tasks SET impact = 61 WHERE local_id = 'a'").run();
    expect(opsAfter(seq)[0]?.intent).toBeNull();
  });
});

const countTasks = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

describe("mu sql --confirm-rows", () => {
  it("counts the cascade identically for a single statement and a script", async () => {
    const single = "DELETE FROM tasks WHERE local_id = 'c'";
    // Task c plus its one cascaded edge: 2 on BOTH paths.
    await expect(cmdDbQuery(db, single, { confirmRows: 1 })).rejects.toThrow(
      /expected 1 rows, would have affected 2/,
    );
    await expect(cmdDbQuery(db, `${single}; SELECT 1`, { confirmRows: 1 })).rejects.toThrow(
      /expected 1 rows, would have affected 2/,
    );
    expect(countTasks()).toBe(3);

    await cmdDbQuery(db, single, { confirmRows: 2, json: true });
    expect(lastJson()).toMatchObject({ confirmRows: 2, actualRows: 2 });
    expect(countTasks()).toBe(2);
  });

  it("a committed confirm-rows write is captured under one group", async () => {
    const seq = maxSeq();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 70", { confirmRows: 3 });
    const rows = opsAfter(seq);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });

  it("a mismatch rolls back and writes no op", async () => {
    const seq = maxSeq();
    await expect(
      cmdDbQuery(db, "UPDATE tasks SET impact = 71", { confirmRows: 2 }),
    ).rejects.toThrow(UsageError);
    expect(opsAfter(seq)).toEqual([]);
  });

  it("accepts UPDATE ... RETURNING as a write", async () => {
    await cmdDbQuery(db, "UPDATE tasks SET impact = 72 WHERE local_id = 'a' RETURNING local_id", {
      confirmRows: 1,
      json: true,
    });
    expect(lastJson()).toMatchObject({ confirmRows: 1, actualRows: 1 });
    const row = db.prepare("SELECT impact FROM tasks WHERE local_id = 'a'").get() as {
      impact: number;
    };
    expect(row.impact).toBe(72);
  });

  it("counts a workstream delete's whole cascade, capture overhead excluded", async () => {
    db.exec(
      "INSERT INTO task_notes (task_id, author, content, created_at) SELECT id, 'u', 'n', 'z' FROM tasks",
    );
    // 1 workstream + 3 tasks + 3 notes + 1 edge.
    await expect(cmdDbQuery(db, "DELETE FROM workstreams", { confirmRows: 7 })).rejects.toThrow(
      /expected 7 rows, would have affected 8/,
    );
    expect(countTasks()).toBe(3);
    const seq = maxSeq();
    await cmdDbQuery(db, "DELETE FROM workstreams; SELECT 1", { confirmRows: 8 });
    expect(countTasks()).toBe(0);
    expect(opsAfter(seq)).toHaveLength(8);
  });

  // g_fix_ops_capture_confirm_rows_double_run: the count used to come
  // from a rolled-back probe and the SQL then ran AGAIN for the commit,
  // so a nondeterministic WHERE could commit a count nobody confirmed.
  it.each([
    ["single statement", ""],
    ["script", "; SELECT 1"],
  ])("commits exactly the confirmed count of ONE run (%s)", async (_label, suffix) => {
    for (let i = 4; i <= 20; i++) {
      addTask(db, { workstream: "w", localId: `t${i}`, title: "t", impact: 1, effortDays: 1 });
    }
    db.exec("UPDATE tasks SET impact = 1");
    const sum = (): number =>
      (db.prepare("SELECT SUM(impact) AS n FROM tasks").get() as { n: number }).n;
    const sql = `UPDATE tasks SET impact = impact + 1 WHERE abs(random()) % 2 = 0${suffix}`;
    let ok = 0;
    let refused = 0;
    // A double run commits an unconfirmed count in most attempts, so a few
    // of each outcome are enough; 200 is the cap, not the cost.
    for (let attempt = 0; attempt < 200 && (ok < 5 || refused < 5); attempt++) {
      const before = sum();
      const seq = maxSeq();
      try {
        await cmdDbQuery(db, sql, { confirmRows: 10 });
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect(sum()).toBe(before);
        expect(opsAfter(seq)).toEqual([]);
        refused++;
        continue;
      }
      expect(sum() - before).toBe(10);
      expect(opsAfter(seq)).toHaveLength(10);
      ok++;
    }
    // C(20,10)/2^20 is ~18%: both outcomes occur well within 200 tries.
    expect(ok).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("still refuses a read", async () => {
    await expect(cmdDbQuery(db, "SELECT * FROM tasks", { confirmRows: 1 })).rejects.toThrow(
      /only meaningful on write statements/,
    );
  });
});

describe("mu log --kind refuses projectable entities", () => {
  for (const kind of ["workstream", "task", "edge", "note"]) {
    it(`refuses --kind ${kind} (exit 2) and writes nothing`, () => {
      const seq = maxSeq();
      expect(() => appendLog(db, { workstream: "w", source: "user", kind, payload: "x" })).toThrow(
        LogKindReservedError,
      );
      expect(opsAfter(seq)).toEqual([]);
      expect(classifyError(new LogKindReservedError(kind)).exitCode).toBe(2);
    });
  }

  it("a custom kind and the default 'message' still rebuild", () => {
    appendLog(db, { workstream: "w", source: "user", kind: "pr-state", payload: "pr=1" });
    appendLog(db, { workstream: "w", source: "user", payload: "hello" });
    const report = rebuildInto(db, { targetPath: join(dir, "rebuilt.db") });
    expect(report.logOnlyByEntity).toMatchObject({ "pr-state": 1, message: 1 });
  });
});

// ─── transaction control is refused: the scope owns the transaction ───

describe("mu sql refuses user transaction control", () => {
  const TX = "mu db query runs inside mu's transaction; remove BEGIN/COMMIT";

  it.each([
    "BEGIN",
    "BEGIN IMMEDIATE",
    "COMMIT",
    "END",
    "END TRANSACTION",
    "ROLLBACK",
    "SAVEPOINT s1",
    "RELEASE s1",
    "begin",
    "  -- comment first\n  COMMIT",
    "/* c */ end",
  ])("%j is refused, single statement", async (sql) => {
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(UsageError);
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(TX);
    expect(db.inTransaction).toBe(false);
  });

  it.each([
    "UPDATE tasks SET impact = 1; COMMIT",
    "UPDATE tasks SET impact = 1;\nEND;",
    "BEGIN; UPDATE tasks SET impact = 1; COMMIT;",
    "UPDATE tasks SET impact = 1; SELECT 'x'; ROLLBACK",
    "UPDATE tasks SET impact = 1; SAVEPOINT s; RELEASE s",
  ])("%j is refused in a script and nothing runs", async (sql) => {
    const seq = maxSeq();
    const before = db.prepare("SELECT SUM(impact) AS n FROM tasks").get();
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(TX);
    expect(db.prepare("SELECT SUM(impact) AS n FROM tasks").get()).toEqual(before);
    expect(opsAfter(seq)).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it("a refused END does not leave the context committed", async () => {
    await expect(cmdDbQuery(db, "UPDATE tasks SET impact = 1; END")).rejects.toThrow(TX);
    expect(currentOpContext(db)).toEqual({
      groupId: null,
      actor: null,
      intent: null,
      applying: false,
    });
  });

  it("does not refuse words inside strings, identifiers, comments or CASE ... END", async () => {
    await cmdDbQuery(db, "SELECT 'BEGIN; COMMIT' AS \"end\" -- ROLLBACK\n");
    await cmdDbQuery(db, "SELECT CASE WHEN 1 THEN 'x' END");
    await cmdDbQuery(db, "UPDATE tasks SET title = 'commit; end' WHERE local_id = 'a'");
    expect(
      (db.prepare("SELECT title FROM tasks WHERE local_id = 'a'").get() as { title: string }).title,
    ).toBe("commit; end");
  });

  it("accepts a CREATE TEMP TRIGGER whose body ends with END", async () => {
    await cmdDbQuery(
      db,
      "CREATE TEMP TRIGGER t_x AFTER INSERT ON ops BEGIN SELECT CASE WHEN 1 THEN 1 END; END; SELECT 1",
    );
    await cmdDbQuery(db, "DROP TRIGGER t_x");
  });

  // rv6_sql_tx_scan: transaction control is recognised by SQLite's own
  // parser, never by words. Keyword-named identifiers neither bypass the
  // refusal nor cause a false one.
  const titles = (): string =>
    (db.prepare("SELECT title FROM tasks ORDER BY local_id").all() as { title: string }[])
      .map((r) => r.title)
      .join(",");
  const tableExists = (name: string): boolean =>
    db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name = ?").get(name) !== undefined;

  it.each([
    [
      "trigger table + begin column",
      "CREATE TEMP TABLE trigger(begin TEXT); UPDATE tasks SET title='bypass'; COMMIT",
    ],
    [
      "trigger + begin columns",
      "CREATE TEMP TABLE t1(trigger TEXT, begin TEXT); UPDATE tasks SET title='bypass'; COMMIT",
    ],
    [
      "trigger + begin, then END",
      "CREATE TEMP TABLE t2(trigger TEXT, begin TEXT); UPDATE tasks SET title='bypass'; END",
    ],
    [
      "savepoint table",
      "CREATE TEMP TABLE savepoint(begin TEXT); UPDATE tasks SET title='bypass'; RELEASE s",
    ],
    [
      "ROLLBACK then autocommit write",
      "CREATE TEMP TABLE t3(trigger TEXT, begin TEXT); ROLLBACK; UPDATE tasks SET title='bypass'",
    ],
    [
      "real trigger, then COMMIT",
      "CREATE TEMP TRIGGER tg AFTER INSERT ON ops BEGIN SELECT CASE WHEN 1 THEN 1 END; END; UPDATE tasks SET title='bypass'; COMMIT",
    ],
    [
      "BEGIN after a trigger-named column",
      "CREATE TEMP TABLE t4(trigger TEXT); BEGIN; UPDATE tasks SET title='bypass'; COMMIT",
    ],
  ])("refuses before running anything: %s", async (_name, sql) => {
    const seq = maxSeq();
    const before = titles();
    const tablesBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM temp.sqlite_master").get() as { n: number }
    ).n;
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(TX);
    await expect(cmdDbQuery(db, sql, { confirmRows: 99 })).rejects.toThrow(TX);
    expect(titles()).toBe(before);
    expect(opsAfter(seq)).toEqual([]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM temp.sqlite_master").get() as { n: number }).n,
    ).toBe(tablesBefore);
    expect(db.inTransaction).toBe(false);
  });

  it("the committed-bypass repro leaves the data untouched, for a second connection too", async () => {
    await expect(
      cmdDbQuery(
        db,
        "CREATE TEMP TABLE trigger(begin TEXT); UPDATE tasks SET title='committed-bypass'; COMMIT",
      ),
    ).rejects.toThrow(UsageError);
    const other = openDb({ path: join(dir, "mu.db") });
    try {
      expect(
        other.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'committed-bypass'").get(),
      ).toEqual({ n: 0 });
      expect(tableExists("trigger")).toBe(false);
    } finally {
      other.close();
    }
  });

  it("accepts tables and columns named after transaction keywords", async () => {
    for (const name of ["begin", "commit", "end", "trigger", "savepoint", "release", "rollback"]) {
      // quoted: `commit` is a reserved word that cannot be bare.
      await cmdDbQuery(db, `CREATE TEMP TABLE "${name}"("${name}" TEXT, x TEXT)`);
      await cmdDbQuery(db, `INSERT INTO "${name}"("${name}", x) VALUES ('v', 'w')`);
      await cmdDbQuery(db, `SELECT "${name}", x FROM "${name}"`);
    }
    await cmdDbQuery(
      db,
      `CREATE TEMP TABLE multi(begin, "commit", end, trigger, savepoint);
       INSERT INTO multi(begin, "commit", end, trigger, savepoint) VALUES (1,2,3,4,5);
       UPDATE multi SET end = begin + "commit"; SELECT trigger, savepoint FROM multi`,
    );
    expect(db.prepare("SELECT end FROM multi").get()).toEqual({ end: 3 });
    expect(db.inTransaction).toBe(false);
  });

  it("runs a script with a real trigger followed by more statements", async () => {
    await cmdDbQuery(
      db,
      "CREATE TEMP TABLE trigger(begin TEXT); CREATE TEMP TRIGGER tg AFTER INSERT ON trigger BEGIN UPDATE trigger SET begin = CASE WHEN 1 THEN 'x' END; END; INSERT INTO trigger(begin) VALUES ('a'); SELECT 1",
    );
    expect(db.prepare("SELECT begin FROM trigger").get()).toEqual({ begin: "x" });
  });

  it("refuses ROLLBACK TO, and a COMMIT after a statement naming a table the script creates", async () => {
    await expect(cmdDbQuery(db, "ROLLBACK TO s1")).rejects.toThrow(TX);
    await expect(
      cmdDbQuery(db, "CREATE TEMP TABLE later(x); INSERT INTO later VALUES (1); COMMIT"),
    ).rejects.toThrow(TX);
    expect(tableExists("later")).toBe(false);
  });

  it("a plain read does not take the write lock", async () => {
    const other = openDb({ path: join(dir, "mu.db") });
    other.pragma("busy_timeout = 0");
    try {
      other.exec("BEGIN IMMEDIATE");
      await expect(cmdDbQuery(db, "SELECT COUNT(*) AS n FROM tasks", { json: true })).resolves.toBe(
        undefined,
      );
      other.exec("ROLLBACK");
    } finally {
      other.close();
    }
  });
});

// ─── explicit non-positive ids, through the escape hatch ──────────────

describe("mu sql refuses explicit non-positive ids", () => {
  const insertTaskWithId = (id: number): string =>
    `INSERT INTO tasks (id, workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
     SELECT ${id}, id, 'zz${Math.abs(id)}', 't', 'OPEN', 'todo', 5, 1, 'x', 'x' FROM workstreams WHERE name = 'w'`;

  it.each([-1, 0])("INSERT INTO tasks(id) VALUES (%i) is refused and rolled back", async (id) => {
    const seq = maxSeq();
    await expect(cmdDbQuery(db, insertTaskWithId(id))).rejects.toThrow(
      /explicit non-positive ids are refused/,
    );
    expect(opsAfter(seq)).toEqual([]);
    expect(countTasks()).toBe(3);
  });

  it("an omitted-id insert still works after an explicit -1 attempt", async () => {
    await expect(cmdDbQuery(db, insertTaskWithId(-1))).rejects.toThrow(/non-positive/);
    await cmdDbQuery(
      db,
      `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
       SELECT id, 'ok', 't', 'OPEN', 'todo', 5, 1, 'x', 'x' FROM workstreams WHERE name = 'w'`,
    );
    expect(countTasks()).toBe(4);
  });
});
