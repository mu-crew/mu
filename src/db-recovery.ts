// mu — the DDL of `remote_recovery`: a table and the two triggers that fill it.
//
// A finalized remote worker's agent row (host, worktree path and base all
// recorded) is the only record of where its worktree lives. THE DATABASE
// keeps what the row said, not the code that deletes it: an AFTER DELETE
// trigger on `agents` writes the record from OLD.*, so it fires for every
// deleter: the reaper, teardown, `mu sql DELETE FROM agents`, and the
// `agents.workstream_id` CASCADE of a workstream delete (a peer's tombstone,
// reinit, `mu sql DELETE FROM workstreams`). The record lives in the deleter's
// transaction: a rollback takes it back.
//
// A cascade deletes the parent first, so the agent trigger can no longer read
// the workstream's name: a BEFORE DELETE trigger on `workstreams` records its
// agents while the parent is still there, and the agent trigger then finds
// the record already written (INSERT OR IGNORE, keyed by incarnation).
//
// One row per ORIGINAL registry incarnation (`agent_id` = `agents.id`, never
// reused): a name or workstream created again later is a different record.
// `aside` is the exact path `closeRemoteWorktree` parks the tree at,
// `<cwd>.mu-removing-<agent_id>` (asideOf, src/remote-agent.ts; a test pins
// the two together). No foreign key and no op: machine-local, never synced,
// rebuilt by nothing (src/rebuild.ts reports it lost). Local rows (no host)
// and unfinalized ones leave nothing. This file is DDL only; the reader is
// src/remote-recovery.ts. It imports nothing: db.ts splices it into
// CURRENT_SCHEMA.

/** Which deleter, as far as the op context says: a teardown, else the agent row was simply deleted. */
const REASON = `CASE COALESCE((SELECT intent FROM op_ctx WHERE id = 1), '')
         WHEN 'workstream.teardown' THEN 'teardown'
         ELSE 'reap' END`;

/** Agent columns that make a row an owned remote worktree (`a` is the row's alias, or OLD). */
const OWNED = (a: string): string =>
  `${a}.host IS NOT NULL AND ${a}.cwd IS NOT NULL AND ${a}.cwd <> ''
       AND ${a}.base IS NOT NULL AND ${a}.base <> ''`;

const COLUMNS = `agent_id, workstream, workstream_id, workstream_created_at, name, pane_id, host, cwd,
       base, collected_head, aside, host_exec, host_repo, reason, preserved_at`;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const REMOTE_RECOVERY_DDL = `
-- remote_recovery: what a finalized remote worker row said about its
-- worktree, written by triggers when the row is deleted (machine-local; see
-- src/db-recovery.ts). No foreign key on purpose: it must outlive the agent,
-- its workstream and its host profile. host_exec / host_repo pin the
-- profile's identity when the profile existed. A receipt of the resource,
-- not a live channel.
CREATE TABLE IF NOT EXISTS remote_recovery (
  agent_id             INTEGER PRIMARY KEY,
  workstream           TEXT NOT NULL,
  workstream_id        INTEGER NOT NULL,
  workstream_created_at TEXT NOT NULL,
  name                 TEXT NOT NULL,
  pane_id              TEXT NOT NULL,
  host                 TEXT NOT NULL,
  cwd                  TEXT NOT NULL,
  base                 TEXT NOT NULL,
  collected_head       TEXT,
  aside                TEXT NOT NULL,
  host_exec            TEXT,
  host_repo            TEXT,
  reason               TEXT NOT NULL CHECK (reason IN ('reap', 'teardown', 'workstream-delete')),
  preserved_at         TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS remote_recovery_agent_del
AFTER DELETE ON agents
WHEN ${OWNED("OLD")}
  AND EXISTS (SELECT 1 FROM workstreams WHERE id = OLD.workstream_id)
BEGIN
  INSERT OR IGNORE INTO remote_recovery (${COLUMNS})
  SELECT OLD.id, ws.name, ws.id, ws.created_at, OLD.name, OLD.pane_id, OLD.host, OLD.cwd,
         OLD.base, OLD.collected_head, OLD.cwd || '.mu-removing-' || OLD.id,
         (SELECT exec FROM host_profiles WHERE name = OLD.host),
         (SELECT repo FROM host_profiles WHERE name = OLD.host),
         ${REASON}, ${NOW}
    FROM workstreams ws WHERE ws.id = OLD.workstream_id;
END;

CREATE TRIGGER IF NOT EXISTS remote_recovery_workstream_del
BEFORE DELETE ON workstreams
BEGIN
  INSERT OR IGNORE INTO remote_recovery (${COLUMNS})
  SELECT a.id, OLD.name, OLD.id, OLD.created_at, a.name, a.pane_id, a.host, a.cwd,
         a.base, a.collected_head, a.cwd || '.mu-removing-' || a.id,
         (SELECT exec FROM host_profiles WHERE name = a.host),
         (SELECT repo FROM host_profiles WHERE name = a.host),
         'workstream-delete', ${NOW}
    FROM agents a
   WHERE a.workstream_id = OLD.id AND ${OWNED("a")};
END;
`;
