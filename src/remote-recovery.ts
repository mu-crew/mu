// mu — remote recovery: what a deleted remote worker row said about its worktree.
//
// A remote agent's row is the only record of where its worktree lives (host,
// path, base, last collected HEAD). The row dies when its pane is reaped,
// its workstream is torn down, a peer's tombstone cascades it away, or
// someone runs SQL. THE DATABASE writes the record: an AFTER DELETE trigger
// on `agents` (and a BEFORE DELETE one on `workstreams` for the cascade),
// defined in src/db-recovery.ts, so no deleter can forget and a rolled-back
// delete rolls the record back too. This module is the reader.
//
// One row per ORIGINAL registry incarnation (`agent_id` = `agents.id`, never
// reused): a name or workstream created again later is a different record,
// and the exact aside path `closeRemoteWorktree` parks a tree at is derived
// from that id, so it is stored, never recomputed from a new one. The table
// has NO foreign key and no op: machine-local, never synced, rebuilt by
// nothing (src/rebuild.ts reports it lost). Only FINALIZED rows (host, path
// and base all recorded) are an owned worktree; anything else leaves nothing.
//
// Reading a record back to close or collect the tree is a separate step;
// nothing here touches a host.

import type { Db } from "./db.js";

/** Why the row went away: `reap` (any plain delete), a `teardown`, or its workstream's deletion. */
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
