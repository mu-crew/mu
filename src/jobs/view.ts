// mu — a job's view and the pane reads (spec 2026-11-09-mu-plugins.md, D1 "Two
// reads", D3). The view is the pane mu opened for a job. These are the only
// places outside src/mux that ask the multiplexer whether a pane exists, runs
// or exited (`test/jobs-imports.test.ts`).
//
// Three questions, each kept exactly as its call sites asked it:
//
//   viewPresent  does the pane exist (running, or retained after its command
//                ended)? View presence: the row rule, teardown, the spawn and
//                rollback proofs. Throws when the probe fails. Batched:
//                `sessionViews` (one session's panes) and `readTmuxViews`
//                (every tmux pane, with murmur's pane options).
//   viewState    did the pane's command run, exit (with its status) or go?
//                Never throws: a probe that fails is `unknown`.
//   viewRunning  does the pane's command still run? Channel admission and a
//                job's liveness. Throws when the probe fails.

import { activeMux } from "../mux/detect.js";
import type { MuxBackend, MuxPane, PaneResult } from "../mux/types.js";
import { tmux } from "../tmux.js";

/** A view's state as the multiplexer reports it, or `unknown` with why. */
export type ViewState = PaneResult | { state: "unknown"; reason: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * View presence: false only when the multiplexer reports the pane (or its
 * server) gone. An exited retained pane is present. Throws when the probe
 * fails, so a caller that deletes on absence fails closed.
 */
export async function viewPresent(paneId: string, mux?: MuxBackend): Promise<boolean> {
  return (mux ?? (await activeMux())).paneAlive(paneId);
}

/**
 * View presence for one mux session, in one read: the panes it holds (none
 * when the session or the server is gone). Throws when the probe fails, so a
 * caller that acts on absence never reads an unreachable mux as "no panes".
 */
export async function sessionViews(session: string, mux?: MuxBackend): Promise<MuxPane[]> {
  return (mux ?? (await activeMux())).listPanes(session);
}

/** One tmux pane in the batched read: absent, or present with murmur's pane options. */
export type TmuxView =
  | { state: "absent" }
  | { state: "present"; murmurState: string; murmurSince: string | undefined };

/**
 * View presence for every tmux pane, in one read (`list-panes -a`), carrying
 * each present pane's murmur options (`@murmur_pane_state`,
 * `@murmur_pane_since`) so the state read needs no second fork. Returns the
 * lookup: a pane id tmux did not list is absent. Throws when tmux cannot be
 * asked.
 */
export async function readTmuxViews(): Promise<(paneId: string) => TmuxView> {
  const stdout = await tmux([
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{@murmur_pane_state}\t#{@murmur_pane_since}",
  ]);
  const present = new Map<string, TmuxView>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [paneId, murmurState = "", murmurSince] = line.split("\t");
    if (paneId !== undefined) present.set(paneId, { state: "present", murmurState, murmurSince });
  }
  return (paneId) => present.get(paneId) ?? { state: "absent" };
}

/**
 * The view's state: running, exited (code or signal), or absent, from the
 * multiplexer's `paneResult`. A backend without it, or a probe that fails, is
 * `unknown`, never a result.
 */
export async function viewState(paneId: string, mux?: MuxBackend): Promise<ViewState> {
  try {
    const m = mux ?? (await activeMux());
    if (m.paneResult === undefined) {
      return { state: "unknown", reason: "the multiplexer cannot report a pane's exit" };
    }
    return await m.paneResult(paneId);
  } catch (e) {
    return { state: "unknown", reason: `mux: ${message(e)}` };
  }
}

/**
 * Whether the view's command still runs. tmux and Rex: `paneResult` is
 * running (a retained pane whose command ended is not). A backend without it:
 * with `occupied`, an agent still occupies the pane (herdr's pane outlives its
 * occupant as a shell); else the pane exists. Throws when the probe fails:
 * unknown keeps whatever the caller guards (a host channel, a row).
 */
export async function viewRunning(
  paneId: string,
  opts: { occupied?: boolean } = {},
): Promise<boolean> {
  const mux = await activeMux();
  if (mux.paneResult !== undefined) return (await mux.paneResult(paneId)).state === "running";
  if (opts.occupied === true && mux.paneOccupied !== undefined) {
    return await mux.paneOccupied(paneId);
  }
  return await mux.paneAlive(paneId);
}
