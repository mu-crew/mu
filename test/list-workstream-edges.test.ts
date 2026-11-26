import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, openDb, WorkstreamNotFoundError } from "../src/db.js";
import { listWorkstreamEdges } from "../src/index.js";
import { addTask, closeTask, parkTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

let openDbs: Db[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-edges-"));
  dirs.push(dir);
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function add(db: Db, ws: string, id: string, blockedBy: string[] = []): void {
  addTask(db, {
    workstream: ws,
    localId: id,
    title: id,
    impact: 50,
    effortDays: 1,
    ...(blockedBy.length ? { blockedBy } : {}),
  });
}

describe("listWorkstreamEdges", () => {
  it("returns [] for a workstream with no edges", () => {
    const db = fixtureDb();
    ensureWorkstream(db, "demo");
    expect(listWorkstreamEdges(db, "demo")).toEqual([]);
    add(db, "demo", "a");
    expect(listWorkstreamEdges(db, "demo")).toEqual([]);
  });

  it("returns every edge of a diamond, sorted, scoped to the workstream", () => {
    const db = fixtureDb();
    add(db, "demo", "a");
    add(db, "demo", "b", ["a"]);
    add(db, "demo", "c", ["a"]);
    add(db, "demo", "d", ["b", "c"]);
    add(db, "other", "x");
    add(db, "other", "y", ["x"]);
    expect(listWorkstreamEdges(db, "demo")).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ]);
  });

  it("keeps edges of closed tasks", () => {
    const db = fixtureDb();
    add(db, "demo", "a");
    add(db, "demo", "b", ["a"]);
    closeTask(db, "a", { workstream: "demo", evidence: "test" });
    expect(listWorkstreamEdges(db, "demo")).toEqual([{ from: "a", to: "b" }]);
  });

  it("keeps only edges with both ends in the workstream, parked ends included, same local ids elsewhere ignored", () => {
    const db = fixtureDb();
    add(db, "demo", "a");
    add(db, "demo", "b", ["a"]);
    add(db, "other", "a");
    add(db, "other", "b", ["a"]);
    parkTask(db, "b", { workstream: "demo", why: "test" });
    const id = (ws: string, local: string): number =>
      (
        db
          .prepare(
            "SELECT t.id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND t.local_id = ?",
          )
          .get(ws, local) as { id: number }
      ).id;
    // Stored cross-workstream edges in both directions (the schema allows them; sync can apply one).
    const edge = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, 'now')",
    );
    edge.run(id("demo", "a"), id("other", "b"));
    edge.run(id("other", "a"), id("demo", "b"));
    expect(listWorkstreamEdges(db, "demo")).toEqual([{ from: "a", to: "b" }]);
    expect(listWorkstreamEdges(db, "other")).toEqual([{ from: "a", to: "b" }]);
  });

  it("throws WorkstreamNotFoundError for a missing workstream", () => {
    const db = fixtureDb();
    expect(() => listWorkstreamEdges(db, "nope")).toThrow(WorkstreamNotFoundError);
  });
});
