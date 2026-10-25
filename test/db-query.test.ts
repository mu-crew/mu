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
import { checkStatement, cmdDbQuery, installScopedViews } from "../src/cli/db-query.js";
import { SqlColumnError, UsageError } from "../src/cli/handle.js";
import { type Db, openDb, WorkstreamNotFoundError } from "../src/db.js";
import { shellQuote } from "../src/shell-quote.js";
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
const lastPayload = (): { items: unknown[]; count: number; more: number; retrieve?: string } =>
  envelopeData(logSpy.mock.calls.at(-1)?.[0]);
const lastRows = (): unknown => lastPayload().items;
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
        /cannot change the schema|only read-only PRAGMAs/,
      );
    }
    expect(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")).toBe(trig);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scratch'").get()).toBeUndefined();
  });

  // triage_vdb_ctx_temp_trigger (P1): a TEMP trigger ON op_ctx fired in the
  // scope's own ctx reset (inside the transaction, never checked) and forged
  // ops / left applying=1 at rest. Now no TEMP object can be created at all.
  describe("no DDL of any kind, TEMP included (triage_vdb_ctx_temp_trigger)", () => {
    const actors = (): string =>
      (db.prepare("SELECT DISTINCT actor FROM ops ORDER BY 1").all() as { actor: string | null }[])
        .map((r) => r.actor)
        .join(",");

    it.each([
      "CREATE TEMP TRIGGER evil AFTER UPDATE ON op_ctx BEGIN UPDATE ops SET actor = 'forged'; END",
      "CREATE TEMP TRIGGER evil AFTER UPDATE ON op_ctx BEGIN UPDATE op_ctx SET applying = 1; END",
      "CREATE TEMP TRIGGER evil AFTER UPDATE ON op_ctx WHEN NEW.applying = 0 BEGIN UPDATE op_ctx SET actor = 'forged-ctx'; END",
      "CREATE TEMP TRIGGER evil BEFORE UPDATE OF impact ON tasks BEGIN UPDATE op_ctx SET applying = 1; END",
      "CREATE TEMP TRIGGER evil AFTER UPDATE ON tasks BEGIN SELECT 1; END",
      "CREATE TEMP TABLE scratch(x)",
      "CREATE TEMPORARY TABLE scratch(x)",
      "CREATE TEMP VIEW v AS SELECT 1",
      "CREATE TEMP TABLE op_ctx (id, applying)",
      "CREATE TEMP VIEW ops AS SELECT 1 AS seq",
      "CREATE VIEW v AS SELECT 1",
      "CREATE INDEX i ON tasks(title)",
      "CREATE TABLE z AS SELECT 1",
      "CREATE VIRTUAL TABLE v USING fts5(a)",
      "ALTER TABLE tasks RENAME TO t2",
      "DROP VIEW ready",
      "DROP INDEX idx_agents_status",
      "ANALYZE",
      "REINDEX",
      "SELECT 1; CREATE TEMP TABLE scratch(x)",
      "UPDATE tasks SET impact = 77; CREATE TEMP TRIGGER evil AFTER UPDATE ON op_ctx BEGIN UPDATE op_ctx SET applying = 1; END",
    ])("%j is refused and leaves nothing behind", async (sql) => {
      const opsBefore = ops();
      const actorsBefore = actors();
      const impacts = count("SELECT SUM(impact) AS n FROM tasks");
      const temp = count("SELECT COUNT(*) AS n FROM temp.sqlite_master");
      const main = count("SELECT COUNT(*) AS n FROM sqlite_master");
      await expect(cmdDbQuery(db, sql)).rejects.toThrow(
        /cannot change the schema|cannot write|ANALYZE|REINDEX/,
      );
      expect(ops()).toBe(opsBefore);
      expect(actors()).toBe(actorsBefore);
      expect(count("SELECT SUM(impact) AS n FROM tasks")).toBe(impacts);
      expect(count("SELECT COUNT(*) AS n FROM temp.sqlite_master")).toBe(temp);
      expect(count("SELECT COUNT(*) AS n FROM sqlite_master")).toBe(main);
      expect(ctx()).toEqual(CTX_AT_REST);
      expect(db.inTransaction).toBe(false);
    });

    it("an ordinary write afterwards still works and is captured (the refusal changed nothing)", async () => {
      await expect(
        cmdDbQuery(
          db,
          "CREATE TEMP TRIGGER evil AFTER UPDATE ON op_ctx BEGIN UPDATE ops SET actor = 'forged'; END",
        ),
      ).rejects.toThrow(/cannot change the schema/);
      const before = ops();
      await cmdDbQuery(db, "UPDATE tasks SET impact = 44 WHERE local_id = 'a'");
      expect(ops()).toBe(before + 2);
      expect(actors()).not.toContain("forged");
      expect(ctx()).toEqual(CTX_AT_REST);
    });
  });

  // triage_vdb_mutants (a): the trust test for a trigger program asks the MAIN
  // schema. A TEMP trigger cannot be made through the verb, but one made on
  // the handle (a caller that shares the connection) must not borrow a real
  // capture trigger's name. Needs a REAL main name, not an unused one.
  it("a TEMP trigger that reuses a real capture trigger's name is not trusted", async () => {
    const real = (
      db
        .prepare(
          "SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE '\\_cap\\_tasks%' ESCAPE '\\'",
        )
        .get() as { name: string }
    ).name;
    db.exec(
      `CREATE TEMP TRIGGER ${real} BEFORE UPDATE ON tasks BEGIN UPDATE op_ctx SET applying = 1; END`,
    );
    const opsBefore = ops();
    await expect(cmdDbQuery(db, "UPDATE tasks SET impact = 78")).rejects.toThrow(
      /cannot write op_ctx/,
    );
    expect(ops()).toBe(opsBefore);
    expect(ctx()).toEqual(CTX_AT_REST);
  });

  it("a write to a handle's TEMP table is not mistaken for bookkeeping that shares its root page number", async () => {
    // Root pages are per database: a temp table's page 2.. can equal main's op_ctx / ops page.
    const roots = (
      db
        .prepare(
          "SELECT rootpage FROM main.sqlite_master WHERE name IN ('op_ctx','op_dying','ops','schema_version')",
        )
        .all() as { rootpage: number }[]
    ).map((r) => r.rootpage);
    const top = Math.max(...roots);
    for (let i = 0; i < top; i++) db.exec(`CREATE TEMP TABLE scratch${i}(x)`);
    for (let i = 0; i < top; i++) await cmdDbQuery(db, `INSERT INTO scratch${i} VALUES (1)`);
    expect(count(`SELECT COUNT(*) AS n FROM scratch${top - 1}`)).toBe(1);
  });

  it("refuses an indirect write through a trigger that exists on the handle", async () => {
    db.exec(
      "CREATE TEMP TRIGGER evil BEFORE UPDATE OF impact ON tasks BEGIN UPDATE op_ctx SET applying = 1; END",
    );
    const opsBefore = ops();
    await expect(cmdDbQuery(db, "UPDATE tasks SET impact = 77")).rejects.toThrow(
      /cannot write op_ctx/,
    );
    expect(ops()).toBe(opsBefore);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE impact = 77")).toBe(0);
    expect(ctx()).toEqual(CTX_AT_REST);
  });

  it("still lets capture itself write the bookkeeping (a captured write, ops and ctx at rest)", async () => {
    const opsBefore = ops();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 33 WHERE local_id = 'a'");
    expect(ops()).toBe(opsBefore + 2); // a in w and in x
    expect(ctx()).toEqual(CTX_AT_REST);
  });

  // triage_vdb_machine_identity: every capture trigger reads the HLC from
  // machine_identity; a forged id or clock silently unpublishes later ops.
  it.each([
    ["clock skew", "UPDATE machine_identity SET last_wall = last_wall + 100000000000"],
    ["impersonate a peer", "UPDATE machine_identity SET machine_id = 'peer-machine'"],
    [
      "INSERT OR REPLACE",
      "INSERT OR REPLACE INTO machine_identity (id, machine_id, created_at) VALUES (1, 'x', 'now')",
    ],
    ["delete", "DELETE FROM machine_identity"],
  ])("machine_identity: %s", async (_name, sql) => {
    const before = db.prepare("SELECT * FROM machine_identity").all();
    const opsBefore = ops();
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(/cannot write machine_identity/);
    expect(db.prepare("SELECT * FROM machine_identity").all()).toEqual(before);
    expect(ops()).toBe(opsBefore);
    expect(db.inTransaction).toBe(false);
  });

  it("machine_identity: a captured write still advances the clock", async () => {
    const before = db.prepare("SELECT last_wall, last_counter FROM machine_identity").get();
    await cmdDbQuery(db, "UPDATE tasks SET impact = 34 WHERE local_id = 'a'");
    expect(db.prepare("SELECT last_wall, last_counter FROM machine_identity").get()).not.toEqual(
      before,
    );
  });

  // triage_vdb_seq_peers_id: counters, watermarks and ids are not the SQL
  // verb's to rewrite.
  it.each([
    [
      "sqlite_sequence UPDATE",
      "UPDATE sqlite_sequence SET seq = 9223372036854775807 WHERE name = 'ops'",
      "sqlite_sequence",
    ],
    ["sqlite_sequence DELETE", "DELETE FROM sqlite_sequence", "sqlite_sequence"],
    [
      "sqlite_sequence INSERT",
      "INSERT INTO sqlite_sequence (name, seq) VALUES ('x', 1)",
      "sqlite_sequence",
    ],
    ["sync_peers UPDATE", "UPDATE sync_peers SET last_applied_seq = 1000000", "sync_peers"],
    [
      "sync_peers INSERT",
      "INSERT INTO sync_peers (machine_id, last_applied_seq) VALUES ('p', 99)",
      "sync_peers",
    ],
    ["sync_peers DELETE", "DELETE FROM sync_peers", "sync_peers"],
  ])("%s", async (_name, sql, what) => {
    db.prepare("INSERT INTO sync_peers (machine_id, last_applied_seq) VALUES ('peer', 3)").run();
    const seq = db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all();
    const peers = db.prepare("SELECT * FROM sync_peers ORDER BY machine_id").all();
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(new RegExp(`cannot write ${what}`));
    expect(db.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all()).toEqual(seq);
    expect(db.prepare("SELECT * FROM sync_peers ORDER BY machine_id").all()).toEqual(peers);
  });

  it("sync_peers refusal names `mu sync --repair`", async () => {
    await expect(cmdDbQuery(db, "UPDATE sync_peers SET last_applied_seq = 9")).rejects.toThrow(
      /mu sync --repair/,
    );
  });

  it("a script cannot smuggle a counter write after a legal write (rolled back whole)", async () => {
    const titlesBefore = titles();
    await expect(
      cmdDbQuery(db, "UPDATE tasks SET title = 'x'; UPDATE sqlite_sequence SET seq = 1 << 62"),
    ).rejects.toThrow(/cannot write sqlite_sequence/);
    expect(titles()).toBe(titlesBefore);
  });

  it("AUTOINCREMENT inserts, deletes and updates keep working (they touch sqlite_sequence themselves)", async () => {
    await cmdDbQuery(
      db,
      "INSERT INTO task_notes (task_id, author, content, kind, created_at) SELECT id, 'me', 'hi', 'note', 'now' FROM tasks WHERE local_id = 'a' AND workstream_id = (SELECT id FROM workstreams WHERE name = 'w')",
    );
    await cmdDbQuery(db, "UPDATE task_notes SET content = 'edited'");
    await cmdDbQuery(db, "DELETE FROM task_notes");
    await cmdDbQuery(db, "INSERT INTO workstreams (name, created_at) VALUES ('fresh', 'now')");
    expect(count("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'fresh'")).toBe(1);
  });

  it.each([
    ["tasks.id", "UPDATE tasks SET id = -1 WHERE local_id = 'a'", "tasks"],
    ["tasks.id to a positive id", "UPDATE tasks SET id = id + 1000", "tasks"],
    ["tasks rowid", "UPDATE tasks SET rowid = -5", "tasks"],
    ["tasks id in a CTE write", "WITH x AS (SELECT 1) UPDATE tasks SET id = 7", "tasks"],
    ["workstreams.id", "UPDATE workstreams SET id = -1", "workstreams"],
    ["task_notes.id", "UPDATE task_notes SET id = 0", "task_notes"],
    ["task_edges rowid", "UPDATE task_edges SET rowid = -2", "task_edges"],
  ])("refuses UPDATE of %s", async (_name, sql, table) => {
    db.prepare(
      "INSERT INTO task_notes (task_id, author, content, kind, created_at) VALUES (1, 'me', 'hi', 'note', 'now')",
    ).run();
    const before = db.prepare("SELECT id, local_id FROM tasks ORDER BY id").all();
    const opsBefore = ops();
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(
      new RegExp(`cannot change the id of ${table}`),
    );
    expect(db.prepare("SELECT id, local_id FROM tasks ORDER BY id").all()).toEqual(before);
    expect(ops()).toBe(opsBefore);
  });

  it("still allows UPDATEs that leave the id alone", async () => {
    await cmdDbQuery(db, "UPDATE tasks SET title = 'renamed' WHERE local_id = 'a'");
    await cmdDbQuery(db, "UPDATE workstreams SET name = name");
    await cmdDbQuery(db, "UPDATE task_edges SET to_task_id = to_task_id");
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE title = 'renamed'")).toBe(2);
  });

  it("allows reading the bookkeeping", async () => {
    await cmdDbQuery(db, "SELECT * FROM op_ctx");
    await cmdDbQuery(db, "SELECT COUNT(*) AS n FROM ops", { json: true });
    expect(lastRows()).toEqual([{ n: ops() }]);
  });
});

describe("db query ATTACH / DETACH (triage_vdb_attach)", () => {
  let peerPath: string;
  const peer = <T>(fn: (p: Db) => T): T => {
    const p = openDb({ path: peerPath });
    try {
      return fn(p);
    } finally {
      p.close();
    }
  };
  let peerOps: number;
  beforeEach(() => {
    peerPath = join(dir, "peer.db");
    peer((p) => {
      ensureWorkstream(p, "pw");
      addTask(p, { workstream: "pw", localId: "p1", title: "peer", impact: 10, effortDays: 1 });
    });
    peerOps = peer((p) => (p.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n);
  });

  it.each([
    (f: string) => `ATTACH '${f}' AS peer; UPDATE peer.ops SET actor = 'forged-att'`,
    (f: string) =>
      `ATTACH '${f}' AS peer; UPDATE peer.op_ctx SET applying = 1; UPDATE peer.tasks SET title = 'uncaptured-attached'`,
    (f: string) => `ATTACH '${f}' AS peer; DROP TRIGGER peer._cap_tasks_upd`,
    (f: string) => `ATTACH '${f}' AS peer; UPDATE peer.schema_version SET capture_version = 0`,
    (f: string) => `ATTACH DATABASE '${f}' AS peer`,
    (f: string) => `ATTACH '${f}' AS main2; DETACH main2`,
    () => "DETACH DATABASE temp",
    () => "ATTACH ':memory:' AS scratch",
  ])("refuses %#", async (mk) => {
    const triggers = peer((p) =>
      count2(p, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'"),
    );
    await expect(cmdDbQuery(db, mk(peerPath))).rejects.toThrow(/cannot ATTACH or DETACH/);
    peer((p) => {
      expect(count2(p, "SELECT COUNT(*) AS n FROM ops")).toBe(peerOps);
      expect(count2(p, "SELECT COUNT(*) AS n FROM ops WHERE actor = 'forged-att'")).toBe(0);
      expect(count2(p, "SELECT COUNT(*) AS n FROM tasks WHERE title = 'uncaptured-attached'")).toBe(
        0,
      );
      expect(count2(p, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")).toBe(
        triggers,
      );
      expect(
        p.prepare("SELECT applying, capture_version FROM op_ctx, schema_version").get(),
      ).toEqual({
        applying: 0,
        capture_version: expect.any(Number),
      });
      expect(count2(p, "SELECT capture_version AS n FROM schema_version")).toBeGreaterThan(0);
    });
    expect((db.pragma("database_list") as { name: string }[]).map((d) => d.name)).not.toContain(
      "peer",
    );
  });

  it("ATTACH inside a script is refused with the earlier statements rolled back", async () => {
    await expect(
      cmdDbQuery(db, `UPDATE tasks SET impact = 91; ATTACH '${peerPath}' AS peer`),
    ).rejects.toThrow(/cannot ATTACH or DETACH/);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE impact = 91")).toBe(0);
  });
});

const count2 = (d: Db, sql: string): number => (d.prepare(sql).get() as { n: number }).n;

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

  it("keyword-named identifiers are still fine", async () => {
    await cmdDbQuery(
      db,
      `WITH "commit"(begin, "end", trigger) AS (VALUES (1, 2, 3))
       SELECT begin, "end", trigger, CASE WHEN 1 THEN 'x' END AS x FROM "commit"`,
      { json: true },
    );
    expect(lastRows()).toEqual([{ begin: 1, end: 2, trigger: 3, x: "x" }]);
  });

  // triage_vdb_mutants (b): the EXPLAIN is the authority; if SQLite cannot list
  // a statement, the call fails. Only a statement that IS an EXPLAIN is let through.
  it("checkStatement fails closed when EXPLAIN cannot list a statement", () => {
    expect(() => checkStatement(db, "NOT SQL AT ALL")).toThrow(/syntax error/);
    expect(() => checkStatement(db, "; NOT SQL AT ALL")).toThrow(/syntax error/);
    expect(() => checkStatement(db, "EXPLAIN SELECT 1")).not.toThrow();
    expect(() => checkStatement(db, "SELECT 1")).not.toThrow();
  });
});

describe("db query allows only read-only PRAGMAs (a prepare APPLIES a PRAGMA)", () => {
  const fk = (): unknown => db.pragma("foreign_keys", { simple: true });
  const busy = (): unknown => db.pragma("busy_timeout", { simple: true });
  const UNCHANGED = /only read-only PRAGMAs/;

  it.each([
    "PRAGMA foreign_keys = OFF",
    "PRAGMA foreign_keys = OFF; SELECT 1",
    "PRAGMA main.foreign_keys = 0",
    "EXPLAIN PRAGMA foreign_keys = OFF",
    "EXPLAIN QUERY PLAN PRAGMA foreign_keys = OFF",
    "; /* c */ -- x\n PRAGMA foreign_keys = OFF",
    "pragma FOREIGN_KEYS(0)",
    'PRAGMA "foreign_keys" = 0',
    "PRAGMA [main] . [foreign_keys] = 0",
    "SELECT 1; PRAGMA foreign_keys = OFF",
    "SELECT 1; PRAGMA busy_timeout = 0",
  ])("%j leaves foreign_keys on", async (sql) => {
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(UNCHANGED);
    expect(fk()).toBe(1);
    expect(busy()).toBe(5000);
  });

  it("a DELETE after the refused PRAGMA still cascades (no orphan task)", async () => {
    await expect(cmdDbQuery(db, "PRAGMA foreign_keys = OFF; SELECT 1")).rejects.toThrow();
    await cmdDbQuery(db, "DELETE FROM workstreams WHERE name = 'x'");
    expect(count("SELECT COUNT(*) AS n FROM tasks")).toBe(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it.each([
    "PRAGMA busy_timeout = 0",
    "PRAGMA busy_timeout(0)",
    "PRAGMA query_only = ON",
    "PRAGMA writable_schema = ON",
    "PRAGMA user_version = 7",
    "PRAGMA user_version(7)",
    "PRAGMA application_id = 7",
    "PRAGMA journal_mode = DELETE",
    "PRAGMA synchronous = OFF",
    "PRAGMA wal_checkpoint",
    "PRAGMA optimize",
    "PRAGMA ignore_check_constraints = ON",
    "PRAGMA recursive_triggers = ON",
    "PRAGMA trusted_schema = ON",
    "PRAGMA defer_foreign_keys = ON",
    "PRAGMA temp_store = FILE",
    "PRAGMA foreign_keys(0)",
    "PRAGMA table_info = 1",
  ])("%j is refused", async (sql) => {
    await expect(cmdDbQuery(db, sql)).rejects.toThrow(UNCHANGED);
    expect(busy()).toBe(5000);
    expect(db.pragma("writable_schema", { simple: true })).toBe(0);
    expect(db.pragma("query_only", { simple: true })).toBe(0);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    await cmdDbQuery(db, "UPDATE tasks SET impact = 5 WHERE local_id = 'a'"); // not read-only
  });

  it("the refusal is one line (no help dump)", async () => {
    const err = await cmdDbQuery(db, "PRAGMA foreign_keys = OFF").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(String((err as Error).message)).not.toContain("\n");
  });

  it("PRAGMA reads on the allowlist work", async () => {
    await cmdDbQuery(db, "PRAGMA table_info(tasks)", { json: true });
    expect((lastRows() as { name: string }[]).some((r) => r.name === "local_id")).toBe(true);
    await cmdDbQuery(db, "pragma main.table_info('tasks')", { json: true });
    expect((lastRows() as { name: string }[]).length).toBeGreaterThan(3);
    await cmdDbQuery(db, "PRAGMA foreign_keys", { json: true });
    expect(lastRows()).toEqual([{ foreign_keys: 1 }]);
    await cmdDbQuery(db, "PRAGMA user_version", { json: true });
    expect(lastRows()).toEqual([{ user_version: 0 }]);
    await cmdDbQuery(db, "PRAGMA foreign_key_list(task_edges)", { json: true });
    await cmdDbQuery(db, "PRAGMA index_list(tasks)", { json: true });
    await cmdDbQuery(db, "PRAGMA foreign_key_check", { json: true });
    await cmdDbQuery(db, "SELECT name FROM pragma_table_info('tasks') LIMIT 1", { json: true });
    await cmdDbQuery(db, "PRAGMA busy_timeout", { json: true });
    expect(lastRows()).toEqual([{ timeout: 5000 }]);
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

// v_db_output: a read is {items, count, more, retrieve?}, capped by final bytes.
describe("db query read payload is a capped collection", () => {
  const big = "x".repeat(300);
  const rowsSql =
    "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 400) SELECT n, 'pad' AS pad FROM c";

  it("small result: all rows, more 0, no retrieve; row keys untouched", async () => {
    await cmdDbQuery(db, "SELECT local_id AS id, 1 AS items FROM tasks ORDER BY id LIMIT 2", {
      json: true,
    });
    const p = lastPayload();
    expect(p.count).toBe(2);
    expect(p.more).toBe(0);
    expect(p.retrieve).toBeUndefined();
    expect(p.items[0]).toEqual({ id: "a", items: 1 });
  });

  it("caps by the FINAL envelope bytes and names the same query with --all", async () => {
    await cmdDbQuery(db, rowsSql, { json: true });
    const p = lastPayload();
    const line = logSpy.mock.calls.at(-1)?.[0] as string;
    expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(4096);
    expect(p.count).toBeGreaterThan(0);
    expect(p.count + p.more).toBe(400);
    expect(p.more).toBeGreaterThan(0);
    expect(p.retrieve).toBe(`mu db query ${shellQuote(rowsSql)} --all`);
    await cmdDbQuery(db, rowsSql, { json: true, all: true });
    const all = lastPayload();
    expect(all.count).toBe(400);
    expect(all.more).toBe(0);
    expect(all.retrieve).toBeUndefined();
  });

  it("retrieve keeps the effective -w and shell-quotes the query", async () => {
    const q =
      "SELECT 'it''s' || hex(zeroblob(3000)) AS s UNION ALL SELECT 'b' || hex(zeroblob(3000))";
    await cmdDbQuery(db, q, { json: true, workstream: "w" });
    const p = lastPayload();
    expect(p.more).toBeGreaterThan(0);
    expect(p.retrieve).toBe(`mu db query ${shellQuote(q)} -w w --all`);
  });

  it("one row over the cap: zero items, more 1, the retrieval, cells never cut", async () => {
    const q = `SELECT '${big.repeat(20)}' AS huge`;
    await cmdDbQuery(db, q, { json: true });
    const p = lastPayload();
    expect(p).toMatchObject({ items: [], count: 0, more: 1 });
    expect(p.retrieve).toContain("--all");
    await cmdDbQuery(db, q, { json: true, all: true });
    expect((lastPayload().items[0] as { huge: string }).huge).toBe(big.repeat(20));
  });

  it("empty result is an empty page", async () => {
    await cmdDbQuery(db, "SELECT 1 AS x WHERE 0", { json: true });
    expect(lastPayload()).toEqual({ items: [], count: 0, more: 0 });
  });

  it("UPDATE ... RETURNING prints every row whole and never advertises a retrieval", async () => {
    await cmdDbQuery(
      db,
      "UPDATE tasks SET title = title || ?1 RETURNING title".replace("?1", `'${big}'`),
      {
        json: true,
      },
    );
    const p = lastPayload();
    expect(p.count).toBe(4);
    expect(p.more).toBe(0);
    expect(p.retrieve).toBeUndefined();
  });
});
