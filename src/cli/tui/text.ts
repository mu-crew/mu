// Plain-text helpers for the dashboard. Ink's <Text> never receives ANSI: wrap
// and padding maths would break on it. Everything is cleaned, then cut and
// padded by VISUAL width (wide glyphs count 2), then handed over as plain text.

import stringWidth from "string-width";

// CSI and OSC sequences, then any other control character (tabs and newlines
// become one space so a title can never add a line to a row).
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character filter
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b./g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: same
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Strip escape sequences and control characters; the result is safe for `<Text>`. */
export function clean(s: string): string {
  return s.replace(ESCAPES, "").replace(CONTROL, " ");
}

const segmenter = new Intl.Segmenter();

/** `s` cleaned, cut to `width` columns (a cut ends in "…") and padded to exactly `width`. */
export function cell(s: string, width: number): string {
  if (width <= 0) return "";
  const text = clean(s);
  const w = stringWidth(text);
  if (w <= width) return text + " ".repeat(width - w);
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const sw = stringWidth(segment);
    if (used + sw > width - 1) break;
    out += segment;
    used += sw;
  }
  return `${out}…${" ".repeat(width - used - 1)}`;
}

/**
 * The first visible row of a viewport: keep `top` while `selected` is inside the
 * window, else move it the least that shows `selected`; never past the end.
 */
export function scrollTop(top: number, selected: number, count: number, height: number): number {
  const h = Math.max(1, height);
  let next = top;
  if (selected < next) next = selected;
  else if (selected >= next + h) next = selected - h + 1;
  return Math.max(0, Math.min(next, count - h));
}
