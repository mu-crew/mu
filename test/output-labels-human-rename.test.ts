// Task read labels (was: the cli-table3 `name` column header; now records).
//
// Convention (README Interface): `mu task list / next / owned-by` print one
// record per line, `task<TAB>id<TAB>STATE<TAB>key=value...<TAB>title`, and
// `--json` items use the SQL column names with `id` = the task's local_id.
// No table, no `name` header, no `localId`/`name` keys.
//
// Each assertion strips ANSI before matching so it does not depend on
// whether picocolors is in colour mode.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addBlockEdge, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

describe("task read labels: records, not a table", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-labels-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    // 'a' is ready (no edges). 'b' depends on 'a' (so 'b' is blocked). 'c' is standalone.
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 80, effortDays: 2 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
    addBlockEdge(db, "auth", "b", "a");
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const records = (stdout: string): string[][] =>
    stripAnsi(stdout)
      .trimEnd()
      .split("\n")
      .map((l) => l.split("\t"));

  it("`mu task list` prints one `task<TAB>id<TAB>STATE` record per task (no table header, no box)", async () => {
    const { stdout } = await runCli(["task", "list", "-w", "auth"], dbPath);
    const rows = records(stdout);
    expect(rows.map((r) => r.slice(0, 3))).toEqual([
      ["task", "a", "OPEN"],
      ["task", "b", "OPEN"],
      ["task", "c", "OPEN"],
    ]);
    expect(stripAnsi(stdout)).not.toMatch(/[│┌─]/);
    expect(stripAnsi(stdout)).not.toMatch(/(^|\s)name(\s|$)/m);
  });

  it("`mu task next -n 0` (merged-in `task ready`) prints records, best ROI first", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth", "-n", "0"], dbPath);
    // c = 50/1, a = 80/2: c first; b is blocked and absent.
    expect(records(stdout).map((r) => r[1])).toEqual(["c", "a"]);
    expect(records(stdout).every((r) => r[0] === "task")).toBe(true);
  });

  it("`mu task next` prints exactly one record", async () => {
    const { stdout } = await runCli(["task", "next", "-w", "auth"], dbPath);
    expect(records(stdout)).toHaveLength(1);
    expect(records(stdout)[0]?.[0]).toBe("task");
  });

  it("`mu task list --json` emits `id` (= local_id) and SQL column names, never name/localId/effortDays", async () => {
    const { data } = await runCliJson(["task", "list", "-w", "auth", "--json"], dbPath);
    const env = data as { items: Array<Record<string, unknown>>; count: number };
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.count).toBe(env.items.length);
    const first = env.items[0];
    if (!first) throw new Error("expected at least one task row");
    expect(first).toMatchObject({
      id: "a",
      local_id: "a",
      effort_days: 2,
      impact: 80,
      status: "OPEN",
    });
    for (const gone of ["name", "localId", "effortDays", "workstreamName", "ownerName", "roi"]) {
      expect(first).not.toHaveProperty(gone);
    }
    expect(typeof first.workstream_id).toBe("number");
  });
});
