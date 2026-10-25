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
import { shellQuote } from "../../shell-quote.js";
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
  /** Code points dropped from the free-text fields (title, wave, dispatch_host); with `retrieve`, the command that prints them whole. */
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

/** A shell argument for `query`: double-quoted when that is inert, else single-quoted. */
const sqlArg = (query: string): string =>
  /^[^"$`\\!]*$/.test(query) ? `"${query}"` : shellQuote(query);

/** `mu sql --json <query>`: the lossless read (JSON rows, no table clipping, inert encoding). */
export const sqlCommand = (query: string): string => `mu sql --json ${sqlArg(query)}`;

/**
 * The command that prints a task's free-text fields whole: the title, the wave
 * label and the dispatch host (the fields a record clips), plus, for `show`,
 * the last claimer (`actor`). Names are `[a-z0-9_-]`, so the literals need no
 * escaping; the workstream is its real numeric key. `all` reads the whole row.
 * One command for every clipped field, in text and in JSON: `task show` clips
 * the same fields again, so it is never the way back.
 */
export function fieldsCommand(
  row: Pick<TaskRow, "name" | "workstreamName" | "workstreamId">,
  opts: { actor?: boolean; all?: boolean } = {},
): string {
  const cols =
    opts.all === true
      ? "t.*, w.name AS workstream, a.name AS owner"
      : "t.title, t.wave, t.dispatch_host";
  const actor =
    opts.actor === true
      ? `, (SELECT actor FROM ops WHERE entity = 'task' AND key = '${row.workstreamName}/${row.name}' AND intent = 'task.claim' ORDER BY seq DESC LIMIT 1) AS last_claim_actor`
      : "";
  const from =
    opts.all === true
      ? "tasks t JOIN workstreams w ON w.id = t.workstream_id LEFT JOIN agents a ON a.id = t.owner_id"
      : "tasks t";
  return sqlCommand(
    `SELECT ${cols}${actor} FROM ${from} WHERE t.local_id = '${row.name}' AND t.workstream_id = ${row.workstreamId}`,
  );
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
    /** Code points already cut from a field the item does not hold itself (`show`'s last claimer). */
    extraCut?: number;
    /** `retrieve` also reads the last claimer. */
    actor?: boolean;
  } = {},
): TaskOutput {
  const item = taskToOutput(row, opts);
  let cut = opts.extraCut ?? 0;
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
    item.retrieve = opts.retrieve ?? fieldsCommand(row, opts.actor === true ? { actor: true } : {});
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
  /** Extra `key=value` fields (`tree`'s depth, parent and what hangs below): kept even when metadata crowds the title out. */
  extra?: readonly string[];
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

/** Free-text metadata (a wave label, a host) as a record field: escaped, at most 40 characters; `onCut` hears what was dropped. */
function clipField(s: string, onCut: (n: number) => void, chars = 40): string {
  const { text, cut } = clipEscaped(s, chars);
  if (cut === 0) return text;
  onCut(cut);
  return `${text}…`;
}

/**
 * `task<TAB>id<TAB>STATE<TAB>k=v ...<TAB>title`: one line, escaped, <= maxChars.
 * Anything the line clips (the title, a wave label, a host, a claimer) is counted in ONE
 * `cut=N` with `next=<command>` printing those fields whole (`fieldsCommand`).
 */
export function taskRecord(row: TaskRow, opts: RecordOpts = {}): string {
  let fieldCut = 0;
  const clip = (s: string, chars = 40): string =>
    clipField(
      s,
      (n) => {
        fieldCut += n;
      },
      chars,
    );
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
  const max = opts.maxChars ?? RECORD_CHARS;
  const whole = escapeRecordText(row.title);
  const titleLen = codePoints(row.title).length;
  const wholeLen = codePoints(whole).length;
  const titleOk =
    (opts.titleChars === undefined || wholeLen <= opts.titleChars) &&
    (opts.titleBytes === undefined || bytes(whole) <= opts.titleBytes);
  const fits = titleOk && wholeLen + codePoints(head).length + 1 <= max;
  if (fits && fieldCut === 0) return `${head}\t${whole}`;
  const retrieve = opts.retrieve ?? fieldsCommand(row, opts.claimedBy ? { actor: true } : {});
  // The suffix is `\tcut=<N>\tnext=<cmd>`; N has at most as many digits as the clipped text has code points.
  const suffixLen = (extra: number): number =>
    `\tcut=\tnext=${retrieve}`.length + String(titleLen + extra).length;
  if (fits && wholeLen + codePoints(head).length + 1 + suffixLen(fieldCut) <= max) {
    return `${head}\t${whole}\tcut=${fieldCut}\tnext=${retrieve}`;
  }
  const clipped = (h: string, extraCut: number, next: string = retrieve): string => {
    const room =
      max -
      codePoints(h).length -
      1 -
      `\tcut=\tnext=${next}`.length -
      String(titleLen + extraCut).length -
      1;
    const { text, cut } = clipEscaped(
      row.title,
      Math.max(0, Math.min(room, (opts.titleChars ?? room + 1) - 1)),
      opts.titleBytes === undefined ? undefined : opts.titleBytes - 3,
    );
    return `${h}\t${text}…\tcut=${cut + extraCut}\tnext=${next}`;
  };
  const room = max - codePoints(head).length - 1 - suffixLen(fieldCut) - 1;
  if (room >= 8) return clipped(head, fieldCut);
  // Metadata crowds the title out: keep the identity and the score; the free-text fields dropped
  // from the line count into `cut` and the way back reads the whole row.
  const dropped = [
    row.status === "IN_PROGRESS" ? row.ownerName : null,
    opts.withWorkstream === true ? row.workstreamName : null,
    row.wave,
    row.dispatchHost,
    row.status !== "OPEN" && row.ownerName === null ? (opts.claimedBy ?? null) : null,
  ]
    .filter((v): v is string => typeof v === "string")
    .reduce((n, v) => n + codePoints(v).length, 0);
  const leanId = clipEscaped(row.name, 64).text;
  const lean = [
    "task",
    leanId,
    formatPair(row),
    [...kv.slice(0, 2), ...(opts.extra ?? [])].join(" "),
  ].join("\t");
  const out = clipped(
    lean,
    dropped,
    opts.retrieve ?? fieldsCommand(row, { all: true, ...(opts.claimedBy ? { actor: true } : {}) }),
  );
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
