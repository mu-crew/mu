// The mu state directory, resolved from builtins only so the CLI
// bootstrap (src/main.ts) can locate its compile cache before it loads
// any of the CLI graph. db.ts re-exports defaultStateDir.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Resolve the canonical mu state directory:
 *   MU_STATE_DIR > $XDG_STATE_HOME/mu-next (absolute only) > ~/.local/state/mu-next
 *
 * `mu-next`, not `mu`: 3.x owns `<state home>/mu`, and a shared default DB,
 * socket dir or lock dir would let the two builds corrupt each other.
 */
export function defaultStateDir(): string {
  if (process.env.MU_STATE_DIR) return process.env.MU_STATE_DIR;
  return join(xdgStateHome(homedir()), "mu-next");
}

/**
 * The mu cache directory, `$XDG_CACHE_HOME/mu` (absolute only) else
 * `~/.cache/mu`: files mu can lose at any time, such as copies of data
 * that lives elsewhere too.
 */
export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "mu");
}

/** `$XDG_STATE_HOME`, or `<home>/.local/state` when it is unset, empty,
 *  or relative: the XDG spec says such a value must be ignored, and a
 *  relative one would scatter state across every cwd mu runs in. */
export function xdgStateHome(home: string): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".local", "state");
}
