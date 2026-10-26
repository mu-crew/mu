import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRONTIER_MAX_DEPTH, loadOpenTaskFrontier } from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";

let openDbs: Db[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-dag-"));
  dirs.push(dir);
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

describe("open task frontier", () => {
  it("reads a task subtree with a bounded number of SQL reads, and counts what the depth cap left out", () => {
    const db = fixtureDb();
    const chain = (n: number): void => {
      for (let i = 0; i < n; i++) {
        addTask(db, {
          workstream: "demo",
          localId: `t${i}`,
          title: `T${i}`,
          impact: 50,
          effortDays: 1,
          ...(i === 0 ? {} : { blockedBy: [`t${i - 1}`] }),
        });
      }
    };
    chain(100);
    const reads = (): number => {
      let prepares = 0;
      const countedDb = new Proxy(db, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (property === "prepare") {
            return (...args: Parameters<Db["prepare"]>) => {
              prepares++;
              return target.prepare(...args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      loadOpenTaskFrontier(countedDb, "demo", "t0", "dependents");
      return prepares;
    };
    const { entries } = loadOpenTaskFrontier(db, "demo", "t0", "dependents");
    const names = entries.map((e) => e.task.name);
    // Capped traversal: the deepest listed task is FRONTIER_MAX_DEPTH levels down...
    expect(names).toContain(`t${FRONTIER_MAX_DEPTH}`);
    expect(names).not.toContain(`t${FRONTIER_MAX_DEPTH + 1}`);
    // ...and it counts exactly one open task hanging below it.
    expect(entries.at(-1)?.kids).toBe(1);
    // One read per level, never per node: bounded by the depth cap, not the chain.
    const small = reads();
    expect(small).toBeLessThanOrEqual(FRONTIER_MAX_DEPTH + 6);
    for (let i = 100; i < 300; i++) {
      addTask(db, {
        workstream: "demo",
        localId: `t${i}`,
        title: `T${i}`,
        impact: 50,
        effortDays: 1,
        blockedBy: [`t${i - 1}`],
      });
    }
    expect(reads()).toBe(small);
  });
});
