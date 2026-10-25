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
  appendLog,
  GroupNotFoundError,
  groupIdFromPrefix,
  type ListLogsOptions,
  latestSeq,
  listLogs,
} from "../logs.js";
import { pc } from "../output.js";
import { shellWord } from "../shell-quote.js";
import { logOut, logPage } from "./log-records.js";
import { boundedCommand } from "./page-records.js";

export interface LogReadOpts {
  workstream?: string;
  allWorkstreams?: boolean;
  since?: number;
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
    await cmdLogWrite(db, text, opts);
    return;
  }
  await cmdLogRead(db, opts);
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
  console.log(
    pc.dim(
      `seq ${row.seq}  workstream=${row.workstreamName ?? "—"}  source=${row.source}  kind=${row.kind}`,
    ),
  );
}

async function cmdLogRead(db: Db, opts: LogReadOpts): Promise<void> {
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
  const page = logPage(rows, {
    json,
    newest: listOpts.since === undefined,
    resume: (seq, n) => readCommand(opts, listOpts, workstream, seq, n),
  });
  if (page.data !== undefined) {
    emitJson(page.data);
    return;
  }
  for (const line of page.lines) console.log(line);
}

/** The same read, continued strictly after `since`, `n` records: what a cut's `next=` runs. */
function readCommand(
  opts: LogReadOpts,
  listOpts: ListLogsOptions,
  workstream: string | undefined,
  since: number,
  n: number,
): string {
  const parts = [
    "mu log",
    ...(workstream === undefined ? ["--all"] : ["-w", shellWord(workstream)]),
  ];
  if (opts.kind !== undefined) parts.push("--kind", shellWord(opts.kind));
  if (opts.source !== undefined) parts.push("--source", shellWord(opts.source));
  if (opts.intent !== undefined) parts.push("--intent", shellWord(opts.intent));
  if (listOpts.group !== undefined) parts.push("--group", listOpts.group);
  parts.push("--since", String(since), "-n", String(n));
  if (opts.json) parts.push("--json");
  return boundedCommand(parts.join(" "), `mu log --since ${since} -n ${n} (with the same filters)`);
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
 * rows loses none: a batch is written whole (the writes are synchronous)
 * before the signal is looked at. SIGINT ends it with 130, SIGTERM with 143.
 */
export async function cmdLogTail(
  db: Db,
  baseOpts: ListLogsOptions,
  cliOpts: LogReadOpts,
  hooks: { signal?: AbortSignal; sleep?: TailSleep } = {},
): Promise<void> {
  // If --since wasn't given, start at "now" so the subscriber only sees
  // NEW entries. Pass `--since 0` to replay from the beginning.
  let cursor = cliOpts.since ?? latestSeq(db);
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
      for (const row of listLogs(db, { ...baseOpts, since: cursor })) {
        emitJsonRow(logOut(row));
        cursor = row.seq;
      }
      await sleep(intervalMs, signal);
    }
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    // Every row written is on the wire before the process can exit.
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
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
      if (raw.lines !== undefined) opts.lines = raw.lines;
      if (raw.source !== undefined) opts.source = raw.source;
      if (raw.all !== undefined) opts.allWorkstreams = raw.all;
      if (raw.workstream !== undefined) opts.workstream = raw.workstream;
      if (raw.json !== undefined) opts.json = raw.json;
      return handle((db) => cmdLog(db, text, opts), this as Command)();
    });
}
