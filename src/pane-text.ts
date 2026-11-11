// mu — pane text: a worker's own words out of a captured pane.
//
// A captured pane carries the harness's screen furniture along with the
// worker's words: runs of blank rows, rules drawn with box-drawing
// characters, scroll markers (`↑ 12 more lines`), spinner/status rows and
// the harness footer (pi: its editor box, cwd and stats rows; claude: its
// input box and hint row). `paneText` drops those and keeps every other line
// as it was, in order. Every pattern matches a whole row of a known harness
// shape, so a word line that merely contains `-`, `|`, `↑` or a count stays.
// It is a view: the raw capture stays what `--raw` / `--json` print.

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Only box-drawing characters (U+2500-257F) and spaces: a drawn line, not words. */
const RULE = /^[ \u2500-\u257f]*[\u2500-\u257f][ \u2500-\u257f]*$/;
/** pi's editor top border with its loader in it: `── ⠋ Working ───`. */
const LABELLED_RULE = /^\s*─{2,} [\u2800-\u28ff] \S.*? ─{3,}\s*$/;
/** Side borders of a drawn box: `│ text │` keeps `text`. */
const SIDES = /^\s*[│┃║]\s?|\s?[│┃║]\s*$/g;
/** Scroll markers and token counters: `↑ 12 more lines`, `… 3 more lines`, `↓ 1.2k tokens`. */
const MARKER =
  /^\s*(?:[↑↓]\s*\d[\d.,]*[kKM]?\s+(?:more lines?|lines? (?:above|below|hidden)|tokens)|(?:…|\.\.\.)\s*\(?\d+ (?:more|earlier) lines?(?:, ctrl\+o to expand)?\)?|\(?\d+ (?:more lines?|lines? (?:above|below|hidden))\)?)\s*$/;
/** A spinner row: a spinner glyph, one word (`Working`, `Thinking…`), an optional `(…)`. */
const SPINNER = /^\s*[\u2800-\u28ff◐◓◑◒✶✻✽✢✳]\s+[A-Z]\w*(?:…|\.\.\.)?(?:\s+\([^)]*\))?\s*$/;
/** A status row that ends in the harness's interrupt hint: `Running tools · esc to cancel`. */
const STATUS =
  /^\s*(?:\S\s+)?[A-Z][\w ]*?(?:…|\.\.\.)?\s*(?:\((?:[^)]*[·•]\s*)?esc to (?:interrupt|cancel)\)|[·•]\s*esc to (?:interrupt|cancel))\s*$/;
/** pi's transcript furniture: a collapsed thinking block, a tool's timing row. */
const PI_STATUS = /^\s*(?:Thinking\.\.\.|(?:Took|Elapsed) (?:\d+h )?(?:\d+m )?[\d.]+s)\s*$/;
/** pi's cwd row under the editor: `~/repo (branch) • session name`. */
const PI_CWD = /^\s*[~/]\S*(?: \([^)]*\))?(?: • .*)?\s*$/;
/** pi's stats row under the cwd: `↑182 ↓11k … $2.467 7.8%/1.0M (auto)`. */
const PI_STATS = /\d%\/\d|\$\d+\.\d{3}/;
/** claude's input row in its box: `> …`, `❯ …`, `│ > … │`. */
const CLAUDE_INPUT = /^\s*(?:│\s*)?[>❯](?:\s|$)/;
/** claude's hint rows under its input box. */
const CLAUDE_HINT =
  /^\s*(?:\? for shortcuts|⏵⏵ |⏸ plan mode on|.*\(shift\+tab to cycle\)|.*auto-accept edits on|.*bypass permissions on|Press .* again to exit$)/;
/** A code fence: inside one every row is the worker's. */
const FENCE = /^\s*(?:```|~~~)/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Index of the next non-blank row at or after `from`, or -1. */
function nextWord(rows: string[], from: number): number {
  for (let i = from; i < rows.length; i++) if (!isBlank(rows[i] ?? "")) return i;
  return -1;
}

/**
 * Where the harness footer starts, or `rows.length` when there is none.
 * The anchor is the last box rule: the bottom of pi's editor (then the cwd
 * row) or of claude's input box (then hint rows or nothing). From there up
 * to the box's top rule is the editor; from there down is the footer.
 */
export function footerStart(rows: string[]): number {
  let bottom = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (RULE.test(rows[i] ?? "")) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return rows.length;
  let top = -1;
  for (let i = bottom - 1; i >= 0; i--) {
    const row = rows[i] ?? "";
    if (RULE.test(row) || LABELLED_RULE.test(row)) {
      top = i;
      break;
    }
  }
  const below = nextWord(rows, bottom + 1);
  const stats = below < 0 ? -1 : nextWord(rows, below + 1);
  const pi = below >= 0 && PI_CWD.test(rows[below] ?? "") && PI_STATS.test(rows[stats] ?? "");
  const tail = rows.slice(bottom + 1).filter((r) => !isBlank(r));
  const inside = top < 0 ? -1 : nextWord(rows, top + 1);
  const claude =
    tail.every((r) => CLAUDE_HINT.test(r)) &&
    inside >= 0 &&
    inside < bottom &&
    CLAUDE_INPUT.test(rows[inside] ?? "");
  if (!pi && !claude) return rows.length;
  return top >= 0 ? top : bottom;
}

function isFurniture(line: string): boolean {
  return (
    RULE.test(line) ||
    LABELLED_RULE.test(line) ||
    MARKER.test(line) ||
    SPINNER.test(line) ||
    STATUS.test(line) ||
    PI_STATUS.test(line)
  );
}

/** The worker's words in `raw`: furniture dropped, blank runs folded to one, edges trimmed. */
export function paneText(raw: string): string {
  const rows = raw
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((r) => r.replace(/\s+$/, ""));
  const end = footerStart(rows);
  const kept: string[] = [];
  let fenced = false;
  for (const line of rows.slice(0, end)) {
    if (FENCE.test(line.replace(SIDES, ""))) {
      fenced = !fenced;
      kept.push(line.replace(SIDES, "").replace(/\s+$/, ""));
      continue;
    }
    if (fenced) {
      kept.push(line);
      continue;
    }
    if (isBlank(line)) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (isFurniture(line)) continue;
    const unboxed = line.replace(SIDES, "").replace(/\s+$/, "");
    if (isBlank(unboxed) || RULE.test(unboxed)) continue;
    kept.push(unboxed);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/** The last `n` lines of `paneText` output (n undefined = all). */
export function tailText(text: string, n: number | undefined): string {
  if (n === undefined || text === "") return text;
  const lines = text.replace(/\n$/, "").split("\n");
  const kept = n === 0 ? lines : lines.slice(-n);
  return `${kept.join("\n")}\n`;
}
