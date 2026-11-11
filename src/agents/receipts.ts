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
//
// This module owns the state machine (plugins spec D8; review 2 of P6e2): a
// state moves only by `transitionReceipt`, one event of `RECEIPT_EVENTS`,
// compare-and-set from the state it read. No other code writes `state`. An
// event names who may cause it: the attempt's own invocation (`creator`: the
// spawn, or the replay that holds the attempt lock now), or another one (`mu
// agent check`) acting on an at-start job record whose creating process is
// proven gone (`other-gone`). While that process lives, another invocation only
// reads (`other-alive`: nothing is allowed).

import { createHash } from "node:crypto";
import type { ChannelName } from "../channels/types.js";
import { type Db, SPAWN_RECEIPT_STATES, type SpawnReceiptState } from "../db.js";

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
  /**
   * How the prompt went: `ctl` (a receipt id was carried), `hooks` (a brief file
   * and a pasted pointer, confirmed by `run_count`: spec D17) or `mux` (no receipt).
   */
  transport: ChannelName | null;
  /** pi's incarnation, once a reply (or a receipt check) named it. On `hooks`: the harness `session_id`. */
  incarnation: string | null;
  /** ctl: pi's runs before the prompt. hooks: the session's `run_count` before the pointer (its baseline). */
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
  transport: ChannelName | null;
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

/** The request's identity: same name, same --next-free, same text, same host, same remote --root. */
export function requestSha(req: {
  name: string;
  nextFree: boolean;
  text: string;
  host?: string | undefined;
  root?: string | undefined;
}): string {
  // A local request hashes exactly as before these fields existed (saved receipts stay valid).
  const parts: unknown[] = [req.name, req.nextFree, req.text];
  if (req.host !== undefined) parts.push(req.host);
  if (req.host !== undefined && req.root !== undefined) parts.push({ root: req.root });
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function getReceipt(db: Db, taskId: number, attemptKey: string): SpawnReceipt | undefined {
  const row = db
    .prepare("SELECT * FROM spawn_receipts WHERE task_id = ? AND attempt_key = ?")
    .get(taskId, attemptKey) as RawReceipt | undefined;
  return row ? fromRaw(row) : undefined;
}

/**
 * The first unused key after `attemptKey` (`manual:t1` -> `t1-2`, `t1-2` ->
 * `t1-3`), without its namespace: what `--attempt` takes to start again.
 */
export function nextAttemptKey(db: Db, taskId: number, attemptKey: string): string {
  const colon = attemptKey.indexOf(":");
  const ns = colon === -1 ? "" : attemptKey.slice(0, colon + 1);
  const bare = attemptKey.slice(ns.length);
  // A suffix too large to count past exactly is part of the stem: `<key>-2` then.
  const m = /^(.*)-(\d{1,9})$/.exec(bare);
  const stem = m?.[1] ?? bare;
  let n = m === null ? 2 : Number(m[2]) + 1;
  while (getReceipt(db, taskId, `${ns}${stem}-${n}`) !== undefined) n++;
  return `${stem}-${n}`;
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

/** Who causes a receipt event: the attempt's own invocation, or another (D8 owner-only rule). */
export type ReceiptActor = "creator" | "other-alive" | "other-gone";

/**
 * The receipt events: the states each moves from, the state it moves to (`same`: a patch of
 * the other columns), and who may cause it. Only `transitionReceipt` reads it.
 */
export const RECEIPT_EVENTS = {
  /** The spawn's agent row and pane exist. */
  pane: { from: ["reserved"], to: "pane", by: ["creator"] },
  /** The task is owned by the receipt's agent (an executor's in-place retry claims at once). */
  claim: { from: ["reserved", "pane"], to: "claimed", by: ["creator"] },
  /** The prompt may be written from here: never resent. */
  send: { from: ["claimed"], to: "sending", by: ["creator"] },
  /** The write (a send, or an at-start job.start carrying the prompt) answered. */
  delivered: { from: ["sending"], to: "sent", by: ["creator"] },
  /** A replay or resolution proved the prompt landed. */
  confirm: { from: ["sending", "unknown"], to: "sent", by: ["creator", "other-gone"] },
  /** It may have landed: never resent. */
  unknown: { from: ["sending", "unknown"], to: "unknown", by: ["creator", "other-gone"] },
  /** Definitely nothing delivered (a refusal before the write, or a dead identity). */
  unsent: { from: ["reserved", "pane", "claimed", "sending"], to: "failed", by: ["creator"] },
  /** A lookup proved the at-start start never happened. */
  never: { from: ["sending", "unknown"], to: "failed", by: ["creator", "other-gone"] },
  /** A manual key runs again after a failure. */
  reset: { from: ["failed"], to: "reserved", by: ["creator"] },
  /** The pane of the receipt's agent, once a view opened for it. */
  repoint: {
    from: ["pane", "claimed", "sending", "sent", "unknown"],
    to: "same",
    by: ["creator", "other-gone"],
  },
  /** Facts beside the state (an incarnation, a detail). */
  note: { from: [...SPAWN_RECEIPT_STATES], to: "same", by: ["creator"] },
} as const satisfies Record<
  string,
  {
    from: readonly SpawnReceiptState[];
    to: SpawnReceiptState | "same";
    by: readonly ReceiptActor[];
  }
>;
export type ReceiptEvent = keyof typeof RECEIPT_EVENTS;

/** A receipt event its current state or its actor does not allow (or a lost compare-and-set). Exit 4. */
export class ReceiptTransitionError extends Error {
  override readonly name = "ReceiptTransitionError";
  constructor(
    public readonly attemptKey: string,
    public readonly event: ReceiptEvent,
    public readonly state: SpawnReceiptState | "missing",
    public readonly actor: ReceiptActor,
  ) {
    super(
      `spawn receipt ${attemptKey}: ${event} by ${actor} is not allowed from ${state}; the attempt is left as it is`,
    );
  }
}

/** Whether `event` by `actor` may move a receipt in `state` (the table, and nothing else). */
export function receiptEventAllowed(
  state: SpawnReceiptState,
  event: ReceiptEvent,
  actor: ReceiptActor,
): boolean {
  const e = RECEIPT_EVENTS[event];
  return (
    (e.from as readonly SpawnReceiptState[]).includes(state) &&
    (e.by as readonly ReceiptActor[]).includes(actor)
  );
}

/** What an event may change beside the state. */
export type ReceiptPatch = Partial<
  Pick<
    SpawnReceipt,
    | "name"
    | "agentId"
    | "paneId"
    | "transport"
    | "incarnation"
    | "runs"
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
  detail: "detail",
  msgId: "msg_id",
  requestSha: "request_sha",
};

/**
 * THE way a receipt changes: `event` by `actor`, compare-and-set from the state read now.
 * Throws `ReceiptTransitionError` when the table refuses it or the row moved meanwhile.
 */
export function transitionReceipt(
  db: Db,
  taskId: number,
  attemptKey: string,
  event: ReceiptEvent,
  patch: ReceiptPatch = {},
  actor: ReceiptActor = "creator",
): SpawnReceipt {
  const cur = getReceipt(db, taskId, attemptKey);
  if (cur === undefined || !receiptEventAllowed(cur.state, event, actor)) {
    throw new ReceiptTransitionError(attemptKey, event, cur?.state ?? "missing", actor);
  }
  const to: SpawnReceiptState =
    RECEIPT_EVENTS[event].to === "same"
      ? cur.state
      : (RECEIPT_EVENTS[event].to as SpawnReceiptState);
  const keys = (Object.keys(patch) as (keyof ReceiptPatch)[]).filter((k) => patch[k] !== undefined);
  const sets = [...keys.map((k) => `${COLUMN[k]} = ?`), "state = ?", "updated_at = ?"];
  const changed = db
    .prepare(
      `UPDATE spawn_receipts SET ${sets.join(", ")} WHERE task_id = ? AND attempt_key = ? AND state = ?`,
    )
    .run(
      ...keys.map((k) => patch[k] as string | number | null),
      to,
      new Date().toISOString(),
      taskId,
      attemptKey,
      cur.state,
    ).changes;
  if (changed !== 1) throw new ReceiptTransitionError(attemptKey, event, cur.state, actor);
  const row = getReceipt(db, taskId, attemptKey);
  if (row === undefined) throw new Error("spawn receipt vanished");
  return row;
}

/**
 * TEST SEAM: seed a receipt with any columns, its state included, bypassing the table (the
 * fixtures of a receipt "left in each stage"). No source file calls it
 * (test/receipt-states.test.ts).
 */
export function updateReceipt(
  db: Db,
  taskId: number,
  attemptKey: string,
  patch: ReceiptPatch & { state?: SpawnReceiptState },
): SpawnReceipt {
  const { state, ...rest } = patch;
  const keys = (Object.keys(rest) as (keyof ReceiptPatch)[]).filter((k) => rest[k] !== undefined);
  const sets = [
    ...keys.map((k) => `${COLUMN[k]} = ?`),
    ...(state !== undefined ? ["state = ?"] : []),
    "updated_at = ?",
  ];
  db.prepare(
    `UPDATE spawn_receipts SET ${sets.join(", ")} WHERE task_id = ? AND attempt_key = ?`,
  ).run(
    ...keys.map((k) => rest[k] as string | number | null),
    ...(state !== undefined ? [state] : []),
    new Date().toISOString(),
    taskId,
    attemptKey,
  );
  const row = getReceipt(db, taskId, attemptKey);
  if (row === undefined) throw new Error("spawn receipt vanished");
  return row;
}

/**
 * The receipts of incarnation `agentId` follow its view to `paneId` (D8 G1a, D3): the `repoint`
 * event, once a view opened. `of`: the receipts of first prompt `msgId` (a lookup recovery's
 * view), or those naming the view `pane` that went (a detached view's reattach).
 */
export function repointReceipts(
  db: Db,
  agentId: number,
  of: { msgId: string } | { pane: string },
  paneId: string,
  actor: ReceiptActor,
): void {
  const [col, val] = "msgId" in of ? ["msg_id", of.msgId] : ["pane_id", of.pane];
  // A reserved or failed attempt names no live view: nothing of it follows.
  const from = RECEIPT_EVENTS.repoint.from.map((st) => `'${st}'`).join(", ");
  const rows = db
    .prepare(
      `SELECT task_id, attempt_key FROM spawn_receipts WHERE agent_id = ? AND ${col} = ? AND state IN (${from})`,
    )
    .all(agentId, val) as { task_id: number; attempt_key: string }[];
  for (const r of rows)
    transitionReceipt(db, r.task_id, r.attempt_key, "repoint", { paneId }, actor);
}

/**
 * Reuse a FAILED attempt (the `reset` event): nothing was sent, so the same key may run again,
 * with a fresh msgId and the new request. Clears the old identity.
 */
export function resetReceipt(
  db: Db,
  taskId: number,
  attemptKey: string,
  next: Pick<SpawnReceipt, "name" | "requestSha" | "msgId">,
): SpawnReceipt {
  return transitionReceipt(db, taskId, attemptKey, "reset", {
    ...next,
    agentId: null,
    paneId: null,
    transport: null,
    incarnation: null,
    runs: null,
    detail: null,
  });
}
