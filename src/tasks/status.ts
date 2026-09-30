// mu — TaskStatus enum + helpers.
//
// Single source of truth for "what statuses and substates can a task
// have". The schema (db.ts) seeds the task_substates lookup table from
// TASK_SUBSTATE_ROWS, and a composite FK from tasks (status, substate)
// into it is the only guard on both columns. Add a status or substate
// here only.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

export type TaskStatus = "OPEN" | "IN_PROGRESS" | "CLOSED";

/** Every legal task status, in canonical order (matches the seeded
 *  task_substates rows). Exported so CLI surfaces (`--status` validators,
 *  --help text, error messages) name them all in one place; missing
 *  one used to silently lie about the supported set. */
export const TASK_STATUSES: readonly TaskStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED"];

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/** Pipe-separated list of every legal status, e.g.
 *  'OPEN | IN_PROGRESS | CLOSED'. Single source of truth for
 *  --help text and error messages so adding a new status doesn't
 *  leave stale lists rotting in the CLI surface. */
export const TASK_STATUS_LIST = TASK_STATUSES.join(" | ");

/** Legal substates per status. `substate` qualifies `status` and never
 *  touches edge semantics: only `status === "CLOSED"` satisfies a
 *  `blocks` edge. Closed: `rejected` = the proposal was declined;
 *  `wontfix` = valid, but not worth doing. */
export const TASK_SUBSTATES = {
  OPEN: ["todo", "parked"],
  IN_PROGRESS: ["active"],
  CLOSED: ["done", "rejected", "wontfix", "duplicate", "superseded"],
} as const satisfies Record<TaskStatus, readonly string[]>;

export type TaskSubstate = (typeof TASK_SUBSTATES)[TaskStatus][number];

/** The substate a status takes when none is given. Never null: an
 *  absent value must not carry meaning. */
export const DEFAULT_SUBSTATE: {
  readonly [S in TaskStatus]: (typeof TASK_SUBSTATES)[S][number];
} = { OPEN: "todo", IN_PROGRESS: "active", CLOSED: "done" };

export interface TaskPair {
  status: TaskStatus;
  substate: TaskSubstate;
}

/** Rows for seeding task_substates: [status, substate, isDefault]. */
export const TASK_SUBSTATE_ROWS: ReadonlyArray<readonly [TaskStatus, TaskSubstate, 0 | 1]> =
  TASK_STATUSES.flatMap((status) =>
    TASK_SUBSTATES[status].map(
      (substate) => [status, substate, substate === DEFAULT_SUBSTATE[status] ? 1 : 0] as const,
    ),
  );

export function isValidPair(status: string, substate: string): boolean {
  if (!isTaskStatus(status)) return false;
  return (TASK_SUBSTATES[status] as readonly string[]).includes(substate);
}

/** Retired v9 statuses and the pair each one now means. */
const LEGACY_STATUS_PAIRS: Readonly<Record<string, TaskPair>> = {
  REJECTED: { status: "CLOSED", substate: "rejected" },
  DEFERRED: { status: "OPEN", substate: "parked" },
};

/** REJECTED -> {CLOSED, rejected}; DEFERRED -> {OPEN, parked}; else null. */
export function mapLegacyStatus(value: string): TaskPair | null {
  const pair = LEGACY_STATUS_PAIRS[value];
  return pair ? { ...pair } : null;
}

/** Map a stored/remote pair onto a legal one. Legacy status -> mapped pair
 *  (ignores substate arg). Unknown status -> null. Known status with
 *  unknown/missing/mismatched substate -> {status, DEFAULT_SUBSTATE[status]}. */
export function resolvePair(status: string, substate: unknown): TaskPair | null {
  const legacy = mapLegacyStatus(status);
  if (legacy) return legacy;
  if (!isTaskStatus(status)) return null;
  if (typeof substate === "string" && isValidPair(status, substate)) {
    return { status, substate: substate as TaskSubstate };
  }
  return { status, substate: DEFAULT_SUBSTATE[status] };
}

/** "OPEN" for default pairs, "OPEN/parked" otherwise. Shared by CLI + TUI. */
export function formatPair(pair: TaskPair): string {
  return pair.substate === DEFAULT_SUBSTATE[pair.status]
    ? pair.status
    : `${pair.status}/${pair.substate}`;
}
