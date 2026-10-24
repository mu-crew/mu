// Note kinds are set once at INSERT (v_task_mutations): addNote/closeTask
// writers, the `inherit` group option, and the CLI/extension surfaces that
// choose a kind. The append-only refusal of a kind UPDATE itself is proven
// in schema-v12.test.ts; here we prove every WRITER picks the right kind.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARD_NEEDS_EVIDENCE } from "../src/capture.js";
import { type Db, openDb } from "../src/db.js";
import { withOpContext } from "../src/op-context.js";
import { addNote, addTask, closeTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-note-kinds-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "w");
  addTask(db, { workstream: "w", localId: "t", title: "T" });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const kinds = (): { kind: string; content: string }[] =>
  db.prepare("SELECT kind, content FROM task_notes ORDER BY id").all() as {
    kind: string;
    content: string;
  }[];
const noteOps = () =>
  db
    .prepare("SELECT group_id, actor, intent FROM ops WHERE entity = 'note' ORDER BY seq")
    .all() as { group_id: string; actor: string | null; intent: string | null }[];

describe("addNote", () => {
  it("returns the kind; default 'note'", () => {
    expect(addNote(db, "t", "x", { workstream: "w" }).kind).toBe("note");
    expect(addNote(db, "t", "y", { workstream: "w", kind: "verdict" }).kind).toBe("verdict");
    expect(kinds().map((k) => k.kind)).toEqual(["note", "verdict"]);
  });

  it("group 'new' (default) starts its own group even inside an outer one", () => {
    let outer = "";
    withOpContext(db, { intent: "outer", group: "new" }, () => {
      outer = (db.prepare("SELECT group_id FROM op_ctx").get() as { group_id: string }).group_id;
      addNote(db, "t", "x", { workstream: "w", author: "me" });
    });
    const [n] = noteOps();
    expect(n?.group_id).not.toBe(outer);
    expect(n?.intent).toBe("task.note");
    expect(n?.actor).toBe("me");
  });

  it("group 'inherit' joins the OUTER group, actor and intent (never the literal 'inherit')", () => {
    let outerGroup: string | null = null;
    withOpContext(db, { intent: "delegate.record", actor: "outer-actor", group: "new" }, () => {
      outerGroup = (db.prepare("SELECT group_id FROM op_ctx").get() as { group_id: string })
        .group_id;
      addNote(db, "t", "v", {
        workstream: "w",
        author: "note-author",
        kind: "verdict",
        group: "inherit",
      });
      addNote(db, "t", "w", { workstream: "w", kind: "report", group: "inherit" });
    });
    const ops = noteOps();
    expect(ops).toHaveLength(2);
    for (const o of ops) {
      expect(o.group_id).toBe(outerGroup);
      expect(o.group_id).not.toBe("inherit");
      expect(o.intent).toBe("delegate.record");
      expect(o.actor).toBe("outer-actor");
    }
  });

  it("group 'inherit' with no outer context still mints a real group and labels itself", () => {
    addNote(db, "t", "v", { workstream: "w", author: "me", group: "inherit" });
    const [o] = noteOps();
    expect(o?.group_id).not.toBe("inherit");
    expect(o?.group_id.length).toBeGreaterThan(10);
    expect(o?.intent).toBe("task.note");
    expect(o?.actor).toBe("me");
  });
});

describe("closeTask --report", () => {
  it("writes report, then close notes, then the status put: ONE group, notes first", () => {
    closeTask(db, "t", {
      workstream: "w",
      evidence: "npm test: 12 passed",
      report: "FILES: a.ts\nDECISION: x",
    });
    expect(kinds()).toEqual([
      { kind: "report", content: "FILES: a.ts\nDECISION: x" },
      { kind: "close", content: "CLOSE: npm test: 12 passed" },
    ]);
    const rows = db
      .prepare("SELECT entity, group_id FROM ops WHERE intent = 'task.close' ORDER BY seq")
      .all() as { entity: string; group_id: string }[];
    expect(rows.map((r) => r.entity)).toEqual(["note", "note", "task"]);
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
  });

  it("a report is NOT evidence: closing to done with only --report is refused, nothing written", () => {
    expect(() => closeTask(db, "t", { workstream: "w", report: "all done" })).toThrow(
      /needs evidence/,
    );
    expect(kinds()).toEqual([]);
    expect(db.prepare("SELECT status FROM tasks").get()).toEqual({ status: "OPEN" });
  });

  it("the DB guard also refuses a report-kind note as the only note before the status put", () => {
    let msg = "no error";
    try {
      withOpContext(db, { intent: "task.close", group: "new" }, () => {
        addNote(db, "t", "r", { workstream: "w", kind: "report", group: "inherit" });
        db.prepare("UPDATE tasks SET status = 'CLOSED', substate = 'done'").run();
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(GUARD_NEEDS_EVIDENCE);
  });

  it("a non-done close takes --report beside --why (report first)", () => {
    closeTask(db, "t", { workstream: "w", as: "wontfix", why: "out of scope", report: "R" });
    expect(kinds()).toEqual([
      { kind: "report", content: "R" },
      { kind: "close", content: "WONTFIX: out of scope" },
    ]);
  });

  it("an idempotent retry writes no second report", () => {
    closeTask(db, "t", { workstream: "w", evidence: "e", report: "R" });
    closeTask(db, "t", { workstream: "w", evidence: "e", report: "R" });
    expect(kinds().filter((k) => k.kind === "report")).toHaveLength(1);
  });

  it("group 'inherit' keeps the caller's group, actor and intent for report, close and status", () => {
    let outer = "";
    withOpContext(db, { intent: "close.apply", actor: "applier", group: "new" }, () => {
      outer = (db.prepare("SELECT group_id FROM op_ctx").get() as { group_id: string }).group_id;
      closeTask(db, "t", { workstream: "w", evidence: "e", report: "R", group: "inherit" });
    });
    const rows = db.prepare("SELECT group_id, actor, intent FROM ops ORDER BY seq").all() as {
      group_id: string;
      actor: string | null;
      intent: string | null;
    }[];
    const closeRows = rows.filter((r) => r.group_id === outer);
    expect(closeRows.length).toBeGreaterThanOrEqual(3);
    for (const r of closeRows) {
      expect(r.actor).toBe("applier");
      expect(r.intent).toBe("close.apply");
    }
    expect(rows.some((r) => r.group_id === "inherit")).toBe(false);
  });
});

describe("CLI note kinds", () => {
  const note = (...args: string[]) =>
    runCli(["task", "note", "t", "-w", "w", "--author", "a", ...args], dbPath);

  it("task note --report writes kind report; plain writes note", async () => {
    expect((await note("plain")).exitCode).toBeNull();
    expect((await note("the report", "--report")).exitCode).toBeNull();
    const r = await runCliJson(["task", "note", "t", "x", "--report", "-w", "w", "--json"], dbPath);
    expect((r.data as { note: { kind: string } }).note.kind).toBe("report");
    const d = openDb({ path: dbPath });
    const got = d.prepare("SELECT kind, content FROM task_notes ORDER BY id").all();
    d.close();
    expect(got).toEqual([
      { kind: "note", content: "plain" },
      { kind: "report", content: "the report" },
      { kind: "report", content: "x" },
    ]);
  });

  it("the internal --kind writes a validated kind and is hidden from --help", async () => {
    expect((await note("v", "--kind", "verdict")).exitCode).toBeNull();
    const bad = await note("v", "--kind", "bogus");
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toMatch(/brief \| report \| verdict \| close \| note|brief, report/);
    const help = await runCli(["task", "note", "--help"], dbPath);
    expect(help.stdout).not.toContain("--kind");
    const d = openDb({ path: dbPath });
    const got = d.prepare("SELECT kind FROM task_notes").all();
    d.close();
    expect(got).toEqual([{ kind: "verdict" }]);
  });

  it("--report together with --kind is a usage error and writes nothing", async () => {
    const r = await note("x", "--report", "--kind", "verdict");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--report.*--kind|--kind.*--report/);
  });

  it("close --note is --evidence; --report writes the report in the same group", async () => {
    const r = await runCli(
      ["task", "close", "t", "-w", "w", "--note", "ran it: exit 0", "--report", "REPORT body"],
      dbPath,
    );
    expect(r.exitCode).toBeNull();
    const d = openDb({ path: dbPath });
    const got = d.prepare("SELECT kind, content FROM task_notes ORDER BY id").all();
    const groups = d.prepare("SELECT DISTINCT group_id FROM ops WHERE intent = 'task.close'").all();
    d.close();
    expect(got).toEqual([
      { kind: "report", content: "REPORT body" },
      { kind: "close", content: "CLOSE: ran it: exit 0" },
    ]);
    expect(groups).toHaveLength(1);
  });

  it("close with both --note and --evidence is a usage error", async () => {
    const r = await runCli(
      ["task", "close", "t", "-w", "w", "--note", "a", "--evidence", "b"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--note.*--evidence|--evidence.*--note/);
  });

  it("close --report alone (no evidence) still refuses a done close", async () => {
    const r = await runCli(["task", "close", "t", "-w", "w", "--report", "R"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/needs evidence/);
  });
});
