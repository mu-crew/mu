// mu — multiplexer backend detection.
//
// Picks the ONE backend a given mu invocation drives. The mux backend is a
// property of the PROCESS, so it is resolved once and cached (see
// `activeMux`).

import { say } from "../messages.js";
import { insideRex, rexBackend } from "./rex.js";
import { tmuxBackend } from "./tmux.js";
import { type MuxBackend, type MuxBackendName, NoMultiplexerError } from "./types.js";

/** Every backend mu knows about, in detection-precedence order. tmux is
 *  the incumbent and wins pure availability ties; Rex is selected by a Rex
 *  terminal (see `detectMux`). herdr was retired in mu 6 (src/mux/binding.ts). */
const BACKENDS: readonly MuxBackend[] = [tmuxBackend, rexBackend];

/** Look up a backend by name. Throws on unknown name. Backs `MU_MUX`. */
export function muxByName(name: MuxBackendName): MuxBackend {
  for (const backend of BACKENDS) {
    if (backend.name === name) return backend;
  }
  if ((name as string) === "herdr") throw new Error(say("mux.herdr_retired"));
  throw new Error(say("mux.unknown_backend", name));
}

/** Valid `MU_MUX` values, for error messages. */
const KNOWN_NAMES: readonly string[] = BACKENDS.map((b) => b.name);

/**
 * Resolve the active multiplexer backend.
 *
 * The detection order:
 *
 *   1. `MU_MUX=<name>`  — explicit override. Also the test seam. An
 *      unknown value throws rather than silently falling through: a
 *      typo'd backend name should fail loud, not quietly run on tmux.
 *   2. Ambient signal    — an env var proving the CALLER is already
 *      inside a managed pane of that mux ($TMUX or $TMUX_PANE for tmux,
 *      $REX_BLOCK or $REX_SESSION with TERM_PROGRAM=rex for Rex). The most specific
 *      signal wins, since tmux can run nested inside Rex.
 *   3. Availability      — whichever backend's binary actually runs.
 *      Ties break in BACKENDS order (tmux is the incumbent).
 *   4. Throw `NoMultiplexerError`.
 *
 * Note steps 2 and 3 are separate on purpose. `$TMUX` says "the caller
 * is in a tmux pane"; `tmux -V` says "tmux works here". mu can spawn a
 * detached session from a plain shell, so step 3 alone is sufficient to
 * operate — step 2 exists only to pick the RIGHT mux when several are
 * installed.
 */
export async function detectMux(): Promise<MuxBackend> {
  const override = process.env.MU_MUX;
  if (override !== undefined && override.length > 0) {
    if (override === "herdr") throw new Error(say("mux.herdr_retired"));
    return muxByName(override as MuxBackendName);
  }

  // Both vars, not just $TMUX: tmux sets $TMUX_PANE in every pane too,
  // and some setups (sudo -E, direnv, ssh with a restrictive SendEnv)
  // pass one through but not the other. Either one proves we are in a
  // tmux pane, which is what this step is asking.
  if (process.env.TMUX || process.env.TMUX_PANE) return tmuxBackend;

  // A Rex terminal, last: tmux runs inside Rex, never the reverse,
  // and both set their own vars in their panes ($REX_BLOCK / $REX_SESSION is inherited).
  if (insideRex()) return rexBackend;

  for (const backend of BACKENDS) {
    if (await backend.available()) return backend;
  }

  throw new NoMultiplexerError(KNOWN_NAMES);
}

// ─── Process-wide active backend ───────────────────────────────────────

let cached: MuxBackend | undefined;

/**
 * The active backend, resolved once per process and memoized.
 *
 * Memoized because detection can shell out (`tmux -V`) and mu is a
 * short-lived CLI that touches the mux many times per invocation; the
 * answer cannot change mid-process in any way that mu should react to.
 */
export async function activeMux(): Promise<MuxBackend> {
  if (cached === undefined) cached = await detectMux();
  return cached;
}

/**
 * Install a backend directly, bypassing detection. Returns the previous
 * value so tests can restore it. Mirrors `setTmuxExecutor`.
 *
 * Production code never calls this — use `activeMux()`.
 */
export function setMuxForTests(backend: MuxBackend | undefined): MuxBackend | undefined {
  const previous = cached;
  cached = backend;
  return previous;
}

/** Drop the memoized backend so the next `activeMux()` re-detects. */
export function resetMux(): void {
  cached = undefined;
}
