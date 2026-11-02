// mu — when an owned agent ref is still OWED a wait, and when it is DONE.
//
// One rule, kept here. An agent ref a caller registered is owed only while the agent owns open work
// (a task that is not CLOSED) or a run it was sent is unsettled. When every task it owned is CLOSED
// (or released) and its last run settled, the ref is DONE: a later `agent close`, or a pane that goes
// away, is NOT a `dead` event. `dead` is for a pane lost while work or a run is still owed.
//
// A row that is gone cannot say what it owned, so DONE is recorded while the agent can still be
// read: `agentOwed` over a reading, kept as a mark (`setAgentDone`: a cursor under
// `done|agent:<ws>/<name>`, machine-local) by every wait tick. The engine (src/wait.ts `ownedRefs`)
// drops a registered agent ref whose row is gone and which carries a mark: no event, no dead.
// Arming new work for the agent (`registerOwnedWait`) and a tick that finds it owed again clear the
// mark. A deliberate `agent close` needs no mark: it drops the agent's ref from every registration
// itself (closing on purpose is never a death; unfinished work stays owed through its task refs).

import type { Db } from "./db.js";
import { doneKey, readCursors } from "./wait-cursor.js";
import { callersOwing, type RefBaseline } from "./wait-registration.js";
import type { AgentReading } from "./wait-types.js";

/** How many tasks registry row `agentRowId` owns that are not CLOSED, and how many are. */
export function workOf(db: Db, agentRowId: number): { open: number; closed: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(status != 'CLOSED'), 0) AS open, COALESCE(SUM(status = 'CLOSED'), 0) AS closed
         FROM tasks WHERE owner_id = ?`,
    )
    .get(agentRowId) as { open: number; closed: number };
  return row;
}

/**
 * What a reading says about an agent ref: `owed` (busy, a dialog, a queued message or an open task),
 * `done` (idle, nothing queued, no open task, and its work ran: the run a producer fenced settled, or
 * with no usable fence the agent was seen busy or owns a CLOSED task) or `unsure` (no fact: an
 * unreadable agent, or idle before any run is known to have happened). Only `done` marks, so an agent
 * lost unread, or lost before it ran, still reads dead. A fence of another pi process, or one the
 * engine probed itself (`probedFence`: no producer sent a run), does not apply.
 */
export function agentOwed(
  db: Db,
  agentRowId: number,
  reading: Pick<AgentReading, "status" | "pending" | "blocked" | "runs" | "incarnation">,
  fence: RefBaseline | undefined,
  probedFence: boolean,
  wasBusy: boolean,
): "owed" | "done" | "unsure" {
  if (reading.status === null || reading.status === "unknown") return "unsure";
  if (reading.status !== "needs_input") return "owed";
  if (reading.pending === true || reading.blocked !== undefined) return "owed";
  const work = workOf(db, agentRowId);
  if (work.open > 0) return "owed";
  if (
    fence !== undefined &&
    !probedFence &&
    (fence.incarnation === undefined ||
      reading.incarnation === undefined ||
      fence.incarnation === reading.incarnation)
  ) {
    return reading.runs !== undefined && reading.runs > fence.afterRuns ? "done" : "unsure";
  }
  return wasBusy || work.closed > 0 ? "done" : "unsure";
}

/** Does `caller` hold a DONE mark for this agent? */
export function hasDoneMark(
  db: Db,
  caller: string,
  ref: { workstream: string; id: string },
): boolean {
  return readCursors(db, caller).has(doneKey(ref.workstream, ref.id));
}

/** Set or clear the DONE mark of an agent for `callers` (default: whoever's registration holds its ref). */
export function setAgentDone(
  db: Db,
  workstream: string,
  name: string,
  done: boolean,
  callers: readonly string[] = callersOwing(db, { kind: "agent", workstream, id: name }),
): void {
  const key = doneKey(workstream, name);
  for (const caller of callers) {
    if (hasDoneMark(db, caller, { workstream, id: name }) === done) continue;
    if (done) {
      db.prepare(
        "INSERT OR IGNORE INTO wait_cursors (caller, ref, incarnation, runs) VALUES (?, ?, 'done', 1)",
      ).run(caller, key);
    } else db.prepare("DELETE FROM wait_cursors WHERE caller = ? AND ref = ?").run(caller, key);
  }
}
