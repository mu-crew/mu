// mu — delegate calls as durable tasks (docs/VOCABULARY.md § delegate call).
//
// A `mu_delegate` call is a `kind=delegate` task with its brief, plus one
// machine-local `delegate_calls` row keyed by a session-qualified `call_id`
// (the caller's own id: `pi:<session>:<n>`). The task is the durable, waitable
// face of the call (state, report, close); the row holds what is not
// portable: the caller, the spawn request, the record target, the lifecycle.
//
// Writers (the only ones; the extension and the CLI both call these):
//   registerDelegateCall   task + brief + row in ONE transaction; idempotent
//                          per call_id; a changed request under it is refused.
//   markDelegate           admission CAS: queued -> starting -> running, or
//                          queued/starting -> refused, or refused -> queued |
//                          starting (a reissue: same call, same task, by the
//                          live runtime that will run or queue it).
//                          `recording`/`done`/... are finishDelegate's.
//   finishDelegate         THE recorder. `recording` is committed first, then
//                          ONE op group writes the verdict note on the judged
//                          task, the delegate's report and its close. If the
//                          record fails the call is `failed`, never `done`,
//                          and the answer is kept as the report. A duplicate
//                          callback changes nothing.
//
// Readers: listDelegates, getDelegateCall, verdictTally. The tally attributes
// ONE result per call_id (its own parsed `verdict`) to the qualified judged
// task; it never scans label-matched notes (they carry no call id).

import { createHash } from "node:crypto";
import type { Db, DELEGATE_CALL_STATES } from "./db.js";
import { parseVerdict, recordNote, type VerdictLabel } from "./delegate-verdict.js";
import { withOpContext } from "./op-context.js";
import { addNote, addTask } from "./tasks/edit.js";
import { TaskNotFoundError } from "./tasks/errors.js";
import { closeTask, setTaskStatus } from "./tasks/lifecycle.js";
import { getTask } from "./tasks/queries.js";

export { parseVerdict, type VerdictLabel } from "./delegate-verdict.js";

export type DelegateState = (typeof DELEGATE_CALL_STATES)[number];
export const TERMINAL_DELEGATE_STATES: readonly DelegateState[] = ["done", "failed", "cancelled"];
const TERMINAL = TERMINAL_DELEGATE_STATES;
const isTerminal = (s: DelegateState): boolean => TERMINAL.includes(s);

/** What a call needs to start again from nothing: the prompt and the spawn options. */
export interface DelegateRequest {
  /** The whole prompt sent to the delegate (standing brief and task); also the task's brief note. */
  text: string;
  label?: string;
  cli?: string;
  model?: string;
  cwd?: string;
  workspace?: boolean;
  timeoutS?: number;
  keep?: boolean;
}

export interface RecordRef {
  workstream: string;
  task: string;
}

export interface DelegateRow {
  callId: string;
  /** The delegate task's local id, in `workstream`. */
  task: string;
  workstream: string;
  caller: string;
  state: DelegateState;
  wave: string | null;
  record: (RecordRef & { label: string | null }) | null;
  request: DelegateRequest;
  /** The agent that ran it, once running. */
  agent: string | null;
  /** The parsed verdict label of a done answer; null otherwise. */
  verdict: VerdictLabel | null;
  error: string | null;
  updatedAt: string;
}

export class DelegateCallConflictError extends Error {
  override readonly name = "DelegateCallConflictError";
  constructor(
    public readonly callId: string,
    public readonly field: string,
  ) {
    super(
      `delegate call ${callId} already exists with a different ${field}; a call id names one request. Use a new call id for a changed request`,
    );
  }
}

export class DelegateStateError extends Error {
  override readonly name = "DelegateStateError";
  constructor(
    public readonly callId: string,
    public readonly from: DelegateState,
    public readonly to: string,
  ) {
    super(`delegate call ${callId} is ${from}; it cannot go to ${to}`);
  }
}

export class DelegateNotFoundError extends Error {
  override readonly name = "DelegateNotFoundError";
  constructor(public readonly callId: string) {
    super(`no such delegate call: ${callId}`);
  }
}

interface RawCall {
  task_id: number;
  caller: string;
  call_id: string;
  state: DelegateState;
  record_workstream: string | null;
  record_task: string | null;
  record_label: string | null;
  error: string | null;
  updated_at: string;
  request: string | null;
  verdict: string | null;
  agent: string | null;
  local_id: string;
  workstream: string;
  wave: string | null;
}

const SELECT_CALL = `SELECT d.*, t.local_id AS local_id, w.name AS workstream, t.wave AS wave
  FROM delegate_calls d
  JOIN tasks t ON t.id = d.task_id
  JOIN workstreams w ON w.id = t.workstream_id`;

function rowOf(r: RawCall): DelegateRow {
  let request: DelegateRequest = { text: "" };
  try {
    if (r.request) request = JSON.parse(r.request) as DelegateRequest;
  } catch {
    // an unreadable request is an empty one; the brief note still has the text
  }
  return {
    callId: r.call_id,
    task: r.local_id,
    workstream: r.workstream,
    caller: r.caller,
    state: r.state,
    wave: r.wave,
    record:
      r.record_workstream !== null && r.record_task !== null
        ? { workstream: r.record_workstream, task: r.record_task, label: r.record_label }
        : null,
    request,
    agent: r.agent,
    verdict: (r.verdict as VerdictLabel | null) ?? null,
    error: r.error,
    updatedAt: r.updated_at,
  };
}

export function getDelegateCall(db: Db, callId: string): DelegateRow | undefined {
  const r = db.prepare(`${SELECT_CALL} WHERE d.call_id = ?`).get(callId) as RawCall | undefined;
  return r ? rowOf(r) : undefined;
}

function mustGet(db: Db, callId: string): DelegateRow {
  const row = getDelegateCall(db, callId);
  if (!row) throw new DelegateNotFoundError(callId);
  return row;
}

/** Calls of `caller` (all callers when undefined), optionally in one workstream and wave, oldest first. */
export function listDelegates(
  db: Db,
  caller?: string,
  workstream?: string,
  opts: { wave?: string; states?: readonly DelegateState[] } = {},
): DelegateRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (caller !== undefined) {
    where.push("d.caller = ?");
    args.push(caller);
  }
  if (workstream !== undefined) {
    where.push("w.name = ?");
    args.push(workstream);
  }
  if (opts.wave !== undefined) {
    where.push("t.wave = ?");
    args.push(opts.wave);
  }
  if (opts.states !== undefined) {
    where.push(`d.state IN (${opts.states.map(() => "?").join(",")})`);
    args.push(...opts.states);
  }
  const sql = `${SELECT_CALL}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY d.task_id`;
  return (db.prepare(sql).all(...args) as RawCall[]).map(rowOf);
}

/** Calls of any of `callers` (the union, each call once, oldest first), optionally in one workstream and wave. `[]` is no calls. */
export function listDelegatesOf(
  db: Db,
  callers: readonly string[],
  workstream?: string,
  opts: { wave?: string } = {},
): DelegateRow[] {
  const set = [...new Set(callers)];
  if (set.length === 0) return [];
  const where = [`d.caller IN (${set.map(() => "?").join(",")})`];
  const args: string[] = [...set];
  if (workstream !== undefined) {
    where.push("w.name = ?");
    args.push(workstream);
  }
  if (opts.wave !== undefined) {
    where.push("t.wave = ?");
    args.push(opts.wave);
  }
  const sql = `${SELECT_CALL} WHERE ${where.join(" AND ")} ORDER BY d.task_id`;
  return (db.prepare(sql).all(...args) as RawCall[]).map(rowOf);
}

/** JSON with sorted keys and no undefined, so two spellings of one request compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** `delegate_<label>_<8 hex of the call id>`: stable per call, unique per id. */
function taskIdFor(callId: string, label: string | undefined): string {
  const stem = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  const h = createHash("sha256").update(callId).digest("hex").slice(0, 8);
  return `delegate_${stem ? `${stem}_` : ""}${h}`;
}

const now = (): string => new Date().toISOString();

export interface RegisterDelegateOptions {
  callId: string;
  caller: string;
  /** Where the task (and the delegate agent) lives. The extension's default is `scratch`. */
  workstream: string;
  request: DelegateRequest;
  wave?: string;
  /** The task the answer's verdict is written onto; must exist. */
  record?: RecordRef;
  /** Admission: `starting` (a slot is free), `queued` (waits for one), `refused` (past the queue). */
  state?: "queued" | "starting" | "refused";
}

/**
 * Create the call: a `kind=delegate` task, its brief note and the call row,
 * in ONE transaction. A queued or refused task is parked (outside
 * `next`/`ready`); a starting one is todo. The same call id with the same
 * request returns the existing call; a different one throws
 * {@link DelegateCallConflictError} and writes nothing.
 */
export function registerDelegateCall(
  db: Db,
  opts: RegisterDelegateOptions,
): { call: DelegateRow; created: boolean } {
  const state = opts.state ?? "queued";
  return withOpContext(db, { intent: "delegate.register", actor: opts.caller, group: "new" }, () =>
    db
      .transaction(() => {
        const existing = getDelegateCall(db, opts.callId);
        if (existing) {
          const same = (field: string, a: unknown, b: unknown) => {
            if (canonical(a) !== canonical(b))
              throw new DelegateCallConflictError(opts.callId, field);
          };
          same("caller", existing.caller, opts.caller);
          same("workstream", existing.workstream, opts.workstream);
          same("wave", existing.wave, opts.wave ?? null);
          same(
            "record target",
            existing.record
              ? { workstream: existing.record.workstream, task: existing.record.task }
              : null,
            opts.record ?? null,
          );
          same("request", existing.request, opts.request);
          return { call: existing, created: false };
        }
        if (opts.record && !getTask(db, opts.record.task, opts.record.workstream))
          throw new TaskNotFoundError(opts.record.task, opts.record.workstream);
        const local = taskIdFor(opts.callId, opts.request.label);
        const headline = (opts.request.label ?? opts.request.text).replace(/\s+/g, " ").trim();
        addTask(db, {
          localId: local,
          workstream: opts.workstream,
          title: `delegate: ${headline.slice(0, 60)}`,
          kind: "delegate",
          ...(opts.wave !== undefined ? { wave: opts.wave } : {}),
        });
        addNote(db, local, opts.request.text, {
          workstream: opts.workstream,
          kind: "brief",
          author: opts.caller,
          group: "inherit",
        });
        if (state !== "starting")
          setTaskStatus(db, local, "OPEN", { workstream: opts.workstream, substate: "parked" });
        const taskId = (
          db
            .prepare(
              "SELECT t.id AS id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ? AND t.local_id = ?",
            )
            .get(opts.workstream, local) as { id: number }
        ).id;
        db.prepare(
          `INSERT INTO delegate_calls
               (task_id, caller, call_id, state, record_workstream, record_task, record_label, updated_at, request)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          taskId,
          opts.caller,
          opts.callId,
          state,
          opts.record?.workstream ?? null,
          opts.record?.task ?? null,
          opts.request.label ?? null,
          now(),
          canonical(opts.request),
        );
        return { call: mustGet(db, opts.callId), created: true };
      })
      .immediate(),
  );
}

/** The admission moves `markDelegate` allows. */
const MOVES: Readonly<Record<string, readonly DelegateState[]>> = {
  queued: ["refused"],
  starting: ["queued", "refused"],
  running: ["starting"],
  refused: ["queued", "starting"],
};

/**
 * One admission step, as a compare-and-set on the current state: two runtimes
 * cannot both start a call. `starting` unparks the task; `refused` parks it.
 * `queued` from `refused` is the reissue: nothing drains a durable queued row
 * but the runtime that holds it, so only that runtime may make one.
 * `done`, `failed`, `cancelled` and `recording` belong to {@link finishDelegate}.
 */
export function markDelegate(
  db: Db,
  callId: string,
  to: "queued" | "starting" | "running" | "refused",
  extra: { agent?: string; error?: string } = {},
): DelegateRow {
  const row = mustGet(db, callId);
  const from = MOVES[to] ?? [];
  if (!from.includes(row.state)) throw new DelegateStateError(callId, row.state, to);
  return withOpContext(db, { intent: `delegate.${to}`, actor: row.caller, group: "new" }, () =>
    db
      .transaction(() => {
        const r = db
          .prepare(
            `UPDATE delegate_calls
                SET state = ?, updated_at = ?, agent = COALESCE(?, agent),
                    error = CASE WHEN ? = 'refused' THEN COALESCE(?, error) ELSE NULL END
              WHERE call_id = ? AND state = ?`,
          )
          .run(to, now(), extra.agent ?? null, to, extra.error ?? null, callId, row.state);
        if (r.changes !== 1) throw new DelegateStateError(callId, mustGet(db, callId).state, to);
        if (to === "starting")
          setTaskStatus(db, row.task, "OPEN", { workstream: row.workstream, substate: "todo" });
        if (to === "refused")
          setTaskStatus(db, row.task, "OPEN", { workstream: row.workstream, substate: "parked" });
        return mustGet(db, callId);
      })
      .immediate(),
  );
}

export interface FinishDelegateOptions {
  /** `done`, or why there is no answer: `timeout`, `died`, `error`, `empty`, `blocked`, `cancelled`, ... */
  outcome: string;
  /** The answer (done) or what is known of the run (the partial text, a pane tail). */
  text?: string;
  elapsedMs?: number;
  /** Who writes: the delegate's name, or the caller for a cancel. */
  author: string;
  /** False: leave the judged task alone (a spawn that never ran has no verdict to give). */
  record?: boolean;
}

export interface FinishDelegateResult {
  /** False for a duplicate callback: nothing was written. */
  changed: boolean;
  state: DelegateState;
  task: string;
  record: RecordRef | null;
  /** Whether the verdict note landed on the judged task. */
  recorded: boolean;
  verdict: VerdictLabel | null;
  error?: string;
}

function finishText(outcome: string, text: string | undefined): string {
  if (outcome === "done") return text ?? "";
  return `no answer (${outcome})${text?.trim() ? `\n\n${text.trimEnd()}` : ""}`;
}

/**
 * The recorder. 1) `recording` is committed. 2) ONE op group: the verdict note
 * on the judged task (when there is a record target), then the delegate's
 * report and close, then the final state. A throw in 2 rolls the group back;
 * the call then becomes `failed` with the answer kept as its report: it is
 * never `done` without its verdict landed. A call already terminal is a no-op,
 * so a duplicate callback writes one verdict, one report and one close.
 */
export function finishDelegate(
  db: Db,
  callId: string,
  opts: FinishDelegateOptions,
): FinishDelegateResult {
  const before = mustGet(db, callId);
  const unchanged = (row: DelegateRow): FinishDelegateResult => ({
    changed: false,
    state: row.state,
    task: row.task,
    record: row.record ? { workstream: row.record.workstream, task: row.record.task } : null,
    recorded: false,
    verdict: row.verdict,
  });
  if (isTerminal(before.state)) return unchanged(before);
  db.prepare(
    "UPDATE delegate_calls SET state = 'recording', updated_at = ? WHERE call_id = ? AND state NOT IN ('done','failed','cancelled')",
  ).run(now(), callId);

  const outcome = opts.outcome === "done" && !opts.text?.trim() ? "empty" : opts.outcome;
  const answered = outcome === "done";
  const cancelled = outcome === "cancelled";
  const label = before.record?.label ?? before.request.label ?? opts.author;
  const verdict = answered ? (parseVerdict(opts.text ?? "") ?? null) : null;
  const record = before.record
    ? { workstream: before.record.workstream, task: before.record.task }
    : null;
  const report = finishText(outcome, opts.text);

  const wantRecord = opts.record !== false;
  const write = (recordIt: boolean, error?: string): FinishDelegateResult =>
    withOpContext(db, { intent: "delegate.finish", actor: opts.author, group: "new" }, () =>
      db
        .transaction((): FinishDelegateResult => {
          const cur = mustGet(db, callId);
          if (isTerminal(cur.state)) return unchanged(cur);
          if (recordIt && record)
            addNote(
              db,
              record.task,
              recordNote(label, opts.author, outcome, opts.text, opts.elapsedMs ?? 0),
              {
                workstream: record.workstream,
                kind: "verdict",
                author: opts.author,
                group: "inherit",
              },
            );
          const ok = answered && error === undefined;
          const state: DelegateState = ok ? "done" : cancelled ? "cancelled" : "failed";
          closeTask(db, cur.task, {
            workstream: cur.workstream,
            author: opts.author,
            group: "inherit",
            report,
            as: ok ? "done" : cancelled ? "wontfix" : "rejected",
            ...(ok
              ? { evidence: `answered ${verdict ?? "NO VERDICT"} (call ${callId})` }
              : { why: error ?? `${outcome}: no answer (call ${callId})` }),
          });
          db.prepare(
            "UPDATE delegate_calls SET state = ?, verdict = ?, error = ?, updated_at = ? WHERE call_id = ?",
          ).run(state, ok ? verdict : null, error ?? null, now(), callId);
          return {
            changed: true,
            state,
            task: cur.task,
            record,
            recorded: recordIt && record !== null,
            verdict: ok ? verdict : null,
            ...(error !== undefined ? { error } : {}),
          };
        })
        .immediate(),
    );

  try {
    return write(wantRecord);
  } catch (e) {
    // The record (or the close) failed and the group rolled back: keep the
    // answer as the delegate's report and say why. Never `done`.
    const msg = e instanceof Error ? e.message : String(e);
    return write(
      false,
      `record ${record ? `${record.workstream}/${record.task} ` : ""}failed: ${msg}`,
    );
  }
}

/** The tally of one wave: see {@link verdictTally}. */
export interface VerdictTally {
  findings: {
    id: string;
    confirmed: number;
    refuted: number;
    unverified: number;
    pending: number;
  }[];
  queued: number;
  running: number;
  /** Call ids refused past the cap, still to reissue. */
  refused: string[];
}

/**
 * One wave's results, grouped by the judged task (`<workstream>/<task>`, or the
 * delegate's own task for a call with no record target). One result per call:
 * a done answer counts its parsed label (none: UNVERIFIED); failed and
 * cancelled calls are UNVERIFIED; queued, starting, running, recording and
 * refused are pending. Reads only the call rows, never notes. `callers`
 * restricts the wave to those callers' calls (a SET: managed ws/name and
 * pi:session; `[]` is no calls): two callers may use the same wave name in one
 * workstream. `undefined` reads every caller (a human's view).
 */
export function verdictTally(
  db: Db,
  workstream: string,
  wave: string,
  /** Only these callers' calls (`mu state` never mixes in another session's identically named wave); `[]` is none. */
  callers?: readonly string[],
): VerdictTally {
  const out: VerdictTally = { findings: [], queued: 0, running: 0, refused: [] };
  const byId = new Map<string, VerdictTally["findings"][number]>();
  const calls =
    callers === undefined
      ? listDelegates(db, undefined, workstream, { wave })
      : listDelegatesOf(db, callers, workstream, { wave });
  for (const c of calls) {
    const id = c.record ? `${c.record.workstream}/${c.record.task}` : `${c.workstream}/${c.task}`;
    let f = byId.get(id);
    if (!f) {
      f = { id, confirmed: 0, refuted: 0, unverified: 0, pending: 0 };
      byId.set(id, f);
      out.findings.push(f);
    }
    switch (c.state) {
      case "done":
        if (c.verdict === "CONFIRMED") f.confirmed++;
        else if (c.verdict === "REFUTED") f.refuted++;
        else f.unverified++;
        break;
      case "failed":
      case "cancelled":
        f.unverified++;
        break;
      case "refused":
        f.pending++;
        out.refused.push(c.callId);
        break;
      case "queued":
        f.pending++;
        out.queued++;
        break;
      default:
        f.pending++;
        out.running++;
    }
  }
  return out;
}
