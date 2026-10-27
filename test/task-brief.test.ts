// buildTaskBrief: the executor's prompt for one attempt, built from the
// task's own notes. First brief verbatim, latest report, pinned note numbers.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { buildTaskBrief, TaskBriefMissingError } from "../src/task-brief.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-brief-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "d");
  addTask(db, { workstream: "d", localId: "t1", title: "T" });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const note = (text: string, kind: "brief" | "report" | "note" = "note") =>
  addNote(db, "t1", text, { workstream: "d", kind, author: "a" });

describe("buildTaskBrief", () => {
  it("never tells the worker to cd anywhere: its cwd is its worktree", () => {
    note("Change src/x.ts.", "brief");
    const b = buildTaskBrief(db, "d", "t1");
    expect(b.text).not.toMatch(/\bcd\b|workspace path/);
  });

  it("is the first brief verbatim plus one task/CLOSE footer; pins the brief note", () => {
    note("Do the thing.\n\nScope: src/x.ts only.", "brief");
    const b = buildTaskBrief(db, "d", "t1");
    expect(b.text.startsWith("Do the thing.\n\nScope: src/x.ts only.")).toBe(true);
    expect(b.text).toContain("t1");
    expect(b.text.match(/CLOSE:/g)).toHaveLength(1);
  });

  it("a later brief note never replaces the first", () => {
    note("first", "brief");
    note("second", "brief");
    const b = buildTaskBrief(db, "d", "t1");
    expect(b.text.startsWith("first")).toBe(true);
    expect(b.text).not.toContain("second");
  });

  it("carries the LATEST report, without 'previous attempt died' unless retrying", () => {
    note("brief", "brief");
    note("old report", "report");
    note("chatter");
    note("newer report", "report");
    const b = buildTaskBrief(db, "d", "t1");
    expect(b.text).toContain("newer report");
    expect(b.text).not.toContain("old report");
    expect(b.text).not.toContain("previous attempt died");
    expect(buildTaskBrief(db, "d", "t1", { retry: true }).text).toContain("previous attempt died");
  });

  it("is never recursive: the footer is not part of what a later brief quotes", () => {
    note("brief", "brief");
    const one = buildTaskBrief(db, "d", "t1");
    const two = buildTaskBrief(db, "d", "t1", { retry: true });
    expect(one.text.match(/CLOSE:/g)).toHaveLength(1);
    expect(two.text.match(/CLOSE:/g)).toHaveLength(1);
  });

  it("refuses a task with no brief", () => {
    note("just a note");
    expect(() => buildTaskBrief(db, "d", "t1")).toThrow(TaskBriefMissingError);
    expect(() => buildTaskBrief(db, "d", "ghost")).toThrow(/ghost/);
  });
});
