// Regressions for task-verb bugs found in the crew-ut-mureview sweep:
//   f_tasks_block_samename_other_ws   block / reparent resolve the blocker
//                                     in the dependent's workstream first
//   f_tasks_reclose_overwrites_substate a bare re-close keeps the substate
//   f_tasks_recent_closed_updatedat   listRecentClosed's order is updated_at
//   f_tasks_slug_cap_boundary         a word ending exactly at the soft cap
//   f_tasks_empty_slug_exit1          empty slug is typed, exit 2 + hint
//   f_taskcli_nodown_hint             tree hint names a real flag
// Fast tier: real SQLite in a temp dir, in-process CLI, no tmux.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  addBlockEdge,
  addTask,
  closeTask,
  getTask,
  getTaskEdges,
  listNotes,
  reparentTask,
  slugifyTitleVerbose,
  TaskTitleSlugEmptyError,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-task-fix-regressions-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function add(localId: string, workstream: string): void {
  addTask(db, { localId, workstream, title: localId, impact: 50, effortDays: 1 });
}

describe("block / reparent with a same-id task in another workstream", () => {
  beforeEach(() => {
    // `aaa` sorts before `zzz`, so a global lookup ordered by name would
    // bind to aaa/shared.
    add("shared", "aaa");
    add("shared", "zzz");
    add("dep", "zzz");
  });

  it("addBlockEdge binds the blocker in the dependent's workstream", () => {
    const r = addBlockEdge(db, "zzz", "dep", "shared");
    expect(r.added).toBe(true);
    expect(getTaskEdges(db, "dep", "zzz").blockers).toEqual(["shared"]);
  });

  it("reparentTask binds the blocker in the task's workstream", () => {
    reparentTask(db, "dep", ["shared"], { workstream: "zzz" });
    expect(getTaskEdges(db, "dep", "zzz").blockers).toEqual(["shared"]);
  });

  it("still raises CrossWorkstreamEdgeError when the id is only elsewhere", () => {
    add("only_aaa", "aaa");
    expect(() => addBlockEdge(db, "zzz", "dep", "only_aaa")).toThrow(/cross-workstream/);
  });
});

describe("re-closing a CLOSED task", () => {
  it("a bare close keeps wontfix (idempotent no-op)", () => {
    add("r", "ws");
    closeTask(db, "r", { workstream: "ws", as: "wontfix", why: "not worth it at all" });
    const again = closeTask(db, "r", { workstream: "ws" });
    expect(again).toMatchObject({ changed: false, substate: "wontfix" });
    expect(getTask(db, "r", "ws")?.substate).toBe("wontfix");
  });

  it("an explicit --as still reclassifies", () => {
    add("r", "ws");
    closeTask(db, "r", { workstream: "ws", as: "rejected", why: "nope, wrong approach" });
    const again = closeTask(db, "r", { workstream: "ws", as: "done" });
    expect(again).toMatchObject({ changed: true, previousSubstate: "rejected", substate: "done" });
  });

  it("a bare close of an OPEN task still defaults to done", () => {
    add("o", "ws");
    expect(closeTask(db, "o", { workstream: "ws" })).toMatchObject({ substate: "done" });
    expect(listNotes(db, "o", "ws")).toEqual([]);
  });
});

describe("slugifyTitleVerbose soft-cap boundary", () => {
  it("keeps a word that ends exactly at the 40-char cap", () => {
    const keep = `${"a".repeat(20)}_${"b".repeat(19)}`;
    const r = slugifyTitleVerbose(`${"a".repeat(20)} ${"b".repeat(19)} ccc`);
    expect(keep).toHaveLength(40);
    expect(r).toMatchObject({ slug: keep, truncated: true });
  });

  it("throws the typed error on a title with no ASCII alnum", () => {
    expect(() => slugifyTitleVerbose("日本語")).toThrow(TaskTitleSlugEmptyError);
  });
});

describe("CLI surfaces", () => {
  beforeEach(() => {
    ensureWorkstream(db, "t");
  });

  it("`task add` with an unsluggable title exits 2 and points at <id>", async () => {
    const r = await runCli(
      ["task", "add", "-w", "t", "--title", "日本語", "-i", "5", "-e", "1"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("title yields empty slug");
    expect(r.stderr).toContain("mu task add <id>");
  });

  it("`task add` with an invalid id exits 2 (usage), like an invalid workstream name", async () => {
    const r = await runCli(
      ["task", "add", "Bad ID", "-w", "t", "-t", "x", "-i", "5", "-e", "1"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Usage: mu task add");
  });

  it("`task tree --down` hints at a flag that exists", async () => {
    add("a", "t");
    const r = await runCli(["task", "tree", "a", "--down", "-w", "t"], dbPath);
    expect(r.stdout).toContain("omit --down for blockers");
    expect(r.stdout).not.toContain("--no-down");
  });
});
