// mu — the DDL of `carrier_jobs` (a lease spawn's reservation of its remote job; see
// src/carrier-jobs.ts) and the lossless rebuild of its pre-reservation shape. db.ts
// splices the DDL into CURRENT_SCHEMA and runs the rebuild inside upgradeSchema's one
// transaction. Types only from db.ts (no runtime import back).

import type { Db } from "./db.js";

export const CARRIER_JOBS_DDL = `
-- carrier_jobs: the RESERVATION of a lease agent's remote job (machine-local).
-- Inserted before the carrier's pane opens, name-exclusive per (workstream, name)
-- (ordinal 0; a rebuilt pre-reservation table's older rows of one name get 1..n),
-- every update guarded by the immutable spawn token. 'launch' turns 'intent' just
-- before the mux is asked for the pane; agent_id binds at finalize, job at the
-- handshake. No FK, no trigger, no op: agent deletion never touches it. Released
-- (deleted) only after a successful stop and the job file's and tree's cleanup, by
-- its creator when nothing was launched, or by an explicit abandon. 'host_stop' is
-- the admitted stop template. 'tree_path'/'tree_agent_id': the remote worktree a
-- --worktree spawn prepared for it (path on 'host', and the placeholder incarnation a
-- recovery record would carry); a close with no agent row releases the reservation
-- only once THAT tree's close succeeded. 'workstream_id': the id of the workstream the
-- bound agent row lived in, stamped at finalize's bind (NULL before, or on a reservation
-- older than the column); a reattach refuses unless it is the live workstream's id.
-- Plugins spec D5: a job record of any kind. 'kind' (NULL: lease), 'plugin' and
-- 'instance' (the stop fence of a plugin job, whose 'host_stop' is NULL), 'host_id' (a
-- provider host's record), 'tree_base' and 'collect_repo' (its tree's base, the local
-- repo collects fetch into), the final-collect flag and its generation (D10), and an
-- at-start kind's first delivery ('first_msg_id', 'first_inc': D8).
CREATE TABLE IF NOT EXISTS carrier_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,
  workstream    TEXT NOT NULL,
  name          TEXT NOT NULL,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  host          TEXT NOT NULL,
  host_stop     TEXT,                          -- NULL only for a plugin job (its fence is 'instance')
  launch        TEXT NOT NULL DEFAULT 'none' CHECK (launch IN ('none', 'intent')),
  creator_pid   INTEGER,
  creator_start TEXT,
  agent_id      INTEGER,
  pane_id       TEXT,
  job           TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  recorded_at   TEXT,
  tree_path     TEXT,
  tree_agent_id INTEGER,
  workstream_id INTEGER,
  kind          TEXT,
  plugin        TEXT,
  instance      TEXT,
  host_id       INTEGER,
  tree_base     TEXT,
  collect_repo  TEXT,
  final_owed    INTEGER NOT NULL DEFAULT 0,
  stop_gen      INTEGER,
  collect_next_at INTEGER,
  first_msg_id  TEXT,
  first_inc     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_carrier_jobs_name ON carrier_jobs (workstream, name, ordinal);
`;

/** carrier_jobs with `host_stop NOT NULL`, from before plugin jobs: rebuilt, rows kept (plugins spec D5). */
export function carrierJobsStopRequired(db: Db): boolean {
  const row = db
    .prepare(
      "SELECT \"notnull\" AS nn FROM pragma_table_info('carrier_jobs') WHERE name = 'host_stop'",
    )
    .get() as { nn: number } | undefined;
  return row?.nn === 1;
}

/** A carrier_jobs table from before reservations: keyed by agent id, no spawn token. */
export function carrierJobsPreReservation(db: Db): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'carrier_jobs'")
      .get() !== undefined &&
    db.prepare("SELECT 1 FROM pragma_table_info('carrier_jobs') WHERE name = 'token'").get() ===
      undefined
  );
}

/**
 * Every pre-reservation row becomes a FILLED reservation: a generated token, launch
 * 'intent' (its carrier ran), its job, host_stop, agent_id and recorded_at kept. Rows
 * of one (workstream, name) keep their order, newest incarnation first (ordinal 0).
 */
export const CARRIER_JOBS_REBUILD = `INSERT INTO carrier_jobs
  (token, workstream, name, ordinal, host, host_stop, launch, agent_id, job, created_at, recorded_at)
  SELECT lower(hex(randomblob(16))), COALESCE(workstream, ''), COALESCE(name, ''),
         ROW_NUMBER() OVER (PARTITION BY workstream, name ORDER BY agent_id DESC) - 1,
         COALESCE(host, ''), host_stop, 'intent', agent_id, job,
         COALESCE(recorded_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), recorded_at
  FROM carrier_jobs_pre_reservation ORDER BY agent_id`;
