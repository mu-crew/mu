// mu — what a hook harness's pane shows, read through the mux (spec D4, D6).
//
// A first-prompt harness (codex, muse) fires no hook before its first prompt,
// so nothing in murmur's inbox says its TUI is up. A launcher wrapper may
// print a banner and install plugins for tens of seconds first, and a paste
// that lands then loses its Enter: the text turns up later in the input box,
// unsubmitted. So mu's first paste to such a pane waits for the harness's own
// ready screen (the row's `readyMarks`), and a paste whose ack is late is
// checked once: if its text still sits in the input line, the submit key is
// pressed once more. Never a second paste.

import type { ReadyMarks } from "../harnesses.js";
import { activeMux } from "../mux.js";
import { sleep } from "../tmux.js";

/** How often the ready wait reads the pane. */
const READY_POLL_MS = 250;

/**
 * How long a paste's ack may lag before mu looks for its text still in the
 * input line. A submitted prompt fires its hook within a second or two.
 */
export const SUBMIT_GRACE_MS = 3000;

/** The key that submits a harness's input line, as `pasteToPane` presses it. */
export const SUBMIT_KEY = "Enter";

/** The screen's non-blank lines, right-trimmed. */
function screenLines(screen: string): string[] {
  return screen
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
}

/** The text of the last input line (after its mark), or undefined when the screen has none. */
function inputLine(marks: ReadyMarks, lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trimStart();
    if (line.startsWith(marks.input)) return line.slice(marks.input.length).trim();
  }
  return undefined;
}

/**
 * True when `screen` (a visible-pane capture) is the harness's own ready
 * screen: one of its screen marks and its input line. A launcher's banner,
 * its "Installing ..." lines, a login shell's prompt (a last line ending in
 * `❯`, left when the harness exited) and a dialog (a numbered option led by
 * the input mark, `› 1. Yes`: a paste would answer it) never are.
 */
export function screenReady(marks: ReadyMarks, screen: string): boolean {
  const lines = screenLines(screen);
  const last = lines.at(-1);
  if (last === undefined || last.endsWith("❯")) return false;
  const option = (l: string): boolean => {
    const t = l.replace(/^[\s│|]+/, "");
    return t.startsWith(marks.input) && /^\s*\d+\./.test(t.slice(marks.input.length));
  };
  if (lines.some(option)) return false;
  if (!lines.some((l) => marks.screen.some((m) => l.includes(m)))) return false;
  return inputLine(marks, lines) !== undefined;
}

/**
 * True when the screen's input line still holds `text`, unsubmitted: its
 * start (a long text wraps, so only the first row shows) is the text's start,
 * whitespace collapsed, at least 8 characters of it (or all of a shorter
 * text). A placeholder or another text never matches.
 */
export function inputHolds(marks: ReadyMarks, screen: string, text: string): boolean {
  const got = (inputLine(marks, screenLines(screen)) ?? "").replace(/\s+/g, " ").trim();
  const want = text.replace(/\s+/g, " ").trim();
  if (got === "" || want === "") return false;
  const n = Math.min(got.length, want.length);
  return n >= Math.min(8, want.length) && got.slice(0, n) === want.slice(0, n);
}

/** The visible pane, or undefined when it cannot be read (gone, or no tmux). */
async function readScreen(paneId: string): Promise<string | undefined> {
  try {
    return await (await activeMux()).capture(paneId, { lines: 0 });
  } catch {
    return undefined;
  }
}

/** How the ready wait ended: the screen showed, `ms` passed, or the pane could not be read. */
export type ReadyWait = "ready" | "timeout" | "unread";

/**
 * Wait up to `ms` for the pane to show the harness's ready screen. Polls are
 * counted, as the ack poll's are, so a test's instant sleep ends it.
 */
export async function awaitReadyScreen(
  paneId: string,
  marks: ReadyMarks,
  ms: number,
): Promise<ReadyWait> {
  const deadline = Date.now() + ms;
  const polls = Math.ceil(ms / READY_POLL_MS) + 1;
  for (let i = 0; i < polls; i++) {
    if (i > 0) await sleep(READY_POLL_MS);
    const screen = await readScreen(paneId);
    if (screen === undefined) return "unread";
    if (screenReady(marks, screen)) return "ready";
    if (Date.now() >= deadline) break;
  }
  return "timeout";
}

/** True when the pane's input line still holds `text`, unsubmitted. */
export async function pasteUnsubmitted(
  paneId: string,
  marks: ReadyMarks,
  text: string,
): Promise<boolean> {
  const screen = await readScreen(paneId);
  return screen !== undefined && inputHolds(marks, screen, text);
}
