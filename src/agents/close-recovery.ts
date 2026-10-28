// mu — `agent close` of a remote worktree whose agent row is gone (v_remote_recovery_close).
//
// The reaper, a teardown or a workstream deletion removed the row but kept
// what it said about the worktree (`remote_recovery`, src/remote-recovery.ts).
// This closes THAT: no agent comes back, no pane is opened or killed, no task
// is touched. It reuses `closeRemoteWorktree` whole (quiescence, the common
// git dir check, clean + known-HEAD or create-only keep-branch, no --force,
// dirty refuses under every flag) with the ORIGINAL incarnation, so the aside
// it resumes from is the one the first, crashed attempt parked the tree at.
//
// The record is checked again after every slow step (compare-and-set on all
// of it, plus the live registry and the profile): before the removal, and at
// the final delete, which removes only this record and only when the tree is
// removed, kept on a branch or gone. Every refusal and error keeps it.
// Runs under the agent lock `closeAgent` took.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { asideOf, closeRemoteWorktree, localPaneAlive } from "../remote-agent.js";
import {
  assertRecoveryProfile,
  assertRecoveryUnchanged,
  assertRecoveryUsable,
  deleteRemoteRecovery,
  type RemoteRecovery,
  RemoteRecoveryRefusedError,
} from "../remote-recovery.js";
import type { CloseAgentResult, ClosePreview } from "./close.js";

/** Why a close of `rec` would refuse right now, from the registry and the profile alone (no host command); null when it would go on. */
export function recoveryRefusal(db: Db, rec: RemoteRecovery): string | null {
  try {
    assertRecoveryUsable(db, rec);
    return null;
  } catch (err) {
    if (err instanceof RemoteRecoveryRefusedError) return err.message;
    throw err;
  }
}

/** The preview fields of a recovery: read only. */
export function recoveryPreview(
  db: Db,
  rec: RemoteRecovery,
): Pick<ClosePreview, "remote" | "recovery"> {
  return {
    remote: { host: rec.host, path: rec.cwd, base: rec.base, collectedHead: rec.collectedHead },
    recovery: {
      id: rec.agentId,
      aside: rec.aside,
      reason: rec.reason,
      preservedAt: rec.preservedAt,
      refusal: recoveryRefusal(db, rec),
    },
  };
}

/** Apply a close to the selected record. The caller holds the agent lock and has passed the revision fence. */
export async function closeRecovery(
  db: Db,
  rec: RemoteRecovery,
  opts: { keepBranch: boolean; force?: boolean },
): Promise<CloseAgentResult> {
  if (rec.aside !== asideOf(rec.cwd, rec.agentId)) {
    throw new RemoteRecoveryRefusedError(
      rec.workstream,
      rec.name,
      "changed",
      `recovery ${rec.agentId} names an aside that is not its own (${rec.aside}); refusing to guess`,
      [rec.agentId],
    );
  }
  assertRecoveryUsable(db, rec);
  const worktree = await closeRemoteWorktree(
    db,
    {
      name: rec.name,
      workstreamName: rec.workstream,
      host: rec.host,
      cwd: rec.cwd,
      base: rec.base,
      collectedHead: rec.collectedHead,
      repo: rec.hostRepo,
      // The ORIGINAL registry incarnation: the aside path derives from it.
      incarnation: rec.agentId,
    },
    {
      keepBranch: opts.keepBranch,
      force: opts.force === true,
      paneAlive: localPaneAlive,
      recoveryId: rec.agentId,
      checkProfile: (profile) => assertRecoveryProfile(rec, profile),
      beforeRemove: () => {
        assertRecoveryUnchanged(db, rec);
        assertRecoveryUsable(db, rec);
      },
    },
  );
  // The tree is removed, kept on a branch or gone; only now does the record go,
  // and only this one, as read.
  const deleted = deleteRemoteRecovery(db, rec);
  if (!deleted) assertRecoveryUnchanged(db, rec);
  const bits = [`recovery ${rec.agentId}`, `worktree ${worktree.action}`];
  if (worktree.branch !== undefined) bits.push(`as ${worktree.branch}`);
  emitEvent(db, rec.workstream, "agent.close", `agent close ${rec.name} (${bits.join(", ")})`);
  return {
    killedPane: false,
    deletedRow: false,
    worktree,
    recovery: { id: rec.agentId, deleted },
  };
}
