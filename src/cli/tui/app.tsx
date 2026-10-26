// The dashboard: a workstream row, four tabs (Tasks, DAG, Agents, Log), one
// filter line, a viewport of rows, and a footer (Next, then error/hints).
// Read-only. Drill (Enter, a) is the next unit. Plain text only: every line is
// cleaned and cut/padded by visual width (text.ts), never ANSI inside <Text>.

import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../../dashboard-data.js";
import {
  cursorIndex,
  type Filter,
  moveCursor,
  NO_FILTER,
  nextLine,
  nextStatusLabel,
  pickWorkstream,
  type Row,
  scopeKey,
  statusesOf,
  TABS,
  type TabId,
  tabRows,
  workstreamLabel,
} from "./rows.js";
import type { DashboardQuery, DashboardRuntime } from "./runtime.js";
import { cell, clean, scrollTop } from "./text.js";
import { useSnapshot } from "./use-snapshot.js";

export interface AppProps {
  runtime: DashboardRuntime;
  /** The workstream to start on (the mux session's, or `-w`); else the most recently active. */
  initialWorkstream?: string;
  /** Poll gap in ms; null loads once. */
  pollMs: number | null;
  /** Clock seam for elapsed times. */
  now?: () => number;
}

const HEADER_LINES = 3;
const FOOTER_LINES = 2;
const HINT = "←/→ tab  [/] workstream  j/k PgUp/PgDn g/G move  s status  / filter  c clear  q quit";

/** The workstream labels as one line of `width` columns, scrolled so the selected one shows. */
export function workstreamLine(labels: readonly string[], selected: number, width: number): string {
  const cell = (i: number): string => (i === selected ? `[${labels[i]}]` : ` ${labels[i]} `);
  let first = 0;
  const total = (from: number): number =>
    labels.slice(from).reduce((n, _, k) => n + clean(cell(from + k)).length, 0);
  while (first < selected && total(first) > width) first++;
  const lead = first > 0 ? "…" : "";
  return lead + labels.map((_, i) => (i >= first ? cell(i) : "")).join("");
}

interface View {
  filter: Filter;
  /** Key of the row under the cursor; null = the tab's default row. */
  cursor: string | null;
}

export function App({ runtime, initialWorkstream, pollMs, now = Date.now }: AppProps) {
  const { exit } = useApp();
  const { columns, rows: screenRows } = useWindowSize();
  const [tab, setTab] = useState<TabId>("tasks");
  const [chosen, setChosen] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, View>>({});
  const [editing, setEditing] = useState<{ before: string } | null>(null);
  const tops = useRef<Record<string, number>>({});

  // The Tasks status filter is the one part of a view the data layer applies, so it
  // is also the query; text filters and workstream scoping are per tab, client-side.
  const viewOf = (t: TabId, w: string | null): View =>
    views[scopeKey(t, w)] ?? { filter: NO_FILTER, cursor: null };
  const query: DashboardQuery = {
    status: [...statusesOf(viewOf("tasks", chosen).filter.status)],
  };
  const state = useSnapshot(runtime, query, pollMs);
  const snap: DashboardSnapshot | null = state.snapshot;

  const names = snap?.workstreams ?? [];
  const live = chosen !== null && names.some((w) => w.name === chosen);
  const ws = live ? chosen : snap ? pickWorkstream(names, initialWorkstream) : null;
  // Lock the first pick: later polls must not move you to whatever is newest.
  useEffect(() => {
    if (chosen === null && ws !== null) setChosen(ws);
  }, [ws, chosen]);

  const view = viewOf(tab, ws);
  const all: Row[] = snap ? tabRows(tab, snap, ws, view.filter, now()) : [];
  const height = Math.max(1, screenRows - HEADER_LINES - FOOTER_LINES);
  const sel = cursorIndex(all, view.cursor, tab);
  const scope = scopeKey(tab, ws);
  const top = scrollTop(tops.current[scope] ?? 0, sel, all.length, height);
  tops.current[scope] = top;

  const patch = (change: Partial<View>, t: TabId = tab): void =>
    setViews((v) => ({ ...v, [scopeKey(t, ws)]: { ...viewOf(t, ws), ...change } }));
  const setFilter = (change: Partial<Filter>): void =>
    patch({ filter: { ...view.filter, ...change }, cursor: null });
  const move = (delta: number): void => patch({ cursor: moveCursor(all, view.cursor, tab, delta) });
  const cycle = (list: readonly string[], cur: string | null, d: number): string | null =>
    list.length === 0
      ? null
      : (list[(Math.max(0, list.indexOf(cur ?? "")) + d + list.length) % list.length] ?? null);

  useInput((input, key) => {
    if (editing !== null) {
      if (key.return) setEditing(null);
      else if (key.escape) {
        setFilter({ text: editing.before });
        setEditing(null);
      } else if (key.backspace || key.delete) setFilter({ text: view.filter.text.slice(0, -1) });
      else if (input !== "" && !key.ctrl && !key.meta)
        setFilter({ text: view.filter.text + clean(input) });
      return;
    }
    if (input === "q" || key.escape) return exit();
    const ids = TABS.map((t) => t.id);
    if (key.tab || key.rightArrow || key.leftArrow) {
      const back = key.leftArrow || (key.tab && key.shift);
      setTab((cycle(ids, tab, back ? -1 : 1) ?? tab) as TabId);
    } else if (input === "[" || input === "]") {
      const next = cycle(
        names.map((w) => w.name),
        ws,
        input === "]" ? 1 : -1,
      );
      if (next !== null) setChosen(next);
    } else if (key.downArrow || input === "j") move(1);
    else if (key.upArrow || input === "k") move(-1);
    else if (key.pageDown) move(height);
    else if (key.pageUp) move(-height);
    else if (input === "g" || key.home) move(-all.length);
    else if (input === "G" || key.end) move(all.length);
    else if (input === "s" && tab === "tasks")
      setFilter({ status: nextStatusLabel(view.filter.status) });
    else if (input === "/") setEditing({ before: view.filter.text });
    else if (input === "c")
      setFilter({ text: "", ...(tab === "tasks" ? { status: "active" as const } : {}) });
    else if (input === "r") state.refresh();
  });

  const text = (s: string) => cell(s, columns);
  const lineOf = (r: Row, i: number): string => `${i === sel ? "> " : "  "}${r.text}`;
  const visible = all.slice(top, top + height);
  const f = view.filter;
  const filterLine = [
    tab === "tasks" ? `status: ${f.status}` : "",
    `filter: ${f.text}${editing ? "_" : ""}`,
    snap ? `${all.length} row${all.length === 1 ? "" : "s"}` : "",
    state.stale || (state.loading && !snap) ? "loading…" : "",
  ]
    .filter((p) => p !== "")
    .join("   ");
  const wsLabels = names.map(workstreamLabel);
  const wsIndex = Math.max(
    0,
    names.findIndex((w) => w.name === ws),
  );
  const empty =
    snap === null
      ? state.error
        ? ""
        : "loading…"
      : all.length === 0
        ? f.text !== ""
          ? "no rows match the filter"
          : "nothing here"
        : "";
  const warn = state.warnings[0];
  const footer = state.error
    ? { text: `error: ${state.error}`, color: "red" as const }
    : warn
      ? { text: `sync: ${warn}`, color: "yellow" as const }
      : { text: editing ? "type to filter  Enter keep  Esc cancel" : HINT, color: undefined };

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {text(wsLabels.length > 0 ? workstreamLine(wsLabels, wsIndex, columns) : "no workstreams")}
      </Text>
      <Box>
        {TABS.map((t) => (
          <Text key={t.id} inverse={t.id === tab} bold={t.id === tab}>
            {` ${t.label} `}
          </Text>
        ))}
      </Box>
      <Text wrap="truncate" dimColor>
        {text(filterLine)}
      </Text>
      {visible.map((r, i) => (
        <Text key={r.key} wrap="truncate" inverse={top + i === sel} dimColor={r.notice === true}>
          {text(lineOf(r, top + i))}
        </Text>
      ))}
      {empty !== "" ? (
        <Text wrap="truncate" dimColor>
          {text(`  ${empty}`)}
        </Text>
      ) : null}
      <Text wrap="truncate" dimColor>
        {text(snap ? nextLine(snap) : "next: unavailable")}
      </Text>
      <Text wrap="truncate" color={footer.color} dimColor={footer.color === undefined}>
        {text(footer.text)}
      </Text>
    </Box>
  );
}
