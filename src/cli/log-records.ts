// mu — the output boundary of the log reads (`mu log`, `mu log --tail`) and of
// the capped `mu workstream list` pages, which share its pager.
//
// Pure (no I/O, no DB). One op is ONE text record on ONE line (escaped, at most
// RECORD_CHARS characters), or one JSON item keyed by the `ops` column names
// (`key`, `actor`, `entity`, `group_id`, `created_at`; `rendered` is the prose of
// the one formatter). The SDK's `LogRow` and `renderOp`'s input keep their names:
// this adapter maps them at the CLI edge, and raw op rows are never rewritten.
//
// A page is bounded on its FINAL bytes (RESULT_BYTES, envelope included). A cut
// is counted (`more=N` records left out, `cut=N` characters clipped) and names
// its way back BY SEQ, never by filter: `mu log --seq A..B` (exact seqs, every
// record whole, no scope) or, when the omitted ops are too scattered to name,
// `mu log --after S` (a cursor into the whole log). A hint is digits only, so its
// size is bounded however long the filters, groups or workstream names were.

import { parseOpKey, renderOp, renderOpLine } from "../log-render.js";
import type { LogRow } from "../logs.js";
import { clipPlain, clippedRecord, type PageOut, pageOut, shrinkItem } from "./page-records.js";

// ─── log records ───────────────────────────────────────────────────────

/** What an op says, on one line: the formatter's prose, or `kind: payload` for operator prose. */
function whatLine(row: LogRow): string {
  const r = renderOp(row);
  if (r === null) return `${row.kind}: ${row.payload}`;
  return [r.verb, r.subject, r.detail].filter((s) => s !== "").join(" ");
}

/** `log<TAB>seq<TAB>time<TAB>source<TAB>scope<TAB>what`: one escaped line, <= 400 characters. */
export function logRecord(row: LogRow, whole = false): { line: string; cut: number } {
  const time = row.createdAt.replace(/\.\d+Z$/, "Z");
  const scope = parseOpKey(row.workstreamName).workstream ?? "-";
  return clippedRecord(["log", String(row.seq), time, row.source, scope], whatLine(row), whole);
}

/** One op as `--json` and `--tail` print it: the `ops` column names plus the formatter's prose. */
export interface LogItem {
  seq: number;
  /** `ops.key`; '' for a machine-wide entry. */
  key: string;
  /** `ops.actor` ('system' where the op had none). */
  actor: string;
  intent: string | null;
  group_id: string;
  op: string;
  /** `ops.entity` (the `--kind` tag). */
  entity: string;
  payload: string;
  created_at: string;
  /** The one formatter's prose for this op. */
  rendered: string;
  /** Characters clipped from this item's text fields; absent when none. */
  cut?: number;
}

const LIMITS = {
  key: 120,
  actor: 80,
  intent: 80,
  group_id: 64,
  op: 16,
  entity: 80,
  payload: 240,
  created_at: 40,
  rendered: 160,
} as const;

/** The item with every text field clipped to `scale` x its limit (cut counted); scale 0 empties them. */
function buildItem(row: LogRow, scale: number): { item: LogItem; cut: number } {
  let cut = 0;
  const clip = (s: string, limit: number): string => {
    const one = clipPlain(s, Math.floor(limit * scale));
    cut += one.cut;
    return one.text;
  };
  const item: LogItem = {
    seq: row.seq,
    key: clip(row.workstreamName ?? "", LIMITS.key),
    actor: clip(row.source, LIMITS.actor),
    intent: row.intent === null ? null : clip(row.intent, LIMITS.intent),
    group_id: clip(row.group, LIMITS.group_id),
    op: clip(row.op, LIMITS.op),
    entity: clip(row.kind, LIMITS.entity),
    payload: clip(row.payload, LIMITS.payload),
    created_at: clip(row.createdAt, LIMITS.created_at),
    rendered: clip(renderOpLine(row), LIMITS.rendered),
  };
  if (cut > 0) item.cut = cut;
  return { item, cut };
}

/** A JSON item whose own document fits ITEM_BYTES (control and multibyte characters included): EVERY text field shrinks until it does. `whole`: every field as stored. */
export function logItem(row: LogRow, whole = false): { item: LogItem; cut: number } {
  if (whole) {
    return {
      cut: 0,
      item: {
        seq: row.seq,
        key: row.workstreamName ?? "",
        actor: row.source,
        intent: row.intent,
        group_id: row.group,
        op: row.op,
        entity: row.kind,
        payload: row.payload,
        created_at: row.createdAt,
        rendered: renderOpLine(row),
      },
    };
  }
  return shrinkItem((scale) => buildItem(row, scale));
}

/** Most exact runs a hint names; scattered omissions past this fall back to a cursor. */
const MAX_RUNS = 8;

/**
 * The command that reads exactly `seqs`: `mu log --seq a..b,c,...` (no scope, every
 * record whole). `gapEmpty(a, b)` says no visible op lies strictly between a and b,
 * so a..b holds nothing else. Too scattered to name in `MAX_RUNS` runs: the cursor
 * `mu log --after <first - 1>` (a paged read of the whole log from there).
 */
export function seqCommand(
  seqs: readonly number[],
  gapEmpty: (a: number, b: number) => boolean,
  json: boolean,
): string {
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && (n === last[1] + 1 || gapEmpty(last[1], n))) last[1] = n;
    else runs.push([n, n]);
    if (runs.length > MAX_RUNS) break;
  }
  const tail = json ? " --json" : "";
  if (runs.length > MAX_RUNS || runs.length === 0) {
    return `mu log --after ${Math.max(0, (sorted[0] ?? 1) - 1)}${tail}`;
  }
  const spec = runs.map(([a, b]) => (a === b ? String(a) : `${a}..${b}`)).join(",");
  return `mu log --seq ${spec}${tail}`;
}

export interface LogPageOpts {
  json: boolean;
  /** Fill from the newest record (a "latest N" read); else from the oldest (a cursor read). */
  newest: boolean;
  /** Every record whole, no cap, no footer (`--seq`). */
  whole?: boolean;
  /** A cursor read with no filter (`--after`): the resume is `--after <last shown>`. */
  cursor?: boolean;
  /** No visible op lies strictly between these two seqs (lets a hint name a range). */
  gapEmpty(a: number, b: number): boolean;
}

/** A page of log records (oldest first), at most RESULT_BYTES of final output. */
export function logPage(rows: readonly LogRow[], opts: LogPageOpts): PageOut {
  const say = (seqs: readonly number[]): string => seqCommand(seqs, opts.gapEmpty, opts.json);
  return pageOut(rows, {
    json: opts.json,
    newest: opts.newest,
    whole: opts.whole === true,
    text: (r, all) => logRecord(r, all),
    item: (r, all) => logItem(r, all),
    // The ops left out, by seq: a latest-N read omits the older ones, a cursor read the later.
    resume: (shown) => {
      if (opts.cursor === true) {
        const at = shown[shown.length - 1]?.seq ?? (rows[0]?.seq ?? 1) - 1;
        return `mu log --after ${at}${opts.json ? " --json" : ""}`;
      }
      const on = new Set(shown.map((r) => r.seq));
      return say(rows.filter((r) => !on.has(r.seq)).map((r) => r.seq));
    },
    retrieve: (clipped) => say(clipped.map((r) => r.seq)),
  });
}

/** One op as `--tail` and a log write print it: the item, plus the way back to the whole op when it was clipped. */
export function logOut(row: LogRow): LogItem & { retrieve?: string } {
  const { item } = logItem(row);
  return item.cut === undefined ? item : { ...item, retrieve: `mu log --seq ${row.seq} --json` };
}

/** The text receipt of a log write: the one record the log shows, plus `cut=N next=...` when it clipped. */
export function logReceipt(row: LogRow): string[] {
  const one = logRecord(row);
  return one.cut === 0 ? [one.line] : [one.line, `cut=${one.cut} next=mu log --seq ${row.seq}`];
}
