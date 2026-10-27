// Column alignment for dashboard rows (ported from 3.x columns.ts, plain text).
//
// A column is PROTECTED (ids, statuses, owners, times: never cut, the user
// copies them verbatim) or CLIP (titles, rendered text: cut to what is left and
// ending in "…"). Rows keep one clip column, last. Widths come from the rows the
// CALLER passes: pass every row of the snapshot, not the filtered or scrolled
// window, so a filter or a poll never moves a column.

import stringWidth from "string-width";
import { cell, clean } from "./text.js";

export interface ColumnSpec {
  kind: "protect" | "clip";
  /** "right" pads on the left (numbers). Default "left". */
  align?: "left" | "right";
  /** Floor for the natural width. A fixed column is min === max. */
  min?: number;
  /** Cap for the natural width, so one rogue row cannot balloon the column. */
  max?: number;
}

/** Space between two columns. */
export const GUTTER = 2;

/** The widest cell per column over `rows`, by visual width. */
export function naturalWidths(rows: ReadonlyArray<ReadonlyArray<string>>, ncols: number): number[] {
  const widths = new Array<number>(ncols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < ncols; i++) {
      const w = stringWidth(clean(row[i] ?? ""));
      if (w > (widths[i] ?? 0)) widths[i] = w;
    }
  }
  return widths;
}

/**
 * The width of every column. Protected columns take their natural width (inside
 * min/max); clip columns share what is left of `total`, the last one taking the
 * rounding. When the protected columns alone overflow, clip columns collapse to 0
 * and the row is cut by `renderRow`'s `total` instead. No `total`: natural widths.
 */
export function columnWidths(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  specs: ReadonlyArray<ColumnSpec>,
  total?: number,
): number[] {
  const natural = naturalWidths(rows, specs.length);
  const widths = specs.map((s, i) => {
    let w = natural[i] ?? 0;
    if (s.min !== undefined) w = Math.max(w, s.min);
    if (s.max !== undefined) w = Math.min(w, s.max);
    return w;
  });
  if (total === undefined) return widths;

  const clip = specs.flatMap((s, i) => (s.kind === "clip" ? [i] : []));
  if (clip.length === 0) return widths;
  const fixed = widths.reduce((n, w, i) => (specs[i]?.kind === "protect" ? n + w : n), 0);
  const left = total - fixed - GUTTER * (specs.length - 1);
  if (left <= 0) {
    for (const i of clip) widths[i] = 0;
    return widths;
  }
  const wanted = clip.reduce((n, i) => n + (widths[i] ?? 0), 0);
  if (wanted <= left) return widths;
  const each = Math.floor(left / clip.length);
  for (const i of clip) widths[i] = each;
  const last = clip[clip.length - 1];
  if (last !== undefined) widths[last] = each + (left - each * clip.length);
  return widths;
}

/** One cell cut (end "…") or padded to exactly `width`; "right" pads on the left. */
export function fitCell(s: string, width: number, align: "left" | "right" = "left"): string {
  const text = clean(s);
  const w = stringWidth(text);
  if (align === "right" && w < width) return " ".repeat(width - w) + text;
  return cell(text, width);
}

/** The cells of one row, each exactly its column width (zero-width columns vanish). */
export function renderCells(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  specs: ReadonlyArray<ColumnSpec>,
): string[] {
  return specs.map((s, i) => fitCell(cells[i] ?? "", widths[i] ?? 0, s.align));
}

/**
 * One row as a single line: cells joined by the gutter, then cut or padded to
 * `total` columns when given (the guard for a terminal too narrow for the
 * protected columns). Zero-width columns are skipped along with their gutter.
 */
export function renderRow(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  specs: ReadonlyArray<ColumnSpec>,
  total?: number,
): string {
  const line = renderCells(cells, widths, specs)
    .filter((_, i) => (widths[i] ?? 0) > 0)
    .join(" ".repeat(GUTTER));
  return total === undefined ? line : cell(line, total);
}
