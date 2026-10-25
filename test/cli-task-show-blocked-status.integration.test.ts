// Regression tests for `mu task show` listing blockers / dependents with their
// status (task_show_blocked_by_renders_closed): a reader must tell from `show`
// alone which blockers still gate the task and which are CLOSED (satisfied).
// mu-next form: after the task record, one `blocker|dependent<TAB>id<TAB>STATE`
// record per neighbour, still-gating first, CLOSED (satisfied) after; JSON
// blockers/dependents are {id, status, substate} items. CLOSED satisfies an edge
// and nothing else does; OPEN/IN_PROGRESS keep gating.
//
// Drives the CLI via buildProgram() + parseAsync() with stdout captured
// (same pattern as test/json-output.integration.test.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, closeTask, setTaskStatus } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli, runCliJson } from "./_runCli.js";

// Strip ANSI escape sequences so assertions can match plain text.
// (cli-table3 + picocolors emit \x1b[...m sequences we don't want
// to bake into test fixtures.)
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip is the point
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The edge records of a `show` (every line after the task record, minus footers). */
const edges = (plain: string): string[] =>
  plain
    .trimEnd()
    .split("\n")
    .filter((l) => /^(blocker|dependent)\t/.test(l));

describe("mu task show — blockers/dependents grouped by status", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-show-blockers-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsx");
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("all-open blockers: one blocker record each, STATE shown", async () => {
    addTask(db, { localId: "blocker_a", workstream: "wsx", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "blocker_b", workstream: "wsx", title: "B", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["blocker_a", "blocker_b"],
    });

    const { stdout, exitCode } = await runCli(["task", "show", "target", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(edges(plain)).toEqual(["blocker\tblocker_a\tOPEN", "blocker\tblocker_b\tOPEN"]);
  });

  it("all-closed blockers: listed as CLOSED (satisfied)", async () => {
    addTask(db, { localId: "done_a", workstream: "wsx", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done_b", workstream: "wsx", title: "B", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["done_a", "done_b"],
    });
    closeTask(db, "done_a", { workstream: "wsx", evidence: "test" });
    closeTask(db, "done_b", { workstream: "wsx", evidence: "test" });

    const { stdout, exitCode } = await runCli(["task", "show", "target", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    // Satisfied blockers are still listed, as CLOSED: the reader sees none gates.
    expect(edges(plain)).toEqual(["blocker\tdone_a\tCLOSED", "blocker\tdone_b\tCLOSED"]);
  });

  it("mixed blockers: still-gating (OPEN/IN_PROGRESS) first, CLOSED (satisfied) after", async () => {
    addTask(db, { localId: "open_x", workstream: "wsx", title: "X", impact: 50, effortDays: 1 });
    addTask(db, { localId: "inprog_y", workstream: "wsx", title: "Y", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done_w", workstream: "wsx", title: "W", impact: 50, effortDays: 1 });
    closeTask(db, "done_w", { workstream: "wsx", evidence: "test" });
    setTaskStatus(db, "inprog_y", "IN_PROGRESS", { workstream: "wsx" });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["open_x", "inprog_y", "done_w"],
    });

    const { stdout, exitCode } = await runCli(["task", "show", "target", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    // OPEN and IN_PROGRESS gate downstream work; only CLOSED is satisfied.
    expect(edges(plain)).toEqual([
      "blocker\tinprog_y\tIN_PROGRESS",
      "blocker\topen_x\tOPEN",
      "blocker\tdone_w\tCLOSED",
    ]);
  });

  it("empty edges: the task record alone, no edge lines", async () => {
    addTask(db, { localId: "lonely", workstream: "wsx", title: "L", impact: 50, effortDays: 1 });

    const { stdout, exitCode } = await runCli(["task", "show", "lonely", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(edges(plain)).toEqual([]);
    expect(plain.trimEnd().split("\n")).toHaveLength(1);
  });

  it("dependents side gets the same treatment: CLOSED dependents listed after the open ones", async () => {
    addTask(db, { localId: "root", workstream: "wsx", title: "R", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "open_dep",
      workstream: "wsx",
      title: "OD",
      impact: 50,
      effortDays: 1,
      blockedBy: ["root"],
    });
    addTask(db, {
      localId: "closed_dep",
      workstream: "wsx",
      title: "CD",
      impact: 50,
      effortDays: 1,
      blockedBy: ["root"],
    });
    // wontfix: a done close would be refused while `root` is open.
    closeTask(db, "closed_dep", { workstream: "wsx", as: "wontfix", why: "n/a" });

    const { stdout, exitCode } = await runCli(["task", "show", "root", "-w", "wsx"], dbPath);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(edges(plain)).toEqual([
      "dependent\topen_dep\tOPEN",
      "dependent\tclosed_dep\tCLOSED/wontfix",
    ]);
  });

  it("--json: blockers/dependents are arrays of {id, status, substate} items", async () => {
    addTask(db, { localId: "b_open", workstream: "wsx", title: "O", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b_done", workstream: "wsx", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "wsx",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["b_open", "b_done"],
    });
    closeTask(db, "b_done", { workstream: "wsx", evidence: "test" });
    addTask(db, {
      localId: "downstream",
      workstream: "wsx",
      title: "DS",
      impact: 50,
      effortDays: 1,
      blockedBy: ["target"],
    });

    const { data, exitCode } = await runCliJson(
      ["task", "show", "target", "-w", "wsx", "--json"],
      dbPath,
    );
    expect(exitCode).toBeNull();
    const parsed = data as {
      blockers: Array<{ id: string; status: string }>;
      dependents: Array<{ id: string; status: string }>;
      edges_more: number;
    };
    // Still-gating first (same order as the text records), CLOSED after.
    expect(parsed.blockers).toEqual([
      { id: "b_open", status: "OPEN", substate: "todo" },
      { id: "b_done", status: "CLOSED", substate: "done" },
    ]);
    expect(parsed.dependents).toEqual([{ id: "downstream", status: "OPEN", substate: "todo" }]);
    expect(parsed.edges_more).toBe(0);
  });
});
