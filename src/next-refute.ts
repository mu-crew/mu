// mu — `executeNext --refute`, slice C: the opt-in durable checker.
//
// Each CLOSED/done attempt of an authorised task gets ONE checker (a delegate
// call, src/delegates.ts), launched and recorded by `mu next --refute`; a
// non-done close (wontfix, rejected, ...) has no claim to check and gets none.
// The durable once-key is the call id `refute:<ws>:<task>:<attempt key>`: a
// second invocation, a crash or a second `mu next` finds the row and resumes
// it, never registers another. No pi extension runs here, so the executor
// drives the whole lifecycle with the existing writers, one effect per step:
//   launch  registerDelegateCall (state `starting`, BEFORE any pane) then
//           `spawnForTask` for the delegate's own task (journaled, claim +
//           first prompt, replay-safe); `sent` marks the call `running`.
//           An unsent failure ends the call `failed`; a send that may have
//           landed stays `starting` and is probed ONCE by the next step (it
//           is never resent), then ends `failed` if still unknown.
//   read    the checker's settled run (or its death) is read once, bounded;
//           `finishDelegate` is the only recorder: the verdict note lands on
//           the judged task BEFORE the delegate's report and close.
// The checker is briefed from the pinned brief and the worker's report (note
// numbers named), runs with the task's stored cli unless one is given (no
// router), lives in `scratch` with the other delegates, and never grants auto
// permission, reopens, accepts or closes the judged work. Its pane is kept.
// The call belongs to the caller: another caller's identical wave is never
// mixed in, and its calls are never touched.

import { agentKey } from "./agent-state.js";
import { delegateOutcome } from "./agents/delegate.js";
import { AgentRestartedError, SpawnAttemptBusyError } from "./agents/errors.js";
import { observeAgentStates, watchAgentRun } from "./agents/observe.js";
import { getReceipt } from "./agents/receipts.js";
import { resolveCliCommand, speaksMuCtl } from "./agents/spawn.js";
import { savedIdentity, spawnForTask } from "./agents/task-spawn.js";
import { agentCtlSocket } from "./agents/transport.js";
import type { AgentRow } from "./agents.js";
import { deliveredOf } from "./auto-attempt.js";
import type { Db } from "./db.js";
import {
  DelegateCallConflictError,
  type DelegateRow,
  DelegateStateError,
  finishDelegate,
  getDelegateCall,
  markDelegate,
  registerDelegateCall,
} from "./delegates.js";
import { NoMultiplexerError } from "./mux/types.js";
import type { NextMove } from "./next.js";
import { idleOnCtl } from "./next-recover.js";
import { autoPermitted, getAutoConfig } from "./task-auto.js";
import { pinnedNotes } from "./task-brief.js";
import { taskIdFor } from "./tasks/core.js";
import { getTaskNote } from "./tasks/queries.js";
import type { WaitRef } from "./wait-types.js";

/** Where checkers (like every delegate) live: never counted against a crew's worker ceiling. */
export const REFUTE_WORKSTREAM = "scratch";
const READ_MS = 3000;
/** A checker still running after this long is recorded `timeout` (a hung checker never blocks its wave). */
const CHECK_TIMEOUT_S = 1800;

/** What reading a checker found. */
export type CheckerReading =
  | { kind: "running" }
  | { kind: "died" }
  | { kind: "answer"; outcome: string; text?: string };

/** Reads one checker once. `afterRuns` is the send's run baseline. Injected by tests. */
export type ReadChecker = (
  db: Db,
  agent: AgentRow,
  base: { afterRuns: number; inc: string | null },
  o: { signal?: AbortSignal; ms: number },
) => Promise<CheckerReading>;

/** The production reader: liveness from one state read, then (idle, past the baseline) the settled run over ctl. */
export const readChecker: ReadChecker = async (db, agent, base, { signal, ms }) => {
  const live = (await observeAgentStates(db, [agent])).get(agentKey(agent));
  if (live === undefined) return { kind: "running" };
  if (live.status === null) return { kind: "died" };
  if (!idleOnCtl(live) || live.runs === undefined || live.runs <= base.afterRuns) {
    return { kind: "running" };
  }
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  const onAbort = (): void => stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const watch = await watchAgentRun(agent, agentCtlSocket(db, agent), stop.signal, {
      afterRuns: base.afterRuns,
      ...(base.inc !== null ? { inc: base.inc } : {}),
    });
    const done = watch === undefined ? undefined : await watch.settled;
    if (done === undefined || !done.settled) return { kind: "running" };
    const outcome = delegateOutcome({ fired: true, dead: false, ...done }, false);
    return { kind: "answer", outcome, text: done.lastText ?? done.lastError };
  } catch (err) {
    if (err instanceof AgentRestartedError) return { kind: "died" };
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};

/** One checker step still owed. */
export interface Check {
  /** The durable once-key. */
  callId: string;
  /** The judged task and its delivered attempt. */
  task: string;
  attempt: string;
  workstream: string;
  /** The stored call, when one exists (this caller's). */
  call?: DelegateRow;
}

/**
 * The next check owed to `caller` not in `skip`: a CLOSED/done permitted task
 * whose delivered attempt has no call yet, or this caller's call that is
 * still `starting`, `running` or `recording`. Read-only.
 */
export function nextCheck(
  db: Db,
  workstream: string,
  caller: string,
  skip: ReadonlySet<string>,
): Check | undefined {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.local_id AS local_id
         FROM task_auto a
         JOIN tasks t ON t.id = a.task_id
         JOIN workstreams w ON w.id = t.workstream_id AND w.name = ?
        WHERE t.status = 'CLOSED' AND t.substate = 'done' ORDER BY t.id`,
    )
    .all(workstream) as { id: number; local_id: string }[];
  for (const r of rows) {
    if (!autoPermitted(db, r.id)) continue;
    const attempt = deliveredOf(db, r.id)?.receipt.attemptKey;
    if (attempt === undefined) continue;
    const callId = `refute:${workstream}:${r.local_id}:${attempt}`;
    if (skip.has(callId)) continue;
    const call = getDelegateCall(db, callId);
    if (call === undefined) return { callId, task: r.local_id, attempt, workstream };
    if (call.caller !== caller) continue;
    if (["starting", "running", "recording"].includes(call.state)) {
      return { callId, task: r.local_id, attempt, workstream, call };
    }
  }
  return undefined;
}

/** The checker's journaled delivery and the agent still holding it (undefined: gone or replaced). */
function checkerOf(db: Db, c: DelegateRow) {
  const taskId = taskIdFor(db, c.task, c.workstream);
  const receipt = taskId === null ? undefined : getReceipt(db, taskId, `manual:${c.task}`);
  const agent = receipt === undefined ? undefined : savedIdentity(db, receipt).agent;
  return receipt !== undefined && agent !== undefined ? { receipt, agent } : undefined;
}

/** This caller's running checkers as wait refs (a hold ends their wait on a settle or death). */
export function checkerRefs(db: Db, workstream: string, caller: string): WaitRef[] {
  const refs: WaitRef[] = [];
  for (const c of liveCalls(db, workstream, caller)) {
    const held = checkerOf(db, c);
    if (held === undefined) continue;
    const { receipt, agent } = held;
    refs.push({
      kind: "agent",
      workstream: agent.workstreamName,
      id: agent.name,
      afterRuns: receipt.runs ?? 0,
      ...(receipt.incarnation !== null ? { incarnation: receipt.incarnation } : {}),
    });
  }
  return refs;
}

function liveCalls(db: Db, workstream: string, caller: string): DelegateRow[] {
  return db
    .prepare(
      "SELECT call_id FROM delegate_calls WHERE caller = ? AND call_id LIKE ? AND state IN ('running','recording')",
    )
    .all(caller, `refute:${workstream}:%`)
    .map((r) => getDelegateCall(db, (r as { call_id: string }).call_id))
    .filter((c): c is DelegateRow => c !== undefined);
}

const stem = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 13)
    .replace(/^-+|-+$/g, "");

function checkerText(db: Db, ws: string, task: string, attempt: string): string {
  const { briefN, reportN } = pinnedNotes(db, ws, task);
  const part = (what: string, n: number): string =>
    n < 1
      ? `${what}: (none)`
      : `${what} (note #${n}):\n${getTaskNote(db, task, ws, n).content.trimEnd()}`;
  return [
    `You are an independent checker of the work on task ${task} (workstream ${ws}), attempt ${attempt}. Read only: do not edit, commit, merge, close or accept anything.`,
    part("Pinned brief", briefN),
    part("The worker's report", reportN),
    "Try to refute the claim that the work meets the brief: read the code and run the checks yourself. End your final message with a line starting `VERDICT:` and one of CONFIRMED, REFUTED, UNVERIFIED, then `EVIDENCE:` lines naming what you ran and saw.",
  ].join("\n\n");
}

/** What `--dry` says of one check. */
export const planCheck = (
  c: Check,
): { kind: "refute"; task: string; key: string; state: string } => ({
  kind: "refute",
  task: c.task,
  key: c.callId,
  state: c.call?.state ?? "new",
});

export interface RunCheckDeps {
  /** The checker's cli: the task's stored key unless the caller chose one. */
  cli?: string;
  caller: string;
  read: ReadChecker;
  signal?: AbortSignal;
}

/** One effect of one check: launch (register + spawn), or read and record. Throws `NoMultiplexerError`; everything else is a move. */
export async function runCheck(db: Db, c: Check, deps: RunCheckDeps): Promise<NextMove> {
  const base = { task: c.task, key: c.callId };
  const taskId = taskIdFor(db, c.task, c.workstream);
  const auto = taskId === null ? undefined : getAutoConfig(db, taskId);
  let call = c.call;
  if (call === undefined) {
    const cli = deps.cli ?? auto?.cli ?? "pi";
    if (!speaksMuCtl(cli, resolveCliCommand(cli))) {
      return {
        kind: "skip",
        ...base,
        cli,
        reason: `cli ${cli} cannot report an answer over ctl: pass --refute-cli pi`,
      };
    }
    try {
      call = registerDelegateCall(db, {
        callId: c.callId,
        caller: deps.caller,
        workstream: REFUTE_WORKSTREAM,
        wave: `refute-${c.workstream}`,
        record: { workstream: c.workstream, task: c.task },
        state: "starting",
        request: {
          text: checkerText(db, c.workstream, c.task, c.attempt),
          label: `refute-${c.task}`,
          cli,
          timeoutS: CHECK_TIMEOUT_S,
        },
      }).call;
    } catch (err) {
      if (err instanceof DelegateCallConflictError) {
        return { kind: "skip", ...base, reason: "another mu registered this check first" };
      }
      throw err;
    }
  }
  if (call.state === "starting") return launch(db, call, base);
  return readOne(db, call, base, deps);
}

async function launch(
  db: Db,
  call: DelegateRow,
  base: { task: string; key: string },
): Promise<NextMove> {
  const cli = call.request.cli ?? "pi";
  try {
    const out = await spawnForTask(db, {
      task: call.task,
      text: call.request.text,
      spawn: {
        name: `delegate-refute-${stem(base.task)}`,
        workstream: call.workstream,
        cli,
        nextFree: true,
      },
    });
    const agent = out.agent?.name ?? out.receipt.name;
    if (out.state === "unknown") {
      // A first send that may have landed is probed once (the replay); still unknown ends the call, never a resend.
      if (!out.replay)
        return {
          kind: "refute",
          ...base,
          agent,
          cli,
          state: "starting",
          reason: out.reason ?? "delivery unknown",
        };
      return end(
        db,
        call,
        base,
        "error",
        `delivery unknown after one probe (${out.reason ?? "no reply"}); pane ${agent} kept`,
      );
    }
    try {
      markDelegate(db, call.callId, "running", { agent });
    } catch (err) {
      if (!(err instanceof DelegateStateError)) throw err; // another mu already marked it
    }
    return { kind: "refute", ...base, agent, cli, state: "running" };
  } catch (err) {
    if (err instanceof NoMultiplexerError) throw err;
    if (err instanceof SpawnAttemptBusyError) {
      return { kind: "skip", ...base, reason: "another mu is launching this checker" };
    }
    const reason = err instanceof Error ? err.message : String(err);
    const done = end(db, call, base, "error", `the checker could not be started: ${reason}`);
    return { ...done, kind: "failed", reason };
  }
}

function end(
  db: Db,
  call: DelegateRow,
  base: { task: string; key: string },
  outcome: string,
  text?: string,
  agent?: string,
): NextMove {
  const r = finishDelegate(db, call.callId, {
    outcome,
    ...(text !== undefined ? { text } : {}),
    elapsedMs: Math.max(0, Date.now() - Date.parse(call.updatedAt)),
    author: agent ?? call.agent ?? "next",
  });
  return {
    kind: "refute",
    ...base,
    ...(call.agent !== null ? { agent: call.agent } : {}),
    state: r.state,
    ...(r.verdict !== null ? { verdict: r.verdict } : {}),
    ...(r.error !== undefined ? { reason: r.error } : {}),
  };
}

async function readOne(
  db: Db,
  call: DelegateRow,
  base: { task: string; key: string },
  deps: RunCheckDeps,
): Promise<NextMove> {
  const held = checkerOf(db, call);
  if (held === undefined) {
    return end(db, call, base, "died", "the checker's agent is gone", call.agent ?? "next");
  }
  const { receipt, agent } = held;
  const got = await deps.read(
    db,
    agent,
    { afterRuns: receipt.runs ?? 0, inc: receipt.incarnation },
    { ...(deps.signal !== undefined ? { signal: deps.signal } : {}), ms: READ_MS },
  );
  if (got.kind === "running") {
    const late =
      Date.now() - Date.parse(call.updatedAt) > (call.request.timeoutS ?? CHECK_TIMEOUT_S) * 1000;
    if (!late) return { kind: "refute", ...base, agent: agent.name, state: "running" };
    return end(db, call, base, "timeout", undefined, agent.name);
  }
  return end(
    db,
    call,
    base,
    got.kind === "died" ? "died" : got.outcome,
    got.kind === "answer" ? got.text : undefined,
    agent.name,
  );
}
