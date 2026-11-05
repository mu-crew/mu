// mu — AgentObservation: the one typed result of reading or watching an agent.
//
// Before this, the facts about an agent's run were split across three
// shapes: `StateReading` (state, runs, pending; no text), the ctl `wait`
// reply that `mu agent wait` consumed inline (text, error, session file; no
// settled run count, incarnation or truncation flag), and
// the snapshot `mu agent wait` read (neither). A caller that
// needs to act on a settled run (apply its CLOSE block exactly once) needs
// all of it at once: the registry id, the ctl incarnation, the SETTLED run
// count, whether it settled, and the text with its truncation flag.
//
// This module is a seam, not an engine. It owns no polling and no loop:
// `observeAgentStates` is one `readAgentStates` pass; the watch of a run's end
// is the agent's channel's (`watchAgentRun` on ctl, src/channels/ctl.ts),
// returning observations. waitForEvents stays the only loop.
//
// Identity: `agentId` is the registry row id (a number, never reused);
// `incarnation` is pi's own string (`--inc`). They are different things
// and never substitute for one another.

import { dirname } from "node:path";
import type { RuntimeState, StateReading, StateSource } from "../agent-state.js";
import { agentKey } from "../agent-state.js";
import type { AgentRow } from "../agents.js";
import { type CtlBlocked, readAgentStates } from "../channels/index.js";
import type { SettledCloseInput } from "../close-block.js";
import type { Db } from "../db.js";
import { type GateReading, readGate } from "./gate.js";

/** Who an observation is about. */
export type ObservedAgent = Pick<
  AgentRow,
  "name" | "workstreamName" | "paneId" | "cli" | "incarnation" | "gateToken" | "channel"
>;

export interface AgentObservation {
  workstream: string;
  name: string;
  /** The registry row id (`AgentRow.incarnation`): a number, not pi's string. */
  agentId: number;
  paneId: string;
  /** Runtime state; null = the pane is gone (dead). */
  status: RuntimeState | null;
  /** Where the reading came from. */
  source: StateSource;
  /** When the state began (ms epoch), when the source says. */
  since: number | null;
  /** Why the state is unknown or blocked, when the source said. */
  reason?: string;
  /** How the control socket answered; absent for a non-pi agent. */
  ctl?: Exclude<StateReading["ctl"], undefined>;
  /** A remote command gate that ended: the command's own numeric exit status (`status` is then null). */
  exit?: number;
  /** pi's process incarnation (ctl only; absent from older extensions). */
  incarnation?: string;
  /** pi's settled-run count: of the SETTLED run when `settled`, else the current count. */
  runs?: number;
  /** ctl only: pi holds queued messages. */
  pending?: boolean;
  /** True only for a ctl `wait` reply that ended `settled`: the run is over and its facts below are its own. */
  settled: boolean;
  /** The extension dialog pi is waiting on (status needs_permission). */
  blocked?: CtlBlocked;
  /** The settled run's final assistant text (tail-capped by the extension). */
  lastText?: string;
  /** True when `lastText` lost its head to the cap: a CLOSE block in it cannot be trusted. */
  lastTextTruncated?: boolean;
  /** The error that ended the settled run. */
  lastError?: string;
  /** The pi session file holding the run's full transcript. */
  sessionFile?: string;
}

/** A status read as an observation. `reading` undefined = the reader had no row. */
export function observationFromReading(
  agent: ObservedAgent,
  reading: StateReading | undefined,
): AgentObservation {
  return {
    workstream: agent.workstreamName,
    name: agent.name,
    agentId: agent.incarnation,
    paneId: agent.paneId,
    status: reading?.alive === false ? null : (reading?.state ?? "unknown"),
    source: reading?.source ?? "none",
    since: reading?.since ?? null,
    ...(reading?.reason !== undefined ? { reason: reading.reason } : {}),
    ...(reading?.ctl !== undefined ? { ctl: reading.ctl } : {}),
    ...(reading?.incarnation !== undefined ? { incarnation: reading.incarnation } : {}),
    ...(reading?.runs !== undefined ? { runs: reading.runs } : {}),
    ...(reading?.pending !== undefined ? { pending: reading.pending } : {}),
    ...(reading?.blocked !== undefined ? { blocked: reading.blocked } : {}),
    settled: false,
  };
}

/** A remote command gate's reading as an observation: running reads busy, an ended one carries its numeric exit. */
export function observationFromGate(agent: ObservedAgent, gate: GateReading): AgentObservation {
  const base = {
    workstream: agent.workstreamName,
    name: agent.name,
    agentId: agent.incarnation,
    paneId: agent.paneId,
    source: "none" as const,
    since: null,
    settled: false,
  };
  switch (gate.kind) {
    case "running":
      return { ...base, status: "busy" };
    case "exited":
      return { ...base, status: null, exit: gate.code };
    case "dead":
      return { ...base, status: null, reason: gate.reason };
    case "unknown":
      return { ...base, status: "unknown", reason: gate.reason };
  }
}

/** One `readAgentStates` pass over `agents`, keyed `<workstream>/<name>`; a gate is read from its pane and result record instead. */
export async function observeAgentStates(
  db: Db,
  agents: readonly AgentRow[],
): Promise<Map<string, AgentObservation>> {
  const gates = agents.filter((a) => a.gateToken !== null);
  const rest = agents.filter((a) => a.gateToken === null);
  const readings = await readAgentStates(rest, { stateDir: dirname(db.name) });
  const out = new Map<string, AgentObservation>(
    rest.map((a) => [agentKey(a), observationFromReading(a, readings.get(agentKey(a)))]),
  );
  const read = await Promise.all(gates.map((g) => readGate(db, g)));
  gates.forEach((g, i) => {
    const r = read[i];
    if (r !== undefined) out.set(agentKey(g), observationFromGate(g, r));
  });
  return out;
}

/** The facts of an observation that decide a settled close. */
export type SettleFacts = Pick<
  AgentObservation,
  | "workstream"
  | "name"
  | "agentId"
  | "status"
  | "settled"
  | "incarnation"
  | "runs"
  | "lastText"
  | "lastTextTruncated"
  | "lastError"
>;

/**
 * `applySettledClose`'s input for an observation, or undefined when it is
 * not one: it must be a ctl-settled run (`settled`), alive, with pi's
 * incarnation and the settled run count. Idle, blocked, unknown and
 * older-extension replies never qualify: a settle is never inferred.
 */
export function settledCloseInput(obs: SettleFacts): SettledCloseInput | undefined {
  if (!obs.settled || obs.status === null) return undefined;
  if (obs.incarnation === undefined || obs.runs === undefined) return undefined;
  return {
    workstream: obs.workstream,
    agent: obs.name,
    agentId: obs.agentId,
    incarnation: obs.incarnation,
    runs: obs.runs,
    lastText: obs.lastText ?? "",
    ...(obs.lastTextTruncated !== undefined ? { lastTextTruncated: obs.lastTextTruncated } : {}),
    settled: true,
    ...(obs.lastError !== undefined ? { lastError: obs.lastError } : {}),
  };
}

export interface ObservedWatch {
  /** The agent's state when the watch started. */
  initial: AgentObservation;
  /** The run count the watch waits past (ctl `afterRuns`). */
  afterRuns: number;
  /** Resolves when the run ends. A REJECTION (AgentRestartedError) is fatal:
   *  the incarnation the run belonged to is gone. */
  settled: Promise<AgentObservation>;
}
