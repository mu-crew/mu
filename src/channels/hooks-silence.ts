// mu — the silence advisory of a hook harness worker: mu sent it a prompt
// and no hook event has come since (bugs #7.1, #7.2: codex's "Trust this
// folder?" or "Hooks need review" dialog took the paste).
//
// Advice only, never a wait's event: silence is not proof of a dialog (a slow
// first turn, a node not read yet). So `mu wait` checks it once, at its
// timeout, after a fresh read of the node, and says nothing unless every read
// answered and showed no event since the send's own time (taken before the
// paste, so an ack that came before the op was written is never missed).

import { say } from "../messages.js";
import { hookSilenceMs, readHooksPane } from "./hooks-pane.js";
import { paneTail } from "./hooks-ready.js";
import type { ChannelTarget } from "./types.js";

/**
 * The advisory line for `t`, or undefined when there is nothing to say:
 * nothing sent (or a send that recorded no time), its ack confirmed (a hook
 * event came), `MU_HOOK_SILENCE_MS` not passed (0: never), a node or pane
 * read that failed (unknown is not silence), or any event since the send
 * (a row that is running or blocked, changed after the send, or counts
 * another run than the send read).
 */
/** How long the advisory's fresh node read may take: it runs after the wait's own deadline. */
export const HOOK_SILENCE_READ_BUDGET_MS = 1000;

export async function hookSilence(
  t: ChannelTarget,
  now = Date.now(),
  budgetMs = HOOK_SILENCE_READ_BUDGET_MS,
): Promise<string | undefined> {
  const { sent, agent } = t;
  const ms = hookSilenceMs();
  if (sent === undefined || sent.ack === "confirmed" || ms === 0 || now - sent.at < ms) {
    return undefined;
  }
  if (t.remote !== undefined) {
    const read = await t.remote.read({ budgetMs });
    if (!read.ok) return undefined;
  }
  const pane = await readHooksPane(agent.paneId);
  if (pane === undefined) return undefined;
  if (pane.activity !== null) {
    if (pane.activity === "running" || pane.blocked !== null) return undefined;
    if (sent.runs === undefined || pane.runCount !== sent.runs) return undefined;
    if (pane.updatedAt === null || pane.updatedAt >= sent.at) return undefined;
  }
  const tail = await paneTail(agent.paneId, agent.paneIdentity);
  return say(
    "agent.hook_silence",
    agent.name,
    agent.workstreamName,
    Math.round((now - sent.at) / 1000),
    tail,
  );
}
