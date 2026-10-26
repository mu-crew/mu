// mu — task error classes.
//
// Every task verb that can fail in a typed way has its own error class
// here. The CLI's `classifyError()` (src/cli.ts) maps them to exit codes:
//   not found  → 3   (TaskNotFoundError)
//   conflict   → 4   (TaskExistsError, TaskNotInWorkstreamError,
//                     TaskAlreadyOwnedError, ClaimerNotRegisteredError,
//                     CrossWorkstreamEdgeError,
//                     SubstateReasonRequiredError, TaskParkStateError,
//                     TaskParkedError, TaskInTriageError,
//                     InvalidSubstateError)
//   cycle      → 4   (CycleError — also a conflict)
//   usage      → 2   (TaskIdInvalidError; TaskTitleSlugEmptyError in id.ts)
//
// Errors carry facts (ids, workstreams, structured fields), never commands:
// a result's follow-up is its `next` (src/next-hints.ts).
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

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
    super(`no such task: ${taskId}`);
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
    super(`invalid task id: ${JSON.stringify(attempted)} (expected /^[a-z][a-z0-9_-]{0,63}$/)`);
  }
}

export class TaskExistsError extends Error {
  override readonly name = "TaskExistsError";
  constructor(public readonly taskId: string) {
    super(`task already exists: ${taskId}`);
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
    super(`task ${taskId} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
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
    super(
      taskId === "<id>"
        ? "a claim in this SQL would take an owned task; release it first: mu task release <id> -w <ws>"
        : `task ${taskId} is already owned by ${currentOwner}`,
    );
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
    const paneHint = paneId !== null ? ` (pane ${paneId})` : "";
    super(
      `claimer '${agentName}'${paneHint} is not a registered mu agent (no row in agents table)`,
    );
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
    super(
      path.length > 1
        ? `adding edge ${from} -> ${to} would create a cycle: ${[from, ...path].join(" -> ")}`
        : `adding edge ${from} -> ${to} would create a cycle`,
    );
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
      `cross-workstream edge: blocker '${blocker}' is in workstream '${blockerWorkstream}', dependent '${dependent}' is in workstream '${dependentWorkstream}'`,
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
    super(
      verb === "close"
        ? `closing ${taskId} as ${substate} needs a reason (--why "...")`
        : `parking ${taskId} needs a reason (--why "...")`,
    );
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
        ? 'a close in this SQL has no close note; close with: mu task close <id> -w <ws> --evidence "<command + result>"'
        : `closing ${taskId} needs evidence (--evidence "<command + result>")`,
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
        ? "a task in this SQL closed as done with open blockers; inspect with: mu task tree <id> -w <ws>"
        : `task ${taskId} has open blockers: ${blockerIds.join(", ")}`,
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
    super(
      status === "IN_PROGRESS"
        ? `cannot park ${taskId}: it is IN_PROGRESS (release it first)`
        : `cannot park ${taskId}: it is CLOSED (open it first)`,
    );
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
    super(`task ${taskId} is in triage (OPEN/triage); accept it or claim with --force`);
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
    super(`task ${taskId} is parked (OPEN/parked); unpark it or claim with --force`);
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
    super(
      `task ${taskId} is a human task: ${action} refused; it resolves only by an explicit \`mu task close ${taskId} -w ${workstream}\``,
    );
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
    super(
      `invalid substate for ${status}: ${JSON.stringify(substate)} (expected one of: ${TASK_SUBSTATES[status].join(", ")})`,
    );
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
    super(
      total === 0
        ? `${taskId} has no notes; note ${n} does not exist`
        : `note ${n} is not one of ${taskId}'s notes (1..${total})`,
    );
  }
}
