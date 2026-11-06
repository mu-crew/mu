// mu — the `hooks` side of a task-bound spawn (spec D17): readiness before
// the brief pointer is pasted, and the receipt reconcile after an unknown one.
//
// A hooks worker is launched with no prompt. Its spawn waits for the pane's
// `session_start` in murmur's inbox, the `hooks` counterpart of pi's ctl
// `hello`, where the harness reports its session as it starts (claude,
// cursor-agent, pi on its fallback). codex and muse report theirs only with
// their first prompt (U0), so for them the wait is one read: the baseline.
// What it read (the session and its `run_count`) is the receipt's baseline: a
// replay that finds a run past it in the inbox promotes an `unknown` receipt
// to `sent`, as a ctl receipt is promoted by its msgId. Nothing here pastes.
//
// A remote worker (spec D11) reports on its node, so its readiness reads the
// node (one exec each, a few seconds apart, as a watch does) and its local
// pane once per read, never the pane alone in a tight poll.
//
// The executor's in-place retry (spec D17) reads here too: a worker whose
// last turn ended in `turn_failed`, with nothing in the pane since, is the
// hooks counterpart of a pi worker idle on an API error. murmur keeps an
// `error` until something clears it, and keeps its first time on a repeat, so
// the retry acknowledges the failure it answers (`acknowledgeTurnFailure`)
// before it pastes: a later failure in the pane is then raised afresh.

import { sleep } from "../tmux.js";
import { rowOf } from "./hooks.js";
import {
  clearPaneAttention,
  type HooksPane,
  pollPane,
  readHooksPane,
  settledRuns,
} from "./hooks-pane.js";
import type { ChannelTarget, DeliveryTarget, RemoteReader } from "./types.js";

/** How long a hooks spawn waits for `session_start`: `MU_SPAWN_ACK_MS`, parsed like `MU_SPAWN_CTL_MS`. */
export function spawnAckMs(): number {
  const raw = process.env.MU_SPAWN_ACK_MS;
  if (raw === undefined) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 30_000;
  return parsed;
}

/** The pane as a hooks spawn read it before its pointer: the receipt's baseline. */
export interface HooksReadiness {
  /** True when the pane reported a session (its `session_start` was drained). */
  ready: boolean;
  /** The harness session, or null: none reported yet (codex and muse before their first prompt). */
  sessionId: string | null;
  /** That session's `run_count`, or null: no agent row. */
  runCount: number | null;
}

const hasSession = (p: HooksPane | undefined): boolean =>
  p !== undefined && p.sessionId !== null && p.activity !== null;

/** How far apart a remote worker's readiness reads its node: each read is an exec (spec D11). */
const REMOTE_READY_POLL_MS = 5000;

/**
 * A remote worker's readiness: read its node (relaying its events into the
 * local pane's inbox), then the pane, until it has a session or `ms` passed.
 * Bounded by the clock and the read count, so a test's no-op sleep ends it.
 */
async function awaitRemoteSession(
  paneId: string,
  remote: RemoteReader,
  ms: number,
): Promise<HooksPane | undefined> {
  const deadline = Date.now() + ms;
  const reads = Math.ceil(ms / REMOTE_READY_POLL_MS) + 1;
  let last: HooksPane | undefined;
  for (let i = 0; i < reads; i++) {
    if (i > 0) await sleep(REMOTE_READY_POLL_MS);
    await remote.read();
    last = (await readHooksPane(paneId)) ?? last;
    if (hasSession(last) || Date.now() >= deadline) break;
  }
  return last;
}

/**
 * Wait up to `ms` for the agent's `session_start`, where its harness reports a
 * session at startup; otherwise read the pane once (a remote worker: its node,
 * then the pane). Never throws: a pane
 * murmur cannot report reads as no session and no row, which the paste's own
 * gate then judges.
 */
export async function awaitHooksSession(
  t: DeliveryTarget,
  ms: number = spawnAckMs(),
): Promise<HooksReadiness> {
  const atStartup = rowOf(t.agent)?.startupSessionStart !== "first-prompt";
  let last: HooksPane | undefined;
  const pane =
    t.remote !== undefined
      ? await awaitRemoteSession(t.agent.paneId, t.remote, atStartup ? ms : 0)
      : ((await pollPane(t.agent.paneId, atStartup ? ms : 0, (p) => {
          last = p ?? last;
          return !atStartup || hasSession(p);
        })) ?? last);
  return {
    ready: hasSession(pane),
    sessionId: pane?.sessionId ?? null,
    runCount: pane?.activity === null ? null : (pane?.runCount ?? null),
  };
}

/** What a reconcile found in the inbox past a hooks receipt's baseline. */
export type HooksRunCheck =
  | {
      state: "ran";
      /** The turns settled before the brief's run: the wait fence. */
      runs: number;
      sessionId: string | null;
    }
  | { state: "none" }
  | { state: "unreachable"; reason: string };

/**
 * Did the agent start a run past `baseline` (spec D17)? A run in the
 * baseline's session past its `run_count`; with no baseline session (codex
 * and muse report theirs only with their first prompt), any run. A run in
 * another session is not the pointer's (a `/clear` and a prompt typed by
 * hand), so it never promotes. A remote worker's node is read first (spec
 * D11). Never throws.
 */
export async function hooksRunSince(
  t: DeliveryTarget,
  baseline: { sessionId: string | null; runCount: number | null },
): Promise<HooksRunCheck> {
  if (t.remote !== undefined) {
    const r = await t.remote.read({});
    if (!r.ok) return { state: "unreachable", reason: `its host was not read: ${r.reason}` };
  }
  const pane = await readHooksPane(t.agent.paneId);
  if (pane === undefined) return { state: "unreachable", reason: "murmur pane did not answer" };
  if (pane.activity === null || pane.runCount === null || pane.runCount < 1) {
    return { state: "none" };
  }
  if (baseline.sessionId === null) return { state: "ran", runs: 0, sessionId: pane.sessionId };
  if (pane.sessionId !== baseline.sessionId) return { state: "none" };
  const runs = baseline.runCount ?? 0;
  if (pane.runCount <= runs) return { state: "none" };
  return { state: "ran", runs, sessionId: pane.sessionId };
}

/** A hooks worker's last turn, ended in `turn_failed` (spec D17). */
export interface HooksTurnFailure {
  /** The harness session the failed turn ran in; null: none reported. */
  sessionId: string | null;
  /** Turns settled in that session, the failed one included: the retry's error run. */
  runs: number;
  /** The failure's message (`""` when the harness gave none). */
  error: string;
}

/**
 * The agent's last turn when it ended in `turn_failed` and nothing has
 * happened in the pane since: stopped, no dialog, and the `error` attention
 * raised by the newest event murmur applied to the pane's row. murmur keeps an
 * `error` through later turns, and keeps its first time on a repeat, so an
 * error older than the row's last event reads as no failure: a turn that
 * settled after it (a human's, say) is not mistaken for a failed one. The
 * executor's retry clears the error it answers ({@link acknowledgeTurnFailure}),
 * so each later failure raises a new one. undefined: no such failure, or
 * murmur did not answer. Reads the local pane only (a remote worker's events
 * reach it through a wait's reads). Never throws.
 */
export async function hooksTurnFailure(t: ChannelTarget): Promise<HooksTurnFailure | undefined> {
  const pane = await readHooksPane(t.agent.paneId);
  if (pane === undefined || pane.activity !== "stopped" || pane.blocked !== null) return undefined;
  if (pane.error === null || pane.errorAt === null || pane.updatedAt === null) return undefined;
  if (pane.errorAt < pane.updatedAt) return undefined;
  const runs = settledRuns(pane);
  if (runs === undefined || runs < 1) return undefined;
  return { sessionId: pane.sessionId, runs, error: pane.error };
}

/**
 * Acknowledge a failed turn before its in-place retry: `murmur clear --pane`
 * on mu's tmux server (`-L` for a private `MU_TMUX_SOCKET`, as the pane is
 * read), then a read of the pane. True only when the pane then reads with no
 * `error` and still stopped with no dialog, so a later failure raises a fresh
 * `error` that {@link hooksTurnFailure} sees. false: murmur could not clear it
 * (absent, or too old to take `-L` and so routed to another tmux server): the
 * retry must not go ahead, since every later failure in the pane would read
 * as the old one. Never throws.
 */
export async function acknowledgeTurnFailure(t: ChannelTarget): Promise<boolean> {
  await clearPaneAttention(t.agent.paneId);
  const pane = await readHooksPane(t.agent.paneId);
  return (
    pane !== undefined &&
    pane.error === null &&
    pane.activity === "stopped" &&
    pane.blocked === null
  );
}
