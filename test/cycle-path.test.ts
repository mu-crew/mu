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
});
