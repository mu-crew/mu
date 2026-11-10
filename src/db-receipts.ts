// mu — the DDL of `spawn_receipts` (the journal of a task-bound spawn; see
// src/agents/receipts.ts) and the lossless rebuild of its shape from before plugin
// channels (a `transport` CHECK). db.ts splices the DDL into CURRENT_SCHEMA and runs the
// rebuild inside upgradeSchema's one transaction. Types only from db.ts (no
// runtime import back).

import type { Db } from "./db.js";

/** The states of a task-bound spawn attempt (`spawn_receipts.state`). */
export const SPAWN_RECEIPT_STATES = [
  "reserved",
  "pane",
  "claimed",
  "sending",
  "sent",
  "unknown",
  "failed",
] as const;
export type SpawnReceiptState = (typeof SPAWN_RECEIPT_STATES)[number];

export const SPAWN_RECEIPTS_DDL = `
-- spawn_receipts: one row per task-bound spawn attempt (machine-local). The
-- journal agent spawn --task writes BEFORE each external effect and that a
-- replay reads back. agent_id/pane_id name the registry incarnation it
-- created and carry NO foreign key on purpose: the receipt must outlive the
-- agent (a deleted or replaced name is "stale", never the replacement).
-- state: reserved (nothing happened yet) < pane (agent row + pane exist)
-- < claimed (task owned by agent_id) < sending (the send MAY have been
-- written: never resend) < sent | unknown; failed = definitely unsent and
-- rolled back. attempt_key is 'manual:<k>' for a manual spawn. transport:
-- 'ctl' (a receipt id), 'hooks' (a brief file and a pasted pointer, confirmed
-- by run_count; incarnation/runs hold the session and its baseline), 'mux', or
-- a plugin channel's name (plugins spec D5): no CHECK, the channel registry names it.
CREATE TABLE IF NOT EXISTS spawn_receipts (
  task_id     INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  attempt_key TEXT NOT NULL,
  name        TEXT NOT NULL,
  workstream  TEXT NOT NULL,
  request_sha TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  agent_id    INTEGER,
  pane_id     TEXT,
  transport   TEXT,
  incarnation TEXT,
  runs        INTEGER,
  state       TEXT NOT NULL
              CHECK (state IN (${SPAWN_RECEIPT_STATES.map((x) => `'${x}'`).join(", ")})),
  detail      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, attempt_key)
);
`;

/**
 * A spawn_receipts whose `transport` has a CHECK (a v13 file, or a v14 one from before plugin
 * channels): SQLite cannot drop or widen a CHECK in place.
 */
export function spawnReceiptsChecked(db: Db): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spawn_receipts'")
    .get() as { sql: string | null } | undefined;
  return row?.sql?.includes("CHECK (transport IN") === true;
}

const RECEIPT_COLUMNS =
  "task_id, attempt_key, name, workstream, request_sha, msg_id, agent_id, pane_id, transport, incarnation, runs, state, detail, created_at, updated_at";

/** The old table, set aside as spawn_receipts_pre_plugin, copied whole by its column list. */
export const SPAWN_RECEIPTS_REBUILD = `INSERT INTO spawn_receipts (${RECEIPT_COLUMNS}) SELECT ${RECEIPT_COLUMNS} FROM spawn_receipts_pre_plugin`;
