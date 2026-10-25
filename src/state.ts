// SDK seam for `mu state`, `mu me` and the dashboard.
//
// `stateSnapshot` is the canonical read: one stable, READ-ONLY shape (SQL
// column names; no reconcile, no reap, no write) that `mu state` bounds and
// prints as JSON and the dashboard projects. `WorkstreamSnapshot` and its
// loaders are the older fast/slow tiers, kept for `mu doctor` and SDK callers
// until doctor migrates. Pure data + a few small derivation helpers — no
// rendering.

import { type AgentOutput, liveAgentToOutput } from "./agent-output.js";
import type { RuntimeState } from "./agent-state.js";
import {
  type AgentRow,
  type LiveAgent,
  type LiveAgentsView,
  listLiveAgents,
  readLiveAgents,
} from "./agents.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "./db.js";
import { type DelegateRow, listDelegates, type VerdictTally, verdictTally } from "./delegates.js";
import { type DoctorSummary, loadDoctorSummary } from "./doctor-summary.js";
import { GLYPH } from "./glyphs.js";
import { openHumanNeeds } from "./human-needed.js";
import { type LogRow, listLogs } from "./logs.js";
import { activeMux } from "./mux.js";
import { byRoiDesc } from "./tasks/sort.js";
import {
  listBlocked,
  listInProgress,
  listReady,
  listRecentClosed,
  listTasks,
  listTasksByOwner,
  type TaskRow,
} from "./tasks.js";
import { getParallelTracks, type Track } from "./tracks.js";

// ─── stateSnapshot: the canonical read ────────────────────────────

/** One task in a state read: SQL column names, `id` = `local_id`. */
export interface StateTask {
  id: string;
  title: string;
  status: string;
  substate: string;
  impact: number;
  effort_days: number;
  /** Owner's name; only while IN_PROGRESS (a CLOSED task's owner is history). */
  owner: string | null;
  kind: string;
  wave: string | null;
  updated_at: string;
  /** `MAX(ops.seq)` over the task's own ops, its notes' and its edges' (raw log, db/sql writes included); 0 when none. */
  activity_seq: number;
}

/** A delegate call that has not finished (`done`/`failed`/`cancelled` are in the wave tally). */
export interface StateDelegate {
  call_id: string;
  /** The delegate task's local id, in this workstream. */
  task: string;
  state: string;
  wave: string | null;
  /** The task judged, `<workstream>/<task>`; null with no record target. */
  judges: string | null;
  agent: string | null;
  verdict: string | null;
  error: string | null;
  updated_at: string;
}

/** One wave of the caller's own calls in this workstream, tallied per call (`verdictTally`'s findings summed). */
export interface StateWave {
  wave: string;
  calls: number;
  confirmed: number;
  refuted: number;
  unverified: number;
  pending: number;
  queued: number;
  running: number;
  /** Call ids refused past the cap, still to reissue. */
  refused: string[];
}

/** An OPEN `human` task of the caller. */
export interface StateHumanNeed {
  id: string;
  /** The brief notes joined with "; " (whole; the CLI bounds it). */
  reason: string;
}

export interface StateCounts {
  tasks: number;
  open: number;
  parked: number;
  triage: number;
  ready: number;
  blocked: number;
  in_progress: number;
  closed: number;
}

export interface WorkstreamState {
  workstream: string;
  workstream_id: number;
  counts: StateCounts;
  /** `scored` order (`byRoiDesc`). */
  ready: StateTask[];
  /** Newest activity first. Absent in a `me` read, which narrows to counts, ready, delegates, waves and human needs. */
  in_progress?: StateTask[];
  blocked?: StateTask[];
  triage?: StateTask[];
  recent_closed?: StateTask[];
  /** Registry rows (host/cwd/base/collected_head included) with their runtime state; unknown stays unknown. */
  agents?: AgentOutput[];
  delegates: StateDelegate[];
  waves: StateWave[];
  human_needs: StateHumanNeed[];
  /** Set when the workstream is mostly history (past BIG_WORKSTREAM_TASKS tasks, under 10% open): start the next effort in a new one. */
  hint?: string;
  /** Panes in the workstream's mux session that look like agents but are not registered. Set only by `mu state`, which reconciles first (the snapshot itself reads no mux). */
  orphans?: { pane_id: string; command: string }[];
}

/** `mu me`: the caller's own identity and the tasks it owns. */
export interface StateMe {
  caller: string;
  /** The managed agent's record; null for a pi session (`pi:<session>`), which has no agent row. */
  agent: AgentOutput | null;
  /** Non-CLOSED tasks the agent owns in its workstream. */
  owned_tasks: StateTask[];
}

export interface StateSnapshot {
  /** `spawnerFromEnv()` identity: `<ws>/<agent>`, `pi:<session>`, or null (delegates and human needs then stay empty). */
  caller: string | null;
  me: StateMe | null;
  workstreams: WorkstreamState[];
}

export interface StateSnapshotOptions {
  /** The scope, already resolved (variadic/comma/repeated `-w` and `--all` live in the CLI). Empty is legal. */
  workstreams: readonly string[];
  caller: string | null;
  /** A `me` read: adds the caller's identity block (`agent` is its registry row, null for a pi session) and narrows each workstream. */
  me?: { agent: AgentRow | null };
}

const RECENT_CLOSED = 5;
/** Past this many tasks, a workstream that is under 10% open gets the one-per-effort hint. */
const BIG_WORKSTREAM_TASKS = 300;

function taskActivity(db: Db, workstream: string): Map<string, number> {
  const prefix = `${workstream}/`;
  const rows = db
    .prepare(
      `SELECT entity, key, MAX(seq) AS seq FROM ops
        WHERE entity IN ('task', 'note', 'edge') AND key >= ? AND key < ?
        GROUP BY entity, key`,
    )
    .all(prefix, `${workstream}0`) as { entity: string; key: string; seq: number }[];
  const out = new Map<string, number>();
  const bump = (id: string, seq: number): void => {
    if (seq > (out.get(id) ?? 0)) out.set(id, seq);
  };
  for (const r of rows) {
    if (r.entity === "task") bump(r.key.slice(prefix.length), r.seq);
    else if (r.entity === "note") bump(r.key.slice(prefix.length).split("#")[0] ?? "", r.seq);
    else {
      const [from, to] = r.key.split("->");
      if (from !== undefined) bump(from.slice(prefix.length), r.seq);
      if (to !== undefined) bump(to.slice(prefix.length), r.seq);
    }
  }
  return out;
}

function stateTask(row: TaskRow, activity: ReadonlyMap<string, number>): StateTask {
  return {
    id: row.name,
    title: row.title,
    status: row.status,
    substate: row.substate,
    impact: row.impact,
    effort_days: row.effortDays,
    owner: row.status === "IN_PROGRESS" ? row.ownerName : null,
    kind: row.kind,
    wave: row.wave,
    updated_at: row.updatedAt,
    activity_seq: activity.get(row.name) ?? 0,
  };
}

/** Newest activity first; no ops (capture suppressed) falls back to `updated_at`, then id. */
function byActivityDesc(a: StateTask, b: StateTask): number {
  if (a.activity_seq !== b.activity_seq) return b.activity_seq - a.activity_seq;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const FINISHED_CALL: readonly string[] = ["done", "failed", "cancelled"];

function delegatesOf(
  db: Db,
  workstream: string,
  caller: string | null,
): { delegates: StateDelegate[]; waves: StateWave[] } {
  if (caller === null) return { delegates: [], waves: [] };
  const calls: DelegateRow[] = listDelegates(db, caller, workstream);
  const delegates = calls
    .filter((c) => !FINISHED_CALL.includes(c.state))
    .map((c) => ({
      call_id: c.callId,
      task: c.task,
      state: c.state,
      wave: c.wave,
      judges: c.record ? `${c.record.workstream}/${c.record.task}` : null,
      agent: c.agent,
      verdict: c.verdict,
      error: c.error,
      updated_at: c.updatedAt,
    }));
  const labels = [...new Set(calls.flatMap((c) => (c.wave === null ? [] : [c.wave])))].reverse();
  const waves = labels.map((wave) => waveOf(verdictTally(db, workstream, wave, caller), wave));
  return { delegates, waves };
}

function waveOf(t: VerdictTally, wave: string): StateWave {
  const sum = (k: "confirmed" | "refuted" | "unverified" | "pending"): number =>
    t.findings.reduce((n, f) => n + f[k], 0);
  const w = {
    wave,
    confirmed: sum("confirmed"),
    refuted: sum("refuted"),
    unverified: sum("unverified"),
    pending: sum("pending"),
  };
  return {
    ...w,
    calls: w.confirmed + w.refuted + w.unverified + w.pending,
    queued: t.queued,
    running: t.running,
    refused: t.refused,
  };
}

function countsOf(db: Db, wsId: number): StateCounts {
  const n = (sql: string): number => (db.prepare(sql).get(wsId) as { n: number }).n;
  const by = (cond: string): number =>
    n(`SELECT count(*) AS n FROM tasks WHERE workstream_id = ? AND ${cond}`);
  return {
    tasks: by("1 = 1"),
    open: by("status = 'OPEN'"),
    parked: by("status = 'OPEN' AND substate = 'parked'"),
    triage: by("status = 'OPEN' AND substate = 'triage'"),
    ready: n("SELECT count(*) AS n FROM ready WHERE workstream_id = ?"),
    blocked: n("SELECT count(*) AS n FROM blocked WHERE workstream_id = ?"),
    in_progress: by("status = 'IN_PROGRESS'"),
    closed: by("status = 'CLOSED'"),
  };
}

async function meOf(db: Db, caller: string | null, self: AgentRow | null): Promise<StateMe> {
  if (self === null) return { caller: caller ?? "", agent: null, owned_tasks: [] };
  const ws = self.workstreamName;
  const wsRow = db.prepare("SELECT id, torn_down_at FROM workstreams WHERE name = ?").get(ws) as
    | { id: number; torn_down_at: string | null }
    | undefined;
  const [live] = await readLiveAgents(db, ws, self.name);
  const live_ = live === undefined ? null : liveAgentToOutput(live, wsRow?.id ?? 0);
  const alive = wsRow !== undefined && wsRow.torn_down_at === null;
  const activity = alive ? taskActivity(db, ws) : new Map<string, number>();
  return {
    caller: caller ?? `${ws}/${self.name}`,
    agent: live_,
    owned_tasks: alive
      ? listTasksByOwner(db, ws, self.name)
          .map((r) => stateTask(r, activity))
          .sort(byActivityDesc)
      : [],
  };
}

/** Live workstreams where `caller` has a delegate call or an open human need (a pi session has no workstream of its own). */
export function callerWorkstreams(db: Db, caller: string): string[] {
  const live = new Set(
    (
      db.prepare("SELECT name FROM workstreams WHERE torn_down_at IS NULL").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  const names = new Set([
    ...listDelegates(db, caller).map((c) => c.workstream),
    ...openHumanNeeds(db, caller).map((h) => h.workstream),
  ]);
  return [...names].filter((n) => live.has(n)).sort();
}

/**
 * The canonical state read: tasks, agents, the caller's delegate queue and
 * waves, and its open human needs, per workstream, under SQL column names.
 * READ-ONLY: it never reconciles or reaps (`mu state` reconciles first, on its
 * own), so the dashboard can reuse it. Async only for the ctl probes. The
 * result is whole; the CLI bounds it (`mu state`).
 *
 * `me` narrows each workstream to counts, ready, delegates, waves and human
 * needs, and adds the caller's identity block. The delegate queue and human
 * needs are the CALLER's own, never another session's.
 */
export async function stateSnapshot(db: Db, opts: StateSnapshotOptions): Promise<StateSnapshot> {
  const needs = opts.caller === null ? [] : openHumanNeeds(db, opts.caller);
  const workstreams: WorkstreamState[] = [];
  let me: StateMe | null = null;
  for (const ws of opts.workstreams) {
    const wsId = tryResolveLiveWorkstreamId(db, ws);
    if (wsId === null) throw new WorkstreamNotFoundError(ws);
    const activity = taskActivity(db, ws);
    const task = (r: TaskRow): StateTask => stateTask(r, activity);
    const state: WorkstreamState = {
      workstream: ws,
      workstream_id: wsId,
      counts: countsOf(db, wsId),
      ready: listReady(db, ws).sort(byRoiDesc).map(task),
      ...delegatesOf(db, ws, opts.caller),
      human_needs: needs
        .filter((h) => h.workstream === ws)
        .map((h) => ({ id: h.id, reason: h.reason })),
    };
    if (opts.me === undefined) {
      state.in_progress = listInProgress(db, ws).map(task).sort(byActivityDesc);
      state.blocked = listBlocked(db, ws).map(task).sort(byActivityDesc);
      state.triage = listTasks(db, ws, { status: "OPEN", substate: "triage" })
        .map(task)
        .sort(byActivityDesc);
      state.recent_closed = listTasks(db, ws, { status: "CLOSED" })
        .map(task)
        .sort(byActivityDesc)
        .slice(0, RECENT_CLOSED);
      state.agents = (await readLiveAgents(db, ws)).map((a) => liveAgentToOutput(a, wsId));
      const { tasks, open, in_progress } = state.counts;
      const unfinished = open + in_progress;
      if (tasks >= BIG_WORKSTREAM_TASKS && unfinished * 10 < tasks) {
        state.hint = `${tasks} tasks, ${unfinished} open; start the next effort in a new <project>-<purpose> workstream`;
      }
    }
    workstreams.push(state);
  }
  if (opts.me !== undefined) me = await meOf(db, opts.caller, opts.me.agent);
  return { caller: opts.caller, me, workstreams };
}

// ─── WorkstreamSnapshot ───────────────────────────────────────────

export interface WorkstreamSnapshot {
  workstreamName: string;
  view: LiveAgentsView;
  tracks: Track[];
  ready: TaskRow[];
  inProgress: TaskRow[];
  blocked: TaskRow[];
  recentClosed: TaskRow[];
  /** OPEN/parked tasks in the workstream. The ready card names them
   *  when nothing is ready, since parked work is otherwise invisible there. */
  parkedCount: number;
  /** OPEN/triage tasks: proposals (review findings) awaiting accept,
   *  reject, or duplicate. Out of `ready`, so listed on their own. */
  triage: TaskRow[];
  /** Every task in the workstream, any status (a COUNT, not the rows). */
  taskCount: number;
  /** Populated only when callers explicitly pass `withAllTasks: true`.
   *  The TUI dashboard fast tick leaves this empty and the all-tasks
   *  popup reads its exhaustive list directly from SQLite while open. */
  allTasks: TaskRow[];
  recent: LogRow[];
  /** Populated when `loadWorkstreamSnapshot` is called with
   *  `withDoctor: true`. Used by the TUI's slot-9 Doctor card to
   *  render a glanceable health badge on the dashboard
   *  (feat_card_9_doctor, workstream `tui-impl`). The static `mu
   *  state` card and `mu doctor` itself don't consume it — they
   *  read the textual doctor card directly. Null when not requested. */
  doctor: DoctorSummary | null;
}

export interface LoadWorkstreamSnapshotOptions {
  /** Recent-events cap (default 200). */
  eventLimit?: number;
  /** When true, slow snapshot loading also populates
   *  `WorkstreamSnapshot.doctor` via `loadDoctorSummary`. The summary is
   *  cheap SQL, but it reports tmux drift from slow-tier fields,
   *  so the TUI refreshes it with the subprocess tier. */
  withDoctor?: boolean;
  /** Optional full task list for the TUI all-tasks popup. */
  withAllTasks?: true;
}

export interface WorkstreamSnapshotSlowFields {
  view: LiveAgentsView;
  doctor: DoctorSummary | null;
}

/**
 * Fast TUI/state snapshot tier: pure SQLite reads only. Subprocess-backed
 * fields are intentionally empty placeholders so callers can merge the last
 * slow-tier values without blocking a 1s render tick on tmux or VCS probes.
 */
export async function loadWorkstreamSnapshotFast(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
): Promise<WorkstreamSnapshot> {
  const eventLimit = opts.eventLimit ?? 200;
  return {
    workstreamName: workstream,
    view: emptyLiveAgentsView(),
    tracks: getParallelTracks(db, workstream),
    ready: listReady(db, workstream).sort(byRoiDesc),
    inProgress: listInProgress(db, workstream),
    blocked: listBlocked(db, workstream),
    recentClosed: listRecentClosed(db, workstream),
    parkedCount: listTasks(db, workstream, { status: "OPEN", substate: "parked" }).length,
    triage: listTasks(db, workstream, { status: "OPEN", substate: "triage" }),
    taskCount: (
      db
        .prepare(
          "SELECT count(*) AS n FROM tasks t JOIN workstreams w ON w.id = t.workstream_id WHERE w.name = ?",
        )
        .get(workstream) as { n: number }
    ).n,
    allTasks: opts.withAllTasks === true ? listTasks(db, workstream) : [],
    // v2-retire-log-shim: this used to filter `kind: "event"` — the
    // prose breadcrumbs. Those are gone, so the Recent card reads every
    // op for the workstream. Payloads are raw JSON for captured ops
    // until v2-log-verb renders them from `intent`; the card stays
    // populated in the meantime rather than going silently empty.
    recent: listLogs(db, { workstream, limit: eventLimit }),
    doctor: null,
  };
}

/**
 * Slow snapshot tier: fields backed by tmux subprocess probes (plus
 * doctor, which reports over those slow-tier observations). Returns only the
 * fields the fast snapshot deliberately leaves empty or undecorated.
 *
 * The slow snapshot tier runs full reconciliation: missing panes are
 * reaped, while mid-spawn placeholders remain protected by the prune
 * loop's pending-pane guard.
 */
export async function loadWorkstreamSnapshotSlow(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
  baseSnapshot?: WorkstreamSnapshot,
): Promise<WorkstreamSnapshotSlowFields> {
  const view = await listLiveAgents(db, { workstream });
  const slow: WorkstreamSnapshotSlowFields = { view, doctor: null };
  if (opts.withDoctor === true) {
    const mux = await activeMux();
    slow.doctor = loadDoctorSummary(
      db,
      mergeSnapshotFastSlow(baseSnapshot ?? minimalSnapshot(workstream), slow),
      mux.paneStatus === undefined ? "murmur" : "herdr",
    );
  }
  return slow;
}

/** Merge the latest slow-tier subprocess observations into a fresh fast tier. */
export function mergeSnapshotFastSlow(
  fast: WorkstreamSnapshot,
  slow: WorkstreamSnapshotSlowFields | null,
): WorkstreamSnapshot {
  if (slow === null) return fast;
  return {
    ...fast,
    view: slow.view,
    doctor: slow.doctor,
  };
}

/**
 * Back-compat wrapper for non-TUI callers: return the historical union shape
 * by composing the new fast SQL tier with one slow subprocess tier.
 */
export async function loadWorkstreamSnapshot(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
): Promise<WorkstreamSnapshot> {
  const fast = await loadWorkstreamSnapshotFast(db, workstream, opts);
  const slow = await loadWorkstreamSnapshotSlow(db, workstream, opts, fast);
  return mergeSnapshotFastSlow(fast, slow);
}

function emptyLiveAgentsView(): LiveAgentsView {
  return {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, orphans: [], mode: "full" },
  };
}

function minimalSnapshot(workstream: string): WorkstreamSnapshot {
  return {
    workstreamName: workstream,
    view: emptyLiveAgentsView(),
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    parkedCount: 0,
    triage: [],
    taskCount: 0,
    allTasks: [],
    recent: [],
    doctor: null,
  };
}

// ─── ROI helpers ───────────────────────────────────────────────────

/**
 * ROI tiers used to colour task rows. Pure: returns the bucket name; the
 * consumer maps bucket → picocolors function (or ink text colour).
 * Magic numbers (≥100 high, ≥50 mid) lifted from the previous HUD impl.
 */
export type RoiBucket = "high" | "mid" | "low" | "infinite";

export function roiBucket(impact: number, effortDays: number): RoiBucket {
  const r = effortDays > 0 ? impact / effortDays : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(r)) return "infinite";
  if (r >= 100) return "high";
  if (r >= 50) return "mid";
  return "low";
}

// ─── Agent helpers ─────────────────────────────────────────────────

/** Histogram of agents by runtime state. Pure derivation (no colour render). */
export function agentStateHistogram(
  agents: readonly LiveAgent[],
): ReadonlyMap<RuntimeState, number> {
  const out = new Map<RuntimeState, number>();
  for (const a of agents) {
    out.set(a.state, (out.get(a.state) ?? 0) + 1);
  }
  return out;
}

// ─── Task helpers ──────────────────────────────────────────────────

export interface OwnedTasksSummary {
  /** Display token: "—" (none), task id (one), or GLYPH.multi + count (many). */
  bit: string;
  /** Underlying count for callers that want their own format. */
  count: number;
  /** The single owned task's local id, when count===1. */
  onlyTaskId?: string;
}

/**
 * Per-agent task summary: condensed display token + raw count. Used by
 * both the static Agents table and the ink Agents card. Pure on the
 * input rows — caller (e.g. loadWorkstreamSnapshot consumer) does the
 * listTasksByOwner query upstream and feeds the rows in.
 */
export function summarizeOwnedTasks(owned: readonly TaskRow[]): OwnedTasksSummary {
  const count = owned.length;
  if (count === 0) return { bit: "—", count: 0 };
  if (count === 1) {
    const only = owned[0];
    if (!only) return { bit: "—", count: 0 };
    return { bit: only.name, count: 1, onlyTaskId: only.name };
  }
  return { bit: `${GLYPH.multi}${count}`, count };
}

// Re-export for convenience: callers wanting to combine listTasksByOwner
// with summarizeOwnedTasks in one import.
export { listTasksByOwner };
