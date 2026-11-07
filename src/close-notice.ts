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
//     orchestrator as a stall);
//   - the workstream is not torn down.
// The marks are reserved-caller rows in `wait_cursors` (like logStallOnce),
// keyed by the row and incarnation, written BEFORE the write: at most once,
// never resent. A veto writes nothing and marks nothing. Only malformed
// blocks get a note; any other refusal (not the owner, a human task, already
// closed) is the orchestrator's. A run another caller's wait applied first
// ("already applied") is parsed again from its text, so its spawner's wait
// still tells the worker.

import { recordSend } from "./agents/transport.js";
import { getAgent } from "./agents.js";
import {
  CTL_DEFAULT_TIMEOUT_MS,
  CtlWriteVetoedError,
  channelTarget,
  deliver,
} from "./channels/index.js";
import { CLOSE_MALFORMED, CLOSE_SHAPE, malformedReason, parseCloseBlock } from "./close-block.js";
import type { Db } from "./db.js";
import { cursorKey } from "./wait-cursor.js";
import type { CloseOutcome, WaitRef } from "./wait-types.js";

/** Notes per pi incarnation; past it the refusal is left to the orchestrator. */
export const NOTICE_CAP = 3;

/** How long a returning wait gives its notices in flight (a ctl send, not a mux read). */
export const NOTICE_GRACE_MS = 3000;

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
  // The note prints the shape on its own lines: drop the reason's one-line copy.
  const why = reason.slice(`${CLOSE_MALFORMED}: `.length).replace(`; ${CLOSE_SHAPE}`, "");
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
  signal?: AbortSignal,
): Promise<NoticeOutcome> {
  const task = r.task;
  if (task === null || !noticeable(r) || callers.length === 0) return "skipped";
  const agent = getAgent(db, r.agent, r.workstream);
  if (agent === undefined || agent.incarnation !== r.agentId || agent.cli !== "pi") {
    return "skipped";
  }
  const text = closeNoticeText(r.workstream, task, r.reason);
  // Keyed by the incarnation itself: a late notice for an old pi never touches the live one's marks.
  const who = `${r.agentId}|${r.incarnation}`;
  const runKey = `close-notice|${cursorKey("agent", r.workstream, r.agent)}|${who}`;
  const capKey = `close-notice-n|${cursorKey("agent", r.workstream, r.agent)}|${who}`;
  let won = false;
  const beforeWrite = (): boolean =>
    db
      .transaction((): boolean => {
        const row = db
          .prepare(
            `SELECT a.cli, a.spawner, w.name AS ws, a.name
               FROM agents a JOIN workstreams w ON w.id = a.workstream_id
              WHERE a.id = ? AND w.torn_down_at IS NULL`,
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
        const last = mark.get(NOTICE_CALLER, runKey) as { runs: number | null } | undefined;
        if ((last?.runs ?? -1) >= r.runs) return false;
        const sent = mark.get(NOTICE_CALLER, capKey) as { runs: number | null } | undefined;
        const count = sent?.runs ?? 0;
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
    const sent = await deliver(channelTarget(db, agent), text, {
      expectIncarnation: r.incarnation,
      ctlGuard: {
        timeoutMs: CTL_DEFAULT_TIMEOUT_MS,
        beforeWrite,
        ...(signal !== undefined ? { signal } : {}),
      },
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
  r: {
    incarnation?: string;
    runs?: number;
    agentId: number;
    lastText?: string;
    lastTextTruncated?: boolean;
  },
  close: CloseOutcome | undefined,
  callers: readonly string[],
  signal?: AbortSignal,
): Promise<NoticeOutcome> | undefined {
  if (close === undefined || close.applied || callers.length === 0) return;
  if (r.incarnation === undefined || r.runs === undefined || r.agentId === 0) return;
  // Another wait (another caller's) applied this run first: the refusal is
  // the same parse of the same text, so read it again here.
  const refused = close.reason === "already applied" ? reparse(db, ref, r) : close;
  if (refused === undefined || !noticeable(refused)) return;
  return noticeRefusedClose(
    db,
    {
      workstream: ref.workstream,
      agent: ref.id,
      agentId: r.agentId,
      incarnation: r.incarnation,
      runs: r.runs,
      task: refused.task,
      reason: refused.reason,
    },
    callers,
    signal,
  ).catch((): NoticeOutcome => "unknown");
}

/** The malformed refusal of an already-applied run, from its text: on the agent's one open task. */
function reparse(
  db: Db,
  ref: WaitRef,
  r: { agentId: number; lastText?: string; lastTextTruncated?: boolean },
): CloseOutcome | undefined {
  if (r.lastText === undefined || r.lastTextTruncated === true) return;
  const block = parseCloseBlock(r.lastText);
  if (block.kind !== "malformed") return;
  const open = db
    .prepare(
      `SELECT t.local_id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE t.owner_id = ? AND t.status = 'IN_PROGRESS' AND w.name = ?`,
    )
    .all(r.agentId, ref.workstream) as { local_id: string }[];
  const task = open.length === 1 ? (open[0]?.local_id ?? null) : null;
  return { applied: false, task, reason: malformedReason(block.reason) };
}

/**
 * One wait's close notices: `start` on a refused settle, `answers` tells the
 * stall driver a run already has a notice (in flight or written: no steer on
 * top of it), `settle` gives the notices in flight at most NOTICE_GRACE_MS
 * when the wait returns (none when it was stopped) and never longer: a
 * notice still pending finishes or not; its mark means it is never resent.
 */
export function closeNotices(
  db: Db,
  callers: readonly string[],
  signal: AbortSignal,
  wake: () => void,
): {
  start: (
    ref: WaitRef,
    r: Parameters<typeof startCloseNotice>[2],
    close: CloseOutcome | undefined,
  ) => void;
  answers: (agent: { workstreamName: string; name: string }, runs: number | undefined) => boolean;
  settle: (graceful: boolean) => Promise<void>;
} {
  const inFlight: Promise<unknown>[] = [];
  const told = new Map<string, number>();
  const keyOf = (ws: string, name: string): string => `${ws}/${name}`;
  return {
    start: (ref, r, close) => {
      const p = startCloseNotice(db, ref, r, close, callers, signal);
      if (p === undefined || r.runs === undefined) return;
      inFlight.push(p);
      const key = keyOf(ref.workstream, ref.id);
      const runs = r.runs;
      told.set(key, runs);
      void p.then((o) => {
        if (o === "skipped" && told.get(key) === runs) told.delete(key);
        wake();
      });
    },
    answers: (agent, runs) => {
      const t = told.get(keyOf(agent.workstreamName, agent.name));
      return t !== undefined && (runs ?? 0) <= t;
    },
    settle: async (graceful) => {
      if (inFlight.length === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(inFlight),
        new Promise<void>((r) => {
          timer = setTimeout(r, graceful ? NOTICE_GRACE_MS : 0);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
