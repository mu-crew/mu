// mu — stall actions of a wait: the guarded release (slice C1).
//
// The engine (wait.ts) DETECTS a stall and hands it to `handleStall`; this
// module is the policy and the effect. `releaseStall` frees the stalled
// task so another worker can take it; nothing else: it never closes the
// task, spawns, kills or steers (steer is `v_wait_steer`).
//
// Every guard is evaluated in the SAME immediate transaction as the write
// (`withOpContext` owns BEGIN IMMEDIATE), synchronously: no await sits inside,
// so permission, ownership and the revision cannot change between the check
// and the release. A refused release writes NOTHING (no op, no note, no
// receipt). A throw inside rolls the whole transaction back, so "refused" with
// the error is exact: nothing happened. The runtime state (`needs_input`) is
// the engine's observation at the stall; the revision fence is what proves the
// task did not move since.
//
// Eligible only when ALL hold: the aborted flag is clear; ctx.caller is in the
// caller set; its wait is still the registered generation (null = an
// unregistered explicit wait, which is NOT a bypass of the ownership checks);
// the task (by primary key, matching ctx.ref) is an IN_PROGRESS `work` task at
// the revision the stall saw, owned by the very agent row of ctx.owner (same
// registry id, name, workstream and pane) that one of the callers spawned; the
// owner needs attention (needs_input, or a broken ctl on a live pane; never a
// permission dialog, a dead pane or a busy run); `autoPermitted` (enabled
// task_auto, work, this host); and none of the callers has an open human stop.
// One release per (task, owner, ctl incarnation): a second is
// `budget-exhausted`, shared across callers, restarts and generations.

import type { Db } from "./db.js";
import { openHumanNeeds } from "./human-needed.js";
import { withOpContext } from "./op-context.js";
import { taskRevision } from "./revision.js";
import { autoPermitted } from "./task-auto.js";
import { releaseTask } from "./tasks/claim.js";
import {
  type ActionKey,
  getActionReceipt,
  reserveActionReceipt,
  transitionActionReceipt,
} from "./wait-action-receipts.js";
import { currentCallers } from "./wait-callers.js";
import { readWaitRegistration } from "./wait-registration.js";
import type { StallActionResult, WaitStallContext } from "./wait-types.js";

export interface StallActionOptions {
  /** The caller set of this process (default: `currentCallers()`). */
  callers?: readonly string[];
}

const refused = (reason: string): StallActionResult => ({
  disposition: "return",
  action: "release",
  state: "refused",
  reason,
});

interface TaskGuardRow {
  local_id: string;
  workstream: string;
  status: string;
  kind: string;
  owner_id: number | null;
}

interface AgentGuardRow {
  name: string;
  workstream: string;
  pane_id: string;
  spawner: string | null;
}

/** The release body: runs inside one immediate transaction. */
function releaseBody(db: Db, ctx: WaitStallContext, callers: readonly string[]): StallActionResult {
  if (ctx.signal.aborted) return refused("the wait was aborted");
  if (!callers.includes(ctx.caller)) {
    return refused(`caller ${ctx.caller} is not one of this process's callers`);
  }
  if (ctx.generation !== null) {
    const reg = readWaitRegistration(db, ctx.caller);
    if (reg === undefined || reg.generation !== ctx.generation) {
      return refused("the wait was superseded (generation changed)");
    }
  }
  const task = db
    .prepare(
      `SELECT t.local_id, w.name AS workstream, t.status, t.kind, t.owner_id
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE t.id = ?`,
    )
    .get(ctx.taskId) as TaskGuardRow | undefined;
  if (task === undefined) return refused("the task no longer exists");
  if (task.local_id !== ctx.ref.id || task.workstream !== ctx.ref.workstream) {
    return refused("the ref does not name this task");
  }
  if (task.kind !== "work") return refused(`a ${task.kind} task is never released`);
  if (task.status !== "IN_PROGRESS") return refused(`the task is ${task.status}, not IN_PROGRESS`);
  if (task.owner_id === null || task.owner_id !== ctx.owner.agentId) {
    return refused("the task's owner is no longer the stalled agent");
  }
  const agent = db
    .prepare(
      `SELECT a.name, w.name AS workstream, a.pane_id, a.spawner
         FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE a.id = ?`,
    )
    .get(task.owner_id) as AgentGuardRow | undefined;
  if (agent === undefined) return refused("the owner is no longer registered");
  if (
    agent.name !== ctx.owner.name ||
    agent.workstream !== ctx.owner.workstream ||
    agent.pane_id !== ctx.owner.paneId
  ) {
    return refused("the owner's name or pane changed (pane mismatch)");
  }
  if (agent.spawner === null || !callers.includes(agent.spawner)) {
    return refused("the owner was not spawned by this caller (not yours to release)");
  }
  const brokenCtl = ctx.owner.ctl === "missing" || ctx.owner.ctl === "refused";
  const needsAttention =
    ctx.owner.status === "needs_input" ||
    (brokenCtl && (ctx.owner.status === "unknown" || ctx.owner.status === "busy"));
  if (!needsAttention) {
    return refused(`the owner is not waiting on anyone (runtime state ${ctx.owner.status})`);
  }
  if (!autoPermitted(db, ctx.taskId)) {
    return refused("the task is not permitted for auto action on this machine (mu task auto)");
  }
  if (callers.some((c) => openHumanNeeds(db, c).length > 0)) {
    return refused("a human stop is open for this caller: leave the stall to the human");
  }
  const revision = taskRevision(db, task.workstream, task.local_id);
  if (revision !== ctx.revision) {
    return refused(
      `the task changed since the stall was seen (revision ${ctx.revision} -> ${revision})`,
    );
  }

  const key: ActionKey = {
    taskId: ctx.taskId,
    ownerId: task.owner_id,
    incarnation: ctx.owner.incarnation ?? "",
    action: "release",
  };
  if (getActionReceipt(db, key) !== undefined) {
    return {
      disposition: "return",
      action: "release",
      state: "budget-exhausted",
      reason: "this owner incarnation was already released once for this task",
    };
  }
  const res = releaseTask(db, task.local_id, {
    workstream: task.workstream,
    expectedOwnerId: task.owner_id,
    ifRevision: ctx.revision,
    author: ctx.caller,
    evidence: `stall: ${agent.name} needed attention (stall ${ctx.stallToken}); released for another worker`,
  });
  if (!res.changed) return refused("the release changed nothing");
  reserveActionReceipt(db, key, {
    caller: ctx.caller,
    taskRef: `${task.workstream}/${task.local_id}`,
    ownerRef: `${agent.workstream}/${agent.name}`,
    paneId: agent.pane_id,
    previewRevision: ctx.revision,
  });
  transitionActionReceipt(db, key, "reserved", "released", {
    detail: `released from ${agent.name}`,
  });
  return {
    disposition: "return",
    action: "release",
    state: "released",
    ...(ctx.owner.incarnation !== undefined ? { incarnation: ctx.owner.incarnation } : {}),
    reason: `released ${task.local_id} from ${agent.name}`,
  };
}

/**
 * Release the stalled task if every guard still holds, atomically; else report
 * why not and change nothing. Always `disposition: "return"`: the caller gets
 * an actionable snapshot, the wait does not go on watching a freed task.
 */
export async function releaseStall(
  db: Db,
  ctx: WaitStallContext,
  opts: StallActionOptions = {},
): Promise<StallActionResult> {
  const callers = opts.callers ?? currentCallers();
  try {
    return withOpContext(db, { intent: "task.release", actor: ctx.caller, group: "new" }, () =>
      releaseBody(db, ctx, callers),
    );
  } catch (e) {
    // The transaction rolled back: nothing was written.
    return refused(
      `release failed, nothing changed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** `handleStall` for `onStall: 'release'`. */
export function releaseStallHandler(
  db: Db,
  opts: StallActionOptions = {},
): (ctx: WaitStallContext) => Promise<StallActionResult> {
  return (ctx) => releaseStall(db, ctx, opts);
}
