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
  /** The previous attempt died (slice B sets it). */
  retry: boolean;
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
    if (receipt.state === "sent") {
      return refuse(
        "delivered",
        `${record.key} of ${task} was delivered; recovery of an ended attempt is not automatic`,
      );
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
    brief = buildTaskBrief(db, workstream, task);
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
      retry: false,
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
