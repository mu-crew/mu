// Regression test for f_orch_close_db_locked: write transactions must
// take the write lock up front (BEGIN IMMEDIATE). A deferred transaction
// that reads, then writes, fails with SQLITE_BUSY_SNAPSHOT the moment
// another process commits in between, and busy_timeout does not retry
// that. Under a fan-out of concurrent `mu` processes this surfaced as
// `mu agent close` / `mu task close` dying with "database is locked".
//
// Two connections to one WAL file stand in for two processes. After the
// first has read inside its transaction and before it writes, the second
// tries to commit a write. With BEGIN IMMEDIATE the second one is refused
// (it would wait on busy_timeout; here 0) and the first commits. With a
// deferred BEGIN the second commits and the first dies on its write with
// SQLITE_BUSY_SNAPSHOT ("database is locked").

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAgent, getAgent, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask, closeTask, getTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let path: string;
let a: Db;
let b: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-tx-imm-"));
  path = join(dir, "mu.db");
  a = openDb({ path });
  ensureWorkstream(a, "auth");
  ensureWorkstream(a, "other");
  b = openDb({ path });
  b.pragma("busy_timeout = 0");
});

afterEach(() => {
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `fn` on connection `a`; the first write statement `a` prepares
 * inside a transaction (so after its reads) triggers a competing write
 * on `b`. Returns what `b` saw.
 */
function withCompetingWrite(fn: () => void): { competitor: "committed" | "refused" } {
  const realPrepare = a.prepare.bind(a);
  let competitor: "committed" | "refused" | undefined;
  a.prepare = ((sql: string) => {
    if (competitor === undefined && a.inTransaction && /^\s*(UPDATE|DELETE|INSERT)/i.test(sql)) {
      try {
        b.prepare("UPDATE workstreams SET name = name WHERE name = 'other'").run();
        competitor = "committed";
      } catch (e) {
        expect(String(e)).toMatch(/locked|busy/i);
        competitor = "refused";
      }
    }
    return realPrepare(sql);
  }) as typeof a.prepare;
  try {
    fn();
  } finally {
    a.prepare = realPrepare as typeof a.prepare;
  }
  if (competitor === undefined) throw new Error("fn never prepared a write in a transaction");
  return { competitor };
}

describe("write transactions take the write lock up front", () => {
  it("deleteAgent (the agent-close reaper) survives a concurrent commit", async () => {
    insertAgent(a, { name: "worker-1", workstream: "auth", paneId: "%1" });
    addTask(a, { localId: "build", workstream: "auth", title: "Build", impact: 50, effortDays: 1 });
    await claimTask(a, "build", { agentName: "worker-1", workstream: "auth" });

    const r = withCompetingWrite(() => {
      expect(deleteAgent(a, "worker-1", "auth")).toBe(true);
    });

    expect(r.competitor).toBe("refused");
    expect(getAgent(a, "worker-1", "auth")).toBeUndefined();
    expect(getTask(a, "build", "auth")?.status).toBe("OPEN");
  });

  it("closeTask survives a concurrent commit", () => {
    addTask(a, { localId: "build", workstream: "auth", title: "Build", impact: 50, effortDays: 1 });

    const r = withCompetingWrite(() => {
      closeTask(a, "build", { workstream: "auth" });
    });

    expect(r.competitor).toBe("refused");
    expect(getTask(a, "build", "auth")?.status).toBe("CLOSED");
  });
});
