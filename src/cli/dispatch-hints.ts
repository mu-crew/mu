// mu — the dispatch-time Next: hints for pi agents.
//
// One rule, one place: a hint that suggests sending a NEW TASK to an
// agent that speaks the control socket (expectsCtl) shows `--fresh`, so
// the task starts in a clean session; a hint that steers or answers a
// RUNNING agent stays a plain send. Non-pi agents keep the plain send.
// Models act on the Next: block printed at the moment of decision far
// more reliably than on skill prose, so this is where --fresh,
// --interrupt and `mu agent abort` get taught.

import { type AgentRow, expectsCtl } from "../agents.js";
import { agentRefOf, dispatchPrompt } from "../next-hints.js";
import type { NextStep } from "../output.js";
import { shellQuote, shellWord } from "../shell-quote.js";

export type HintAgent = Pick<AgentRow, "name" | "cli" | "workstreamName">;

/**
 * The ONE hint after a send: `mu wait` on exactly the run it started, as one
 * typed ref (`agent:<ws>/<name>@<runs>#<incarnation>`). `runs` is the baseline
 * the send measured; `incarnation` pins the pi process, so a restart is refused
 * instead of waited on. `mu wait` always prints JSON (the final text is
 * `snapshots[].lastText`), so no `--json`. The ref is one POSIX-quoted word:
 * the line parses as printed and works in any shell, armed or not. `msgId` names
 * the send in the intent (the ref pins the run by runs + inc).
 */
export function waitHint(
  agent: Pick<HintAgent, "name" | "workstreamName">,
  runs: number,
  incarnation?: string,
  msgId?: string,
): NextStep {
  const of = msgId === undefined ? "" : ` to ${msgId}`;
  return {
    intent: `Wait for the response${of} (returns its final text)`,
    command: `mu wait ${shellWord(agentRefOf(agent, runs, incarnation))}`,
  };
}

/** After a remote command gate spawns: `mu wait` on it returns the command's own exit code. */
export function gateWaitHint(agent: Pick<HintAgent, "name" | "workstreamName">): NextStep {
  return {
    intent: "Wait for the gate's command (exits with its status)",
    command: `mu wait ${shellWord(agentRefOf(agent))}`,
  };
}

/**
 * "Send work" for an agent about to get a new task. pi agents get
 * `--fresh`; non-pi agents get a plain send.
 */
export function dispatchHint(
  agent: HintAgent,
  opts: { task?: { id: string; workstream: string } } = {},
): NextStep {
  const ws = agent.workstreamName;
  const text = opts.task === undefined ? "'...'" : shellQuote(dispatchPrompt(opts.task));
  if (!expectsCtl(agent)) {
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

/** After `mu task wait` fires: hand the owner its next task (in `ws`), fresh. pi only. */
export function nextDispatchHint(agent: HintAgent, ws: string): NextStep | null {
  if (!expectsCtl(agent)) return null;
  const forRef = agent.workstreamName === ws ? agent.name : `${agent.workstreamName}/${agent.name}`;
  return {
    intent: `Dispatch the next task to ${agent.name} (pick one with mu task next; fresh session)`,
    command: `mu task claim <id> --for ${forRef} -w ${ws} && mu agent send ${agent.name} --fresh ${shellQuote(dispatchPrompt({ id: "<id>", workstream: ws }))} -w ${agent.workstreamName}`,
  };
}
