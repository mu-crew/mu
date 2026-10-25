// mu — the shared pager of the capped text/JSON reads that are not task reads
// (`mu log`, `mu workstream list`).
//
// Pure (no I/O, no DB). A page is bounded on its FINAL bytes (RESULT_BYTES,
// envelope included). A cut is counted (`more=N` records left out, `cut=N`
// characters clipped) and names its way back as a command that exists.

import {
  clipEscaped,
  codePoints,
  jsonDocument,
  linesBytes,
  pageRecords,
  RECORD_CHARS,
  type RecordPage,
} from "./tasks/records.js";

const bytes = (s: string): number => Buffer.byteLength(s);

/** Longest retrieval command echoed back; past it the hint is generic. */
const COMMAND_MAX_BYTES = 1024;
/** A fixed column (source, scope, ...) is clipped to this many characters. */
const COLUMN_CHARS = 64;

/** `cmd`, or `generic` when it would crowd the result cap. */
export function boundedCommand(cmd: string, generic: string): string {
  return bytes(cmd) > COMMAND_MAX_BYTES ? generic : cmd;
}

// ─── the generic pager ─────────────────────────────────────────────────

export interface PageSpec<T> {
  json: boolean;
  /** Every row, whole, no cap and no footer (`--all`). */
  whole?: boolean;
  /** Fill the page from the END of `rows` (the newest), printing it in the original order. */
  newest?: boolean;
  /** One text record; `cut` counts the characters it clipped . */
  text(row: T): { line: string; cut: number };
  /** One JSON item; `cut` counts the characters it clipped . */
  item(row: T): { item: object; cut: number };
  /** The command that reads the `more` records left out. */
  resume(shown: readonly T[], more: number): string;
  /** The command that reads the clipped rows whole; defaults to `resume`. */
  retrieve?(clipped: readonly T[]): string;
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
  const render = (page: RecordPage<T>): { lines: string[]; data: PageData } => {
    const shown = newest ? [...page.shown].reverse() : page.shown;
    let cut = 0;
    const clipped: T[] = [];
    const lines: string[] = [];
    const items: object[] = [];
    for (const r of shown) {
      if (spec.json) {
        const one = spec.item(r);
        if (one.cut > 0) clipped.push(r);
        cut += one.cut;
        items.push(one.item);
      } else {
        const one = spec.text(r);
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
    return {
      lines: spec.json ? [] : lines,
      data: {
        items,
        count: items.length,
        more: page.more,
        ...(cut > 0 ? { cut } : {}),
        ...(resume === undefined ? {} : { resume }),
        ...(retrieve === undefined ? {} : { retrieve }),
      },
    };
  };
  const input = newest ? [...rows].reverse() : rows;
  const page: RecordPage<T> =
    spec.whole === true
      ? { shown: [...input], more: 0 }
      : pageRecords(input, (p) => {
          const r = render(p);
          return spec.json ? bytes(jsonDocument(r.data)) + 1 : linesBytes(r.lines);
        });
  const out = render(page);
  return {
    lines: out.lines,
    ...(spec.json ? { data: out.data } : {}),
    shown: page.shown.length,
    more: page.more,
  };
}

/** `s` clipped to `max` code points; `cut` counts the code points dropped. */
export function clipPlain(s: string, max: number): { text: string; cut: number } {
  const cps = codePoints(s);
  if (cps.length <= max) return { text: s, cut: 0 };
  return { text: cps.slice(0, max).join(""), cut: cps.length - max };
}

/** One text record: fixed columns, then a free-text tail; escaped, at most RECORD_CHARS characters. */
export function clippedRecord(
  columns: readonly string[],
  free: string,
): { line: string; cut: number } {
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
