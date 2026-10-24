// addTasks (v_task_mutations): batch create + outbound `--blocks` edges in
// ONE op group and ONE transaction. Any failure (duplicate id, cycle,
// missing or cross-workstream umbrella, invalid id) rolls back every row,
// edge and brief of the batch.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  addTask,
  addTasks,
  CrossWorkstreamEdgeError,
  CycleError,
  getTaskEdges,
  listNotes,
  TaskExistsError,
  TaskIdInvalidError,
  TaskNotFoundError,
} from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-task-batch-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, "w");
  addTask(db, { workstream: "w", localId: "umbrella", title: "Umbrella" });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmFixtureDir(dir);
});

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const ids = (): string[] =>
  (db.prepare("SELECT local_id FROM tasks ORDER BY local_id").all() as { local_id: string }[]).map(
    (r) => r.local_id,
  );
const U = [{ id: "a", title: "A" }];

describe("addTasks", () => {
  it("creates every task, its brief and its --blocks edges, in ONE op group", () => {
    const before = (db.prepare("SELECT MAX(seq) AS s FROM ops").get() as { s: number }).s;
    const r = addTasks(
      db,
      [
        { id: "a", title: "A", note: "brief a" },
        { id: "b", title: "B" },
      ],
      { workstream: "w", blocks: ["umbrella"], noteAuthor: "me" },
    );
    expect(r).toMatchObject({ ids: ["a", "b"], changed: true });
    expect(getTaskEdges(db, "umbrella", "w").blockers.sort()).toEqual(["a", "b"]);
    expect(listNotes(db, "a", "w").map((n) => n.content)).toEqual(["brief a"]);
    expect(listNotes(db, "b", "w")).toEqual([]);
    const ops = db
      .prepare("SELECT entity, intent, group_id FROM ops WHERE seq > ?")
      .all(before) as { entity: string; intent: string; group_id: string }[];
    expect(new Set(ops.map((o) => o.entity))).toEqual(new Set(["task", "note", "edge"]));
    expect(new Set(ops.map((o) => o.group_id)).size).toBe(1);
    expect(new Set(ops.map((o) => o.intent))).toEqual(new Set(["task.add"]));
  });

  it("files every initial note as kind 'brief'", () => {
    addTasks(db, [{ id: "a", title: "A", note: "x" }], { workstream: "w" });
    expect(db.prepare("SELECT kind FROM task_notes").all()).toEqual([{ kind: "brief" }]);
  });

  it("applies one blockedBy/triage/score to every task", () => {
    addTasks(
      db,
      [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
      { workstream: "w", blockedBy: ["umbrella"], triage: true, impact: 70 },
    );
    expect(getTaskEdges(db, "a", "w").blockers).toEqual(["umbrella"]);
    expect(getTaskEdges(db, "b", "w").blockers).toEqual(["umbrella"]);
    expect(
      db.prepare("SELECT substate, impact, scored FROM tasks WHERE local_id = 'b'").get(),
    ).toEqual({ substate: "triage", impact: 70, scored: 1 });
  });

  it("an empty batch is a no-op", () => {
    expect(addTasks(db, [], { workstream: "w" })).toMatchObject({ ids: [], changed: false });
  });

  describe("rolls back the WHOLE batch", () => {
    const state = () => ({
      tasks: ids(),
      edges: count("task_edges"),
      notes: count("task_notes"),
      ops: count("ops"),
    });

    it("duplicate id inside the batch", () => {
      const before = state();
      expect(() =>
        addTasks(
          db,
          [
            { id: "a", title: "A", note: "n" },
            { id: "a", title: "again" },
          ],
          { workstream: "w", blocks: ["umbrella"] },
        ),
      ).toThrow(TaskExistsError);
      expect(state()).toEqual(before);
    });

    it("an id that already exists", () => {
      const before = state();
      expect(() =>
        addTasks(db, [...U, { id: "umbrella", title: "dup" }], { workstream: "w" }),
      ).toThrow(TaskExistsError);
      expect(state()).toEqual(before);
    });

    it("a cycle through --blocks (umbrella already blocked by... the new task's blocker)", () => {
      const before = state();
      // a is blockedBy umbrella AND blocks umbrella: umbrella -> a -> umbrella.
      expect(() =>
        addTasks(db, U, { workstream: "w", blockedBy: ["umbrella"], blocks: ["umbrella"] }),
      ).toThrow(CycleError);
      expect(state()).toEqual(before);
    });

    it("a missing umbrella, after earlier tasks were inserted", () => {
      const before = state();
      expect(() =>
        addTasks(
          db,
          [
            { id: "a", title: "A", note: "n" },
            { id: "b", title: "B" },
          ],
          { workstream: "w", blocks: ["umbrella", "ghost"] },
        ),
      ).toThrow(TaskNotFoundError);
      expect(state()).toEqual(before);
    });

    it("an umbrella in another workstream", () => {
      ensureWorkstream(db, "other");
      addTask(db, { workstream: "other", localId: "far", title: "far" });
      const before = state();
      expect(() => addTasks(db, U, { workstream: "w", blocks: ["far"] })).toThrow(
        CrossWorkstreamEdgeError,
      );
      expect(state()).toEqual(before);
    });

    it("an invalid id in the middle of the batch", () => {
      const before = state();
      expect(() =>
        addTasks(
          db,
          [
            { id: "a", title: "A" },
            { id: "Bad Id", title: "B" },
          ],
          { workstream: "w" },
        ),
      ).toThrow(TaskIdInvalidError);
      expect(state()).toEqual(before);
    });

    it("a failing brief insert after the tasks were created", () => {
      db.exec(
        "CREATE TEMP TRIGGER boom BEFORE INSERT ON task_notes BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      const before = state();
      expect(() => addTasks(db, [{ id: "a", title: "A", note: "n" }], { workstream: "w" })).toThrow(
        /boom/,
      );
      expect(state()).toEqual(before);
    });
  });

  it("--blocks twice on the same umbrella inserts one edge", () => {
    addTasks(db, U, { workstream: "w", blocks: ["umbrella", "umbrella"] });
    expect(count("task_edges")).toBe(1);
  });

  it("--blocks bumps the umbrella's updated_at", () => {
    const at = () =>
      (
        db.prepare("SELECT updated_at FROM tasks WHERE local_id = 'umbrella'").get() as {
          updated_at: string;
        }
      ).updated_at;
    const before = at();
    addTasks(db, U, { workstream: "w", blocks: ["umbrella"] });
    expect(at() > before).toBe(true);
  });
});
