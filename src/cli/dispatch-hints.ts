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
import type { CtlStatus } from "../ctl/protocol.js";
import type { NextStep } from "../output.js";
import { shellQuote, shellWord } from "../shell-quote.js";
import { relTime } from "./format.js";

export type HintAgent = Pick<AgentRow, "name" | "cli" | "workstreamName">;

/** The prompt that hands a claimed task to its owner. */
function dispatchText(task: { id: string; workstream: string }): string {
  return `Claim done: work on ${task.id}. Read: mu task notes ${task.id} -w ${task.workstream}`;
}

/**
 * The one hint after a send: wait for exactly the run it started. `runs` is
 * the baseline the send measured; `incarnation` pins the pi process, so a
 * restart is refused instead of waited on. `--json` is part of it: the text
 * mode prints no answer, `lastText` is in the JSON. Every word is POSIX
 * quoted; the line parses as printed.
 */
export function waitHint(
  agent: Pick<HintAgent, "name" | "workstreamName">,
  runs: number,
  incarnation?: string,
): NextStep {
  const inc = incarnation === undefined ? "" : ` --inc ${shellWord(incarnation)}`;
  return {
    intent: "Wait for the response (returns its final text)",
    command: `mu agent wait ${shellWord(agent.name)} -w ${shellWord(agent.workstreamName)} --after-runs ${runs}${inc} --json`,
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
  const text = opts.task === undefined ? "'...'" : shellQuote(dispatchText(opts.task));
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

/**
 * Hints for a plain or --steer ctl send, from the status read just before
 * it. Busy: the text was queued, so say how long the run has gone and how
 * to make pi act now. Idle after a settled run (plain only): the text
 * probably started a new task in an old context, so nudge toward --fresh.
 */
export function plainSendHints(
  agent: HintAgent,
  before: Pick<CtlStatus, "state" | "runs"> & { since?: number },
  now: number = Date.now(),
  mode: "followUp" | "steer" = "followUp",
): NextStep[] {
  const { name, workstreamName: ws } = agent;
  if (before.state === "busy") {
    const busy = before.since === undefined ? "busy" : `busy since ${relTime(now - before.since)}`;
    const lands = mode === "steer" ? "the current tool call" : "the current run ends";
    return [
      {
        intent: `${busy}: sees this after ${lands}; to act now: --interrupt`,
        command: `mu agent send ${name} --interrupt '...' -w ${ws}`,
      },
    ];
  }
  if (mode === "followUp" && before.state === "idle" && before.runs > 0) {
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
