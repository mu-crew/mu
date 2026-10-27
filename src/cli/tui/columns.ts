// Column alignment for dashboard rows (ported from 3.x columns.ts, plain text).
//
// A column is PROTECTED (ids, statuses, owners, times: never cut, the user
// copies them verbatim) or CLIP (titles, rendered text: cut to what is left and
// ending in "…" when the view cuts the line). Rows keep one clip column, last. Widths come from the rows the
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
 * The width of every column: the natural width of its widest cell, inside min/max. The
 * clip column is NOT sized here: its text goes out whole and the view cuts the line to
 * the screen width (`fitLine`, ending in "…").
 */
export function columnWidths(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  specs: ReadonlyArray<ColumnSpec>,
): number[] {
  const natural = naturalWidths(rows, specs.length);
  return specs.map((s, i) => {
    let w = natural[i] ?? 0;
    if (s.min !== undefined) w = Math.max(w, s.min);
    if (s.max !== undefined) w = Math.min(w, s.max);
    return w;
  });
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
