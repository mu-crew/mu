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
import { classifyError, UsageError } from "../src/cli/handle.js";
import { cmdSql, topLevelKeywords } from "../src/cli/sql.js";
import { type Db, openDb } from "../src/db.js";
import { renderOpLine } from "../src/log-render.js";
import { appendLog, LogKindReservedError, listLogs } from "../src/logs.js";
import { currentOpContext } from "../src/op-context.js";
import { rebuildInto } from "../src/rebuild.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
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

const lastJson = (): Record<string, unknown> =>
  JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

describe("mu sql writes share one op context", () => {
  it("a multi-row UPDATE is one sql.write group", async () => {
    const seq = maxSeq();
    await cmdSql(db, "UPDATE tasks SET impact = 33");
    const rows = opsAfter(seq);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
    expect(rows.every((r) => r.intent === "sql.write")).toBe(true);
  });

  it("a multi-statement script is one group too", async () => {
    const seq = maxSeq();
    await cmdSql(
      db,
      "UPDATE tasks SET impact = 40 WHERE local_id = 'a'; UPDATE tasks SET impact = 41 WHERE local_id = 'b'",
    );
    const rows = opsAfter(seq);
    expect(rows.map((r) => r.key)).toEqual(["w/a", "w/b"]);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });

  it("two mu sql calls are two groups", async () => {
    const seq = maxSeq();
    await cmdSql(db, "UPDATE tasks SET impact = 50 WHERE local_id = 'a'");
    await cmdSql(db, "UPDATE tasks SET impact = 51 WHERE local_id = 'a'");
    expect(new Set(opsAfter(seq).map((r) => r.group_id)).size).toBe(2);
  });

  it("mu log renders the write as prose, not raw JSON", async () => {
    const seq = maxSeq();
    await cmdSql(db, "UPDATE tasks SET impact = 33 WHERE local_id = 'a'");
    const [row] = listLogs(db, { since: seq });
    if (!row) throw new Error("expected one log row");
    const line = renderOpLine(row);
    expect(line).toBe("sql write a task impact=33");
    expect(line).not.toContain("{");
  });

  it("leaves no context behind for the next mutation", async () => {
    await cmdSql(db, "UPDATE tasks SET impact = 60 WHERE local_id = 'a'");
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
    await expect(cmdSql(db, single, { confirmRows: 1 })).rejects.toThrow(
      /expected 1 rows, would have affected 2/,
    );
    await expect(cmdSql(db, `${single}; SELECT 1`, { confirmRows: 1 })).rejects.toThrow(
      /expected 1 rows, would have affected 2/,
    );
    expect(countTasks()).toBe(3);

    await cmdSql(db, single, { confirmRows: 2, json: true });
    expect(lastJson()).toMatchObject({ confirmRows: 2, actualRows: 2 });
    expect(countTasks()).toBe(2);
  });

  it("a committed confirm-rows write is captured under one group", async () => {
    const seq = maxSeq();
    await cmdSql(db, "UPDATE tasks SET impact = 70", { confirmRows: 3 });
    const rows = opsAfter(seq);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });

  it("a mismatch rolls back and writes no op", async () => {
    const seq = maxSeq();
    await expect(cmdSql(db, "UPDATE tasks SET impact = 71", { confirmRows: 2 })).rejects.toThrow(
      UsageError,
    );
    expect(opsAfter(seq)).toEqual([]);
  });

  it("accepts UPDATE ... RETURNING as a write", async () => {
    await cmdSql(db, "UPDATE tasks SET impact = 72 WHERE local_id = 'a' RETURNING local_id", {
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
    await expect(cmdSql(db, "DELETE FROM workstreams", { confirmRows: 7 })).rejects.toThrow(
      /expected 7 rows, would have affected 8/,
    );
    expect(countTasks()).toBe(3);
    const seq = maxSeq();
    await cmdSql(db, "DELETE FROM workstreams; SELECT 1", { confirmRows: 8 });
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
    for (let attempt = 0; attempt < 200; attempt++) {
      const before = sum();
      const seq = maxSeq();
      try {
        await cmdSql(db, sql, { confirmRows: 10 });
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
    // C(20,10)/2^20 is ~18%: both outcomes occur in 200 tries.
    expect(ok).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("still refuses a read", async () => {
    await expect(cmdSql(db, "SELECT * FROM tasks", { confirmRows: 1 })).rejects.toThrow(
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
  const TX = "mu sql runs inside mu's transaction; remove BEGIN/COMMIT";

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
    await expect(cmdSql(db, sql)).rejects.toThrow(UsageError);
    await expect(cmdSql(db, sql)).rejects.toThrow(TX);
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
    await expect(cmdSql(db, sql)).rejects.toThrow(TX);
    expect(db.prepare("SELECT SUM(impact) AS n FROM tasks").get()).toEqual(before);
    expect(opsAfter(seq)).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it("a refused END does not leave the context committed", async () => {
    await expect(cmdSql(db, "UPDATE tasks SET impact = 1; END")).rejects.toThrow(TX);
    expect(currentOpContext(db)).toEqual({
      groupId: null,
      actor: null,
      intent: null,
      applying: false,
    });
  });

  it("does not refuse words inside strings, identifiers, comments or CASE ... END", async () => {
    await cmdSql(db, "SELECT 'BEGIN; COMMIT' AS \"end\" -- ROLLBACK\n");
    await cmdSql(db, "SELECT CASE WHEN 1 THEN 'x' END");
    await cmdSql(db, "UPDATE tasks SET title = 'commit; end' WHERE local_id = 'a'");
    expect(
      (db.prepare("SELECT title FROM tasks WHERE local_id = 'a'").get() as { title: string }).title,
    ).toBe("commit; end");
  });

  it("accepts a CREATE TRIGGER whose body ends with END", async () => {
    await cmdSql(
      db,
      "CREATE TEMP TRIGGER t_x AFTER INSERT ON ops BEGIN SELECT CASE WHEN 1 THEN 1 END; END; SELECT 1",
    );
    await cmdSql(db, "DROP TRIGGER t_x");
  });

  it("topLevelKeywords lists the first keyword of each statement", () => {
    expect(topLevelKeywords("select 1; Update t set a=1 ;; delete from t")).toEqual([
      "SELECT",
      "UPDATE",
      "DELETE",
    ]);
    expect(
      topLevelKeywords("CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END; COMMIT"),
    ).toEqual(["CREATE", "COMMIT"]);
  });

  it("a plain read does not take the write lock", async () => {
    const other = openDb({ path: join(dir, "mu.db") });
    other.pragma("busy_timeout = 0");
    try {
      other.exec("BEGIN IMMEDIATE");
      await expect(cmdSql(db, "SELECT COUNT(*) AS n FROM tasks", { json: true })).resolves.toBe(
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
    await expect(cmdSql(db, insertTaskWithId(id))).rejects.toThrow(
      /explicit non-positive ids are refused/,
    );
    expect(opsAfter(seq)).toEqual([]);
    expect(countTasks()).toBe(3);
  });

  it("an omitted-id insert still works after an explicit -1 attempt", async () => {
    await expect(cmdSql(db, insertTaskWithId(-1))).rejects.toThrow(/non-positive/);
    await cmdSql(
      db,
      `INSERT INTO tasks (workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at)
       SELECT id, 'ok', 't', 'OPEN', 'todo', 5, 1, 'x', 'x' FROM workstreams WHERE name = 'w'`,
    );
    expect(countTasks()).toBe(4);
  });
});
