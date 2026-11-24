import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { taskIdFor } from "../src/tasks/core.js";
import { findCyclePath } from "../src/tasks/edges.js";
import { CycleError } from "../src/tasks/errors.js";
import { addBlockEdge, addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

const WS = "ws";
let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-cycle-path-"));
  db = openDb({ path: join(dir, "mu.db") });
  ensureWorkstream(db, WS);
  for (const n of ["a", "b", "c"])
    addTask(db, { localId: n, title: n, workstream: WS, impact: 50, effortDays: 1 });
  addBlockEdge(db, WS, "b", "a"); // a blocks b
  addBlockEdge(db, WS, "c", "b"); // b blocks c
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("cycle path", () => {
  it("block error names the full path and a concrete unblock step", () => {
    let err: unknown;
    try {
      addBlockEdge(db, WS, "a", "c"); // c blocks a => cycle
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CycleError);
    const e = err as CycleError;
    expect(e.message).toBe("adding edge c -> a would create a cycle: c -> a -> b -> c");
  });

  it("findCyclePath terminates on pre-existing cycles", () => {
    const a = taskIdFor(db, "a", WS) as number;
    const c = taskIdFor(db, "c", WS) as number;
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(c, a, "x");
    expect(findCyclePath(db, c, a)).toEqual(["a", "b", "c"]);
  });

  it("expands each shared descendant once on a wide layered DAG and finds the direct return edge", () => {
    // A small DAG suffices: every pair of layers has shared descendants. A
    // per-path walk revisits a node, even without a graph wide enough to hang.
    const layers = Array.from({ length: 5 }, (_, l) =>
      Array.from({ length: 3 }, (_, i) => `l${l}_${i}`),
    );
    for (const id of layers.flat())
      addTask(db, { localId: id, title: id, workstream: WS, impact: 50, effortDays: 1 });
    // Build the fixture without running a cycle check per edge.
    const ins = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    const id = (n: string): number => taskIdFor(db, n, WS) as number;
    db.transaction(() => {
      for (let l = 0; l < layers.length - 1; l++)
        for (const from of layers[l] ?? [])
          for (const to of layers[l + 1] ?? []) ins.run(id(from), id(to), "x");
      for (const first of layers[0] ?? []) ins.run(id("c"), id(first), "x"); // c blocks layer 0
    })();

    const visited = new Set<unknown>();
    const prepare = db.prepare.bind(db);
    const queries = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (sql.includes("FROM task_edges WHERE from_task_id = ?")) {
        const all = stmt.all.bind(stmt);
        vi.spyOn(stmt, "all").mockImplementation((node) => {
          expect(visited.has(node), `revisited node ${node}`).toBe(false);
          visited.add(node);
          return all(node);
        });
      }
      return stmt;
    });
    try {
      const path = findCyclePath(db, id("l4_0"), id("c"));
      expect(path).toHaveLength(6);
      expect(path?.[0]).toBe("c");
      expect(path?.at(-1)).toBe("l4_0");
      expect(visited.size).toBe(1 + layers.slice(0, -1).flat().length);
    } finally {
      queries.mockRestore();
    }
    let err: unknown;
    try {
      addBlockEdge(db, WS, "a", "c"); // c blocks a: closes directly via a -> b -> c
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CycleError);
    expect((err as CycleError).message).toBe(
      "adding edge c -> a would create a cycle: c -> a -> b -> c",
    );
  });

  it("returns the shortest path when a longer route also closes the cycle", () => {
    for (const n of ["x", "y"])
      addTask(db, { localId: n, title: n, workstream: WS, impact: 50, effortDays: 1 });
    addBlockEdge(db, WS, "x", "a"); // a blocks x
    addBlockEdge(db, WS, "y", "x"); // x blocks y
    addBlockEdge(db, WS, "c", "y"); // y blocks c: a -> x -> y -> c (longer)
    const a = taskIdFor(db, "a", WS) as number;
    const c = taskIdFor(db, "c", WS) as number;
    expect(findCyclePath(db, c, a)).toEqual(["a", "b", "c"]);
  });
});
