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
// Each error implements HasNextSteps so the CLI can render a per-error
// `Next:` block with the most useful follow-up commands.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { HasNextSteps, NextStep } from "../output.js";
import { sanitiseTaskId } from "./id.js";
import { TASK_SUBSTATES, type TaskStatus, type TaskSubstate } from "./status.js";

export class TaskNotFoundError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    if (this.workstream !== undefined) {
      const ws = this.workstream;
      return [
        ...this.candidateIds.map((id) => ({
          intent: `Did you mean ${id}? (read-only)`,
          command: `mu task show ${id} -w ${ws}`,
        })),
        { intent: "List tasks in workstream", command: `mu task list -w ${ws}` },
      ];
    }
    // v5: tasks.workstream (TEXT) was replaced by tasks.workstream_id
    // (FK → workstreams.id). The pre-v5 recipe SELECTed a column that
    // no longer exists and crashed at runtime — and this is THE first
    // hint a user sees on a missed-task lookup, so the breakage was
    // high-traffic. Mirror the join pattern used by AgentExistsError.
    const idLit = this.taskId.replace(/'/g, "''").toLowerCase();
    const recipe = `mu db query "SELECT ws.name AS workstream, t.local_id, t.status, t.title FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE LOWER(t.local_id) LIKE '%${idLit}%' OR LOWER(t.title) LIKE '%${idLit}%'"`;
    return [
      { intent: "List tasks in workstream", command: "mu task list -w <workstream>" },
      { intent: "Search every workstream by substring (id + title)", command: recipe },
    ];
  }
}

/**
 * Thrown by `addTask` when `localId` violates the schema regex
 * `/^[a-z][a-z0-9_-]{0,63}$/`. Replaces a bare `TypeError` so the
 * CLI's `handle()` wrapper can map it to exit code 2 (usage, with the
 * verb's --help, like WorkstreamNameInvalidError) and surface a `--json` `nextSteps` block pointing at
 * the auto-derived-id workflow and a sanitised candidate.
 */
export class TaskIdInvalidError extends Error implements HasNextSteps {
  override readonly name = "TaskIdInvalidError";
  constructor(public readonly attempted: string) {
    super(`invalid task id: ${JSON.stringify(attempted)} (expected /^[a-z][a-z0-9_-]{0,63}$/)`);
  }
  errorNextSteps(): NextStep[] {
    const sanitised = sanitiseTaskId(this.attempted);
    return [
      {
        intent: "Use the auto-derived id (drop the <id> positional; --title derives it)",
        command: 'mu task add --title "..." --impact <n> --effort-days <n>',
      },
      {
        intent: "Sanitise to a valid id",
        command: `mu task add ${sanitised} --title "..." --impact <n> --effort-days <n>`,
      },
    ];
  }
}

export class TaskExistsError extends Error implements HasNextSteps {
  override readonly name = "TaskExistsError";
  constructor(public readonly taskId: string) {
    super(`task already exists: ${taskId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Show the existing task", command: `mu task show ${this.taskId}` },
      {
        intent: "Update fields on the existing task",
        command: `mu task update ${this.taskId} --title "..." --impact <n> --effort-days <n>`,
      },
      {
        intent: "Pick a different id",
        command: 'mu task add <new-id> --title "..." --impact <n> --effort-days <n>',
      },
    ];
  }
}

/**
 * Thrown when a verb is invoked with `-w/--workstream <name>` but the
 * named task lives in a different workstream. Distinguishes "the user
 * typo'd the workstream" from "the task doesn't exist anywhere"
 * (which surfaces as `TaskNotFoundError`). Maps to exit code 4
 * (conflict / wrong scope).
 */
export class TaskNotInWorkstreamError extends Error implements HasNextSteps {
  override readonly name = "TaskNotInWorkstreamError";
  constructor(
    public readonly taskId: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`task ${taskId} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Use the correct workstream",
        command: `mu task show ${this.taskId} -w ${this.actualWorkstream}`,
      },
      {
        intent: "List tasks in the requested workstream",
        command: `mu task list -w ${this.expectedWorkstream}`,
      },
    ];
  }
}

export class TaskAlreadyOwnedError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    if (this.taskId === "<id>") {
      return [{ intent: "Release the claim, then retry", command: "mu task release <id> -w <ws>" }];
    }
    return [
      {
        intent: "See the current owner's task list",
        command: `mu task owned-by ${this.currentOwner}`,
      },
      {
        intent: "Release the current claim (if you ARE the owner)",
        command: `mu task release ${this.taskId}`,
      },
      { intent: "Show full task state", command: `mu task show ${this.taskId}` },
    ];
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
export class ClaimerNotRegisteredError extends Error implements HasNextSteps {
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

  /**
   * Two actionable resolutions in expected-frequency order:
   *   1. --self  : orchestrator pattern (working directly)
   *   2. --for   : dispatcher pattern (assigning to a worker)
   */
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Work directly (anonymous)", command: "mu task claim <id> --self" },
      { intent: "Dispatch to a worker", command: "mu task claim <id> --for <worker>" },
    ];
  }
}

export class CycleError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    const a = this.path[0];
    const b = this.path[1];
    const ws = this.workstream ? ` -w ${this.workstream}` : "";
    const concrete: NextStep[] =
      a !== undefined && b !== undefined
        ? [
            {
              intent: `Break the cycle by removing existing edge ${a} -> ${b}`,
              command: `mu task unblock ${b} --by ${a}${ws}`,
            },
          ]
        : [];
    return [
      ...concrete,
      {
        intent: "Show the dependency tree",
        command: `mu task tree ${this.to} --down`,
      },
      {
        intent: "Show the prereq tree (what blocks the from-task)",
        command: `mu task tree ${this.from}`,
      },
      {
        intent: "Remove an edge in the path to break the cycle",
        command: "mu task unblock <blocked> --by <blocker>",
      },
    ];
  }
}

export class CrossWorkstreamEdgeError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    // No "move the blocker" recipe. A task's workstream is part of its
    // natural key (`<ws>/<local_id>`), which every op is filed under, so
    // a raw `UPDATE tasks SET workstream_id=...` re-keys the row with no
    // op for either key: sync and `mu doctor` then disagree with
    // the table. The capture layer refuses that UPDATE (src/capture.ts
    // KEY_COLUMNS). The "rename one workstream to the other" hint went
    // earlier for the same reason, and because it moved every task.
    return [
      {
        intent: "Duplicate the blocker into the dependent's workstream",
        command: `mu task add <new-id> -w ${this.dependentWorkstream} --title "<copy of ${this.blocker}>" --impact <n> --effort-days <n>`,
      },
      {
        intent: "Or wait on the blocker across workstreams instead of an edge",
        command: `mu task wait ${this.blockerWorkstream}/${this.blocker}`,
      },
    ];
  }
}

/**
 * Thrown by `closeTask` (non-`done` `--as`) and `parkTask` when no
 * non-empty `--why` was given. The reason is stored as a note, so a
 * classification with no rationale is refused before any write.
 */
export class SubstateReasonRequiredError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    const cmd =
      this.verb === "close"
        ? `mu task close ${this.taskId} --as ${this.substate} --why "<reason>"`
        : `mu task park ${this.taskId} --why "<reason>"`;
    return [{ intent: "Retry with a reason", command: cmd }];
  }
}

/**
 * Thrown when a close lands without a `kind = 'close'` note in its op
 * group: the local-write guard `_cap_tasks_close_evidence` (src/capture.ts)
 * refused it. Raised by `closeTask` only; ingest never sees it.
 */
export class CloseNeedsEvidenceError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Retry with what you observed",
        command: `mu task close ${this.taskId} -w ${this.workstream} --evidence "<command + result>"`,
      },
    ];
  }
}

/**
 * Thrown when a close to `done` finds a blocker still OPEN or
 * IN_PROGRESS (guard `_cap_tasks_close_blockers`). Classifying the task
 * as wontfix / duplicate / rejected / superseded is exempt: those do not
 * claim the work happened.
 */
export class TaskHasOpenBlockersError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "See the open blockers",
        command: `mu task tree ${this.taskId} -w ${this.workstream}`,
      },
    ];
  }
}

/**
 * Thrown by `parkTask` on an IN_PROGRESS or CLOSED task. Park is one
 * transition (OPEN/todo → OPEN/parked); the owner releases, or the task
 * is reopened, first.
 */
export class TaskParkStateError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
    const ws = this.workstream;
    const first: NextStep =
      this.status === "IN_PROGRESS"
        ? { intent: "Release the claim first", command: `mu task release ${this.taskId} -w ${ws}` }
        : { intent: "Reopen the task first", command: `mu task open ${this.taskId} -w ${ws}` };
    return [
      first,
      {
        intent: "Then park it",
        command: `mu task park ${this.taskId} --why "<reason>" -w ${ws}`,
      },
    ];
  }
}

/**
 * Thrown by `claimTask` on an OPEN/triage task without `force`. A triage
 * task is a proposal (often a review finding) nobody has accepted as
 * work yet; accept it, or close it rejected / duplicate.
 */
export class TaskInTriageError extends Error implements HasNextSteps {
  override readonly name = "TaskInTriageError";
  constructor(
    public readonly taskId: string,
    public readonly workstream: string,
  ) {
    super(`task ${taskId} is in triage (OPEN/triage); accept it or claim with --force`);
  }
  errorNextSteps(): NextStep[] {
    const ws = this.workstream;
    return [
      {
        intent: "Accept it as work, then claim",
        command: `mu task accept ${this.taskId} -w ${ws}`,
      },
      {
        intent: "Decline it",
        command: `mu task close ${this.taskId} --as rejected --why "<reason>" -w ${ws}`,
      },
      { intent: "Claim it anyway", command: `mu task claim ${this.taskId} --force -w ${ws}` },
    ];
  }
}

/**
 * Thrown by `claimTask` on an OPEN/parked task without `force`. Parked
 * means "keep out of the scheduler"; claiming it anyway is explicit.
 */
export class TaskParkedError extends Error implements HasNextSteps {
  override readonly name = "TaskParkedError";
  constructor(
    public readonly taskId: string,
    public readonly workstream: string,
  ) {
    super(`task ${taskId} is parked (OPEN/parked); unpark it or claim with --force`);
  }
  errorNextSteps(): NextStep[] {
    const ws = this.workstream;
    return [
      { intent: "Unpark it, then claim", command: `mu task unpark ${this.taskId} -w ${ws}` },
      { intent: "Claim it anyway", command: `mu task claim ${this.taskId} --force -w ${ws}` },
    ];
  }
}

/**
 * Thrown when a verb would resolve a `human` task other than by an explicit
 * `mu task close`: unpark, claim (even --force) and a CLOSE block. A human
 * task records a decision only a person can make; nothing autonomous may
 * make it ready or close it.
 */
export class HumanTaskError extends Error implements HasNextSteps {
  override readonly name = "HumanTaskError";
  /** The message already names the command: one line, no Next: block. */
  readonly inlineNext = true;
  constructor(
    public readonly taskId: string,
    public readonly workstream: string,
    action: string,
  ) {
    super(
      `task ${taskId} is a human task: ${action} refused; it resolves only by an explicit \`mu task close ${taskId} -w ${workstream}\``,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Close it on the human's decision",
        command: `mu task close ${this.taskId} -w ${this.workstream} --evidence "<the decision>"`,
      },
    ];
  }
}

/**
 * Thrown when a verb is asked for a (status, substate) pair that the
 * task_substates table does not allow, e.g. `close --as parked`.
 * Caught here rather than by the deferred FK, which would fail only at
 * commit with an opaque constraint message.
 */
export class InvalidSubstateError extends Error implements HasNextSteps {
  override readonly name = "InvalidSubstateError";
  constructor(
    public readonly status: TaskStatus,
    public readonly substate: string,
  ) {
    super(
      `invalid substate for ${status}: ${JSON.stringify(substate)} (expected one of: ${TASK_SUBSTATES[status].join(", ")})`,
    );
  }
  errorNextSteps(): NextStep[] {
    return TASK_SUBSTATES[this.status].map((s) => ({
      intent: `Use ${this.status}/${s}`,
      command:
        this.status === "CLOSED" ? `mu task close <id> --as ${s}` : `mu task list --substate ${s}`,
    }));
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
