// CLI-level tests for the `mu task add --blocked-by` flag.
//
// Surfaced by nit_blocks_flag_naming: the original `-b/--blocks <ids>`
// flag read as 'this task BLOCKS those' but actually meant 'this task
// is BLOCKED BY those' — a recurring footgun. We renamed the flag to
// `-b, --blocked-by <ids>` and removed the old name entirely
// (pre-public-release; no compat burden). Same rename applies to
// `mu task reparent --blocked-by`.
//
// We drive the program directly via buildProgram() + parseAsync() with
// stdout captured (same pattern as test/json-output.integration.test.ts) so we
// exercise the real Commander wiring without spawning subprocesses.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTaskEdges } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task add --blocked-by", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-blocked-by-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--blocked-by inserts incoming edges and renders the human hint", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    const { stdout } = await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "design",
      ],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build", "test");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
    expect(stdout).toContain("blocked by: design");
  });

  it("omits the blocked-by hint when no blockers were supplied", async () => {
    const { stdout } = await runCli(
      [
        "task",
        "add",
        "foo",
        "-w",
        "test",
        "--title",
        "Foo",
        "--impact",
        "1",
        "--effort-days",
        "0.1",
      ],
      dbPath,
    );

    expect(stdout).not.toContain("blocked by:");
  });

  it("-b is a short form for --blocked-by", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    await runCli(
      ["task", "add", "build", "-w", "test", "-t", "Build", "-i", "70", "-e", "3", "-b", "design"],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build", "test");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocked-by accepts comma-separated lists", async () => {
    for (const id of ["a", "b", "c"]) {
      await runCli(
        ["task", "add", id, "-w", "test", "-t", id.toUpperCase(), "-i", "50", "-e", "1"],
        dbPath,
      );
    }
    await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "a,b,c",
      ],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build", "test");
    db.close();
    expect(edges.blockers.sort()).toEqual(["a", "b", "c"]);
  });

  it("--blocked-by dedupes CSV duplicate blockers", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    const r = await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "design,design",
      ],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stderr).not.toMatch(/SQLITE_CONSTRAINT|UNIQUE constraint failed/i);
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build", "test");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocked-by accepts the repeated-flag form (variadic)", async () => {
    // Codified by cli_audit_plurality_uniformity (v0.3): every
    // multi-value flag accepts repeated invocations OR a CSV value
    // OR any mix; parseCsvFlag canonicalises.
    for (const id of ["a", "b", "c"]) {
      await runCli(
        ["task", "add", id, "-w", "test", "-t", id.toUpperCase(), "-i", "50", "-e", "1"],
        dbPath,
      );
    }
    await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "a",
        "--blocked-by",
        "b",
        "--blocked-by",
        "c",
      ],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build", "test");
    db.close();
    expect(edges.blockers.sort()).toEqual(["a", "b", "c"]);
  });

  it("--blocked-by dedupes repeated duplicate blockers", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    const r = await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "design",
        "--blocked-by",
        "design",
      ],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stderr).not.toMatch(/SQLITE_CONSTRAINT|UNIQUE constraint failed/i);
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build", "test");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocks makes the NEW task block an existing umbrella (outbound edge)", async () => {
    await runCli(["task", "add", "umb", "-w", "test", "-t", "Umbrella"], dbPath);
    const r = await runCli(
      ["task", "add", "build", "-w", "test", "-t", "Build", "--blocks", "umb"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain("blocks: umb");
    const db = openDb({ path: dbPath });
    const umb = getTaskEdges(db, "umb", "test");
    const build = getTaskEdges(db, "build", "test");
    db.close();
    expect(umb.blockers).toEqual(["build"]);
    expect(build.blockers).toEqual([]);
  });

  it("--blocks and --blocked-by combine; repeat and comma forms both work", async () => {
    for (const id of ["u1", "u2", "pre"]) {
      await runCli(["task", "add", id, "-w", "test", "-t", id], dbPath);
    }
    const r = await runCli(
      ["task", "add", "x", "-w", "test", "-t", "X", "--blocks", "u1,u2", "-b", "pre"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const db = openDb({ path: dbPath });
    const got = ["u1", "u2", "x"].map((id) => getTaskEdges(db, id, "test").blockers);
    db.close();
    expect(got).toEqual([["x"], ["x"], ["pre"]]);
  });

  it("--blocks that closes a cycle fails and creates NOTHING", async () => {
    const r = await runCli(
      ["task", "add", "a", "-w", "test", "-t", "A", "-b", "umb", "--blocks", "umb"],
      dbPath,
    );
    expect(r.exitCode).not.toBe(0);
    const db = openDb({ path: dbPath });
    const rows = db.prepare("SELECT 1 FROM tasks WHERE local_id = 'a'").all();
    db.close();
    expect(rows).toEqual([]);
  });

  it("batch: several ids, one -t each, one --note, all edges, atomically", async () => {
    await runCli(["task", "add", "umb", "-w", "test", "-t", "Umbrella"], dbPath);
    const r = await runCli(
      [
        "task",
        "add",
        "p",
        "q",
        "-w",
        "test",
        "-t",
        "P",
        "-t",
        "Q",
        "--blocks",
        "umb",
        "--note",
        "shared brief",
      ],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "umb", "test").blockers.sort();
    const kinds = db.prepare("SELECT kind, content FROM task_notes ORDER BY id").all();
    db.close();
    expect(edges).toEqual(["p", "q"]);
    expect(kinds).toEqual([
      { kind: "brief", content: "shared brief" },
      { kind: "brief", content: "shared brief" },
    ]);
  });

  it("batch with a duplicate id creates none of them", async () => {
    await runCli(["task", "add", "q", "-w", "test", "-t", "Q0"], dbPath);
    const r = await runCli(
      ["task", "add", "p", "q", "-w", "test", "-t", "P", "-t", "Q", "--note", "n"],
      dbPath,
    );
    expect(r.exitCode).not.toBe(0);
    const db = openDb({ path: dbPath });
    const ids = db.prepare("SELECT local_id FROM tasks").all();
    const notes = db.prepare("SELECT 1 FROM task_notes").all();
    db.close();
    expect(ids).toEqual([{ local_id: "q" }]);
    expect(notes).toEqual([]);
  });

  it("batch without ids derives one id per title, disambiguating inside the batch", async () => {
    const r = await runCli(
      ["task", "add", "-w", "test", "-t", "Same title", "-t", "Same title"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const db = openDb({ path: dbPath });
    const ids = db.prepare("SELECT local_id FROM tasks ORDER BY local_id").all();
    db.close();
    expect(ids).toEqual([{ local_id: "same_title" }, { local_id: "same_title_2" }]);
  });

  it("ids/titles count mismatch is a usage error that creates nothing", async () => {
    const r = await runCli(["task", "add", "p", "q", "-w", "test", "-t", "P"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/2 id\(s\).*need 2 -t\/--title, got 1/);
    const db = openDb({ path: dbPath });
    const n = db.prepare("SELECT COUNT(*) AS n FROM tasks").get();
    db.close();
    expect(n).toEqual({ n: 0 });
  });
});
