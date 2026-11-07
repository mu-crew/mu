// `mu sql` reads by default; a statement that writes needs `--write`. SQLite's
// own verdict (`stmt.readonly`) decides, never the text, so every write shape
// below must be refused, change nothing, and name the verb or --write in one line.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdDbQuery } from "../src/cli/db-query.js";
import { UsageError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson } from "./_runCli.js";

let dir: string;
let path: string;
let db: Db;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-sql-optin-"));
  path = join(dir, "mu.db");
  db = openDb({ path });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  ensureWorkstream(db, "w");
  addTask(db, { workstream: "w", localId: "a", title: "orig", impact: 10, effortDays: 1 });
});

afterEach(() => {
  log.mockRestore();
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const snapshot = (): string =>
  JSON.stringify([
    db.prepare("SELECT * FROM tasks").all(),
    db.prepare("SELECT * FROM workstreams").all(),
    db.prepare("SELECT count(*) AS n FROM ops").get(),
  ]);

const WRITES: [label: string, sql: string, verb: string][] = [
  ["INSERT", "INSERT INTO workstreams (name, created_at) VALUES ('x', 'now')", "INSERT"],
  ["UPDATE", "UPDATE tasks SET title = 'changed'", "UPDATE"],
  ["DELETE", "DELETE FROM tasks", "DELETE"],
  ["REPLACE", "REPLACE INTO workstreams (name, created_at) VALUES ('fresh', 'now')", "REPLACE"],
  [
    "WITH ... INSERT",
    "WITH s AS (SELECT 'x' AS n) INSERT INTO workstreams (name, created_at) SELECT n, 'now' FROM s",
    "",
  ],
  ["WITH ... UPDATE", "WITH s AS (SELECT 1 AS n) UPDATE tasks SET impact = (SELECT n FROM s)", ""],
  [
    "WITH ... DELETE",
    "WITH s AS (SELECT 1 AS n) DELETE FROM tasks WHERE id IN (SELECT id FROM tasks)",
    "",
  ],
  ["UPDATE ... RETURNING", "UPDATE tasks SET title = 'changed' RETURNING title", "UPDATE"],
  ["DELETE ... RETURNING", "DELETE FROM tasks RETURNING id", "DELETE"],
  [
    "INSERT ... RETURNING",
    "INSERT INTO workstreams (name, created_at) VALUES ('x', 'n') RETURNING id",
    "INSERT",
  ],
  ["comment-led UPDATE", "-- harmless\n/* really */ UPDATE tasks SET title = 'changed'", "UPDATE"],
  ["lowercase", "update tasks set title = 'changed'", "UPDATE"],
  ["a write after a read (script)", "SELECT 1; UPDATE tasks SET title = 'changed'", "UPDATE"],
  ["a write behind a leading ;", "; UPDATE tasks SET title = 'changed'", "UPDATE"],
  ["write then read (script)", "UPDATE tasks SET title = 'changed'; SELECT 1", "UPDATE"],
];

describe("mu sql without --write", () => {
  it.each(WRITES)("refuses %s, one line, nothing changed", async (_label, sql, verb) => {
    const before = snapshot();
    const err = await cmdDbQuery(db, sql, { json: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    const msg = (err as UsageError).message;
    expect(msg).not.toContain("\n");
    expect(msg).toContain("--write");
    if (verb !== "") expect(msg).toContain(verb);
    expect((err as UsageError).showHelp).toBe(false);
    expect(snapshot()).toBe(before);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses with --confirm-rows too (the count never gets to run a write)", async () => {
    const before = snapshot();
    await expect(
      cmdDbQuery(db, "UPDATE tasks SET title = 'changed'", { confirmRows: 1 }),
    ).rejects.toThrow(/--write/);
    expect(snapshot()).toBe(before);
  });

  it("the connection is query_only while it runs, and back to its old value after", async () => {
    await cmdDbQuery(db, "SELECT 1", { json: true });
    expect(db.pragma("query_only", { simple: true })).toBe(0);
    await cmdDbQuery(db, "UPDATE tasks SET title = 'x'").catch(() => {});
    expect(db.pragma("query_only", { simple: true })).toBe(0);
  });

  it("still reads: SELECT, WITH ... SELECT, PRAGMA table_info, EXPLAIN, a script of reads", async () => {
    for (const sql of [
      "SELECT title FROM tasks",
      "WITH s AS (SELECT 1 AS n) SELECT n FROM s",
      "PRAGMA table_info(tasks)",
      "EXPLAIN UPDATE tasks SET title = 'x'",
      "SELECT 1; SELECT 2",
    ]) {
      await cmdDbQuery(db, sql, { json: true });
    }
    expect(db.prepare("SELECT title FROM tasks").get()).toEqual({ title: "orig" });
  });
});

describe("mu sql --write", () => {
  it.each(WRITES)("runs %s", async (_label, sql) => {
    await cmdDbQuery(db, sql, { json: true, write: true });
    expect(log).toHaveBeenCalled();
  });

  it("a read with --write is a read", async () => {
    await cmdDbQuery(db, "SELECT title FROM tasks", { json: true, write: true });
    expect(String(log.mock.calls[0]?.[0])).toContain("orig");
  });
});

describe("mu sql over the CLI", () => {
  it("a refused write exits 2 (UsageError) with one named line; --write exits 0 and captures", async () => {
    db.close();
    const refused = await runCliJson(["sql", "UPDATE tasks SET title = 'cli'"], path);
    expect(refused.exitCode).toBe(2);
    expect(refused.doc).toMatchObject({ ok: false, exit: 2 });
    expect(String((refused.doc as unknown as { message: string }).message)).toMatch(
      /UPDATE.*--write/,
    );
    const ok = await runCliJson(["sql", "--write", "UPDATE tasks SET title = 'cli'"], path);
    expect(ok.exitCode ?? 0).toBe(0);
    db = openDb({ path });
    expect(db.prepare("SELECT title FROM tasks").get()).toEqual({ title: "cli" });
    expect(
      db.prepare("SELECT intent FROM ops WHERE intent = 'sql.write' LIMIT 1").get(),
    ).toBeDefined();
  });

  it.each([
    [["sql"], "mu sql"],
    [["db", "query"], "mu db query"],
  ])("a refusal names the verb as typed (%j)", async (argv, verb) => {
    db.close();
    const message = async (sql: string): Promise<string> =>
      String(
        ((await runCliJson([...argv, sql], path)).doc as unknown as { message: string }).message,
      );
    expect(await message("UPDATE tasks SET title = 'cli'")).toMatch(
      new RegExp(`^${verb} reads by default`),
    );
    expect(await message("BEGIN")).toMatch(new RegExp(`^${verb} runs inside`));
    expect(await message("PRAGMA foreign_keys = OFF")).toMatch(new RegExp(`^${verb} allows only`));
    expect(await message("DROP TABLE tasks")).toMatch(
      new RegExp(`^${verb} cannot change the schema`),
    );
    expect(await message("DELETE FROM ops")).toMatch(new RegExp(`^${verb} cannot write ops`));
    db = openDb({ path });
  });

  it("a capped read's retrieve names the verb as typed", async () => {
    db.close();
    const big =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) SELECT i, 'xxxxxxxxxxxxxxxxxxxx' AS pad FROM n";
    const { data } = await runCliJson<{ retrieve?: string }>(["sql", big], path);
    expect(data.retrieve).toMatch(/^mu sql /);
    db = openDb({ path });
  });
});
