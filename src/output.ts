// mu — output helpers: colour, tables, JSON-mode detection, usage lines.
//
// A result's follow-up is its `next` plan (src/next-hints.ts), finalised
// once in src/cli/handle.ts; nothing here builds a hint.

import Table from "cli-table3";
import tableUtils from "cli-table3/src/utils.js";
import type { Command } from "commander";
import picocolors from "picocolors";

/**
 * Should we emit ANSI color escapes from this process?
 *
 * picocolors ships an `isColorSupported` flag, but it bakes its env
 * inspection (NO_COLOR / FORCE_COLOR / isTTY) ONCE at module-load
 * time. That makes the function untestable without dynamic re-imports
 * — and worse, it loses colors whenever stdout is a pipe, most
 * painfully under `watch --color mu state` and `tmux display-popup -E
 * 'mu state' | cat`, where the surrounding pane is a real terminal but
 * our own stdout is a pipe.
 *
 * We therefore re-implement the decision from scratch at call time,
 * reading every signal directly from `process.env` / `process.stdout`
 * so tests can flip env vars and observe the result without the
 * vi.resetModules + vi.doMock dance (per task
 * review_test_color_enabled_no_color_module_load_caveat).
 *
 * Order of precedence (first match wins):
 *   - `NO_COLOR` set (cross-tool opt-out, https://no-color.org/) →
 *     OFF, even when TMUX/MU_FORCE_COLOR/FORCE_COLOR are set. We
 *     treat any defined value (including "") as set, matching the
 *     no-color.org convention and picocolors' own behavior.
 *   - `MU_FORCE_COLOR` truthy → ON (mu-specific override). Values
 *     "", "0", and "false" are explicit opt-outs, matching chalk's
 *     FORCE_COLOR convention.
 *   - `FORCE_COLOR` truthy → ON (the standard env var picocolors /
 *     chalk consult). Values "", "0", and "false" opt out.
 *   - `TMUX` set → ON (the load-bearing fix for `watch` inside tmux:
 *     the surrounding pane is a real terminal even though our stdout
 *     is a pipe).
 *   - Fall back to the standard TTY heuristic: stdout is a TTY AND
 *     TERM !== "dumb". This mirrors what picocolors itself does in
 *     `isColorSupported` for the happy-path case.
 *
 * See task hud_colors_stripped_under_watch_and for the original repro.
 */
function envForceTrue(key: string): boolean {
  const v = process.env[key];
  if (v === undefined) return false;
  if (v === "" || v === "0" || v.toLowerCase() === "false") return false;
  return true;
}

export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (envForceTrue("MU_FORCE_COLOR")) return true;
  if (envForceTrue("FORCE_COLOR")) return true;
  if (process.env.TMUX !== undefined) return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
}

/**
 * The single picocolors instance the rest of the codebase imports.
 * Built once at module load with `colorEnabled()` baked in, so every
 * caller (cli.ts, src/cli/*.ts) renders consistently regardless of
 * isTTY heuristics. Any other module that needs `pc` should import
 * this one rather than reaching for `picocolors` directly.
 */
// picocolors is still used as the renderer (createColors honors the
// flag we pass), but the *decision* of whether to render is ours.
export const pc = picocolors.createColors(colorEnabled());

// Printable ASCII plus the width-1 punctuation mu prints (dashes,
// quotes, "…", "∞"), after stripping picocolors' SGR codes. Such a line
// renders as itself with width = stripped length, skipping per-grapheme
// segmentation (~95 ms on 1901 rows). Anything else (unbalanced SGR,
// zero-width/format characters, wide text, tabs, CR, other escapes) goes
// through cli-table3's own strlen and colorizeLines, so it is
// byte-identical by construction: cli-table3 bundles an older
// string-width that measures soft hyphen and U+200B differently, and
// closes SGR left open at each line end.
const NARROW = /^[\x20-\x7e\u2010-\u2027\u221e]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point
const SGR = /\u001b\[(?:\d*;){0,5}\d*m/g;
interface BoxCell {
  lines: string[];
  widths: number[];
  width: number;
}
// Mirrors cli-table3's Cell: lines = colorizeLines(content.split("\n")),
// width = widest line. Splitting on "\n" only (not CR) is what it does.
function boxCell(c: string): BoxCell {
  if (NARROW.test(c)) return { lines: [c], widths: [c.length], width: c.length };
  const raw = c.split("\n");
  const lines = tableUtils.colorizeLines(raw);
  const widths = raw.map((l) => {
    const plain = l.replace(SGR, ""); // cli-table3's strlen strip regex
    return NARROW.test(plain) ? plain.length : tableUtils.strlen(l);
  });
  return { lines, widths, width: Math.max(...widths) };
}

/**
 * Render a bordered table byte-identical to `muTable({ head }).toString()`
 * (default style, auto widths), in linear time.
 *
 * cli-table3's layout pass (`fillInTable` → `conflictExists`) scans
 * every earlier row for every cell, so a 1901-row `mu task list` spent
 * ~1.5 s there. Plain cells take a fast path; the rest use cli-table3's
 * own width and SGR-closing helpers (see boxCell). A row is as tall as
 * its tallest cell; shorter cells get blank lines below, as in cli-table3.
 */
export function renderBoxTable(
  head: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const all = [head, ...rows];
  const widths = head.map(() => 0);
  const cells = all.map((r) =>
    r.map((c, i) => {
      const cell = boxCell(c);
      if (cell.width > (widths[i] ?? 0)) widths[i] = cell.width;
      return cell;
    }),
  );
  const rule = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const sep = rule("├", "┼", "┤");
  const out: string[] = [rule("┌", "┬", "┐")];
  for (let y = 0; y < all.length; y++) {
    if (y > 0) out.push(sep);
    const r = cells[y] ?? [];
    let height = 1;
    for (const cell of r) if (cell.lines.length > height) height = cell.lines.length;
    for (let n = 0; n < height; n++) {
      let line = "│";
      for (let x = 0; x < widths.length; x++) {
        const cell = r[x];
        const pad = (widths[x] ?? 0) - (cell?.widths[n] ?? 0);
        line += ` ${cell?.lines[n] ?? ""}${" ".repeat(pad)} │`;
      }
      out.push(line);
    }
  }
  out.push(rule("└", "┴", "┘"));
  return out.join("\n");
}

/**
 * Build a cli-table3 Table with the mu-standard safety belt:
 * `wordWrap: false` (cells wider than their column truncate with `…`
 * instead of wrapping to a second visual row), per-column max widths
 * applied only where the caller asks (`null` = auto), and a default
 * borderless style mirroring the state/agent/workstream tables.
 *
 * Callers should pre-truncate values they care about via the
 * `truncate()` / `truncateFront()` helpers in cli.ts (the proactive
 * path); `wordWrap: false` is the safety belt for the cells they
 * miss. This is load-bearing for renderers with fixed row budgets:
 * a single wrapped cell silently blows out the promised section height.
 *
 * Surfaced live by a worktree table blowing the terminal width on
 * the `path` column (tables_truncate_long_cols_audit). Don't try to
 * cap every column — apply `colWidths` only on the column(s) the
 * operator is least likely to read in full and most likely to be
 * long. Don't add a `--full` / `--no-truncate` flag per verb either;
 * `--json` already emits the full value.
 */
export function muTable(opts: {
  head: string[];
  /** Per-column max widths in cells (`null` = auto width). When
   *  supplied, the array length must match `head`. cli-table3
   *  truncates with `…` because we set `wordWrap: false`. */
  colWidths?: (number | null)[];
  /** Style override; defaults to `{ head: [], border: [] }` (mu's
   *  borderless look). Pass `{ head: [] }` to keep cli-table3's
   *  default border styling. */
  style?: { head?: string[]; border?: string[] };
}): InstanceType<typeof Table> {
  return new Table({
    head: opts.head,
    ...(opts.colWidths !== undefined ? { colWidths: opts.colWidths } : {}),
    style: opts.style ?? { head: [], border: [] },
    wordWrap: false,
  });
}

/**
 * Detect whether the current invocation requested `--json`. Used by the
 * error handler to decide between human prose on stderr and one JSON
 * document on stdout. Reads `process.argv` directly because commander has
 * already consumed it by the time the handler runs, and threading it
 * through every verb wrapper would be invasive.
 *
 * Tolerates `--json=...` form (commander supports both) but mu's verbs
 * only use the bare `--json` flag.
 */
export function isJsonMode(): boolean {
  const argv = process.argv;
  return (
    argv.some((a) => a === "--json" || a.startsWith("--json=")) ||
    (isSqlVerbArgv(argv) && !argv.includes("--table")) ||
    isStateVerbArgv(argv) ||
    isWaitVerbArgv(argv)
  );
}

/** The first one or two words of the invocation, found the way the parser does:
 *  the first words that are not an option or the value of `-w`, so
 *  `mu -w state task list` is a `task` verb. */
function verbWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (let i = 2; i < argv.length && words.length < 2; i++) {
    const a = argv[i] as string;
    if (a === "-w" || a === "--workstream") i++;
    else if (!a.startsWith("-")) words.push(a);
  }
  return words;
}

/**
 * Is this invocation `mu sql` or `mu db query`? Those two print JSON unless
 * `--table`.
 */
export function isSqlVerbArgv(argv: readonly string[]): boolean {
  const words = verbWords(argv);
  return words[0] === "sql" || (words[0] === "db" && words[1] === "query");
}

/**
 * Is this invocation `mu state` or a bare `mu me` (its `--me` alias)? They
 * print one JSON document, errors included (parse-time and handler), with no
 * `--json` needed. `mu me tasks` / `mu me next` are other verbs and keep the
 * explicit flag. Every other verb needs `--json`.
 */
export function isStateVerbArgv(argv: readonly string[]): boolean {
  const [first, second] = verbWords(argv);
  return first === "state" || (first === "me" && second !== "tasks" && second !== "next");
}

/**
 * Is this invocation `mu wait`, its alias `mu task wait`, or a producer that enters
 * the wait (`mu agent send --wait`, `mu task claim --and-wait`)? The wait prints one JSON
 * document for every outcome, errors and parse-time errors included, with no
 * `--json` needed. Found the way the parser finds the verb, so `mu -w x task list`
 * is not a wait and `mu -w x wait` is.
 */
export function isWaitVerbArgv(argv: readonly string[]): boolean {
  const [first, second] = verbWords(argv);
  return (
    first === "wait" ||
    (first === "task" && second === "wait") ||
    // `send --wait` / `claim --and-wait` enter the same wait: one JSON document too.
    (first === "agent" && second === "send" && argv.includes("--wait")) ||
    (first === "task" && second === "claim" && argv.includes("--and-wait"))
  );
}

// ─── Usage rendering for the validation-error contract ──────────────
//
// Every operator-error path (commander-thrown CommanderError, handler-
// thrown UsageError, typed *Invalid* errors) gets the same surface:
// (1) the error line, (2) the failing subcommand's accepted syntax. The
// human path prints commander's own helpInformation(); the --json path
// carries at most three short lines (never the whole help as JSON), so
// the one error document stays small.

/** Walk parent chain so renderings include the full path ("mu task add"). */
function commandFullName(cmd: Command): string {
  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur) {
    parts.unshift(cur.name());
    cur = cur.parent;
  }
  return parts.join(" ");
}

const USAGE_LINE_MAX = 200;

/** The failing verb's accepted syntax in at most 3 lines: synopsis, options,
 *  subcommands. Options list long flags only; a long list ends in "…". */
export function usageLines(cmd: Command): string[] {
  const clip = (s: string) =>
    s.length > USAGE_LINE_MAX ? `${s.slice(0, USAGE_LINE_MAX - 1)}…` : s;
  const lines = [`${commandFullName(cmd)} ${cmd.usage()}`];
  const flags = cmd.options.filter((o) => !o.hidden).map((o) => o.flags);
  if (flags.length > 0) lines.push(clip(`options: ${flags.join(", ")}`));
  const subs = cmd.commands.map((c) => c.name());
  if (subs.length > 0) lines.push(clip(`commands: ${subs.join(", ")}`));
  return lines;
}

/** Render the human --help block (commander's own `helpInformation()`)
 *  to stderr. Single source of truth for the post-error help dump. */
export function printUsageHuman(cmd: Command): void {
  // helpInformation() returns the full "Usage: ...\n\n<desc>\n\nOptions:\n  ..." block.
  // Print to stderr (errors only) so success-path stdout is never polluted.
  process.stderr.write(`\n${cmd.helpInformation()}`);
}
