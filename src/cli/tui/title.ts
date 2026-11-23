// The dashboard's terminal/window title: `mu [<workstream>]` for one selected
// workstream, `mu` for none. process.title feeds tmux automatic-rename; OSC 2
// sets the terminal title. Never shells out to tmux.

import { clean } from "./text.js";

const MAX_NAME = 40;

/** The title for the shown workstream (null = none/all). The name is stripped of escapes and control chars. */
export function formatTitle(workstream: string | null | undefined): string {
  const name = clean(workstream ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return name === "" ? "mu" : `mu [${name}]`;
}

/** Set process.title and the OSC 2 title; `write` is the terminal write (a test seam). */
export function setTitle(
  workstream: string | null | undefined,
  write: (s: string) => unknown = (s) => process.stdout.write(s),
): void {
  const title = formatTitle(workstream);
  process.title = title;
  write(`\u001b]2;${title}\u0007`);
}
