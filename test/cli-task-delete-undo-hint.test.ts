// `mu task delete --yes` must print an undo command that actually
// restores the task. It used to promise a snapshot (gone since v9) and
// offer bare `mu undo --yes`, which only lists groups
// (f_tasks_delete_snapshot_undo_stale).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("task delete undo hint", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-task-delete-undo-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    addTask(db, { localId: "r", workstream: "ws", title: "R", impact: 10, effortDays: 1 });
    db.close();
  });

  afterEach(() => rmFixtureDir(dir));

  it("the printed undo command restores the deleted task", async () => {
    const del = await runCli(["task", "delete", "r", "-w", "ws", "--yes", "--json"], dbPath);
    expect(del.error).toBeUndefined();
    const payload = JSON.parse(del.stdout) as {
      group: string | null;
      nextSteps: { command: string }[];
    };
    expect(payload.group).not.toBeNull();
    const undo = payload.nextSteps.find((s) => s.command.startsWith("mu undo"))?.command;
    expect(undo).toBe(`mu undo ${payload.group?.slice(0, 8)} --yes`);

    const argv = (undo ?? "").split(" ").slice(1);
    const r = await runCli(argv, dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    const db = openDb({ path: dbPath });
    expect(getTask(db, "r", "ws")).toBeDefined();
    db.close();
  });

  it("help and dry-run text drop the snapshot promise and bare `mu undo --yes`", async () => {
    const dry = await runCli(["task", "delete", "r", "-w", "ws"], dbPath);
    expect(dry.stdout).not.toContain("snapshot");
    expect(dry.stdout).not.toMatch(/mu undo --yes/);

    const help = await runCli(["task", "delete", "--help"], dbPath);
    expect(help.stdout).not.toMatch(/snapshot/i);
    expect(help.stdout.replace(/\s+/g, " ")).toContain("mu undo <group> --yes");
  });
});
