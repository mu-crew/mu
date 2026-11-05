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

import { rowOf } from "./hooks.js";
import { type HooksPane, pollPane, readHooksPane } from "./hooks-pane.js";
import type { DeliveryTarget } from "./types.js";

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

/**
 * Wait up to `ms` for the agent's `session_start`, where its harness reports a
 * session at startup; otherwise read the pane once. Never throws: a pane
 * murmur cannot report reads as no session and no row, which the paste's own
 * gate then judges.
 */
export async function awaitHooksSession(
  t: DeliveryTarget,
  ms: number = spawnAckMs(),
): Promise<HooksReadiness> {
  const atStartup = rowOf(t.agent)?.startupSessionStart !== "first-prompt";
  let last: HooksPane | undefined;
  const seen = await pollPane(t.agent.paneId, atStartup ? ms : 0, (p) => {
    last = p ?? last;
    return !atStartup || hasSession(p);
  });
  const pane = seen ?? last;
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
