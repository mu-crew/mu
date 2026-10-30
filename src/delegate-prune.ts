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
//
// Files: each pruned call's pi session goes too, after the commit (files are not
// in the backup, so they go only with rows that did): a pane delegate's
// `delegate-sessions/<ws>/<task>/` and a mux-free one's `delegate-process/<hash>/`
// (receipt, log, session). Loose `delegate-sessions/<ws>/*.jsonl` files (the
// first layout, one folder per workstream, no call to tie them to) go by age,
// never younger than a day (a pane may still write one), and only for this
// DB's live workstreams (another DB beside it may own the rest).
// A receipt of a call that still exists is never touched: it fences a resend.
//
// The CLI adds the dry run, the backup beside the DB, VACUUM and the drift check.

import { lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./db.js";
import { delegateProcessDir, delegateSessionDir } from "./delegates.js";
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
  /** The pi session files that go with the candidates, plus old loose ones. */
  files: { paths: string[]; bytes: number };
}

/** Bytes under `p` (a file or a tree; symlinks not followed); 0 when absent. */
function sizeOf(p: string): number {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += sizeOf(join(p, e));
  return n;
}

/** A DB with no file of its own keeps no session files beside it. */
const hasFileDir = (db: Db): boolean => db.name !== "" && db.name !== ":memory:";

/** A loose file this young may belong to a pane still writing it, whatever the age asked. */
const LOOSE_MIN_AGE_MS = 86_400_000;

/**
 * Session files of the first layout: `delegate-sessions/<ws>/*.jsonl` last
 * written before `cutoff` (and at least a day ago), for this DB's live
 * workstreams only: another DB beside this one may own the rest.
 */
function looseSessions(
  db: Db,
  cutoff: string,
  workstream: string | undefined,
  now: number,
): string[] {
  const root = join(dirname(db.name), "delegate-sessions");
  const before = Math.min(Date.parse(cutoff), now - LOOSE_MIN_AGE_MS);
  const out: string[] = [];
  const wss = (
    db
      .prepare(
        "SELECT name FROM workstreams WHERE torn_down_at IS NULL AND (? IS NULL OR name = ?)",
      )
      .all(workstream ?? null, workstream ?? null) as { name: string }[]
  ).map((r) => r.name);
  for (const ws of wss) {
    let names: string[];
    try {
      names = readdirSync(join(root, ws));
    } catch {
      continue;
    }
    for (const f of names) {
      const p = join(root, ws, f);
      if (!f.endsWith(".jsonl")) continue;
      try {
        const st = lstatSync(p);
        if (st.isFile() && st.mtimeMs < before) out.push(p);
      } catch {
        // gone meanwhile
      }
    }
  }
  return out.sort();
}

/** The session directories one call may have left (either transport). */
const callFiles = (db: Db, c: PruneCandidate): string[] => [
  delegateSessionDir(db.name, c.workstream, c.task),
  delegateProcessDir(db.name, c.callId),
];

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
        WHERE t.kind = 'delegate' AND t.status = 'CLOSED' AND t.updated_at <= ?
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
    files: { paths: [], bytes: 0 },
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
  if (hasFileDir(db)) {
    const paths = [
      ...plan.candidates.flatMap((c) => callFiles(db, c)).filter(exists),
      ...looseSessions(db, cutoff, opts.workstream, opts.now ?? Date.now()),
    ];
    plan.files = { paths, bytes: paths.reduce((n, p) => n + sizeOf(p), 0) };
  }
  return plan;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the plan's tasks (tombstones captured, one op group) and their puts, in
 * one transaction. Irreversible: the CLI backs up first. A task that changed
 * since the plan (reopened, no longer delegate or closed) is left alone.
 */
export function pruneDelegates(
  db: Db,
  plan: PrunePlan,
): { tasks: number; ops: number; files: number } {
  let tasks = 0;
  let ops = 0;
  const pruned: PruneCandidate[] = [];
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
          pruned.push(c);
          ops += puts.run({ k: `${c.workstream}/${c.task}`, own, me }).changes;
          cursor.run(`delegate:${c.workstream}/${c.callId}`);
        }
      })
      .immediate(),
  );
  // After the commit: only the calls whose rows are gone lose their files.
  let files = 0;
  if (hasFileDir(db)) {
    const loose = new Set(plan.files.paths);
    const go = [
      ...pruned.flatMap((c) => callFiles(db, c)),
      ...looseSessions(db, plan.cutoff, undefined, Date.now()).filter((p) => loose.has(p)),
    ];
    for (const p of go) {
      if (!exists(p)) continue;
      try {
        rmSync(p, { recursive: true, force: true });
        files++;
      } catch {
        // best-effort: a file left behind is found again by the next prune
      }
    }
  }
  return { tasks, ops, files };
}

/**
 * Doctor's housekeeping row: closed delegate tasks old enough to prune. Always
 * `ok` (a tidy-up is not a fault), with the count and the command when any.
 */
export function checkOldDelegates(db: Db, opts: { now?: number } = {}): FleetHazard {
  const plan = planDelegatePrune(db, opts);
  const n = plan.candidates.length;
  if (n === 0) {
    // Fresh ones pile up too (a busy day of checks): say so, with the way to drop them.
    const all = planDelegatePrune(db, { ...opts, days: 0 }).candidates.length;
    if (all > 0)
      return {
        name: "delegates-old",
        severity: "ok",
        detail: `no closed delegate task older than ${plan.days} days; ${all} newer closed`,
        remediation: [
          "  mu delegates prune --older-than 0   # dry run: every closed delegate task",
        ],
      };
    return {
      name: "delegates-old",
      severity: "ok",
      detail: `no closed delegate task older than ${plan.days} days`,
    };
  }
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
