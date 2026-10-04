// mu — keep mu.db slim: `mu db compact` and `mu db forget`.
//
// The ops log is append-only except for these two operator verbs. Both
// rewrite history on THIS machine only and never touch sync segments:
//
// - compact: a note tombstone (`op='del'`) whose key also has a put in
//   the log carries a copy of that put's row. Undo folds the puts and
//   apply's delete reads the put, so the copy is dead weight; blank it
//   to `{}`. Capture stopped writing these copies (src/capture.ts
//   noteTombstonePayload); this applies the same rule to old rows.
// - forget: delete every op of named, torn-down workstreams. Their rows
//   are already gone from the live tables, so rebuild and drift stay
//   consistent; what is lost is `mu undo` of that teardown, on purpose.
//
// Neither is reached by a trigger or a sync path. The CLI backs up the
// DB first and runs the drift check after.

import type { Db } from "./db.js";
import { intentSpellings } from "./legacy-ops.js";

/** Note tombstones whose payload is redundant with a put under the same key. */
const REDUNDANT_TOMBSTONES_SQL = `
  SELECT d.seq AS seq, length(d.payload) AS bytes
    FROM ops d
   WHERE d.entity = 'note' AND d.op = 'del' AND d.payload <> '{}'
     AND EXISTS (SELECT 1 FROM ops p
                  WHERE p.entity = 'note' AND p.key = d.key AND p.op = 'put')`;

export interface CompactPlan {
  /** Note tombstones that would be blanked. */
  tombstones: number;
  /** Payload bytes those tombstones carry now. */
  bytes: number;
}

export function planCompact(db: Db): CompactPlan {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM (${REDUNDANT_TOMBSTONES_SQL})`,
    )
    .get() as { n: number; b: number };
  return { tombstones: r.n, bytes: r.b };
}

/** Blank every redundant note tombstone, in one transaction. */
export function compact(db: Db): CompactPlan {
  const plan = planCompact(db);
  db.transaction(() => {
    db.prepare(
      `UPDATE ops SET payload = '{}' WHERE seq IN (SELECT seq FROM (${REDUNDANT_TOMBSTONES_SQL}))`,
    ).run();
  })();
  return plan;
}

/** The ops one workstream's history occupies: the workstream op itself,
 *  and every op keyed under it (`<ws>/...`: tasks, notes, edges, agents,
 *  workspaces, waves). */
const WORKSTREAM_OPS_WHERE = `(key = @ws OR substr(key, 1, length(@ws) + 1) = @ws || '/')`;

export interface ForgetCandidate {
  name: string;
  /** ISO time of its latest teardown. */
  tornDownAt: string;
  ops: number;
  /** Payload bytes of those ops (the on-disk share is about twice this,
   *  with the row overhead and the four ops indexes). */
  bytes: number;
}

/** Why a name cannot be forgotten. */
export type ForgetRefusal = "live" | "never-torn-down";

export interface ForgetPlan {
  candidates: ForgetCandidate[];
  refused: { name: string; why: ForgetRefusal }[];
}

/** Every torn-down workstream that is not live again, largest first. */
export function listForgetCandidates(db: Db): ForgetCandidate[] {
  const spellings = intentSpellings("workstream.teardown");
  const names = db
    .prepare(
      `SELECT key AS name, MAX(created_at) AS at
         FROM ops
        WHERE entity = 'workstream' AND op = 'del'
          AND intent IN (${spellings.map(() => "?").join(", ")})
          AND key NOT IN (SELECT name FROM workstreams)
        GROUP BY key`,
    )
    .all(...spellings) as { name: string; at: string }[];
  const cost = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(payload)), 0) AS b FROM ops WHERE ${WORKSTREAM_OPS_WHERE}`,
  );
  return names
    .map((r) => {
      const c = cost.get({ ws: r.name }) as { n: number; b: number };
      return { name: r.name, tornDownAt: r.at, ops: c.n, bytes: c.b };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

export function planForget(db: Db, names: readonly string[]): ForgetPlan {
  const all = new Map(listForgetCandidates(db).map((c) => [c.name, c]));
  const live = new Set(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );
  const plan: ForgetPlan = { candidates: [], refused: [] };
  for (const name of new Set(names)) {
    const c = all.get(name);
    if (c) plan.candidates.push(c);
    else plan.refused.push({ name, why: live.has(name) ? "live" : "never-torn-down" });
  }
  return plan;
}

/** Delete every op of the plan's candidates, in one transaction. Not undoable. */
export function forget(db: Db, plan: ForgetPlan): { ops: number } {
  const del = db.prepare(`DELETE FROM ops WHERE ${WORKSTREAM_OPS_WHERE}`);
  let ops = 0;
  db.transaction(() => {
    for (const c of plan.candidates) ops += del.run({ ws: c.name }).changes;
  })();
  return { ops };
}
