// mu — the shared pager of the capped text/JSON reads that are not task reads
// (`mu log`, `mu workstream list`).
//
// Pure (no I/O, no DB). A page is bounded on its FINAL bytes (RESULT_BYTES,
// envelope, footer and trailer included). A cut is counted (`more=N` records
// left out, `cut=N` characters clipped) and names its way back as a command that
// runs as printed.

import { RESULT_BYTES } from "../output-contract.js";
import {
  clipEscaped,
  codePoints,
  escapeRecordText,
  jsonDocument,
  linesBytes,
  pageRecords,
  RECORD_CHARS,
  type RecordPage,
} from "./tasks/records.js";

const bytes = (s: string): number => Buffer.byteLength(s);

/** Longest command a hint echoes back (one page also holds a second hint and its records). */
export const COMMAND_MAX_BYTES = 1024;
/** A fixed column (source, scope, ...) is clipped to this many characters. */
const COLUMN_CHARS = 64;
/** One JSON item's own document stays within this, so a page always has room for its metadata. */
export const ITEM_BYTES = 2048;

/** `cmd` when it is one inert line of at most `max` bytes, else `fallback()`: a hint must run as printed. */
export function boundedCommand(
  cmd: string,
  fallback: () => string,
  max = COMMAND_MAX_BYTES,
): string {
  return bytes(cmd) > max || escapeRecordText(cmd) !== cmd ? fallback() : cmd;
}

/** `s` clipped to `max` code points; `cut` counts the code points dropped. */
export function clipPlain(s: string, max: number): { text: string; cut: number } {
  const cps = codePoints(s);
  if (cps.length <= max) return { text: s, cut: 0 };
  return { text: cps.slice(0, max).join(""), cut: cps.length - max };
}

/**
 * Build an item whose own document fits ITEM_BYTES whatever it holds (control
 * and multibyte characters escape to 6 bytes and more): every field's character
 * limit shrinks (halving, then to empty) until it does. `build(scale)` clips each
 * field to `floor(limit * scale)`.
 */
export function shrinkItem<I extends object>(
  build: (scale: number) => { item: I; cut: number },
): { item: I; cut: number } {
  let out = build(1);
  for (const scale of [0.5, 0.25, 0.125, 0]) {
    if (bytes(jsonDocument({ items: [out.item] })) <= ITEM_BYTES) break;
    out = build(scale);
  }
  return out;
}

// ─── the generic pager ─────────────────────────────────────────────────

export interface PageSpec<T> {
  json: boolean;
  /** Every row, whole, no cap and no footer (`--all`). */
  whole?: boolean;
  /** Fill the page from the END of `rows` (the newest), printing it in the original order. */
  newest?: boolean;
  /** One text record; `cut` counts the characters it clipped (none when `whole`). */
  text(row: T, whole: boolean): { line: string; cut: number };
  /** One JSON item; `cut` counts the characters it clipped (none when `whole`). */
  item(row: T, whole: boolean): { item: object; cut: number };
  /** The command that reads the `more` records left out. */
  resume(shown: readonly T[], more: number): string;
  /** The command that reads the clipped rows whole; defaults to `resume`. */
  retrieve?(clipped: readonly T[]): string;
  /** Lines printed after the footer (a `Next:` block), counted in the page's final bytes. */
  trailer?: readonly string[];
  /** JSON: name the one way back `retrieve`, with no separate `resume`. */
  singleRetrieve?: boolean;
}

export interface PageData {
  items: object[];
  count: number;
  more: number;
  cut?: number;
  /** Reads the `more` records left out. */
  resume?: string;
  /** Reads the clipped records whole. */
  retrieve?: string;
}

export interface PageOut {
  /** Text lines to print; empty when `json`. */
  lines: string[];
  /** The `data` payload; undefined unless `json`. */
  data?: PageData;
  shown: number;
  more: number;
}

/** Page `rows` into at most RESULT_BYTES of final output, as text lines or one JSON document. */
export function pageOut<T>(rows: readonly T[], spec: PageSpec<T>): PageOut {
  const newest = spec.newest === true;
  const whole = spec.whole === true;
  const render = (page: RecordPage<T>): { lines: string[]; data: PageData } => {
    const shown = newest ? [...page.shown].reverse() : page.shown;
    let cut = 0;
    const clipped: T[] = [];
    const lines: string[] = [];
    const items: object[] = [];
    for (const r of shown) {
      if (spec.json) {
        const one = spec.item(r, whole);
        if (one.cut > 0) clipped.push(r);
        cut += one.cut;
        items.push(one.item);
      } else {
        const one = spec.text(r, whole);
        if (one.cut > 0) clipped.push(r);
        cut += one.cut;
        lines.push(one.line);
      }
    }
    const resume = page.more > 0 ? spec.resume(shown, page.more) : undefined;
    const retrieve =
      cut > 0 ? (spec.retrieve ?? ((_c) => spec.resume(shown, page.more)))(clipped) : undefined;
    if (resume !== undefined && resume === retrieve) {
      lines.push(`more=${page.more} cut=${cut} next=${resume}`);
    } else {
      if (resume !== undefined) lines.push(`more=${page.more} next=${resume}`);
      if (retrieve !== undefined) lines.push(`cut=${cut} next=${retrieve}`);
    }
    lines.push(...(spec.trailer ?? []));
    const single = spec.singleRetrieve === true;
    const way = retrieve ?? (single ? resume : undefined);
    return {
      lines: spec.json ? [] : lines,
      data: {
        items,
        count: items.length,
        more: page.more,
        ...(cut > 0 ? { cut } : {}),
        ...(resume === undefined || single ? {} : { resume }),
        ...(way === undefined ? {} : { retrieve: way }),
      },
    };
  };
  const input = newest ? [...rows].reverse() : rows;
  // min 0: when even one record plus the footer would bust the cap, none goes out
  // and the footer says how to read on.
  const page: RecordPage<T> = whole
    ? { shown: [...input], more: 0 }
    : pageRecords(
        input,
        (p) => {
          const r = render(p);
          return spec.json ? bytes(jsonDocument(r.data)) + 1 : linesBytes(r.lines);
        },
        RESULT_BYTES,
        0,
      );
  const out = render(page);
  return {
    lines: out.lines,
    ...(spec.json ? { data: out.data } : {}),
    shown: page.shown.length,
    more: page.more,
  };
}

/** One text record: fixed columns, then a free-text tail; escaped, at most RECORD_CHARS characters (`whole`: escaped, never clipped). */
export function clippedRecord(
  columns: readonly string[],
  free: string,
  whole = false,
): { line: string; cut: number } {
  if (whole) return { line: [...columns, free].map(escapeRecordText).join("\t"), cut: 0 };
  let cut = 0;
  const lean = columns
    .map((c) => {
      const one = clipEscaped(c, COLUMN_CHARS);
      cut += one.cut;
      return one.text;
    })
    .join("\t");
  const room = Math.max(0, RECORD_CHARS - lean.length - 2);
  const tail = clipEscaped(free, room);
  cut += tail.cut;
  return { line: `${lean}\t${tail.text}${tail.cut > 0 ? "…" : ""}`, cut };
}
