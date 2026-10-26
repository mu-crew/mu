// mu — `buildTaskBrief`: the prompt of one executor attempt, built from the
// task's OWN notes. The first `brief` note, verbatim; the latest `report`
// note; one footer naming the task and the CLOSE line. Nothing generated is
// ever stored back, so a retry can never quote an earlier footer.
//
// The notes are PINNED by their `n` (1-based position, `selectTaskNotes`):
// the executor stores `{brief, report}` with the reservation and rebuilds the
// identical text from them on a replay, after newer notes or a newer report
// arrived. Pure SQL: no mux, no ctl.

import type { Db } from "./db.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { taskIdFor } from "./tasks/core.js";
import { TaskNotFoundError } from "./tasks/errors.js";
import { getTaskNote } from "./tasks/queries.js";

/** The task has no `brief` note (or a pinned note is not what it was): nothing is built. */
export class TaskBriefMissingError extends Error implements HasNextSteps {
  override readonly name = "TaskBriefMissingError";
  constructor(
    public readonly task: string,
    public readonly workstream: string,
    reason: string,
  ) {
    super(`task ${task} cannot be briefed: ${reason}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Pin the brief the worker should get",
        command: `mu task note ${this.task} --kind brief -w ${this.workstream} -`,
      },
    ];
  }
}

export interface TaskBriefPin {
  /** `n` of the brief note. */
  brief: number;
  /** `n` of the report note, or null for none. */
  report: number | null;
}

export interface TaskBriefOptions {
  /** The previous attempt died: say so. */
  retry?: boolean;
  /** Rebuild from exactly these notes instead of the first brief + latest report. */
  pin?: TaskBriefPin;
}

export interface TaskBrief extends TaskBriefPin {
  text: string;
}

/** Build the prompt of one attempt for `task` (see the file header). */
export function buildTaskBrief(
  db: Db,
  workstream: string,
  task: string,
  opts: TaskBriefOptions = {},
): TaskBrief {
  const taskId = taskIdFor(db, task, workstream);
  if (taskId === null) throw new TaskNotFoundError(task, workstream);
  const kinds = (
    db.prepare("SELECT kind FROM task_notes WHERE task_id = ? ORDER BY id").all(taskId) as {
      kind: string;
    }[]
  ).map((r) => r.kind);
  const pin: TaskBriefPin = opts.pin ?? {
    brief: kinds.indexOf("brief") + 1,
    report: kinds.lastIndexOf("report") + 1 || null,
  };
  if (pin.brief < 1 || kinds[pin.brief - 1] !== "brief") {
    throw new TaskBriefMissingError(task, workstream, "it has no brief note (kind brief)");
  }
  if (pin.report !== null && kinds[pin.report - 1] !== "report") {
    throw new TaskBriefMissingError(task, workstream, `note ${pin.report} is not a report`);
  }
  const brief = getTaskNote(db, task, workstream, pin.brief).content;
  const report = pin.report === null ? null : getTaskNote(db, task, workstream, pin.report).content;

  const parts = [brief.trimEnd()];
  if (report !== null) parts.push(`Latest report on this task:\n${report.trimEnd()}`);
  if (opts.retry === true) {
    parts.push("The previous attempt died before it finished; continue from its report.");
  }
  parts.push(
    `Work only on task ${task} (workstream ${workstream}). Commit, then end your final message with:\n` +
      `CLOSE: task=${task} evidence="<command + result>"\nREPORT:\n<what you did>`,
  );
  return { text: parts.join("\n\n"), ...pin };
}
