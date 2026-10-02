// mu — delegate outcome: what one finished `mu agent wait` means for a
// delegate (a scratch agent started for one task).
//
// The classification lives here, not in the pi extension, so the
// `mu_delegate` tool has no logic the CLI lacks (ROADMAP § Pi extension
// and the three rules, rule 2): `mu agent wait --json` reports it per
// agent as `outcome`, and the extension only formats it.

import type { AgentWaitAgentState } from "./wait.js";

/**
 * - `done`: the run settled with a final assistant text (`lastText`).
 * - `empty`: the run settled without one (or the agent has no
 *   control socket to supply it); read the pane instead.
 * - `died`: the pane or its control socket went away mid-wait.
 * - `timeout`: still working when the wait gave up; the pane is untouched.
 * - `pending`: not finished, and the wait ended for another reason
 *   (`--any` fired on a sibling).
 */
export type DelegateOutcome = "done" | "empty" | "died" | "timeout" | "pending";

export function delegateOutcome(
  agent: Pick<AgentWaitAgentState, "fired" | "dead" | "lastText">,
  timedOut: boolean,
): DelegateOutcome {
  if (agent.dead) return "died";
  if (agent.fired) return agent.lastText ? "done" : "empty";
  return timedOut ? "timeout" : "pending";
}
