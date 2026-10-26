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
// Selection and the guards a close or collect passes before it touches the
// tree live here too (src/agents/close-recovery.ts, src/remote-collect.ts use
// them); nothing here runs a host command.

import type { Db } from "./db.js";
import { say } from "./messages.js";

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

// ─── Selection: which record a close or collect means ───────────────────────

/** A recovery operation refused: nothing was changed on the host or in the record. Exit 4. */
export class RemoteRecoveryRefusedError extends Error {
  override readonly name = "RemoteRecoveryRefusedError";
  constructor(
    public readonly workstream: string,
    public readonly agentName: string,
    public readonly reason:
      | "ambiguous"
      | "mismatch"
      | "gone"
      | "live-agent"
      | "resource-in-use"
      | "profile"
      | "changed"
      | "pin",
    detail: string,
    /** The record ids the refusal is about (every candidate, or the one that moved). */
    public readonly candidates: readonly number[] = [],
  ) {
    super(say("remote.recovery_refused", workstream, agentName, detail));
  }
}

const rowToRecovery = (r: RawRow): RemoteRecovery => ({
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
});

/** Every record, oldest incarnation first. */
export function listRemoteRecoveries(db: Db): RemoteRecovery[] {
  const rows = db.prepare("SELECT * FROM remote_recovery ORDER BY agent_id").all() as RawRow[];
  return rows.map(rowToRecovery);
}

/** The record of ORIGINAL incarnation `agentId`, or undefined. */
export function getRemoteRecovery(db: Db, agentId: number): RemoteRecovery | undefined {
  const r = db.prepare("SELECT * FROM remote_recovery WHERE agent_id = ?").get(agentId) as
    | RawRow
    | undefined;
  return r === undefined ? undefined : rowToRecovery(r);
}

/** Every record of workstream NAME `workstream` and agent `name`, oldest incarnation first. */
export function recoveriesFor(db: Db, workstream: string, name: string): RemoteRecovery[] {
  const rows = db
    .prepare("SELECT * FROM remote_recovery WHERE workstream = ? AND name = ? ORDER BY agent_id")
    .all(workstream, name) as RawRow[];
  return rows.map(rowToRecovery);
}

/** The workstream names holding a record for agent `name` (the workstream may be gone). */
export function recoveryWorkstreams(db: Db, name: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT workstream FROM remote_recovery WHERE name = ? ORDER BY workstream")
    .all(name) as { workstream: string }[];
  return rows.map((r) => r.workstream);
}

/**
 * The record `<workstream>/<name>` means. An explicit `recoveryId` must be a
 * record of that very name (`mismatch` otherwise) and is undefined once
 * removed: the caller decides (a retried close is a no-op; a collect refuses
 * with `recoveryGone`, never falling through to a live agent). Without it exactly ONE record
 * selects itself; several refuse (`ambiguous`) and list their ids, never the
 * newest one. Read only.
 */
export function selectRemoteRecovery(
  db: Db,
  workstream: string,
  name: string,
  recoveryId?: number,
): RemoteRecovery | undefined {
  if (recoveryId !== undefined) {
    const rec = getRemoteRecovery(db, recoveryId);
    if (rec === undefined) return undefined;
    if (rec.workstream !== workstream || rec.name !== name) {
      throw new RemoteRecoveryRefusedError(
        workstream,
        name,
        "mismatch",
        `recovery ${recoveryId} belongs to ${rec.workstream}/${rec.name}`,
        [recoveryId],
      );
    }
    return rec;
  }
  const all = recoveriesFor(db, workstream, name);
  if (all.length <= 1) return all[0];
  const ids = all.map((r) => r.agentId);
  throw new RemoteRecoveryRefusedError(
    workstream,
    name,
    "ambiguous",
    `${all.length} removed agents of that name left a worktree (recoveries ${ids.join(", ")}); pass --recovery <id>`,
    ids,
  );
}

/** An explicit `--recovery <id>` that is no longer there: refused, never read as "no recovery asked". */
export const recoveryGone = (
  workstream: string,
  name: string,
  recoveryId: number,
): RemoteRecoveryRefusedError =>
  new RemoteRecoveryRefusedError(
    workstream,
    name,
    "gone",
    `recovery ${recoveryId} is gone (closed or never recorded); nothing was collected`,
  );

// ─── Guards ─────────────────────────────────────────────────────────────────

/** The profile at the time of use must be the one the record pinned. Missing provenance refuses. */
export function assertRecoveryProfile(
  rec: RemoteRecovery,
  profile: { exec: string; repo: string } | undefined,
): void {
  const refuse = (detail: string): never => {
    throw new RemoteRecoveryRefusedError(rec.workstream, rec.name, "profile", detail, [
      rec.agentId,
    ]);
  };
  if (profile === undefined) refuse(`host ${rec.host} has no profile now`);
  if (rec.hostExec === null || rec.hostRepo === null) {
    refuse(
      `host ${rec.host} had no profile when the agent was removed: nothing proves the profile now named ${rec.host} reaches that worktree`,
    );
  }
  if (profile?.exec !== rec.hostExec || profile.repo !== rec.hostRepo) {
    refuse(`host ${rec.host}'s profile changed since the agent was removed (exec or repo differs)`);
  }
}

/**
 * Refuse unless nothing else claims what the record names: no current agent
 * of that name, no current agent on the same host and path, no NEWER record
 * of the same host and path (a name reused after its tree went away is
 * deterministically the same path: the newest record owns the tree, an older
 * one must not act on it), and the host's profile is the pinned one. Read only; run before any remote command and
 * again before the removal.
 */
export function assertRecoveryUsable(db: Db, rec: RemoteRecovery): void {
  const live = db
    .prepare(
      `SELECT ws.name AS workstream, a.name AS name FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
        WHERE (ws.name = ? AND a.name = ?) OR (a.host = ? AND a.cwd = ?)`,
    )
    .all(rec.workstream, rec.name, rec.host, rec.cwd) as { workstream: string; name: string }[];
  const same = live.find((a) => a.workstream === rec.workstream && a.name === rec.name);
  if (same !== undefined) {
    throw new RemoteRecoveryRefusedError(
      rec.workstream,
      rec.name,
      "live-agent",
      `a current agent holds the name; close it first, or recover after it is gone`,
      [rec.agentId],
    );
  }
  const other = live[0];
  if (other !== undefined) {
    throw new RemoteRecoveryRefusedError(
      rec.workstream,
      rec.name,
      "resource-in-use",
      `current agent ${other.workstream}/${other.name} uses ${rec.cwd} on ${rec.host}`,
      [rec.agentId],
    );
  }
  const newer = db
    .prepare(
      "SELECT agent_id FROM remote_recovery WHERE host = ? AND cwd = ? AND agent_id > ? ORDER BY agent_id DESC LIMIT 1",
    )
    .get(rec.host, rec.cwd, rec.agentId) as { agent_id: number } | undefined;
  if (newer !== undefined) {
    throw new RemoteRecoveryRefusedError(
      rec.workstream,
      rec.name,
      "resource-in-use",
      `newer recovery ${newer.agent_id} owns ${rec.cwd} on ${rec.host}; deal with it first`,
      [rec.agentId, newer.agent_id],
    );
  }
  assertRecoveryProfile(
    rec,
    db.prepare("SELECT exec, repo FROM host_profiles WHERE name = ?").get(rec.host) as
      | { exec: string; repo: string }
      | undefined,
  );
}

/** Refuse (`changed`) unless the record is exactly `rec`: the CAS after every slow step. */
export function assertRecoveryUnchanged(db: Db, rec: RemoteRecovery): void {
  if (JSON.stringify(getRemoteRecovery(db, rec.agentId)) === JSON.stringify(rec)) return;
  throw new RemoteRecoveryRefusedError(
    rec.workstream,
    rec.name,
    "changed",
    `recovery ${rec.agentId} changed or went away while it was being used; preview it again`,
    [rec.agentId],
  );
}

const SAME =
  "agent_id = ? AND host = ? AND cwd = ? AND base = ? AND aside = ? AND collected_head IS ?";
const sameArgs = (r: RemoteRecovery): (string | number | null)[] => [
  r.agentId,
  r.host,
  r.cwd,
  r.base,
  r.aside,
  r.collectedHead,
];

/** Delete exactly this record (compare-and-set on its identity and content). False when it is not there as read. */
export function deleteRemoteRecovery(db: Db, rec: RemoteRecovery): boolean {
  return (
    db.prepare(`DELETE FROM remote_recovery WHERE ${SAME}`).run(...sameArgs(rec)).changes === 1
  );
}

/** Record a collected HEAD on exactly this record (compare-and-set). False when it moved. */
export function setRecoveryCollectedHead(db: Db, rec: RemoteRecovery, head: string): boolean {
  return (
    db
      .prepare(`UPDATE remote_recovery SET collected_head = ? WHERE ${SAME}`)
      .run(head, ...sameArgs(rec)).changes === 1
  );
}

/** True when exactly this record is still there (the fence of a collect that wrote nothing). */
export function recoveryHolds(db: Db, rec: RemoteRecovery): boolean {
  return (
    db.prepare(`SELECT 1 FROM remote_recovery WHERE ${SAME}`).all(...sameArgs(rec)).length === 1
  );
}

/** Ids of the OTHER records of this name whose last collected commit is `commit` (a pin they rely on). */
export function pinnedByOthers(
  db: Db,
  rec: { workstream: string; name: string; agentId: number },
  commit: string,
): number[] {
  const rows = db
    .prepare(
      "SELECT agent_id FROM remote_recovery WHERE workstream = ? AND name = ? AND agent_id <> ? AND collected_head = ? ORDER BY agent_id",
    )
    .all(rec.workstream, rec.name, rec.agentId, commit) as { agent_id: number }[];
  return rows.map((r) => r.agent_id);
}
