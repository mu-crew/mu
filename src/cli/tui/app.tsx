// The dashboard: a workstream row, five tabs (Overview, Tasks, DAG, Agents, Log), an
// attention strip (every view, drills too), a framed list that fills the screen, and Next plus a hint/error
// line pinned to the last row. Overview (the first screen) is a grid of framed cards
// (overview.tsx). Read-only. Drill (Enter, a) is the next unit. Plain text only: every line is
// cleaned and cut/padded by visual width (text.ts), never ANSI inside <Text>.

import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../../dashboard-data.js";
import {
  type AttachResult,
  attachKeyHint,
  planAttach,
  runAttach,
  type StepRunner,
  spawnStep,
} from "./commands.js";
import { Drill, useYank } from "./drill.js";
import { FRAME_CHROME, FRAME_SIDES, Frame } from "./frame.js";
import { NAV_HINT, navKey } from "./nav.js";
import { Overview, overviewCards } from "./overview.js";
import {
  attentionLabel,
  cursorIndex,
  type DrillTarget,
  type Filter,
  moveCursor,
  NO_FILTER,
  nextLine,
  nextSortLabel,
  nextStatusLabel,
  pickWorkstream,
  type Row,
  SORT_ARROWS,
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
  /** The tab to open on (default: Overview). */
  initialTab?: TabId;
  /** Clock seam for elapsed times. */
  now?: () => number;
  /** Runs one attach step with the terminal handed over (a test seam; default spawns). */
  runStep?: StepRunner;
}

// Every screen line is one row tall (cut by width), so the layout is exactly `rows`
// lines at any size. A short terminal drops lines in this order of importance: the
// workstream row and tab row always stay, then ONE data line, then the pinned
// footer, the attention strip, the filter line and Next last.
const FIXED_BY_PRIORITY = ["footer", "strip", "filter", "next"] as const;
type FixedLine = (typeof FIXED_BY_PRIORITY)[number];
const TOP_LINES = 2;

/**
 * Which of `lines` fit in `rows` screen lines, and how many lines remain for the
 * data area (a frame, or bare rows when too short to frame).
 */
export function layout(
  rows: number,
  lines: readonly FixedLine[] = FIXED_BY_PRIORITY,
): { shown: ReadonlySet<FixedLine>; height: number } {
  const spare = Math.max(0, rows - TOP_LINES - 1); // one line kept for data
  const shown = new Set(lines.slice(0, spare));
  return { shown, height: Math.max(0, rows - TOP_LINES - shown.size) };
}

// `q quit` comes right after the tab keys: a narrow terminal cuts the hint from the right.
const HINT_HEAD = `←/→ tab  q quit  [/] workstream  ${NAV_HINT} move`;
const HINT_OVERVIEW = `${HINT_HEAD}  Enter open  y copy`;
const HINT = `${HINT_HEAD}  Enter open  / filter  c clear  y copy`;
const HINT_TASKS = `${HINT_HEAD}  Enter open  s sort  o status  / filter  c clear  y copy`;
const hintAgents = (attachKey: string): string =>
  `${HINT_HEAD}  Enter scrollback  ${attachKey}  / filter  c clear  y copy`;

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

/** An open drill, and what to say above it (an attach that fell back to it). */
interface Open {
  target: DrillTarget;
  notice: readonly string[];
}
type ScrollTarget = Extract<DrillTarget, { kind: "scrollback" }>;

export function App({
  runtime,
  initialWorkstream,
  initialTab = "overview",
  pollMs,
  now = Date.now,
  runStep = spawnStep,
}: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const yank = useYank();
  const [drill, setDrill] = useState<Open | null>(null);
  // A ref, not state or `isActive`: deactivating useInput would drop Ink's raw-mode count,
  // and Ink could not restore raw mode on resume (a key right after the repaint would
  // arrive line-buffered and be lost). The hooks stay active; the handlers just return.
  const busy = useRef(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [attachKey, setAttachKey] = useState("a attach");
  useEffect(() => {
    void attachKeyHint().then(setAttachKey);
  }, []);
  const { columns, rows: screenRows } = useWindowSize();
  const [tab, setTab] = useState<TabId>(initialTab);
  const [chosen, setChosen] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, View>>({});
  const [editing, setEditing] = useState<{ before: string } | null>(null);
  const tops = useRef<Record<string, number>>({});

  // The Tasks status filter and the Log's workstream are what the data layer applies,
  // so they are the query; text filters and the other tabs' scoping are client-side.
  const viewOf = (t: TabId, w: string | null): View =>
    views[scopeKey(t, w)] ?? { filter: NO_FILTER, cursor: null };
  const query: DashboardQuery = {
    status: [...statusesOf(viewOf("tasks", chosen).filter.status)],
    // The Log tail is read per workstream: a quiet one must not vanish behind a busy one's 100 ops.
    ...(chosen !== null ? { logWorkstream: chosen } : {}),
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
  const overview = tab === "overview";
  const { shown, height: area } = layout(
    screenRows,
    // The Overview has no filter; the strip shows on every view, next to the Attention card.
    FIXED_BY_PRIORITY.filter((l) => !(overview && l === "filter")),
  );
  // The data area is framed when it has room for a border and a row; else bare rows.
  const framed = !overview && area > FRAME_CHROME && columns > FRAME_SIDES + 2;
  const height = framed ? area - FRAME_CHROME : area;
  const sel = cursorIndex(all, view.cursor, tab);
  const scope = scopeKey(tab, ws);
  const top = scrollTop(tops.current[scope] ?? 0, sel, all.length, height);
  tops.current[scope] = top;

  const patch = (change: Partial<View>, t: TabId = tab): void =>
    setViews((v) => {
      const k = scopeKey(t, ws);
      return { ...v, [k]: { filter: NO_FILTER, cursor: null, ...v[k], ...change } };
    });
  const setFilter = (change: Partial<Filter>): void =>
    patch({ filter: { ...view.filter, ...change }, cursor: null });
  const move = (delta: number): void => patch({ cursor: moveCursor(all, view.cursor, tab, delta) });
  // Pin the default row: with no cursor yet (first view, or a filter just reset it) the
  // cursor is index 0 of whatever is listed NOW, and a later poll that reorders by
  // activity must not carry it to another task. Log keeps null: its default is the
  // newest row, so it follows the tail until you move. A stale snapshot (a status
  // filter just changed) is not pinned: its rows are about to be replaced.
  useEffect(() => {
    const key = all[sel]?.key;
    if (view.cursor === null && tab !== "log" && !state.stale && key !== undefined)
      setViews((v) => {
        const k = scopeKey(tab, ws);
        // Only if nothing (a key press) set a cursor since this render.
        if (v[k]?.cursor != null) return v;
        return { ...v, [k]: { filter: NO_FILTER, ...v[k], cursor: key } };
      });
  });
  const cycle = (list: readonly string[], cur: string | null, d: number): string | null =>
    list.length === 0
      ? null
      : (list[(Math.max(0, list.indexOf(cur ?? "")) + d + list.length) % list.length] ?? null);

  // Attach runs ONLY from an explicit `a`. The backend's ordered steps get the real
  // terminal (Ink suspends: alternate screen and raw mode off, restored after). If no
  // client can open (no server, no workspace, a required step fails) the user lands on
  // that agent's scrollback with the reason and the line for a shell outside.
  const attach = async (t: ScrollTarget): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setFlash(null);
    let outcome: AttachResult;
    const plan = await planAttach(t);
    if (!plan.ok) outcome = { ok: false, reason: plan.reason, warnings: [] };
    else {
      outcome = { ok: false, reason: "terminal unavailable", warnings: [] };
      try {
        await suspendTerminal(async () => {
          // The suspended terminal keeps this line: where the user went, and how to get back.
          stdout.write(`${plan.notice}\n`);
          outcome = await runAttach(plan.steps, runStep);
          // Still suspended: Ink has not resumed input, so nothing reads stdin yet.
          // Drop what is buffered (typeahead must not replay into the next screen);
          // Ink then restores raw mode for the hooks that own it, before it repaints.
          await new Promise<void>((r) => setImmediate(r));
          while (stdin.read() !== null) {}
          busy.current = false;
        });
      } catch (e) {
        outcome = { ok: false, reason: e instanceof Error ? e.message : String(e), warnings: [] };
      }
    }
    busy.current = false;
    if (!outcome.ok)
      setDrill({
        target: t,
        notice: [
          `could not attach: ${outcome.reason}`,
          ...(plan.line === null ? [] : [`from a shell outside the mux: ${plan.line}`]),
        ],
      });
    else if (outcome.warnings.length > 0) setFlash(`attach: ${outcome.warnings.join("; ")}`);
  };

  useInput(
    (input, key) => {
      if (busy.current) return;
      setFlash(null);
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
      // The Overview's cursor is the Attention card's; its page is the screen's data area.
      const nav = navKey(input, key, height);
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
      } else if (nav !== null)
        move("by" in nav ? nav.by : nav.to === "top" ? -all.length : all.length);
      else if (input === "s" && tab === "tasks")
        setFilter({ sort: nextSortLabel(view.filter.sort) });
      else if (input === "o" && tab === "tasks")
        setFilter({ status: nextStatusLabel(view.filter.status) });
      else if (input === "/" && !overview) setEditing({ before: view.filter.text });
      else if (input === "c" && !overview)
        setFilter({
          text: "",
          ...(tab === "tasks" ? { status: "active" as const, sort: "activity" as const } : {}),
        });
      else if (input === "r") state.refresh();
      else if (key.return) {
        const target = all[sel]?.drill;
        if (target !== undefined) setDrill({ target, notice: [] });
      } else if (input === "a" && tab === "agents") {
        const target = all[sel]?.drill;
        if (target?.kind === "scrollback") void attach(target);
      } else if (input === "y") {
        const target = all[sel]?.drill;
        if (target !== undefined) void yank(target).then(setFlash);
      }
    },
    // A drill owns the keys while it is open: App reads none.
    { isActive: drill === null },
  );

  const text = (s: string) => cell(s, columns);
  const attention = snap?.attention ?? [];
  const lineOf = (r: Row, i: number): string => `${i === sel ? "> " : "  "}${r.text}`;
  const visible = all.slice(top, top + height);
  const f = view.filter;
  const filterLine = [
    tab === "tasks" ? `status: ${f.status}` : "",
    tab === "tasks" ? `sort: ${f.sort} ${SORT_ARROWS[f.sort]}` : "",
    `filter: ${f.text}${editing ? "_" : ""}`,
    snap ? `${all.length} row${all.length === 1 ? "" : "s"}` : "",
    state.stale || (state.loading && !snap) ? "loading…" : "",
  ]
    .filter((p) => p !== "")
    .join("   ");
  const tabIndex = TABS.findIndex((t) => t.id === tab);
  const tabsFit = TABS.reduce((n, t) => n + t.label.length + 2, 0) <= columns;
  const wsLabels = names.map(workstreamLabel);
  const wsIndex = Math.max(
    0,
    names.findIndex((w) => w.name === ws),
  );
  const strip =
    attention.length === 0
      ? "✓ all quiet"
      : `⚠ ${attention.length} need you: ${attention.map((a) => attentionLabel(a, ws)).join(" · ")}`;
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
  const footer = flash
    ? { text: flash, color: undefined }
    : state.error
      ? { text: `error: ${state.error}`, color: "red" as const }
      : warn
        ? { text: `sync: ${warn}`, color: "yellow" as const }
        : {
            text: editing
              ? "type to filter  Enter keep  Esc cancel"
              : overview
                ? HINT_OVERVIEW
                : tab === "agents"
                  ? hintAgents(attachKey)
                  : tab === "tasks"
                    ? HINT_TASKS
                    : HINT,
            color: undefined,
          };

  if (drill !== null)
    return (
      <Drill
        target={drill.target}
        notice={drill.notice}
        strip={{ text: strip, alert: attention.length > 0 }}
        runtime={runtime}
        busy={busy}
        onClose={() => setDrill(null)}
        onAttach={(t) => void attach(t)}
      />
    );

  const bodyLines = [
    ...visible.map((r, i) => lineOf(r, top + i)),
    ...(empty ? [`  ${empty}`] : []),
  ];
  const tabLabel = TABS[tabIndex]?.label ?? "";

  return (
    <Box flexDirection="column" height={screenRows}>
      <Text wrap="truncate">
        {text(wsLabels.length > 0 ? workstreamLine(wsLabels, wsIndex, columns) : "no workstreams")}
      </Text>
      {tabsFit ? (
        <Box>
          {TABS.map((t) => (
            <Text key={t.id} inverse={t.id === tab} bold={t.id === tab}>
              {` ${t.label} `}
            </Text>
          ))}
        </Box>
      ) : (
        // Too narrow for the labels (they would wrap onto a second row): show the
        // active one and its place.
        <Text wrap="truncate" inverse bold>
          {cell(` ${tabLabel} ${tabIndex + 1}/${TABS.length}`, columns)}
        </Text>
      )}
      {shown.has("strip") ? (
        <Text
          wrap="truncate"
          color={attention.length > 0 ? "yellow" : undefined}
          dimColor={attention.length === 0}
        >
          {text(strip)}
        </Text>
      ) : null}
      {shown.has("filter") ? (
        <Text wrap="truncate" dimColor>
          {text(filterLine)}
        </Text>
      ) : null}
      {overview ? (
        <Overview
          cards={snap ? overviewCards(snap, ws, now()) : []}
          sel={sel}
          width={columns}
          height={area}
        />
      ) : framed ? (
        <Frame
          width={columns}
          height={area}
          title={tabLabel}
          subtitle={snap ? String(all.length) : ""}
          bottom={all.length > height ? `${sel + 1}/${all.length}` : ""}
          body={bodyLines}
          selected={sel - top}
        />
      ) : (
        bodyLines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of a fixed-height viewport
          <Text key={i} wrap="truncate" inverse={i === sel - top}>
            {text(l)}
          </Text>
        ))
      )}
      <Box flexGrow={1} />
      {shown.has("next") ? (
        <Text wrap="truncate" dimColor>
          {text(snap ? nextLine(snap) : "next: unavailable")}
        </Text>
      ) : null}
      {shown.has("footer") ? (
        <Text wrap="truncate" color={footer.color} dimColor={footer.color === undefined}>
          {text(footer.text)}
        </Text>
      ) : null}
    </Box>
  );
}
