// v_db_output: `mu sql` / `mu db query` print the JSON document by default, errors
// included (parse-time, scope and SQL errors), `--table` restores prose, and no
// other verb changes its default.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { isSqlVerbArgv } from "../src/output.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson, runCliWire } from "./_runCli.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-sql-json-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "wsa");
  addTask(db, { localId: "t1", workstream: "wsa", title: "one", impact: 10, effortDays: 1 });
  db.close();
});
afterEach(() => rmFixtureDir(dir));

const spellings: [string, string[]][] = [
  ["sql", ["sql"]],
  ["db query", ["db", "query"]],
];

describe.each(spellings)("mu %s defaults to JSON", (_n, verb) => {
  it("a read is a success document with no --json", async () => {
    const r = await runCliJson([...verb, "SELECT local_id FROM tasks"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toBe("");
    expect(r.data).toEqual({ items: [{ local_id: "t1" }], count: 1, more: 0 });
  });

  it("a write keeps its write result", async () => {
    const r = await runCliJson([...verb, "--write", "UPDATE tasks SET impact = 20"], dbPath);
    expect(r.data).toEqual({ changes: 1, lastInsertRowid: expect.any(Number) });
  });

  it.each([
    ["bad SQL", ["SELEC 1"], 1, "SqliteError"],
    ["bad column", ["SELECT nope FROM tasks"], 2, "SqlColumnError"],
    ["a forbidden write", ["--write", "UPDATE ops SET actor = 'x'"], 2, "UsageError"],
    ["a write without --write", ["UPDATE tasks SET impact = 1"], 2, "UsageError"],
    ["a missing query", [], 2, "CommanderError"],
    ["an unknown -w", ["SELECT 1", "-w", "nope"], 3, "WorkstreamNotFoundError"],
    ["a root -w naming nothing", ["SELECT 1", "-w", "nope"], 3, "WorkstreamNotFoundError"],
  ])("%s is the failure document on stdout", async (_name, rest, exit, error) => {
    const r = await runCliWire([...verb, ...rest], dbPath);
    expect(r.stderr).toBe("");
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ ok: false, error, exit });
    expect(r.exitCode).toBe(exit);
  });

  it("root -w before the verb and an unknown root -w are JSON too", async () => {
    const ok = await runCliJson(["-w", "wsa", ...verb, "SELECT local_id FROM ready"], dbPath);
    expect(ok.data.items).toEqual([{ local_id: "t1" }]);
    const bad = await runCliWire(["-w", "nope", ...verb, "SELECT 1"], dbPath);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, exit: 3 });
    expect(bad.stderr).toBe("");
  });

  it("an explicit --json is still accepted", async () => {
    const r = await runCliJson([...verb, "SELECT 1 AS one", "--json"], dbPath);
    expect(r.data.items).toEqual([{ one: 1 }]);
  });

  it("--table is the human output, errors on stderr", async () => {
    const ok = await runCliWire([...verb, "SELECT 1 AS one", "--table"], dbPath);
    expect(ok.stdout).toContain("(1 row)");
    const bad = await runCliWire([...verb, "SELEC 1", "--table"], dbPath);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toContain("syntax error");
  });

  it("--all prints every row whole", async () => {
    const q = "SELECT hex(zeroblob(1500)) AS h UNION ALL SELECT hex(zeroblob(1500))";
    const capped = await runCliJson([...verb, q], dbPath);
    expect(capped.data.count).toBeLessThan(2);
    expect(capped.data.retrieve).toContain("--all");
    const all = await runCliJson([...verb, q, "--all"], dbPath);
    expect(all.data).toMatchObject({ count: 2, more: 0 });
  });
});

describe("isSqlVerbArgv", () => {
  const argv = (...a: string[]): string[] => ["node", "mu", ...a];
  it("finds the two verbs through root and namespace -w", () => {
    expect(isSqlVerbArgv(argv("sql", "SELECT 1"))).toBe(true);
    expect(isSqlVerbArgv(argv("db", "query", "SELECT 1"))).toBe(true);
    expect(isSqlVerbArgv(argv("-w", "x", "sql", "SELECT 1"))).toBe(true);
    expect(isSqlVerbArgv(argv("db", "-w", "x", "query", "SELECT 1"))).toBe(true);
    expect(isSqlVerbArgv(argv("--json", "sql", "SELECT 1"))).toBe(true);
  });
  it("is not fooled by other verbs or a workstream named sql", () => {
    expect(isSqlVerbArgv(argv("task", "list", "-w", "sql"))).toBe(false);
    expect(isSqlVerbArgv(argv("-w", "sql", "task", "list"))).toBe(false);
    expect(isSqlVerbArgv(argv("db", "backup", "query"))).toBe(false);
    expect(isSqlVerbArgv(argv("doctor"))).toBe(false);
    expect(isSqlVerbArgv(argv("task", "note", "t1", "sql"))).toBe(false);
  });
  it("other verbs keep their prose default", async () => {
    const r = await runCliWire(["task", "list", "-w", "wsa"], dbPath);
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});
