// SDK seam for `mu state` (static) and the later dashboard.
//
// Every renderer (the cli-table3-based static card in
// src/cli/state.ts, and the dashboard) consumes
// the same WorkstreamSnapshot. Pure data + a few small derivation
// helpers — no rendering. See design_sdk_seam in workstream `tui` for
// the rationale (`mu task notes design_sdk_seam -w tui`).

import type { RuntimeState } from "./agent-state.js";
import { type LiveAgent, type LiveAgentsView, listLiveAgents } from "./agents.js";
import type { Db } from "./db.js";
import { type DoctorSummary, loadDoctorSummary } from "./doctor-summary.js";
import { GLYPH } from "./glyphs.js";
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
import { listWorkspaces, type WorkspaceRow } from "./workspace.js";

// ─── WorkstreamSnapshot ───────────────────────────────────────────

export interface RemoteWorker {
  taskName: string;
  host: string;
  path: string;
}

export interface RemoteDispatch extends RemoteWorker {
  agentName: string;
  baseSha: string;
}

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
  workspaces: WorkspaceRow[];
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
   *  cheap SQL, but it reports tmux/workspace drift from slow-tier fields,
   *  so the TUI refreshes it with the subprocess tier. */
  withDoctor?: boolean;
  /** Optional full task list for the TUI all-tasks popup. */
  withAllTasks?: true;
}

export interface WorkstreamSnapshotSlowFields {
  view: LiveAgentsView;
  doctor: DoctorSummary | null;
}

/** Notes that may carry a REMOTE: / REMOTE_BASE: line. GLOB, not LIKE:
 *  the parsers below are case-sensitive, so LIKE's case-folding only
 *  fetched notes they then dropped, and GLOB's byte compare is ~2.5x
 *  cheaper per note. Still one pass over the workstream's notes; no index
 *  can serve a substring match, and a partial index would need a schema
 *  version bump (f_remote_notes_like). */
function remoteNoteRows(
  db: Db,
  workstream: string,
  taskName?: string,
): Array<{ task_name: string; content: string }> {
  const filter = taskName === undefined ? "" : " AND t.local_id = ?";
  const params: string[] = taskName === undefined ? [workstream] : [workstream, taskName];
  return db
    .prepare(
      `SELECT t.local_id AS task_name, n.content AS content
       FROM task_notes n
       JOIN tasks t ON t.id = n.task_id
       JOIN workstreams ws ON ws.id = t.workstream_id
       WHERE ws.name = ?${filter}
         AND (n.content GLOB '*REMOTE: *' OR n.content GLOB '*REMOTE_BASE: *')
       ORDER BY n.id`,
    )
    .all(...params) as Array<{
    task_name: string;
    content: string;
  }>;
}

export function listRemoteWorkers(db: Db, workstream: string): RemoteWorker[] {
  const remoteWorkers: RemoteWorker[] = [];
  for (const row of remoteNoteRows(db, workstream)) {
    for (const line of row.content.split(/\r?\n/)) {
      const match = /^REMOTE:\s+([^:\s]+):(\S+)\s*$/.exec(line);
      const host = match?.[1];
      const path = match?.[2];
      if (host !== undefined && path !== undefined) {
        remoteWorkers.push({ taskName: row.task_name, host, path });
      }
    }
  }
  return remoteWorkers;
}

export function findRemoteDispatch(
  db: Db,
  workstream: string,
  taskName: string,
  agentName: string,
): RemoteDispatch | undefined {
  let dispatch: RemoteDispatch | undefined;
  for (const row of remoteNoteRows(db, workstream, taskName)) {
    let location: RemoteWorker | undefined;
    let baseSha: string | undefined;
    for (const line of row.content.split(/\r?\n/)) {
      const remote = /^REMOTE:\s+([^:\s]+):(\S+)\s*$/.exec(line);
      if (remote?.[1] !== undefined && remote[2] !== undefined) {
        location = { taskName, host: remote[1], path: remote[2] };
      }
      const base = /^REMOTE_BASE:\s+([^:\s]+):(\S+)\s*$/.exec(line);
      if (base?.[1] === agentName && base[2] !== undefined) baseSha = base[2];
    }
    if (location !== undefined && baseSha !== undefined) {
      dispatch = { ...location, agentName, baseSha };
    }
  }
  return dispatch;
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
    workspaces: listWorkspaces(db, workstream),
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
    workspaces: [],
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
