// mu — wait registrations: what a caller still owes a wait.
//
// `wait_registrations` (machine-local, one row per caller) holds the typed
// refs that a later `mu wait` must still answer: the tasks, agents and
// delegate calls this caller started. Two jobs, both small:
//
//   1. Registration. `registerOwnedWait` merges real refs into the caller's
//      row (deduped, in one canonical order): each must name an entity that
//      exists when it is registered. Refs come from mu's own producers as
//      typed values, never from parsing a shell line.
//   2. One active wait per caller. `beginWait` bumps the row's `generation`
//      and marks it `waiting`; `endWait` is a compare-and-set on that
//      generation, so an older wait that finishes late (or twice) cannot
//      overwrite a newer one. A wait that died leaves `waiting` behind:
//      the next `beginWait` simply supersedes it.
//
// What this module does NOT do: it never records consumed runs (that is
// `wait_cursors`, written by the wait that delivers an event), so
// registering or beginning a wait cannot lose an unreturned event. `endWait`
// removes only the refs the wait actually DELIVERED; an undelivered sibling,
// a timeout or an interrupt leaves every ref owed.
//
// Every write is one short synchronous BEGIN IMMEDIATE transaction. None
// spans an await, so no write lock is held while a wait sleeps.

import { isValidAgentName } from "./agents.js";
import { compareStrings } from "./compare.js";
import type { Db } from "./db.js";
import { isValidTaskId } from "./tasks/id.js";
import { cursorKey } from "./wait-cursor.js";
import { isValidWorkstreamName } from "./workstream.js";

export const WAIT_REF_KINDS = ["task", "agent", "delegate"] as const;
export type WaitRefKind = (typeof WAIT_REF_KINDS)[number];

/** One owed ref: a task or agent of a workstream, or a delegate call id. */
export interface RegisteredRef {
  kind: WaitRefKind;
  workstream: string;
  id: string;
}

/**
 * The UNCONSUMED run baseline of an agent ref: what a producer (`send`,
 * `spawn`, `claim`) saw BEFORE its effect: the ctl run count, pi's process
 * incarnation and the registry id. A wait counts the agent's runs from here, so
 * a send that settles before any wait starts is still caught. Distinct from a
 * consumed cursor (`wait_cursors`), which says what a wait already delivered.
 */
export interface RefBaseline {
  afterRuns: number;
  incarnation?: string;
  agentId?: number;
}

/** A ref to register, with its baseline when it is an agent. */
export type RegisterRef = RegisteredRef & { baseline?: RefBaseline };

export const WAIT_REGISTRATION_STATES = ["armed", "waiting"] as const;
export type WaitRegistrationState = (typeof WAIT_REGISTRATION_STATES)[number];

export interface WaitRegistration {
  caller: string;
  /** Canonical order: kind, workstream, id. */
  refs: RegisteredRef[];
  state: WaitRegistrationState;
  /** Bumped by every `beginWait`; never decreases. */
  generation: number;
  /** Unconsumed baselines of agent refs, by `cursorKey("agent", ws, name)`. */
  baselines: Record<string, RefBaseline>;
  updatedAt: string;
}

/** The most refs one caller may owe at once. */
export const WAIT_REGISTRATION_MAX_REFS = 256;

/** A caller, ref or registration mu refuses or cannot read. */
export class WaitRegistrationError extends Error {
  override readonly name = "WaitRegistrationError";
}

const CALLER_MAX = 200;
const ID_MAX = 512;

/** Throws WaitRegistrationError unless `caller` is 1-200 printable characters. */
export function checkCaller(caller: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (caller.trim() === "" || caller.length > CALLER_MAX || /[\u0000-\u001f\u007f]/.test(caller)) {
    throw new WaitRegistrationError(
      `wait registration: caller must be 1-${CALLER_MAX} printable characters`,
    );
  }
}

function checkRef(ref: RegisteredRef): void {
  const where = `${ref.kind}:${ref.workstream}/${ref.id}`;
  if (!(WAIT_REF_KINDS as readonly string[]).includes(ref.kind)) {
    throw new WaitRegistrationError(`wait registration: unknown ref kind in ${where}`);
  }
  if (typeof ref.workstream !== "string" || !isValidWorkstreamName(ref.workstream)) {
    throw new WaitRegistrationError(`wait registration: bad workstream in ${where}`);
  }
  const ok =
    typeof ref.id === "string" &&
    (ref.kind === "task"
      ? isValidTaskId(ref.id)
      : ref.kind === "agent"
        ? isValidAgentName(ref.id)
        : ref.id !== "" && ref.id.length <= ID_MAX); // a call id is whatever delegate_calls stores
  if (!ok) throw new WaitRegistrationError(`wait registration: bad ${ref.kind} id in ${where}`);
}

const keyOf = (r: RegisteredRef): string => `${r.kind}\n${r.workstream}\n${r.id}`;

function compareRefs(a: RegisteredRef, b: RegisteredRef): number {
  return (
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.workstream, b.workstream) ||
    compareStrings(a.id, b.id)
  );
}

/**
 * Refuse the first ref (canonical order) whose entity does not exist now:
 * the workstream, the task or agent in it, or the delegate call exactly as
 * `delegate_calls.call_id` stores it (and its task in that workstream).
 * Called inside the registering transaction.
 */
function checkRefsExist(db: Db, refs: readonly RegisteredRef[]): void {
  const hasWorkstream = db.prepare("SELECT 1 FROM workstreams WHERE name = ?");
  const hasTask = db.prepare(
    "SELECT 1 FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND t.local_id = ?",
  );
  const hasAgent = db.prepare(
    "SELECT 1 FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE w.name = ? AND a.name = ?",
  );
  const hasCall = db.prepare(
    "SELECT 1 FROM delegate_calls d JOIN tasks t ON t.id = d.task_id JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND d.call_id = ?",
  );
  for (const ref of refs) {
    const where = `${ref.kind} ${ref.workstream}/${ref.id}`;
    if (hasWorkstream.get(ref.workstream) === undefined) {
      throw new WaitRegistrationError(
        `wait registration: no workstream ${ref.workstream} (for ${where}); nothing registered`,
      );
    }
    const stmt = ref.kind === "task" ? hasTask : ref.kind === "agent" ? hasAgent : hasCall;
    if (stmt.get(ref.workstream, ref.id) === undefined) {
      throw new WaitRegistrationError(`wait registration: no ${where}; nothing registered`);
    }
  }
}

/** Validate, dedupe and order `refs` (copies; the input is not touched). */
function canonical(refs: readonly RegisteredRef[]): RegisteredRef[] {
  const seen = new Map<string, RegisteredRef>();
  for (const ref of refs) {
    checkRef(ref);
    seen.set(keyOf(ref), { kind: ref.kind, workstream: ref.workstream, id: ref.id });
  }
  return [...seen.values()].sort(compareRefs);
}

interface Row {
  caller: string;
  refs_json: string;
  state: WaitRegistrationState;
  generation: number;
  updated_at: string;
  baselines_json: string;
}

function parseBaselines(json: string, refs: readonly RegisteredRef[]): Record<string, RefBaseline> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const live = new Set(refs.filter((r) => r.kind === "agent").map((r) => refKeyOf(r)));
  const out: Record<string, RefBaseline> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const b = v as Partial<RefBaseline> | null;
    if (!live.has(k) || b === null || typeof b !== "object") continue;
    if (typeof b.afterRuns !== "number" || !Number.isInteger(b.afterRuns) || b.afterRuns < 0)
      continue;
    out[k] = {
      afterRuns: b.afterRuns,
      ...(typeof b.incarnation === "string" ? { incarnation: b.incarnation } : {}),
      ...(typeof b.agentId === "number" ? { agentId: b.agentId } : {}),
    };
  }
  return out;
}

const refKeyOf = (r: RegisteredRef): string => cursorKey(r.kind, r.workstream, r.id);

/** Merge a new baseline into an old one: the EARLIEST run of one incarnation wins; a new incarnation replaces. */
function mergeBaseline(old: RefBaseline | undefined, add: RefBaseline): RefBaseline {
  if (old === undefined || old.incarnation !== add.incarnation || old.agentId !== add.agentId) {
    return add;
  }
  return old.afterRuns <= add.afterRuns ? old : add;
}

function parse(row: Row): WaitRegistration {
  let raw: unknown;
  try {
    raw = JSON.parse(row.refs_json);
  } catch {
    throw new WaitRegistrationError(`wait registration for ${row.caller}: refs_json is not JSON`);
  }
  if (!Array.isArray(raw)) {
    throw new WaitRegistrationError(`wait registration for ${row.caller}: refs_json is not a list`);
  }
  const refs = canonical(raw as RegisteredRef[]);
  return {
    caller: row.caller,
    refs,
    state: row.state,
    generation: row.generation,
    baselines: parseBaselines(row.baselines_json, refs),
    updatedAt: row.updated_at,
  };
}

const select = (db: Db, caller: string): Row | undefined =>
  db
    .prepare(
      "SELECT caller, refs_json, state, generation, updated_at, baselines_json FROM wait_registrations WHERE caller = ?",
    )
    .get(caller) as Row | undefined;

/** The caller's registration, or undefined when it never registered anything. */
export function readWaitRegistration(db: Db, caller: string): WaitRegistration | undefined {
  const row = select(db, caller);
  return row === undefined ? undefined : parse(row);
}

/**
 * Add `refs` to what `caller` owes a wait. Merges with the refs already
 * owed (deduped, canonical order) and keeps `state` and `generation`, so
 * registering while a wait is in flight neither disturbs it nor is lost
 * when it ends. Every ref must exist now (checked in the same transaction
 * that writes); a ref whose entity is deleted LATER stays owed. Refuses the
 * whole call (nothing stored) on a bad caller, a bad or missing ref, an
 * empty list, or more than
 * WAIT_REGISTRATION_MAX_REFS refs owed in total.
 */
export function registerOwnedWait(
  db: Db,
  caller: string,
  refs: readonly RegisterRef[],
): WaitRegistration {
  checkCaller(caller);
  if (refs.length === 0) throw new WaitRegistrationError("wait registration: no refs to register");
  const add = canonical(refs);
  const incoming = new Map<string, RefBaseline>();
  for (const r of refs) {
    if (r.baseline === undefined) continue;
    if (r.kind !== "agent") {
      throw new WaitRegistrationError(
        `wait registration: only an agent ref has a run baseline (${r.kind}:${r.workstream}/${r.id})`,
      );
    }
    const b = r.baseline;
    if (!Number.isInteger(b.afterRuns) || b.afterRuns < 0) {
      throw new WaitRegistrationError(
        `wait registration: baseline afterRuns must be a non-negative integer (${r.workstream}/${r.id})`,
      );
    }
    const key = refKeyOf(r);
    incoming.set(key, mergeBaseline(incoming.get(key), b));
  }
  return db
    .transaction((): WaitRegistration => {
      checkRefsExist(db, add);
      const row = select(db, caller);
      const old = row === undefined ? undefined : parse(row);
      const have = old?.refs ?? [];
      const merged = canonical([...have, ...add]);
      if (merged.length > WAIT_REGISTRATION_MAX_REFS) {
        throw new WaitRegistrationError(
          `wait registration: at most ${WAIT_REGISTRATION_MAX_REFS} refs may be owed at once (${caller} would owe ${merged.length})`,
        );
      }
      const baselines: Record<string, RefBaseline> = { ...(old?.baselines ?? {}) };
      for (const [k, b] of incoming) baselines[k] = mergeBaseline(baselines[k], b);
      const now = new Date().toISOString();
      const baselinesJson = JSON.stringify(baselines);
      if (row === undefined) {
        db.prepare(
          "INSERT INTO wait_registrations (caller, refs_json, state, generation, updated_at, baselines_json) VALUES (?, ?, 'armed', 0, ?, ?)",
        ).run(caller, JSON.stringify(merged), now, baselinesJson);
      } else if (merged.length !== have.length || baselinesJson !== row.baselines_json) {
        db.prepare(
          "UPDATE wait_registrations SET refs_json = ?, baselines_json = ?, updated_at = ? WHERE caller = ?",
        ).run(JSON.stringify(merged), baselinesJson, now, caller);
      }
      const after = select(db, caller);
      if (after === undefined) throw new WaitRegistrationError("wait registration vanished");
      return parse(after);
    })
    .immediate();
}

/**
 * Store `baseline` as the unconsumed fence of an owed agent ref that has none
 * (a ref registered with no producer baseline: the first wait probed the run
 * count and counts from it), or whose stored fence belongs to another process
 * or registry row. A no-op when the ref is not owed or the fence is usable. Touches neither `state` nor `generation`, so it never disturbs a
 * wait in flight.
 */
export function fenceAgentRef(
  db: Db,
  caller: string,
  ref: RegisteredRef,
  baseline: RefBaseline,
): void {
  db.transaction(() => {
    const row = select(db, caller);
    if (row === undefined) return;
    const reg = parse(row);
    const key = refKeyOf(ref);
    if (!reg.refs.some((r) => refKeyOf(r) === key)) return;
    // The same fence (or an earlier one of the same process) stays; a baseline of
    // another process or registry row, which no wait could use, is replaced.
    const merged = mergeBaseline(reg.baselines[key], baseline);
    if (merged === reg.baselines[key]) return;
    db.prepare("UPDATE wait_registrations SET baselines_json = ? WHERE caller = ?").run(
      JSON.stringify({ ...reg.baselines, [key]: merged }),
      caller,
    );
  }).immediate();
}

/**
 * Start a wait for `caller`: bump the generation, mark the row `waiting`,
 * return the generation and the refs owed now. undefined (and nothing
 * written) when the caller owes nothing. An earlier wait still marked
 * `waiting` is superseded: its `endWait` will no longer match.
 */
export function beginWait(
  db: Db,
  caller: string,
):
  | { generation: number; refs: RegisteredRef[]; baselines: Record<string, RefBaseline> }
  | undefined {
  return db
    .transaction(() => {
      const row = select(db, caller);
      if (row === undefined) return undefined;
      const reg = parse(row);
      if (reg.refs.length === 0) return undefined;
      const generation = reg.generation + 1;
      db.prepare(
        "UPDATE wait_registrations SET state = 'waiting', generation = ?, updated_at = ? WHERE caller = ?",
      ).run(generation, new Date().toISOString(), caller);
      return { generation, refs: reg.refs, baselines: reg.baselines };
    })
    .immediate();
}

/**
 * Finish the wait that `beginWait` numbered `generation`: drop the
 * `delivered` refs from what is owed and re-arm the row. A compare-and-set:
 * `applied: false` (and nothing written) when the row is gone, a newer wait
 * started, or this generation already ended. Refs registered since
 * `beginWait`, and refs not delivered, stay owed. The row is kept even when
 * nothing is left, so generations never restart.
 */
export function endWait(
  db: Db,
  caller: string,
  generation: number,
  delivered: readonly RegisteredRef[],
): { applied: boolean } {
  return db
    .transaction((): { applied: boolean } => {
      const gone = new Set(canonical(delivered).map(keyOf));
      const row = select(db, caller);
      if (row === undefined || row.generation !== generation || row.state !== "waiting") {
        return { applied: false };
      }
      const reg = parse(row);
      const left = reg.refs.filter((r) => !gone.has(keyOf(r)));
      const kept = Object.fromEntries(
        Object.entries(reg.baselines).filter(([k]) => left.some((r) => refKeyOf(r) === k)),
      );
      db.prepare(
        "UPDATE wait_registrations SET refs_json = ?, baselines_json = ?, state = 'armed', updated_at = ? WHERE caller = ?",
      ).run(JSON.stringify(left), JSON.stringify(kept), new Date().toISOString(), caller);
      return { applied: true };
    })
    .immediate();
}
