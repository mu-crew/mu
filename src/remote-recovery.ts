// mu — remote recovery: what a deleted remote worker row said about its worktree.
//
// A remote agent's row is the only record of where its worktree lives (host,
// path, base, last collected HEAD). The row dies when its pane is reaped,
// its workstream is torn down, or a peer's tombstone cascades it away, and
// with it the way to find the tree. Every such deleter calls a snapshot
// function below INSIDE its own transaction, so the record and the deletion
// commit or roll back together.
//
// One row per ORIGINAL registry incarnation (`agent_id` = `agents.id`, never
// reused): a name or workstream created again later is a different record,
// and the exact aside path `closeRemoteWorktree` parks a tree at is derived
// from that id, so it is stored, never recomputed from a new one. The table
// has NO foreign key and no op: machine-local, never synced, rebuilt by
// nothing (src/rebuild.ts reports it lost). Only FINALIZED rows (host, path
// and base all recorded) are an owned worktree; anything else leaves nothing.
//
// This module is storage only. Reading a record back to close or collect the
// tree is a separate step; nothing here touches a host.

import type { Db } from "./db.js";
import { asideOf } from "./remote-agent.js";

/** Why the row went away. */
export type RemoteRecoveryReason = "reap" | "teardown" | "workstream-delete";

export interface RemoteRecovery {
  /** The ORIGINAL registry incarnation (`agents.id`). */
  agentId: number;
  workstream: string;
  /** With `workstreamCreatedAt`: which generation of the name the agent lived in. */
  workstreamId: number;
  workstreamCreatedAt: string;
  name: string;
  paneId: string;
  host: string;
  /** The worktree path on the host. */
  cwd: string;
  base: string;
  collectedHead: string | null;
  /** The exact path a crashed close left (or would leave) the tree at. */
  aside: string;
  /** The profile's exec template and repo when it existed, else null: identity, not authority. */
  hostExec: string | null;
  hostRepo: string | null;
  reason: RemoteRecoveryReason;
  preservedAt: string;
}

interface RawRow {
  agent_id: number;
  workstream: string;
  workstream_id: number;
  workstream_created_at: string;
  name: string;
  pane_id: string;
  host: string;
  cwd: string;
  base: string;
  collected_head: string | null;
  aside: string;
  host_exec: string | null;
  host_repo: string | null;
  reason: RemoteRecoveryReason;
  preserved_at: string;
}

/** The agent rows that own a remote worktree, ready to insert. */
const SELECT_OWNED = `
  SELECT a.id AS id, ws.name AS workstream, ws.id AS workstream_id,
         ws.created_at AS workstream_created_at, a.name AS name, a.pane_id AS pane_id,
         a.host AS host, a.cwd AS cwd, a.base AS base, a.collected_head AS collected_head,
         h.exec AS host_exec, h.repo AS host_repo
    FROM agents a
    JOIN workstreams ws ON ws.id = a.workstream_id
    LEFT JOIN host_profiles h ON h.name = a.host
   WHERE a.host IS NOT NULL AND a.cwd IS NOT NULL AND a.cwd <> ''
     AND a.base IS NOT NULL AND a.base <> ''`;

interface OwnedRow {
  id: number;
  workstream: string;
  workstream_id: number;
  workstream_created_at: string;
  name: string;
  pane_id: string;
  host: string;
  cwd: string;
  base: string;
  collected_head: string | null;
  host_exec: string | null;
  host_repo: string | null;
}

function insertRecord(db: Db, r: OwnedRow, reason: RemoteRecoveryReason, at: string): boolean {
  return (
    db
      .prepare(
        `INSERT OR IGNORE INTO remote_recovery
           (agent_id, workstream, workstream_id, workstream_created_at, name, pane_id, host, cwd,
            base, collected_head, aside, host_exec, host_repo, reason, preserved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.workstream,
        r.workstream_id,
        r.workstream_created_at,
        r.name,
        r.pane_id,
        r.host,
        r.cwd,
        r.base,
        r.collected_head,
        asideOf(r.cwd, r.id),
        r.host_exec,
        r.host_repo,
        reason,
        at,
      ).changes > 0
  );
}

/**
 * Record the remote worktree of agent row `agentId`, if it owns one. Call it
 * in the transaction that deletes the row, BEFORE the delete. Idempotent per
 * incarnation. True when a record was written.
 */
export function snapshotRemoteAgent(
  db: Db,
  agentId: number,
  reason: RemoteRecoveryReason,
): boolean {
  const row = db.prepare(`${SELECT_OWNED} AND a.id = ?`).get(agentId) as OwnedRow | undefined;
  return row !== undefined && insertRecord(db, row, reason, new Date().toISOString());
}

/**
 * Record every remote worktree owned by the agents of workstream `workstreamId`
 * (a delete of the workstream cascades them away). Same transaction rule.
 * Returns how many records were written.
 */
export function snapshotWorkstreamRemotes(
  db: Db,
  workstreamId: number,
  reason: RemoteRecoveryReason,
): number {
  const at = new Date().toISOString();
  const rows = db
    .prepare(`${SELECT_OWNED} AND a.workstream_id = ? ORDER BY a.id`)
    .all(workstreamId) as OwnedRow[];
  let n = 0;
  for (const r of rows) if (insertRecord(db, r, reason, at)) n += 1;
  return n;
}

/** Every record, oldest incarnation first. */
export function listRemoteRecoveries(db: Db): RemoteRecovery[] {
  const rows = db.prepare("SELECT * FROM remote_recovery ORDER BY agent_id").all() as RawRow[];
  return rows.map((r) => ({
    agentId: r.agent_id,
    workstream: r.workstream,
    workstreamId: r.workstream_id,
    workstreamCreatedAt: r.workstream_created_at,
    name: r.name,
    paneId: r.pane_id,
    host: r.host,
    cwd: r.cwd,
    base: r.base,
    collectedHead: r.collected_head,
    aside: r.aside,
    hostExec: r.host_exec,
    hostRepo: r.host_repo,
    reason: r.reason,
    preservedAt: r.preserved_at,
  }));
}
