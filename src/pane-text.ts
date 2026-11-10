// mu — pane text: a worker's own words out of a captured pane.
//
// A captured pane carries the harness's screen furniture along with the
// worker's words: runs of blank rows, rules drawn with box-drawing
// characters, scroll-marker rows (`↑ 12 more lines`), spinner/status rows
// and footer rows (token counters, cwd, lease / attach / stop hints).
// `paneText` drops those and keeps every other line as it was, in order.
// It is a view: the raw capture stays what `--raw` / `--json` print.

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Only rule/box/block characters (and spaces): a drawn line, not words. */
const RULE = /^[\s\u2500-\u257f\u2580-\u259f\-=_~·•*+|]*$/;
/** Side borders of a drawn box: `│ text │` keeps `text`. */
const SIDES = /^\s*[│┃║╎╏┆┇┊┋]\s?|\s?[│┃║╎╏┆┇┊┋]\s*$/g;
/** A scroll marker or a token counter: an arrow then a count. */
const ARROW = /^\s*[↑↓▲▼⬆⬇⇡⇣↕]\s*\d/;
/** A scroll marker spelled out: `… 12 more lines`, `(3 lines above)`. */
const MORE = /^\s*[([…]*\s*\d+\s+(more\s+)?lines?(\s+(above|below|hidden))?\b[^a-z]*$/i;
/** A spinner row: braille or a spinner glyph first. */
const SPINNER = /^\s*[\u2800-\u28ff◐◓◑◒✶✻✽✢]\s+\S/;
/** Status words a harness prints while a run is going. */
const STATUS =
  /\b(esc to (interrupt|cancel)|ctrl\+c to (stop|exit|interrupt)|press .* to (stop|detach))\b/i;
/** Footer rows: lease, attach, stop/detach hints, a bare cwd or `(branch)`. */
const FOOTER =
  /^\s*(lease\b|leases?:|attach\b|attach:|stop:|detach\b|worktree:)|^\s*~?\/\S*(\s+\([^)]*\))?\s*$/i;
/** The footer is at most this many non-blank rows at the bottom. */
const FOOTER_ROWS = 6;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** The worker's words in `raw`: furniture dropped, blank runs folded to one, edges trimmed. */
export function paneText(raw: string): string {
  const rows = raw.replace(ANSI, "").replace(/\r/g, "").split("\n");
  // Footer region: the last FOOTER_ROWS non-blank rows.
  let footerStart = rows.length;
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < FOOTER_ROWS; i--) {
    if (!isBlank(rows[i] ?? "")) {
      seen++;
      footerStart = i;
    }
  }
  const kept: string[] = [];
  rows.forEach((row, i) => {
    const line = row.replace(/\s+$/, "");
    if (isBlank(line)) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      return;
    }
    if (RULE.test(line) || ARROW.test(line) || MORE.test(line)) return;
    if (SPINNER.test(line) || STATUS.test(line)) return;
    if (i >= footerStart && FOOTER.test(line)) return;
    const unboxed = line.replace(SIDES, "").replace(/\s+$/, "");
    if (isBlank(unboxed) || RULE.test(unboxed)) return;
    kept.push(unboxed);
  });
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
