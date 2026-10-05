// `mu sql` and `mu log --kind` against the op capture layer, in-process.
//
// f_cli_sql_write_no_opctx: a `mu sql` write had no op context, so each
//   changed row became its own random undo group with a null intent.
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
import { cmdSql } from "../src/cli/sql.js";
import { type Db, openDb } from "../src/db.js";
import { renderOpLine } from "../src/log-render.js";
import { appendLog, LogKindReservedError, listLogs } from "../src/logs.js";
import { rebuildInto } from "../src/rebuild.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { undoGroup } from "../src/undo.js";
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

  it("mu undo of a script that writes one field twice restores the pre-call value", async () => {
    // g_fix_ops_capture_undo_same_field: grouping the whole call must
    // make the whole call undoable, not stop at the intermediate value.
    const seq = maxSeq();
    await cmdSql(
      db,
      "UPDATE tasks SET impact = 20 WHERE local_id = 'a'; UPDATE tasks SET impact = 30 WHERE local_id = 'a'",
    );
    const [first] = opsAfter(seq);
    if (!first) throw new Error("expected a sql.write op");
    undoGroup(db, first.group_id);
    const row = db.prepare("SELECT impact FROM tasks WHERE local_id = 'a'").get() as {
      impact: number;
    };
    expect(row.impact).toBe(10);
  });

  it("leaves no context behind for the next mutation", async () => {
    await cmdSql(db, "UPDATE tasks SET impact = 60 WHERE local_id = 'a'");
    const seq = maxSeq();
    db.prepare("UPDATE tasks SET impact = 61 WHERE local_id = 'a'").run();
    expect(opsAfter(seq)[0]?.intent).toBeNull();
  });
});

describe("mu sql --confirm-rows", () => {
  const countTasks = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;

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
