// `mu db query` (alias `mu sql`): the SQL boundary, in-process.
//
// rv6_sql_ctx_tamper: SQL could switch capture off (UPDATE op_ctx SET
//   applying=1), forge provenance, rewrite ops, drop capture triggers.
// rv6p2_sql_leading_semicolon: `; BEGIN` skipped the transaction refusal.
// Also: a PRAGMA is applied by PREPARE, scoped views, did-you-mean columns.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDbQuery, installScopedViews } from "../src/cli/db-query.js";
import { SqlColumnError, UsageError } from "../src/cli/handle.js";
import { type Db, openDb, WorkstreamNotFoundError } from "../src/db.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { envelopeData } from "./_envelope.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-db-query-"));
  db = openDb({ path: join(dir, "mu.db") });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const ws of ["w", "x"]) {
    ensureWorkstream(db, ws);
    for (const id of ["a", "b"]) {
      addTask(db, { workstream: ws, localId: id, title: id, impact: 10, effortDays: 1 });
    }
  }
  addBlockEdge(db, "w", "b", "a"); // a blocks b
});

afterEach(() => {
  logSpy.mockRestore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const ops = (): number => count("SELECT COUNT(*) AS n FROM ops");
const titles = (): string =>
  (db.prepare("SELECT title FROM tasks ORDER BY id").all() as { title: string }[])
    .map((r) => r.title)
    .join(",");
const lastRows = (): unknown => envelopeData<unknown>(logSpy.mock.calls.at(-1)?.[0]);
const ctx = (): unknown => db.prepare("SELECT group_id, actor, intent, applying FROM op_ctx").get();
const CTX_AT_REST = { group_id: null, actor: null, intent: null, applying: 0 };

describe("db query refuses to write mu's capture bookkeeping", () => {
  it("the rv6_sql_ctx_tamper repro: UPDATE op_ctx SET applying=1 then an uncaptured write", async () => {
    const opsBefore = ops();
    const titlesBefore = titles();
    await expect(
      cmdDbQuery(db, "UPDATE op_ctx SET applying = 1; UPDATE tasks SET title = 'uncaptured'"),
    ).rejects.toThrow(/cannot write op_ctx/);
    expect(titles()).toBe(titlesBefore);
    expect(ops()).toBe(opsBefore);
    expect(ctx()).toEqual(CTX_AT_REST);
  });

  it.each([
    ["forged provenance", "UPDATE op_ctx SET actor = 'forged', intent = 'forged'", "op_ctx"],
    ["INSERT OR REPLACE", "INSERT OR REPLACE INTO op_ctx (id, applying) VALUES (1, 1)", "op_ctx"],
    ["rewrite the log", "UPDATE ops SET actor = 'x'", "ops"],
    ["delete the log", "DELETE FROM ops", "ops"],
    ["truncate the log", "DELETE FROM main.ops WHERE 1", "ops"],
    ["op_dying", "DELETE FROM op_dying", "op_dying"],
    ["schema_version", "UPDATE schema_version SET capture_version = 0", "schema_version"],
    ["quoted", 'UPDATE "op_ctx" SET applying = 1', "op_ctx"],
    ["schema qualified", "UPDATE main.op_ctx SET applying = 1", "op_ctx"],
    ["mixed case", "uPdAtE Op_Ctx SET applying = 1", "op_ctx"],
    [
      "a CTE feeding the write",
      "WITH n AS (SELECT 1 AS v) UPDATE op_ctx SET applying = (SELECT v FROM n)",
      "op_ctx",
    ],
  ])("%s", async (_name, sql, what) => {
    const before = db.prepare("SELECT * FROM ops ORDER BY seq").all();
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(new RegExp(`cannot write ${what}`));
    expect(db.prepare("SELECT * FROM ops ORDER BY seq").all()).toEqual(before);
    expect(ctx()).toEqual(CTX_AT_REST);
    expect(db.inTransaction).toBe(false);
  });

  it("refuses a DROP TRIGGER / CREATE TRIGGER / DROP TABLE on the main schema", async () => {
    const trig = count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'");
    for (const sql of [
      "DROP TRIGGER _cap_tasks_upd",
      "CREATE TRIGGER _cap_refuter AFTER UPDATE ON tasks BEGIN SELECT 1; END",
      "CREATE TRIGGER harmless AFTER UPDATE ON tasks BEGIN SELECT 1; END",
      "DROP TABLE ops",
      "DROP TABLE op_ctx",
      "ALTER TABLE tasks ADD COLUMN zz TEXT",
      "CREATE TABLE scratch(x)",
      "PRAGMA writable_schema = ON; UPDATE sqlite_master SET name = 'x'",
    ]) {
      await expect(cmdDbQuery(db, sql)).rejects.toThrow(
        /cannot write sqlite_master|keeps the connection|may not be modified/,
      );
    }
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")).toBe(trig);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scratch'").get()).toBeUndefined();
  });

  it("refuses an INDIRECT write: a TEMP trigger that updates op_ctx, then an ordinary UPDATE", async () => {
    // Allowed to exist (TEMP objects are the user's own) ...
    await cmdDbQuery(
      db,
      "CREATE TEMP TRIGGER evil BEFORE UPDATE OF impact ON tasks BEGIN UPDATE op_ctx SET applying = 1; END",
    );
    const opsBefore = ops();
    // ... but the statement that would fire it is refused: its program contains the trigger body.
    await expect(cmdDbQuery(db, "UPDATE tasks SET impact = 77")).rejects.toThrow(
      /cannot write op_ctx/,
    );
    expect(ops()).toBe(opsBefore);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE impact = 77")).toBe(0);
    expect(ctx()).toEqual(CTX_AT_REST);
  });

  it("a TEMP trigger reusing a capture trigger's name is not trusted", async () => {
    await cmdDbQuery(
      db,
      "CREATE TEMP TRIGGER _cap_sneaky AFTER UPDATE ON tasks BEGIN UPDATE op_ctx SET applying = 1; END",
    );
    await expect(cmdDbQuery(db, "UPDATE tasks SET impact = 78")).rejects.toThrow(
      /cannot write op_ctx/,
    );
  });

  it("refuses a TEMP table or view that would shadow a bookkeeping table", async () => {
    await expect(cmdDbQuery(db, "CREATE TEMP TABLE op_ctx (id, applying)")).rejects.toThrow(
      /shadow/,
    );
    await expect(cmdDbQuery(db, "CREATE TEMP VIEW ops AS SELECT 1 AS seq")).rejects.toThrow(
      /shadow/,
    );
    expect(
      db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name IN ('op_ctx','ops')").get(),
    ).toBeUndefined();
  });

  it("still lets capture itself write the bookkeeping (a captured write, ops and ctx at rest)", async () => {
    const opsBefore = ops();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 33 WHERE local_id = 'a'");
    expect(ops()).toBe(opsBefore + 2); // a in w and in x
    expect(ctx()).toEqual(CTX_AT_REST);
  });

  it("allows reading the bookkeeping, TEMP tables, and ordinary trigger DDL on TEMP", async () => {
    await cmdDbQuery(db, "SELECT * FROM op_ctx");
    await cmdDbQuery(db, "SELECT COUNT(*) AS n FROM ops", { json: true });
    expect(lastRows()).toEqual([{ n: ops() }]);
    await cmdDbQuery(
      db,
      "CREATE TEMP TABLE scratch(x); INSERT INTO scratch VALUES (1); DROP TABLE scratch",
    );
  });
});

describe("db query transaction control: SQLite decides, not the text (rv6p2_sql_leading_semicolon)", () => {
  const TX = /remove BEGIN\/COMMIT/;

  it.each([
    "; BEGIN",
    ";BEGIN DEFERRED",
    "; SAVEPOINT s",
    "; COMMIT",
    "; END",
    "; ROLLBACK",
    ";;; BEGIN IMMEDIATE",
    " ;\n-- note\n; BEGIN",
    "/* c */ ; /* d */ RELEASE s",
    "; ; ROLLBACK TO s",
  ])("%j is refused as a single statement", async (sql) => {
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(UsageError);
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(TX);
    expect(db.inTransaction).toBe(false);
  });

  it.each([
    "UPDATE tasks SET title = 'x'; ; BEGIN",
    "UPDATE tasks SET title = 'x';; COMMIT",
    "UPDATE tasks SET title = 'x'; /* gap */ ; END",
  ])("%j is refused in a script and nothing runs", async (sql) => {
    const before = titles();
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(TX);
    expect(titles()).toBe(before);
  });

  it("an EXPLAIN of transaction control is not transaction control", async () => {
    await cmdDbQuery(db, "EXPLAIN BEGIN");
    await cmdDbQuery(db, "; EXPLAIN COMMIT");
  });

  it("fails closed: a statement SQLite cannot list propagates its error", async () => {
    await expect(cmdDbQuery(db, "; NOT SQL AT ALL")).rejects.toThrow(/syntax error/);
  });

  it("keyword-named identifiers are still fine, and a trigger body with END runs (TEMP)", async () => {
    await cmdDbQuery(
      db,
      `CREATE TEMP TABLE "commit"(begin, "end", trigger);
       CREATE TEMP TRIGGER t1 AFTER INSERT ON "commit" BEGIN UPDATE "commit" SET begin = CASE WHEN 1 THEN 'x' END; END;
       INSERT INTO "commit"(begin, "end", trigger) VALUES (1, 2, 3);
       SELECT begin, "end", trigger FROM "commit"`,
    );
    expect(db.prepare('SELECT begin FROM "commit"').get()).toEqual({ begin: "x" });
  });
});

describe("db query cannot change the connection's settings (a prepare APPLIES a PRAGMA)", () => {
  const fk = (): unknown => db.pragma("foreign_keys", { simple: true });
  const busy = (): unknown => db.pragma("busy_timeout", { simple: true });

  it.each([
    "PRAGMA foreign_keys = OFF",
    "PRAGMA foreign_keys = OFF; SELECT 1",
    "PRAGMA main.foreign_keys = 0",
    "EXPLAIN PRAGMA foreign_keys = OFF",
  ])("%j leaves foreign_keys on", async (sql) => {
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(/connection settings fixed/);
    expect(fk()).toBe(1);
  });

  it("a PRAGMA foreign_keys inside the call's transaction is a no-op: still on, still cascading", async () => {
    await cmdDbQuery(db, "SELECT 1; PRAGMA foreign_keys = OFF");
    expect(fk()).toBe(1);
    await cmdDbQuery(db, "DELETE FROM workstreams WHERE name = 'x'");
    expect(count("SELECT COUNT(*) AS n FROM tasks")).toBe(2);
  });

  it("a DELETE after the refused PRAGMA still cascades (no orphan task)", async () => {
    await expect(cmdDbQuery(db, "PRAGMA foreign_keys = OFF; SELECT 1")).rejects.toThrow();
    await cmdDbQuery(db, "DELETE FROM workstreams WHERE name = 'x'");
    expect(count("SELECT COUNT(*) AS n FROM tasks")).toBe(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("busy_timeout and query_only cannot be changed either; writable_schema never takes (and sqlite_master writes are refused above)", async () => {
    for (const sql of [
      "PRAGMA busy_timeout = 0",

      "PRAGMA query_only = ON",
    ]) {
      await expect(cmdDbQuery(db, sql)).rejects.toThrow(/connection settings fixed/);
    }
    await cmdDbQuery(db, "PRAGMA writable_schema = ON").catch(() => {});
    expect(busy()).toBe(5000);
    expect(db.pragma("writable_schema", { simple: true })).toBe(0);
    expect(db.pragma("query_only", { simple: true })).toBe(0);
    await cmdDbQuery(db, "UPDATE tasks SET impact = 5 WHERE local_id = 'a'"); // not read-only
  });

  it("PRAGMA reads still work", async () => {
    await cmdDbQuery(db, "PRAGMA table_info(tasks)", { json: true });
    expect((lastRows() as { name: string }[]).some((r) => r.name === "local_id")).toBe(true);
    await cmdDbQuery(db, "PRAGMA foreign_keys", { json: true });
    expect(lastRows()).toEqual([{ foreign_keys: 1 }]);
  });
});

describe("scoped TEMP views", () => {
  const rows = async (sql: string, workstream?: string): Promise<unknown> => {
    await cmdDbQuery(db, sql, { json: true, ...(workstream === undefined ? {} : { workstream }) });
    return lastRows();
  };

  it("without -w the views are the global ones", async () => {
    expect(
      await rows("SELECT workstream_id AS w, local_id FROM ready ORDER BY w, local_id"),
    ).toHaveLength(3);
  });

  it("-w scopes ready, blocked and blockers to that workstream, with their own projections", async () => {
    expect(await rows("SELECT local_id FROM ready", "w")).toEqual([{ local_id: "a" }]);
    expect(await rows("SELECT local_id FROM blocked", "w")).toEqual([{ local_id: "b" }]);
    expect(await rows("SELECT local_id FROM ready", "x")).toEqual([
      { local_id: "a" },
      { local_id: "b" },
    ]);
    expect(await rows("SELECT * FROM blocked", "x")).toEqual([]);
    const blockers = (await rows("SELECT * FROM blockers", "w")) as Record<string, unknown>[];
    expect(blockers).toHaveLength(1);
    expect(Object.keys(blockers[0] as object)).toEqual([
      "task_id",
      "blocker_id",
      "blocker_local_id",
      "blocker_status",
    ]);
    expect(await rows("SELECT * FROM blockers", "x")).toEqual([]);
    // the global projection is the same columns, so a -w query is not a different schema
    expect(
      Object.keys(((await rows("SELECT * FROM ready", "w")) as object[])[0] as object),
    ).toEqual(Object.keys(db.prepare("SELECT * FROM main.ready").get() as object));
  });

  it("the resolved id is a literal in the view, and main.ready is still the global one", async () => {
    installScopedViews(db, "w");
    const sql = (
      db.prepare("SELECT sql FROM temp.sqlite_master WHERE name = 'ready'").get() as { sql: string }
    ).sql;
    expect(sql).toMatch(/workstream_id = \d+$/);
    expect(count("SELECT COUNT(*) AS n FROM main.ready")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM ready")).toBe(1);
  });

  it("torn-down filtering is inherited: the scoped views select FROM the global ones", async () => {
    installScopedViews(db, "w");
    for (const v of ["ready", "blocked", "blockers"]) {
      const sql = (
        db.prepare("SELECT sql FROM temp.sqlite_master WHERE name = ?").get(v) as { sql: string }
      ).sql;
      expect(sql).toContain(`main.${v}`);
    }
    db.prepare("UPDATE workstreams SET torn_down_at = '2026-01-01' WHERE name = 'w'").run();
    expect(count("SELECT COUNT(*) AS n FROM ready")).toBe(0);
  });

  it("an unknown workstream is a typed not-found (exit 3), not an empty result", async () => {
    await expect(cmdDbQuery(db, "SELECT 1", { workstream: "nope" })).rejects.toThrow(
      WorkstreamNotFoundError,
    );
  });

  it("views are per connection: nothing is left in the file", async () => {
    await cmdDbQuery(db, "SELECT 1", { workstream: "w" });
    const other = openDb({ path: join(dir, "mu.db") });
    try {
      expect((other.prepare("SELECT COUNT(*) AS n FROM ready").get() as { n: number }).n).toBe(3);
    } finally {
      other.close();
    }
  });

  it("a scoped write is still captured as one sql.write group", async () => {
    const before = ops();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 9 WHERE id IN (SELECT id FROM ready)", {
      workstream: "w",
    });
    expect(ops()).toBe(before + 1);
    expect(db.prepare("SELECT intent FROM ops ORDER BY seq DESC LIMIT 1").get()).toEqual({
      intent: "sql.write",
    });
  });
});

describe("no such column", () => {
  const fail = async (sql: string): Promise<SqlColumnError> => {
    try {
      await cmdDbQuery(db, sql);
    } catch (err) {
      expect(err).toBeInstanceOf(SqlColumnError);
      return err as SqlColumnError;
    }
    throw new Error("expected a SqlColumnError");
  };

  it("names the column wanted, a near one, and the table's real columns, on one line", async () => {
    const err = await fail("SELECT titel FROM tasks");
    expect(err.message).toBe(
      "no such column: titel (did you mean title?). columns: tasks(id, workstream_id, local_id, title, status, substate, impact, effort_days, scored, dispatch_host, kind, wave, owner_id, created_at, updated_at)",
    );
    expect(err.message).not.toContain("\n");
    expect(err.showHelp).toBe(false);
  });

  it("the guesses of a model: owner / workstream / agent_name", async () => {
    expect((await fail("SELECT owner FROM tasks")).message).toMatch(/did you mean owner_id/);
    expect((await fail("SELECT t.workstream FROM tasks t")).message).toMatch(
      /did you mean workstream_id/,
    );
    const a = await fail("SELECT agent_name FROM agents");
    expect(a.message).toMatch(/columns: agents\(id, workstream_id, name,/);
  });

  it("covers every table the query names, and a write too", async () => {
    const err = await fail(
      "UPDATE tasks SET nope = 1 WHERE workstream_id IN (SELECT id FROM workstreams)",
    );
    expect(err.message).toMatch(/tasks\(.*\); workstreams\(/);
  });

  it("is a usage error (exit 2) and the SQL is not retried or rewritten", async () => {
    const before = ops();
    await fail("UPDATE tasks SET titel = 'x'");
    expect(ops()).toBe(before);
    expect(titles()).toBe("a,b,a,b");
  });

  it("other SQL errors pass through unchanged", async () => {
    await expect(cmdDbQuery(db, "SELECT * FROM no_such_table")).rejects.toThrow(/no such table/);
    await expect(cmdDbQuery(db, "SELEKT 1")).rejects.not.toBeInstanceOf(SqlColumnError);
  });
});

describe("explicit non-positive ids", () => {
  it("is a typed one-line usage error, rolled back", async () => {
    const before = ops();
    let err: unknown;
    try {
      await cmdDbQuery(
        db,
        "INSERT INTO tasks (id, workstream_id, local_id, title, status, substate, impact, effort_days, created_at, updated_at) SELECT -1, id, 'z', 't', 'OPEN', 'todo', 5, 1, 'x', 'x' FROM workstreams WHERE name = 'w'",
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).message).toMatch(/explicit non-positive ids are refused/);
    expect((err as UsageError).showHelp).toBe(false);
    expect(ops()).toBe(before);
    expect(count("SELECT COUNT(*) AS n FROM tasks")).toBe(4);
  });
});
