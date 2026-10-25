// mu — task read records: the output boundary of list / next / owned-by / show / tree.
//
// Pure (no I/O, no DB). A task becomes ONE record per line, or one JSON item
// whose keys are the SQL column names (`id` is the task's `local_id`; the
// integer primary key never appears; `workstream_id` / `owner_id` are the real
// foreign keys). Every result is bounded on its FINAL bytes (README Interface,
// output caps): a record is at most RECORD_CHARS characters, a result at most
// RESULT_BYTES, and a cut names the way back. There is ONE way back that always
// works: the same read with `--all` (uncapped), and for a clipped field of one
// task `mu task show <id> -w <ws> --all`. Neither is ever clipped itself.
//
//   text   task<TAB>id<TAB>STATE<TAB>key=value ...<TAB>title[<TAB>cut=N<TAB>next=<cmd>]
//   footer more=N next=<command>
//
// Everything a terminal or a line tool could misread is escaped: backslash,
// newline, tab and CR as two characters, any other control, C1, bidi,
// line/paragraph-separator character as `\u{hex}`.

import { encodeEnvelope, okEnvelope, RESULT_BYTES } from "../../output-contract.js";
import { shellWord } from "../../shell-quote.js";
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

/** The one JSON document line of a success envelope: the encoder every `--json` read emits through, so a size measured here is the size printed. */
export function jsonDocument(data: unknown): string {
  return encodeEnvelope(okEnvelope(data));
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

/** Title bound of a `show` (its own 4 KB result has a task, edges and notes to share; `show` shrinks it to fit). */
export const SHOW_TITLE_CHARS = 600;

/** The way back from any clipped field of one task: `show --all` prints the task whole. */
export const showAllCommand = (row: Pick<TaskRow, "name" | "workstreamName">): string =>
  `mu task show ${shellWord(row.name)} -w ${shellWord(row.workstreamName)} --all`;

/** What a task read says when it cut something: `more=N` records left out, `cut=N` characters clipped, and the one command that prints it all. */
export interface Cuts {
  more: number;
  cut: number;
}

/** `more=N cut=N next=<command>` footer line; null when nothing was cut. `next` is the reserved tail: never sliced. */
export function footerLine(c: Cuts, next: string): string | null {
  if (c.more <= 0 && c.cut <= 0) return null;
  const parts = [c.more > 0 ? `more=${c.more}` : "", c.cut > 0 ? `cut=${c.cut}` : ""];
  return `${parts.filter(Boolean).join(" ")} next=${next}`;
}

/** JSON item with bounded free-text fields; `cut` counts the code points clipped. `whole` clips nothing. */
export function taskItemCut(
  row: TaskRow,
  opts: {
    revision?: number;
    withWorkstream?: boolean;
    titleChars?: number;
    whole?: boolean;
    /** Code points already cut from a field the item does not hold itself (`show`'s last claimer). */
    extraCut?: number;
  } = {},
): { item: TaskOutput; cut: number } {
  const item = taskToOutput(row, opts);
  if (opts.whole === true) return { item, cut: 0 };
  let cut = opts.extraCut ?? 0;
  const clip = (s: string, max: number): string => {
    const cps = codePoints(s);
    if (cps.length <= max) return s;
    cut += cps.length - Math.max(0, max - 1);
    return max <= 0 ? "" : `${cps.slice(0, max - 1).join("")}…`;
  };
  item.title = clip(row.title, opts.titleChars ?? JSON_TITLE_CHARS);
  if (item.wave !== null) item.wave = clip(item.wave, JSON_FIELD_CHARS);
  if (item.dispatch_host !== null) item.dispatch_host = clip(item.dispatch_host, JSON_FIELD_CHARS);
  if (item.owner !== undefined) item.owner = clip(item.owner, JSON_FIELD_CHARS);
  return { item, cut };
}

/** `taskItemCut` for a single task (`show`, `tree`). */
export const taskItem = (row: TaskRow, opts: Parameters<typeof taskItemCut>[1] = {}): TaskOutput =>
  taskItemCut(row, opts).item;

// ─── Text records ──────────────────────────────────────────────────────

export interface RecordOpts {
  /** Name the workstream (cross-workstream views). */
  withWorkstream?: boolean;
  revision?: number;
  /** Show the owner as `by=<name>` when the row has none (an anonymous claim). */
  claimedBy?: string | null;
  /** Add `created=` and `updated=` (the `show` record). */
  times?: boolean;
  /** Extra `key=value` fields (`tree`'s depth, parent and what hangs below): kept even when metadata crowds the title out. */
  extra?: readonly string[];
  /** Add the one timestamp a `--sort recency|age` orders by. */
  basis?: "updatedAt" | "createdAt";
  /** Characters of the whole record (default RECORD_CHARS). */
  maxChars?: number;
  /** `show`: the title's own bound in code points (the record cap still applies). */
  titleChars?: number;
  /** Clip nothing (`--all`): only escape. */
  whole?: boolean;
}

/**
 * `task<TAB>id<TAB>STATE<TAB>k=v ...<TAB>title`: one line, escaped, <= maxChars
 * (never sliced: a clipped title ends in `…`, a field that does not fit is
 * dropped). `cut` counts the code points left out of the line; the caller's
 * footer carries the one way back (`--all` prints every record whole).
 */
export function taskRecordCut(row: TaskRow, opts: RecordOpts = {}): { line: string; cut: number } {
  const whole = opts.whole === true;
  let fieldCut = 0;
  const clip = (s: string, chars = 40): string => {
    if (whole) return escapeRecordText(s);
    const { text, cut } = clipEscaped(s, chars);
    if (cut === 0) return text;
    fieldCut += cut;
    return `${text}…`;
  };
  const kv: string[] = [`impact=${row.impact}`, `effort_days=${row.effortDays}`];
  if (!row.scored) kv.push("scored=0");
  if (row.status === "IN_PROGRESS" && row.ownerName !== null)
    kv.push(`owner=${clip(row.ownerName)}`);
  if (opts.withWorkstream === true) kv.push(`ws=${clip(row.workstreamName)}`);
  if (row.status !== "OPEN" && row.ownerName === null && opts.claimedBy) {
    kv.push(`self=${clip(opts.claimedBy)}`);
  }
  if (row.kind !== "work") kv.push(`kind=${row.kind}`);
  if (row.wave !== null) kv.push(`wave=${clip(row.wave)}`);
  if (row.dispatchHost !== null) kv.push(`host=${clip(row.dispatchHost)}`);
  if (opts.times === true) kv.push(`created=${row.createdAt}`, `updated=${row.updatedAt}`);
  else if (opts.basis === "updatedAt") kv.push(`updated=${row.updatedAt}`);
  else if (opts.basis === "createdAt") kv.push(`created=${row.createdAt}`);
  if (opts.revision !== undefined) kv.push(`rev=${opts.revision}`);
  kv.push(...(opts.extra ?? []));
  const id = clip(row.name, 64);
  const head = ["task", id, formatPair(row), kv.join(" ")].join("\t");
  const wholeTitle = escapeRecordText(row.title);
  if (whole) return { line: `${head}\t${wholeTitle}`, cut: 0 };
  const max = opts.maxChars ?? RECORD_CHARS;
  const bound = opts.titleChars ?? Number.POSITIVE_INFINITY;
  const place = (h: string, extraCut: number): { line: string; cut: number } | undefined => {
    const roomMax = max - codePoints(h).length - 1;
    if (roomMax < 9) return undefined;
    const room = Math.min(roomMax, bound);
    if (codePoints(wholeTitle).length <= room)
      return { line: `${h}\t${wholeTitle}`, cut: extraCut };
    const { text, cut } = clipEscaped(row.title, Math.max(0, room - 1));
    return { line: `${h}\t${text}…`, cut: cut + extraCut };
  };
  const first = place(head, fieldCut);
  if (first !== undefined) return first;
  // Metadata crowds the title out: keep the identity and the score; the free-text fields
  // dropped from the line count into `cut` (`--all` prints them).
  const dropped = [
    row.status === "IN_PROGRESS" ? row.ownerName : null,
    opts.withWorkstream === true ? row.workstreamName : null,
    row.wave,
    row.dispatchHost,
    row.status !== "OPEN" && row.ownerName === null ? (opts.claimedBy ?? null) : null,
  ]
    .filter((v): v is string => typeof v === "string")
    .reduce((n, v) => n + codePoints(v).length, 0);
  const lean = [
    "task",
    id,
    formatPair(row),
    [...kv.slice(0, 2), ...(opts.extra ?? [])].join(" "),
  ].join("\t");
  const room = Math.min(Math.max(0, max - codePoints(lean).length - 2), Math.max(0, bound - 1));
  const { text, cut } = clipEscaped(row.title, room);
  return { line: `${lean}\t${text}…`, cut: cut + dropped };
}

export const taskRecord = (row: TaskRow, opts: RecordOpts = {}): string =>
  taskRecordCut(row, opts).line;

// ─── Paging ────────────────────────────────────────────────────────────

export interface RecordPage<T> {
  /** The records of this page (always at least one when any exist). */
  shown: T[];
  /** Records left out. */
  more: number;
}

/**
 * Take records from `all`, in order, as many as keep the FINAL emitted bytes
 * (`size(page)`: the caller serializes text lines or the JSON document, footer
 * and metadata included) within `budget`. The first record always goes out
 * (records are themselves bounded), so a page makes progress.
 */
export function pageRecords<T>(
  all: readonly T[],
  size: (page: RecordPage<T>) => number,
  budget: number = RESULT_BYTES,
  /** Records that go out even when over budget (default 1: progress). */
  min = 1,
): RecordPage<T> {
  const build = (k: number): RecordPage<T> => ({ shown: all.slice(0, k), more: all.length - k });
  let page = build(Math.min(min, all.length));
  for (let k = min + 1; k <= all.length; k++) {
    const candidate = build(k);
    if (size(candidate) > budget) break;
    page = candidate;
  }
  return page;
}

// ─── A page of task records ────────────────────────────────────────────

export interface TaskPageOpts {
  /** `--all`: every record, whole, no cap. */
  all: boolean;
  /** The footer's `next=`: the same read, uncapped (`--all`; `--full` where `--all` is taken). */
  next: string;
  json: boolean;
  withWorkstream?: boolean;
  /** The timestamp the sort orders by, shown on text records. */
  basis?: "updatedAt" | "createdAt" | null;
  /** `local_id` → revision (list). */
  revisions?: ReadonlyMap<string, number>;
  /** Extra single-line records printed after the footer (counted in the cap). */
  trailer?: readonly string[];
}

export interface TaskPageOut {
  /** Text lines to print (no terminal framing); empty when `json`. */
  lines: string[];
  /** The `data` payload; undefined unless `json`. */
  data?: { items: TaskOutput[]; count: number; more: number; cut?: number; retrieve?: string };
  shown: number;
  more: number;
}

/** Page `rows` into at most RESULT_BYTES of final output, in text or JSON; `--all` prints every row whole. */
export function taskPage(rows: readonly TaskRow[], opts: TaskPageOpts): TaskPageOut {
  const ws = opts.withWorkstream === true;
  const whole = opts.all;
  const render = (
    page: RecordPage<TaskRow>,
  ): { lines: string[]; data: NonNullable<TaskPageOut["data"]> } => {
    let cut = 0;
    const lines: string[] = [];
    const items: TaskOutput[] = [];
    for (const r of page.shown) {
      const revision = opts.revisions?.get(r.name);
      const rev = revision === undefined ? {} : { revision };
      if (opts.json) {
        const one = taskItemCut(r, { withWorkstream: ws, whole, ...rev });
        cut += one.cut;
        items.push(one.item);
      } else {
        const one = taskRecordCut(r, {
          withWorkstream: ws,
          whole,
          ...rev,
          ...(opts.basis ? { basis: opts.basis } : {}),
        });
        cut += one.cut;
        lines.push(one.line);
      }
    }
    const foot = footerLine({ more: page.more, cut }, opts.next);
    if (foot !== null) lines.push(foot);
    lines.push(...(opts.trailer ?? []));
    return {
      lines: opts.json ? [] : lines,
      data: {
        items,
        count: items.length,
        more: page.more,
        ...(cut > 0 ? { cut } : {}),
        ...(foot === null ? {} : { retrieve: opts.next }),
      },
    };
  };
  const page: RecordPage<TaskRow> = whole
    ? { shown: [...rows], more: 0 }
    : pageRecords(rows, (p) => {
        const r = render(p);
        return opts.json ? bytes(jsonDocument(r.data)) + 1 : linesBytes(r.lines);
      });
  const out = render(page);
  return {
    lines: out.lines,
    ...(opts.json ? { data: out.data } : {}),
    shown: page.shown.length,
    more: page.more,
  };
}
