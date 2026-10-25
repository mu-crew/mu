// mu — pure rendering helpers used by every cli/*.ts verb wrapper.
//
// Extracted from src/cli.ts (review_cli_ts_past_refactor_signal): the
// table renderers, status colourers, truncators, and relative-time
// formatter were the bulk of cli.ts's bloat (~600 LOC over the 800-LOC
// refactor signal). Co-locating them here keeps cli.ts focused on
// argument parsing, workstream resolution, and program wiring.
//
// All helpers are pure (no I/O beyond returning a string). cli.ts
// re-exports every symbol for back-compat with the existing import
// surface (tests + cli/* importers).

import { type RuntimeState, UNKNOWN_REASON } from "../agent-state.js";
import type { LiveAgent } from "../agents.js";
import { agentStateGlyph, GLYPH } from "../glyphs.js";
import { muTable, pc, renderBoxTable } from "../output.js";
import { RESULT_BYTES } from "../output-contract.js";
import { formatPair, type TaskPair } from "../tasks/status.js";
import type { TaskNoteRow, TaskRow } from "../tasks.js";

// ─── Status colours / icons ────────────────────────────────────────────

/** Per-status colour for the table view. The glyph itself comes from
 *  agentStateGlyph in src/glyphs.ts — single source of truth so the
 *  CLI and TUI status surfaces never drift
 *  (review_code_status_emoji_two_sources caught a 2-of-7 disagreement). */
const STATUS_COLORS: Record<RuntimeState, (s: string) => string> = {
  busy: pc.cyan,
  needs_input: pc.dim,
  needs_permission: pc.magenta,
  unknown: pc.dim,
};

export function statusIcon(state: RuntimeState): string {
  return STATUS_COLORS[state](agentStateGlyph(state));
}

/**
 * Glyph used to flag the derived 'idle but assigned' state
 * (`AgentRow.idle === true`; idle_assigned_agent_detection). Same
 * warning glyph the doctor card paints for a `warn` check — one
 * symbol, one meaning, from src/glyphs.ts.
 */
export const IDLE_GLYPH = GLYPH.warn;

/** Colour a task's (status, substate) pair, rendered by formatPair:
 *  bare "OPEN" for a default substate, "CLOSED/wontfix" otherwise.
 *  OPEN cyan, IN_PROGRESS yellow, CLOSED/done green, any other CLOSED
 *  red (not done), OPEN/parked dim (out of the ready set). */
export function colorPair(pair: TaskPair): string {
  const text = formatPair(pair);
  switch (pair.status) {
    case "OPEN":
      return pair.substate === "parked" || pair.substate === "triage"
        ? pc.dim(text)
        : pc.cyan(text);
    case "IN_PROGRESS":
      return pc.yellow(text);
    case "CLOSED":
      return pair.substate === "done" ? pc.green(text) : pc.red(text);
  }
}

// ─── Width / truncation helpers ───────────────────────────────────────

/**
 * Default fallback when stdout isn't a TTY (e.g. output is piped to
 * less/jq) and `process.stdout.columns` is undefined. 100 fits an 80-col
 * terminal with some breathing room; 100 is wide enough to keep most
 * rows on one line.
 */
const DEFAULT_TERMINAL_WIDTH = 100;

export function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
}

/** Truncate `s` to fit `max` columns (counting display width as length;
 *  good enough for ASCII titles, undercount for emoji/CJK — acceptable
 *  trade-off given the terminal will visually clip anyway). Adds an
 *  ellipsis when truncated. */
export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, max);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Front-truncate `s` to fit `max` columns, prepending an ellipsis when
 *  truncated. Used for paths where the trailing `<workstream>/<agent>`
 *  suffix is the only useful bit (the leading `~/.local/state/mu-next/...`
 *  prefix is identical for every row). Surfaced live by `mu agent
 *  list` blowing the terminal width on the `path` column
 *  (tables_truncate_long_cols_audit). */
export function truncateFront(s: string, max: number): string {
  if (max <= 1) return s.slice(-max);
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

/** Format an elapsed duration (in ms) as a compact relative string:
 *  '12s', '3m', '1h', '2d', '3w'. Used by the task list table when
 *  `--sort recency`/`--sort age` is active so the timeframe the user
 *  is sorting by is visible. Mirrors the helper in src/cli/state.ts
 *  (TUI renderers); kept in sync (the TUI version omits weeks because it shows tighter
 *  windows, but for task list a 5w-old item is real and worth a tag).
 */
export function relTime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return `${Math.floor(day / 7)}w`;
}

/** Like {@link relTime} but with a trailing " ago" suffix. The TUI's
 *  Recent card / popup wants past-tense formatting ("3m ago") while
 *  the In-progress card / popup wants the bare token ("3m"); both
 *  buckets share the rest of the arithmetic. Hoisted out of the TUI
 *  cluster (review_unify_format_when_since) so the two formatters
 *  can't drift the way they were starting to. */
export function relTimeAgo(ms: number): string {
  return `${relTime(ms)} ago`;
}

// ─── Table renderers ──────────────────────────────────────────────────

/** Width of the cwd column: a worktree path is ~70 chars; front-truncate so
 *  the useful trailing `<ws>/<agent>` suffix survives. */
const CWD_BUDGET = 40;

export function formatAgentsTable(agents: readonly LiveAgent[]): string {
  if (agents.length === 0) return pc.dim("  (no agents)");
  // Cap the variable-width columns so a long tmux window name (or a
  // future free-text role) can't push the table past the terminal.
  // Other columns are bounded by their schemas (name 32-char cap,
  // cli is one of pi/codex/claude, status is one of OPEN/...).
  const table = muTable({
    head: [
      pc.bold(""),
      pc.bold("name"),
      pc.bold("cli"),
      pc.bold("state"),
      pc.bold("window"),
      pc.bold("role"),
      pc.bold("cwd"),
    ],
    colWidths: [null, null, null, null, 32, 14, CWD_BUDGET],
    style: { head: [] },
  });
  for (const a of agents) {
    // Idle (alive + assigned + no recent progress): supplement the
    // status glyph with the yellow shared warning glyph, and yellow the
    // agent name itself so the row is visually obvious. The status column
    // stays the truth ('needs_input'); GLYPH.warn is the supplement.
    const idle = a.idle === true;
    const glyphCell = idle
      ? `${pc.yellow(IDLE_GLYPH)} ${statusIcon(a.state)}`
      : statusIcon(a.state);
    const nameCell = idle ? pc.yellow(a.name) : a.name;
    table.push([
      glyphCell,
      nameCell,
      a.cli,
      (a.state === "unknown" || a.state === "needs_permission") && a.reason !== undefined
        ? `${a.state}: ${a.reason}`
        : a.state,
      a.tab ?? a.name,
      a.role === "read-only" ? pc.yellow("read-only") : "",
      a.cwd === null ? pc.dim("—") : truncateFront(a.cwd, CWD_BUDGET - 2),
    ]);
  }
  const needsMurmur = agents.some(
    (a) =>
      a.state === "unknown" &&
      (a.reason === UNKNOWN_REASON.murmurMissing || a.reason === UNKNOWN_REASON.extensionMissing),
  );
  return needsMurmur
    ? `${table.toString()}\n${pc.dim("agent state needs murmur (see mu doctor)")}`
    : table.toString();
}

export function formatReadyTable(tasks: readonly TaskRow[]): string {
  if (tasks.length === 0) return pc.dim("  (no ready tasks)");
  // Sort by ROI descending.
  const sorted = [...tasks].sort((a, b) => b.impact / b.effortDays - a.impact / a.effortDays);
  // Same title-truncation treatment as formatTaskListTable so the
  // ready-task table doesn't blow out terminal width.
  let idW = "name".length;
  let impactW = "impact".length;
  let effortW = "effort".length;
  let roiW = "ROI".length;
  let ownerW = "owner".length;
  for (const t of sorted) {
    idW = Math.max(idW, t.name.length);
    impactW = Math.max(impactW, String(t.impact).length);
    effortW = Math.max(effortW, String(t.effortDays).length);
    const roi = (t.impact / t.effortDays).toFixed(1);
    roiW = Math.max(roiW, roi.length);
    ownerW = Math.max(ownerW, (t.ownerName ?? "").length);
  }
  const padding = 6 * 3 + 1; // 6 cols
  const titleBudget = Math.max(
    20,
    terminalWidth() - (idW + impactW + effortW + roiW + ownerW) - padding,
  );

  // Title is pre-truncated above; use muTable so wordWrap:false acts
  // as a safety belt for any other cell we don't pre-trim.
  const table = muTable({
    head: [
      pc.bold("name"),
      pc.bold("title"),
      pc.bold("impact"),
      pc.bold("effort"),
      pc.bold("ROI"),
      pc.bold("owner"),
    ],
    style: { head: [] },
  });
  for (const t of sorted) {
    const roi = (t.impact / t.effortDays).toFixed(1);
    table.push([
      t.name,
      truncate(t.title, titleBudget),
      String(t.impact),
      String(t.effortDays),
      roi,
      t.ownerName ?? "",
    ]);
  }
  return table.toString();
}

export function formatTaskListTable(
  tasks: readonly TaskRow[],
  opts: { withWorkstream?: boolean; relTimeBasis?: "updatedAt" | "createdAt" } = {},
): string {
  if (tasks.length === 0) return pc.dim("  (no tasks)");
  // The optional relative-time column is appended at the end; header
  // mirrors the timestamp basis ("updated" / "created") so a glance
  // says which sort key is live.
  const timeHeader =
    opts.relTimeBasis === "updatedAt"
      ? "updated"
      : opts.relTimeBasis === "createdAt"
        ? "created"
        : null;
  const baseHead = opts.withWorkstream
    ? ["name", "workstream", "status", "title", "impact", "effort", "ROI", "owner"]
    : ["name", "status", "title", "impact", "effort", "ROI", "owner"];
  const head = timeHeader === null ? baseHead : [...baseHead, timeHeader];

  // Pre-compute the relative-time strings (relative to NOW) so column
  // width and row text agree.
  const now = Date.now();
  const timeCells: string[] = [];
  if (opts.relTimeBasis !== undefined) {
    const basis = opts.relTimeBasis;
    for (const t of tasks) {
      const ts = basis === "updatedAt" ? t.updatedAt : t.createdAt;
      const ms = now - new Date(ts).getTime();
      timeCells.push(relTime(ms));
    }
  }

  // Compute a budget for the title column so the table fits the terminal.
  // Other columns are mostly short fixed-shape values; figure out how
  // wide they actually are, sum them up, and give title the leftover.
  const otherCols = opts.withWorkstream
    ? (["localId", "workstream", "status", "impact", "effortDays", "roi", "owner"] as const)
    : (["localId", "status", "impact", "effortDays", "roi", "owner"] as const);
  const widths = new Map<string, number>();
  for (const col of otherCols) widths.set(col, col.length); // header is the floor
  for (const t of tasks) {
    widths.set("localId", Math.max(widths.get("localId") ?? 0, t.name.length));
    if (opts.withWorkstream) {
      widths.set("workstream", Math.max(widths.get("workstream") ?? 0, t.workstreamName.length));
    }
    widths.set("status", Math.max(widths.get("status") ?? 0, formatPair(t).length));
    widths.set("impact", Math.max(widths.get("impact") ?? 0, String(t.impact).length));
    widths.set("effortDays", Math.max(widths.get("effortDays") ?? 0, String(t.effortDays).length));
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    widths.set("roi", Math.max(widths.get("roi") ?? 0, roi.length));
    widths.set("owner", Math.max(widths.get("owner") ?? 0, (t.ownerName ?? "—").length));
  }
  let timeWidth = 0;
  if (timeHeader !== null) {
    timeWidth = timeHeader.length;
    for (const cell of timeCells) timeWidth = Math.max(timeWidth, cell.length);
  }
  // cli-table3 adds 2 chars of padding per cell + 1 char border per
  // column. Account for that to find the title budget.
  const numCols = head.length;
  const otherTotal = otherCols.reduce((acc, c) => acc + (widths.get(c) ?? 0), 0) + timeWidth;
  const padding = numCols * 3 + 1;
  const titleBudget = Math.max(20, terminalWidth() - otherTotal - padding);

  // Title is pre-truncated to titleBudget above. renderBoxTable, not
  // cli-table3: its layout pass is quadratic in rows
  // (f_tasklist_table_render).
  const rows: string[][] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t) continue; // noUncheckedIndexedAccess
    const roi = t.effortDays > 0 ? (t.impact / t.effortDays).toFixed(1) : "∞";
    const title = truncate(t.title, titleBudget);
    const baseRow = opts.withWorkstream
      ? [
          t.name,
          t.workstreamName,
          colorPair(t),
          title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.ownerName ?? pc.dim("—"),
        ]
      : [
          t.name,
          colorPair(t),
          title,
          String(t.impact),
          String(t.effortDays),
          roi,
          t.ownerName ?? pc.dim("—"),
        ];
    const row = timeHeader === null ? baseRow : [...baseRow, pc.dim(timeCells[i] ?? "")];
    rows.push(row);
  }
  return renderBoxTable(
    head.map((h) => pc.bold(h)),
    rows,
  );
}

// ─── Note records ──────────────────────────────────────────────────────

/** Escape so one note is one line: `\\`, newline, tab and CR become two-character
 *  escapes (the inverse of `unescapeNoteText`), so a raw tab or newline in
 *  a record is always a separator. */
export function escapeNoteText(s: string): string {
  return s.replace(/[\\\n\t\r]/g, (c) =>
    c === "\\" ? "\\\\" : c === "\n" ? "\\n" : c === "\t" ? "\\t" : "\\r",
  );
}

/** Characters of an oversize ordinary note kept as a preview in its stub. */
const NOTE_PREVIEW_CHARS = 120;
/** Characters of the author a stub keeps; `show --note` prints the whole one. */
const STUB_AUTHOR_CHARS = 64;

/** The author as a stub shows it: clipped, so free-text metadata cannot blow the cap. */
export function stubAuthor(author: string | null): string | null {
  if (author === null) return null;
  const chars = [...author];
  return chars.length <= STUB_AUTHOR_CHARS
    ? author
    : `${chars.slice(0, STUB_AUTHOR_CHARS).join("")}…`;
}

/** The content preview a stub shows. */
export function stubPreview(content: string): string {
  return `${[...content].slice(0, NOTE_PREVIEW_CHARS).join("")}…`;
}

/** One note, one line, TAB-separated: `kind  n  by=…  at=…  <escaped text>`.
 *  `retrieve` marks a stub: author and text are clipped previews, `cut=` is the
 *  whole note's bytes and `next=` names the command that prints it whole. */
export function noteRecord(
  n: TaskNoteRow,
  retrieve?: { cutBytes: number; command: string },
): string {
  const author = retrieve === undefined ? n.author : stubAuthor(n.author);
  const head = [
    n.kind,
    String(n.n),
    `by=${escapeNoteText(author ?? "<orchestrator>")}`,
    `at=${n.createdAt}`,
  ];
  if (retrieve === undefined) return [...head, escapeNoteText(n.content)].join("\t");
  return [
    ...head,
    escapeNoteText(stubPreview(n.content)),
    `cut=${retrieve.cutBytes}`,
    `next=${retrieve.command}`,
  ].join("\t");
}

/** A note to print; `cutBytes` set on an oversize ordinary stub. */
export interface ShownNote {
  note: TaskNoteRow;
  cutBytes?: number;
}

export interface PlannedNotes {
  /** Notes to print, oldest first. */
  shown: ShownNote[];
  /** `n` of every note left out, ascending. */
  omitted: number[];
}

/**
 * Apply the byte cap. It is measured on what is EMITTED: `size(ordinary)`
 * serializes the whole output for that set of ordinary notes (text lines or
 * JSON envelope, record keys and the `more` footer included) and returns its
 * bytes with the pinned notes set aside, because pinned notes (the brief,
 * report and verdicts) are content: always whole, never charged, never
 * dropped. A note that alone exceeds `budget` becomes a
 * stub, so a page always makes progress and `show --note` has something to
 * name. Filling runs newest-first when `fill` is "newest" (the default view:
 * the oldest ordinary notes are dropped) and oldest-first when it is "page"
 * (`--all` / `--from`: what is left out is a suffix a further `--from`
 * reaches); it stops at the first ordinary note that does not fit, so the
 * shown ordinary notes are one contiguous run.
 */
export function planNotes(
  notes: readonly TaskNoteRow[],
  pinned: ReadonlySet<number>,
  fill: "newest" | "page",
  size: (ordinary: readonly ShownNote[]) => number,
  opts: { budget?: number } = {},
): PlannedNotes {
  const budget = opts.budget ?? RESULT_BYTES;
  const ordinary = notes.filter((n) => !pinned.has(n.n));
  const keep = new Map<number, number | undefined>();
  const toShown = (): ShownNote[] =>
    notes
      .filter((n) => keep.has(n.n) && !pinned.has(n.n))
      .map((note) => {
        const cutBytes = keep.get(note.n);
        return cutBytes === undefined ? { note } : { note, cutBytes };
      });
  const whole = (n: TaskNoteRow): number => Buffer.byteLength(noteRecord(n)) + 1;
  if (size(ordinary.map((note) => ({ note }))) <= budget) {
    for (const n of ordinary) keep.set(n.n, undefined);
  } else {
    let full = false;
    for (const n of fill === "newest" ? [...ordinary].reverse() : ordinary) {
      if (full) continue;
      const plain: ShownNote = { note: n };
      const entry: ShownNote = size([plain]) > budget ? { note: n, cutBytes: whole(n) } : plain;
      const shownNow = toShown();
      const probe = fill === "newest" ? [entry, ...shownNow] : [...shownNow, entry];
      if (shownNow.length > 0 && size(probe) > budget) {
        full = true;
        continue;
      }
      keep.set(n.n, entry.cutBytes);
    }
  }
  for (const n of notes) if (pinned.has(n.n)) keep.set(n.n, undefined);
  const shown = notes
    .filter((n) => keep.has(n.n))
    .map((note) => {
      const cutBytes = keep.get(note.n);
      return cutBytes === undefined ? { note } : { note, cutBytes };
    });
  return { shown, omitted: notes.filter((n) => !keep.has(n.n)).map((n) => n.n) };
}
