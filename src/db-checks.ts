// mu — the portable `checks` table (spec D5, D8): its DDL and the re-fold
// that runs when an older v13 file gains it.
//
// A check is one review of a task by a native subagent or a cross-family
// pane, recorded by `mu task check` (the brief) and `mu task verdict` (the
// VERDICT/EVIDENCE lines), so a verdict is something mu recorded. The id is
// a ULID: two synced machines never mint the same one. The natural key every
// op is filed under is `<task key>#<check id>` (src/capture.ts).
//
// Additive at schema 13 (no bump). A build from before the table records a
// peer's `check` ops in `ops` without projecting them (an unknown entity is a
// forward-compatible no-op), so the upgrade that creates the table re-applies
// every stored `check` op through `applyOp`, in the same transaction.

import { applyOp } from "./apply.js";
import type { Db } from "./db.js";

/** `checks.state`: `open` until a verdict is recorded, then `answered`. The
 *  fold derives it from the verdict, so a peer cannot split the two, and a
 *  table CHECK refuses a local write that would. */
export const CHECK_STATES = ["open", "answered"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const CHECKS_DDL = `
-- checks: one recorded check of a task (portable; src/db-checks.ts). id is a
-- ULID; checker is the --by <harness>/<model>; verdict NULL: unanswered.
CREATE TABLE IF NOT EXISTS checks (
  id         TEXT PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  checker    TEXT NOT NULL,
  brief      TEXT NOT NULL,
  verdict    TEXT,
  state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- state is the verdict's shadow (the fold derives it): a write cannot split them.
  CHECK ((verdict IS NULL) = (state = 'open'))
);
CREATE INDEX IF NOT EXISTS idx_checks_task ON checks (task_id);
`;

/** True when this file has no `checks` table yet (an older v13 file). */
export function checksTableMissing(db: Db): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'checks'").get() ===
    undefined
  );
}

/**
 * Project every `check` op already in the log: the ops a peer synced, or
 * this machine recorded, before the table existed. Runs inside upgradeSchema's
 * transaction (each `applyOp` nests as a savepoint) after the capture
 * triggers are installed, so nothing it writes is captured again. The fold
 * is order-independent, so a verdict stored before its brief lands the same.
 * Returns the number of ops that changed a row.
 */
export function refoldStoredChecks(db: Db): number {
  const ops = db
    .prepare(
      `SELECT hlc, machine_id AS machineId, group_id AS groupId, actor, intent, entity, key, op, payload
         FROM ops WHERE entity = 'check' ORDER BY hlc`,
    )
    .all() as Parameters<typeof applyOp>[1][];
  let changed = 0;
  for (const op of ops) if (applyOp(db, op).changed) changed += 1;
  return changed;
}
