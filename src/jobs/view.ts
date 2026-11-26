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
//
// A view a record keeps for later proof (a file kind's dispatcher) also records
// the mux server it was born on (`birthServer`), and is asked about only there
// (`viewOnServer`): another server's answer is no proof.

import { foreignBackend } from "../mux/binding.js";
import { activeMux } from "../mux/detect.js";
import {
  type ActionPaneRef,
  paneRef,
  requireVerifiedPane,
  TmuxPaneBirthError,
  type VerifiedPaneRef,
} from "../mux/pane-ref.js";
import {
  type AttachTarget,
  type CaptureOptions,
  type MuxBackend,
  MuxError,
  type MuxPane,
  type MuxPaneStatus,
  type PaneResult,
} from "../mux/types.js";
import { tmux } from "../tmux.js";

/** A view's state as the multiplexer reports it, or `unknown` with why. */
export type ViewState = PaneResult | { state: "unknown"; reason: string };

/**
 * The action ref for a pane just born: on tmux, the birth identity is required (a birth
 * without one is uncertain, never a legacy row).
 */
export function viewRef(
  mux: MuxBackend,
  paneId: string,
  identity: string | null | undefined,
): ActionPaneRef {
  return mux.name === "tmux"
    ? requireVerifiedPane(paneRef(paneId, identity))
    : { kind: "native", paneId };
}

/**
 * The action ref for an agent row's pane. A tmux row with a recorded server acts only on
 * that server; a legacy row (spawned before `agents.pane_identity`) acts on its bare id,
 * the check mu made before the column.
 */
export function rowRef(
  mux: MuxBackend,
  paneId: string,
  identity: string | null | undefined,
): ActionPaneRef {
  return mux.name === "tmux" ? paneRef(paneId, identity) : { kind: "native", paneId };
}

/** ID-only fallback for legacy liveness observations. */
function probeRef(
  mux: MuxBackend,
  paneId: string,
  identity?: string | null,
): string | VerifiedPaneRef {
  if (mux.name !== "tmux") return paneId;
  const ref = paneRef(paneId, identity);
  return ref.kind === "verified" ? ref : ref.paneId;
}

/** Attach both displayed commands and live actions to the exact tmux pane, not its tab name. */
export function agentAttachTarget(
  mux: MuxBackend,
  agent: { paneId: string; paneIdentity?: string | undefined; tab: string | null; name: string },
  workstream: string,
): AttachTarget {
  const backend = foreignBackend(agent.paneId, mux.name);
  if (backend !== undefined)
    throw new MuxError(`pane ${agent.paneId} belongs to ${backend}, not ${mux.name}`);
  const session = `mu-${workstream}`;
  if (mux.name === "tmux") {
    return { session, pane: paneRef(agent.paneId, agent.paneIdentity) };
  }
  return { session, window: agent.tab ?? agent.name };
}

export async function killView(
  mux: MuxBackend,
  paneId: string,
  identity?: string | null,
): Promise<void> {
  await mux.killPane(rowRef(mux, paneId, identity));
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
  return m.paneAlive(probeRef(m, paneId, identity));
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
  return m.capture(rowRef(m, paneId, identity), opts);
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
  if (mux.name !== "tmux") return undefined;
  try {
    return requireVerifiedPane(paneRef(paneId, born)).identity;
  } catch {
    throw new TmuxPaneBirthError(paneId);
  }
}

/** The identity to record for a pane spawned now (`agents.pane_identity`); undefined: none to give. */
export async function viewIdentity(mux?: MuxBackend): Promise<string | undefined> {
  return (mux ?? (await activeMux())).serverIdentity?.();
}

/**
 * What a dispatcher view's birth is compared against (`birthServer`), read before the mux is
 * asked: Rex's server instance answering now. tmux needs none (its creation call reports its
 * server) and herdr has none to give: undefined. Never throws: no answer is an unknown birth.
 */
export async function serverBeforeBirth(mux: MuxBackend): Promise<string | undefined> {
  if (mux.name === "tmux" || mux.paneOnServer === undefined) return undefined;
  return mux.serverIdentity?.().catch(() => undefined);
}

/**
 * The mux server a view was born on, recorded with its pane (`carrier_jobs.view_server`): the
 * backend's name and the server's own identity after a `:`, never a backend name alone.
 * tmux: `born`, the identity the creation call itself reported (`onPaneCreated`). Rex: its
 * server instance, the same before (`serverBeforeBirth`) and after the birth. A backend with no
 * server identity (herdr), a birth that reported none, or a server that changed is null: the
 * view is unknown and its record retains, never inferred.
 */
export async function birthServer(
  mux: MuxBackend,
  born: string | undefined,
  before: string | undefined,
): Promise<string | null> {
  if (mux.paneOnServer === undefined) return null;
  if (mux.name === "tmux") return born === undefined ? null : `tmux:${born}`;
  const after = await mux.serverIdentity?.().catch(() => undefined);
  return before !== undefined && after === before ? `${mux.name}:${after}` : null;
}

/** A recorded view as seen from here: present, absent, or on a server this invocation cannot ask. */
export type ViewOnServer = "present" | "absent" | "elsewhere";

/**
 * View presence, asked only of the server the view was recorded on (`birthServer`), in the
 * backend's server-fenced probe (`paneOnServer`: tmux checks the server in the very call that
 * looks for the pane). Another backend, another server or none answering is `elsewhere`, never
 * absence: except that a tmux server whose process is gone took its panes with it (`absent`).
 * Throws when a probe fails.
 */
export async function viewOnServer(
  paneId: string,
  server: string,
  mux?: MuxBackend,
): Promise<ViewOnServer> {
  const m = mux ?? (await activeMux());
  const [, backend, identity] = /^(tmux|rex|herdr):(.+)$/.exec(server) ?? [];
  if (backend === undefined || identity === undefined) return "elsewhere";
  if (backend === m.name && m.paneOnServer !== undefined) {
    const seen = await m.paneOnServer(paneId, identity);
    if (seen !== "foreign") return seen;
  }
  return backend === "tmux" && tmuxServerGone(identity) ? "absent" : "elsewhere";
}

/** A tmux server identity leads with its process id (`<pid>|<start time>`): ESRCH proves it gone. */
function tmuxServerGone(identity: string): boolean {
  const pid = Number(/^(\d+)\|\d+$/.exec(identity)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
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
  // tmux has paneStatus for vtmux only: plain tmux still reads murmur, so it never takes this path.
  return mux.paneStatus !== undefined && mux.name !== "tmux";
}

/** vtmux's OSC 7501 status for a tmux pane (ahead of murmur); undefined on plain tmux or any probe failure. */
export async function vtmuxPaneStatus(
  mux: MuxBackend,
  paneId: string,
): Promise<MuxPaneStatus | undefined> {
  try {
    return await mux.paneStatus?.(paneId);
  } catch {
    return undefined;
  }
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
  return m.panePid?.(probeRef(m, paneId, identity));
}

/** One tmux pane in the batched read: absent, or present with murmur's pane options. */
export type TmuxView =
  | { state: "absent" }
  | {
      state: "present";
      murmurState: string;
      murmurSince: string | undefined;
      /** The server is vtmux with `vtmux-program-status` on: worth a `paneStatus` read. */
      vtmuxStatus: boolean;
    };

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
    // `#{vtmux-program-status}` expands empty on stock tmux, so it pays no per-pane probe.
    "#{pane_id}|#{@murmur_pane_state}|#{@murmur_pane_since}|#{vtmux_version}|#{vtmux-program-status}",
  ]);
  const present = new Map<string, TmuxView>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [paneId, murmurState = "", murmurSince, vtmuxVersion = "", vtmuxOn = ""] =
      line.split("|");
    if (paneId !== undefined) {
      const vtmuxStatus = vtmuxVersion !== "" && (vtmuxOn === "on" || vtmuxOn === "1");
      present.set(paneId, { state: "present", murmurState, murmurSince, vtmuxStatus });
    }
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
    return await m.paneResult(probeRef(m, paneId, identity));
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
    return (await mux.paneResult(probeRef(mux, paneId, opts.identity))).state === "running";
  }
  if (opts.occupied === true && mux.paneOccupied !== undefined) {
    return await mux.paneOccupied(paneId);
  }
  return await mux.paneAlive(probeRef(mux, paneId, opts.identity));
}
