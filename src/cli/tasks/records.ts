// mu — task read records: the output boundary of list / next / owned-by / show / tree.
//
// Pure (no I/O, no DB). A task becomes ONE record per line, or one JSON item
// whose keys are the SQL column names (`id` is the task's `local_id`; the
// integer primary key never appears; `workstream_id` / `owner_id` are the real
// foreign keys). Every result is bounded on its FINAL bytes (README Interface,
// output caps): a record is at most RECORD_CHARS characters, a result at most
// RESULT_BYTES, and a cut names the exact command that brings the rest back.
//
//   text   task<TAB>id<TAB>STATE<TAB>key=value ...<TAB>title[<TAB>cut=N<TAB>next=<cmd>]
//   footer more=N next=<command>
//
// Everything a terminal or a line tool could misread is escaped: backslash,
// newline, tab and CR as two characters, any other control, C1, bidi,
// line/paragraph-separator character as `\u{hex}`.

import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../../output-contract.js";
import { shellQuote, shellWord } from "../../shell-quote.js";
import { formatPair } from "../../tasks/status.js";
import type { TaskRow } from "../../tasks.js";

/** Most characters of one list record (README: list record <= 400 chars). */
export const RECORD_CHARS = 400;
/** Most characters of a title in a JSON item. */
export const JSON_TITLE_CHARS = 120;
/** Most characters of a wave label or host in a JSON item (clipped ones count into `cut`). */
const JSON_FIELD_CHARS = 80;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\\]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_G = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\\]/gu;

/** Escape so one value is one inert field of one line. */
export function escapeRecordText(s: string): string {
  if (!UNSAFE.test(s)) return s;
  return s.replace(UNSAFE_G, (c) => {
    switch (c) {
      case "\\":
        return "\\\\";
      case "\n":
        return "\\n";
      case "\t":
        return "\\t";
      case "\r":
        return "\\r";
      default:
        return `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`;
    }
  });
}

/**
 * Re-escape the characters JSON.stringify leaves raw but a terminal or line
 * tool treats specially (C1 controls incl. 8-bit CSI, bidi controls, U+2028/9)
 * as `\uXXXX` JSON escapes: still valid, lossless JSON, one inert line.
 */
export function safeJsonLine(json: string): string {
  return json.replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/** The one JSON document line of a success envelope, made inert (see safeJsonLine). */
export function jsonDocument(data: unknown): string {
  return safeJsonLine(encodeEnvelope(okEnvelope(data)));
}

const bytes = (s: string): number => Buffer.byteLength(s);
/** Bytes of `lines` as printed (one newline each). */
export const linesBytes = (lines: readonly string[]): number => bytes(lines.join("\n")) + 1;

/** Code points of `s`. */
export const codePoints = (s: string): string[] => [...s];

/** `s` cut to at most `maxChars` code points AND `maxBytes` ESCAPED bytes; `cut` counts what was dropped. */
export function clipEscaped(
  s: string,
  maxChars: number,
  maxBytes = Number.POSITIVE_INFINITY,
): { text: string; cut: number } {
  const cps = codePoints(s);
  let out = "";
  let used = 0;
  let n = 0;
  for (const cp of cps) {
    const esc = escapeRecordText(cp);
    if (out.length + esc.length > maxChars || used + bytes(esc) > maxBytes) break;
    out += esc;
    used += bytes(esc);
    n++;
  }
  return { text: out, cut: cps.length - n };
}

// ─── JSON items ────────────────────────────────────────────────────────

/** One task as `--json` emits it: SQL column names, real foreign keys. */
export interface TaskOutput {
  /** The task's `local_id` (never the integer primary key). */
  id: string;
  local_id: string;
  /** Real `tasks.workstream_id`. */
  workstream_id: number;
  /** Name of that workstream; present only where the ref is otherwise ambiguous (`show`, cross-workstream views). */
  workstream?: string;
  title: string;
  status: string;
  substate: string;
  impact: number;
  effort_days: number;
  scored: 0 | 1;
  dispatch_host: string | null;
  /** Real `tasks.owner_id` (kept after close: lifecycle attribution). */
  owner_id: number | null;
  /** Owner's name; present ONLY while IN_PROGRESS (a CLOSED task's owner is history). */
  owner?: string;
  created_at: string;
  updated_at: string;
  kind: string;
  wave: string | null;
  /** What `--if <rev>` repeats; present when the verb computed it. */
  revision?: number;
  /** Title code points dropped from `title`; with `retrieve`, the command that prints it whole. */
  cut?: number;
  retrieve?: string;
}

/** Boundary mapper: TaskRow (names + real FKs) → output item. Never aliases name/effortDays. */
export function taskToOutput(
  row: TaskRow,
  opts: { revision?: number; withWorkstream?: boolean } = {},
): TaskOutput {
  const out: TaskOutput = {
    id: row.name,
    local_id: row.name,
    workstream_id: row.workstreamId,
    title: row.title,
    status: row.status,
    substate: row.substate,
    impact: row.impact,
    effort_days: row.effortDays,
    scored: row.scored ? 1 : 0,
    dispatch_host: row.dispatchHost,
    owner_id: row.ownerId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    kind: row.kind,
    wave: row.wave,
  };
  if (opts.withWorkstream === true) out.workstream = row.workstreamName;
  if (row.status === "IN_PROGRESS" && row.ownerName !== null) out.owner = row.ownerName;
  if (opts.revision !== undefined) out.revision = opts.revision;
  return out;
}

/** Title bounds of a `show` (its own 4 KB result has a task, edges and notes to share). */
export const SHOW_TITLE_CHARS = 600;
export const SHOW_TITLE_ESCAPED_BYTES = 800;
export const SHOW_TITLE_JSON_BYTES = 800;

const showCommand = (row: Pick<TaskRow, "name" | "workstreamName">): string =>
  `mu task show ${shellWord(row.name)} -w ${shellWord(row.workstreamName)}`;

/** Does `title` print whole in a `show` (text or JSON)? */
export function titleFitsShow(title: string, json: boolean): boolean {
  return json
    ? bytes(JSON.stringify(title)) <= SHOW_TITLE_JSON_BYTES
    : codePoints(title).length <= SHOW_TITLE_CHARS &&
        bytes(escapeRecordText(title)) <= SHOW_TITLE_ESCAPED_BYTES;
}

/**
 * The command that prints a task's title whole: `task show` when it fits there,
 * else the raw SQL read (the title is the one thing `show` itself must clip).
 */
export function titleCommand(
  row: Pick<TaskRow, "name" | "workstreamName" | "title">,
  json = false,
): string {
  if (titleFitsShow(row.title, json)) return `${showCommand(row)}${json ? " --json" : ""}`;
  const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  // Names are [a-z0-9_-] by validation, so double quotes need no further escaping.
  const query = `SELECT title FROM tasks WHERE local_id = ${lit(row.name)} AND workstream_id = (SELECT id FROM workstreams WHERE name = ${lit(row.workstreamName)})`;
  return /^[\w\s'=(),*-]+$/.test(query) ? `mu sql "${query}"` : `mu sql ${shellQuote(query)}`;
}

/** JSON item with a bounded title; a clipped title carries `cut` and `retrieve`. */
export function taskItem(
  row: TaskRow,
  opts: {
    revision?: number;
    withWorkstream?: boolean;
    titleChars?: number;
    titleJsonBytes?: number;
    retrieve?: string;
  } = {},
): TaskOutput {
  const item = taskToOutput(row, opts);
  let cut = 0;
  const clip = (s: string, max: number): string => {
    const cps = codePoints(s);
    if (cps.length <= max) return s;
    cut += cps.length - (max - 1);
    return `${cps.slice(0, max - 1).join("")}…`;
  };
  item.title = clip(row.title, opts.titleChars ?? JSON_TITLE_CHARS);
  if (opts.titleJsonBytes !== undefined) {
    // Shrink by whole code points until the ENCODED title fits (escapes can be 6x).
    const cps = codePoints(item.title);
    let n = cps.length;
    while (n > 0 && bytes(JSON.stringify(`${cps.slice(0, n).join("")}…`)) > opts.titleJsonBytes)
      n--;
    if (n < cps.length) {
      cut += cps.length - n;
      item.title = `${cps.slice(0, n).join("")}…`;
    }
  }
  if (item.wave !== null) item.wave = clip(item.wave, JSON_FIELD_CHARS);
  if (item.dispatch_host !== null) item.dispatch_host = clip(item.dispatch_host, JSON_FIELD_CHARS);
  if (item.owner !== undefined) item.owner = clip(item.owner, JSON_FIELD_CHARS);
  if (cut > 0) {
    item.cut = cut;
    item.retrieve = opts.retrieve ?? titleCommand(row, true);
  }
  return item;
}

// ─── Text records ──────────────────────────────────────────────────────

export interface RecordOpts {
  /** Name the workstream (cross-workstream views). */
  withWorkstream?: boolean;
  revision?: number;
  /** Show the owner as `by=<name>` when the row has none (an anonymous claim). */
  claimedBy?: string | null;
  /** Add `created=` and `updated=` (the `show` record). */
  times?: boolean;
  /** Add the one timestamp a `--sort recency|age` orders by. */
  basis?: "updatedAt" | "createdAt";
  /** Characters of the whole record (default RECORD_CHARS). */
  maxChars?: number;
  /** Command that prints the title whole; default `titleCommand`. */
  retrieve?: string;
  /** `show`: the title's own bounds (code points, escaped bytes) instead of the record cap. */
  titleChars?: number;
  titleBytes?: number;
}

/** Free-text metadata (a wave label, a host) as a record field: escaped, at most 40 characters. */
function clipField(s: string, chars = 40): string {
  const { text, cut } = clipEscaped(s, chars);
  return cut > 0 ? `${text}…` : text;
}

/** `task<TAB>id<TAB>STATE<TAB>k=v ...<TAB>title`: one line, escaped, <= maxChars. */
export function taskRecord(row: TaskRow, opts: RecordOpts = {}): string {
  const kv: string[] = [`impact=${row.impact}`, `effort_days=${row.effortDays}`];
  if (!row.scored) kv.push("scored=0");
  if (row.status === "IN_PROGRESS" && row.ownerName !== null) {
    kv.push(`owner=${clipField(row.ownerName)}`);
  }
  if (opts.withWorkstream === true) kv.push(`ws=${clipField(row.workstreamName)}`);
  if (row.status !== "OPEN" && row.ownerName === null && opts.claimedBy) {
    kv.push(`self=${clipField(opts.claimedBy)}`);
  }
  if (row.kind !== "work") kv.push(`kind=${row.kind}`);
  if (row.wave !== null) kv.push(`wave=${clipField(row.wave)}`);
  if (row.dispatchHost !== null) kv.push(`host=${clipField(row.dispatchHost)}`);
  if (opts.times === true) kv.push(`created=${row.createdAt}`, `updated=${row.updatedAt}`);
  else if (opts.basis === "updatedAt") kv.push(`updated=${row.updatedAt}`);
  else if (opts.basis === "createdAt") kv.push(`created=${row.createdAt}`);
  if (opts.revision !== undefined) kv.push(`rev=${opts.revision}`);
  const head = ["task", clipField(row.name, 64), formatPair(row), kv.join(" ")].join("\t");
  const max = opts.maxChars ?? RECORD_CHARS;
  const whole = escapeRecordText(row.title);
  const titleOk =
    (opts.titleChars === undefined || codePoints(whole).length <= opts.titleChars) &&
    (opts.titleBytes === undefined || bytes(whole) <= opts.titleBytes);
  if (titleOk && codePoints(whole).length + codePoints(head).length + 1 <= max) {
    return `${head}\t${whole}`;
  }
  const retrieve = opts.retrieve ?? titleCommand(row);
  // The suffix is `\tcut=<N>\tnext=<cmd>`; N has at most as many digits as the title has code points.
  const digits = String(codePoints(row.title).length).length;
  const suffixLen = `\tcut=\tnext=${retrieve}`.length + digits;
  const room = max - codePoints(head).length - 1 - suffixLen - 1;
  const clipped = (h: string, r: number): string => {
    const { text, cut } = clipEscaped(
      row.title,
      Math.max(0, Math.min(r, (opts.titleChars ?? r + 1) - 1)),
      opts.titleBytes === undefined ? undefined : opts.titleBytes - 3,
    );
    return `${h}\t${text}…\tcut=${cut}\tnext=${retrieve}`;
  };
  if (room >= 8) return clipped(head, room);
  // Metadata crowds the title out: keep the identity and the score, the rest is on `show`.
  const lean = ["task", clipField(row.name, 64), formatPair(row), kv.slice(0, 2).join(" ")].join(
    "\t",
  );
  const out = clipped(lean, max - codePoints(lean).length - 1 - suffixLen - 1);
  return codePoints(out).length <= max ? out : codePoints(out).slice(0, max).join("");
}

// ─── Paging ────────────────────────────────────────────────────────────

export interface RecordPage<T> {
  /** The records of this page (always at least one when any remain). */
  shown: T[];
  /** Records after this page. */
  more: number;
  /** The command for the next page; null when nothing remains. */
  next: string | null;
}

/**
 * Take records from `all` starting at 1-based `from`, as many as keep the
 * FINAL emitted bytes (`size(page)`: the caller serializes text lines or the JSON
 * document, footer and metadata included) within `budget`. A page always makes
 * progress: the first record goes out even when it alone is over (records
 * are themselves bounded). `nextFor(k)` names the command that resumes at
 * record `k`.
 */
export function pageRecords<T>(
  all: readonly T[],
  from: number,
  size: (page: RecordPage<T>) => number,
  nextFor: (from: number) => string,
  budget: number = RESULT_BYTES,
): RecordPage<T> {
  const rest = all.slice(Math.max(0, from - 1));
  const build = (k: number): RecordPage<T> => {
    const left = rest.length - k;
    return { shown: rest.slice(0, k), more: left, next: left > 0 ? nextFor(from + k) : null };
  };
  let page = build(Math.min(1, rest.length));
  for (let k = 2; k <= rest.length; k++) {
    const candidate = build(k);
    if (size(candidate) > budget) break;
    page = candidate;
  }
  return page;
}

/** `more=N next=<command>` footer line; null when nothing remains. */
export const moreLine = (page: { more: number; next: string | null }): string | null =>
  page.next === null ? null : `more=${page.more} next=${page.next}`;

/** `--from` as a 1-based record number, or a usage-friendly failure for the caller to throw. */
export function fromOffset(from: number | undefined): number {
  return from === undefined ? 1 : Math.max(1, Math.floor(from));
}

// ─── A page of task records ────────────────────────────────────────────

export interface TaskPageOpts {
  /** 1-based record to start at (`--from`). */
  from: number;
  /** The command that resumes at record `k` (flags preserved). */
  nextFor: (from: number) => string;
  json: boolean;
  withWorkstream?: boolean;
  /** The timestamp the sort orders by, shown on text records. */
  basis?: "updatedAt" | "createdAt" | null;
  /** `local_id` → revision (list). */
  revisions?: ReadonlyMap<string, number>;
  /** Extra single-line records printed after the footer (counted in the cap). */
  trailer?: readonly string[];
  /** Extra keys on the JSON `data` (counted in the cap). */
  extra?: Record<string, unknown>;
}

export interface TaskPageOut {
  /** Text lines to print (no terminal framing); empty when `json`. */
  lines: string[];
  /** The `data` payload; undefined unless `json`. */
  data?: { items: TaskOutput[]; count: number; more: number; retrieve?: string };
  shown: number;
  more: number;
}

/** Page `rows` into at most RESULT_BYTES of final output, in text or JSON. */
export function taskPage(rows: readonly TaskRow[], opts: TaskPageOpts): TaskPageOut {
  const from = opts.from;
  const rev = (r: TaskRow): { revision?: number } => {
    const v = opts.revisions?.get(r.name);
    return v === undefined ? {} : { revision: v };
  };
  const ws = opts.withWorkstream === true;
  const textOf = (page: RecordPage<TaskRow>): string[] => {
    const lines = page.shown.map((r) =>
      taskRecord(r, {
        withWorkstream: ws,
        ...rev(r),
        ...(opts.basis ? { basis: opts.basis } : {}),
      }),
    );
    const foot = moreLine(page);
    if (foot !== null) lines.push(foot);
    lines.push(...(opts.trailer ?? []));
    return lines;
  };
  const dataOf = (page: RecordPage<TaskRow>) => ({
    ...(opts.extra ?? {}),
    items: page.shown.map((r) => taskItem(r, { withWorkstream: ws, ...rev(r) })),
    count: page.shown.length,
    more: page.more,
    ...(page.next === null ? {} : { retrieve: page.next }),
  });
  const page = pageRecords(
    rows,
    from,
    opts.json ? (p) => bytes(jsonDocument(dataOf(p))) + 1 : (p) => linesBytes(textOf(p)),
    opts.nextFor,
  );
  if (opts.json) {
    const data = dataOf(page) as TaskPageOut["data"];
    return {
      lines: [],
      ...(data === undefined ? {} : { data }),
      shown: page.shown.length,
      more: page.more,
    };
  }
  return { lines: textOf(page), shown: page.shown.length, more: page.more };
}
