// Workstream-scoped ops reads must not full-scan ops for a quiet or
// unknown workstream (f_ops_key_scan), and must return exactly the rows
// the exact-or-LIKE scope does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  appendLog,
  groupIdFromPrefix,
  lastClaimActor,
  latestSeq,
  listLogs,
  workstreamScopeParams,
  workstreamScopeSql,
} from "../src/logs.js";
import { ensureWorkstream } from "../src/workstream.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-log-scope-"));
  db = openDb({ path: join(dir, "mu.db") });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** Record the EXPLAIN QUERY PLAN of every ops statement `fn` runs. */
function plansOf(fn: () => unknown): string[] {
  const plans: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    if (/\bFROM ops\b/.test(sql) && !sql.trimStart().startsWith("EXPLAIN")) {
      const original = stmt.all.bind(stmt);
      const get = stmt.get.bind(stmt);
      const explain = (params: unknown[]) => {
        const rows = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
        plans.push(rows.map((r) => r.detail).join(" | "));
      };
      stmt.all = ((...params: unknown[]) => {
        explain(params);
        return original(...params);
      }) as typeof stmt.all;
      stmt.get = ((...params: unknown[]) => {
        explain(params);
        return get(...params);
      }) as typeof stmt.get;
    }
    return stmt;
  }) as typeof db.prepare;
  try {
    fn();
  } finally {
    db.prepare = prepare as typeof db.prepare;
  }
  return plans;
}

/** Many unrelated ops so a full scan and a seek have different plans. */
function busyOtherWorkstream(n: number): void {
  ensureWorkstream(db, "busy");
  for (let i = 0; i < n; i++) {
    appendLog(db, { workstream: "busy", source: "w", kind: "message", payload: `m${i}` });
  }
}

const fullScan = (plan: string) => /\bSCAN l\b|\bSCAN ops\b/.test(plan);

describe("workstream-scoped ops reads", () => {
  it("a quiet workstream outside the recent window is a SEARCH, not a SCAN", () => {
    ensureWorkstream(db, "quiet");
    appendLog(db, { workstream: "quiet", source: "w", kind: "message", payload: "old" });
    busyOtherWorkstream(2100);

    const plans = plansOf(() => {
      expect(listLogs(db, { workstream: "quiet", limit: 20 }).map((r) => r.payload)).toContain(
        "old",
      );
      expect(latestSeq(db, "quiet")).toBeGreaterThan(0);
      expect(listLogs(db, { workstream: "nope", limit: 20 })).toEqual([]);
      expect(latestSeq(db, "nope")).toBe(0);
    });
    const fallbacks = plans.filter((p) => p.includes("idx_ops_entity_key (entity=? AND key>?"));
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const p of fallbacks) expect(fullScan(p)).toBe(false);
  });

  it("returns the exact-or-LIKE row set, and '_' in a name does not widen it", () => {
    ensureWorkstream(db, "a_b");
    ensureWorkstream(db, "axb");
    ensureWorkstream(db, "a_b2");
    appendLog(db, { workstream: "a_b", source: "w", kind: "message", payload: "mine" });
    appendLog(db, { workstream: "axb", source: "w", kind: "message", payload: "other" });
    appendLog(db, { workstream: "a_b2", source: "w", kind: "message", payload: "prefix" });

    const reference = (
      db
        .prepare(`SELECT seq FROM ops l WHERE ${workstreamScopeSql()} ORDER BY seq`)
        .pluck()
        .all(...workstreamScopeParams("a_b")) as number[]
    ).filter((seq) => listLogs(db, {}).some((r) => r.seq === seq));
    expect(listLogs(db, { workstream: "a_b" }).map((r) => r.seq)).toEqual(reference);
    expect(listLogs(db, { workstream: "a_b", limit: 50 }).map((r) => r.seq)).toEqual(reference);
    expect(listLogs(db, { workstream: "a_b" }).map((r) => r.payload)).not.toContain("other");
    expect(listLogs(db, { workstream: "a_b" }).map((r) => r.payload)).not.toContain("prefix");
  });

  it("lastClaimActor and groupIdFromPrefix seek their indexes", () => {
    ensureWorkstream(db, "ws");
    appendLog(db, { workstream: "ws", source: "w", kind: "message", payload: "x" });
    const group = (db.prepare("SELECT group_id FROM ops LIMIT 1").get() as { group_id: string })
      .group_id;
    const plans = plansOf(() => {
      expect(lastClaimActor(db, "ws", "never-claimed")).toBeNull();
      expect(groupIdFromPrefix(db, group.slice(0, 8))).toBe(group);
    });
    expect(plans).toHaveLength(2);
    for (const p of plans) expect(fullScan(p)).toBe(false);
    expect(plans[0]).toContain("idx_ops_entity_key (entity=? AND key=?)");
    expect(plans[1]).toContain("idx_ops_group (group_id>? AND group_id<?)");
  });
});
