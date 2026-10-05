// mu — task graph SDK hub.
//
// The concrete DAG implementation lives in the cohesive src/tasks/
// cluster. This root file preserves the public `import { ... } from
// "./tasks.js"` surface while keeping task edit / edge / query code in
// focused files.

export {
  type ClaimResult,
  type ClaimTaskOptions,
  claimTask,
  type ReleaseResult,
  type ReleaseTaskOptions,
  releaseTask,
  resolveActorIdentity,
} from "./tasks/claim.js";
export {
  lookupTaskAnyWorkstream,
  noteFromDb,
  type RawTaskNoteRow,
  type RawTaskRow,
  rowFromDb,
  SELECT_NOTE_COLS,
  SELECT_TASK_COLS,
  TASK_FROM_JOIN,
  type TaskNoteRow,
  type TaskRow,
  taskIdFor,
  touchTask,
} from "./tasks/core.js";
export {
  addBlockEdge,
  type BlockEdgeResult,
  getPrerequisites,
  getTaskEdges,
  getTaskEdgesWithStatus,
  type RemoveBlockEdgeResult,
  type ReparentTaskResult,
  removeBlockEdge,
  reparentTask,
  type TaskEdges,
  type TaskEdgesWithStatus,
  type TaskEdgeWithStatus,
  wouldCreateCycle,
} from "./tasks/edges.js";
export {
  type AddNoteOptions,
  type AddTaskOptions,
  addNote,
  addTask,
  type DeleteTaskOptions,
  type DeleteTaskResult,
  deleteTask,
  type UpdateTaskOptions,
  type UpdateTaskResult,
  type UpdateTaskScopeOption,
  updateTask,
} from "./tasks/edit.js";
// Re-export status enum + helpers and error classes from the cluster
// modules. Public callers continue to `import { ... } from "./tasks.js"`
// regardless of which sub-file the symbol lives in.
export {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  InvalidSubstateError,
  ReaperDetectedDuringWaitError,
  StallDetectedDuringWaitError,
  SubstateReasonRequiredError,
  TaskAlreadyOwnedError,
  TaskClaimStaleWorkspaceError,
  TaskExistsError,
  TaskIdInvalidError,
  TaskInTriageError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
  TaskParkedError,
  TaskParkStateError,
} from "./tasks/errors.js";
export {
  type IdFromTitleResult,
  idFromTitle,
  idFromTitleVerbose,
  isValidTaskId,
  type SlugifyResult,
  sanitiseTaskId,
  slugifyTitle,
  slugifyTitleVerbose,
  TaskTitleSlugEmptyError,
} from "./tasks/id.js";
export {
  type AttributedEvidence,
  acceptTask,
  type CloseSkippedResult,
  type CloseSubstate,
  type CloseTaskOptions,
  type CloseTaskResult,
  closeTask,
  type EvidenceOption,
  evidenceSuffix,
  openTask,
  type ParkTaskOptions,
  parkTask,
  type SetStatusOptions,
  type SetStatusResult,
  setTaskStatus,
  unparkTask,
  WEAK_REASON_CHARS,
  weakDecisionWarning,
} from "./tasks/lifecycle.js";
export {
  getTask,
  getTaskOwner,
  type ListNotesOptions,
  type ListReadyOptions,
  type ListTasksOptions,
  listBlocked,
  listGoals,
  listInProgress,
  listNotes,
  listReady,
  listRecentClosed,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
} from "./tasks/queries.js";
export {
  DEFAULT_SUBSTATE,
  formatPair,
  isTaskStatus,
  isValidPair,
  mapLegacyStatus,
  resolvePair,
  TASK_STATUS_LIST,
  TASK_STATUSES,
  TASK_SUBSTATE_ROWS,
  TASK_SUBSTATES,
  type TaskPair,
  type TaskStatus,
  type TaskSubstate,
} from "./tasks/status.js";
export {
  DEFAULT_CTL_STUCK_AFTER_MS,
  DEFAULT_STUCK_AFTER_MS,
  getWaitPollCount,
  resetWaitPollCount,
  setWaitSleepForTests,
  setWaitStuckWarnForTests,
  type TaskWaitOptions,
  type TaskWaitRef,
  type TaskWaitResult,
  type TaskWaitTaskState,
  waitForTasks,
} from "./tasks/wait.js";
