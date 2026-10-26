// mu — the executor's attempt accounting (`mu next`, slice A).
//
// One authorised dispatch is one ATTEMPT, `auto:<n>` in `spawn_receipts`
// (a different namespace from a manual `manual:<k>`), whose latest record
// lives in `task_auto.last_spawn` as JSON. A run is CHARGED once, when the
// attempt is reserved: counter, record and `reserved` receipt are written in
// ONE immediate transaction that re-plans first, so two `mu next` (two
// processes) cannot mint different attempts for a task, and a crash leaves
// either nothing or a reservation that a later `mu next` resumes under the
// SAME key. The record stores the EXACT prompt, so a replay sends those bytes
// and never rebuilds (nothing can drift). Replays, UNKNOWN probes and receipt
// checks never charge. A
// definitely-unsent failure keeps its charge and its failed key (never
// reset): the next attempt is a new key and a new charge, so real spawns can
// never exceed `max_runs`.
//
// `planAttempt` is the read-only half (also the dry run); `reserveAttempt`
// re-runs it inside the write transaction. No await, no ctl, no mux here.

import {
  getReceipt,
  requestSha,
  reserveReceipt,
  type SpawnReceipt,
  updateReceipt,
} from "./agents/receipts.js";
import { savedIdentity } from "./agents/task-spawn.js";
import { MAX_AGENT_NAME_LEN } from "./agents.js";
import { newMsgId } from "./ctl/client.js";
import type { Db } from "./db.js";
import { taskRevision } from "./revision.js";
import { localMachineId } from "./segments.js";
import { type AutoConfig, autoPermitted, getAutoConfig } from "./task-auto.js";
import { buildTaskBrief, TaskBriefMissingError } from "./task-brief.js";
import { taskIdFor } from "./tasks/core.js";
import { listReady } from "./tasks/queries.js";

/**
 * How a stored attempt ended without a delivery: `abandoned` (nothing left to
 * do: the task closed, the agent is gone) or `needs_human` (the prompt may
 * have landed and cannot be confirmed: never resent, parked behind a human
 * need). Either is terminal: never replayed, never counted again.
 */
export interface AttemptEnd {
  state: "abandoned" | "needs_human";
  reason: string;
}

/** `task_auto.last_spawn`: the latest attempt, with its exact request. */
export interface AttemptRecord {
  v: 1;
  attempt: number;
  /** `auto:<attempt>`: the `spawn_receipts.attempt_key`. */
  key: string;
  /** The agent name asked for (a taken one is moved on by `nextFree`; the receipt has the real one). */
  name: string;
  cli: string;
  worktree: boolean;
  /** The exact prompt, stored at reservation: a replay sends these bytes. */
  text: string;
  /** The previous attempt's worker is gone: the brief says so. */
  retry: boolean;
  /**
   * A retry IN PLACE: the same live worker (its saved registry id + pane) is
   * sent the brief again after an API-errored run. No pane is spawned, and no
   * failure ever removes the worker.
   */
  inPlace?: boolean;
  /** Set once the attempt reached a terminal state without a delivery. */
  end?: AttemptEnd;
}

export interface AttemptPlan extends AttemptRecord {
  task: string;
  taskId: number;
  workstream: string;
  /** The task's derived revision the plan was made at. */
  revision: number;
}

export type PlanCode =
  | "not-found"
  | "not-permitted"
  | "in-flight"
  | "parked"
  | "delivered"
  | "ceiling"
  | "not-ready"
  | "no-brief"
  | "changed";

export type PlanResult =
  | { ok: true; plan: AttemptPlan }
  | { ok: false; code: PlanCode; reason: string };

/** Receipt states from which an attempt must be resumed, not replaced. */
export const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  "reserved",
  "pane",
  "claimed",
  "sending",
  "unknown",
]);

/** Receipt states from which nothing has been written to the agent. */
const UNSENT_STATES: ReadonlySet<string> = new Set(["reserved", "pane", "claimed"]);

const refuse = (code: PlanCode, reason: string): PlanResult => ({ ok: false, code, reason });

/**
 * Is the worker of a DELIVERED attempt known to be gone, with its task
 * reopened by the reaper? The saved registry id + pane no longer hold, and the
 * reaper's own note (`[reaper] previous owner <name> gone`) was written after
 * the attempt began. A task someone reopened by hand (a rejected review) has
 * no such note: that is a decision, never a death.
 */
export function workerGone(db: Db, taskId: number, receipt: SpawnReceipt): boolean {
  if (savedIdentity(db, receipt).stale === undefined) return false;
  const head = `[reaper] previous owner ${receipt.name} gone`;
  return (
    db
      .prepare(
        `SELECT 1 AS x FROM task_notes
          WHERE task_id = ? AND author = 'reaper' AND created_at >= ? AND instr(content, ?) = 1
          LIMIT 1`,
      )
      .get(taskId, receipt.createdAt, head) !== undefined
  );
}

export function parseAttempt(raw: string | null): AttemptRecord | undefined {
  if (raw === null) return undefined;
  try {
    const r = JSON.parse(raw) as Partial<AttemptRecord>;
    if (
      r.v !== 1 ||
      typeof r.key !== "string" ||
      typeof r.attempt !== "number" ||
      typeof r.text !== "string"
    ) {
      return undefined;
    }
    return r as AttemptRecord;
  } catch {
    return undefined;
  }
}

/** The stored attempt of a task and its receipt (either may be absent). */
export function readAttempt(
  db: Db,
  taskId: number,
): { auto?: AutoConfig; record?: AttemptRecord; receipt?: SpawnReceipt } {
  const auto = getAutoConfig(db, taskId);
  const record = parseAttempt(auto?.lastSpawn ?? null);
  const receipt = record === undefined ? undefined : getReceipt(db, taskId, record.key);
  return {
    ...(auto !== undefined ? { auto } : {}),
    ...(record !== undefined ? { record } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  };
}

/**
 * The DELIVERED receipt the latest attempt stands on: its own when `sent`; for
 * an in-place retry that failed unsent (the worker was never touched), the
 * delivery it retried. Undefined when nothing was delivered.
 */
export function deliveredOf(
  db: Db,
  taskId: number,
): { record: AttemptRecord; receipt: SpawnReceipt } | undefined {
  const { record, receipt } = readAttempt(db, taskId);
  if (record === undefined || receipt === undefined || record.end !== undefined) return undefined;
  if (receipt.state === "sent") return { record, receipt };
  if (record.inPlace !== true || receipt.state !== "failed") return undefined;
  const prior = db
    .prepare(
      `SELECT attempt_key FROM spawn_receipts
        WHERE task_id = ? AND state = 'sent' AND attempt_key LIKE 'auto:%' AND agent_id = ?
        ORDER BY created_at DESC, attempt_key DESC LIMIT 1`,
    )
    .get(taskId, receipt.agentId) as { attempt_key: string } | undefined;
  const sent = prior === undefined ? undefined : getReceipt(db, taskId, prior.attempt_key);
  return sent === undefined ? undefined : { record, receipt: sent };
}

/**
 * Local ids of the permitted tasks of `workstream` whose latest attempt is
 * in flight (reserved … unknown) and not ended: to be RESUMED before anything
 * new is allocated, even at their run ceiling. Revoked, foreign and ended
 * (abandoned / needs_human) attempts are absent.
 */
export function pendingAttempts(db: Db, workstream: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.local_id AS local_id
         FROM task_auto a
         JOIN tasks t ON t.id = a.task_id
         JOIN workstreams w ON w.id = t.workstream_id AND w.name = ?
         JOIN spawn_receipts r ON r.task_id = a.task_id
          AND r.attempt_key = json_extract(a.last_spawn, '$.key')
        WHERE a.enabled = 1 AND t.kind = 'work' AND t.dispatch_host = ?
          AND r.state IN ('reserved', 'pane', 'claimed', 'sending', 'unknown')
          AND json_extract(a.last_spawn, '$.end') IS NULL
          AND json_extract(a.last_spawn, '$.text') IS NOT NULL
        ORDER BY t.id`,
    )
    .all(workstream, localMachineId(db)) as { id: number; local_id: string }[];
  return rows.filter((r) => autoPermitted(db, r.id)).map((r) => r.local_id);
}

/** The agent name an attempt asks for: the task id cut to leave room for `-<attempt>`. */
export function attemptName(task: string, attempt: number): string {
  const suffix = `-${attempt}`;
  return `${task.slice(0, MAX_AGENT_NAME_LEN - suffix.length)}${suffix}`;
}

/** The request hash of an attempt (the executor always spawns `nextFree`, locally). */
export const attemptSha = (name: string, text: string): string =>
  requestSha({ name, nextFree: true, text });

/**
 * Read-only: may a NEW attempt for `task` be reserved now, and what would it
 * be? Checks, in order: permission (enabled, work, this host), an attempt
 * already in flight or delivered, the run ceiling, readiness and the brief.
 * `revision` (when given) must equal the task's current revision.
 */
export function planAttempt(
  db: Db,
  workstream: string,
  task: string,
  opts: { revision?: number } = {},
): PlanResult {
  const taskId = taskIdFor(db, task, workstream);
  if (taskId === null) return refuse("not-found", `no task ${task} in ${workstream}`);
  if (!autoPermitted(db, taskId)) {
    return refuse("not-permitted", `${task} is not authorised for this machine (mu task auto)`);
  }
  const { auto, record, receipt } = readAttempt(db, taskId);
  if (auto === undefined) return refuse("not-permitted", `${task} has no auto config`);
  let retry = false;
  if (record?.end?.state === "needs_human") {
    return refuse(
      "parked",
      `${record.key} of ${task} may have been delivered and waits for a human (${record.end.reason})`,
    );
  }
  if (record !== undefined && receipt !== undefined && record.end === undefined) {
    if (IN_FLIGHT_STATES.has(receipt.state)) {
      return refuse("in-flight", `${record.key} of ${task} is ${receipt.state}: resume it`);
    }
    const delivered = deliveredOf(db, taskId);
    if (delivered !== undefined) {
      if (!workerGone(db, taskId, delivered.receipt)) {
        return refuse(
          "delivered",
          `${record.key} of ${task} was delivered and its worker is not known to be gone: not re-dispatched`,
        );
      }
      retry = true;
    }
  }
  if (auto.runs >= auto.maxRuns) {
    return refuse("ceiling", `${task} used its ${auto.maxRuns} run(s)`);
  }
  if (!listReady(db, workstream).some((t) => t.name === task)) {
    return refuse("not-ready", `${task} is not ready`);
  }
  const revision = taskRevision(db, workstream, task);
  if (opts.revision !== undefined && opts.revision !== revision) {
    return refuse(
      "changed",
      `${task} changed since it was planned (rev ${opts.revision} → ${revision})`,
    );
  }
  const attempt = auto.runs + 1;
  const name = attemptName(task, attempt);
  let brief: ReturnType<typeof buildTaskBrief>;
  try {
    brief = buildTaskBrief(db, workstream, task, { retry });
  } catch (err) {
    if (err instanceof TaskBriefMissingError) return refuse("no-brief", err.message);
    throw err;
  }
  return {
    ok: true,
    plan: {
      v: 1,
      attempt,
      key: `auto:${attempt}`,
      name,
      cli: auto.cli,
      worktree: auto.worktree,
      text: brief.text,
      retry,
      task,
      taskId,
      workstream,
      revision,
    },
  };
}

/**
 * Charge one run and reserve its attempt, atomically (see the file header).
 * Re-plans INSIDE the immediate transaction, so a change seen at ingest
 * between the caller's view and now refuses instead of acting on it.
 */
export function reserveAttempt(
  db: Db,
  workstream: string,
  task: string,
  opts: { revision?: number } = {},
): PlanResult {
  return db
    .transaction((): PlanResult => {
      const planned = planAttempt(db, workstream, task, opts);
      if (!planned.ok) return planned;
      const { plan } = planned;
      const { task: _t, taskId, workstream: _w, revision: _r, ...record } = plan;
      const charged = db
        .prepare(
          "UPDATE task_auto SET runs = runs + 1, last_spawn = ? WHERE task_id = ? AND runs = ? AND enabled = 1",
        )
        .run(JSON.stringify(record), taskId, plan.attempt - 1);
      if (charged.changes !== 1) return refuse("changed", `${task}'s run counter moved`);
      reserveReceipt(db, {
        taskId,
        attemptKey: plan.key,
        name: plan.name,
        workstream,
        requestSha: attemptSha(plan.name, plan.text),
        msgId: newMsgId(),
      });
      return planned;
    })
    .immediate();
}

/**
 * Move the stored attempt `key` of a task to a terminal state (compare and
 * set on the key, so a newer attempt is never overwritten). A receipt that
 * never reached the send (reserved, pane, claimed) is failed with the reason;
 * a sending / unknown one is left as the evidence it is. False when the
 * record moved on.
 */
export function endAttempt(db: Db, taskId: number, key: string, end: AttemptEnd): boolean {
  return db
    .transaction((): boolean => {
      const { record, receipt } = readAttempt(db, taskId);
      if (record === undefined || record.key !== key || record.end !== undefined) return false;
      const changed = db
        .prepare("UPDATE task_auto SET last_spawn = ? WHERE task_id = ?")
        .run(JSON.stringify({ ...record, end }), taskId).changes;
      if (changed !== 1) return false;
      if (receipt !== undefined && UNSENT_STATES.has(receipt.state)) {
        updateReceipt(db, taskId, key, { state: "failed", detail: `${end.state}: ${end.reason}` });
      }
      return true;
    })
    .immediate();
}

/** What `reserveRetry` needs of the worker observed to have stopped on an API error. */
export interface RetryTarget {
  /** The registry row the attempt saved: id + pane, and the name. */
  agent: { incarnation: number; paneId: string; name: string };
  /** pi's process incarnation the error was read from: the send is bound to it. */
  pi: string;
  /** pi's settled-run count of the errored run. */
  errorRuns: number;
}

/**
 * Charge one run and reserve an IN-PLACE retry of the delivered attempt, atomically
 * (see the file header): the same worker, the same task, a new `auto:<n>` key
 * whose receipt starts at `claimed` on the saved identity, so the guarded replay
 * skips the spawn and the claim and goes straight to the journaled send. Refuses
 * unless, in this transaction: the task is permitted and IN_PROGRESS, owned by the
 * very registry row the delivered attempt saved (id + pane), under its run
 * ceiling, and the error run is a newer one than the delivered send (so a retry
 * already sent is never charged twice for the same error).
 */
export function reserveRetry(
  db: Db,
  workstream: string,
  task: string,
  target: RetryTarget,
): PlanResult {
  return db
    .transaction((): PlanResult => {
      const taskId = taskIdFor(db, task, workstream);
      if (taskId === null) return refuse("not-found", `no task ${task} in ${workstream}`);
      if (!autoPermitted(db, taskId)) {
        return refuse("not-permitted", `${task} is not authorised for this machine (mu task auto)`);
      }
      const { auto } = readAttempt(db, taskId);
      const delivered = deliveredOf(db, taskId);
      if (auto === undefined || delivered === undefined) {
        return refuse("changed", `${task} has no delivered attempt`);
      }
      const { receipt } = delivered;
      const { agent } = target;
      if (
        receipt.agentId !== agent.incarnation ||
        receipt.paneId !== agent.paneId ||
        receipt.name !== agent.name ||
        savedIdentity(db, receipt).stale !== undefined
      ) {
        return refuse("changed", `${task}: the worker is not the one its attempt delivered to`);
      }
      if (receipt.runs === null || target.errorRuns <= receipt.runs) {
        return refuse("changed", `${task}: that error was already answered`);
      }
      const row = db.prepare("SELECT status, owner_id FROM tasks WHERE id = ?").get(taskId) as {
        status: string;
        owner_id: number | null;
      };
      if (row.status !== "IN_PROGRESS" || row.owner_id !== agent.incarnation) {
        return refuse("changed", `${task} is no longer in progress with ${agent.name}`);
      }
      if (auto.runs >= auto.maxRuns) {
        return refuse("ceiling", `${task} used its ${auto.maxRuns} run(s)`);
      }
      let brief: ReturnType<typeof buildTaskBrief>;
      try {
        brief = buildTaskBrief(db, workstream, task, { retry: "error" });
      } catch (err) {
        if (err instanceof TaskBriefMissingError) return refuse("no-brief", err.message);
        throw err;
      }
      const attempt = auto.runs + 1;
      const plan: AttemptPlan = {
        v: 1,
        attempt,
        key: `auto:${attempt}`,
        name: agent.name,
        cli: auto.cli,
        worktree: auto.worktree,
        text: brief.text,
        retry: true,
        inPlace: true,
        task,
        taskId,
        workstream,
        revision: taskRevision(db, workstream, task),
      };
      const { task: _t, taskId: _i, workstream: _w, revision: _r, ...stored } = plan;
      const charged = db
        .prepare(
          "UPDATE task_auto SET runs = runs + 1, last_spawn = ? WHERE task_id = ? AND runs = ? AND enabled = 1",
        )
        .run(JSON.stringify(stored), taskId, auto.runs);
      if (charged.changes !== 1) return refuse("changed", `${task}'s run counter moved`);
      reserveReceipt(db, {
        taskId,
        attemptKey: plan.key,
        name: agent.name,
        workstream,
        requestSha: attemptSha(agent.name, plan.text),
        msgId: newMsgId(),
      });
      updateReceipt(db, taskId, plan.key, {
        state: "claimed",
        agentId: agent.incarnation,
        paneId: agent.paneId,
        incarnation: target.pi,
      });
      return { ok: true, plan };
    })
    .immediate();
}
