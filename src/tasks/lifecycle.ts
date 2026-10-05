// mu — task lifecycle verbs: setTaskStatus, closeTask, openTask.
//
// Lifecycle = "transition a task from one status to another, with
// the right captured-op and evidence-note side effects".
//
// EvidenceOption is shared with claim/release (in tasks/claim.ts) and
// re-exported here as the canonical home; claim.ts imports from this
// file.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { Db } from "../db.js";
import { withOpContext } from "../op-context.js";
import { taskIdFor } from "./core.js";
import { getTaskEdgesWithStatus } from "./edges.js";
import { addNote, insertNote } from "./edit.js";
import {
  InvalidSubstateError,
  SubstateReasonRequiredError,
  TaskNotFoundError,
  TaskParkStateError,
} from "./errors.js";
import { getTask, listNotes } from "./queries.js";
import {
  DEFAULT_SUBSTATE,
  isValidPair,
  type TASK_SUBSTATES,
  type TaskStatus,
  type TaskSubstate,
} from "./status.js";

export interface SetStatusResult {
  /** Status before the call. */
  previousStatus: TaskStatus;
  /** Status after the call (== requested status). */
  status: TaskStatus;
  /** Substate before the call. */
  previousSubstate: TaskSubstate;
  /** Substate after the call (== requested substate, or the status default). */
  substate: TaskSubstate;
  /** True iff status OR substate changed. False on idempotent no-op. */
  changed: boolean;
}

/** The substates a task can be closed as (`mu task close --as`). */
export type CloseSubstate = (typeof TASK_SUBSTATES)["CLOSED"][number];

/**
 * Optional evidence string carried on lifecycle verbs (close / open /
 * claim / release). Lands in the auto-emitted `kind='event'` payload
 * verbatim, prefixed with `evidence=`. The first inch of distinguishing
 * "observed" from "claimed" state per an internal critique: the
 * verb still trusts the caller (it's not a verifier), but the audit
 * trail records what the caller said it relied on.
 */
export interface EvidenceOption {
  evidence?: string;
}

/** Evidence plus the actor its note is attributed to. The CLI passes
 *  `resolveActorIdentity()`; without it the note has no author and
 *  renders as `<orchestrator>`. */
export interface AttributedEvidence extends EvidenceOption {
  author?: string;
}

/**
 * Persist `--evidence` as a task note, so it survives as a captured op.
 *
 * mu once put evidence in the prose event payload AND (for close only) in a
 * synthetic note. v2-retire-log-shim deleted the prose events, which
 * would have silently dropped evidence on open/release. The note is now
 * the single home for it: notes are portable and sync, whereas the prose
 * event was machine-local and unparseable.
 *
 * Only fires when the verb actually changed something (an idempotent
 * re-close attests nothing new) and the evidence is a non-empty string.
 */
export function recordEvidenceNote(
  db: Db,
  localId: string,
  workstream: string,
  label: string,
  opts: AttributedEvidence | undefined,
): void {
  if (!opts || opts.evidence === undefined || opts.evidence === "") return;
  const noteOpts: { author?: string; workstream: string } = { workstream };
  if (opts.author !== undefined && opts.author !== "") noteOpts.author = opts.author;
  addNote(db, localId, `${label}: ${opts.evidence}`, noteOpts);
}

/** Render the optional `--evidence "<text>"` payload as the trailing
 *  ' evidence="..."' on every state-changing event. Exported because
 *  claimTask/releaseTask in src/tasks/claim.ts also use it. */
export function evidenceSuffix(opts: EvidenceOption | undefined): string {
  if (!opts || opts.evidence === undefined) return "";
  return ` evidence=${JSON.stringify(opts.evidence)}`;
}

export interface SetStatusOptions extends EvidenceOption {
  workstream: string;
  /** Substate to land on; defaults to DEFAULT_SUBSTATE[status]. A pair
   *  outside TASK_SUBSTATES throws InvalidSubstateError before any write. */
  substate?: TaskSubstate;
}

/**
 * Flip a task's status to any of OPEN / IN_PROGRESS / CLOSED, writing
 * status and substate in ONE UPDATE (one op, one HLC — spec D7).
 * Idempotent: setting a task to its current pair is a no-op (returns
 * `changed: false`) rather than throwing. Owner is unchanged.
 */
export function setTaskStatus(
  db: Db,
  localId: string,
  status: TaskStatus,
  opts: SetStatusOptions,
): SetStatusResult {
  // NOTE: no `group` here, so a nested call inherits the enclosing
  // group. A direct call with no enclosing context still gets its own
  // group (withOpContext mints one).
  //
  // `intentIfUnset` (not `intent`): when reached via closeTask, the
  // outer verb is the label the operator recognises, so it must win.
  // Only a direct setTaskStatus call labels itself.
  return withOpContext(db, { intentIfUnset: `task.set-${status.toLowerCase()}` }, () =>
    setTaskStatusImpl(db, localId, status, opts),
  );
}

function setTaskStatusImpl(
  db: Db,
  localId: string,
  status: TaskStatus,
  opts: SetStatusOptions,
): SetStatusResult {
  const substate = opts.substate ?? DEFAULT_SUBSTATE[status];
  if (!isValidPair(status, substate)) throw new InvalidSubstateError(status, substate);
  const before = getTask(db, localId, opts.workstream);
  if (!before) throw new TaskNotFoundError(localId);
  const base = {
    previousStatus: before.status,
    status,
    previousSubstate: before.substate,
    substate,
  };
  if (before.status === status && before.substate === substate) {
    return { ...base, changed: false };
  }
  // v5: tasks.local_id is per-workstream unique. Scope to the row's
  // workstream so the UPDATE doesn't accidentally touch a same-named
  // task in another workstream.
  db.prepare(
    `UPDATE tasks SET status = ?, substate = ?, updated_at = ?
      WHERE local_id = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
  ).run(status, substate, new Date().toISOString(), localId, before.workstreamName);
  // No emitEvent: the UPDATE fired the capture trigger, whose intent is
  // the specific verb (task.close / task.open, or task.set-<status> for
  // a bare status set) and whose payload names the new status. Evidence,
  // when passed, lands as a task note — itself a captured op.
  return { ...base, changed: true };
}

/** Result of `closeTask` when called with `ifReady: true` and the
 *  task is NOT yet ready to close (still has at least one OPEN /
 *  IN_PROGRESS blocker). Distinguished from a regular `SetStatusResult`
 *  by the literal `skipped` field; the CLI keys on it to switch
 *  between the "closed" and "waiting" rendering paths.
 *
 *  Surfaced in `fb_umbrella_no_auto_close` (impact=60): a wave umbrella
 *  with N blockers stayed OPEN after every blocker reached a terminal
 *  status. `--if-ready` is the cheap fix: bare `mu task close` is
 *  unchanged (closes regardless), `--if-ready` is a no-op unless every
 *  blocker is CLOSED. */
export interface CloseSkippedResult {
  /** Always 'not_ready' when set; future cause-codes can extend this
   *   without reshaping the JSON payload (the literal-union narrows
   *   safely in the CLI rendering path). */
  skipped: "not_ready";
  /** Status before the call (always the current status, no change). */
  previousStatus: TaskStatus;
  /** Status after the call (== previousStatus, since we no-op). */
  status: TaskStatus;
  /** Substate before (and after) the call. */
  previousSubstate: TaskSubstate;
  substate: TaskSubstate;
  /** Always false on a skip (no row mutated). */
  changed: false;
  /** Local ids of every blocker still in OPEN or IN_PROGRESS, sorted
   *   alphabetically for deterministic rendering. Empty list is
   *   impossible on this branch — the no-op only fires when ≥1
   *   blocker is non-terminal. */
  blockingIds: string[];
}

export interface CloseTaskOptions extends EvidenceOption {
  workstream: string;
  /** When true, no-op the close unless every blocker is CLOSED.
   *   Returns a `CloseSkippedResult` carrying the still-blocking ids;
   *   the CLI renders the skip with a Next: hint pointing at
   *   `mu task wait`. When false / omitted, behaves as bare `closeTask`
   *   (closes regardless of blocker status). */
  ifReady?: boolean;
  /** Optional actor identity attributed to the synthetic `CLOSE: …`
   *  note auto-inserted when `evidence` is non-empty (see closeTask
   *  body). The CLI resolves this via `resolveActorIdentity()` so the
   *  note carries the closing worker's name; SDK callers (tests,
   *  internal use) may omit it (the note then carries no author, same
   *  as a bare `addNote` without `--author`). Surfaced in mufeedback
   *  task_close_evidence_does_not_append_the. */
  author?: string;
  /** Closing substate; default "done". Any CLOSED/* satisfies edges. */
  as?: CloseSubstate;
  /** Required (non-empty) unless `as` is "done"; stored as a
   *  `<AS>: <why>` note in the same op group. */
  why?: string;
}

/** Result of a close that ran (not skipped). */
export interface CloseTaskResult extends SetStatusResult {
  /** Direct same-workstream dependents that entered the `ready` view
   *  because of this close, sorted. Computed only when `as` is not
   *  "done" (spec D3: a non-done close must show what it released);
   *  always [] for a done close. */
  unblocked: string[];
}

/** Convenience: setTaskStatus(db, id, "CLOSED"). Accepts evidence.
 *  Skipped
 *  for the idempotent no-op (already CLOSED) so we don't accumulate
 *  empty-delta snapshots on retry loops.
 *
 *  With `ifReady: true`, returns a `CloseSkippedResult` (no mutation,
 *  no snapshot) when any blocker is still OPEN / IN_PROGRESS. Used by
 *  `mu task close --if-ready` so an orchestrator can fire-and-forget
 *  the umbrella close after every blocker resolves without first
 *  re-querying the graph. */
export function closeTask(
  db: Db,
  localId: string,
  opts: CloseTaskOptions,
): CloseTaskResult | CloseSkippedResult {
  // Validate before any write (and before withOpContext mints a group).
  const as = opts.as ?? "done";
  if (!isValidPair("CLOSED", as)) throw new InvalidSubstateError("CLOSED", as);
  if (as !== "done" && (opts.why === undefined || opts.why.trim() === "")) {
    throw new SubstateReasonRequiredError("close", as, localId);
  }
  return withOpContext(db, { intent: "task.close", actor: opts.author, group: "new" }, () =>
    closeTaskImpl(db, localId, opts),
  );
}

function closeTaskImpl(
  db: Db,
  localId: string,
  opts: CloseTaskOptions,
): CloseTaskResult | CloseSkippedResult {
  const as: CloseSubstate = opts.as ?? "done";
  const before = getTask(db, localId, opts.workstream);
  if (opts.ifReady && before) {
    // Inspect direct blockers only — the umbrella convention is one
    // hop (umbrella -[blocked-by]→ each wave task). If any direct
    // blocker is not CLOSED, the umbrella isn't ready.
    const edges = getTaskEdgesWithStatus(db, localId, before.workstreamName);
    const blocking = edges.blockers
      .filter((e) => e.status !== "CLOSED")
      .map((e) => e.name)
      .sort();
    if (blocking.length > 0) {
      return {
        skipped: "not_ready",
        previousStatus: before.status,
        status: before.status,
        previousSubstate: before.substate,
        substate: before.substate,
        changed: false,
        blockingIds: blocking,
      };
    }
  }
  // No pre-mutation snapshot: v9 dropped the `snapshots` table and
  // rollback is inverse ops over the ops log (`mu undo`).
  return db.transaction((): CloseTaskResult => {
    const track = as !== "done" && before !== undefined;
    const readyBefore = track ? readyDependents(db, localId, before.workstreamName) : [];
    const r = setTaskStatus(db, localId, "CLOSED", {
      workstream: opts.workstream,
      substate: as,
      ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
    });
    if (!r.changed || !before) return { ...r, unblocked: [] };
    recordReasonNote(db, localId, before.workstreamName, as, opts.why, opts.author);
    // mufeedback task_close_evidence_does_not_append_the: evidence must
    // reach `mu task notes <id>` / `mu task show <id>`, not just the log.
    // Since v2-retire-log-shim the note is the ONLY home for it.
    recordEvidenceNote(db, localId, before.workstreamName, "CLOSE", opts);
    const unblocked = track
      ? readyDependents(db, localId, before.workstreamName).filter((n) => !readyBefore.includes(n))
      : [];
    return { ...r, unblocked };
  })();
}

/** Direct dependents of `localId` currently in the `ready` view, sorted.
 *  Edges never cross workstreams, so these are all in `workstream`. */
function readyDependents(db: Db, localId: string, workstream: string): string[] {
  const id = taskIdFor(db, localId, workstream);
  if (id === null) return [];
  const rows = db
    .prepare(
      `SELECT r.local_id AS name FROM task_edges e
         JOIN ready r ON r.id = e.to_task_id
        WHERE e.from_task_id = ? ORDER BY r.local_id`,
    )
    .all(id) as { name: string }[];
  return rows.map((r) => r.name);
}

/** Store a classification's `--why` as a `<SUBSTATE>: <why>` note
 *  (e.g. `WONTFIX: out of scope`). Notes are captured, so it syncs,
 *  and it lands in the enclosing verb's op group. No-op for an empty
 *  reason (a done close needs none). */
function recordReasonNote(
  db: Db,
  localId: string,
  workstream: string,
  substate: TaskSubstate,
  why: string | undefined,
  author: string | undefined,
): void {
  if (why === undefined || why.trim() === "") return;
  const noteOpts: { author?: string; workstream: string } = { workstream };
  if (author !== undefined && author !== "") noteOpts.author = author;
  const text =
    substate === "rejected" || substate === "superseded"
      ? withTitles(db, why, workstream, localId)
      : why;
  // insertNote, not addNote: the note joins the verb's group and
  // intent instead of minting its own, so one undo reverts both.
  insertNote(db, localId, `${substate.toUpperCase()}: ${text}`, noteOpts);
}

/** A token shaped like a task id, not inside a word, path, or file name. */
const TASK_ID_TOKEN = /(?<![\w./-])[a-z][a-z0-9_-]{0,63}(?![\w-])/g;

/** Ids in `text` naming another task in `workstream`. */
function namedTaskIds(db: Db, text: string, workstream: string, self: string): string[] {
  const ids = (text.match(TASK_ID_TOKEN) ?? []).filter((t) => t !== self);
  return [...new Set(ids)].filter((t) => getTask(db, t, workstream) !== undefined);
}

/** Append each named task's title after its id, so a REJECTED /
 *  SUPERSEDED note reads without looking the ids up. Text that names
 *  no task in the workstream is left as is. */
function withTitles(db: Db, why: string, workstream: string, self: string): string {
  const named = new Set(namedTaskIds(db, why, workstream, self));
  if (named.size === 0) return why;
  return why.replace(TASK_ID_TOKEN, (id) => {
    if (!named.has(id)) return id;
    return `${id} (${getTask(db, id, workstream)?.title ?? ""})`;
  });
}

/** Below this many characters a decision reason names no check. */
export const WEAK_REASON_CHARS = 40;

/** A note line recording a verdict: `VERDICT: …`, or the header
 *  `REFUTER <label> (...)` a recorded delegate answer starts with. */
const VERDICT_LINE = /^\s*(VERDICT:|REFUTER\s)/m;

/**
 * Decision-time guardrail for a finding. Returns one warning (or
 * none) for accepting a task in triage (`kind: "accept"`, reason =
 * `--evidence`) or closing it as rejected / wontfix / duplicate
 * (reason = `--why`). Warns only when the task is OPEN/triage, the
 * reason is missing or under {@link WEAK_REASON_CHARS} chars, and no
 * note records a verdict. A duplicate whose reason names an existing
 * task is fine. Read-only: call it before the verb writes.
 */
export function weakDecisionWarning(
  db: Db,
  localId: string,
  workstream: string,
  kind: "accept" | CloseSubstate,
  reason: string | undefined,
): string | undefined {
  if (kind === "done" || kind === "superseded") return undefined;
  const task = getTask(db, localId, workstream);
  if (task?.status !== "OPEN" || task.substate !== "triage") return undefined;
  const trimmed = (reason ?? "").trim();
  if (trimmed.length >= WEAK_REASON_CHARS) return undefined;
  if (kind === "duplicate" && namedTaskIds(db, trimmed, workstream, localId).length > 0) {
    return undefined;
  }
  if (listNotes(db, localId, workstream).some((n) => VERDICT_LINE.test(n.content))) {
    return undefined;
  }
  const flag = kind === "accept" ? "--evidence" : "--why";
  const what = trimmed === "" ? `no ${flag}` : `${flag} is ${trimmed.length} chars`;
  return `${localId}: ${kind === "accept" ? "accepting" : `closing as ${kind}`} a finding with ${what} and no verdict recorded (no VERDICT: line or REFUTER note); record what confirmed it`;
}

/** Convenience: setTaskStatus(db, id, "OPEN"). Owner intentionally NOT
 *  cleared — use `releaseTask` for that. Accepts evidence. */
export function openTask(
  db: Db,
  localId: string,
  opts: AttributedEvidence & { workstream: string },
): SetStatusResult {
  return withOpContext(db, { intent: "task.open", actor: opts.author, group: "new" }, () => {
    const before = getTask(db, localId, opts.workstream);
    const r = setTaskStatus(db, localId, "OPEN", {
      workstream: opts.workstream,
      ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
    });
    if (r.changed && before) recordEvidenceNote(db, localId, before.workstreamName, "OPEN", opts);
    return r;
  });
}

export interface ParkTaskOptions extends EvidenceOption {
  workstream: string;
  /** Required, non-empty; stored as a `PARKED: <why>` note. */
  why: string;
  author?: string;
}

/**
 * OPEN/todo → OPEN/parked: keep the task out of `ready` / `next` and
 * make `claim` refuse it without `--force`. Its dependents stay blocked
 * (parked is still OPEN). Idempotent on OPEN/parked (no second note).
 * Refuses IN_PROGRESS (release first) and CLOSED (open first) — one
 * verb, one transition.
 */
export function parkTask(db: Db, localId: string, opts: ParkTaskOptions): SetStatusResult {
  if (opts.why.trim() === "") throw new SubstateReasonRequiredError("park", "parked", localId);
  return withOpContext(db, { intent: "task.park", actor: opts.author, group: "new" }, () =>
    db.transaction((): SetStatusResult => {
      const before = getTask(db, localId, opts.workstream);
      if (!before) throw new TaskNotFoundError(localId);
      if (before.status !== "OPEN") {
        throw new TaskParkStateError(localId, before.status, before.workstreamName);
      }
      const r = setTaskStatus(db, localId, "OPEN", {
        workstream: opts.workstream,
        substate: "parked",
      });
      if (r.changed) {
        recordReasonNote(db, localId, before.workstreamName, "parked", opts.why, opts.author);
        recordEvidenceNote(db, localId, before.workstreamName, "PARK", opts);
      }
      return r;
    })(),
  );
}

/**
 * OPEN/triage → OPEN/todo: accept a proposed task (a review finding) as
 * real work, back in `ready` / `next`. A no-op (`changed: false`) on any
 * other pair. Declining is `close --as rejected | duplicate --why`.
 */
export function acceptTask(
  db: Db,
  localId: string,
  opts: AttributedEvidence & { workstream: string },
): SetStatusResult {
  return withOpContext(db, { intent: "task.accept", actor: opts.author, group: "new" }, () =>
    db.transaction((): SetStatusResult => {
      const before = getTask(db, localId, opts.workstream);
      if (!before) throw new TaskNotFoundError(localId);
      if (before.status !== "OPEN" || before.substate !== "triage") {
        return {
          previousStatus: before.status,
          status: before.status,
          previousSubstate: before.substate,
          substate: before.substate,
          changed: false,
        };
      }
      const r = setTaskStatus(db, localId, "OPEN", { workstream: opts.workstream });
      recordEvidenceNote(db, localId, before.workstreamName, "ACCEPT", opts);
      return r;
    })(),
  );
}

/** OPEN/parked → OPEN/todo. A no-op (`changed: false`) on any other pair. */
export function unparkTask(
  db: Db,
  localId: string,
  opts: AttributedEvidence & { workstream: string },
): SetStatusResult {
  return withOpContext(db, { intent: "task.unpark", actor: opts.author, group: "new" }, () =>
    db.transaction((): SetStatusResult => {
      const before = getTask(db, localId, opts.workstream);
      if (!before) throw new TaskNotFoundError(localId);
      if (before.status !== "OPEN" || before.substate !== "parked") {
        return {
          previousStatus: before.status,
          status: before.status,
          previousSubstate: before.substate,
          substate: before.substate,
          changed: false,
        };
      }
      const r = setTaskStatus(db, localId, "OPEN", { workstream: opts.workstream });
      recordEvidenceNote(db, localId, before.workstreamName, "UNPARK", opts);
      return r;
    })(),
  );
}
