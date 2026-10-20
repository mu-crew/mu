// layout.ts — pure responsive-dashboard layout helpers.
//
// The TUI dashboard is glanceable, not exhaustive: cards should use
// the horizontal and vertical space available without letting one noisy
// list crowd out the rest. This module owns the two pure pieces that
// make that deterministic and easy to test:
//
//   1. layoutColumns(cols, visibleCardIds) — breakpoint + pair-aware
//      card packing into dashboard columns.
//   2. allocateRowBudgets(availableRows, cards) — per-column body-row
//      allocator with min-row guarantees, a maxRows first pass, and
//      largest-remainder leftover distribution; rows still spare then
//      go to cards that hide data, so a column fills its height.
//   3. arrangeColumns({ initial, availableRows, ... }) — local search
//      that moves cards between columns to minimise hidden rows, with
//      hysteresis against the previous assignment.
//
// No ink/react imports here. Cards import their own config from this
// file and re-export it as `cardConfig`; <App> imports the pure helpers
// and the card modules separately.

import type { WorkstreamSnapshot } from "../../state.js";

export type CardId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type CardGroup = "small-pair" | "task-list" | "stream";

export interface CardRowConfig {
  /** Stable card name (e.g. "commits", "agents", "inProgress"). The
   *  single source of truth for the per-card identifier; replaces
   *  the old hand-rolled cardKeyFromId switch in app.tsx. Used as
   *  the card-toggle visibility key (alongside the numeric CardId)
   *  and as a stable string handle anywhere a name is needed. */
  name: string;
  /** Human label shown in the popup status bar (e.g. "Commits",
   *  "In-progress", "Tasks"). Replaces the old popupNameForId
   *  switch in app.tsx. Distinct from `name` because some labels
   *  diverge from a naive capitalise (slot 3's name is "ready"
   *  but its popup is the all-Tasks view; slot 6 is "In-progress",
   *  not "InProgress"). */
  label: string;
  /** Minimum BODY rows to reserve for the card. Empty data still gets this much budget. */
  minRows: number;
  /** First-pass cap on BODY rows. Rows left over after every card
   *  reaches its cap go to cards that still hide data, so this is a
   *  share limit under contention, not a hard ceiling. Popups are exhaustive. */
  maxRows: number;
  /** Non-body rows consumed by TitledBox chrome + footer inset when truncated. */
  chrome: number;
  /** Static neighbour preference used by the pair-aware packer. */
  group: CardGroup;
}

export type CardConfigMap = Readonly<Record<CardId, CardRowConfig>>;

// Two rows of TitledBox chrome: 1 top-border line + 1 bottom-border
// line. The body is rendered by the inner Box (paddingY=0) and the
// PaddedRows helper fills it to exactly `rowBudget` text rows, so the
// declared outer height is `chrome + rowBudget` with no slack.
// Historically this was 4 (over-reservation) which left 2 blank rows
// at the bottom of every card and made the dashboard feel loose; the
// pack_dashboard_cards_tighter polish lowered it to the true chrome
// cost so cards stack flush against each other.
const CARD_CHROME_ROWS = 2;

export const CARD_CONFIGS: CardConfigMap = {
  0: {
    name: "commits",
    label: "Commits",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "stream",
  },
  1: {
    name: "agents",
    label: "Agents",
    minRows: 2,
    maxRows: 10,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
  2: {
    name: "tracks",
    label: "Tracks",
    minRows: 2,
    maxRows: 8,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
  3: {
    name: "ready",
    label: "Tasks",
    minRows: 3,
    maxRows: 15,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  4: {
    name: "log",
    label: "Log",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "stream",
  },
  5: {
    name: "workspaces",
    label: "Workspaces",
    minRows: 2,
    maxRows: 8,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
  6: {
    name: "inProgress",
    label: "In-progress",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  7: {
    name: "blocked",
    label: "Blocked",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  8: {
    name: "recent",
    label: "Recent",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  9: {
    name: "doctor",
    label: "Doctor",
    minRows: 2,
    maxRows: 8,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
};

export interface ColumnAssignment {
  cards: CardId[];
}

export interface CardHitRegion {
  id: CardId;
  column: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function dashboardColumnCount(cols: number): 1 | 2 | 3 | 4 {
  if (cols >= 240) return 4;
  if (cols >= 180) return 3;
  if (cols >= 120) return 2;
  return 1;
}

/**
 * Breakpoint + pair-aware card packer.
 *
 * - <120 cols: single stack, sorted by slot with slot 0 last.
 * - 120-179: small/task columns with stream cards split as trailers.
 * - 180-239: small cards / task-list / stream.
 * - 240+: split the two natural small pairs, then task-list, then stream.
 *
 * Empty columns are filtered out so toggling a whole group off
 * redistributes the remaining columns instead of leaving a blank lane.
 */
export function layoutColumns(
  cols: number,
  visibleCardIds: ReadonlyArray<CardId>,
): ColumnAssignment[] {
  const visible = normalizeVisible(visibleCardIds);
  const target = dashboardColumnCount(cols);
  if (target === 1) {
    const cards = sortCards(visible);
    return cards.length === 0 ? [] : [{ cards }];
  }

  const small = sortCards(visible.filter((id) => CARD_CONFIGS[id].group === "small-pair"));
  const task = sortCards(visible.filter((id) => CARD_CONFIGS[id].group === "task-list"));
  const stream = sortCards(visible.filter((id) => CARD_CONFIGS[id].group === "stream"));

  const columns = (() => {
    if (target === 2) {
      const leftStream: CardId[] = [];
      const rightStream: CardId[] = [];
      for (const [index, id] of stream.entries()) {
        if (stream.length === 1 && id === 0) {
          rightStream.push(id);
          continue;
        }
        (index % 2 === 0 ? leftStream : rightStream).push(id);
      }
      return [
        [...small, ...sortCards(leftStream)],
        [...task, ...sortCards(rightStream)],
      ];
    }
    if (target === 3) return [small, task, stream];
    const topSmall = small.filter((id) => id === 1 || id === 2);
    const bottomSmall = small.filter((id) => id === 5 || id === 9);
    return [topSmall, bottomSmall, task, stream];
  })();

  return columns.filter((cards) => cards.length > 0).map((cards) => ({ cards }));
}

export interface ColumnWidth {
  width: number;
}

export function columnWidths(totalCols: number, columnCount: number): ColumnWidth[] {
  if (columnCount <= 0) return [];
  const gaps = columnCount - 1;
  const usable = Math.max(columnCount, totalCols - gaps);
  const base = Math.floor(usable / columnCount);
  const extra = usable - base * columnCount;
  return Array.from({ length: columnCount }, (_, i) => ({ width: base + (i < extra ? 1 : 0) }));
}

export function dashboardCardHitRegions(
  assignments: ReadonlyArray<ColumnAssignment>,
  widths: ReadonlyArray<ColumnWidth>,
  budgets: ReadonlyArray<RowBudgetMap>,
  opts: { top?: number; left?: number; columnGap?: number } = {},
): CardHitRegion[] {
  const topBase = opts.top ?? 1;
  const leftBase = opts.left ?? 1;
  const gap = opts.columnGap ?? 1;
  const out: CardHitRegion[] = [];
  let left = leftBase;
  for (let column = 0; column < assignments.length; column++) {
    const assignment = assignments[column];
    const width = widths[column]?.width;
    const budget = budgets[column];
    if (assignment === undefined || width === undefined || budget === undefined) continue;
    let top = topBase;
    for (const id of assignment.cards) {
      const height = CARD_CONFIGS[id].chrome + budget[id];
      out.push({ id, column, left, right: left + width - 1, top, bottom: top + height - 1 });
      top += height;
    }
    left += width + gap;
  }
  return out;
}

export function cardRenderHeight(
  config: CardRowConfig,
  rowBudget: number | undefined,
): number | undefined {
  return rowBudget === undefined ? undefined : config.chrome + rowBudget;
}

export function hitTestDashboardCard(
  regions: ReadonlyArray<CardHitRegion>,
  point: { x: number; y: number },
): CardId | null {
  for (const region of regions) {
    if (
      point.x >= region.left &&
      point.x <= region.right &&
      point.y >= region.top &&
      point.y <= region.bottom
    ) {
      return region.id;
    }
  }
  return null;
}

export interface RowBudgetInput {
  id: CardId;
  dataCount: number;
  config?: CardRowConfig;
}

export type RowBudgetMap = Readonly<Record<CardId, number>>;

const CARD_CULL_PRIORITY: readonly CardId[] = [9, 8, 5, 2, 7, 6, 4, 0, 1, 3];
const CARD_CULL_LAYOUT_COLS = 140;

export interface CulledCards {
  /** Surviving cards, preserving the caller's visible-set order after de-dupe. */
  cards: CardId[];
  /** Cards hidden because the pane is too short, in cull-priority order. */
  hidden: CardId[];
}

/**
 * Trim low-priority dashboard cards until the minimum stack fits.
 *
 * The user-controlled visible set is the ceiling: toggled-off cards
 * never reappear here. We only cull further, keeping at least one
 * card (the highest-priority visible card) so a tiny-but-not-panic
 * pane still renders a useful dashboard plus the resize hint.
 */
export function cullCardsForRows(
  visibleCardIds: ReadonlyArray<CardId>,
  availableRows: number,
): CulledCards {
  const cards = normalizeVisible(visibleCardIds);
  const hidden: CardId[] = [];
  if (cards.length === 0) return { cards, hidden };

  const remaining = new Set<CardId>(cards);
  const budget = Math.max(0, Math.floor(availableRows));
  const maxCardsForRows = Math.max(1, Math.floor(budget / CARD_CHROME_ROWS));
  for (const id of CARD_CULL_PRIORITY) {
    const surviving = cards.filter((card) => remaining.has(card));
    if (surviving.length <= maxCardsForRows && tallestMinStackRows(surviving) <= budget) break;
    if (!remaining.has(id)) continue;
    if (remaining.size <= 1) break;
    remaining.delete(id);
    hidden.push(id);
  }

  return { cards: cards.filter((id) => remaining.has(id)), hidden };
}

/** Hysteresis for `arrangeColumns`: a new card-to-column assignment
 *  replaces the previous one only when it hides at least this many
 *  fewer rows (or this fraction of the previous hidden total, if
 *  larger). Keeps cards from jumping when a list grows by one. */
export const REARRANGE_MIN_GAIN_ROWS = 3;
export const REARRANGE_MIN_GAIN_FRACTION = 0.1;

export interface ArrangeColumnsInput {
  /** Default group packing from `layoutColumns`; the search start. */
  initial: ReadonlyArray<ColumnAssignment>;
  /** Rows per column, chrome included (same value fed to the budgets). */
  availableRows: number;
  dataCountFn: (id: CardId) => number;
  /** Assignment from the previous render. Ignored unless it holds the
   *  same cards in the same number of columns. Pass null after a
   *  resize or card toggle so the layout may reflow freely. */
  previous?: ReadonlyArray<ColumnAssignment> | null;
}

export interface ArrangedColumns {
  assignments: ColumnAssignment[];
  /** Rows of data the chosen assignment cannot show, summed over cards. */
  hiddenRows: number;
}

/**
 * Card-to-column search. Pure: (previous, input) -> next.
 *
 * Objective: minimise hidden rows, the sum over cards of
 * max(0, dataCount - budget) once every column's budgets are filled
 * (`columnRowBudgets`). Steepest descent from the default packing:
 * each round tries every single-card move and every pairwise swap
 * across columns and takes the best by the key (hidden rows, then
 * fewest cards away from their default column, then slot order). Equal-
 * hidden neighbours count when they win on the later keys. It stops
 * when no neighbour beats the current assignment, so the result is a
 * deterministic local optimum of the whole key. With 10 cards and 4
 * columns a round is at most 30 moves + 45 swaps; rounds strictly
 * improve the key and are capped at MAX_ARRANGE_ROUNDS.
 *
 * Cards keep slot order inside a column (`compareSlot`, Commits last)
 * and no column is emptied, so the column count never changes.
 *
 * Stability: with a valid `previous`, the search also descends from
 * it and keeps the better of the two optima. `previous` survives
 * unless that optimum hides at least max(REARRANGE_MIN_GAIN_ROWS, 10%)
 * fewer rows, so no single move or swap from a retained layout saves
 * that much.
 */
const MAX_ARRANGE_ROUNDS = 40;

export function arrangeColumns(input: ArrangeColumnsInput): ArrangedColumns {
  const initial = input.initial.map((a) => sortCards(a.cards));
  const rows = input.availableRows;
  const counts = new Map<CardId, number>();
  for (const lane of initial) {
    for (const id of lane) counts.set(id, Math.max(0, Math.floor(input.dataCountFn(id))));
  }
  const dataCount = (id: CardId): number => counts.get(id) ?? 0;
  const hiddenOf = (lanes: ReadonlyArray<ReadonlyArray<CardId>>): number =>
    lanes.reduce((sum, lane) => sum + hiddenRowsForColumn(rows, lane, dataCount), 0);

  const defaultColumn = new Map<CardId, number>();
  initial.forEach((lane, column) => {
    for (const id of lane) defaultColumn.set(id, column);
  });
  // Lexicographic search key: hidden rows, then cards away from their
  // default column, then slot order (each card's column, cards taken
  // in slot order, so earlier slots stay in earlier columns). A total
  // order, so descent on it terminates.
  const slotCards = sortCards(initial.flat());
  type Scored = { lanes: CardId[][]; hidden: number; moved: number; slots: number[] };
  const score = (lanes: CardId[][], hidden = hiddenOf(lanes)): Scored => {
    const column = new Map<CardId, number>();
    lanes.forEach((lane, c) => {
      for (const id of lane) column.set(id, c);
    });
    let moved = 0;
    for (const id of slotCards) if (column.get(id) !== defaultColumn.get(id)) moved++;
    return { lanes, hidden, moved, slots: slotCards.map((id) => column.get(id) ?? 0) };
  };
  const better = (a: Scored, b: Scored): boolean => {
    if (a.hidden !== b.hidden) return a.hidden < b.hidden;
    if (a.moved !== b.moved) return a.moved < b.moved;
    for (let i = 0; i < a.slots.length; i++) {
      const x = a.slots[i] ?? 0;
      const y = b.slots[i] ?? 0;
      if (x !== y) return x < y;
    }
    return false;
  };

  // Steepest descent on the full key: equal-hidden neighbours that
  // move fewer cards (or restore slot order) are taken too.
  const descend = (start: CardId[][]): { lanes: CardId[][]; hidden: number } => {
    let current = score(start);
    for (let round = 0; round < MAX_ARRANGE_ROUNDS; round++) {
      let best: Scored | null = null;
      for (const lanes of neighbours(current.lanes)) {
        const hidden = hiddenOf(lanes);
        if (hidden > current.hidden) continue;
        const candidate = score(lanes, hidden);
        if (!better(candidate, current)) continue;
        if (best === null || better(candidate, best)) best = candidate;
      }
      if (best === null) break;
      current = best;
    }
    return { lanes: current.lanes, hidden: current.hidden };
  };

  let result = descend(initial);
  const previous = validPrevious(input.previous, initial);
  if (previous !== null) {
    const previousHidden = hiddenOf(previous);
    // Also descend from the previous assignment: the default-start
    // search can land in a different local optimum and miss a single
    // move or swap from `previous` that saves more than the hysteresis.
    const fromPrevious = descend(previous);
    if (fromPrevious.hidden <= result.hidden) result = fromPrevious;
    const minGain = Math.max(
      REARRANGE_MIN_GAIN_ROWS,
      Math.ceil(previousHidden * REARRANGE_MIN_GAIN_FRACTION),
    );
    if (previousHidden - result.hidden < minGain) {
      return { assignments: previous.map((cards) => ({ cards })), hiddenRows: previousHidden };
    }
  }
  return { assignments: result.lanes.map((cards) => ({ cards })), hiddenRows: result.hidden };
}

/** Every assignment one card move or one cross-column swap away, in slot order. */
function* neighbours(lanes: ReadonlyArray<ReadonlyArray<CardId>>): Generator<CardId[][]> {
  for (let from = 0; from < lanes.length; from++) {
    const donor = lanes[from] ?? [];
    if (donor.length <= 1) continue;
    for (const card of donor) {
      for (let to = 0; to < lanes.length; to++) {
        if (to === from) continue;
        const next = lanes.map((lane) => [...lane]);
        next[from] = donor.filter((id) => id !== card);
        next[to] = sortCards([...(lanes[to] ?? []), card]);
        yield next;
      }
    }
  }
  for (let a = 0; a < lanes.length; a++) {
    for (let b = a + 1; b < lanes.length; b++) {
      for (const x of lanes[a] ?? []) {
        for (const y of lanes[b] ?? []) {
          const next = lanes.map((lane) => [...lane]);
          next[a] = sortCards([...(lanes[a] ?? []).filter((id) => id !== x), y]);
          next[b] = sortCards([...(lanes[b] ?? []).filter((id) => id !== y), x]);
          yield next;
        }
      }
    }
  }
}

function validPrevious(
  previous: ReadonlyArray<ColumnAssignment> | null | undefined,
  initial: ReadonlyArray<ReadonlyArray<CardId>>,
): CardId[][] | null {
  if (previous === null || previous === undefined) return null;
  if (previous.length !== initial.length) return null;
  if (previous.some((a) => a.cards.length === 0)) return null;
  const key = (lanes: ReadonlyArray<ReadonlyArray<CardId>>): string =>
    sortCards(lanes.flat()).join(",");
  const lanes = previous.map((a) => sortCards(a.cards));
  if (lanes.flat().length !== new Set(lanes.flat()).size) return null;
  return key(lanes) === key(initial) ? lanes : null;
}

function hiddenRowsForColumn(
  availableRows: number,
  cards: ReadonlyArray<CardId>,
  dataCountFn: (id: CardId) => number,
): number {
  const budgets = columnRowBudgets(availableRows, cards, dataCountFn);
  return cards.reduce<number>((sum, id) => sum + Math.max(0, dataCountFn(id) - budgets[id]), 0);
}

/**
 * Final body-row budgets for one column: `allocateRowBudgets`, then
 * clipped top-down so the stack never exceeds `availableRows` even
 * when the min guarantees alone do not fit. Card footers and
 * `dashboardCardHitRegions` read these same numbers.
 */
export function columnRowBudgets(
  availableRows: number,
  cards: ReadonlyArray<CardId>,
  dataCountFn: (id: CardId) => number,
): RowBudgetMap {
  const out: Record<CardId, number> = {
    ...allocateRowBudgets(
      availableRows,
      cards.map((id) => ({ id, dataCount: dataCountFn(id) })),
    ),
  };
  let remaining = Math.max(0, Math.floor(availableRows));
  for (const id of cards) {
    const chrome = CARD_CONFIGS[id].chrome;
    out[id] = Math.min(out[id], Math.max(0, remaining - chrome));
    remaining = Math.max(0, remaining - chrome - out[id]);
  }
  return out;
}

/**
 * Allocate BODY rows among the cards in one dashboard column.
 *
 * `availableRows` is the total vertical budget for the column,
 * including card chrome. The returned map contains body rows (the
 * value each card should pass to slice(0, N)). Chrome is still
 * accounted for so columns with many cards don't over-allocate.
 */
export function allocateRowBudgets(
  availableRows: number,
  cards: ReadonlyArray<RowBudgetInput>,
): RowBudgetMap {
  const entries = cards.map((card) => {
    const config = card.config ?? CARD_CONFIGS[card.id];
    const dataCount = Math.max(0, Math.floor(card.dataCount));
    const minRows = Math.max(0, config.minRows);
    const maxRows = Math.max(minRows, config.maxRows);
    const naturalRows = clamp(dataCount, minRows, maxRows);
    return { id: card.id, dataCount, config, minRows, maxRows, naturalRows };
  });

  const out = emptyBudgetMap();
  if (entries.length === 0) return out;

  const chromeTotal = entries.reduce((sum, e) => sum + e.config.chrome, 0);
  const bodyAvailable = Math.max(0, availableRows - chromeTotal);

  const naturalTotal = entries.reduce((sum, e) => sum + e.naturalRows + e.config.chrome, 0);
  if (naturalTotal <= availableRows) {
    for (const e of entries) out[e.id] = e.naturalRows;
    return fillOverflow(out, entries, bodyAvailable);
  }
  const minTotal = entries.reduce((sum, e) => sum + e.minRows, 0);

  // Min-row guarantee. If the terminal is too short to fit the
  // guarantees plus chrome, return the guarantees anyway and let the
  // App root's overflow clip be the final guard.
  if (bodyAvailable <= minTotal) {
    for (const e of entries) out[e.id] = e.minRows;
    return out;
  }

  for (const e of entries) out[e.id] = e.minRows;

  let remaining = bodyAvailable - minTotal;
  const totalWeight = entries.reduce((sum, e) => sum + clamp(e.dataCount, e.minRows, e.maxRows), 0);
  const weighted = entries.map((e, index) => {
    const weight = totalWeight === 0 ? 1 : clamp(e.dataCount, e.minRows, e.maxRows);
    const raw = totalWeight === 0 ? remaining / entries.length : (remaining * weight) / totalWeight;
    const add = Math.min(e.maxRows - e.minRows, Math.floor(raw));
    return { id: e.id, index, raw, add, capacity: e.maxRows - e.minRows };
  });

  for (const w of weighted) {
    out[w.id] += w.add;
    remaining -= w.add;
  }

  const remainders = weighted
    .map((w) => ({ ...w, remainder: w.raw - Math.floor(w.raw) }))
    .sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder - a.remainder));

  while (remaining > 0) {
    let changed = false;
    for (const r of remainders) {
      if (remaining <= 0) break;
      const entry = entries[r.index];
      if (entry === undefined) continue;
      if (out[r.id] >= entry.maxRows) continue;
      out[r.id] += 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
  }

  return fillOverflow(out, entries, bodyAvailable);
}

/**
 * Second pass of `allocateRowBudgets`: maxRows capped the first pass,
 * so rows may be left over while a card still hides data. Hand them to
 * the cards with hidden rows, in proportion to how many each hides
 * (largest remainder, ties by input order), never past a card's data.
 * Cards that fit get nothing, so short lists are not padded.
 */
function fillOverflow(
  out: Record<CardId, number>,
  entries: ReadonlyArray<{ id: CardId; dataCount: number }>,
  bodyAvailable: number,
): Record<CardId, number> {
  let spare = bodyAvailable - entries.reduce((sum, e) => sum + out[e.id], 0);
  while (spare > 0) {
    const hidden = entries
      .map((e, index) => ({ id: e.id, index, rows: Math.max(0, e.dataCount - out[e.id]) }))
      .filter((h) => h.rows > 0);
    const totalHidden = hidden.reduce((sum, h) => sum + h.rows, 0);
    if (totalHidden === 0) break;
    const pool = Math.min(spare, totalHidden);
    const shares = hidden.map((h) => {
      const raw = (pool * h.rows) / totalHidden;
      return { ...h, add: Math.floor(raw), remainder: raw - Math.floor(raw) };
    });
    let given = 0;
    for (const share of shares) {
      out[share.id] += share.add;
      given += share.add;
    }
    shares.sort((a, b) =>
      b.remainder === a.remainder ? a.index - b.index : b.remainder - a.remainder,
    );
    for (const share of shares) {
      if (given >= pool) break;
      if (out[share.id] >= (entries[share.index]?.dataCount ?? 0)) continue;
      out[share.id] += 1;
      given += 1;
    }
    if (given === 0) break;
    spare -= given;
  }
  return out;
}

export function dataCountForCard(id: CardId, snapshot: WorkstreamSnapshot | null): number {
  if (snapshot === null) return 0;
  switch (id) {
    case 0:
      return snapshot.recentCommits.length;
    case 1:
      return snapshot.view.agents.length;
    case 2:
      return snapshot.tracks.length;
    case 3:
      return snapshot.ready.length;
    case 4:
      return snapshot.recent.length;
    case 5:
      return snapshot.workspaces.length;
    case 6:
      return snapshot.inProgress.length;
    case 7:
      return snapshot.blocked.length;
    case 8:
      return snapshot.recentClosed.length;
    case 9:
      return snapshot.doctor?.problemCount ?? 0;
  }
}

function compareSlot(a: CardId, b: CardId): number {
  const ka = a === 0 ? 10 : a;
  const kb = b === 0 ? 10 : b;
  return ka - kb;
}

function sortCards(ids: ReadonlyArray<CardId>): CardId[] {
  return [...ids].sort(compareSlot);
}

function normalizeVisible(ids: ReadonlyArray<CardId>): CardId[] {
  const seen = new Set<CardId>();
  const out: CardId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.sort((a, b) => a - b);
}

function emptyBudgetMap(): Record<CardId, number> {
  return { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
}

function tallestMinStackRows(ids: ReadonlyArray<CardId>): number {
  let tallest = 0;
  for (const assignment of layoutColumns(CARD_CULL_LAYOUT_COLS, ids)) {
    let total = 0;
    for (const id of assignment.cards) {
      const config = CARD_CONFIGS[id];
      total += Math.max(0, config.minRows) + Math.max(0, config.chrome);
    }
    tallest = Math.max(tallest, total);
  }
  return tallest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
