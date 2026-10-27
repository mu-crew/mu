// `task add --json` returns task items in the SQL-column shape every task read uses (`id`,
// `effort_days`, `workstream_id`, `scored: 0|1`), identical to `task show --json`'s task, never the
// SDK row's `name` / `effortDays` / `roi` (rr_r4_task_add_json_camel).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCliJson } from "./_runCli.js";

describe("mu task add --json", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-add-json-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    db.close();
  });
  afterEach(() => rmFixtureDir(dir));

  const add = (...more: string[]) =>
    runCliJson(["task", "add", "-w", "ws", "--json", ...more], dbPath);

  it("task is the same record `task show --json` prints (modulo its workstream label and revision)", async () => {
    const a = await add("alpha", "-t", "Alpha", "-i", "60", "-e", "2");
    expect(a.exitCode).toBeNull();
    const task = a.data.task as Record<string, unknown>;
    expect(task).toMatchObject({
      id: "alpha",
      local_id: "alpha",
      effort_days: 2,
      impact: 60,
      scored: 1,
    });
    for (const camel of ["name", "effortDays", "workstreamName", "ownerName", "createdAt", "roi"]) {
      expect(task).not.toHaveProperty(camel);
    }
    const s = await runCliJson(["task", "show", "alpha", "-w", "ws", "--json"], dbPath);
    const { workstream: _w, revision: _r, ...shown } = s.data.task as Record<string, unknown>;
    expect(task).toEqual(shown);
  });

  it("several ids: tasks[] is in the same shape", async () => {
    const a = await add("a1", "a2", "-t", "One", "-t", "Two");
    const tasks = a.data.tasks as { id: string; effort_days: number }[];
    expect(tasks.map((t) => t.id)).toEqual(["a1", "a2"]);
    expect(tasks.every((t) => typeof t.effort_days === "number")).toBe(true);
    expect(a.data.task).toEqual(tasks[0]);
  });
});
