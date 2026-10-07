import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

const ESC = "\u001B";
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "y");
const SGR_PATTERN = new RegExp(`^${ESC}\\[([0-9;]*)m$`);
const RESET = `${ESC}[0m`;

// Printable ASCII plus the width-1 glyphs mu draws (dashes/quotes/"…",
// arrows incl. "↻", box-drawing, "π"), after stripping SGR: width is the
// stripped length. string-width's per-grapheme segmentation cost
// ~150 ms per 4.4k-line DAG body; everything else still goes through it.
const NARROW = /^[\x20-\x7e\u03c0\u2010-\u2027\u2190-\u21ff\u2500-\u257f]*$/;

/** Terminal-visible width of `s` (ANSI-aware, wide-char-aware). */
export function visibleWidth(s: string): number {
  const plain = s.includes(ESC) ? stripVTControlCharacters(s) : s;
  return NARROW.test(plain) ? plain.length : stringWidth(s);
}

interface Token {
  text: string;
  width: number;
}

/**
 * Wrap a single line by terminal-visible width while preserving
 * ANSI SGR colour/style across hard wrap boundaries.
 */
export function wrapAnsi(line: string, width: number): string[] {
  if (line === "") return [line];
  if (width <= 0 || visibleWidth(line) <= width) {
    // Even the early-return path must guarantee SGR is closed so the ink
    // render does not leak colour into adjacent chrome (the popup right
    // border is the canonical reproducer): a short colored line like
    // `\x1b[31m+ added` with no trailing reset would otherwise paint the
    // following border cell red. (bug_drill_ansi_state_leaks_into_border)
    return [closeIfOpen(line, computeActiveSgr(line))];
  }

  const out: string[] = [];
  const activeSgr: string[] = [];
  let chunk = "";
  let chunkWidth = 0;
  let i = 0;

  const emit = () => {
    if (chunkWidth === 0) return;
    out.push(closeIfOpen(chunk, activeSgr));
    chunk = activeSgr.join("");
    chunkWidth = 0;
  };

  while (i < line.length) {
    ANSI_PATTERN.lastIndex = i;
    const ansi = ANSI_PATTERN.exec(line);
    if (ansi?.index === i) {
      const seq = ansi[0];
      chunk += seq;
      updateActiveSgr(seq, activeSgr);
      i += seq.length;
      continue;
    }

    const token = nextToken(line, i);
    if (chunkWidth > 0 && chunkWidth + token.width > width) emit();
    chunk += token.text;
    chunkWidth += token.width;
    i += token.text.length;

    if (chunkWidth >= width) emit();
  }

  // Same close-if-open guarantee as emit() for the trailing chunk: an
  // input whose final fragment is colored without a closing reset must
  // not bleed into ink's border render on the next row.
  if (chunkWidth > 0 || (chunk !== "" && out.length === 0)) {
    out.push(closeIfOpen(chunk, activeSgr));
  }
  return out.length === 0 ? [line] : out;
}

export function padAnsiLine(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w >= width) return line;
  return line + " ".repeat(width - w);
}

// Wrapped+padded output per (width, raw line). Drill bodies are rebuilt on
// every changed fast tick, but almost all of their lines are unchanged, so
// a re-wrap is a split + lookups + join instead of ~4k width computations.
// Bounded: cleared wholesale when full (a big body refills it in one pass).
const WRAP_CACHE_MAX = 20_000;
const wrapCache = new Map<string, string>();

function wrapAndPadLine(line: string, width: number): string {
  const key = `${width}\u0000${line}`;
  const hit = wrapCache.get(key);
  if (hit !== undefined) return hit;
  const out = wrapAnsi(line, width)
    .map((l) => padAnsiLine(l, width))
    .join("\n");
  if (wrapCache.size >= WRAP_CACHE_MAX) wrapCache.clear();
  wrapCache.set(key, out);
  return out;
}

export function wrapAndPadAnsiLines(text: string, width: number): string {
  if (text === "") return "";
  return text
    .split("\n")
    .map((line) => wrapAndPadLine(line, width))
    .join("\n");
}

/** Test hook: number of cached wrapped lines. */
export function wrapCacheSizeForTests(): number {
  return wrapCache.size;
}

function nextToken(text: string, offset: number): Token {
  const first = text[offset];
  if (first === undefined) return { text: "", width: 0 };
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return { text: first, width: visibleWidth(first) };
  const char = String.fromCodePoint(codePoint);
  return { text: char, width: visibleWidth(char) };
}

function closeIfOpen(text: string, active: string[]): string {
  return active.length > 0 ? `${text}${RESET}` : text;
}

function computeActiveSgr(line: string): string[] {
  const active: string[] = [];
  let i = 0;
  while (i < line.length) {
    ANSI_PATTERN.lastIndex = i;
    const m = ANSI_PATTERN.exec(line);
    if (m?.index === i) {
      updateActiveSgr(m[0], active);
      i += m[0].length;
      continue;
    }
    i++;
  }
  return active;
}

function updateActiveSgr(seq: string, active: string[]): void {
  const match = SGR_PATTERN.exec(seq);
  if (match === null) return;
  const rawParams = match[1] ?? "";
  const params = rawParams === "" ? [0] : rawParams.split(";").map((p) => Number(p || "0"));
  if (params.some(isFullReset)) {
    active.length = 0;
    return;
  }
  active.push(seq);
}

function isFullReset(code: number): boolean {
  return code === 0;
}
