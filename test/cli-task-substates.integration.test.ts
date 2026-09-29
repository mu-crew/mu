// CLI tests for task substates (ts_5): close --as/--why, park/unpark,
// claim --force, --substate filter, and "STATUS/substate" pair rendering.
//
// Drives the wired CLI via runCli (real SQLite + buildProgram) so the
// assertions cover the JSON shape and the text an operator reads.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { addTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task substates CLI", () => {
  let tempDir: string;
  let dbPath: string;

  // a -> b (b blocked by a); c -> d (d blocked by c); e is standalone.
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-substates-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    const add = (localId: string, blockedBy?: string[]) =>
      addTask(db, {
        localId,
        workstream: "test",
        title: localId.toUpperCase(),
        impact: 50,
        effortDays: 1,
        ...(blockedBy ? { blockedBy } : {}),
      });
    add("a");
    add("b", ["a"]);
    add("c");
    add("d", ["c"]);
    add("e");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const cli = (...args: string[]) => runCli(["task", ...args, "-w", "test"], dbPath);
  const names = (stdout: string) =>
    (JSON.parse(stdout) as { items: { name: string }[] }).items.map((t) => t.name);

  it("close --as wontfix without --why exits 4 naming --why", async () => {
    const r = await cli("close", "a", "--as", "wontfix");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("--why");
  });

  it("close --as rejects an unknown substate", async () => {
    const r = await cli("close", "a", "--as", "parked", "--why", "x");
    expect(r.exitCode).toBe(4);
  });

  it("close --as wontfix --why reports status, substate and unblocked", async () => {
    const r = await cli("close", "a", "--as", "wontfix", "--why", "dup of x", "--json");
    expect(r.exitCode).toBeNull();
    const p = JSON.parse(r.stdout) as { status: string; substate: string; unblocked: string[] };
    expect(p.status).toBe("CLOSED");
    expect(p.substate).toBe("wontfix");
    expect(p.unblocked).toEqual(["b"]);
  });

  it("close --as prints Unblocked in text mode", async () => {
    const r = await cli("close", "a", "--as", "superseded", "--why", "by z");
    expect(r.exitCode).toBeNull();
    expect(plain(r.stdout)).toContain("CLOSED/superseded");
    expect(plain(r.stdout)).toMatch(/Unblocked: b/);
    expect(r.stdout).toContain("mu task next -w test");
  });

  it("park hides a task from next and --substate parked lists it", async () => {
    const park = await cli("park", "c", "--why", "later");
    expect(park.exitCode).toBeNull();
    const list = await cli("list", "--substate", "parked", "--json");
    expect(names(list.stdout)).toEqual(["c"]);
    const next = await cli("next", "-n", "0", "--json");
    expect(names(next.stdout)).not.toContain("c");
    expect(names(next.stdout)).toContain("a");
  });

  it("--substate accepts comma lists and rejects unknown values (usage error)", async () => {
    await cli("park", "c", "--why", "later");
    const list = await cli("list", "--substate", "parked,todo", "--json");
    expect(names(list.stdout)).toEqual(["a", "b", "c", "d", "e"]);
    const bad = await cli("list", "--substate", "bogus");
    expect(bad.exitCode).toBe(2); // UsageError, same as --status bogus
    expect(bad.stderr).toContain("--substate");
  });

  it("park on an IN_PROGRESS task exits 4 and suggests release", async () => {
    expect((await cli("claim", "a", "--self")).exitCode).toBeNull();
    const r = await cli("park", "a", "--why", "x");
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("mu task release");
  });

  it("unpark returns the task to next", async () => {
    await cli("park", "c", "--why", "later");
    const r = await cli("unpark", "c", "--json");
    expect(r.exitCode).toBeNull();
    const next = await cli("next", "-n", "0", "--json");
    expect(names(next.stdout)).toContain("c");
  });

  it("claim refuses a parked task unless --force", async () => {
    await cli("park", "c", "--why", "later");
    const refused = await cli("claim", "c", "--self");
    expect(refused.exitCode).toBe(4);
    expect(refused.stderr).toContain("unpark");
    const forced = await cli("claim", "c", "--self", "--force");
    expect(forced.exitCode).toBeNull();
    const db = openDb({ path: dbPath });
    expect(getTask(db, "c", "test")?.status).toBe("IN_PROGRESS");
    db.close();
  });

  it("show renders a parked blocker as OPEN/parked", async () => {
    await cli("park", "c", "--why", "later");
    const r = await cli("show", "d");
    expect(r.exitCode).toBeNull();
    expect(plain(r.stdout)).toContain("OPEN/parked");
  });

  it("show header renders the task's own pair", async () => {
    await cli("park", "c", "--why", "later");
    const r = await cli("show", "c");
    expect(r.exitCode).toBeNull();
    expect(plain(r.stdout)).toMatch(/status +: OPEN\/parked/);
  });

  it("list renders CLOSED/wontfix and bare OPEN", async () => {
    await cli("close", "a", "--as", "wontfix", "--why", "nope");
    const r = await cli("list");
    const out = plain(r.stdout);
    expect(out).toContain("CLOSED/wontfix");
    expect(out).toMatch(/│ b +│ OPEN +│/);
    expect(out).not.toContain("OPEN/todo");
  });

  it("mu state marks a track whose only open task is parked", async () => {
    await cli("park", "e", "--why", "later");
    const r = await runCli(["state", "-w", "test"], dbPath);
    expect(r.exitCode).toBeNull();
    const lines = plain(r.stdout).split("\n");
    const trackLine = lines.find((l) => /Track \d+: e\b/.test(l));
    expect(trackLine).toBeDefined();
    expect(trackLine).toContain("(parked)");
    const other = lines.find((l) => /Track \d+: b\b/.test(l));
    expect(other).not.toContain("(parked)");
  });
});
