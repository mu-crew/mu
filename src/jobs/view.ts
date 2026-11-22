// mu — a job's view and the pane reads (spec 2026-11-09-mu-plugins.md, D1 "Two
// reads", D3). The view is the pane mu opened for a job. These are the only
// places outside src/mux that probe the multiplexer about a pane: whether it
// exists, runs or exited, what its classifier reports, its first pid
// (`test/jobs-imports.test.ts`; reconcile keeps its own `listPanes`, spec D8).
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
import type {
  CaptureOptions,
  MuxBackend,
  MuxPane,
  MuxPaneStatus,
  PaneResult,
} from "../mux/types.js";
import { paneRef, tmux } from "../tmux.js";

/** A view's state as the multiplexer reports it, or `unknown` with why. */
export type ViewState = PaneResult | { state: "unknown"; reason: string };

/**
 * The pane as the backend must be asked for it: tmux gets the id with the server it must be on, so
 * the identity is checked inside the tmux call that acts (`paneRef`). Another backend has no server
 * identity: the bare id.
 */
export function viewRef(
  m: MuxBackend,
  paneId: string,
  identity: string | null | undefined,
): string {
  return identity && m.serverIdentity !== undefined ? paneRef(paneId, identity) : paneId;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * View presence: false only when the multiplexer reports the pane (or its
 * server) gone. An exited retained pane is present. Throws when the probe
 * fails, so a caller that deletes on absence fails closed.
 */
export async function viewPresent(
  paneId: string,
  mux?: MuxBackend,
  identity?: string | null,
): Promise<boolean> {
  const m = mux ?? (await activeMux());
  return m.paneAlive(viewRef(m, paneId, identity));
}

/**
 * Whether a pane id still names the agent's pane, not a recycled one: tmux pane ids
 * restart at `%0` per server, so the server the row recorded at spawn (`identity`)
 * must be the one answering now. True without a recorded identity (a row older than the
 * column, unverified: today's check) or on a backend with none. A different or gone
 * server is false: the pane is dead for that row, and the id on the new server is
 * another's, never touched. Throws when the probe fails.
 */
export async function viewOwned(
  identity: string | null | undefined,
  mux?: MuxBackend,
): Promise<boolean> {
  if (identity === undefined || identity === null || identity === "") return true;
  const m = mux ?? (await activeMux());
  if (m.serverIdentity === undefined) return true;
  return (await m.serverIdentity()) === identity;
}

/** The pane's scrollback, refused for a pane another tmux server now holds under the row's id. */
export async function viewCapture(
  paneId: string,
  identity: string | null | undefined,
  opts: CaptureOptions,
  mux?: MuxBackend,
): Promise<string> {
  const m = mux ?? (await activeMux());
  return m.capture(viewRef(m, paneId, identity), opts);
}

/**
 * The identity a pane's birth must report: the backend gave one (tmux: from the same call that
 * created the pane), or it has none to give (herdr, Rex: undefined). A backend that has an identity
 * and gave none is a spawn failure, never a row without one: that row would read as a pre-upgrade
 * (unverified) row and adopt a recycled pane.
 */
export function birthIdentity(
  mux: MuxBackend,
  paneId: string,
  born: string | undefined,
): string | undefined {
  if (born === undefined && mux.serverIdentity !== undefined) {
    throw new Error(`could not establish which ${mux.name} server holds pane ${paneId}`);
  }
  return born;
}

/** The identity to record for a pane spawned now (`agents.pane_identity`); undefined: none to give. */
export async function viewIdentity(mux?: MuxBackend): Promise<string | undefined> {
  return (mux ?? (await activeMux())).serverIdentity?.();
}

/**
 * View presence for one mux session, in one read: the panes it holds (none
 * when the session or the server is gone). Throws when the probe fails, so a
 * caller that acts on absence never reads an unreachable mux as "no panes".
 */
export async function sessionViews(session: string, mux?: MuxBackend): Promise<MuxPane[]> {
  return (mux ?? (await activeMux())).listPanes(session);
}

/** Whether the backend classifies its panes itself (herdr's classifier, Rex's OSC 7501 report). */
export function viewsReportStatus(mux: MuxBackend): boolean {
  return mux.paneStatus !== undefined;
}

/** A view as a classifying backend sees it: its reported agent state, or present with none, or absent. */
export type ViewStatus =
  | { state: "reported"; status: MuxPaneStatus }
  | { state: "present" }
  | { state: "absent" };

/**
 * The backend's own state for the pane (`paneStatus`). A reported state means
 * the pane is there; with none, view presence (`paneAlive`) decides. Throws
 * when either probe fails.
 */
export async function viewStatus(
  paneId: string,
  mux: MuxBackend,
  identity?: string | null,
): Promise<ViewStatus> {
  if (!(await viewOwned(identity, mux))) return { state: "absent" };
  const status = await mux.paneStatus?.(paneId);
  if (status !== undefined) return { state: "reported", status };
  return (await viewPresent(paneId, mux, identity)) ? { state: "present" } : { state: "absent" };
}

/**
 * The pid of the view's first process, so a caller can tell the job's own
 * processes from others; undefined when the pane is gone or the backend cannot
 * say. Throws when the probe fails.
 */
export async function viewPid(
  paneId: string,
  mux?: MuxBackend,
  identity?: string | null,
): Promise<number | undefined> {
  const m = mux ?? (await activeMux());
  return m.panePid?.(viewRef(m, paneId, identity));
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
    // tmux 3.8 turns literal tabs into `_`. Pane IDs, Murmur state tokens
    // and timestamps contain no `|`.
    "#{pane_id}|#{@murmur_pane_state}|#{@murmur_pane_since}",
  ]);
  const present = new Map<string, TmuxView>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [paneId, murmurState = "", murmurSince] = line.split("|");
    if (paneId !== undefined) present.set(paneId, { state: "present", murmurState, murmurSince });
  }
  return (paneId) => present.get(paneId) ?? { state: "absent" };
}

/**
 * The view's state: running, exited (code or signal), or absent, from the
 * multiplexer's `paneResult`. A backend without it, or a probe that fails, is
 * `unknown`, never a result.
 */
export async function viewState(
  paneId: string,
  mux?: MuxBackend,
  identity?: string | null,
): Promise<ViewState> {
  try {
    const m = mux ?? (await activeMux());
    if (m.paneResult === undefined) {
      return { state: "unknown", reason: "the multiplexer cannot report a pane's exit" };
    }
    return await m.paneResult(viewRef(m, paneId, identity));
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
  opts: { occupied?: boolean; identity?: string | null } = {},
): Promise<boolean> {
  const mux = await activeMux();
  if (mux.paneResult !== undefined) {
    return (await mux.paneResult(viewRef(mux, paneId, opts.identity))).state === "running";
  }
  if (opts.occupied === true && mux.paneOccupied !== undefined) {
    return await mux.paneOccupied(paneId);
  }
  return await mux.paneAlive(viewRef(mux, paneId, opts.identity));
}
