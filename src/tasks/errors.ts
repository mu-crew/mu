// mu — task error classes.
//
// Every task verb that can fail in a typed way has its own error class
// here. The CLI's `classifyError()` (src/cli.ts) maps them to exit codes:
//   not found  → 3   (TaskNotFoundError)
//   conflict   → 4   (TaskExistsError, TaskNotInWorkstreamError,
//                     TaskAlreadyOwnedError, ClaimerNotRegisteredError,
//                     CrossWorkstreamEdgeError,
//                     TaskParkStateError,
//                     TaskParkedError, TaskInTriageError,
//                     InvalidSubstateError)
//   cycle      → 4   (CycleError — also a conflict)
//   usage      → 2   (TaskIdInvalidError; TaskTitleSlugEmptyError in id.ts;
//                     CloseNeedsEvidenceError, SubstateReasonRequiredError: a close's
//                     missing --evidence / --why, on the CLI, the SDK and `mu sql --write`)
//
// Errors carry facts (ids, workstreams, structured fields), never commands:
// a result's follow-up is its `next` (src/next-hints.ts).
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import { say } from "../messages.js";
import { TASK_SUBSTATES, type TaskStatus, type TaskSubstate } from "./status.js";

export class TaskNotFoundError extends Error {
  override readonly name = "TaskNotFoundError";
  /** Near ids from the SAME workstream (`candidateTaskIds`), read-only
   *  suggestions: filled by `handle()` after the miss, never used to write. */
  candidateIds: readonly string[] = [];
  /** `workstream` is the partition the exact lookup missed in, when known. */
  constructor(
    public readonly taskId: string,
    public readonly workstream?: string,
    /** The id the candidates are matched against, when `taskId` is the
     *  operator's qualified spelling (`ws/id`). Defaults to `taskId`. */
    public readonly lookupId: string = taskId,
  ) {
    super(say("task.not_found", taskId));
  }
}

/**
 * Thrown by `addTask` when `localId` violates the schema regex
 * `/^[a-z][a-z0-9_-]{0,63}$/`. Replaces a bare `TypeError` so the
 * CLI's `handle()` wrapper can map it to exit code 2 (usage, with the
 * verb's --help, like WorkstreamNameInvalidError).
 */
export class TaskIdInvalidError extends Error {
  override readonly name = "TaskIdInvalidError";
  constructor(public readonly attempted: string) {
    super(say("task.id_invalid", attempted));
  }
}

export class TaskExistsError extends Error {
  override readonly name = "TaskExistsError";
  constructor(public readonly taskId: string) {
    super(say("task.exists", taskId));
  }
}

/**
 * Thrown when a verb is invoked with `-w/--workstream <name>` but the
 * named task lives in a different workstream. Distinguishes "the user
 * typo'd the workstream" from "the task doesn't exist anywhere"
 * (which surfaces as `TaskNotFoundError`). Maps to exit code 4
 * (conflict / wrong scope).
 */
export class TaskNotInWorkstreamError extends Error {
  override readonly name = "TaskNotInWorkstreamError";
  constructor(
    public readonly taskId: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(say("task.not_in_workstream", taskId, expectedWorkstream, actualWorkstream));
  }
}

export class TaskAlreadyOwnedError extends Error {
  override readonly name = "TaskAlreadyOwnedError";
  /** `taskId` / `currentOwner` are omitted when a raw `mu sql` write tripped
   *  the guard: the SQL may not name one task, so the hints carry placeholders. */
  constructor(
    public readonly taskId = "<id>",
    public readonly currentOwner = "<owner>",
  ) {
    super(taskId === "<id>" ? say("task.owned_sql") : say("task.owned", taskId, currentOwner));
  }
}

/**
 * Thrown when `mu task claim` resolves a claimer agent name (from the
 * pane title or --for) that has no matching row in the agents table.
 *
 * The FK on `tasks.owner_id` references `agents.id`; without this guard
 * the claim attempt would fail with the unhelpful 'FOREIGN KEY constraint
 * failed' from SQLite. This typed error gives the user actionable next
 * steps (work with --self, or use --for to pick a registered agent).
 *
 * Maps to exit code 4 (conflict) via the cli.ts handler.
 */
export class ClaimerNotRegisteredError extends Error {
  override readonly name = "ClaimerNotRegisteredError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string | null,
  ) {
    super(say("task.claimer_unregistered", agentName, paneId));
  }
}

export class CycleError extends Error {
  override readonly name = "CycleError";
  constructor(
    public readonly from: string,
    public readonly to: string,
    /** Existing path `to -> … -> from` (task names) that the new edge would close. */
    public readonly path: readonly string[] = [],
    public readonly workstream?: string,
  ) {
    super(say("task.cycle", from, to, path));
  }
}

export class CrossWorkstreamEdgeError extends Error {
  override readonly name = "CrossWorkstreamEdgeError";
  constructor(
    public readonly blocker: string,
    public readonly blockerWorkstream: string,
    public readonly dependent: string,
    public readonly dependentWorkstream: string,
  ) {
    super(
      say("task.cross_workstream_edge", blocker, blockerWorkstream, dependent, dependentWorkstream),
    );
  }
}

/**
 * Thrown by `closeTask` (non-`done` `--as`) and `parkTask` when no
 * non-empty `--why` was given. The reason is stored as a note, so a
 * classification with no rationale is refused before any write.
 */
export class SubstateReasonRequiredError extends Error {
  override readonly name = "SubstateReasonRequiredError";
  constructor(
    public readonly verb: "close" | "park",
    public readonly substate: TaskSubstate,
    public readonly taskId: string,
  ) {
    super(say("task.close_reason_needed", verb, taskId, substate));
  }
}

/**
 * Thrown when a close lands without a `kind = 'close'` note in its op
 * group: the local-write guard `_cap_tasks_close_evidence` (src/capture.ts)
 * refused it. Raised by `closeTask` only; ingest never sees it.
 */
export class CloseNeedsEvidenceError extends Error {
  override readonly name = "CloseNeedsEvidenceError";
  /** Ids are omitted when a raw `mu sql` write tripped the guard: the SQL
   *  may not name one task, so the message and hint carry placeholders. */
  constructor(
    public readonly taskId = "<id>",
    public readonly workstream = "<ws>",
  ) {
    super(
      taskId === "<id>"
        ? say("task.close_needs_evidence_sql")
        : say("task.close_needs_evidence", taskId, workstream),
    );
  }
}

/**
 * Thrown when a close to `done` finds a blocker still OPEN or
 * IN_PROGRESS (guard `_cap_tasks_close_blockers`). Classifying the task
 * as wontfix / duplicate / rejected / superseded is exempt: those do not
 * claim the work happened.
 */
export class TaskHasOpenBlockersError extends Error {
  override readonly name = "TaskHasOpenBlockersError";
  /** Ids are omitted when a raw `mu sql` write tripped the guard: the SQL
   *  may not name one task, so the message and hint carry placeholders. */
  constructor(
    public readonly taskId = "<id>",
    public readonly workstream = "<ws>",
    public readonly blockerIds: readonly string[] = [],
  ) {
    super(
      taskId === "<id>"
        ? say("task.open_blockers_sql")
        : say("task.open_blockers", taskId, blockerIds),
    );
  }
}

/**
 * Thrown by `parkTask` on an IN_PROGRESS or CLOSED task. Park is one
 * transition (OPEN/todo → OPEN/parked); the owner releases, or the task
 * is reopened, first.
 */
export class TaskParkStateError extends Error {
  override readonly name = "TaskParkStateError";
  constructor(
    public readonly taskId: string,
    public readonly status: "IN_PROGRESS" | "CLOSED",
    public readonly workstream: string,
  ) {
    super(say("task.park_state", taskId, status));
  }
}

/**
 * Thrown by `claimTask` on an OPEN/triage task without `force`. A triage
 * task is a proposal (often a review finding) nobody has accepted as
 * work yet; accept it, or close it rejected / duplicate.
 */
export class TaskInTriageError extends Error {
  override readonly name = "TaskInTriageError";
  constructor(
    public readonly taskId: string,
    public readonly workstream: string,
  ) {
    super(say("task.in_triage", taskId));
  }
}

/**
 * Thrown by `claimTask` on an OPEN/parked task without `force`. Parked
 * means "keep out of the scheduler"; claiming it anyway is explicit.
 */
export class TaskParkedError extends Error {
  override readonly name = "TaskParkedError";
  constructor(
    public readonly taskId: string,
    public readonly workstream: string,
  ) {
    super(say("task.parked", taskId));
  }
}

/**
 * Thrown when a verb would resolve a `human` task other than by an explicit
 * `mu task close`: unpark, claim (even --force) and a CLOSE block. A human
 * task records a decision only a person can make; nothing autonomous may
 * make it ready or close it.
 */
export class HumanTaskError extends Error {
  override readonly name = "HumanTaskError";
  constructor(
    public readonly taskId: string,
    public readonly workstream: string,
    action: string,
  ) {
    super(say("task.human", taskId, workstream, action));
  }
}

/**
 * Thrown when a verb is asked for a (status, substate) pair that the
 * task_substates table does not allow, e.g. `close --as parked`.
 * Caught here rather than by the deferred FK, which would fail only at
 * commit with an opaque constraint message.
 */
export class InvalidSubstateError extends Error {
  override readonly name = "InvalidSubstateError";
  constructor(
    public readonly status: TaskStatus,
    public readonly substate: string,
  ) {
    super(say("task.invalid_substate", status, substate, TASK_SUBSTATES[status]));
  }
}

/** A note selector (`--from <n>` / `--note <n>`) that is not one of the task's
 *  own notes `1..total`. Exact membership: there is no fuzzy match. */
export class TaskNoteRangeError extends Error {
  override readonly name = "TaskNoteRangeError";
  constructor(
    public readonly taskId: string,
    public readonly n: number,
    public readonly total: number,
  ) {
    super(say("task.note_range", taskId, n, total));
  }
}
