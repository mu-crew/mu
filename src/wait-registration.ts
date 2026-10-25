// mu — wait registrations: what a caller still owes a wait.
//
// `wait_registrations` (machine-local, one row per caller) holds the typed
// refs that a later `mu wait` must still answer: the tasks, agents and
// delegate calls this caller started. Two jobs, both small:
//
//   1. Registration. `registerOwnedWait` merges real, validated refs into
//      the caller's row (deduped, in one canonical order). Refs come from
//      mu's own producers as typed values, never from parsing a shell line.
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
import { isValidWorkstreamName } from "./workstream.js";

export const WAIT_REF_KINDS = ["task", "agent", "delegate"] as const;
export type WaitRefKind = (typeof WAIT_REF_KINDS)[number];

/** One owed ref: a task or agent of a workstream, or a delegate call id. */
export interface RegisteredRef {
  kind: WaitRefKind;
  workstream: string;
  id: string;
}

export const WAIT_REGISTRATION_STATES = ["armed", "waiting"] as const;
export type WaitRegistrationState = (typeof WAIT_REGISTRATION_STATES)[number];

export interface WaitRegistration {
  caller: string;
  /** Canonical order: kind, workstream, id. */
  refs: RegisteredRef[];
  state: WaitRegistrationState;
  /** Bumped by every `beginWait`; never decreases. */
  generation: number;
  updatedAt: string;
}

/** The most refs one caller may owe at once. */
export const WAIT_REGISTRATION_MAX_REFS = 256;

/** A caller, ref or registration mu refuses or cannot read. */
export class WaitRegistrationError extends Error {
  override readonly name = "WaitRegistrationError";
}

// A delegate call id is minted by mu (a short token); accept that alphabet only.
const DELEGATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CALLER_MAX = 200;

function checkCaller(caller: string): void {
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
        : DELEGATE_ID_RE.test(ref.id));
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
    updatedAt: row.updated_at,
  };
}

const select = (db: Db, caller: string): Row | undefined =>
  db
    .prepare(
      "SELECT caller, refs_json, state, generation, updated_at FROM wait_registrations WHERE caller = ?",
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
 * when it ends. Refuses the whole call (nothing stored) on a bad caller,
 * a bad or unknown ref, an empty list, or more than
 * WAIT_REGISTRATION_MAX_REFS refs owed in total.
 */
export function registerOwnedWait(
  db: Db,
  caller: string,
  refs: readonly RegisteredRef[],
): WaitRegistration {
  checkCaller(caller);
  if (refs.length === 0) throw new WaitRegistrationError("wait registration: no refs to register");
  const add = canonical(refs);
  return db
    .transaction((): WaitRegistration => {
      const row = select(db, caller);
      const have = row === undefined ? [] : parse(row).refs;
      const merged = canonical([...have, ...add]);
      if (merged.length > WAIT_REGISTRATION_MAX_REFS) {
        throw new WaitRegistrationError(
          `wait registration: at most ${WAIT_REGISTRATION_MAX_REFS} refs may be owed at once (${caller} would owe ${merged.length})`,
        );
      }
      const now = new Date().toISOString();
      if (row === undefined) {
        db.prepare(
          "INSERT INTO wait_registrations (caller, refs_json, state, generation, updated_at) VALUES (?, ?, 'armed', 0, ?)",
        ).run(caller, JSON.stringify(merged), now);
      } else if (merged.length !== have.length) {
        db.prepare(
          "UPDATE wait_registrations SET refs_json = ?, updated_at = ? WHERE caller = ?",
        ).run(JSON.stringify(merged), now, caller);
      }
      const after = select(db, caller);
      if (after === undefined) throw new WaitRegistrationError("wait registration vanished");
      return parse(after);
    })
    .immediate();
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
): { generation: number; refs: RegisteredRef[] } | undefined {
  return db
    .transaction((): { generation: number; refs: RegisteredRef[] } | undefined => {
      const row = select(db, caller);
      if (row === undefined) return undefined;
      const reg = parse(row);
      if (reg.refs.length === 0) return undefined;
      const generation = reg.generation + 1;
      db.prepare(
        "UPDATE wait_registrations SET state = 'waiting', generation = ?, updated_at = ? WHERE caller = ?",
      ).run(generation, new Date().toISOString(), caller);
      return { generation, refs: reg.refs };
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
      const left = parse(row).refs.filter((r) => !gone.has(keyOf(r)));
      db.prepare(
        "UPDATE wait_registrations SET refs_json = ?, state = 'armed', updated_at = ? WHERE caller = ?",
      ).run(JSON.stringify(left), new Date().toISOString(), caller);
      return { applied: true };
    })
    .immediate();
}
