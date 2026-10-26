// mu — `buildTaskBrief`: the prompt of one executor attempt, built from the
// task's OWN notes. The first `brief` note, verbatim; the latest `report`
// note; one footer naming the task and the CLOSE line. Nothing generated is
// ever stored back, so a retry can never quote an earlier footer.
//
// The executor stores the built TEXT with the reservation and a replay sends
// those exact bytes: it never calls this again, so a deleted note, a newer
// report or a changed footer cannot alter a stored request. Pure SQL: no mux,
// no ctl.

import type { Db } from "./db.js";
import { say } from "./messages.js";
import { taskIdFor } from "./tasks/core.js";
import { TaskNotFoundError } from "./tasks/errors.js";
import { getTaskNote } from "./tasks/queries.js";

/** The task has no `brief` note : nothing is built. */
export class TaskBriefMissingError extends Error {
  override readonly name = "TaskBriefMissingError";
  constructor(
    public readonly task: string,
    public readonly workstream: string,
    reason: string,
  ) {
    super(say("task.brief_missing", task, reason));
  }
}

export interface TaskBriefOptions {
  /** The previous attempt died (`true`) or its run stopped on an API error (`"error"`): say so. */
  retry?: boolean | "error";
}

export interface TaskBrief {
  text: string;
}

/**
 * The pinned notes of a task: the 1-based number of its FIRST `brief` note and
 * of its LATEST `report` note (0 = none). A checker is briefed from the same two.
 */
export function pinnedNotes(
  db: Db,
  workstream: string,
  task: string,
): { briefN: number; reportN: number } {
  const taskId = taskIdFor(db, task, workstream);
  if (taskId === null) throw new TaskNotFoundError(task, workstream);
  const kinds = (
    db.prepare("SELECT kind FROM task_notes WHERE task_id = ? ORDER BY id").all(taskId) as {
      kind: string;
    }[]
  ).map((r) => r.kind);
  return { briefN: kinds.indexOf("brief") + 1, reportN: kinds.lastIndexOf("report") + 1 };
}

/** Build the prompt of one attempt for `task` (see the file header). */
export function buildTaskBrief(
  db: Db,
  workstream: string,
  task: string,
  opts: TaskBriefOptions = {},
): TaskBrief {
  const { briefN, reportN } = pinnedNotes(db, workstream, task);
  if (briefN < 1) {
    throw new TaskBriefMissingError(task, workstream, "it has no brief note (kind brief)");
  }
  const brief = getTaskNote(db, task, workstream, briefN).content;
  const report = reportN < 1 ? null : getTaskNote(db, task, workstream, reportN).content;

  const parts = [brief.trimEnd()];
  if (report !== null) parts.push(`Latest report on this task:\n${report.trimEnd()}`);
  if (opts.retry === true) {
    parts.push("The previous attempt died before it finished; continue from its report.");
  } else if (opts.retry === "error") {
    parts.push(
      "Your previous run stopped on an API error before it finished; continue where you stopped.",
    );
  }
  parts.push(
    `Work only on task ${task} (workstream ${workstream}). Commit, then end your final message with:\n` +
      `CLOSE: task=${task} evidence="<command + result>"\nREPORT:\n<what you did>`,
  );
  return { text: parts.join("\n\n") };
}
