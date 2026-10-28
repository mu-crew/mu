// SDK seam for the dashboard: ONE read-only projection of everything its tabs
// show (workstreams, tasks with a delegate task's `call`, frontier, agents, log,
// human needs, the caller's delegates, delegate `waves`, attention).
//
// READ-ONLY by construction: it never reconciles, reaps, ingests or writes, and
// runs on a `readonly: true` connection. The only I/O beyond SQL is the
// best-effort ctl probe `readLiveAgents` does (a socket read). It composes the
// merged readers (`listTasks`, `loadOpenTaskFrontier`, `readLiveAgents`,
// `listLogs`/`logItem`, `openHumanNeeds`, `listDelegates`, `tallyCalls`) rather than
// re-deriving them, so a dashboard row equals the CLI's. `stateSnapshot` is NOT
// the source of the task list: it omits OPEN/parked rows and caps closed ones.
//
// `next` is `computeNext` (the CLI's one rule set) with no outcome: it only reads.
// A failed computation stays `next_source: "unavailable"` (never "no authorised
// work"). An agent's `tool` comes from the ctl status the agent read already did:
// an object while a tool runs, null when none, absent for an extension that
// predates the field (unknown). Elapsed is `now - since`, calculated at read.
//
// Two delegate reads, on purpose: `delegates` is the caller's own unfinished calls
// (caller-scoped like `human_needs`, empty for a human shell), while a task's
// `call`, `waves` and the `delegate` attention items read every caller's, because
// they describe tasks and waves anyone can see. Each delegate read is bounded in
// SQL (shown task statuses, the newest waves, the failed-call window), so a tick
// does not grow with the delegate history in `scratch`.

import { type AgentOutput, liveAgentToOutput } from "./agent-output.js";
import type { StateReading } from "./agent-state.js";
import { UNKNOWN_REASON } from "./agent-state.js";
import { readLiveAgents } from "./agents.js";
import { type LogItem, logItem } from "./cli/log-records.js";
import type { CtlTool } from "./ctl/protocol.js";
import { loadOpenTaskFrontier } from "./dag.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "./db.js";
import { type DelegateRow, listDelegates, tallyCalls } from "./delegates.js";
import { openHumanNeeds } from "./human-needed.js";
import { parseOpKey } from "./log-render.js";
import { latestSeq, listLogs } from "./logs.js";
import { computeNext } from "./next-hints.js";
import type { NextPlan } from "./output-contract.js";
import type { TaskStatus } from "./tasks/status.js";
import { listTasks, type TaskRow } from "./tasks.js";
import { isScratchWorkstream } from "./workstream.js";

/** A running tool of a pi agent (from the ctl status). */
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
  /** Newest visible op seq in the workstream; 0 when it has none, or when `activity: false` skipped the read. */
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
  /** The owner's registry id (`tasks.owner_id`; the identity: names repeat across workstreams). */
  owner_id: number | null;
  /** The owner's OWN workstream, which can differ from the task's; null when unowned. */
  owner_workstream: string | null;
  kind: string;
  wave: string | null;
  created_at: string;
  updated_at: string;
  /** `MAX(ops.seq)` over the task's own ops, its notes' and its edges' (raw log, db/sql writes included); 0 when none. */
  activity_seq: number;
  /** The call behind a `kind=delegate` task, whoever made it; absent for any other task. */
  call?: DashboardCall;
}

/** A delegate call as a task row shows it: machine-wide, never narrowed to a caller. */
export interface DashboardCall {
  call_id: string;
  state: string;
  /** The parsed label of a done answer; null otherwise. */
  verdict: string | null;
  /** `<workstream>/<task>` the call judges; null with no record target. */
  judges: string | null;
  wave: string | null;
}

/**
 * One wave of delegate calls in a workstream, tallied as `verdictTally` counts it
 * (one result per call), over every caller. `pending` includes `refused`.
 */
export interface DashboardWave {
  /** `<workstream>/<wave>`. */
  key: string;
  workstream: string;
  wave: string;
  calls: number;
  confirmed: number;
  refuted: number;
  unverified: number;
  pending: number;
  refused: number;
  /** The newest `updated_at` of its calls. */
  updated_at: string;
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

/** What the frontier cap left out of one workstream's DAG (per-entry `cap_cut` cannot say it). */
export interface DashboardFrontierCut {
  workstream: string;
  /** Open start tasks the node cap left out: open work absent from `edges`. */
  roots_cut: number;
  /** Recurrence (diamond) lines the cap left out; each such task is listed elsewhere. */
  again_cut: number;
}

/** A registry agent with its computed state; unknown stays unknown. */
export interface DashboardAgent extends AgentOutput {
  /** `<workstream>/<name>`. */
  key: string;
  /** Qualified keys of the IN_PROGRESS tasks it owns (empty when none). */
  tasks: string[];
  /** The first of `tasks`; null when none. */
  task: string | null;
  /** The running tool; null = none running; absent = unknown (old extension, no ctl): never read as "none". */
  tool?: AgentTool | null;
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

/**
 * Something a human has to look at. Read over EVERY live workstream and blind
 * to the status/text filters and the workstream scope, so each surface (the
 * strip under the tabs, the Overview card) agrees.
 *
 * - `dead`: the agent's pane (or gate process) is gone.
 * - `permission`: `needs_permission`; `text` carries how long.
 * - `stalled`: one tool has run over `STALLED_TOOL_MS`.
 * - `input`: `needs_input` past the idle threshold on an agent that owns work
 *   (the registry's `idle` flag; `MU_IDLE_THRESHOLD_MS`, 0 disables).
 * - `delegate`: a delegate call that is `refused` (parked until its pi session
 *   reissues it) or `failed` within `FAILED_CALL_MS`, whoever made it.
 * - `human`: an OPEN `kind=human` task, whoever recorded it (`human_needs`
 *   is caller-scoped and empty for a human shell).
 * - `next_unavailable`: `computeNext` failed.
 * - `sync`: a warning the caller passed as `syncWarnings`.
 */
export type AttentionKind =
  | "dead"
  | "permission"
  | "input"
  | "stalled"
  | "delegate"
  | "human"
  | "next_unavailable"
  | "sync";

export interface DashboardAttention {
  /** Unique within a snapshot (`<kind>:<target>`). */
  key: string;
  /** The workstream it belongs to; null for a machine-wide item (`next_unavailable`, `sync`). */
  workstream: string | null;
  kind: AttentionKind;
  /** One short line, age at read ("worker-3 permission 20m"; a human task: its title); bare names, the UI qualifies. */
  text: string;
  /** Qualified key to drill into: the agent (dead/permission/input/stalled) or the task (delegate, human); null otherwise. */
  target: string | null;
}

export interface DashboardSnapshot {
  /** The identity the caller-scoped panels were read for; null = a human shell. */
  caller: string | null;
  /** `none`: no identity, so `human_needs` and `delegates` are empty BY DESIGN (never another caller's); `call`, `waves` and attention are every caller's. */
  caller_scope: "caller" | "none";
  /** Every live workstream, scratch included; never narrowed by a filter (it is the switcher). */
  workstreams: DashboardWorkstream[];
  tasks: DashboardTask[];
  edges: DashboardEdge[];
  /** One per in-scope workstream: the frontier's root/recurrence cuts, passed through. */
  frontier: DashboardFrontierCut[];
  agents: DashboardAgent[];
  /** The newest ops, oldest first. */
  log: DashboardLogItem[];
  /** `computeNext` for the caller set and the workstream filter; null when `next_source` is `unavailable`, or computed and nothing is authorised. */
  next: NextPlan;
  /** `unavailable`: the computation failed; the UI must not read null as "no work". */
  next_source: "unavailable" | "computed";
  human_needs: DashboardHumanNeed[];
  delegates: DashboardDelegate[];
  /** Per read workstream (tasks scope), its `WAVE_MAX` most recently updated waves, newest first, any caller. */
  waves: DashboardWave[];
  /** Trouble across every workstream, filters ignored, most urgent first (see `AttentionKind`). */
  attention: DashboardAttention[];
}

export interface DashboardOptions {
  /** Narrow tasks, frontier, agents, log and caller panels to one live workstream. */
  workstream?: string;
  /**
   * Read tasks, edges and frontier of this workstream ONLY (a name that is not live,
   * or null: none), leaving agents, log, caller panels and attention machine-wide:
   * the dashboard shows one workstream, and reading every other one's tasks and DAG
   * each tick is what made it costly. Absent: every live workstream. `workstream`, when
   * set, wins.
   */
  scopeWorkstream?: string | null;
  /** Statuses to list; default OPEN + IN_PROGRESS (CLOSED is hidden). */
  status?: readonly TaskStatus[];
  /** Case-insensitive substring over a task's key/title/owner/substate and an agent's key/name/state/task keys. */
  text?: string;
  /** `spawnerFromEnv()`; null = a human shell (caller-scoped panels stay empty). */
  caller: string | null;
  /** Who `next` is computed for (`currentCallers()`); default: `caller` alone, none for a human shell. */
  callers?: readonly string[];
  /** Log tail size (default 100). */
  logLimit?: number;
  /** Read the log tail of this workstream only, leaving every other panel unscoped (not checked: a name that is not live reads an empty log). */
  logWorkstream?: string;
  /**
   * Read each workstream's `latest_seq` (default true). It only ranks the starting
   * pick and costs one log scan per workstream, so the dashboard's poll passes false
   * once the set of live workstreams is known (every `latest_seq` is then 0).
   */
  activity?: boolean;
  /** Sync warnings the caller holds (`ambientIngest`); each becomes a `sync` attention item. */
  syncWarnings?: readonly string[];
  /**
   * The agent-state cache (the dashboard's slow tier, see `readLiveAgents`): with
   * `probe: false` the read is SQL only for every cached agent. Absent: probe all.
   */
  agentStates?: { cache: Map<string, StateReading>; probe: boolean };
}

const DEFAULT_STATUS: readonly TaskStatus[] = ["OPEN", "IN_PROGRESS"];
const DEFAULT_LOG_LIMIT = 100;
/** A tool running this long counts as stalled. */
export const STALLED_TOOL_MS = 15 * 60_000;
const FINISHED_CALL: readonly string[] = ["done", "failed", "cancelled"];
/** A failed call is an attention item this long after it failed. */
export const FAILED_CALL_MS = 24 * 60 * 60_000;
/** Waves kept per workstream. */
export const WAVE_MAX = 5;

const callOf = (c: DelegateRow): DashboardCall => ({
  call_id: c.callId,
  state: c.state,
  verdict: c.verdict,
  judges: c.record ? `${c.record.workstream}/${c.record.task}` : null,
  wave: c.wave,
});

/** The `WAVE_MAX` most recently updated waves of `calls` (one workstream's), newest first. */
function wavesOf(db: Db, workstream: string): DashboardWave[] {
  // The newest waves by name first (no request parse), then only their calls.
  const names = (
    db
      .prepare(
        `SELECT t.wave AS wave, MAX(d.updated_at) AS at FROM delegate_calls d
           JOIN tasks t ON t.id = d.task_id JOIN workstreams w ON w.id = t.workstream_id
          WHERE w.name = ? AND t.wave IS NOT NULL
          GROUP BY t.wave ORDER BY at DESC, t.wave LIMIT ?`,
      )
      .all(workstream, WAVE_MAX) as { wave: string }[]
  ).map((r) => r.wave);
  return names.map((wave): DashboardWave => {
    const rows = listDelegates(db, undefined, workstream, { wave });
    const t = tallyCalls(rows);
    const sum = (k: "confirmed" | "refuted" | "unverified" | "pending"): number =>
      t.findings.reduce((n, f) => n + f[k], 0);
    return {
      key: keyOf(workstream, wave),
      workstream,
      wave,
      calls: rows.length,
      confirmed: sum("confirmed"),
      refuted: sum("refuted"),
      unverified: sum("unverified"),
      pending: sum("pending"),
      refused: t.refused.length,
      updated_at: rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), ""),
    };
  });
}

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

function nextOf(
  db: Db,
  callers: readonly string[],
  workstream: string | undefined,
): { plan: NextPlan; source: DashboardSnapshot["next_source"] } {
  try {
    const plan = computeNext(db, { callers, ...(workstream !== undefined ? { workstream } : {}) });
    return { plan, source: "computed" };
  } catch {
    return { plan: null, source: "unavailable" };
  }
}

/** The tool as the dashboard shows it, `elapsed_ms` calculated now; unknown stays absent. */
function toolOf(tool: CtlTool | null | undefined, now: number): { tool?: AgentTool | null } {
  if (tool === undefined) return {};
  return { tool: tool === null ? null : { ...tool, elapsed_ms: Math.max(0, now - tool.since) } };
}

const keyOf = (workstream: string, id: string): string => `${workstream}/${id}`;

interface AgentIdentity {
  name: string;
  workstream: string;
}

function dashboardTask(
  row: TaskRow,
  activity: ReadonlyMap<string, number>,
  agentsById: ReadonlyMap<number, AgentIdentity>,
  calls: ReadonlyMap<string, DelegateRow>,
): DashboardTask {
  const call = row.kind === "delegate" ? calls.get(row.name) : undefined;
  const inProgress = row.status === "IN_PROGRESS";
  const owner = inProgress && row.ownerId !== null ? agentsById.get(row.ownerId) : undefined;
  return {
    key: keyOf(row.workstreamName, row.name),
    workstream: row.workstreamName,
    id: row.name,
    title: row.title,
    status: row.status,
    substate: row.substate,
    impact: row.impact,
    effort_days: row.effortDays,
    owner: inProgress ? row.ownerName : null,
    owner_id: inProgress ? row.ownerId : null,
    owner_workstream: owner?.workstream ?? null,
    kind: row.kind,
    wave: row.wave,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    activity_seq: activity.get(row.name) ?? 0,
    ...(call ? { call: callOf(call) } : {}),
  };
}

/** Newest activity first; no ops (capture suppressed) falls back to `updated_at`, then key. */
function byActivityDesc(a: DashboardTask, b: DashboardTask): number {
  if (a.activity_seq !== b.activity_seq) return b.activity_seq - a.activity_seq;
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** `45s`, `1m05s`, `1h05m`: the ONE duration format of the dashboard (strip and tool column). */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** The pane (or a gate's process) is gone, as opposed to a state source that merely cannot say. */
function isDead(a: DashboardAgent): boolean {
  if (a.state !== "unknown") return false;
  if (a.reason === UNKNOWN_REASON.paneGone) return true;
  return a.gate_token !== null && /^(exited \d+|killed by signal)/.test(a.reason ?? "");
}

const ATTENTION_ORDER: readonly AttentionKind[] = [
  "dead",
  "permission",
  "stalled",
  "input",
  "delegate",
  "human",
  "next_unavailable",
  "sync",
];

function agentAttention(a: DashboardAgent, now: number): DashboardAttention[] {
  const item = (kind: AttentionKind, text: string): DashboardAttention => ({
    key: `${kind}:${a.key}`,
    workstream: a.workstream,
    kind,
    text: `${a.name} ${text}`,
    target: a.key,
  });
  const since = a.since == null ? Number.NaN : Date.parse(a.since);
  const waited = Number.isFinite(since) ? ` ${formatElapsed(now - since)}` : "";
  const out: DashboardAttention[] = [];
  if (isDead(a)) out.push(item("dead", "dead"));
  if (a.state === "needs_permission") out.push(item("permission", `permission${waited}`));
  if (a.idle === true) out.push(item("input", `input${waited}`));
  const ran = a.tool?.elapsed_ms;
  if (a.tool != null && ran !== undefined && ran >= STALLED_TOOL_MS) {
    out.push(item("stalled", `${a.tool.name} ${formatElapsed(ran)}`));
  }
  return out;
}

export function matches(
  text: string | undefined,
  ...fields: (string | null | undefined)[]
): boolean {
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
  // Whose tasks, edges and frontier are read (`scopeWorkstream`; `workstream` wins).
  const readFrom =
    opts.workstream !== undefined || opts.scopeWorkstream === undefined
      ? scoped
      : live.filter((w) => w.name === opts.scopeWorkstream);
  const statuses =
    opts.status === undefined || opts.status.length === 0 ? DEFAULT_STATUS : opts.status;

  const agentsById = new Map<number, AgentIdentity>(
    (
      db
        .prepare(
          "SELECT a.id, a.name, w.name AS workstream FROM agents a JOIN workstreams w ON w.id = a.workstream_id",
        )
        .all() as { id: number; name: string; workstream: string }[]
    ).map((a) => [a.id, { name: a.name, workstream: a.workstream }]),
  );
  // IN_PROGRESS tasks by owner registry id, over EVERY live workstream: a task can be
  // claimed by an agent of another workstream, and a filtered read must still show it.
  const owned = new Map<number, string[]>();
  for (const t of db
    .prepare(
      `SELECT ws.name AS ws, t.local_id AS id, t.owner_id AS owner FROM tasks t
        JOIN workstreams ws ON ws.id = t.workstream_id AND ws.torn_down_at IS NULL
        WHERE t.status = 'IN_PROGRESS' AND t.owner_id IS NOT NULL ORDER BY ws.name, t.local_id`,
    )
    .all() as { ws: string; id: string; owner: number }[]) {
    owned.set(t.owner, [...(owned.get(t.owner) ?? []), keyOf(t.ws, t.id)]);
  }

  const tasks: DashboardTask[] = [];
  const edges: DashboardEdge[] = [];
  const frontier: DashboardFrontierCut[] = [];
  const agents: DashboardAgent[] = [];
  const waves: DashboardWave[] = [];
  const now = Date.now();
  for (const ws of readFrom) {
    const activity = taskActivity(db, ws.name);
    const calls = listDelegates(db, undefined, ws.name, { taskStatuses: statuses });
    const callByTask = new Map(calls.map((c) => [c.task, c]));
    waves.push(...wavesOf(db, ws.name));
    tasks.push(
      ...listTasks(db, ws.name, { status: statuses })
        .map((r) => dashboardTask(r, activity, agentsById, callByTask))
        .filter((t) =>
          matches(
            opts.text,
            t.key,
            t.title,
            t.owner,
            t.substate,
            t.call?.state,
            t.call?.verdict,
            t.call?.judges,
          ),
        ),
    );
    const front = loadOpenTaskFrontier(db, ws.name);
    frontier.push({
      workstream: ws.name,
      roots_cut: front.rootsCut,
      again_cut: front.againCut,
    });
    for (const e of front.entries) {
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
  }
  tasks.sort(byActivityDesc);

  // Every live workstream's agents, whatever the scope or text: Attention reads them all.
  const everyAgent: DashboardAgent[] = [];
  for (const ws of live) {
    for (const a of await readLiveAgents(db, ws.name, undefined, opts.agentStates)) {
      const mine = owned.get(a.incarnation) ?? [];
      everyAgent.push({
        ...liveAgentToOutput(a, ws.id),
        key: keyOf(ws.name, a.name),
        tasks: mine,
        task: mine[0] ?? null,
        ...toolOf(a.tool, now),
      });
    }
  }
  const inScope = new Set(scoped.map((w) => w.name));
  agents.push(
    ...everyAgent.filter(
      (a) => inScope.has(a.workstream) && matches(opts.text, a.key, a.state ?? null, ...a.tasks),
    ),
  );

  const next = nextOf(
    db,
    opts.callers ?? (opts.caller === null ? [] : [opts.caller]),
    opts.workstream,
  );
  const logWs = opts.logWorkstream ?? opts.workstream;
  const log = listLogs(db, {
    ...(logWs !== undefined ? { workstream: logWs } : {}),
    limit: opts.logLimit ?? DEFAULT_LOG_LIMIT,
  }).map((row) => ({
    ...logItem(row, true).item,
    scope: parseOpKey(row.workstreamName).workstream ?? null,
  }));

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

  const attention: DashboardAttention[] = everyAgent.flatMap((a) => agentAttention(a, now));
  const liveNames = new Set(live.map((w) => w.name));
  const troubled = [
    ...listDelegates(db, undefined, undefined, { states: ["refused"] }),
    ...listDelegates(db, undefined, undefined, {
      states: ["failed"],
      updatedAfter: new Date(now - FAILED_CALL_MS).toISOString(),
    }),
  ];
  // Workstream, then task id, like the human items.
  troubled.sort((a, b) => keyOf(a.workstream, a.task).localeCompare(keyOf(b.workstream, b.task)));
  for (const c of troubled) {
    if (!liveNames.has(c.workstream)) continue;
    // A refused call has no expiry: say how to clear it.
    const how = c.state === "refused" ? " (reissue or cancel it from pi)" : "";
    attention.push({
      key: `delegate:${keyOf(c.workstream, c.task)}`,
      workstream: c.workstream,
      kind: "delegate",
      text: `delegate ${c.state}: ${c.request.label ?? c.task}${how}`,
      target: keyOf(c.workstream, c.task),
    });
  }
  for (const t of db
    .prepare(
      `SELECT ws.name AS ws, t.local_id AS id, t.title AS title FROM tasks t
        JOIN workstreams ws ON ws.id = t.workstream_id AND ws.torn_down_at IS NULL
        WHERE t.status = 'OPEN' AND t.kind = 'human' ORDER BY ws.name, t.local_id`,
    )
    .all() as { ws: string; id: string; title: string }[]) {
    attention.push({
      key: `human:${keyOf(t.ws, t.id)}`,
      workstream: t.ws,
      kind: "human",
      text: t.title,
      target: keyOf(t.ws, t.id),
    });
  }
  if (next.source === "unavailable") {
    attention.push({
      key: "next_unavailable",
      workstream: null,
      kind: "next_unavailable",
      text: "next unavailable",
      target: null,
    });
  }
  (opts.syncWarnings ?? []).forEach((w, i) => {
    attention.push({
      key: `sync:${i}`,
      workstream: null,
      kind: "sync",
      text: `sync: ${w}`,
      target: null,
    });
  });
  // Most urgent kind first; within a kind the order read holds (agents, delegate and
  // human items: workstream, then name).
  attention.sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind));

  return {
    caller: opts.caller,
    caller_scope: callerOwn ? "caller" : "none",
    workstreams: live.map((w) => ({
      name: w.name,
      scratch: w.scratch,
      latest_seq: opts.activity === false ? 0 : latestSeq(db, w.name),
    })),
    tasks,
    edges,
    frontier,
    agents,
    log,
    next: next.plan,
    next_source: next.source,
    human_needs,
    delegates,
    waves,
    attention,
  };
}
