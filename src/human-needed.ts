// mu — the durable human-needed stop (`mu human-needed <reason>`).
//
// The state-armed loop stops for exactly one reason of its own: a person must
// decide. The caller records that explicitly; no error or refusal does.
// A need is a `human` task, OPEN/parked (never ready, never auto, never
// claimed: HumanTaskError), whose brief note holds the reason. Its caller
// lives in the machine-local `human_needs` row (rebuild cannot restore it;
// a note author is never trusted for ownership). The task closes only by an
// explicit `mu task close`.

import { type Db, resolveWorkstreamId } from "./db.js";
import { withOpContext } from "./op-context.js";
import { addTasks, insertNote } from "./tasks/edit.js";

/** A blank reason or caller: nothing is recorded (exit 2). */
export class HumanNeededInvalidError extends Error {
  override readonly name = "HumanNeededInvalidError";
}

export interface HumanNeededOptions {
  workstream: string;
  /** Who is stopping: `spawnerFromEnv()` (managed `<ws>/<agent>` or `pi:<session>`). */
  caller: string;
  reason: string;
}

export interface HumanNeeded {
  workstream: string;
  id: string;
  reason: string;
}

const TITLE_CHARS = 60;

/**
 * Record (or extend) the caller's open human need in a workstream, in ONE
 * transaction. Same caller + workstream with an open need: the same reason
 * is a no-op (`changed: false`), a different one appends a brief to it.
 */
export function recordHumanNeeded(
  db: Db,
  opts: HumanNeededOptions,
): { id: string; changed: boolean } {
  const reason = opts.reason.trim();
  const caller = opts.caller.trim();
  if (reason === "") throw new HumanNeededInvalidError("human-needed: reason is blank");
  if (caller === "") {
    throw new HumanNeededInvalidError(
      "human-needed: no caller identity (run inside a mu agent or a pi session)",
    );
  }
  return withOpContext(db, { intent: "task.note", actor: caller, group: "new" }, () =>
    db
      .transaction(() => {
        const open = openNeedFor(db, caller, opts.workstream);
        if (open !== undefined) {
          if (open.briefs.includes(reason)) return { id: open.id, changed: false };
          insertNote(db, open.id, reason, {
            workstream: opts.workstream,
            author: caller,
            kind: "brief",
          });
          return { id: open.id, changed: true };
        }
        const title = `human needed: ${reason.replace(/\s+/g, " ").slice(0, TITLE_CHARS)}`;
        const { ids } = addTasks(db, [{ title, note: reason }], {
          workstream: opts.workstream,
          kind: "human",
          noteAuthor: caller,
        });
        const id = ids[0];
        if (id === undefined) throw new Error("recordHumanNeeded: no task created");
        const taskId = (
          db
            .prepare("SELECT id FROM tasks WHERE workstream_id = ? AND local_id = ?")
            .get(resolveWorkstreamId(db, opts.workstream), id) as { id: number }
        ).id;
        db.prepare("INSERT INTO human_needs (task_id, caller) VALUES (?, ?)").run(taskId, caller);
        return { id, changed: true };
      })
      .immediate(),
  );
}

interface OpenNeedRow {
  taskId: number;
  id: string;
  workstream: string;
}

function openNeedRows(db: Db, caller: string, workstream?: string): OpenNeedRow[] {
  return db
    .prepare(
      `SELECT t.id AS taskId, t.local_id AS id, w.name AS workstream
         FROM human_needs h
         JOIN tasks t ON t.id = h.task_id
         JOIN workstreams w ON w.id = t.workstream_id
        WHERE h.caller = ? AND t.kind = 'human' AND t.status = 'OPEN'
          AND w.torn_down_at IS NULL AND (? IS NULL OR w.name = ?)
        ORDER BY t.id`,
    )
    .all(caller, workstream ?? null, workstream ?? null) as OpenNeedRow[];
}

function briefsOf(db: Db, taskId: number): string[] {
  return (
    db
      .prepare("SELECT content FROM task_notes WHERE task_id = ? AND kind = 'brief' ORDER BY id")
      .all(taskId) as { content: string }[]
  ).map((r) => r.content);
}

function openNeedFor(
  db: Db,
  caller: string,
  workstream: string,
): { id: string; briefs: string[] } | undefined {
  const row = openNeedRows(db, caller, workstream).at(-1);
  return row === undefined ? undefined : { id: row.id, briefs: briefsOf(db, row.taskId) };
}

/** The caller's OPEN human needs, oldest first, across workstreams. Another
 *  caller's need never appears. Reasons of an extended need join with "; ". */
export function openHumanNeeds(db: Db, caller: string): HumanNeeded[] {
  return openNeedRows(db, caller).map((r) => ({
    workstream: r.workstream,
    id: r.id,
    reason: briefsOf(db, r.taskId).join("; "),
  }));
}
