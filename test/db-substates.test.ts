// Schema v11: the task_substates lookup table, the tasks.substate
// column, and the DEFERRABLE composite FK that ties them together.
// Every write path that sets status must set substate in the same
// statement, or the FK fails at commit.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, insertAgent } from "../src/agents.js";
import { applyOp } from "../src/apply.js";
import { CURRENT_SCHEMA_VERSION, type Db, openDb, SchemaTooNewError } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { TASK_SUBSTATE_ROWS } from "../src/tasks/status.js";
import {
  addTask,
  claimTask,
  closeTask,
  getTask,
  listGoals,
  listReady,
  releaseTask,
} from "../src/tasks.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-db-substates-"));
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function add(localId: string): void {
  addTask(db, { localId, workstream: "ws", title: localId, impact: 50, effortDays: 1 });
}

function pair(localId: string): { status: string; substate: string } {
  const t = getTask(db, localId, "ws");
  if (!t) throw new Error(`no task ${localId}`);
  return { status: t.status, substate: t.substate };
}

function raw(sql: string): void {
  db.prepare(sql).run();
}

describe("task_substates lookup table", () => {
  it("is seeded from TASK_SUBSTATE_ROWS exactly (map parity guard)", () => {
    const rows = db
      .prepare("SELECT status, substate, is_default FROM task_substates ORDER BY 1, 2")
      .all() as Array<{ status: string; substate: string; is_default: number }>;
    const expected = [...TASK_SUBSTATE_ROWS]
      .map(([status, substate, isDefault]) => ({ status, substate, is_default: isDefault }))
      .sort((a, b) =>
        a.status === b.status ? (a.substate < b.substate ? -1 : 1) : a.status < b.status ? -1 : 1,
      );
    expect(rows).toEqual(expected);
  });

  it("tasks has a foreign key into task_substates", () => {
    const fks = db.prepare("PRAGMA foreign_key_list(tasks)").all() as Array<{ table: string }>;
    expect(fks.some((f) => f.table === "task_substates")).toBe(true);
  });

  it("allows only one default per status", () => {
    expect(() =>
      raw("INSERT INTO task_substates (status, substate, is_default) VALUES ('OPEN', 'x', 1)"),
    ).toThrow(/UNIQUE/);
  });

  it("refuses to delete a pair a task still uses", () => {
    add("a");
    closeTask(db, "a", { workstream: "ws" });
    expect(() =>
      raw("DELETE FROM task_substates WHERE status = 'CLOSED' AND substate = 'done'"),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("tasks.substate FK", () => {
  it("addTask yields OPEN/todo", () => {
    add("a");
    expect(pair("a")).toEqual({ status: "OPEN", substate: "todo" });
  });

  it("is deferred: two single-field UPDATEs in one transaction commit", () => {
    add("a");
    db.transaction(() => {
      raw("UPDATE tasks SET status = 'CLOSED' WHERE local_id = 'a'");
      raw("UPDATE tasks SET substate = 'wontfix' WHERE local_id = 'a'");
    })();
    expect(pair("a")).toEqual({ status: "CLOSED", substate: "wontfix" });
  });

  it("rejects a substate that belongs to another status", () => {
    add("a");
    closeTask(db, "a", { workstream: "ws" });
    expect(() => raw("UPDATE tasks SET substate = 'parked' WHERE local_id = 'a'")).toThrow(
      /FOREIGN KEY/,
    );
  });

  it("rejects an unknown substate", () => {
    add("a");
    expect(() => raw("UPDATE tasks SET substate = 'bogus' WHERE local_id = 'a'")).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("views", () => {
  it("a parked OPEN task is absent from ready but stays a goal", () => {
    add("a");
    raw("UPDATE tasks SET substate = 'parked' WHERE local_id = 'a'");
    expect(listReady(db, "ws").map((t) => t.name)).not.toContain("a");
    expect(listGoals(db, "ws").map((t) => t.name)).toContain("a");
  });
});

describe("write sites keep the pair valid", () => {
  it("claim -> IN_PROGRESS/active; release -> OPEN/todo", async () => {
    add("a");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    await claimTask(db, "a", { agentName: "w1", workstream: "ws" });
    expect(pair("a")).toEqual({ status: "IN_PROGRESS", substate: "active" });
    releaseTask(db, "a", { workstream: "ws" });
    expect(pair("a")).toEqual({ status: "OPEN", substate: "todo" });
  });

  it("the reaper reverts IN_PROGRESS/active to OPEN/todo", async () => {
    add("a");
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1" });
    await claimTask(db, "a", { agentName: "w1", workstream: "ws" });
    expect(deleteAgent(db, "w1", "ws")).toBe(true);
    expect(pair("a")).toEqual({ status: "OPEN", substate: "todo" });
  });

  it("close -> CLOSED/done", () => {
    add("a");
    closeTask(db, "a", { workstream: "ws" });
    expect(pair("a")).toEqual({ status: "CLOSED", substate: "done" });
  });

  it("applyOp of a status-only put onto CLOSED/done commits as OPEN/todo", () => {
    add("a");
    closeTask(db, "a", { workstream: "ws" });
    applyOp(db, {
      hlc: formatHlc({
        wallMs: 2_000_000_000_000,
        counter: 0,
        machineId: "9f1c8a2e-0000-4000-8000-0000000000aa",
      }),
      machineId: "9f1c8a2e-0000-4000-8000-0000000000aa",
      groupId: "grp-1",
      actor: "peer",
      intent: null,
      entity: "task",
      key: "ws/a",
      op: "put",
      payload: JSON.stringify({ status: "OPEN" }),
    });
    expect(pair("a")).toEqual({ status: "OPEN", substate: "todo" });
  });
});

describe("SchemaTooNewError", () => {
  it("refuses a DB stamped newer than this build and leaves it untouched", () => {
    db.close();
    const future = CURRENT_SCHEMA_VERSION + 1;
    const h = new Database(dbPath);
    h.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(future);
    h.close();

    expect(() => openDb({ path: dbPath })).toThrow(SchemaTooNewError);

    const check = new Database(dbPath, { readonly: true });
    const row = check.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
      version: number;
    };
    check.close();
    expect(row.version).toBe(future);
  });
});
