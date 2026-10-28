// The Overview tab: framed cards over the selected workstream (Attention, Agents,
// In progress, Open by ROI, Log) in 1/2/3 columns by width (grid.ts). The card
// contents are the other tabs' own rows, so a line reads the same everywhere.
// Attention is the cursor's list; the rest are read-only glances.

import { Box } from "ink";
import type { ReactElement } from "react";
import type { DashboardSnapshot } from "../../dashboard-data.js";
import { Frame } from "./frame.js";
import { COLUMN_GAP, columnCount, fitColumn, gridWidths, placeCards } from "./grid.js";
import { NO_FILTER, tabRows, taskRows, waveRows } from "./rows.js";
import { type Line, scrollTop } from "./text.js";
import type { Role } from "./theme.js";

export interface Card {
  id: string;
  title: string;
  lines: Line[];
  /** Shown when there are no lines. */
  empty: string;
  /** The empty line's role (Attention's `✓ all quiet` is good news; the rest are muted). */
  emptyRole?: Role;
  /** Body rows it takes before spare rows are shared out. */
  max: number;
  /** Show the newest lines (the log), not the first. */
  tail?: boolean;
}

/** The cards of workstream `ws`, in order: five, plus Waves when it has delegate waves. */
export function overviewCards(snap: DashboardSnapshot, ws: string | null, now: number): Card[] {
  const lines = (tab: "overview" | "agents" | "log"): Line[] =>
    tabRows(tab, snap, ws, NO_FILTER, now).map((r) => r.line);
  const tasks = (f: typeof NO_FILTER): Line[] =>
    taskRows(snap, ws, f, { call: false }).map((r) => r.line);
  const waves = waveRows(snap, ws).map((r) => r.line);
  return [
    {
      id: "attention",
      title: "Attention",
      lines: lines("overview"),
      empty: "✓ all quiet",
      emptyRole: "good",
      max: 6,
    },
    { id: "agents", title: "Agents", lines: lines("agents"), empty: "no agents", max: 6 },
    {
      id: "progress",
      title: "In progress",
      lines: tasks({ ...NO_FILTER, status: "in_progress" }),
      empty: "nothing in progress",
      max: 8,
    },
    {
      id: "open",
      title: "Open · by ROI",
      lines: tasks({ ...NO_FILTER, status: "open", sort: "roi" }),
      empty: "nothing open",
      max: 12,
    },
    ...(waves.length > 0
      ? [{ id: "waves", title: "Waves", lines: waves, empty: "no waves", max: 5 }]
      : []),
    { id: "log", title: "Log", lines: lines("log"), empty: "no activity", max: 10, tail: true },
  ];
}

/** The cards laid out in `width` x `height`; `sel` is the Attention cursor. */
export function Overview(p: {
  cards: readonly Card[];
  sel: number;
  width: number;
  height: number;
}): ReactElement {
  const columns = placeCards(
    p.cards.map((c) => c.id),
    columnCount(p.width),
  );
  const widths = gridWidths(p.width, columns.length);
  return (
    <Box height={p.height} width={p.width} columnGap={COLUMN_GAP}>
      {columns.map((ids, ci) => {
        const cards = ids.flatMap((id) => p.cards.find((c) => c.id === id) ?? []);
        const placed = fitColumn(
          p.height,
          cards.map((c) => ({
            id: c.id,
            // Attention keeps up to 3 rows even on a short screen: it is why you look.
            min: c.id === "attention" ? Math.max(1, Math.min(3, c.lines.length)) : 1,
            max: c.max,
            count: c.lines.length,
          })),
        );
        return (
          <Box key={ids.join()} flexDirection="column" width={widths[ci]} flexShrink={0}>
            {placed.map((pl) => {
              const card = cards.find((c) => c.id === pl.id);
              if (card === undefined) return null;
              const attention = card.id === "attention";
              const from = card.tail
                ? Math.max(0, card.lines.length - pl.rows)
                : attention
                  ? scrollTop(0, p.sel, card.lines.length, pl.rows)
                  : 0;
              const body = card.lines
                .slice(from, from + pl.rows)
                .map(
                  (l, i): Line =>
                    attention ? [{ text: from + i === p.sel ? "> " : "  " }, ...l] : l,
                );
              return (
                <Frame
                  key={card.id}
                  width={widths[ci] ?? 0}
                  height={pl.height}
                  title={card.title}
                  subtitle={card.lines.length > 0 ? String(card.lines.length) : ""}
                  bottom={pl.hidden > 0 ? `+${pl.hidden} ${card.tail ? "older" : "more"}` : ""}
                  body={
                    card.lines.length === 0
                      ? [[{ text: card.empty, role: card.emptyRole ?? "muted" }]]
                      : body
                  }
                  {...(attention && card.lines.length > 0 ? { selected: p.sel - from } : {})}
                />
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
