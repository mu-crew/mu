// The dashboard's pure model: which workstream to start on, what each tab's
// rows are, how filters apply, how the cursor moves. No React, no I/O, no
// clock (callers pass `now`), so every rule here is a plain unit test.
//
// Row text is plain and unpadded; the view cuts and pads it by visual width.
// Every row has a STABLE key: the cursor follows the key across polls, so a
// reorder by activity never moves it onto another task.

import type {
  DashboardAgent,
  DashboardAttention,
  DashboardEdge,
  DashboardLogItem,
  DashboardSnapshot,
  DashboardTask,
} from "../../dashboard-data.js";
import {
  DEFAULT_SUBSTATE,
  isTaskStatus,
  TASK_STATUSES,
  TASK_SUBSTATES,
  type TaskStatus,
} from "../../tasks/status.js";
import { type ColumnSpec, columnWidths, GUTTER, renderCells } from "./columns.js";
import { clean } from "./text.js";

export type TabId = "overview" | "tasks" | "dag" | "agents" | "log";
export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "tasks", label: "Tasks" },
  { id: "dag", label: "DAG" },
  { id: "agents", label: "Agents" },
  { id: "log", label: "Log" },
];

/** What Enter opens on a row (a tagged union). */
export type DrillTarget =
  | { kind: "notes"; workstream: string; id: string; title: string }
  | { kind: "scrollback"; workstream: string; name: string; paneId: string; tab: string | null }
  | { kind: "log"; item: DashboardLogItem };

export interface Row {
  key: string;
  text: string;
  /** Enter opens this; absent = nothing to open. */
  drill?: DrillTarget;
  /** Not a cursor stop's data (a cut notice): shown, never filtered out. */
  notice?: boolean;
}

/** Task status filter, cycled with `o`. `active` is the dashboard default (CLOSED hidden). */
export const STATUS_LABELS = ["active", "open", "in_progress", "closed", "all"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

/** Task order, cycled with `s` (Tasks tab only): newest activity (default), ROI, oldest first, id. */
export const SORT_LABELS = ["activity", "roi", "age", "id"] as const;
export type SortLabel = (typeof SORT_LABELS)[number];

/** The filter line's name for a sort: the arrow points at what comes first. */
export const SORT_ARROWS: Record<SortLabel, string> = {
  activity: "↓", // newest first
  roi: "↓", // highest first
  age: "↑", // oldest first
  id: "↑",
};

export interface Filter {
  status: StatusLabel;
  text: string;
  sort: SortLabel;
}
export const NO_FILTER: Filter = { status: "active", text: "", sort: "activity" };

const STATUS_SETS: Record<StatusLabel, readonly TaskStatus[]> = {
  active: ["OPEN", "IN_PROGRESS"],
  open: ["OPEN"],
  in_progress: ["IN_PROGRESS"],
  closed: ["CLOSED"],
  all: ["OPEN", "IN_PROGRESS", "CLOSED"],
};

export const statusesOf = (label: StatusLabel): readonly TaskStatus[] => STATUS_SETS[label];

export function nextStatusLabel(label: StatusLabel): StatusLabel {
  const i = STATUS_LABELS.indexOf(label);
  return STATUS_LABELS[(i + 1) % STATUS_LABELS.length] ?? "active";
}

export function nextSortLabel(label: SortLabel): SortLabel {
  const i = SORT_LABELS.indexOf(label);
  return SORT_LABELS[(i + 1) % SORT_LABELS.length] ?? "activity";
}

/** Filters (and cursors) persist per tab and workstream: every tab shows the selected one. */
export const scopeKey = (tab: TabId, workstream: string | null): string =>
  `${tab}\u0000${workstream ?? ""}`;

/**
 * The workstream to start on: the hint (the mux session's, or `-w`) when it is
 * live, else the one with the MOST RECENT activity (`latest_seq`; ties by name).
 * Never `workstreams[0]`: the list is alphabetical, which says nothing.
 */
export function pickWorkstream(
  workstreams: DashboardSnapshot["workstreams"],
  hint?: string,
): string | null {
  if (hint !== undefined && workstreams.some((w) => w.name === hint)) return hint;
  let best: DashboardSnapshot["workstreams"][number] | undefined;
  for (const w of workstreams) {
    if (best === undefined || w.latest_seq > best.latest_seq) best = w;
  }
  return best?.name ?? null;
}

/** `scratch` carries a `*`: the picker is the only place that says it is ephemeral. */
export const workstreamLabel = (w: { name: string; scratch: boolean }): string =>
  w.scratch ? `${w.name}*` : w.name;

/** The Next line. Unavailable is NOT "no authorised work": only a computed null says that. */
export function nextLine(snap: DashboardSnapshot): string {
  if (snap.next_source !== "computed") return "next: unavailable";
  if (snap.next === null) return "next: no authorised work";
  return `next (${snap.next.mode}): ${snap.next.commands.join(" ; ")}`;
}

function textMatch(text: string, ...fields: (string | null | undefined)[]): boolean {
  if (text === "") return true;
  const needle = text.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle) === true);
}

function statusText(status: string, substate: string): string {
  const dflt = isTaskStatus(status) ? DEFAULT_SUBSTATE[status] : undefined;
  return substate === "" || substate === dflt ? status : `${status}/${substate}`;
}

// Column widths come from the SNAPSHOT (every row of the workstream), never from the
// filtered or scrolled rows, so typing a filter or a poll never moves a column. A
// status label is fixed at the longest legal one (`CLOSED/superseded`); the one clip
// column (title, rendered text, tool) is last.
const STATUS_WIDTH = Math.max(
  ...TASK_STATUSES.flatMap((st) => TASK_SUBSTATES[st].map((sub) => statusText(st, sub).length)),
);
const STATE_WIDTH = "needs_permission".length;
const HOST_WIDTH = 6;
const LOCAL = "local";
const TIME_WIDTH = 8;

const protect = (min = 0, max?: number): ColumnSpec => ({
  kind: "protect",
  min,
  ...(max !== undefined ? { max } : {}),
});
const fixed = (n: number): ColumnSpec => ({ kind: "protect", min: n, max: n });
const CLIP: ColumnSpec = { kind: "clip" };

/**
 * Lay rows out in columns sized over `basis` (every row of the snapshot, protected
 * columns only). The LAST spec is the one clip column: its text goes out whole and
 * the view cuts the line to its width, ending in "…". Zero-width columns vanish.
 */
function layoutRows(
  basis: ReadonlyArray<ReadonlyArray<string>>,
  specs: readonly ColumnSpec[],
): (cells: readonly string[]) => string {
  const widths = columnWidths(basis, specs);
  const last = specs.length - 1;
  return (cells) => {
    const head = renderCells(cells, widths, specs)
      .slice(0, last)
      .filter((_, i) => (widths[i] ?? 0) > 0);
    return [...head, clean(cells[last] ?? "")].join(" ".repeat(GUTTER)).trimEnd();
  };
}

/** `@name`, with the owner's workstream when it is not the task's own. */
const ownerLabel = (t: DashboardTask): string =>
  t.owner === null
    ? ""
    : `@${t.owner_workstream !== null && t.owner_workstream !== t.workstream ? `${t.owner_workstream}/` : ""}${t.owner}`;

/** Order of a task list: activity is the snapshot's own order (newest first); ties keep it. */
function sortTasks(tasks: DashboardTask[], sort: SortLabel): DashboardTask[] {
  const roi = (t: DashboardTask): number => t.impact / Math.max(t.effort_days, 1e-9);
  const out = [...tasks];
  if (sort === "roi") out.sort((a, b) => roi(b) - roi(a) || a.effort_days - b.effort_days);
  else if (sort === "age")
    out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  else if (sort === "id") out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function taskRows(snap: DashboardSnapshot, ws: string | null, f: Filter): Row[] {
  const statuses: readonly string[] = statusesOf(f.status);
  const inWs = snap.tasks.filter((t) => t.workstream === ws);
  const tasks = sortTasks(
    inWs.filter(
      (t) => statuses.includes(t.status) && textMatch(f.text, t.key, t.title, t.owner, t.substate),
    ),
    f.sort,
  );
  const specs = [protect(0, 24), fixed(STATUS_WIDTH), protect(0, 24), CLIP];
  // The owner sits BEFORE the title, so a long title can never clip it away. Its width
  // covers the workstream's agents too: a task claimed later does not shift the title.
  const agentNames = snap.agents.filter((a) => a.workstream === ws).map((a) => `@${a.name}`);
  const line = layoutRows(
    [...inWs.map((t) => [t.id, "", ownerLabel(t)]), ...agentNames.map((n) => ["", "", n])],
    specs,
  );
  return tasks.map((t) => ({
    key: t.key,
    text: line([t.id, statusText(t.status, t.substate), ownerLabel(t), t.title]),
    drill: { kind: "notes", workstream: t.workstream, id: t.id, title: t.title },
  }));
}

function edgeNotes(e: DashboardEdge): string {
  const notes = [
    e.again ? "again, listed above" : "",
    e.kids > 0 ? `+${e.kids} open` : "",
    e.closed > 0 ? `${e.closed} closed` : "",
    e.cap_cut > 0 ? `${e.cap_cut} cut by cap` : "",
  ].filter((n) => n !== "");
  return notes.length > 0 ? `  (${notes.join(", ")})` : "";
}

/** The id cell carries the tree indent: the protected column that shows the shape. */
const edgeId = (e: DashboardEdge): string => `${"  ".repeat(e.depth)}${e.id}`;

/**
 * The open DAG of one workstream, preorder. The text filter hides entry lines
 * (an entry's parent may vanish: the line keeps its indent); the status filter
 * does not apply (the DAG is the OPEN work and its frontier by definition). Cuts
 * are ALWAYS listed, per-entry ones included (a hidden entry leaves a notice): a
 * filter must not hide that open work was left out.
 */
function dagRows(snap: DashboardSnapshot, ws: string | null, f: Filter): Row[] {
  const rows: Row[] = [];
  const mine = snap.edges.filter((e) => e.workstream === ws);
  const specs = [protect(0, 40), fixed(STATUS_WIDTH), CLIP];
  const line = layoutRows(
    mine.map((e) => [edgeId(e), "", ""]),
    specs,
  );
  for (const e of mine) {
    if (textMatch(f.text, e.key, e.title, e.substate)) {
      rows.push({
        key: `${e.parent ?? ""}>${e.key}`,
        text: line([edgeId(e), statusText(e.status, e.substate), `${e.title}${edgeNotes(e)}`]),
        drill: { kind: "notes", workstream: e.workstream, id: e.id, title: e.title },
      });
    } else if (e.cap_cut > 0) {
      // Its line is filtered out, and the line is the only place its cap cut was
      // said: keep the warning as a notice naming the entry.
      rows.push({
        key: `cut:cap:${e.key}`,
        text: `… ${e.cap_cut} open task${e.cap_cut === 1 ? "" : "s"} under ${e.id} left out by the node cap`,
        notice: true,
      });
    }
  }
  const cut = snap.frontier.find((c) => c.workstream === ws);
  if (cut !== undefined && cut.roots_cut > 0) {
    rows.push({
      key: "cut:roots",
      text: `… ${cut.roots_cut} open start task${cut.roots_cut === 1 ? "" : "s"} left out by the node cap`,
      notice: true,
    });
  }
  if (cut !== undefined && cut.again_cut > 0) {
    rows.push({
      key: "cut:again",
      text: `… ${cut.again_cut} repeat line${cut.again_cut === 1 ? "" : "s"} left out by the node cap`,
      notice: true,
    });
  }
  return rows;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Running tool + elapsed; `-` = none running; an agent whose tool is not reported is `?` (unknown), never "none". */
function toolText(a: DashboardAgent, now: number): string {
  if (a.tool === undefined) return "tool ?";
  if (a.tool === null) return "tool -";
  const ms = a.tool.elapsed_ms ?? now - a.tool.since;
  return `${a.tool.name} ${formatElapsed(ms)}`;
}

function agentRows(snap: DashboardSnapshot, ws: string | null, f: Filter, now: number): Row[] {
  const mine = snap.agents.filter((a) => a.workstream === ws);
  const agents = mine.filter((a) => textMatch(f.text, a.key, a.state, a.tool?.name, ...a.tasks));
  // The tab shows one workstream: a bare name, the host in its own column (`local` =
  // none), and a task of another workstream keeps its qualifier.
  const taskOf = (a: DashboardAgent): string =>
    a.task === null
      ? "-"
      : a.task.startsWith(`${a.workstream}/`)
        ? a.task.slice(a.workstream.length + 1)
        : a.task;
  const specs = [protect(0, 32), fixed(HOST_WIDTH), fixed(STATE_WIDTH), protect(0, 32), CLIP];
  const line = layoutRows(
    // The task column is as wide as the workstream's task ids, not just the tasks owned
    // right now: an agent claiming or finishing a task must not move the tool column.
    [
      ...mine.map((a) => [a.name, "", "", taskOf(a)]),
      ...snap.tasks.filter((t) => t.workstream === ws).map((t) => ["", "", "", t.id]),
    ],
    specs,
  );
  return agents.map((a) => ({
    key: a.key,
    text: line([a.name, a.host ?? LOCAL, a.state ?? "?", taskOf(a), toolText(a, now)]),
    drill: {
      kind: "scrollback" as const,
      workstream: a.workstream,
      name: a.name,
      paneId: a.pane_id,
      tab: a.tab,
    },
  }));
}

const timeOf = (iso: string): string => /T(\d\d:\d\d:\d\d)/.exec(iso)?.[1] ?? iso;

/** The log is one workstream's (the data layer reads it so), so there is no scope column. */
function logRows(snap: DashboardSnapshot, ws: string | null, f: Filter): Row[] {
  const mine = snap.log.filter((l) => l.scope === ws);
  const specs: ColumnSpec[] = [{ kind: "protect", align: "right" }, fixed(TIME_WIDTH), CLIP];
  const line = layoutRows(
    mine.map((l) => [String(l.seq), "", ""]),
    specs,
  );
  return mine
    .filter((l) => textMatch(f.text, l.rendered, l.actor, l.scope))
    .map((l) => ({
      key: String(l.seq),
      text: line([String(l.seq), timeOf(l.created_at), l.rendered]),
      drill: { kind: "log", item: l },
    }));
}

/** One attention item as a line: another workstream's is qualified, bare names otherwise. */
export function attentionLabel(a: DashboardAttention, ws: string | null): string {
  const where = a.workstream !== null && a.workstream !== ws ? `${a.workstream}/` : "";
  return `${where}${a.kind === "human" ? `human: ${a.text}` : a.text}`;
}

/** The Overview's cursor stops: every attention item (all workstreams), Enter opens its agent or task. */
function attentionRows(snap: DashboardSnapshot, ws: string | null): Row[] {
  return snap.attention.map((a) => {
    const agent = snap.agents.find((x) => x.key === a.target);
    const task = snap.tasks.find((x) => x.key === a.target);
    const drill: DrillTarget | undefined = agent
      ? {
          kind: "scrollback",
          workstream: agent.workstream,
          name: agent.name,
          paneId: agent.pane_id,
          tab: agent.tab,
        }
      : task
        ? { kind: "notes", workstream: task.workstream, id: task.id, title: task.title }
        : undefined;
    return { key: a.key, text: attentionLabel(a, ws), ...(drill ? { drill } : {}) };
  });
}

/** Every tab shows the selected workstream only (scratch included, like any other). */
export function tabRows(
  tab: TabId,
  snap: DashboardSnapshot,
  ws: string | null,
  f: Filter,
  now: number,
): Row[] {
  switch (tab) {
    case "overview":
      return attentionRows(snap, ws);
    case "tasks":
      return taskRows(snap, ws, f);
    case "dag":
      return dagRows(snap, ws, f);
    case "agents":
      return agentRows(snap, ws, f, now);
    case "log":
      return logRows(snap, ws, f);
  }
}

/** Index of the cursor: its key when still listed, else the tab default (Log: the newest row). */
export function cursorIndex(rows: readonly Row[], key: string | null, tab: TabId): number {
  const i = key === null ? -1 : rows.findIndex((r) => r.key === key);
  if (i >= 0) return i;
  return tab === "log" ? Math.max(0, rows.length - 1) : 0;
}

/** The key `delta` rows from the cursor (clamped); null for no rows. */
export function moveCursor(
  rows: readonly Row[],
  key: string | null,
  tab: TabId,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const i = Math.max(0, Math.min(rows.length - 1, cursorIndex(rows, key, tab) + delta));
  return rows[i]?.key ?? null;
}
