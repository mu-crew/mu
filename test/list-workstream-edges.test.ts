import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, openDb, WorkstreamNotFoundError } from "../src/db.js";
import { listWorkstreamEdges } from "../src/index.js";
import { addTask, closeTask } from "../src/tasks.js";
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

  it("throws WorkstreamNotFoundError for a missing workstream", () => {
    const db = fixtureDb();
    expect(() => listWorkstreamEdges(db, "nope")).toThrow(WorkstreamNotFoundError);
  });
});
