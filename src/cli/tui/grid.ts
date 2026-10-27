// Overview card geometry (ported from 3.x layout.ts, rewritten over a small
// CardSpec): how many columns, how wide, which card goes where, and how many
// body rows each card gets. Pure and plain-text; no ink.
//
// Rules: 1 column below 120 cols, 2 from 120, 3 from 180. Each card has min and
// max body rows. The allocator hands rows out up to max first so a noisy list
// cannot crowd its siblings, then gives spare rows to the cards still hiding
// data, in proportion to what each hides: a column with hidden data fills its
// height, a short list is not padded.

import { FRAME_CHROME } from "./frame.js";

export interface CardSpec {
  id: string;
  /** Body rows reserved even when empty. */
  min: number;
  /** First-pass cap on body rows; spare rows may go past it while data is hidden. */
  max: number;
  /** How many rows the card has to show. */
  count: number;
}

/** Space between two columns. */
export const COLUMN_GAP = 1;

export function columnCount(cols: number): 1 | 2 | 3 {
  if (cols >= 180) return 3;
  if (cols >= 120) return 2;
  return 1;
}

/** Outer widths of `n` columns across `total` cols, leaving a gap between each; the leftmost take the remainder. */
export function gridWidths(total: number, n: number): number[] {
  if (n <= 0) return [];
  const usable = Math.max(n, total - COLUMN_GAP * (n - 1));
  const base = Math.floor(usable / n);
  const extra = usable - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Which column each Overview card sits in, per column count. A fixed table, so a
 * list growing by one row never moves a card. Attention first, Log last.
 */
const PLACEMENT: Readonly<Record<1 | 2 | 3, Readonly<Record<string, number>>>> = {
  1: {},
  2: { attention: 0, agents: 0, progress: 1, open: 1, log: 0 },
  3: { attention: 0, agents: 0, progress: 1, open: 1, log: 2 },
};

/**
 * `ids` (in card order) split into columns by `PLACEMENT[n]`. An id the table
 * does not name goes in the last column. Empty columns are dropped.
 */
export function placeCards(ids: readonly string[], n: 1 | 2 | 3): string[][] {
  const table = PLACEMENT[n];
  const cols: string[][] = Array.from({ length: n }, () => []);
  for (const id of ids) cols[Math.min(n - 1, table[id] ?? n - 1)]?.push(id);
  return cols.filter((c) => c.length > 0);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Body rows per card for one column of `availableRows` lines (chrome included).
 * The result is keyed by card id, in `cards` order. When even the minimums do
 * not fit, the minimums come back and `fitColumn` clips them.
 */
export function allocateRowBudgets(
  availableRows: number,
  cards: readonly CardSpec[],
): Map<string, number> {
  const out = new Map<string, number>();
  const entries = cards.map((c) => {
    const min = Math.max(0, c.min);
    const max = Math.max(min, c.max);
    const count = Math.max(0, Math.floor(c.count));
    return { id: c.id, min, max, count, natural: clamp(count, min, max) };
  });
  if (entries.length === 0) return out;

  const body = Math.max(0, availableRows - FRAME_CHROME * entries.length);
  const set = (id: string, n: number): void => void out.set(id, n);

  const naturalTotal = entries.reduce((n, e) => n + e.natural, 0);
  if (naturalTotal <= body) {
    for (const e of entries) set(e.id, e.natural);
    return fillHidden(out, entries, body);
  }
  const minTotal = entries.reduce((n, e) => n + e.min, 0);
  for (const e of entries) set(e.id, e.min);
  if (body <= minTotal) return out;

  // Share what is left above the minimums, weighted by each card's natural size.
  const left = body - minTotal;
  const weight = entries.reduce((n, e) => n + e.natural, 0);
  const shares = entries.map((e, index) => {
    const raw = weight === 0 ? left / entries.length : (left * e.natural) / weight;
    return { e, index, raw, add: Math.min(e.max - e.min, Math.floor(raw)) };
  });
  let remaining = left;
  for (const s of shares) {
    set(s.e.id, s.e.min + s.add);
    remaining -= s.add;
  }
  const byRemainder = [...shares].sort(
    (a, b) => b.raw - Math.floor(b.raw) - (a.raw - Math.floor(a.raw)) || a.index - b.index,
  );
  while (remaining > 0) {
    let changed = false;
    for (const s of byRemainder) {
      if (remaining <= 0) break;
      const have = out.get(s.e.id) ?? 0;
      if (have >= s.e.max) continue;
      set(s.e.id, have + 1);
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
  }
  return fillHidden(out, entries, body);
}

/**
 * Spare rows go to the cards that still hide data, in proportion to how many each
 * hides (largest remainder, ties by card order), never past a card's own count.
 */
function fillHidden(
  out: Map<string, number>,
  entries: ReadonlyArray<{ id: string; count: number }>,
  body: number,
): Map<string, number> {
  let spare = body - entries.reduce((n, e) => n + (out.get(e.id) ?? 0), 0);
  while (spare > 0) {
    const hidden = entries
      .map((e, index) => ({ id: e.id, index, rows: Math.max(0, e.count - (out.get(e.id) ?? 0)) }))
      .filter((h) => h.rows > 0);
    const total = hidden.reduce((n, h) => n + h.rows, 0);
    if (total === 0) break;
    const pool = Math.min(spare, total);
    const shares = hidden.map((h) => {
      const raw = (pool * h.rows) / total;
      return { ...h, add: Math.floor(raw), rem: raw - Math.floor(raw) };
    });
    let given = 0;
    for (const s of shares) {
      out.set(s.id, (out.get(s.id) ?? 0) + s.add);
      given += s.add;
    }
    shares.sort((a, b) => b.rem - a.rem || a.index - b.index);
    for (const s of shares) {
      if (given >= pool) break;
      const count = entries[s.index]?.count ?? 0;
      if ((out.get(s.id) ?? 0) >= count) continue;
      out.set(s.id, (out.get(s.id) ?? 0) + 1);
      given += 1;
    }
    if (given === 0) break;
    spare -= given;
  }
  return out;
}

export interface PlacedCard {
  id: string;
  /** Outer height, frame included. */
  height: number;
  /** Body rows the card shows. */
  rows: number;
  /** Rows of data it cannot show (`+N more`). */
  hidden: number;
}

/**
 * One column laid out in `availableRows` lines: budgets from `allocateRowBudgets`,
 * clipped top-down so the stack never passes `availableRows`. A card left with no
 * body row is dropped rather than drawn as an empty frame, but the first card
 * always stays. Total height is at most `availableRows`.
 */
export function fitColumn(availableRows: number, cards: readonly CardSpec[]): PlacedCard[] {
  const budgets = allocateRowBudgets(availableRows, cards);
  const out: PlacedCard[] = [];
  let left = Math.max(0, Math.floor(availableRows));
  for (const c of cards) {
    const rows = Math.min(budgets.get(c.id) ?? 0, Math.max(0, left - FRAME_CHROME));
    if (rows === 0 && c.min > 0 && out.length > 0) continue;
    if (left < FRAME_CHROME) break;
    out.push({ id: c.id, height: FRAME_CHROME + rows, rows, hidden: Math.max(0, c.count - rows) });
    left -= FRAME_CHROME + rows;
  }
  return out;
}
