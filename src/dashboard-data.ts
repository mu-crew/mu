// SDK seam for the dashboard: ONE read-only projection of everything its tabs
// show (workstreams, tasks, frontier, agents, log, human needs, delegates).
//
// READ-ONLY by construction: it never reconciles, reaps, ingests or writes, and
// runs on a `readonly: true` connection. The only I/O beyond SQL is the
// best-effort ctl probe `readLiveAgents` does (a socket read). It composes the
// merged readers (`listTasks`, `loadOpenTaskFrontier`, `readLiveAgents`,
// `listLogs`/`logItem`, `openHumanNeeds`, `listDelegates`) rather than
// re-deriving them, so a dashboard row equals the CLI's. `stateSnapshot` is NOT
// the source of the task list: it omits OPEN/parked rows and caps closed ones.
//
// Reserved for the Next/tool slice (`v_dashboard_next`): `next` is typed as the
// full `NextPlan` but is always null here with `next_source: "unavailable"`
// (the shell says "unavailable", never "no authorised work"), and an agent's
// optional `tool` is never set here.

import { type AgentOutput, liveAgentToOutput } from "./agent-output.js";
import { readLiveAgents } from "./agents.js";
import { type LogItem, logItem } from "./cli/log-records.js";
import { loadOpenTaskFrontier } from "./dag.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "./db.js";
import { listDelegates } from "./delegates.js";
import { openHumanNeeds } from "./human-needed.js";
import { parseOpKey } from "./log-render.js";
import { latestSeq, listLogs } from "./logs.js";
import type { NextPlan } from "./output-contract.js";
import type { TaskStatus } from "./tasks/status.js";
import { listTasks, type TaskRow } from "./tasks.js";
import { isScratchWorkstream } from "./workstream.js";

/** A running tool of a pi agent (filled by the ctl read path; never by this module). */
export interface AgentTool {
  name: string;
  /** Epoch ms the tool started. */
  since: number;
  /** Calculated at read time (`now - since`), when known. */
  elapsed_ms?: number;
}

export interface DashboardWorkstream {
  name: string;
  scratch: boolean;
  /** Newest visible op seq in the workstream; 0 when it has none. */
  latest_seq: number;
}

/** One task, SQL column names, `key` = `<workstream>/<id>` (unique across workstreams). */
export interface DashboardTask {
  key: string;
  workstream: string;
  id: string;
  title: string;
  status: string;
  substate: string;
  impact: number;
  effort_days: number;
  /** Owner's name; only while IN_PROGRESS. */
  owner: string | null;
  kind: string;
  wave: string | null;
  updated_at: string;
  /** `MAX(ops.seq)` over the task's own ops, its notes' and its edges' (raw log, db/sql writes included); 0 when none. */
  activity_seq: number;
}

/** One line of the open DAG (`loadOpenTaskFrontier`, preorder, per workstream). */
export interface DashboardEdge {
  key: string;
  workstream: string;
  id: string;
  title: string;
  status: string;
  substate: string;
  depth: number;
  /** Qualified key of the entry it is listed under; null for a root. */
  parent: string | null;
  /** Already listed above (a diamond): not expanded again. */
  again: boolean;
  /** Open neighbours not listed under this entry. */
  kids: number;
  /** CLOSED neighbours collapsed into this count. */
  closed: number;
  cap_cut: number;
}

/** A registry agent with its computed state; unknown stays unknown. */
export interface DashboardAgent extends AgentOutput {
  /** `<workstream>/<name>`. */
  key: string;
  /** Qualified keys of the IN_PROGRESS tasks it owns (empty when none). */
  tasks: string[];
  /** The first of `tasks`; null when none. */
  task: string | null;
  /** Reserved for `v_dashboard_next`: the running tool. Absent = unknown, never "none". */
  tool?: AgentTool;
}

/** An op of the canonical log, rendered by the one formatter (`logItem`), plus its workstream. */
export interface DashboardLogItem extends LogItem {
  /** The workstream the op belongs to; null for a machine-wide op. */
  scope: string | null;
}

/** An OPEN `human` task of the caller. */
export interface DashboardHumanNeed {
  key: string;
  workstream: string;
  id: string;
  reason: string;
}

/** An unfinished delegate call of the caller. */
export interface DashboardDelegate {
  call_id: string;
  workstream: string;
  /** The delegate task's local id. */
  task: string;
  state: string;
  wave: string | null;
  judges: string | null;
  agent: string | null;
  verdict: string | null;
  error: string | null;
  updated_at: string;
}

export interface DashboardSnapshot {
  /** The identity the caller-scoped panels were read for; null = a human shell. */
  caller: string | null;
  /** `none`: no identity, so `human_needs` and `delegates` are empty BY DESIGN (never another caller's). */
  caller_scope: "caller" | "none";
  /** Every live workstream, scratch included; never narrowed by a filter (it is the switcher). */
  workstreams: DashboardWorkstream[];
  tasks: DashboardTask[];
  edges: DashboardEdge[];
  agents: DashboardAgent[];
  /** The newest ops, oldest first. */
  log: DashboardLogItem[];
  /** Always null here: see `next_source`. */
  next: NextPlan;
  /** `unavailable` until the Next slice computes it; the UI must not read null as "no work". */
  next_source: "unavailable" | "computed";
  human_needs: DashboardHumanNeed[];
  delegates: DashboardDelegate[];
}

export interface DashboardOptions {
  /** Narrow tasks, frontier, agents, log and caller panels to one live workstream. */
  workstream?: string;
  /** Statuses to list; default OPEN + IN_PROGRESS (CLOSED is hidden). */
  status?: readonly TaskStatus[];
  /** Case-insensitive substring over a task's key/title/owner/substate and an agent's key/name/state/task keys. */
  text?: string;
  /** `spawnerFromEnv()`; null = a human shell (caller-scoped panels stay empty). */
  caller: string | null;
  /** Log tail size (default 100). */
  logLimit?: number;
}

const DEFAULT_STATUS: readonly TaskStatus[] = ["OPEN", "IN_PROGRESS"];
const DEFAULT_LOG_LIMIT = 100;
const FINISHED_CALL: readonly string[] = ["done", "failed", "cancelled"];

/** `MAX(ops.seq)` per task id of one workstream over its task, note and edge ops. */
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
  const bump = (id: string | undefined, seq: number): void => {
    if (id !== undefined && seq > (out.get(id) ?? 0)) out.set(id, seq);
  };
  for (const r of rows) {
    if (r.entity === "task") bump(r.key.slice(prefix.length), r.seq);
    else if (r.entity === "note") bump(r.key.slice(prefix.length).split("#")[0], r.seq);
    else {
      const parsed = parseOpKey(r.key);
      bump(parsed.local, r.seq);
      bump(parsed.to, r.seq);
    }
  }
  return out;
}

const keyOf = (workstream: string, id: string): string => `${workstream}/${id}`;

function dashboardTask(row: TaskRow, activity: ReadonlyMap<string, number>): DashboardTask {
  return {
    key: keyOf(row.workstreamName, row.name),
    workstream: row.workstreamName,
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

/** Newest activity first; no ops (capture suppressed) falls back to `updated_at`, then key. */
function byActivityDesc(a: DashboardTask, b: DashboardTask): number {
  if (a.activity_seq !== b.activity_seq) return b.activity_seq - a.activity_seq;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function matches(text: string | undefined, ...fields: (string | null)[]): boolean {
  if (text === undefined || text === "") return true;
  const needle = text.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle) === true);
}

/**
 * Load the dashboard's whole read model in one pass. Read-only (see the file
 * header); async only for the ctl probes. Throws `WorkstreamNotFoundError` for
 * a `workstream` filter that is not a live workstream.
 */
export async function loadDashboard(db: Db, opts: DashboardOptions): Promise<DashboardSnapshot> {
  const live = (
    db
      .prepare("SELECT name, id FROM workstreams WHERE torn_down_at IS NULL ORDER BY name")
      .all() as { name: string; id: number }[]
  ).map((w) => ({ ...w, scratch: isScratchWorkstream(w.name) }));
  if (opts.workstream !== undefined && tryResolveLiveWorkstreamId(db, opts.workstream) === null) {
    throw new WorkstreamNotFoundError(opts.workstream);
  }
  const scoped = live.filter((w) => opts.workstream === undefined || w.name === opts.workstream);
  const statuses =
    opts.status === undefined || opts.status.length === 0 ? DEFAULT_STATUS : opts.status;

  const tasks: DashboardTask[] = [];
  const edges: DashboardEdge[] = [];
  const agents: DashboardAgent[] = [];
  for (const ws of scoped) {
    const activity = taskActivity(db, ws.name);
    tasks.push(
      ...listTasks(db, ws.name, { status: statuses })
        .map((r) => dashboardTask(r, activity))
        .filter((t) => matches(opts.text, t.key, t.title, t.owner, t.substate)),
    );
    for (const e of loadOpenTaskFrontier(db, ws.name).entries) {
      edges.push({
        key: keyOf(ws.name, e.task.name),
        workstream: ws.name,
        id: e.task.name,
        title: e.task.title,
        status: e.task.status,
        substate: e.task.substate,
        depth: e.depth,
        parent: e.parent === null ? null : keyOf(ws.name, e.parent),
        again: e.again,
        kids: e.kids,
        closed: e.closed,
        cap_cut: e.capCut,
      });
    }
    const owned = new Map<string, string[]>();
    for (const t of listTasks(db, ws.name, { status: "IN_PROGRESS" })) {
      if (t.ownerName === null) continue;
      owned.set(t.ownerName, [...(owned.get(t.ownerName) ?? []), keyOf(ws.name, t.name)]);
    }
    for (const a of await readLiveAgents(db, ws.name)) {
      const mine = owned.get(a.name) ?? [];
      const agent: DashboardAgent = {
        ...liveAgentToOutput(a, ws.id),
        key: keyOf(ws.name, a.name),
        tasks: mine,
        task: mine[0] ?? null,
      };
      if (matches(opts.text, agent.key, agent.state ?? null, ...mine)) agents.push(agent);
    }
  }
  tasks.sort(byActivityDesc);

  const log = listLogs(db, {
    ...(opts.workstream !== undefined ? { workstream: opts.workstream } : {}),
    limit: opts.logLimit ?? DEFAULT_LOG_LIMIT,
  }).map((row) => ({
    ...logItem(row, true).item,
    scope: parseOpKey(row.workstreamName).workstream ?? null,
  }));

  const inScope = new Set(scoped.map((w) => w.name));
  const callerOwn = opts.caller !== null;
  const human_needs = callerOwn
    ? openHumanNeeds(db, opts.caller as string)
        .filter((h) => inScope.has(h.workstream))
        .map((h) => ({
          key: keyOf(h.workstream, h.id),
          workstream: h.workstream,
          id: h.id,
          reason: h.reason,
        }))
    : [];
  const delegates = callerOwn
    ? listDelegates(db, opts.caller as string)
        .filter((c) => inScope.has(c.workstream) && !FINISHED_CALL.includes(c.state))
        .map((c) => ({
          call_id: c.callId,
          workstream: c.workstream,
          task: c.task,
          state: c.state,
          wave: c.wave,
          judges: c.record ? `${c.record.workstream}/${c.record.task}` : null,
          agent: c.agent,
          verdict: c.verdict,
          error: c.error,
          updated_at: c.updatedAt,
        }))
    : [];

  return {
    caller: opts.caller,
    caller_scope: callerOwn ? "caller" : "none",
    workstreams: live.map((w) => ({
      name: w.name,
      scratch: w.scratch,
      latest_seq: latestSeq(db, w.name),
    })),
    tasks,
    edges,
    agents,
    log,
    next: null,
    next_source: "unavailable",
    human_needs,
    delegates,
  };
}
