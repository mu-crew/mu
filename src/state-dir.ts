// The mu state directory, resolved from builtins only so the CLI
// bootstrap (src/main.ts) can locate its compile cache before it loads
// any of the CLI graph. db.ts re-exports defaultStateDir.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Resolve the canonical mu state directory:
 *   MU_STATE_DIR > $XDG_STATE_HOME/mu (absolute only) > ~/.local/state/mu
 */
export function defaultStateDir(): string {
  if (process.env.MU_STATE_DIR) return process.env.MU_STATE_DIR;
  return join(xdgStateHome(homedir()), "mu");
}

/** `$XDG_STATE_HOME`, or `<home>/.local/state` when it is unset, empty,
 *  or relative: the XDG spec says such a value must be ignored, and a
 *  relative one would scatter state across every cwd mu runs in. */
export function xdgStateHome(home: string): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
}
