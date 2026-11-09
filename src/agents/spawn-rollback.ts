// mu — rollbackSpawn: undo a failed spawn (pane, host channel, lease job, worktree, row,
// reservation), best-effort and idempotent. Split from spawn.ts (file cap); re-exported
// there, so imports of agents/spawn.js keep working. Imports only types from spawn.ts.

import { deleteAgent, getAgent } from "../agents.js";
import { getCarrierJobByAgent, keepCarrierJobForTree, noteCarrierJob } from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { type HostLease, releaseHostChannel, releaseHostChannelsForAgent } from "../hosts.js";
import { viewPresent } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import { activeMux } from "../mux.js";
import { getWorktreeAt, releaseWorktree } from "../worktree.js";
import { type LeaseRollback, releaseLeaseReservation, rollbackLeaseJob } from "./lease-carrier.js";
import { withAgentLock } from "./lock.js";
import type { StagedWorktree } from "./spawn.js";
import { rollbackRemoteWorktree } from "./spawn-remote.js";

function reservationOf(db: Db, incarnation: number | undefined): { token: string } | undefined {
  if (incarnation === undefined) return undefined;
  const r = getCarrierJobByAgent(db, incarnation);
  return r === undefined ? undefined : { token: r.token };
}

/**
 * Roll back a failed spawn. Idempotent and best-effort: every step
 * swallows its own errors so a partial-cleanup substrate (already-killed
 * pane, no agent row) never masks the original failure.
 *
 * `paneId` is `undefined` when spawnAgent itself threw before returning a
 * pane id — there's nothing to kill. `staged` is set when prestageWorktree
 * succeeded: once the pane is proven gone, the worktree this spawn made goes
 * through the close rule (`releaseWorktree`; its pane may have worked in it):
 * clean and merged is removed, commits are kept on `mu/<ws>/<name>-<sha12>`
 * first, and dirty files or a writer keep the tree and its registry row for
 * `mu agent close <name>`; each outcome but the plain removal is logged. A pane NOT proven gone
 * keeps the row and the worktree (the row rule): `mu agent close` finishes
 * them once it is. deleteAgent is idempotent (no-op on a missing row).
 *
 * `ownedIncarnation` is undefined when the spawn failed before inserting
 * its own row (e.g. it lost a same-name race); the row then belongs to
 * another agent and is left alone. Otherwise only that incarnation is
 * deleted, never a replacement under the same name.
 *
 * Returns whether the pane is proven gone (no pane counts as gone), or which agent's row
 * now holds its id (left alone: not proven gone).
 */
export async function rollbackSpawn(
  db: Db,
  name: string,
  paneId: string | undefined,
  staged: StagedWorktree | undefined,
  ownedIncarnation: number | undefined,
  workstream: string,
  /** The spawn's host channel lease, while it is still the reservation (before or after its bind). */
  lease?: HostLease,
  /** A lease spawn's carrier_jobs reservation: the only job this rollback may stop or release. */
  carrier?: { token: string },
): Promise<{ gone: boolean; heldBy?: string }> {
  // Is the pane (the host transport) proven gone? A channel is freed only on that proof.
  let paneGone = paneId === undefined;
  let heldBy: string | undefined;
  if (paneId !== undefined) {
    // Best-effort: rollback runs on an already-failing path and must not
    // mask the original error, even if the mux itself went away.
    const mux = await activeMux().catch(() => undefined);
    // The mux is in hand before the check, and the kill is issued in the
    // same step: a row of another incarnation on this very pane id (a
    // replacement that reused it) means the pane is no longer ours.
    // A pane id registered to ANY other incarnation (any name, any
    // workstream) is not ours either: leave it alone and say so.
    const foreign = db
      .prepare(
        "SELECT ws.name || '/' || a.name AS who FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.pane_id = ? AND a.id IS NOT ? LIMIT 1",
      )
      .get(paneId, ownedIncarnation ?? null) as { who: string } | undefined;
    heldBy = foreign?.who;
    if (foreign === undefined) {
      await mux?.killPane(paneId).catch(() => {});
      paneGone = mux !== undefined && (await viewPresent(paneId, mux).catch(() => true)) === false;
    } else {
      paneGone = true; // another agent holds the id: ours is not that pane

      try {
        emitEvent(
          db,
          workstream,
          "agent.spawn_failed",
          `agent spawn rollback ${name}: pane ${paneId} now belongs to another agent, left alone`,
        );
      } catch {
        // best-effort
      }
    }
  }
  if (paneGone) {
    try {
      if (lease !== undefined) releaseHostChannel(db, lease);
      if (paneId !== undefined && ownedIncarnation !== undefined) {
        releaseHostChannelsForAgent(db, ownedIncarnation, paneId);
      }
    } catch {
      // best-effort: the next admission reclaims a channel whose pane is dead
    }
  }
  // A lease job is stopped (its handle filled into the spawn's own reservation first)
  // before its tree is touched; one not stopped, or not known, keeps the reservation
  // and the tree (and its recovery record) for `mu agent close`.
  // A caller without the token (task-spawn's rollback of a finished spawn) finds the
  // reservation bound to the incarnation it owns: never another one's.
  carrier ??= reservationOf(db, ownedIncarnation);
  const job: LeaseRollback | undefined = carrier
    ? await rollbackLeaseJob(db, { workstream, name, token: carrier.token }, paneGone)
    : undefined;
  // The remote tree this rollback proved gone: the row's delete then owes no recovery record.
  let remoteGone = false;
  if (staged?.host !== undefined) {
    if (job !== "kept")
      remoteGone = await rollbackRemoteWorktree(db, name, workstream, staged, paneGone);
  } else if (staged !== undefined && paneGone) {
    // Only once the pane is proven gone: a surviving pane may be running in
    // the tree (the row is kept below, so `mu agent close` finishes it).
    // The worker may have worked before the spawn failed: the tree goes
    // through the close rule, never a forced removal. Commits are kept on a
    // branch first; dirty files or a writer keep the tree and its registry
    // row (the record `mu agent close` finishes).
    const say = (what: string): void => {
      try {
        emitEvent(db, workstream, "agent.spawn_failed", `agent spawn rollback ${name}: ${what}`);
      } catch {
        // best-effort
      }
    };
    try {
      // Under the agent lock, and only while the name is still this spawn's
      // (or gone) AND the registry row at the path is the one this spawn
      // wrote: a replacement staged there, or a newer orphan, owns it now.
      await withAgentLock(db, workstream, name, async () => {
        const cur = getAgent(db, name, workstream);
        if (cur !== undefined && cur.incarnation !== staged.incarnation) return;
        const reg = getWorktreeAt(db, staged.path);
        if (reg !== undefined && (reg.createdAt !== staged.createdAt || reg.base !== staged.base))
          return;
        const done = await releaseWorktree(
          db,
          reg ?? { ...staged, agent: name, workstream, lastCollectedHead: null },
        );
        if (done.action === "kept-branch")
          say(`worktree ${staged.path} had commits; kept on branch ${done.branch}, tree removed`);
        for (const w of done.warnings ?? []) say(w);
      });
    } catch (err) {
      const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      say(
        `worktree ${staged.path} kept (${why}); once handled: mu agent close ${name} -w ${workstream}`,
      );
    }
  }
  // A row whose pane is not proven gone is kept (the row rule, as in close),
  // with its worktree: the pane may still run in it. A host row's death would
  // also free the channel the live pane (the transport) holds.
  if (ownedIncarnation !== undefined && !paneGone) {
    // The reservation is kept too (rollbackLeaseJob returned "kept" for a launched one).
    try {
      emitEvent(
        db,
        workstream,
        "agent.spawn_failed",
        `agent spawn rollback ${name}: pane ${paneId} not proven gone, row${staged === undefined ? "" : " and worktree"}${getAgent(db, name, workstream)?.host ? " and host channel" : ""} kept; once it is gone: mu agent close ${name} -w ${workstream}`,
      );
    } catch {
      // best-effort
    }
    return heldBy === undefined ? { gone: paneGone } : { gone: false, heldBy };
  }
  // Only the row this spawn inserted: never a replacement under the name. A remote
  // tree this rollback removed (or found gone) leaves no `remote_recovery` record:
  // the record is for a worktree someone must still deal with.
  if (ownedIncarnation !== undefined)
    deleteAgent(db, name, workstream, { incarnation: ownedIncarnation }, { preserve: !remoteGone });
  // Last: the reservation goes only once nothing was launched, or its job is stopped and
  // its job file and tree are dealt with. Until then the name stays fenced.
  // A stopped job whose remote tree was not removed keeps its reservation: the close
  // that finishes the tree releases it.
  // Never launched is no exception: a prepared remote tree whose removal failed keeps
  // the reservation, with the reason (the placeholder row recorded no path, so the
  // reservation is the tree's only pointer, and the name stays fenced).
  const treeDone = staged?.host === undefined || remoteGone;
  if (carrier && (job === "none" || job === "stopped")) {
    if (treeDone) releaseLeaseReservation(db, carrier.token, job);
    else keepForTree(db, carrier.token, staged);
  }
  return heldBy === undefined ? { gone: paneGone } : { gone: false, heldBy };
}

/** Record on a kept reservation WHICH remote tree its rollback did not remove. Never throws. */
function keepForTree(db: Db, token: string, staged: StagedWorktree | undefined): void {
  try {
    const reason = `remote worktree ${staged?.path ?? "?"} on ${staged?.host ?? "?"} was not removed`;
    if (staged === undefined) noteCarrierJob(db, token, reason);
    else
      keepCarrierJobForTree(db, token, { path: staged.path, agentId: staged.incarnation, reason });
  } catch {
    // best-effort: the kept reservation fences the name either way
  }
}
