// The dashboard's pure model: which workstream to start on, what each tab's
// rows are, how filters apply, how the cursor moves. No React, no I/O, no
// clock (callers pass `now`), so every rule here is a plain unit test.
//
// Row text is plain and unpadded; the view cuts and pads it by visual width.
// Every row has a STABLE key: the cursor follows the key across polls, so a
// reorder by activity never moves it onto another task.

import type {
  DashboardAgent,
  DashboardEdge,
  DashboardLogItem,
  DashboardSnapshot,
  DashboardTask,
} from "../../dashboard-data.js";
import { DEFAULT_SUBSTATE, isTaskStatus, type TaskStatus } from "../../tasks/status.js";
import { cell, clean } from "./text.js";

export type TabId = "tasks" | "dag" | "agents" | "log";
export const TABS: readonly { id: TabId; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "dag", label: "DAG" },
  { id: "agents", label: "Agents" },
  { id: "log", label: "Log" },
];

/** What Enter opens on a row (a tagged union; the DAG tab has no drill). */
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

/** Task status filter, cycled with `s`. `active` is the dashboard default (CLOSED hidden). */
export const STATUS_LABELS = ["active", "open", "in_progress", "closed", "all"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

export interface Filter {
  status: StatusLabel;
  text: string;
}
export const NO_FILTER: Filter = { status: "active", text: "" };

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

/**
 * Filters (and cursors) persist per tab and workstream. Agents and Log show every
 * workstream, so they are scoped by tab alone: a filter must not change under you
 * when you switch to a workstream that does not change the list.
 */
export const scopeKey = (tab: TabId, workstream: string | null): string =>
  tab === "agents" || tab === "log" ? tab : `${tab}\u0000${workstream ?? ""}`;

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

const pad = (n: number, max: number): number => Math.min(max, n);
const widest = (xs: readonly string[], max: number): number =>
  pad(Math.max(0, ...xs.map((x) => clean(x).length)), max);

function statusText(status: string, substate: string): string {
  const dflt = isTaskStatus(status) ? DEFAULT_SUBSTATE[status] : undefined;
  return substate === "" || substate === dflt ? status : `${status}/${substate}`;
}

function taskRows(snap: DashboardSnapshot, ws: string | null, f: Filter): Row[] {
  const statuses: readonly string[] = statusesOf(f.status);
  const tasks = snap.tasks.filter(
    (t) =>
      t.workstream === ws &&
      statuses.includes(t.status) &&
      textMatch(f.text, t.key, t.title, t.owner, t.substate),
  );
  // `snap.tasks` already arrives newest-activity first: keep that order.
  const idw = widest(
    tasks.map((t) => t.id),
    28,
  );
  const stw = widest(
    tasks.map((t) => statusText(t.status, t.substate)),
    22,
  );
  return tasks.map((t: DashboardTask) => {
    const owner =
      t.owner === null
        ? ""
        : `  @${t.owner_workstream !== null && t.owner_workstream !== t.workstream ? `${t.owner_workstream}/` : ""}${t.owner}`;
    return {
      key: t.key,
      text: `${cell(t.id, idw)}  ${cell(statusText(t.status, t.substate), stw)}  ${t.title}${owner}`,
      drill: { kind: "notes", workstream: t.workstream, id: t.id, title: t.title },
    };
  });
}

function edgeText(e: DashboardEdge): string {
  const notes = [
    e.again ? "again, listed above" : "",
    e.kids > 0 ? `+${e.kids} open` : "",
    e.closed > 0 ? `${e.closed} closed` : "",
    e.cap_cut > 0 ? `${e.cap_cut} cut by cap` : "",
  ].filter((n) => n !== "");
  return `${"  ".repeat(e.depth)}${e.id}  [${statusText(e.status, e.substate)}]  ${e.title}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`;
}

/**
 * The open DAG of one workstream, preorder. The text filter hides entry lines
 * (an entry's parent may vanish: the line keeps its indent); the status filter
 * does not apply (the DAG is the OPEN work and its frontier by definition). Cuts
 * are ALWAYS listed, per-entry ones included (a hidden entry leaves a notice): a
 * filter must not hide that open work was left out.
 */
function dagRows(snap: DashboardSnapshot, ws: string | null, f: Filter): Row[] {
  const rows: Row[] = [];
  for (const e of snap.edges) {
    if (e.workstream !== ws) continue;
    if (textMatch(f.text, e.key, e.title, e.substate)) {
      rows.push({ key: `${e.parent ?? ""}>${e.key}`, text: edgeText(e) });
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

function agentRows(snap: DashboardSnapshot, f: Filter, now: number): Row[] {
  const agents = snap.agents.filter((a) =>
    textMatch(f.text, a.key, a.state, a.tool?.name, ...a.tasks),
  );
  const kw = widest(
    agents.map((a) => a.key),
    32,
  );
  const sw = widest(
    agents.map((a) => a.state ?? "?"),
    14,
  );
  const tw = widest(
    agents.map((a) => a.task ?? "-"),
    32,
  );
  return agents.map((a) => ({
    key: a.key,
    text: `${cell(a.key, kw)}  ${cell(a.state ?? "?", sw)}  ${cell(a.task ?? "-", tw)}  ${toolText(a, now)}`,
    drill: {
      kind: "scrollback" as const,
      workstream: a.workstream,
      name: a.name,
      paneId: a.pane_id,
      tab: a.tab,
    },
  }));
}

function logRows(snap: DashboardSnapshot, f: Filter): Row[] {
  return snap.log
    .filter((l) => textMatch(f.text, l.rendered, l.actor, l.scope))
    .map((l) => {
      const time = /T(\d\d:\d\d:\d\d)/.exec(l.created_at)?.[1] ?? l.created_at;
      return {
        key: String(l.seq),
        text: `${l.seq}  ${time}  ${l.scope ?? "-"}  ${l.rendered}`,
        drill: { kind: "log", item: l },
      };
    });
}

/**
 * Tasks and DAG show the selected workstream; Agents and Log span every
 * workstream, scratch included (an agent's key says where it lives).
 */
export function tabRows(
  tab: TabId,
  snap: DashboardSnapshot,
  ws: string | null,
  f: Filter,
  now: number,
): Row[] {
  switch (tab) {
    case "tasks":
      return taskRows(snap, ws, f);
    case "dag":
      return dagRows(snap, ws, f);
    case "agents":
      return agentRows(snap, f, now);
    case "log":
      return logRows(snap, f);
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
