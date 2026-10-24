// `mu task add` -i/-e are optional (defaults 50 / 1, scored 0); giving
// either scores the task. `task next` orders scored by ROI, then unscored
// oldest first. `task update -i/-e` scores a task.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

describe("mu task add/update/next with optional scoring", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-scored-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "t");
    db.close();
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  const row = (id: string) => {
    const db = openDb({ path: dbPath });
    try {
      return db.prepare("SELECT impact, effort_days, scored FROM tasks WHERE local_id = ?").get(id);
    } finally {
      db.close();
    }
  };
  const add = (id: string, ...flags: string[]) =>
    runCli(["task", "add", id, "-w", "t", "-t", id, ...flags], dbPath);

  it("add with neither flag succeeds, unscored, defaults 50 / 1", async () => {
    const r = await add("plain");
    expect(r.exitCode).toBeNull();
    expect(row("plain")).toEqual({ impact: 50, effort_days: 1, scored: 0 });
  });

  it("add with -i only or -e only scores the task", async () => {
    await add("i_only", "-i", "80");
    await add("e_only", "-e", "4");
    expect(row("i_only")).toEqual({ impact: 80, effort_days: 1, scored: 1 });
    expect(row("e_only")).toEqual({ impact: 50, effort_days: 4, scored: 1 });
  });

  it("update --impact scores an unscored task even at the same value", async () => {
    await add("u");
    await runCli(["task", "update", "u", "-w", "t", "--impact", "50"], dbPath);
    expect(row("u")).toEqual({ impact: 50, effort_days: 1, scored: 1 });
  });

  it("next -n 0 lists scored by ROI, then unscored oldest first (also with --sort roi)", async () => {
    await add("old_unscored");
    await add("lo", "-i", "10", "-e", "2");
    await add("hi", "-i", "90", "-e", "1");
    await add("new_unscored");
    const db = openDb({ path: dbPath });
    db.prepare(
      "UPDATE tasks SET created_at = '2026-01-01T00:00:00.000Z' WHERE local_id = 'old_unscored'",
    ).run();
    db.prepare(
      "UPDATE tasks SET created_at = '2026-09-01T00:00:00.000Z' WHERE local_id = 'new_unscored'",
    ).run();
    db.close();
    for (const extra of [[], ["--sort", "roi"]]) {
      const r = await runCliJson(
        ["task", "next", "-n", "0", "-w", "t", "--json", ...extra],
        dbPath,
      );
      const names = (r.data as { items: { name: string }[] }).items.map((t) => t.name);
      expect(names).toEqual(["hi", "lo", "old_unscored", "new_unscored"]);
    }
  });
});
