// mu — the dispatch-time Next: hints for pi agents.
//
// One rule, one place: a hint that suggests sending a NEW TASK to an
// agent that speaks the control socket (expectsCtl) shows `--fresh`, so
// the task starts in a clean session; a hint that steers or answers a
// RUNNING agent stays a plain send. Non-pi agents keep the plain send.
// Models act on the Next: block printed at the moment of decision far
// more reliably than on skill prose, so this is where --fresh, --steer
// and `mu agent abort` get taught.

import { type AgentRow, expectsCtl } from "../agents.js";
import type { CtlStatus } from "../ctl/protocol.js";
import type { NextStep } from "../output.js";
import { shellQuote } from "../shell-quote.js";

export type HintAgent = Pick<AgentRow, "name" | "cli" | "workstreamName">;

/** The prompt that hands a claimed task to its owner. */
function dispatchText(task: { id: string; workstream: string }): string {
  return `Claim done: work on ${task.id}. Read: mu task notes ${task.id} -w ${task.workstream}`;
}

/**
 * "Send work" for an agent about to get a new task. pi agents get
 * `--fresh` unless `plain` (e.g. an adopted pane whose socket is down,
 * where the restart / --via mux hints come first).
 */
export function dispatchHint(
  agent: HintAgent,
  opts: { task?: { id: string; workstream: string }; plain?: boolean } = {},
): NextStep {
  const ws = agent.workstreamName;
  const text = opts.task === undefined ? "'...'" : shellQuote(dispatchText(opts.task));
  if (opts.plain === true || !expectsCtl(agent)) {
    return { intent: "Send work", command: `mu agent send ${agent.name} ${text} -w ${ws}` };
  }
  return {
    intent:
      opts.task === undefined
        ? "Send the first task (fresh session + prompt in one step)"
        : `Send the task to ${agent.name} (fresh session + prompt in one step)`,
    command: `mu agent send ${agent.name} --fresh ${text} -w ${ws}`,
  };
}

/** `mu agent abort` as the first resort for a pi agent; null otherwise. */
export function abortHint(agent: HintAgent): NextStep | null {
  if (!expectsCtl(agent)) return null;
  return {
    intent: "Prefer abort for pi agents (stops the turn through the control socket)",
    command: `mu agent abort ${agent.name} -w ${agent.workstreamName}`,
  };
}

/**
 * Hints for a plain (not --steer, not --fresh) ctl send, from the status
 * read just before it. Busy: the text was queued, so say how to
 * interrupt or redirect. Idle after a settled run: the text probably
 * started a new task in an old context, so nudge toward --fresh.
 */
export function plainSendHints(
  agent: HintAgent,
  before: Pick<CtlStatus, "state" | "runs">,
): NextStep[] {
  const { name, workstreamName: ws } = agent;
  if (before.state === "busy") {
    return [
      {
        intent:
          "Queued as a follow-up (runs after the current turn); to interrupt now, use --steer",
        command: `mu agent send ${name} --steer '...' -w ${ws}`,
      },
      {
        intent: "Redirecting it? Stop the turn first",
        command: `mu agent abort ${name} -w ${ws}`,
      },
    ];
  }
  if (before.state === "idle" && before.runs > 0) {
    return [
      {
        intent: "Starting unrelated work? Use --fresh next time (new session, no stale context)",
        command: `mu agent send ${name} --fresh '...' -w ${ws}`,
      },
    ];
  }
  return [];
}

/** After `mu task wait` fires: hand the owner its next task (in `ws`), fresh. pi only. */
export function nextDispatchHint(agent: HintAgent, ws: string): NextStep | null {
  if (!expectsCtl(agent)) return null;
  const forRef = agent.workstreamName === ws ? agent.name : `${agent.workstreamName}/${agent.name}`;
  return {
    intent: `Dispatch the next task to ${agent.name} (pick one with mu task next; fresh session)`,
    command: `mu task claim <id> --for ${forRef} -w ${ws} && mu agent send ${agent.name} --fresh ${shellQuote(dispatchText({ id: "<id>", workstream: ws }))} -w ${agent.workstreamName}`,
  };
}
