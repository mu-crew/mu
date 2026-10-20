// tmux paste path for non-pi agents; pi agents use the control socket.
//
// Private pane-text checks used by tmux's send protocol. These answer whether
// input can be delivered, not what state an agent is in.

const TAIL_WINDOW_LINES = 100;
const TAIL_LINES = 20;
// "model: loading" is Codex's boot screen: it has no spinner, so without
// the marker a booting Codex looks calm. This only covers the text being
// visible in the captured tail, not a blank startup screen or the readiness
// deadline expiring (sendToPane still pastes then).
const BUSY_MARKERS: readonly string[] = ["to interrupt)", "model: loading"];
const BRAILLE_SPINNER_RE = /[\u2800-\u28ff]/;

/** Take the recent non-blank pane tail used by the input-timing checks. */
export function extractTail(scrollback: string): string {
  const lines = scrollback.split("\n");
  const window = lines.slice(-TAIL_WINDOW_LINES);
  let end = window.length;
  while (end > 0 && (window[end - 1] ?? "").trim() === "") end--;
  return window.slice(Math.max(0, end - TAIL_LINES), end).join("\n");
}

/** True when recent pane text shows input is temporarily unsafe to submit. */
export function paneLooksBusy(scrollback: string): boolean {
  const tail = extractTail(scrollback);
  return BUSY_MARKERS.some((marker) => tail.includes(marker)) || BRAILLE_SPINNER_RE.test(tail);
}
