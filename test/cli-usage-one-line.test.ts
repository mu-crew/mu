// A usage error whose message names the fix is ONE line (exit 2, or 4 for a collision): no
// verb --help dump after it (rr_r4_usage_help_dump_fix_named; surface-contract: one line with a fix).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("fix-naming usage errors are one line", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-one-line-"));
    dbPath = join(dir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    addTask(db, { localId: "b1", workstream: "ws", title: "b", impact: 10, effortDays: 1 });
    db.close();
  });
  afterEach(() => rmFixtureDir(dir));

  const oneLine = (stderr: string): void => {
    expect(stderr.trim().split("\n"), stderr).toHaveLength(1);
  };

  it("db backup onto an existing file: exit 4 like rebuild's collision, one line", async () => {
    const target = join(dir, "b.sqlite");
    expect((await runCli(["db", "backup", target], dbPath)).exitCode).toBeNull();
    const r = await runCli(["db", "backup", target], dbPath);
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toMatch(/already exists: mu db backup never overwrites/);
    oneLine(r.stderr);
  });

  it("db forget of a live workstream: one line", async () => {
    const r = await runCli(["db", "forget", "ws"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/cannot forget: ws \(is live\)/);
    oneLine(r.stderr);
  });

  it.each([
    ["task note with no text", ["task", "note", "b1", "-w", "ws"], /note text required/],
    ["task update with nothing", ["task", "update", "b1", "-w", "ws"], /nothing to update/],
    ["a title with no slug", ["task", "add", "-t", "???", "-w", "ws"], /empty slug/],
    ["an invalid workstream name", ["workstream", "init", "Bad.Name"], /invalid workstream name/],
  ])("%s", async (_n, argv, re) => {
    const r = await runCli(argv, dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(re);
    oneLine(r.stderr);
  });

  it("the invalid-name line is short and names the shape; the tmux rationale is in the docs", async () => {
    const r = await runCli(["workstream", "init", "Bad.Name"], dbPath);
    expect(r.stderr).toContain('invalid workstream name "Bad.Name": use [a-z][a-z0-9_-]{0,31}');
    expect(r.stderr.length).toBeLessThan(160);
  });

  it("an unknown root option is one line naming --help, not the whole root help", async () => {
    const r = await runCli(["--foo"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unknown option '--foo'.*mu --help/);
    oneLine(r.stderr);
  });

  it("a usage error that names no fix still prints the verb's help", async () => {
    const r = await runCli(["task", "show", "--bogus"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.trim().split("\n").length).toBeGreaterThan(3);
  });
});
