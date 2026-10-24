import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(e.errorNextSteps()[0]?.command).toBe(`mu task unblock b --by a -w ${WS}`);
  });

  it("findCyclePath terminates on pre-existing cycles", () => {
    const a = taskIdFor(db, "a", WS) as number;
    const c = taskIdFor(db, "c", WS) as number;
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(c, a, "x");
    expect(findCyclePath(db, c, a)).toEqual(["a", "b", "c"]);
  });

  it("stays fast on a wide layered DAG with a direct return edge", () => {
    // 7 layers x 7 tasks, every task blocks every task in the next layer:
    // ~7^6 simple paths that never reach the goal. A per-path walk
    // enumerates all of them before picking the shortest.
    const layers: string[][] = [];
    for (let l = 0; l < 7; l++) {
      layers.push([]);
      for (let i = 0; i < 7; i++) {
        const id = `l${l}_${i}`;
        addTask(db, { localId: id, title: id, workstream: WS, impact: 50, effortDays: 1 });
        layers[l]?.push(id);
      }
    }
    // Raw inserts in one transaction: addBlockEdge runs a cycle check per edge
    // (~4ms each, 1.3s for ~300), and only the path search under test matters.
    const ins = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    const id = (n: string): number => taskIdFor(db, n, WS) as number;
    db.transaction(() => {
      for (let l = 0; l < 6; l++)
        for (const from of layers[l] ?? [])
          for (const to of layers[l + 1] ?? []) ins.run(id(from), id(to), "x");
      for (const first of layers[0] ?? []) ins.run(id("c"), id(first), "x"); // c blocks layer 0
    })();
    const t0 = Date.now();
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
    const ms = Date.now() - t0;
    expect(ms, `cycle check took ${ms}ms`).toBeLessThan(150);
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
