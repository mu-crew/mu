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
import { shellQuote, shellWord } from "../shell-quote.js";
import { clipPlain, clippedRecord, type PageOut, pageOut, shrinkItem } from "./page-records.js";

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

/** A JSON item whose own document fits ITEM_BYTES (control and multibyte characters included): EVERY text field shrinks until it does. */
export function logItem(row: LogRow): { item: LogItem; cut: number } {
  return shrinkItem((scale) => buildItem(row, scale));
}

/** Columns a recovery returns: every one an item clips, whole. */
const OPS_COLUMNS = "seq, key, actor, intent, group_id, op, entity, payload, created_at";

/**
 * The lossless read of ops: `mu db query` prints a query's rows whole under
 * `--all`, every column an item clips. `-w` names the scope of the read that
 * clipped them (it must exist for `db query` to run; none for `--all` reads).
 */
export function opsRetrieveCommand(seqs: readonly number[], workstream?: string): string {
  const ws = workstream === undefined ? [] : ["-w", shellWord(workstream)];
  const where = seqs.length <= RANGE_AFTER ? `seq IN (${seqs.join(",")})` : seqRange(seqs);
  return [
    "mu db query",
    shellQuote(`SELECT ${OPS_COLUMNS} FROM ops WHERE ${where} ORDER BY seq`),
    ...ws,
    "--all",
  ].join(" ");
}

/** Past this many exact seqs the recovery names the covering range (a superset of the ops wanted). */
const RANGE_AFTER = 60;
const seqRange = (seqs: readonly number[]): string =>
  `seq BETWEEN ${Math.min(...seqs)} AND ${Math.max(...seqs)}`;

export interface LogPageOpts {
  json: boolean;
  /** Fill from the newest record (a "latest N" read); else from the oldest (a cursor read). */
  newest: boolean;
  /** The same read, continued strictly after `seq`, `n` records; null when it cannot be said as one short command. */
  resume(seq: number, n: number): string | null;
  /** The scope of the read (for the recovery command). */
  workstream?: string | undefined;
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
    // A filter too long to repeat falls back to the exact ops left out: still lossless and runnable.
    resume: (shown, more) => {
      const said = opts.newest
        ? opts.resume(first - 1, more)
        : opts.resume(shown[shown.length - 1]?.seq ?? 0, more);
      if (said !== null) return said;
      const on = new Set(shown.map((r) => r.seq));
      return opsRetrieveCommand(
        rows.filter((r) => !on.has(r.seq)).map((r) => r.seq),
        opts.workstream,
      );
    },
    retrieve: (clipped) =>
      opsRetrieveCommand(
        clipped.map((r) => r.seq),
        opts.workstream,
      ),
  });
}

/** One op as `--tail` and a log write print it: the item, plus the way back to the whole op when it was clipped. */
export function logOut(row: LogRow, workstream?: string): LogItem & { retrieve?: string } {
  const { item } = logItem(row);
  return item.cut === undefined
    ? item
    : { ...item, retrieve: opsRetrieveCommand([row.seq], workstream) };
}
