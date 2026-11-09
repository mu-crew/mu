// The mu state directory, resolved from builtins only so the CLI
// bootstrap (src/main.ts) can locate its compile cache before it loads
// any of the CLI graph. db.ts re-exports defaultStateDir.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** mu 5's state directory name under the state home. Schema 14 broke
 *  on-disk compatibility with mu 4, which keeps `mu-next` (AGENTS.md
 *  "State directories"; spec D5). */
const STATE_DIR_NAME = "mu5";
/** mu 4's state directory name: the state import's source, never written. */
const MU4_STATE_DIR_NAME = "mu-next";

/**
 * Resolve the canonical mu state directory:
 *   MU_STATE_DIR > $XDG_STATE_HOME/mu5 (absolute only) > ~/.local/state/mu5
 *
 * Neither `mu-next` (mu 4) nor `mu` (3.x): a shared default DB, socket dir
 * or lock dir would let two builds corrupt each other.
 */
export function defaultStateDir(): string {
  if (process.env.MU_STATE_DIR) return process.env.MU_STATE_DIR;
  return stateDirIn(xdgStateHome(homedir()));
}

/** mu's state dir under a state home (`$XDG_STATE_HOME` or `~/.local/state`). */
export function stateDirIn(stateHome: string): string {
  return join(stateHome, STATE_DIR_NAME);
}

/**
 * The state import's two files (spec D5): mu 4's `<state home>/mu-next/mu.db`
 * and mu 5's `<state home>/mu5/mu.db`. Null when MU_STATE_DIR or MU_DB_PATH
 * is set: the operator chose the DB, and there is no mu 4 sibling to import.
 */
export function stateImportPaths(): { source: string; target: string } | null {
  if (process.env.MU_STATE_DIR || process.env.MU_DB_PATH) return null;
  const home = xdgStateHome(homedir());
  return {
    source: join(home, MU4_STATE_DIR_NAME, "mu.db"),
    target: join(stateDirIn(home), "mu.db"),
  };
}

/** The state import's paths when it is due: mu 4's DB exists and mu 5's
 *  does not. Two `existsSync` calls, so every open can afford it. */
export function dueStateImport(): { source: string; target: string } | null {
  const paths = stateImportPaths();
  if (paths === null || existsSync(paths.target) || !existsSync(paths.source)) return null;
  return paths;
}

/** Thrown by openDb on mu 5's default DB while mu 4's still awaits the state
 *  import (spec D5): opening would create an empty DB, which the import then
 *  refuses to replace. Exit 4. Any mu verb imports first (handle()). */
export class StateImportPendingError extends Error {
  override readonly name = "StateImportPendingError";
  constructor(
    public readonly source: string,
    public readonly target: string,
  ) {
    super(
      `${source} has not been imported into ${target} yet: run any mu verb (it imports once), or set MU_STATE_DIR or MU_DB_PATH to open another DB`,
    );
  }
}

/** Refuse to open `path` when it is mu 5's default DB and the import is due. */
export function refusePendingStateImport(path: string): void {
  const due = dueStateImport();
  if (due !== null && resolve(path) === resolve(due.target)) {
    throw new StateImportPendingError(due.source, due.target);
  }
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
