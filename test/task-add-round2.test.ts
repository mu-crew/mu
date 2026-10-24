// v_task_mutations round 2: scalar repeatable -t keeps positional ids
// (f_task_mutations_title_eats_id), batch auto-ids pick the next FREE
// suffix against the DB and the batch (f_task_mutations_batch_slug_collision),
// and addTasks is part of the published entry (f_task_mutations_sdk_export).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, addTasks } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-add-r2-"));
  dbPath = join(dir, "mu.db");
  const db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  db.close();
});
afterEach(() => rmFixtureDir(dir));

function rows(): { local_id: string; title: string }[] {
  const db = openDb({ path: dbPath });
  try {
    return db.prepare("SELECT local_id, title FROM tasks ORDER BY local_id").all() as {
      local_id: string;
      title: string;
    }[];
  } finally {
    db.close();
  }
}

describe("task add: -t does not swallow positional ids", () => {
  it("id after a title creates ONE task with that id and title", async () => {
    const r = await runCli(
      ["task", "add", "-t", "Title before id", "explicit_id", "-w", "w"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    expect(rows()).toEqual([{ local_id: "explicit_id", title: "Title before id" }]);
  });

  it("id before a title creates ONE task", async () => {
    const r = await runCli(["task", "add", "explicit_id", "-t", "T", "-w", "w"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(rows()).toEqual([{ local_id: "explicit_id", title: "T" }]);
  });

  it("repeated -t pairs with ids in order, titles first", async () => {
    const r = await runCli(["task", "add", "-t", "A", "-t", "B", "a", "b", "-w", "w"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(rows()).toEqual([
      { local_id: "a", title: "A" },
      { local_id: "b", title: "B" },
    ]);
  });

  it("an unquoted multi-word title is refused in one line and creates nothing", async () => {
    const r = await runCli(["task", "add", "-t", "Fix the", "bug", "other", "-w", "w"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/2 id\(s\) \(bug other\) need 2 -t\/--title, got 1/);
    expect(rows()).toEqual([]);
  });
});

describe("addTasks: auto ids pick the next free suffix", () => {
  const mk = (): Db => openDb({ path: dbPath });
  const ids = (): string[] => rows().map((r) => r.local_id);

  it("skips a suffix already in the DB", async () => {
    const db = mk();
    addTask(db, { workstream: "w", localId: "same_2", title: "existing" });
    db.close();
    const r = await runCli(["task", "add", "-t", "same", "-t", "same", "-w", "w"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(ids()).toEqual(["same", "same_2", "same_3"]);
  });

  it("never selects an occupied same_2_2", async () => {
    const db = mk();
    addTask(db, { workstream: "w", localId: "same", title: "x" });
    addTask(db, { workstream: "w", localId: "same_2_2", title: "y" });
    db.close();
    const r = await runCli(["task", "add", "-t", "same", "-t", "same", "-w", "w"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(ids()).toEqual(["same", "same_2", "same_2_2", "same_3"]);
  });

  it("SDK: omitted ids are derived inside the batch transaction", () => {
    const db = mk();
    try {
      addTask(db, { workstream: "w", localId: "t_2", title: "x" });
      const res = addTasks(db, [{ title: "T" }, { title: "T" }, { id: "t_4", title: "n" }], {
        workstream: "w",
      });
      expect(res.ids).toEqual(["t", "t_3", "t_4"]);
    } finally {
      db.close();
    }
  });
});

describe("published entry exports addTasks", () => {
  const entry = resolve(__dirname, "..", "dist", "index.js");
  it.skipIf(!existsSync(entry))("dist/index.js exposes addTasks and it works", () => {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import * as sdk from ${JSON.stringify(entry)};
         const db = sdk.openDb({ path: ${JSON.stringify(join(dir, "sdk.db"))} });
         sdk.ensureWorkstream(db, "w");
         const r = sdk.addTasks(db, [{ id: "a", title: "A" }], { workstream: "w" });
         console.log(typeof sdk.addTasks, JSON.stringify(r.ids));`,
      ],
      { encoding: "utf8", env: { ...process.env, MU_SYNC_DIR: "" } },
    );
    expect(out.trim()).toBe('function ["a"]');
  });
});
