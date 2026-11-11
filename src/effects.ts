// mu — the effects journal (plugins spec D4, D5): every plugin effect, written
// ahead with its exact request, and its one recorded outcome.
//
// An effect is a plugin call that changes something outside mu's DB
// (`host.acquire`/`release`, `job.start`/`stop`, the channel deliveries). Its
// row commits in ONE immediate transaction with the subject's own change,
// before the call: a mu-generated key, the method's `params` exactly as first
// sent (the envelope id and `deadline` are fresh per send, never part of it),
// the plugin's handshake instance, the creator (pid and start time) and the
// plugin's process group. The definite result is recorded on the subject and
// the row deleted in the same transaction, so only unresolved effects stay.
//
// Ownership. While its creator lives, a `pending` row is the creator's: a
// second verb's claim refuses, naming it. A resolver claims an `unknown` row,
// a `pending` one whose creator is proven gone, or a `resolving` one whose
// resolver is proven gone, by compare-and-set. The creator records with
// `state = 'pending'`, a resolver with its own pid: a loser's write changes
// nothing, so one result is ever recorded.
//
// Deliveries. Each agent's `delivery_seq` is a durable high-water mark: a
// delivery effect (an at-start `job.start` carrying the first prompt included:
// it takes seq 1) increments it in its intent's transaction and keeps the new
// value (`seq`). A resend is allowed only while `seq` is still the mark (no
// newer delivery was written), and a new delivery refuses while another to the
// agent is being resolved. SQLite's write lock serializes both rules.
//
// Built-in effects keep their own journals; nothing here is used without a plugin.

import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { groupAlive, pidProvenGone, pidStart } from "./hosts.js";

export type EffectSubjectKind = "host" | "job" | "delivery";
export type EffectState = "pending" | "resolving" | "unknown";

/** An `effects` row (D5). Times are epoch ms. */
export interface EffectRow {
  key: string;
  subject_kind: EffectSubjectKind;
  /** The host record's id, the job record's token, or the agent's registry id. */
  subject_id: string;
  msg_id: string | null;
  seq: number | null;
  plugin: string;
  method: string;
  params_json: string;
  params_sha: string;
  instance: string;
  state: EffectState;
  creator_pid: number;
  creator_start: string | null;
  plugin_pgid: number;
  plugin_pgid_start: string | null;
  resolver_pid: number | null;
  resolver_start: string | null;
  created_at: number;
  updated_at: number;
}

/** `agentId` on a job: an at-start `job.start` carrying its agent's first prompt (a delivery, D4). */
export type EffectSubject =
  | { kind: "host" | "job"; id: string; msgId?: string; agentId?: number }
  | { kind: "delivery"; agentId: number; msgId: string };

/** The tokens of agent `@agent`'s job records, by its name (a placeholder is bound to none yet). */
const AGENT_JOBS = `SELECT c.token FROM carrier_jobs c JOIN workstreams w ON w.name = c.workstream
  JOIN agents a ON a.workstream_id = w.id AND a.name = c.name WHERE a.id = @agent`;

/** The delivery effects of agent `@agent` (`@sid`, as text): its sends, and its first prompt's `job.start`. */
const AGENT_DELIVERIES = `seq IS NOT NULL AND ((subject_kind = 'delivery' AND subject_id = @sid)
  OR (subject_kind = 'job' AND subject_id IN (${AGENT_JOBS})))`;

export interface EffectIntent {
  key: string;
  subject: EffectSubject;
  plugin: string;
  method: string;
  params: Record<string, unknown>;
  /** The plugin process the call goes to: its handshake instance and its group. */
  instance: string;
  pgid: number;
  pgidStart: string | null;
}

/** Another invocation owns the effect: its creator is still in its call, or a resolver is. Exit 4. */
export class EffectHeldError extends Error {
  override readonly name = "EffectHeldError";
  constructor(
    public readonly key: string,
    public readonly by: "creator" | "resolver",
    public readonly pid: number,
  ) {
    super(
      by === "creator"
        ? `effect ${key} is in flight: its creator, pid ${pid}, is still in its call`
        : `effect ${key} is being resolved by pid ${pid}`,
    );
  }
}

/** A new delivery while another to the same agent is being resolved (D4). Exit 4. */
export class DeliveryResolvingError extends Error {
  override readonly name = "DeliveryResolvingError";
  constructor(
    public readonly agentId: number,
    public readonly key: string,
  ) {
    super(`a delivery to this agent (effect ${key}) is being resolved: try again once it is`);
  }
}

type Owner = { pid: number; start: string | null };
let ownerForTests: Owner | undefined;

/** TEST SEAM: act as another process (a crashed creator's pid, or a second mu). */
export function setEffectOwnerForTests(o: Owner | undefined): void {
  ownerForTests = o;
}

/** This invocation, as a creator or resolver. */
export function effectOwner(): Owner {
  return ownerForTests ?? { pid: process.pid, start: pidStart(process.pid) };
}

/** The persisted request's bytes and their digest. */
export function paramsDigest(params: Record<string, unknown>): { json: string; sha: string } {
  const json = JSON.stringify(params);
  return { json, sha: `sha256:${createHash("sha256").update(json).digest("hex")}` };
}

export function getEffect(db: Db, key: string): EffectRow | undefined {
  return db.prepare("SELECT * FROM effects WHERE key = ?").get(key) as EffectRow | undefined;
}

/** Every unresolved effect on a subject (a delivery's subject id is the agent's registry id). */
export function effectsOf(db: Db, kind: EffectSubjectKind, id: string): EffectRow[] {
  return db
    .prepare("SELECT * FROM effects WHERE subject_kind = ? AND subject_id = ? ORDER BY created_at")
    .all(kind, id) as EffectRow[];
}

/** Every unresolved effect on plugin `name`'s calls (`mu plugin rm` refuses over them). */
export function effectsOfPlugin(db: Db, name: string): EffectRow[] {
  return db.prepare("SELECT * FROM effects WHERE plugin = ? ORDER BY key").all(name) as EffectRow[];
}

/**
 * Write the intent ahead of the call, with `alongside` (the subject's own change) in the same
 * immediate transaction; a subject it creates (a host record) returns its id. A delivery takes
 * the agent's next `delivery_seq`, and refuses while another delivery to the agent is being
 * resolved.
 */
export function writeEffect(db: Db, e: EffectIntent, alongside?: () => unknown): EffectRow {
  const { json, sha } = paramsDigest(e.params);
  const me = effectOwner();
  return db
    .transaction(() => {
      const created = alongside?.();
      const subjectId =
        e.subject.kind === "delivery"
          ? String(e.subject.agentId)
          : typeof created === "string"
            ? created
            : e.subject.id;
      let seq: number | null = null;
      const agent = e.subject.agentId;
      if (agent !== undefined) {
        const busy = db
          .prepare(`SELECT key FROM effects WHERE state = 'resolving' AND ${AGENT_DELIVERIES}`)
          .get({ agent, sid: String(agent) }) as { key: string } | undefined;
        if (busy !== undefined) throw new DeliveryResolvingError(agent, busy.key);
        const r = db
          .prepare(
            "UPDATE agents SET delivery_seq = delivery_seq + 1 WHERE id = ? RETURNING delivery_seq",
          )
          .get(agent) as { delivery_seq: number } | undefined;
        if (r === undefined) throw new Error(`no agent row ${agent} for a delivery`);
        seq = r.delivery_seq;
      }
      const now = Date.now();
      db.prepare(
        `INSERT INTO effects (key, subject_kind, subject_id, msg_id, seq, plugin, method, params_json, params_sha,
           instance, state, creator_pid, creator_start, plugin_pgid, plugin_pgid_start, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.key,
        e.subject.kind,
        subjectId,
        e.subject.msgId ?? null,
        seq,
        e.plugin,
        e.method,
        json,
        sha,
        e.instance,
        me.pid,
        me.start,
        e.pgid,
        e.pgidStart,
        now,
        now,
      );
      return getEffect(db, e.key) as EffectRow;
    })
    .immediate();
}

/** The owner clause: the creator while `pending`, the resolver while `resolving`. */
const OWNED = `((state = 'pending' AND creator_pid = @pid AND creator_start IS @start)
  OR (state = 'resolving' AND resolver_pid = @pid AND resolver_start IS @start))`;

/**
 * The definite outcome: delete the row and run `record` (the subject's change) in one
 * transaction, only while this invocation owns it. False, and nothing recorded, otherwise.
 */
export function settleEffect(db: Db, key: string, record?: () => void): boolean {
  const me = effectOwner();
  return db
    .transaction(() => {
      const r = db
        .prepare(`DELETE FROM effects WHERE key = @key AND ${OWNED}`)
        .run({ key, pid: me.pid, start: me.start });
      if (r.changes !== 1) return false;
      record?.();
      return true;
    })
    .immediate();
}

/** No definite outcome: the row stays, `unknown`, for the next verb (its owner only). */
export function leaveEffectUnknown(db: Db, key: string): boolean {
  const me = effectOwner();
  return (
    db
      .prepare(
        `UPDATE effects SET state = 'unknown', resolver_pid = NULL, resolver_start = NULL, updated_at = @now
         WHERE key = @key AND ${OWNED}`,
      )
      .run({ key, pid: me.pid, start: me.start, now: Date.now() }).changes === 1
  );
}

/** Proven gone, by pid and start time. */
export const creatorGone = (r: EffectRow): boolean => pidProvenGone(r.creator_pid, r.creator_start);

/** The plugin process group the row was sent to is proven gone. */
export const pluginGroupGone = (r: EffectRow): boolean =>
  !groupAlive(r.plugin_pgid, r.plugin_pgid_start);

/**
 * Claim the row for resolving (D4 step 1), compare-and-set. Refuses with EffectHeldError while
 * its creator (a `pending` row) or its resolver (a `resolving` one) lives. `newest`: no later
 * delivery to the agent was written (always true for a row with no `seq`: a host's, or a job's
 * that carries no first prompt), read in the claim.
 * Undefined when the row is gone (resolved meanwhile).
 */
export function claimEffect(db: Db, key: string): { row: EffectRow; newest: boolean } | undefined {
  const me = effectOwner();
  return db
    .transaction(() => {
      const row = getEffect(db, key);
      if (row === undefined) return undefined;
      refuseLiveOwner(row);
      const now = Date.now();
      db.prepare(
        "UPDATE effects SET state = 'resolving', resolver_pid = ?, resolver_start = ?, updated_at = ? WHERE key = ? AND state = ?",
      ).run(me.pid, me.start, now, key, row.state);
      let newest = true;
      if (row.seq !== null) {
        const a = db
          .prepare(
            row.subject_kind === "delivery"
              ? "SELECT delivery_seq FROM agents WHERE id = ?"
              : `SELECT a.delivery_seq FROM carrier_jobs c JOIN workstreams w ON w.name = c.workstream
                 JOIN agents a ON a.workstream_id = w.id AND a.name = c.name WHERE c.token = ?`,
          )
          .get(row.subject_id) as { delivery_seq: number } | undefined;
        newest = a !== undefined && a.delivery_seq === row.seq;
      }
      return {
        row: {
          ...row,
          state: "resolving" as const,
          resolver_pid: me.pid,
          resolver_start: me.start,
        },
        newest,
      };
    })
    .immediate();
}

/** Refuse (`EffectHeldError`) while the row's creator (`pending`) or resolver (`resolving`) lives. */
export function refuseLiveOwner(r: EffectRow): void {
  if (r.state === "pending" && !creatorGone(r)) {
    throw new EffectHeldError(r.key, "creator", r.creator_pid);
  }
  if (
    r.state === "resolving" &&
    r.resolver_pid !== null &&
    !pidProvenGone(r.resolver_pid, r.resolver_start)
  ) {
    throw new EffectHeldError(r.key, "resolver", r.resolver_pid);
  }
}

/** Drop a row without an outcome: an abandon, or a job lost with its host (the caller logs it). */
export function deleteEffect(db: Db, key: string): void {
  db.prepare("DELETE FROM effects WHERE key = ?").run(key);
}

/**
 * The unresolved deliveries to agent incarnation `agentId`, dropped as its row goes (a close, the
 * reaper): no verb can resolve a delivery to an agent that is gone. Returned for the caller's
 * loss record, written in the same transaction.
 */
export function dropDeliveries(db: Db, agentId: number): EffectRow[] {
  return db
    .prepare("DELETE FROM effects WHERE subject_kind = 'delivery' AND subject_id = ? RETURNING *")
    .all(String(agentId)) as EffectRow[];
}
