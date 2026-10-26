// mu — producer arming: what `spawn --send`, `send`, `send --interrupt` and
// `claim --for` owe the next wait.
//
// A producer that DID something (delivered a prompt, handed a task over)
// registers the typed refs it started under the caller's identity
// (`wait_registrations`, src/wait-registration.ts), so a later bare `mu wait`
// (or the settle hook) owns them without anyone parsing a shell line. Three rules:
//
//   1. The caller is the managed `<ws>/<agent>` when there is one, else
//      `pi:<session>`: the same name `agents.spawner` records, so one ref is owed
//      to exactly one caller. No identity (a plain shell) arms nothing; an
//      explicit `mu wait <ref>` still works there.
//   2. An agent ref carries the UNCONSUMED fence the producer measured BEFORE its
//      effect (ctl runs, pi incarnation, registry id): a run that settles before
//      any wait starts is still delivered. Never a baseline sampled afterwards.
//   3. Arming never fails the producer. The effect is committed; a refused or
//      full registration comes back as a warning, and provenance discovery
//      (src/wait.ts) still finds spawned workers' in-progress tasks.
//
// Direct SDK calls (spawnAgent, sendToAgent, claimTask, spawnForTask) do not arm:
// the verbs do, because only they know whether the effect landed.

import { getAgent } from "../agents.js";
import type { Db } from "../db.js";
import { currentCallers } from "../wait-callers.js";
import { type RefBaseline, type RegisterRef, registerOwnedWait } from "../wait-registration.js";

export interface ArmResult {
  armed: boolean;
  /** The caller the refs were registered under. */
  caller?: string;
  /** Set when registration was refused: the producer's effect stands. */
  warning?: string;
}

/** The agent ref a delivered prompt owes, fenced by what the producer saw before it. */
export function agentRef(
  agent: { name: string; workstreamName: string; incarnation: number },
  fence: { runs?: number; incarnation?: string } = {},
): RegisterRef {
  const baseline: RefBaseline | undefined =
    fence.runs === undefined
      ? undefined
      : {
          afterRuns: fence.runs,
          agentId: agent.incarnation,
          ...(fence.incarnation !== undefined ? { incarnation: fence.incarnation } : {}),
        };
  return {
    kind: "agent",
    workstream: agent.workstreamName,
    id: agent.name,
    ...(baseline !== undefined ? { baseline } : {}),
  };
}

/** The task ref of work a producer handed over, in the TASK's own workstream. */
export function taskRef(workstream: string, id: string): RegisterRef {
  return { kind: "task", workstream, id };
}

/** Register `refs` for the current caller; never throws. */
export function armWait(db: Db, refs: readonly RegisterRef[]): ArmResult {
  const caller = currentCallers()[0];
  if (caller === undefined || refs.length === 0) return { armed: false };
  try {
    registerOwnedWait(db, caller, refs);
    return { armed: true, caller };
  } catch (e) {
    return {
      armed: false,
      caller,
      warning: `the wait was not armed (${e instanceof Error ? e.message : String(e)}); the work itself is committed; name it with mu wait`,
    };
  }
}

/** What a send measured before its effect (the SendResult / InterruptResult / saved receipt fields). */
export interface SentFence {
  transport?: "ctl" | "mux";
  runs?: number;
  incarnation?: string;
}

/**
 * Arm the wait a DELIVERED prompt owes. A ctl send with a run count is fenced exactly
 * (runs + incarnation + registry id). A delivered mux send (a non-pi pane: its busy-to-idle
 * is all there is) is owed with no fence. A ctl send with no run count (a slash command,
 * an extension that predates runs) started no run: no agent ref. `extraRefs` ride in the
 * same registration (the task a spawn bound), so it is all or nothing.
 */
export function armSend(
  db: Db,
  agent: { name: string; workstreamName: string },
  sent: SentFence,
  extraRefs: readonly RegisterRef[] = [],
): ArmResult {
  const row = getAgent(db, agent.name, agent.workstreamName);
  if (row === undefined) return { armed: false };
  if (sent.transport !== "mux" && sent.runs === undefined) return armWait(db, extraRefs);
  return armWait(db, [
    ...extraRefs,
    agentRef(
      row,
      sent.transport === "mux"
        ? {}
        : {
            runs: sent.runs,
            ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
          },
    ),
  ]);
}
