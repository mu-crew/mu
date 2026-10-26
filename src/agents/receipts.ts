// mu — spawn receipts: the journal of one task-bound spawn attempt.
//
// One row per (task, attempt key) in the machine-local `spawn_receipts`
// table. The orchestration (task-spawn.ts) writes it BEFORE each external
// effect, so a process that dies anywhere leaves a row whose state says how
// far it got, and a replay reads it back instead of acting again.
//
// The row names the registry incarnation it created (`agent_id` =
// `agents.id`, plus `pane_id`) with NO foreign key: it must outlive the
// agent. A replay compares both against the agent now holding the name; a
// deleted or replaced one is "stale", never silently swapped for the
// replacement. `incarnation` is pi's own string (the `--inc` of `agent
// wait`), a different thing, and is only known once a reply carried it.
//
// States, in order: reserved (nothing happened) < pane (agent row + pane
// exist) < claimed (the task is owned by agent_id) < sending (the prompt MAY
// have been written: never resend) < sent | unknown. failed means definitely
// unsent and rolled back. Pure SQL: no mux, no ctl.

import { createHash } from "node:crypto";
import type { Db, SpawnReceiptState } from "../db.js";

export interface SpawnReceipt {
  taskId: number;
  /** `manual:<key>`: the namespace of a manual spawn (the executor's attempts are `task_auto.last_spawn`). */
  attemptKey: string;
  name: string;
  workstream: string;
  /** Hash of the request (name, --next-free, text): a replay with another one conflicts. */
  requestSha: string;
  /** The id the send carries on the control socket (`mu agent check`). Never resent. */
  msgId: string;
  agentId: number | null;
  paneId: string | null;
  /** How the prompt went: `ctl` (a receipt id was carried) or `mux` (no receipt). */
  transport: "ctl" | "mux" | null;
  /** pi's incarnation, once a reply (or a receipt check) named it. */
  incarnation: string | null;
  runs: number | null;
  state: SpawnReceiptState;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawReceipt {
  task_id: number;
  attempt_key: string;
  name: string;
  workstream: string;
  request_sha: string;
  msg_id: string;
  agent_id: number | null;
  pane_id: string | null;
  transport: "ctl" | "mux" | null;
  incarnation: string | null;
  runs: number | null;
  state: SpawnReceiptState;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

const fromRaw = (r: RawReceipt): SpawnReceipt => ({
  taskId: r.task_id,
  attemptKey: r.attempt_key,
  name: r.name,
  workstream: r.workstream,
  requestSha: r.request_sha,
  msgId: r.msg_id,
  agentId: r.agent_id,
  paneId: r.pane_id,
  transport: r.transport,
  incarnation: r.incarnation,
  runs: r.runs,
  state: r.state,
  detail: r.detail,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The request's identity: same name, same --next-free, same text, same host. */
export function requestSha(req: {
  name: string;
  nextFree: boolean;
  text: string;
  host?: string | undefined;
}): string {
  // A local request hashes exactly as before this field existed (saved receipts stay valid).
  const parts: unknown[] = [req.name, req.nextFree, req.text];
  if (req.host !== undefined) parts.push(req.host);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function getReceipt(db: Db, taskId: number, attemptKey: string): SpawnReceipt | undefined {
  const row = db
    .prepare("SELECT * FROM spawn_receipts WHERE task_id = ? AND attempt_key = ?")
    .get(taskId, attemptKey) as RawReceipt | undefined;
  return row ? fromRaw(row) : undefined;
}

/** Write the reservation. Throws on a duplicate key (the caller holds the attempt lock and checked). */
export function reserveReceipt(
  db: Db,
  r: Pick<SpawnReceipt, "taskId" | "attemptKey" | "name" | "workstream" | "requestSha" | "msgId">,
): SpawnReceipt {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO spawn_receipts
       (task_id, attempt_key, name, workstream, request_sha, msg_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
  ).run(r.taskId, r.attemptKey, r.name, r.workstream, r.requestSha, r.msgId, now, now);
  const row = getReceipt(db, r.taskId, r.attemptKey);
  if (row === undefined) throw new Error("spawn receipt vanished after reservation");
  return row;
}

/** What `updateReceipt` may change. */
export type ReceiptPatch = Partial<
  Pick<
    SpawnReceipt,
    | "name"
    | "agentId"
    | "paneId"
    | "transport"
    | "incarnation"
    | "runs"
    | "state"
    | "detail"
    | "msgId"
    | "requestSha"
  >
>;

const COLUMN: Record<keyof ReceiptPatch, string> = {
  name: "name",
  agentId: "agent_id",
  paneId: "pane_id",
  transport: "transport",
  incarnation: "incarnation",
  runs: "runs",
  state: "state",
  detail: "detail",
  msgId: "msg_id",
  requestSha: "request_sha",
};

/** Patch a receipt (only the keys present). */
export function updateReceipt(
  db: Db,
  taskId: number,
  attemptKey: string,
  patch: ReceiptPatch,
): SpawnReceipt {
  const keys = (Object.keys(patch) as (keyof ReceiptPatch)[]).filter((k) => patch[k] !== undefined);
  const sets = [...keys.map((k) => `${COLUMN[k]} = ?`), "updated_at = ?"];
  db.prepare(
    `UPDATE spawn_receipts SET ${sets.join(", ")} WHERE task_id = ? AND attempt_key = ?`,
  ).run(
    ...keys.map((k) => patch[k] as string | number | null),
    new Date().toISOString(),
    taskId,
    attemptKey,
  );
  const row = getReceipt(db, taskId, attemptKey);
  if (row === undefined) throw new Error("spawn receipt vanished");
  return row;
}

/**
 * Reuse a FAILED attempt: nothing was sent, so the same key may run again,
 * with a fresh msgId and the new request. Clears the old identity.
 */
export function resetReceipt(
  db: Db,
  taskId: number,
  attemptKey: string,
  next: Pick<SpawnReceipt, "name" | "requestSha" | "msgId">,
): SpawnReceipt {
  db.prepare(
    `UPDATE spawn_receipts
        SET name = ?, request_sha = ?, msg_id = ?, agent_id = NULL, pane_id = NULL,
            transport = NULL, incarnation = NULL, runs = NULL, state = 'reserved', detail = NULL, updated_at = ?
      WHERE task_id = ? AND attempt_key = ?`,
  ).run(next.name, next.requestSha, next.msgId, new Date().toISOString(), taskId, attemptKey);
  const row = getReceipt(db, taskId, attemptKey);
  if (row === undefined) throw new Error("spawn receipt vanished");
  return row;
}

/**
 * Compare-and-set a receipt out of `from` (one statement): true iff THIS call
 * moved it. The write fence of an in-place send: only the winner may write.
 */
export function casReceipt(
  db: Db,
  taskId: number,
  attemptKey: string,
  from: SpawnReceiptState,
  patch: ReceiptPatch & { state: SpawnReceiptState },
): boolean {
  const keys = (Object.keys(patch) as (keyof ReceiptPatch)[]).filter((k) => patch[k] !== undefined);
  const sets = [...keys.map((k) => `${COLUMN[k]} = ?`), "updated_at = ?"];
  const res = db
    .prepare(
      `UPDATE spawn_receipts SET ${sets.join(", ")} WHERE task_id = ? AND attempt_key = ? AND state = ?`,
    )
    .run(
      ...keys.map((k) => patch[k] as string | number | null),
      new Date().toISOString(),
      taskId,
      attemptKey,
      from,
    );
  return res.changes === 1;
}
