// mu — recorded checks (spec D5): `mu task check` and `mu task verdict`.
//
// claude, codex, muse and cursor-agent orchestrators check a finding with
// their native subagents (or a cross-family scratch pane) instead of
// `mu_delegate`. These verbs record that work in the portable `checks` table
// (src/db-checks.ts), so a verdict is something mu recorded, not something an
// orchestrator says happened. `mu state` lists the checks still without a
// verdict, so a replacement orchestrator sees which were issued and which
// were lost, and `mu task close --if-ready` waits for them.

import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import type { CheckState } from "./db-checks.js";
import { parseVerdict, type VerdictLabel } from "./delegate-verdict.js";
import { HARNESSES, isHarness } from "./harnesses.js";
import { say } from "./messages.js";
import { withOpContext } from "./op-context.js";
import { taskIdFor } from "./tasks/core.js";
import { TaskNotFoundError } from "./tasks/errors.js";

/** No check with that id on that task. Exit 3 (not found). */
export class CheckNotFoundError extends Error {
  override readonly name = "CheckNotFoundError";
  constructor(
    public readonly checkId: string,
    public readonly task: string,
  ) {
    super(say("check.not_found", checkId, task));
  }
}

/** A malformed `--by`, an empty brief, or a verdict with no VERDICT line.
 *  Exit 2 (usage). */
export class CheckArgError extends Error {
  override readonly name = "CheckArgError";
}

/** One recorded check, as the verbs and `mu state` show it. */
export interface CheckRow {
  id: string;
  /** The checked task's local id. */
  task: string;
  workstream: string;
  /** `<harness>/<model>` (or `<harness>` alone) that ran (or runs) the check. */
  by: string;
  brief: string;
  /** The VERDICT/EVIDENCE lines as recorded; null until answered. */
  verdict: string | null;
  /** The label on the verdict's first VERDICT line; null until answered. */
  label: VerdictLabel | null;
  state: CheckState;
  createdAt: string;
  updatedAt: string;
}

// ─── ULID ─────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of milliseconds then 80 random bits, Crockford base32
 *  (26 characters, sorting by time). Two machines never mint the same one,
 *  so a check id needs no coordination. `nowMs` and `random` are test seams. */
export function newCheckId(
  nowMs: number = Date.now(),
  random: Uint8Array = randomBytes(10),
): string {
  let time = "";
  let t = Math.max(0, Math.floor(nowMs));
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of random.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD.charAt(Number(bits & 31n)) + rand;
    bits >>= 5n;
  }
  return time + rand;
}

// ─── Reads ────────────────────────────────────────────────────────────

interface Joined {
  id: string;
  task_id: number;
  task: string;
  workstream: string;
  checker: string;
  brief: string;
  verdict: string | null;
  state: CheckState;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT c.id, c.task_id, t.local_id AS task, w.name AS workstream, c.checker, c.brief,
                       c.verdict, c.state, c.created_at, c.updated_at
                  FROM checks c
                  JOIN tasks t ON t.id = c.task_id
                  JOIN workstreams w ON w.id = t.workstream_id`;

function toRow(r: Joined): CheckRow {
  return {
    id: r.id,
    task: r.task,
    workstream: r.workstream,
    by: r.checker,
    brief: r.brief,
    verdict: r.verdict,
    label: r.verdict === null ? null : (parseVerdict(r.verdict) ?? "UNVERIFIED"),
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The checks of a workstream (`open`: only those without a verdict),
 *  oldest first. */
export function listChecks(db: Db, workstream: string, opts: { open?: boolean } = {}): CheckRow[] {
  const open = opts.open === true ? " AND c.verdict IS NULL" : "";
  const rows = db
    .prepare(`${SELECT} WHERE w.name = ?${open} ORDER BY c.created_at, c.id`)
    .all(workstream) as Joined[];
  return rows.map(toRow);
}

/** The checks without a verdict on any of `taskIds` (surrogate ids), oldest first. */
export function unansweredChecksOn(db: Db, taskIds: readonly number[]): CheckRow[] {
  if (taskIds.length === 0) return [];
  const marks = taskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `${SELECT} WHERE c.task_id IN (${marks}) AND c.verdict IS NULL ORDER BY c.created_at, c.id`,
    )
    .all(...taskIds) as Joined[];
  return rows.map(toRow);
}

function checkById(db: Db, id: string): { check: CheckRow; taskId: number } | undefined {
  const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as Joined | undefined;
  return row === undefined ? undefined : { check: toRow(row), taskId: row.task_id };
}

// ─── Writes ───────────────────────────────────────────────────────────

/** `--by <harness>` or `--by <harness>/<model>`, trimmed: a harness from the
 *  table, and a model (when given) with no whitespace. null model: the
 *  orchestrator did not name one, and the check records the harness alone. */
export function parseCheckBy(by: string): { harness: string; model: string | null } {
  const value = by.trim();
  const slash = value.indexOf("/");
  const harness = slash < 0 ? value : value.slice(0, slash);
  const model = slash < 0 ? null : value.slice(slash + 1);
  if (!isHarness(harness) || model === "" || (model !== null && /\s/.test(model))) {
    throw new CheckArgError(say("check.by_invalid", by, HARNESSES));
  }
  return { harness, model };
}

export interface IssueCheckOptions {
  workstream: string;
  /** `<harness>` or `<harness>/<model>`. */
  by: string;
  brief: string;
  /** The actor stamped on the op (`ops.actor`). */
  author?: string;
}

/** Record a check of task `localId`: a new `checks` row (one captured `check`
 *  put) with a fresh ULID. Throws TaskNotFoundError, CheckArgError. */
export function issueCheck(db: Db, localId: string, opts: IssueCheckOptions): CheckRow {
  const { harness, model } = parseCheckBy(opts.by);
  if (opts.brief.trim() === "") throw new CheckArgError(say("check.brief_empty"));
  return withOpContext(db, { intent: "check.issue", actor: opts.author, group: "new" }, () =>
    db
      .transaction((): CheckRow => {
        const taskId = taskIdFor(db, localId, opts.workstream);
        if (taskId === null) throw new TaskNotFoundError(localId, opts.workstream);
        const id = newCheckId();
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO checks (id, task_id, checker, brief, verdict, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'open', ?, ?)`,
        ).run(id, taskId, model === null ? harness : `${harness}/${model}`, opts.brief, now, now);
        const row = checkById(db, id);
        if (row === undefined) throw new CheckNotFoundError(id, localId);
        return row.check;
      })
      .immediate(),
  );
}

export interface RecordVerdictOptions {
  workstream: string;
  /** The check id `mu task check` printed. */
  check: string;
  /** The answer: its first VERDICT line names the label; the rest is evidence. */
  verdict: string;
  author?: string;
}

export interface RecordVerdictResult {
  check: CheckRow;
  /** False when the same verdict was already recorded (nothing written). */
  changed: boolean;
  /** True when a different verdict was there before (the last one wins). */
  replaced: boolean;
}

/** Record the verdict of check `opts.check` on task `localId`. Throws
 *  TaskNotFoundError, CheckNotFoundError, CheckArgError (no VERDICT line). */
export function recordCheckVerdict(
  db: Db,
  localId: string,
  opts: RecordVerdictOptions,
): RecordVerdictResult {
  const verdict = opts.verdict.replace(/\s+$/, "");
  if (parseVerdict(verdict) === undefined) throw new CheckArgError(say("check.verdict_line"));
  const id = opts.check.trim().toUpperCase();
  return withOpContext(db, { intent: "check.verdict", actor: opts.author, group: "new" }, () =>
    db
      .transaction((): RecordVerdictResult => {
        const taskId = taskIdFor(db, localId, opts.workstream);
        if (taskId === null) throw new TaskNotFoundError(localId, opts.workstream);
        const before = checkById(db, id);
        if (before === undefined || before.taskId !== taskId) {
          throw new CheckNotFoundError(id, localId);
        }
        if (before.check.verdict === verdict) {
          return { check: before.check, changed: false, replaced: false };
        }
        db.prepare(
          "UPDATE checks SET verdict = ?, state = 'answered', updated_at = ? WHERE id = ?",
        ).run(verdict, new Date().toISOString(), id);
        const after = checkById(db, id);
        if (after === undefined) throw new CheckNotFoundError(id, localId);
        return { check: after.check, changed: true, replaced: before.check.verdict !== null };
      })
      .immediate(),
  );
}
