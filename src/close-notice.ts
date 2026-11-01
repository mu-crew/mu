// mu — the close notice: tell a worker its CLOSE block was refused.
//
// A settled run whose CLOSE block does not parse is recorded as
// "no close (malformed): <reason>" (close-block.ts) and the task stays
// IN_PROGRESS. The worker was never told, so it repeated the same shape
// (aiv-blog: 67 refusals). A wait that sees such a refusal sends the worker
// ONE fixed note: the reason, the exact shape, and "no CLOSE: while not done".
//
// Guarded like a stall action but not gated on `mu task auto`: it answers what
// the worker just wrote, it does not act on the task. Every condition is
// checked in ONE immediate transaction run by the ctl write fence
// (`beforeWrite`), immediately before the one write, together with the marks:
//   - the worker is the registry row that ran (id), a pi agent, spawned by one
//     of the wait's callers;
//   - the task is an IN_PROGRESS `work` task that row owns;
//   - at most once per (worker row, pi incarnation, run), and at most
//     NOTICE_CAP per incarnation (a worker that loops goes back to the
//     orchestrator as a stall).
// The marks are reserved-caller rows in `wait_cursors` (like logStallOnce),
// written BEFORE the write: at most once, never resent. A veto writes nothing
// and marks nothing. Only malformed blocks get a note; any other refusal
// (not the owner, a human task, already closed) is the orchestrator's.

import { agentCtlSocket, recordSend, sendViaTransport } from "./agents/transport.js";
import { getAgent } from "./agents.js";
import { CLOSE_MALFORMED } from "./close-block.js";
import { CTL_DEFAULT_TIMEOUT_MS, CtlWriteVetoedError } from "./ctl/client.js";
import type { Db } from "./db.js";
import { cursorKey } from "./wait-cursor.js";
import type { CloseOutcome, WaitRef } from "./wait-types.js";

/** Notes per pi incarnation; past it the refusal is left to the orchestrator. */
export const NOTICE_CAP = 3;

/** The reserved caller of the notice marks: no caller is spelled like it. */
const NOTICE_CALLER = "mu:close-notice";

/** What the wait knows when a settled run's CLOSE block was refused. */
export interface RefusedClose {
  workstream: string;
  /** The worker (agent name). */
  agent: string;
  /** Its registry row id. */
  agentId: number;
  /** pi's incarnation and the settled run's count. */
  incarnation: string;
  runs: number;
  /** The worker's one open task the refusal was noted on; null when none or several. */
  task: string | null;
  /** The refusal (`no close (malformed): ...`). */
  reason: string;
}

export type NoticeOutcome = "sent" | "skipped" | "unknown";

/** Is this refusal one a note can fix (a malformed block on a known task)? */
export function noticeable(r: { task: string | null; reason: string }): boolean {
  return r.task !== null && r.reason.startsWith(`${CLOSE_MALFORMED}: `);
}

/** The note: fixed text, filled only with the task id and the parser's reason. */
export function closeNoticeText(workstream: string, task: string, reason: string): string {
  const why = reason.slice(`${CLOSE_MALFORMED}: `.length);
  return [
    `[mu] Your CLOSE block for ${workstream}/${task} was not applied: ${why}.`,
    "If the task is done, end your final message with exactly:",
    `CLOSE: task=${task} evidence="<command + result>"`,
    "REPORT:",
    "<what you did>",
    "If it is not done, do not write CLOSE: at all.",
  ].join("\n");
}

/**
 * Send the note once, if every guard holds at the moment of the write.
 * Never throws: `sent`, `skipped` (a guard, a mark or the cap said no;
 * nothing written), or `unknown` (the write may have happened; never resent).
 */
export async function noticeRefusedClose(
  db: Db,
  r: RefusedClose,
  callers: readonly string[],
): Promise<NoticeOutcome> {
  const task = r.task;
  if (task === null || !noticeable(r) || callers.length === 0) return "skipped";
  const agent = getAgent(db, r.agent, r.workstream);
  if (agent === undefined || agent.incarnation !== r.agentId || agent.cli !== "pi") {
    return "skipped";
  }
  const text = closeNoticeText(r.workstream, task, r.reason);
  const runKey = `close-notice|${cursorKey("agent", r.workstream, r.agent)}`;
  const capKey = `close-notice-n|${cursorKey("agent", r.workstream, r.agent)}`;
  const who = `${r.agentId}|${r.incarnation}`;
  let won = false;
  const beforeWrite = (): boolean =>
    db
      .transaction((): boolean => {
        const row = db
          .prepare(
            `SELECT a.cli, a.spawner, w.name AS ws, a.name
               FROM agents a JOIN workstreams w ON w.id = a.workstream_id WHERE a.id = ?`,
          )
          .get(r.agentId) as
          | { cli: string; spawner: string | null; ws: string; name: string }
          | undefined;
        if (row === undefined || row.cli !== "pi" || row.ws !== r.workstream) return false;
        if (row.name !== r.agent || row.spawner === null || !callers.includes(row.spawner)) {
          return false;
        }
        const t = db
          .prepare(
            `SELECT t.status, t.kind, t.owner_id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
              WHERE w.name = ? AND t.local_id = ?`,
          )
          .get(r.workstream, task) as
          | { status: string; kind: string; owner_id: number | null }
          | undefined;
        if (t?.kind !== "work" || t.status !== "IN_PROGRESS" || t.owner_id !== r.agentId) {
          return false;
        }
        const mark = db.prepare(
          "SELECT incarnation, runs FROM wait_cursors WHERE caller = ? AND ref = ?",
        );
        const last = mark.get(NOTICE_CALLER, runKey) as
          | { incarnation: string | null; runs: number | null }
          | undefined;
        if (last?.incarnation === who && (last.runs ?? -1) >= r.runs) return false;
        const sent = mark.get(NOTICE_CALLER, capKey) as
          | { incarnation: string | null; runs: number | null }
          | undefined;
        const count = sent?.incarnation === who ? (sent.runs ?? 0) : 0;
        if (count >= NOTICE_CAP) return false;
        const put = db.prepare(
          `INSERT INTO wait_cursors (caller, ref, incarnation, runs) VALUES (?, ?, ?, ?)
             ON CONFLICT (caller, ref) DO UPDATE SET incarnation = excluded.incarnation, runs = excluded.runs`,
        );
        put.run(NOTICE_CALLER, runKey, who, r.runs);
        put.run(NOTICE_CALLER, capKey, who, count + 1);
        won = true;
        return true;
      })
      .immediate();
  try {
    const sent = await sendViaTransport(agent, text, {
      socket: agentCtlSocket(db, agent),
      expectIncarnation: r.incarnation,
      ctlGuard: { timeoutMs: CTL_DEFAULT_TIMEOUT_MS, beforeWrite },
    });
    try {
      recordSend(
        db,
        agent,
        "plain",
        Buffer.byteLength(text),
        { transport: sent.transport, state: sent.state, notice: "close-refused" },
        "mu:close-notice",
      );
    } catch {
      // the audit line is best-effort once delivered
    }
    return "sent";
  } catch (e) {
    // Nothing was written before the fence passed; after it, the write may have happened.
    if (e instanceof CtlWriteVetoedError || !won) return "skipped";
    return "unknown";
  }
}

/**
 * The wait's hook: a settled run of `ref` whose CLOSE block was refused as
 * malformed starts one notice (undefined when there is nothing to tell).
 * The promise never rejects.
 */
export function startCloseNotice(
  db: Db,
  ref: WaitRef,
  r: { incarnation?: string; runs?: number; agentId: number },
  close: CloseOutcome | undefined,
  callers: readonly string[],
): Promise<NoticeOutcome> | undefined {
  if (close === undefined || close.applied || !noticeable(close) || callers.length === 0) return;
  if (r.incarnation === undefined || r.runs === undefined || r.agentId === 0) return;
  return noticeRefusedClose(
    db,
    {
      workstream: ref.workstream,
      agent: ref.id,
      agentId: r.agentId,
      incarnation: r.incarnation,
      runs: r.runs,
      task: close.task,
      reason: close.reason,
    },
    callers,
  ).catch((): NoticeOutcome => "unknown");
}
