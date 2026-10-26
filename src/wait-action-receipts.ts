// mu — wait action receipts: the exclusion and journal of stall actions.
//
// One row per (task, owner, ctl incarnation, action) in the machine-local
// `wait_action_receipts` table. The identity is deliberately NOT the wait
// generation, the task revision or the caller: every caller, restart and
// generation of a wait shares one exclusion, so a stalled worker is nudged
// once and released once per incarnation, however many waits see the stall.
//
// `task_id` and `owner_id` are `tasks.id` / `agents.id` with NO foreign key:
// the row is evidence that an effect may have happened and must outlive both.
// `incarnation` is pi's process incarnation ('' when ctl named none).
//
// States and their edges (anything else throws; history is never rewritten):
//   reserved -> sending | refused | released
//   sending  -> sent | unknown | refused
//                                   (sending is "the write MAY have happened";
//                                    refused = pi answered ok:false, so it did not)
//   unknown  -> sent                (a receipt probe on the SAME saved registry,
//                                    pane and incarnation confirmed it)
// Pure SQL: no mux, no ctl, no transaction of its own (each call is one
// statement; callers that need more wrap their own).

import type { Db, WaitAction, WaitActionState } from "./db.js";

export interface ActionKey {
  /** `tasks.id`. */
  taskId: number;
  /** `agents.id` of the owner when the action was taken. */
  ownerId: number;
  /** pi's ctl incarnation; '' when none. */
  incarnation: string;
  action: WaitAction;
}

/** What a reservation records about the situation. */
export interface ActionInfo {
  /** Who asked (one of the caller set); attribution only, not identity. */
  caller: string;
  /** `<workstream>/<task>`. */
  taskRef: string;
  /** `<workstream>/<agent>`. */
  ownerRef: string;
  paneId: string;
  /** The task revision the action was decided against. */
  previewRevision: number;
}

export interface ActionReceipt extends ActionKey, ActionInfo {
  msgId: string | null;
  state: WaitActionState;
  runs: number | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Raw {
  task_id: number;
  owner_id: number;
  incarnation: string;
  action: WaitAction;
  caller: string;
  task_ref: string;
  owner_ref: string;
  pane_id: string;
  preview_revision: number;
  msg_id: string | null;
  state: WaitActionState;
  runs: number | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

const fromRaw = (r: Raw): ActionReceipt => ({
  taskId: r.task_id,
  ownerId: r.owner_id,
  incarnation: r.incarnation,
  action: r.action,
  caller: r.caller,
  taskRef: r.task_ref,
  ownerRef: r.owner_ref,
  paneId: r.pane_id,
  previewRevision: r.preview_revision,
  msgId: r.msg_id,
  state: r.state,
  runs: r.runs,
  detail: r.detail,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const EDGES: Record<WaitActionState, readonly WaitActionState[]> = {
  reserved: ["sending", "refused", "released"],
  sending: ["sent", "unknown", "refused"],
  unknown: ["sent"],
  sent: [],
  refused: [],
  released: [],
};

export function getActionReceipt(db: Db, key: ActionKey): ActionReceipt | undefined {
  const row = db
    .prepare(
      `SELECT * FROM wait_action_receipts
        WHERE task_id = ? AND owner_id = ? AND incarnation = ? AND action = ?`,
    )
    .get(key.taskId, key.ownerId, key.incarnation, key.action) as Raw | undefined;
  return row === undefined ? undefined : fromRaw(row);
}

/**
 * Reserve the exclusion. `created: true` means THIS call made the row and
 * owns the action; `false` returns the row that is already there (whoever
 * wrote it, in whatever state). One statement: concurrent connections race
 * on the primary key and exactly one wins.
 */
export function reserveActionReceipt(
  db: Db,
  key: ActionKey,
  info: ActionInfo & {
    /** The id a ctl send will carry: reserved WITH the row, so a resumer reuses it and a crash leaves one to probe. */
    msgId?: string;
  },
): { created: boolean; receipt: ActionReceipt } {
  const now = new Date().toISOString();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO wait_action_receipts
         (task_id, owner_id, incarnation, action, caller, task_ref, owner_ref, pane_id,
          preview_revision, msg_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
    )
    .run(
      key.taskId,
      key.ownerId,
      key.incarnation,
      key.action,
      info.caller,
      info.taskRef,
      info.ownerRef,
      info.paneId,
      info.previewRevision,
      info.msgId ?? null,
      now,
      now,
    );
  const receipt = getActionReceipt(db, key);
  if (receipt === undefined) throw new Error("wait action receipt vanished after reservation");
  return { created: res.changes === 1, receipt };
}

/**
 * Compare-and-set `from` -> `to`: true iff this call moved the row. False
 * when the row is absent or no longer in `from` (someone else won). A
 * `from`/`to` pair that is not an edge throws. Patch fields left undefined
 * keep their stored value.
 */
export function transitionActionReceipt(
  db: Db,
  key: ActionKey,
  from: WaitActionState,
  to: WaitActionState,
  patch: { msgId?: string; runs?: number; detail?: string } = {},
): boolean {
  if (!EDGES[from].includes(to)) {
    throw new Error(`wait action receipt: illegal transition ${from} -> ${to}`);
  }
  const res = db
    .prepare(
      `UPDATE wait_action_receipts
          SET state = ?, msg_id = COALESCE(?, msg_id), runs = COALESCE(?, runs),
              detail = COALESCE(?, detail), updated_at = ?
        WHERE task_id = ? AND owner_id = ? AND incarnation = ? AND action = ? AND state = ?`,
    )
    .run(
      to,
      patch.msgId ?? null,
      patch.runs ?? null,
      patch.detail ?? null,
      new Date().toISOString(),
      key.taskId,
      key.ownerId,
      key.incarnation,
      key.action,
      from,
    );
  return res.changes === 1;
}
