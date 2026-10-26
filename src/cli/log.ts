// mu — `mu log` verb (write + read + tail).
//
// One verb, three modes:
//   mu log "text"            → write
//   mu log                    → read latest 50
//   mu log --tail             → blocking subscription (poll every 1s)
//   mu log --since <seq>      → cursor read (everything after seq)
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import {
  emitJson,
  emitJsonRow,
  injectedIdentity,
  injectedWorkstream,
  missingWorkstreamError,
  resolveWorkstream,
  UsageError,
} from "../cli.js";
import type { Db } from "../db.js";
import {
  anyVisibleBetween,
  appendLog,
  GroupNotFoundError,
  groupIdFromPrefix,
  type ListLogsOptions,
  type LogRow,
  latestSeq,
  listLogs,
} from "../logs.js";
import { pc } from "../output.js";
import { logOut, logPage, logReceipt } from "./log-records.js";

export interface LogReadOpts {
  workstream?: string;
  allWorkstreams?: boolean;
  since?: number;
  /** Cursor read of the whole log, strictly after this seq (no scope, no filter). */
  after?: number;
  /** Exact seqs, `A..B,C`: each record whole (no scope, no filter). */
  seq?: string;
  lines?: number;
  source?: string;
  /** Operator channel tag (`ops.entity`). See the log-ledger pattern. */
  kind?: string;
  /** Structured intent filter (`ops.intent`), e.g. 'task.close'. */
  intent?: string;
  /** Op-group filter (`ops.group_id`). */
  group?: string;
  json?: boolean;
  tail?: boolean;
}

export interface LogWriteOpts {
  workstream?: string;
  as?: string;
  kind?: string;
  json?: boolean;
}

/**
 * The `mu log` verb is overloaded: with a positional <text>, write
 * an entry; without, read the log (optionally tailing).
 */
export async function cmdLog(
  db: Db,
  text: string | undefined,
  opts: LogReadOpts & LogWriteOpts,
): Promise<void> {
  if (text !== undefined && text.length > 0) {
    refuseWriteWithReadFlags(text, opts);
    await cmdLogWrite(db, text, opts);
    return;
  }
  await cmdLogRead(db, opts);
}

/**
 * A write never carries a read flag. `--tail`/`--all` are booleans, so a guessed
 * `mu log --tail 20` parses 20 as the text to log: a read that writes. Refuse it
 * (nothing is written); a write is the text with no read flag.
 */
function refuseWriteWithReadFlags(text: string, opts: LogReadOpts): void {
  const flag = [
    opts.tail === true && "--tail",
    opts.allWorkstreams === true && "--all",
    opts.since !== undefined && "--since",
    opts.after !== undefined && "--after",
    opts.seq !== undefined && "--seq",
    opts.lines !== undefined && "-n",
    opts.source !== undefined && "--source",
    opts.intent !== undefined && "--intent",
    opts.group !== undefined && "--group",
  ].find((x) => x !== false);
  if (flag === undefined) return;
  const hint = /^\d+$/.test(text) ? `did you mean -n ${text}? ` : "";
  throw new UsageError(
    `${flag} reads the log but ${JSON.stringify(text)} would be written to it; ${hint}to log the text, drop ${flag}`,
    { showHelp: false },
  );
}

/**
 * Resolve who/where this log entry belongs to:
 *   --as <name>      explicit source; scope still comes from -w / identity
 *   injected worker  source = $MU_AGENT_NAME, workstream = $MU_WORKSTREAM
 *                    (spawn-injected; $TMUX_PANE is never consulted)
 *   else             source = 'user'; scope is -w, or the missing-scope error
 * An explicit `-w` always wins the workstream.
 */
async function resolveLogContext(opts: {
  as?: string;
  workstream?: string;
}): Promise<{ source: string; workstream: string }> {
  const identity = injectedIdentity();
  const workstream = await resolveWorkstream(opts.workstream);
  return { source: opts.as ?? identity?.name ?? "user", workstream };
}

async function cmdLogWrite(db: Db, text: string, opts: LogWriteOpts): Promise<void> {
  const ctx = await resolveLogContext(opts);
  const row = appendLog(db, {
    workstream: ctx.workstream,
    source: ctx.source,
    kind: opts.kind ?? "message",
    payload: text,
  });
  if (opts.json) {
    emitJson(logOut(row));
    return;
  }
  // The receipt is the record the log will show for this op: escaped, clipped, counted.
  for (const line of logReceipt(row)) console.log(line);
}

/** `1..5,9` → [[1,5],[9,9]]; anything else is a usage error. */
export function parseSeqSpec(spec: string): [number, number][] {
  const runs: [number, number][] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d{1,15})(?:\.\.(\d{1,15}))?$/.exec(part);
    const a = m?.[1] === undefined ? Number.NaN : Number(m[1]);
    const b = m?.[2] === undefined ? a : Number(m[2]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > b) {
      throw new UsageError(`--seq expects seqs like 7 or 5..9,12, got ${JSON.stringify(spec)}`, {
        showHelp: false,
      });
    }
    runs.push([a, b]);
  }
  return runs;
}

/** `--seq` and `--after` read the log by position: no scope, no filter, nothing inherited. */
function refuseScopeAndFilters(opts: LogReadOpts, flag: string, allowLines: boolean): void {
  const other = [
    opts.workstream !== undefined && "-w",
    opts.allWorkstreams === true && "--all",
    opts.kind !== undefined && "--kind",
    opts.source !== undefined && "--source",
    opts.intent !== undefined && "--intent",
    opts.group !== undefined && "--group",
    opts.since !== undefined && "--since",
    opts.tail === true && "--tail",
    opts.seq !== undefined && flag !== "--seq" && "--seq",
    opts.after !== undefined && flag !== "--after" && "--after",
    !allowLines && opts.lines !== undefined && "-n",
  ].find((x) => x !== false);
  if (other !== undefined) {
    throw new UsageError(`${flag} reads by seq: it cannot be combined with ${other}`, {
      showHelp: false,
    });
  }
}

const gapEmptyIn =
  (db: Db) =>
  (a: number, b: number): boolean =>
    !anyVisibleBetween(db, a + 1, b - 1);

function printPage(page: ReturnType<typeof logPage>): void {
  if (page.data !== undefined) {
    emitJson(page.data);
    return;
  }
  for (const line of page.lines) console.log(line);
}

/** `mu log --seq A..B,C`: exactly those ops (no scope, no filter), each whole. */
function cmdLogSeq(db: Db, opts: LogReadOpts): void {
  refuseScopeAndFilters(opts, "--seq", false);
  const rows = new Map<number, LogRow>();
  for (const [a, b] of parseSeqSpec(opts.seq ?? "")) {
    for (const row of listLogs(db, { since: a - 1, upTo: b })) rows.set(row.seq, row);
  }
  const sorted = [...rows.values()].sort((x, y) => x.seq - y.seq);
  const json = opts.json === true;
  if (sorted.length === 0 && !json) {
    console.log(pc.dim("(no log entries)"));
    return;
  }
  printPage(logPage(sorted, { json, newest: false, whole: true, gapEmpty: gapEmptyIn(db) }));
}

/** `mu log --after S`: the whole log after S (no scope, no filter), oldest first, paged. */
function cmdLogAfter(db: Db, opts: LogReadOpts): void {
  refuseScopeAndFilters(opts, "--after", true);
  const listOpts: ListLogsOptions = { since: opts.after ?? 0 };
  if (opts.lines !== undefined) listOpts.limit = opts.lines;
  const rows = listLogs(db, listOpts);
  const json = opts.json === true;
  if (rows.length === 0 && !json) {
    console.log(pc.dim("(no log entries)"));
    return;
  }
  printPage(logPage(rows, { json, newest: false, cursor: true, gapEmpty: gapEmptyIn(db) }));
}

async function cmdLogRead(db: Db, opts: LogReadOpts): Promise<void> {
  if (opts.seq !== undefined) return cmdLogSeq(db, opts);
  if (opts.after !== undefined) return cmdLogAfter(db, opts);
  const workstream = await logReadWorkstream(opts);
  const listOpts: ListLogsOptions = {};
  if (workstream !== undefined) listOpts.workstream = workstream;
  if (opts.source !== undefined) listOpts.source = opts.source;
  if (opts.kind !== undefined) listOpts.kind = opts.kind;
  if (opts.intent !== undefined) listOpts.intent = opts.intent;
  if (opts.group !== undefined) {
    // Accept an abbreviated group id (the 8-char form `mu log` prints). A
    // prefix that matches no group is an error rather than an empty
    // listing, since "no entries" reads as "this group did nothing".
    const resolved = groupIdFromPrefix(db, opts.group);
    if (resolved === null) throw new GroupNotFoundError(opts.group);
    listOpts.group = resolved;
  }

  if (opts.tail) {
    await cmdLogTail(db, listOpts, opts);
    return;
  }

  if (opts.since !== undefined) listOpts.since = opts.since;
  if (opts.lines !== undefined) listOpts.limit = opts.lines;
  // Default cap: latest 50 entries when no `since` and no `--lines`.
  if (opts.since === undefined && opts.lines === undefined) listOpts.limit = 50;

  const rows = listLogs(db, listOpts);
  // One record per VISIBLE op: listLogs hides the parent-row touch an
  // add-note or add-edge writes (same op group, only `updated_at`), which
  // would print as a second line for one action. Those stay in `ops`.
  const json = opts.json === true;
  if (rows.length === 0 && !json) {
    console.log(pc.dim("(no log entries)"));
    return;
  }
  printPage(
    logPage(rows, { json, newest: listOpts.since === undefined, gapEmpty: gapEmptyIn(db) }),
  );
}

/**
 * Resolve the workstream filter for log reads:
 *   --all            → undefined (every workstream + machine-wide)
 *   -w X             → X
 *   injected worker  → its own workstream
 *   none             → the one-line missing-scope error (never a global read)
 */
async function logReadWorkstream(opts: LogReadOpts): Promise<string | undefined> {
  if (opts.allWorkstreams) {
    if (opts.workstream !== undefined) {
      throw new UsageError("--all and -w/--workstream are mutually exclusive", {
        showHelp: false,
      });
    }
    return undefined;
  }
  if (opts.workstream === undefined && injectedWorkstream() === undefined) {
    throw await missingWorkstreamError({ orAll: true });
  }
  return resolveWorkstream(opts.workstream);
}

/** A tail whose output failed. `cursor` is the seq of the last row that went out: `--since` it to lose none. */
export class TailStopped extends Error {
  constructor(
    readonly cursor: number,
    cause: unknown,
  ) {
    super(
      `log tail stopped after seq ${cursor}: output failed; resume with --tail --since ${cursor}`,
      {
        cause,
      },
    );
  }
}

/** How a tail waits between polls; a test replaces it to drive the loop without sleeping. */
export type TailSleep = (ms: number, signal: AbortSignal) => Promise<void>;

const realSleep: TailSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

/**
 * `--tail` is a stream, never a document: ALWAYS NDJSON, one `LogItem` per
 * line (no envelope, no header, nothing else on stdout), each line bounded
 * like a `--json` item with a `retrieve` command when it clipped something.
 * The cursor moves only AFTER a line is written, so an interrupt between two
 * rows loses none: a batch is written whole (stdout writes to a pipe or file
 * are synchronous on POSIX) before the signal is looked at, and the loop
 * RETURNS rather than calling process.exit, so Node drains stdout before the
 * process ends. SIGINT ends it with 130, SIGTERM with 143.
 */
export async function cmdLogTail(
  db: Db,
  baseOpts: ListLogsOptions,
  cliOpts: LogReadOpts,
  hooks: {
    signal?: AbortSignal;
    sleep?: TailSleep;
    /** Where a row goes (default: one NDJSON line on stdout); a test makes it fail or lag. */
    emit?: (row: object) => void;
    /** How a poll reads (default `listLogs`); a test records the `since` cursor each poll is given. */
    poll?: (opts: ListLogsOptions) => LogRow[];
  } = {},
): Promise<void> {
  // If --since wasn't given, start at "now" so the subscriber only sees
  // NEW entries. Pass `--since 0` to replay from the beginning.
  let cursor = cliOpts.since ?? latestSeq(db);
  const emit = hooks.emit ?? emitJsonRow;
  const poll = hooks.poll ?? ((o: ListLogsOptions) => listLogs(db, o));
  const control = new AbortController();
  const signal = hooks.signal ?? control.signal;
  const sleep = hooks.sleep ?? realSleep;
  const onInt = (): void => {
    process.exitCode = 130;
    control.abort();
  };
  const onTerm = (): void => {
    process.exitCode = 143;
    control.abort();
  };
  if (hooks.signal === undefined) {
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
  }
  const intervalMs = defaultLogTailIntervalMs();
  try {
    while (!signal.aborted) {
      for (const row of poll({ ...baseOpts, since: cursor })) {
        try {
          emit(logOut(row));
        } catch (err) {
          throw new TailStopped(cursor, err);
        }
        cursor = row.seq;
      }
      await sleep(intervalMs, signal);
    }
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

/** Tail interval default + safety floor. Mirrors defaultSpawnLivenessMs
 *  (src/agents.ts). Naive
 *  `Number(env)` was a DOS-by-typo: an env value of '' parses as 0
 *  and any non-numeric value as NaN, both of which Node's setTimeout
 *  treats as 1ms — hammering SQLite at ~500 Hz on the next mu log
 *  --tail. Unparseable env → fall back to the no-env default of 1000ms;
 *  parseable but too-low → clamp up to the 50ms floor (so a deliberate
 *  `MU_LOG_TAIL_INTERVAL_MS=10` becomes 50, not 1000). */
const LOG_TAIL_INTERVAL_FLOOR_MS = 50;
const LOG_TAIL_INTERVAL_DEFAULT_MS = 1000;
function defaultLogTailIntervalMs(): number {
  const raw = process.env.MU_LOG_TAIL_INTERVAL_MS;
  if (raw === undefined) return LOG_TAIL_INTERVAL_DEFAULT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return LOG_TAIL_INTERVAL_DEFAULT_MS;
  return Math.max(LOG_TAIL_INTERVAL_FLOOR_MS, parsed);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireLogCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { handle, JSON_OPT, parseLines, parseNonNegativeInt, WORKSTREAM_OPT } from "../cli.js";

export function wireLogCommand(program: Command): void {
  // mu log — overloaded:
  //   mu log "text"            → write
  //   mu log                    → read latest 50
  //   mu log --tail             → blocking subscription (poll every 1s)
  //   mu log --since <seq>      → cursor read (everything after seq)
  program
    .command("log [text]")
    .description(
      "Write a log entry (with text) or read the log (without). --tail blocks and prints new entries as they land.",
    )
    .option("--as <name>", "override the source name (default: $MU_AGENT_NAME, else 'user')")
    .option(
      "--kind <kind>",
      "operator-chosen channel tag: sets it on write, filters to it on read (log-ledger pattern); workstream, task, edge and note are reserved",
    )
    .option(
      "--intent <intent>",
      "filter reads to one structured intent, e.g. task.close (see `mu log` output)",
    )
    .option("--group <id>", "filter reads to one op group (every op of a single action)")
    .option(
      "--tail",
      "block and print entries as they're appended: always NDJSON, one object per line (no envelope); ctrl-c exits 130",
    )
    .option(
      "--since <seq>",
      "return entries with seq strictly greater than this (use 0 to replay everything)",
      parseNonNegativeInt,
    )
    .option(
      "--after <seq>",
      "read the whole log strictly after this seq (no scope, no filter; what a cut's `next=` names)",
      parseNonNegativeInt,
    )
    .option(
      "--seq <spec>",
      "read exactly these seqs, each record whole: 7 or 5..9,12 (no scope, no filter, nothing inherited)",
    )
    .option(
      "-n, --lines <n>",
      "cap to N entries: the latest N (default 50), or with --since the first N after the cursor (no default cap)",
      parseLines,
    )
    .option("--source <name>", "filter by source")
    .option("--all", "read across every workstream (and machine-wide entries)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (text: string | undefined) {
      const raw = (this as Command).opts() as {
        as?: string;
        kind?: string;
        intent?: string;
        group?: string;
        tail?: boolean;
        since?: number;
        after?: number;
        seq?: string;
        lines?: number;
        source?: string;
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      const opts: LogReadOpts & LogWriteOpts = {};
      if (raw.as !== undefined) opts.as = raw.as;
      if (raw.kind !== undefined) opts.kind = raw.kind;
      if (raw.intent !== undefined) opts.intent = raw.intent;
      if (raw.group !== undefined) opts.group = raw.group;
      if (raw.tail !== undefined) opts.tail = raw.tail;
      if (raw.since !== undefined) opts.since = raw.since;
      if (raw.after !== undefined) opts.after = raw.after;
      if (raw.seq !== undefined) opts.seq = raw.seq;
      if (raw.lines !== undefined) opts.lines = raw.lines;
      if (raw.source !== undefined) opts.source = raw.source;
      if (raw.all !== undefined) opts.allWorkstreams = raw.all;
      if (raw.workstream !== undefined) opts.workstream = raw.workstream;
      if (raw.json !== undefined) opts.json = raw.json;
      return handle((db) => cmdLog(db, text, opts), this as Command)();
    });
}
