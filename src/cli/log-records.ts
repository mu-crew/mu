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
// its way back: `more` the same read continued, `cut` the lossless `ops` rows
// through `mu db query ... --all` (never clipped).

import { parseOpKey, renderOp, renderOpLine } from "../log-render.js";
import type { LogRow } from "../logs.js";
import { RESULT_BYTES } from "../output-contract.js";
import { clipPlain, clippedRecord, type PageOut, pageOut } from "./page-records.js";
import { jsonDocument } from "./tasks/records.js";

const bytes = (s: string): number => Buffer.byteLength(s);

// ─── log records ───────────────────────────────────────────────────────

/** What an op says, on one line: the formatter's prose, or `kind: payload` for operator prose. */
function whatLine(row: LogRow): string {
  const r = renderOp(row);
  if (r === null) return `${row.kind}: ${row.payload}`;
  return [r.verb, r.subject, r.detail].filter((s) => s !== "").join(" ");
}

/** `log<TAB>seq<TAB>time<TAB>source<TAB>scope<TAB>what`: one escaped line, <= 400 characters. */
export function logRecord(row: LogRow): { line: string; cut: number } {
  const time = row.createdAt.replace(/\.\d+Z$/, "Z");
  const scope = parseOpKey(row.workstreamName).workstream ?? "-";
  return clippedRecord(["log", String(row.seq), time, row.source, scope], whatLine(row));
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

/** One item's own document stays within this, so a page always has room for its metadata. */
const ITEM_BYTES = RESULT_BYTES / 2;
const PAYLOAD_CHARS = 240;
const RENDERED_CHARS = 160;

function buildItem(row: LogRow, payloadChars: number, renderedChars: number): LogItem {
  let cut = 0;
  const clip = (s: string, max: number): string => {
    const one = clipPlain(s, max);
    cut += one.cut;
    return one.text;
  };
  const item: LogItem = {
    seq: row.seq,
    key: clip(row.workstreamName ?? "", 120),
    actor: clip(row.source, 80),
    intent: row.intent === null ? null : clip(row.intent, 80),
    group_id: clip(row.group, 64),
    op: clip(row.op, 16),
    entity: clip(row.kind, 80),
    payload: clip(row.payload, payloadChars),
    created_at: clip(row.createdAt, 40),
    rendered: clip(renderOpLine(row), renderedChars),
  };
  if (cut > 0) item.cut = cut;
  return item;
}

/** A JSON item whose own document fits ITEM_BYTES (multibyte and control characters included): the free-text fields shrink until it does. */
export function logItem(row: LogRow): { item: LogItem; cut: number } {
  let p = PAYLOAD_CHARS;
  let r = RENDERED_CHARS;
  for (;;) {
    const item = buildItem(row, p, r);
    if (bytes(jsonDocument({ items: [item] })) <= ITEM_BYTES || p + r === 0) {
      return { item, cut: item.cut ?? 0 };
    }
    p = Math.floor(p / 2);
    r = Math.floor(r / 2);
  }
}

/** The lossless read of clipped ops: `mu db query` prints a query's rows whole under `--all`. */
export function opsRetrieveCommand(seqs: readonly number[]): string {
  const list = seqs.slice(0, 40).join(",");
  return `mu db query 'SELECT seq, key, payload FROM ops WHERE seq IN (${list}) ORDER BY seq' --all`;
}

export interface LogPageOpts {
  json: boolean;
  /** Fill from the newest record (a "latest N" read); else from the oldest (a cursor read). */
  newest: boolean;
  /** The same read, continued strictly after `seq`, `n` records. */
  resume(seq: number, n: number): string;
}

/** A page of log records (oldest first), at most RESULT_BYTES of final output. */
export function logPage(rows: readonly LogRow[], opts: LogPageOpts): PageOut {
  const first = rows[0]?.seq ?? 0;
  return pageOut(rows, {
    json: opts.json,
    newest: opts.newest,
    text: (r) => logRecord(r),
    item: (r) => logItem(r),
    // A cursor read continues after the last record shown; a latest-N read reaches
    // back to the first `more` records of its window, which the newest ones displaced.
    resume: (shown, more) =>
      opts.newest
        ? opts.resume(first - 1, more)
        : opts.resume(shown[shown.length - 1]?.seq ?? 0, more),
    retrieve: (clipped) => opsRetrieveCommand(clipped.map((r) => r.seq)),
  });
}

/** One op as `--tail` and a log write print it: the item, plus the way back to the whole payload when it was clipped. */
export function logOut(row: LogRow): LogItem & { retrieve?: string } {
  const { item } = logItem(row);
  return item.cut === undefined ? item : { ...item, retrieve: opsRetrieveCommand([row.seq]) };
}
