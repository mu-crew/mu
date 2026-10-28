// mu — `mu delegates prune`: drop old delegate tasks (docs/VOCABULARY.md § delegate prune).
//
// Every `mu_delegate` call and `mu next --refute` checker is a `kind=delegate`
// task in `scratch`, with its whole brief and report. Nothing else removes them,
// so they pile up. A prune deletes the CLOSED ones past an age whose call this
// machine made (it holds the `delegate_calls` row; each machine prunes its own,
// and the tombstones remove the copies on its peers):
//
// 1. The task rows go in ONE op group (intent `delegate.prune`). The capture
//    triggers write the tombstones, so peers drop the same rows on sync; notes,
//    the machine-local call row and receipts go with them by cascade.
// 2. The puts of those tasks and their notes are deleted from `ops`, so mu.db
//    shrinks. The tombstones stay: a peer's older put arriving later is still dead.
//    With sync on, only PEERS' puts go: this machine's own are lines of its
//    segment, and flush regenerates a damaged or missing segment from `ops`. A
//    shorter regenerated file would sit under peers' line watermarks and they
//    would silently skip the ops that follow. Sync segments are never edited.
//
// Kept, and counted, so the operator sees why:
// - a task with an edge: the edge records a dependency someone drew, and the
//   cascade would drop it;
// - a `refute:` call whose judged task is still under `mu task auto` (enabled):
//   `mu next --refute` keys the check on the call id, and a missing call means
//   "check owed", so pruning it would rerun the checker.
//
// The verdict notes the calls wrote live on the judged tasks and stay.
// The CLI adds the dry run, the backup beside the DB, VACUUM and the drift check.

import type { Db } from "./db.js";
import type { FleetHazard } from "./fleet-hazards.js";
import { withOpContext } from "./op-context.js";
import { localMachineId } from "./segments.js";
import { syncEnabled } from "./sync.js";

/** Default age, in days, past which a closed delegate task is pruned. */
export const PRUNE_DEFAULT_DAYS = 30;

export interface PruneCandidate {
  workstream: string;
  task: string;
  callId: string;
  /** The task's `updated_at`: when it closed, for a closed delegate task. */
  closedAt: string;
}

export interface PrunePlan {
  /** ISO time: tasks last updated before it are old. */
  cutoff: string;
  days: number;
  candidates: PruneCandidate[];
  /** Old closed delegate tasks kept, by reason. */
  kept: { edges: number; refuteTarget: number };
  /** Whether this machine's own puts are deleted too (sync off), or only peers'. */
  ownHistory: boolean;
  /** Ops the prune would delete (the puts of the candidates and their notes). */
  ops: number;
  /** Payload bytes of those ops. */
  bytes: number;
}

/** The puts of one task and its notes: key `<ws>/<id>` and `<ws>/<id>#<n>`. The
 *  range outside the OR ('$' is the byte after '#') is what idx_ops_entity_key
 *  seeks on (without it SQLite scans every put of the entity); the OR inside drops
 *  siblings such as `<id>-2`. `@own` 1 includes this machine's puts. */
const TASK_PUTS_WHERE = `entity IN ('task', 'note') AND op = 'put'
  AND key >= @k AND key < @k || '$' AND (key = @k OR key >= @k || '#')
  AND (@own = 1 OR machine_id <> @me)`;

/** The earliest instant a JS Date holds: a huge age means "nothing that old". */
const MIN_DATE_MS = -8.64e15;

interface Row {
  id: number;
  workstream: string;
  task: string;
  updated_at: string;
  call_id: string;
  call_state: string;
  edges: number;
  judged_auto: number;
}

/**
 * What a prune of delegate tasks closed more than `days` ago would delete,
 * optionally in one workstream (live ones only). Read-only.
 */
export function planDelegatePrune(
  db: Db,
  opts: { days?: number; workstream?: string; now?: number; ownHistory?: boolean } = {},
): PrunePlan {
  const days = opts.days ?? PRUNE_DEFAULT_DAYS;
  const ownHistory = opts.ownHistory ?? !syncEnabled();
  const cutoff = new Date(
    Math.max(MIN_DATE_MS, (opts.now ?? Date.now()) - days * 86_400_000),
  ).toISOString();
  const rows = db
    .prepare(
      `SELECT t.id AS id, w.name AS workstream, t.local_id AS task, t.updated_at AS updated_at,
              d.call_id AS call_id, d.state AS call_state,
              (SELECT COUNT(*) FROM task_edges e WHERE e.from_task_id = t.id OR e.to_task_id = t.id) AS edges,
              EXISTS (SELECT 1 FROM tasks jt JOIN workstreams jw ON jw.id = jt.workstream_id
                        JOIN task_auto ja ON ja.task_id = jt.id AND ja.enabled = 1
                       WHERE jw.name = d.record_workstream AND jt.local_id = d.record_task) AS judged_auto
         FROM tasks t
         JOIN workstreams w ON w.id = t.workstream_id AND w.torn_down_at IS NULL
         JOIN delegate_calls d ON d.task_id = t.id
        WHERE t.kind = 'delegate' AND t.status = 'CLOSED' AND t.updated_at < ?
          AND (? IS NULL OR w.name = ?)
        ORDER BY w.name, t.updated_at, t.local_id`,
    )
    .all(cutoff, opts.workstream ?? null, opts.workstream ?? null) as Row[];
  const plan: PrunePlan = {
    cutoff,
    days,
    candidates: [],
    kept: { edges: 0, refuteTarget: 0 },
    ownHistory,
    ops: 0,
    bytes: 0,
  };
  const cost = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(length(payload)), 0) AS b FROM ops WHERE ${TASK_PUTS_WHERE}`,
  );
  const me = localMachineId(db);
  const own = ownHistory ? 1 : 0;
  for (const r of rows) {
    // A CLOSED task whose call is still live (a crash mid-record) is not old work.
    if (!["done", "failed", "cancelled"].includes(r.call_state)) continue;
    if (r.edges > 0) {
      plan.kept.edges++;
      continue;
    }
    if (r.call_id.startsWith("refute:") && r.judged_auto === 1) {
      plan.kept.refuteTarget++;
      continue;
    }
    plan.candidates.push({
      workstream: r.workstream,
      task: r.task,
      callId: r.call_id,
      closedAt: r.updated_at,
    });
    const c = cost.get({ k: `${r.workstream}/${r.task}`, own, me }) as { n: number; b: number };
    plan.ops += c.n;
    plan.bytes += c.b;
  }
  return plan;
}

/**
 * Delete the plan's tasks (tombstones captured, one op group) and their puts, in
 * one transaction. Irreversible: the CLI backs up first. A task that changed
 * since the plan (reopened, no longer delegate or closed) is left alone.
 */
export function pruneDelegates(db: Db, plan: PrunePlan): { tasks: number; ops: number } {
  let tasks = 0;
  let ops = 0;
  withOpContext(db, { intent: "delegate.prune", actor: "mu delegates prune", group: "new" }, () =>
    db
      .transaction(() => {
        // Re-checked at delete time: the plan ran before the backup, outside this transaction.
        const del = db.prepare(
          `DELETE FROM tasks WHERE kind = 'delegate' AND status = 'CLOSED' AND updated_at < ?
              AND local_id = ? AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)
              AND NOT EXISTS (SELECT 1 FROM task_edges e
                               WHERE e.from_task_id = tasks.id OR e.to_task_id = tasks.id)`,
        );
        const puts = db.prepare(`DELETE FROM ops WHERE ${TASK_PUTS_WHERE}`);
        const me = localMachineId(db);
        const own = plan.ownHistory ? 1 : 0;
        // A wait's consumed-call cursor names the call; it has nothing left to hide.
        const cursor = db.prepare("DELETE FROM wait_cursors WHERE ref = ?");
        for (const c of plan.candidates) {
          if (del.run(plan.cutoff, c.task, c.workstream).changes === 0) continue;
          tasks++;
          ops += puts.run({ k: `${c.workstream}/${c.task}`, own, me }).changes;
          cursor.run(`delegate:${c.workstream}/${c.callId}`);
        }
      })
      .immediate(),
  );
  return { tasks, ops };
}

/**
 * Doctor's housekeeping row: closed delegate tasks old enough to prune. Always
 * `ok` (a tidy-up is not a fault), with the count and the command when any.
 */
export function checkOldDelegates(db: Db, opts: { now?: number } = {}): FleetHazard {
  const plan = planDelegatePrune(db, opts);
  const n = plan.candidates.length;
  if (n === 0)
    return {
      name: "delegates-old",
      severity: "ok",
      detail: `no closed delegate task older than ${plan.days} days`,
    };
  return {
    name: "delegates-old",
    severity: "ok",
    detail: `${n} closed delegate task(s) older than ${plan.days} days (${plan.ops} ops)`,
    remediation: [
      "Each holds its whole brief and report, synced to every peer. Their verdicts stay on the judged tasks.",
      "  mu delegates prune              # dry run: what goes, and what is kept",
      "  mu delegates prune --yes        # backs up beside the DB first; irreversible",
    ],
  };
}
