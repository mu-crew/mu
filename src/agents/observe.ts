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
// `observeAgentStates` is one `readAgentStates` pass, and `watchAgentRun` is
// the probe + ctl `wait` + drop fallback that `cmdAgentWait` carried inline,
// moved here and returning observations. waitForEvents stays the only loop.
//
// Identity: `agentId` is the registry row id (a number, never reused);
// `incarnation` is pi's own string (`--inc`). They are different things
// and never substitute for one another.

import { dirname } from "node:path";
import type { RuntimeState, StateReading, StateSource } from "../agent-state.js";
import { agentKey, blockedReason, ctlRuntimeState, readAgentStates } from "../agent-state.js";
import type { AgentRow } from "../agents.js";
import type { SettledCloseInput } from "../close-block.js";
import { ctlProbe, ctlRequest } from "../ctl/client.js";
import { type CtlBlocked, INCARNATION_MISMATCH } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { AgentRestartedError } from "./errors.js";
import { type GateReading, readGate } from "./gate.js";
import { expectsCtl } from "./transport.js";

/** Who an observation is about. */
export type ObservedAgent = Pick<
  AgentRow,
  "name" | "workstreamName" | "paneId" | "cli" | "incarnation" | "gateToken"
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

/**
 * Watch a pi agent's current or next run end over its control socket: one
 * ctl `wait` that the extension answers on `agent_settled`. `afterRuns`
 * (else a status read taken BEFORE the wait: a followUp queued while busy
 * runs in the same pi run) is the baseline; `inc` pins the pi process.
 *
 * undefined when the agent has no control socket or it does not answer
 * (the caller polls it instead). `signal` aborts the wait (`settled` then
 * resolves unknown, never dead and never settled).
 */
export async function watchAgentRun(
  agent: ObservedAgent,
  sock: string,
  signal: AbortSignal,
  opts: { afterRuns?: number; inc?: string },
): Promise<ObservedWatch | undefined> {
  if (!expectsCtl(agent, sock)) return undefined;
  const base = {
    workstream: agent.workstreamName,
    name: agent.name,
    agentId: agent.incarnation,
    paneId: agent.paneId,
  };
  // With --after-runs the run past the baseline is the pending work: read
  // as busy until the wait settles; no status probe needed.
  let initial: AgentObservation = {
    ...base,
    status: "busy",
    source: "ctl",
    since: null,
    settled: false,
  };
  let afterRuns = opts.afterRuns;
  if (afterRuns === undefined) {
    const probe = await ctlProbe(sock);
    if (probe.kind !== "ok") return undefined;
    afterRuns = probe.status.runs;
    const { blocked } = probe.status;
    initial = {
      ...base,
      status: ctlRuntimeState(probe.status.state, blocked),
      source: "ctl",
      since: blocked?.since ?? probe.status.since,
      runs: probe.status.runs,
      pending: probe.status.pending,
      ...(probe.incarnation !== undefined ? { incarnation: probe.incarnation } : {}),
      ...(blocked !== undefined ? { blocked, reason: blockedReason(blocked) } : {}),
      settled: false,
    };
  }
  // returnOnBlocked: a dialog opening mid-run ends the wait instead of
  // holding it to --timeout. Older extensions ignore it.
  const req = {
    op: "wait",
    afterRuns,
    returnOnBlocked: true,
    ...(opts.inc !== undefined ? { incarnation: opts.inc } : {}),
  } as const;
  const restarted = (actual?: string): AgentRestartedError =>
    new AgentRestartedError(agent.name, agent.workstreamName, opts.inc ?? "", actual);
  const lost = (status: null | "unknown", reason?: string): AgentObservation => ({
    ...base,
    status,
    source: "ctl",
    since: null,
    ...(reason !== undefined ? { reason } : {}),
    settled: false,
  });
  const settled = ctlRequest(sock, req, { signal }).then(
    (reply): AgentObservation => {
      // A refused incarnation is fatal, never "unknown": the run is gone.
      if (!reply.ok && reply.error === INCARNATION_MISMATCH) throw restarted(reply.incarnation);
      if (!reply.ok) return lost("unknown", reply.error);
      const facts = {
        ...base,
        source: "ctl" as const,
        since: reply.since ?? null,
        ...(reply.incarnation !== undefined ? { incarnation: reply.incarnation } : {}),
        ...(reply.runs !== undefined ? { runs: reply.runs } : {}),
        ...(reply.pending !== undefined ? { pending: reply.pending } : {}),
      };
      if (reply.ended === "blocked" && reply.blocked !== undefined) {
        return {
          ...facts,
          status: "needs_permission",
          blocked: reply.blocked,
          reason: blockedReason(reply.blocked),
          settled: false,
        };
      }
      if (reply.state === undefined) return lost("unknown", "ctl wait: no state");
      return {
        ...facts,
        status: ctlRuntimeState(reply.state),
        // Only a reply that says it ended `settled` is a settled run; an
        // older extension's reply still fires the wait but never closes a task.
        settled: reply.ended === "settled",
        ...(reply.lastText !== undefined ? { lastText: reply.lastText } : {}),
        ...(reply.lastTextTruncated !== undefined
          ? { lastTextTruncated: reply.lastTextTruncated }
          : {}),
        ...(reply.lastError !== undefined ? { lastError: reply.lastError } : {}),
        ...(reply.sessionFile !== undefined ? { sessionFile: reply.sessionFile } : {}),
      };
    },
    // The connection dropped. A socket that still answers (pi's /new
    // restarts the session) hands back to polling; one that does not means
    // the pi that served it is gone. With `inc` an answering process must
    // also BE that incarnation: another one means the agent restarted and
    // the run is gone (fatal, never polled).
    async (): Promise<AgentObservation> => {
      if (signal.aborted) return lost("unknown");
      const again = await ctlProbe(sock);
      if (
        opts.inc !== undefined &&
        again.kind === "ok" &&
        again.incarnation !== undefined &&
        again.incarnation !== opts.inc
      ) {
        throw restarted(again.incarnation);
      }
      return again.kind === "ok" ? lost("unknown", "ctl wait interrupted") : lost(null);
    },
  );
  return { initial, afterRuns, settled };
}
