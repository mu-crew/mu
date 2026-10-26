// mu — stall actions of a wait: the guarded release (C1) and the crash-safe
// steer (C2).
//
// The engine (wait.ts) DETECTS a stall and hands it to `handleStall`; this
// module is the policy and the effect. `releaseStall` frees the stalled
// task so another worker can take it; it never closes the task, spawns or
// kills. `steerStall` sends the owner ONE fixed reminder over its ctl socket
// (see below).
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
//
// STEER is at-most-once by SQLite, never by the msgId: the real extension
// remembers msgIds but does NOT dedupe sends. One synchronous immediate
// transaction guards and reserves the row (state `reserved`, msgId saved with
// it). Then, over ctl, hello and incarnation bind first; the LAST step before
// the write is `beforeWrite` (client.ts, on connect, synchronous): it re-runs
// every guard and compare-and-sets reserved -> sending in one immediate
// transaction. Only that CAS winner writes; a guard that fails there leaves the
// row `reserved` (nothing was sent: the budget is not burned). After the CAS the
// write MAY have happened, so every failure but pi's own ok:false is `unknown`
// and stays that way: a row found in `sending`/`unknown` (a crash, a timeout)
// is only ever PROBED (`status {msgId}` on the same saved registry id, pane and
// incarnation), never resent, and never turned into a release. Reserved and
// then crashed before the CAS: a resumer contends for the CAS with the saved
// msgId. Post-send storage failure keeps `sending`: the exclusion survives.

import { AgentReplacedError, AgentSendRefusedError } from "./agents/errors.js";
import { agentCtlSocket, checkMessage, recordSend, sendViaTransport } from "./agents/transport.js";
import { getAgent } from "./agents.js";
import { CTL_DEFAULT_TIMEOUT_MS, CtlWriteVetoedError, newMsgId } from "./ctl/client.js";
import type { Db } from "./db.js";
import { openHumanNeeds } from "./human-needed.js";
import { withOpContext } from "./op-context.js";
import { taskRevision } from "./revision.js";
import { autoPermitted } from "./task-auto.js";
import { releaseTask } from "./tasks/claim.js";
import { type WaitOptions, type WaitResult, waitForEvents } from "./wait.js";
import {
  type ActionKey,
  getActionReceipt,
  reserveActionReceipt,
  transitionActionReceipt,
} from "./wait-action-receipts.js";
import { currentCallers } from "./wait-callers.js";
import { readWaitRegistration } from "./wait-registration.js";
import type { StallActionResult, WaitRef, WaitStallContext } from "./wait-types.js";

export interface StallActionOptions {
  /** The caller set of this process (default: `currentCallers()`). */
  callers?: readonly string[];
}

const refused = (reason: string, action: StallActionResult["action"]): StallActionResult => ({
  disposition: "return",
  action,
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
  pane_id: string;
  spawner: string | null;
}

/** What a passed guard found, for the action to use. */
interface Guarded {
  localId: string;
  workstream: string;
  ownerId: number;
  ownerName: string;
  paneId: string;
}

/**
 * Every condition a stall action needs, evaluated synchronously (the caller
 * holds an immediate transaction) against the DB as it is NOW. `null` reason =
 * eligible. Shared by release and steer; steer additionally needs a readable,
 * healthy ctl (it can only be sent through it).
 */
function guardStall(
  db: Db,
  ctx: WaitStallContext,
  callers: readonly string[],
  action: StallActionResult["action"],
): { ok: true; found: Guarded } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (ctx.signal.aborted) return no("the wait was aborted");
  if (!callers.includes(ctx.caller)) {
    return no(`caller ${ctx.caller} is not one of this process's callers`);
  }
  if (ctx.generation !== null) {
    const reg = readWaitRegistration(db, ctx.caller);
    if (reg === undefined || reg.generation !== ctx.generation) {
      return no("the wait was superseded (generation changed)");
    }
  }
  const task = db
    .prepare(
      `SELECT t.local_id, w.name AS workstream, t.status, t.kind, t.owner_id
         FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE t.id = ?`,
    )
    .get(ctx.taskId) as TaskGuardRow | undefined;
  if (task === undefined) return no("the task no longer exists");
  if (task.local_id !== ctx.ref.id || task.workstream !== ctx.ref.workstream) {
    return no("the ref does not name this task");
  }
  if (task.kind !== "work") return no(`a ${task.kind} task is never ${action}d`);
  if (task.status !== "IN_PROGRESS") return no(`the task is ${task.status}, not IN_PROGRESS`);
  if (task.owner_id === null || task.owner_id !== ctx.owner.agentId) {
    return no("the task's owner is no longer the stalled agent");
  }
  // The owner is the registry row the stall saw (id), still on the pane it saw.
  const agent = db
    .prepare("SELECT a.name, a.pane_id, a.spawner FROM agents a WHERE a.id = ?")
    .get(task.owner_id) as AgentGuardRow | undefined;
  if (agent === undefined) return no("the owner is no longer registered");
  if (agent.pane_id !== ctx.owner.paneId) return no("the owner's pane changed (pane mismatch)");
  if (agent.spawner === null || !callers.includes(agent.spawner)) {
    return no("the owner was not spawned by this caller (not yours to act on)");
  }
  if (action === "steer") {
    if (ctx.owner.status !== "needs_input" || ctx.owner.ctl !== "ok") {
      return no(`the owner is not idle on a healthy control socket (state ${ctx.owner.status})`);
    }
    if (ctx.owner.incarnation === undefined || ctx.owner.incarnation === "") {
      return no("the owner's pi named no incarnation: a steer could not be bound to it");
    }
  } else {
    const brokenCtl = ctx.owner.ctl === "missing" || ctx.owner.ctl === "refused";
    const needsAttention =
      ctx.owner.status === "needs_input" ||
      (brokenCtl && (ctx.owner.status === "unknown" || ctx.owner.status === "busy"));
    if (!needsAttention) {
      return no(`the owner is not waiting on anyone (runtime state ${ctx.owner.status})`);
    }
  }
  if (!autoPermitted(db, ctx.taskId)) {
    return no("the task is not permitted for auto action on this machine (mu task auto)");
  }
  if (callers.some((c) => openHumanNeeds(db, c).length > 0)) {
    return no("a human stop is open for this caller: leave the stall to the human");
  }
  const revision = taskRevision(db, task.workstream, task.local_id);
  if (revision !== ctx.revision) {
    return no(
      `the task changed since the stall was seen (revision ${ctx.revision} -> ${revision})`,
    );
  }
  return {
    ok: true,
    found: {
      localId: task.local_id,
      workstream: task.workstream,
      ownerId: task.owner_id,
      ownerName: agent.name,
      paneId: agent.pane_id,
    },
  };
}

const keyOf = (ctx: WaitStallContext, ownerId: number, action: ActionKey["action"]): ActionKey => ({
  taskId: ctx.taskId,
  ownerId,
  incarnation: ctx.owner.incarnation ?? "",
  action,
});

const infoOf = (ctx: WaitStallContext, f: Guarded) => ({
  caller: ctx.caller,
  taskRef: `${f.workstream}/${f.localId}`,
  ownerRef: `${ctx.owner.workstream}/${f.ownerName}`,
  paneId: f.paneId,
  previewRevision: ctx.revision,
});

/** The release body: runs inside one immediate transaction. */
function releaseBody(db: Db, ctx: WaitStallContext, callers: readonly string[]): StallActionResult {
  const g = guardStall(db, ctx, callers, "release");
  if (!g.ok) return refused(g.reason, "release");
  const { found } = g;
  const key = keyOf(ctx, found.ownerId, "release");
  if (getActionReceipt(db, key) !== undefined) {
    return {
      disposition: "return",
      action: "release",
      state: "budget-exhausted",
      reason: "this owner incarnation was already released once for this task",
    };
  }
  const res = releaseTask(db, found.localId, {
    workstream: found.workstream,
    expectedOwnerId: found.ownerId,
    ifRevision: ctx.revision,
    author: ctx.caller,
    evidence: `stall: ${found.ownerName} needed attention (stall ${ctx.stallToken}); released for another worker`,
  });
  // Defence: the guards above already hold in this transaction.
  if (!res.changed) return refused("the release changed nothing", "release");
  reserveActionReceipt(db, key, infoOf(ctx, found));
  transitionActionReceipt(db, key, "reserved", "released", {
    detail: `released from ${found.ownerName}`,
  });
  return {
    disposition: "return",
    action: "release",
    state: "released",
    ...(ctx.owner.incarnation !== undefined ? { incarnation: ctx.owner.incarnation } : {}),
    reason: `released ${found.localId} from ${found.ownerName}`,
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
      "release",
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

// ─── steer ───────────────────────────────────────────────────────────────

/**
 * The one reminder a stalled worker gets: fixed, plain text, bounded (a task
 * id is a short name). Never carries worker output, notes or free text.
 */
export function steerText(workstream: string, taskId: string): string {
  return `[mu] ${workstream}/${taskId} is still yours (IN_PROGRESS) and mu is waiting on it. If the work is done and verified, close it: mu task close ${taskId} -w ${workstream} --evidence "<what you verified>". If you are blocked or need an answer, say so in one line and stop.`;
}

const steerResult = (
  state: StallActionResult["state"],
  disposition: StallActionResult["disposition"],
  extra: Partial<StallActionResult> = {},
): StallActionResult => ({ disposition, action: "steer", state, ...extra });

type SteerPlan =
  | { kind: "done"; result: StallActionResult }
  | { kind: "probe"; msgId: string; key: ActionKey; paneId: string; state: "sending" | "unknown" }
  | { kind: "send"; msgId: string; key: ActionKey; found: Guarded };

/**
 * Plan the steer in ONE synchronous immediate transaction (no await): what the
 * receipt says decides, then the guards, then the reservation. A row past
 * `reserved` is never sent again, whatever the guards say now.
 */
function planSteer(db: Db, ctx: WaitStallContext, callers: readonly string[]): SteerPlan {
  return db
    .transaction((): SteerPlan => {
      const key = keyOf(ctx, ctx.owner.agentId, "steer");
      const have = getActionReceipt(db, key);
      if (have !== undefined && have.state !== "reserved") {
        if (have.state === "sending" || have.state === "unknown") {
          if (have.msgId === null) {
            return {
              kind: "done",
              result: steerResult("unknown", "return", {
                reason: "a steer may have been written but its id was lost: not resent",
              }),
            };
          }
          return {
            kind: "probe",
            msgId: have.msgId,
            key,
            paneId: have.paneId,
            state: have.state,
          };
        }
        return {
          kind: "done",
          result: steerResult(have.state === "refused" ? "refused" : "budget-exhausted", "return", {
            reason:
              have.state === "refused"
                ? `pi refused the steer for this owner incarnation (${have.detail ?? "no reason"}); not retried`
                : "this owner incarnation was already nudged once for this task",
            ...(have.msgId !== null ? { msgId: have.msgId } : {}),
          }),
        };
      }
      const g = guardStall(db, ctx, callers, "steer");
      if (!g.ok) return { kind: "done", result: refused(g.reason, "steer") };
      const msgId = have?.msgId ?? newMsgId();
      if (have === undefined) {
        reserveActionReceipt(db, key, { ...infoOf(ctx, g.found), msgId });
      }
      return { kind: "send", msgId, key, found: g.found };
    })
    .immediate();
}

/** Ask a pi whether it accepted `msgId`; only the SAME incarnation's answer counts. */
async function probeSteer(
  db: Db,
  ctx: WaitStallContext,
  plan: Extract<SteerPlan, { kind: "probe" }>,
  timeoutMs: number,
): Promise<StallActionResult> {
  const unknown = (reason: string): StallActionResult => {
    if (plan.state === "sending") {
      try {
        transitionActionReceipt(db, plan.key, "sending", "unknown", { detail: reason });
      } catch {}
    }
    return steerResult("unknown", "return", { msgId: plan.msgId, reason });
  };
  const agent = getAgent(db, ctx.owner.name, ctx.owner.workstream);
  if (
    agent === undefined ||
    agent.incarnation !== plan.key.ownerId ||
    agent.paneId !== plan.paneId
  ) {
    return unknown("the owner was replaced: the earlier steer cannot be confirmed (not resent)");
  }
  if (ctx.signal.aborted) return unknown("the wait was aborted before the receipt probe");
  const check = await checkMessage(agentCtlSocket(db, agent), plan.msgId, timeoutMs);
  if (check.state !== "accepted" || check.incarnation !== plan.key.incarnation) {
    return unknown(
      check.state === "accepted"
        ? "the receipt came from another pi incarnation: not confirmed"
        : "the earlier steer is not confirmed (receipt absent or unreachable): not resent",
    );
  }
  try {
    transitionActionReceipt(db, plan.key, plan.state, "sent", {
      ...(check.runs !== undefined ? { runs: check.runs } : {}),
      detail: "confirmed by receipt probe",
    });
  } catch {
    // Storage failed: the row keeps its state (still an exclusion); the fact stands.
  }
  // The steer's run is still ahead of the stall observation only when the
  // receipt's run count has not fallen behind the owner's: otherwise that run
  // already settled and the owner is idle again, so return the stall (a
  // continue would wait on a token that can never change).
  if (check.runs !== undefined && ctx.owner.runs !== undefined && check.runs < ctx.owner.runs) {
    return steerResult("sent", "return", {
      msgId: plan.msgId,
      incarnation: plan.key.incarnation,
      afterRuns: check.runs,
      reason: "nudged earlier, owner idle again",
    });
  }
  return sentResult(plan.msgId, plan.key.incarnation, check.runs);
}

function sentResult(msgId: string, incarnation: string, runs: number | undefined) {
  return steerResult("sent", runs === undefined ? "return" : "continue", {
    msgId,
    incarnation,
    ...(runs !== undefined ? { afterRuns: runs } : {}),
    ...(runs === undefined ? { reason: "sent, but pi reported no run baseline to wait from" } : {}),
  });
}

/**
 * Nudge the stalled owner once. See the file header for the protocol. The
 * result is never a thrown error: `sent` (+ the real run baseline) continues
 * the wait; everything else returns the stall with the reason.
 */
export async function steerStall(
  db: Db,
  ctx: WaitStallContext,
  opts: StallActionOptions = {},
): Promise<StallActionResult> {
  const callers = opts.callers ?? currentCallers();
  const timeoutMs = Math.min(CTL_DEFAULT_TIMEOUT_MS, Math.max(1, ctx.deadlineMs));
  let plan: SteerPlan;
  try {
    plan = planSteer(db, ctx, callers);
  } catch (e) {
    return refused(`steer failed, nothing sent: ${errText(e)}`, "steer");
  }
  if (plan.kind === "done") return plan.result;
  if (plan.kind === "probe") return probeSteer(db, ctx, plan, timeoutMs);

  const { key, msgId, found } = plan;
  const agent = getAgent(db, found.ownerName, ctx.owner.workstream);
  if (agent === undefined || agent.incarnation !== found.ownerId) {
    return refused("the owner is no longer registered", "steer");
  }
  let won = false;
  let vetoed: StallActionResult | undefined;
  // The last synchronous step before the write: guards again, then the CAS.
  const beforeWrite = (): boolean => {
    const go = db
      .transaction((): boolean => {
        const g = guardStall(db, ctx, callers, "steer");
        if (!g.ok) {
          vetoed = refused(g.reason, "steer");
          return false;
        }
        if (!transitionActionReceipt(db, key, "reserved", "sending", { msgId })) {
          vetoed = steerResult("budget-exhausted", "return", {
            reason: "another waiter owns this nudge",
          });
          return false;
        }
        return true;
      })
      .immediate();
    won = go;
    return go;
  };
  try {
    const sent = await sendViaTransport(agent, steerText(found.workstream, found.localId), {
      socket: agentCtlSocket(db, agent),
      mode: "steer",
      msgId,
      expectIncarnation: key.incarnation,
      ctlGuard: { signal: ctx.signal, timeoutMs, beforeWrite },
    });
    try {
      const patch = {
        ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
        detail: sent.receipt ?? "accepted",
      };
      // A concurrent probe may have parked the row at `unknown` meanwhile.
      if (!transitionActionReceipt(db, key, "sending", "sent", patch)) {
        transitionActionReceipt(db, key, "unknown", "sent", patch);
      }
      recordSend(
        db,
        agent,
        "steer",
        Buffer.byteLength(steerText(found.workstream, found.localId)),
        {
          transport: "ctl",
          state: sent.state,
        },
        ctx.caller,
      );
    } catch {
      // Storage failed after the send: the row stays `sending`, the exclusion survives.
    }
    return sentResult(msgId, key.incarnation, sent.runs);
  } catch (e) {
    if (e instanceof CtlWriteVetoedError || !won) {
      // Nothing was written. The row stays `reserved`: the budget is not spent.
      return vetoed ?? refused(`steer not sent: ${errText(e)}`, "steer");
    }
    // The CAS passed, so the write may have happened.
    const definite = e instanceof AgentSendRefusedError || e instanceof AgentReplacedError;
    const to = definite ? "refused" : "unknown";
    try {
      transitionActionReceipt(db, key, "sending", to, { detail: errText(e) });
    } catch {}
    return steerResult(to, "return", { msgId, reason: errText(e) });
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `handleStall` for `onStall: 'steer'`. */
export function steerStallHandler(
  db: Db,
  opts: StallActionOptions = {},
): (ctx: WaitStallContext) => Promise<StallActionResult> {
  return (ctx) => steerStall(db, ctx, opts);
}

/**
 * `waitForEvents` with the stall actions wired: `onStall: 'steer' | 'release'`
 * picks the handler (a `handleStall` you pass wins). A composition, not a loop.
 */
export function waitWithActions(
  db: Db,
  refs: readonly WaitRef[],
  opts: WaitOptions,
): Promise<WaitResult> {
  if (opts.handleStall !== undefined) return waitForEvents(db, refs, opts);
  const actionOpts = { callers: opts.callers };
  const handleStall =
    opts.onStall === "steer"
      ? steerStallHandler(db, actionOpts)
      : opts.onStall === "release"
        ? releaseStallHandler(db, actionOpts)
        : undefined;
  return waitForEvents(db, refs, handleStall === undefined ? opts : { ...opts, handleStall });
}
