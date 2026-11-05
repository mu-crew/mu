// mu — the `ctl` channel: a pi agent read over its control socket.
//
// State is one `status` per agent (no hello) per read; the watch is one ctl
// `wait` that the extension answers on `agent_settled`; the baseline is a
// probe's run count and incarnation; a receipt is `status {msgId}`; the last
// text is a `wait` past the previous run, answered at once. The write fence
// (`beforeWrite`, CtlWriteVetoedError) and msgIds are ctl's, re-exported here
// for the callers that reserve and fence a send.

import type { RuntimeState, StateAgentRef, StateReading } from "../agent-state.js";
import { agentKey, UNKNOWN_REASON, unknownReading } from "../agent-state.js";
import { AgentRestartedError } from "../agents/errors.js";
import type { AgentObservation, ObservedAgent, ObservedWatch } from "../agents/observe.js";
import { ctlProbe, ctlRequest } from "../ctl/client.js";
import { ctlSocketPath } from "../ctl/path.js";
import { type CtlBlocked, type CtlState, INCARNATION_MISMATCH } from "../ctl/protocol.js";
import { activeMux } from "../mux.js";
import { expectsCtl } from "./select.js";
import type {
  AgentChannel,
  ChannelReadOptions,
  ChannelTarget,
  MessageCheck,
  RunBaseline,
} from "./types.js";

export { CTL_DEFAULT_TIMEOUT_MS, CtlWriteVetoedError, newMsgId } from "../ctl/client.js";

/** Per-agent budget for the control-socket status read (one connection). */
const CTL_STATE_PROBE_MS = 1000;

/** The one `status {msgId}` probe a failed send gets, and `mu agent check`. */
const MSG_PROBE_MS = 5000;

/** ctl's idle maps to needs_input, the same as murmur's idle; an open
 *  extension dialog (`blocked`) maps to needs_permission. */
export function ctlRuntimeState(state: CtlState, blocked?: CtlBlocked): RuntimeState {
  if (blocked !== undefined) return "needs_permission";
  return state === "busy" ? "busy" : "needs_input";
}

/** The reason line for a dialog-blocked pi: `dialog <kind>: <title>`. */
export function blockedReason(blocked: CtlBlocked): string {
  return `dialog ${blocked.kind}${blocked.title !== undefined ? `: ${blocked.title}` : ""}`;
}

const socketOf = (t: ChannelTarget): string =>
  ctlSocketPath(t.agent.workstreamName, t.agent.name, t.stateDir);

/** One status probe per agent; a socket that does not answer reads `unknown` with its link. */
async function readCtlStates(
  agents: readonly StateAgentRef[],
  opts: ChannelReadOptions,
): Promise<Map<string, StateReading>> {
  const probes = await Promise.all(
    agents.map((a) =>
      ctlProbe(ctlSocketPath(a.workstreamName, a.name, opts.stateDir), CTL_STATE_PROBE_MS, {
        hello: false,
      }),
    ),
  );
  const readings = new Map<string, StateReading>();
  agents.forEach((agent, i) => {
    const probe = probes[i];
    if (probe?.kind === "ok") {
      const { blocked } = probe.status;
      readings.set(agentKey(agent), {
        state: ctlRuntimeState(probe.status.state, blocked),
        source: "ctl",
        since: blocked?.since ?? probe.status.since,
        alive: true,
        ...(blocked !== undefined ? { reason: blockedReason(blocked), blocked } : {}),
        ctl: "ok",
        pending: probe.status.pending,
        runs: probe.status.runs,
        ...(probe.incarnation !== undefined ? { incarnation: probe.incarnation } : {}),
        ...(probe.status.tool !== undefined ? { tool: probe.status.tool } : {}),
      });
    } else {
      const ctl = probe?.kind === "missing" ? "missing" : "refused";
      const reason = ctl === "missing" ? UNKNOWN_REASON.ctlMissing : UNKNOWN_REASON.ctlRefused;
      readings.set(agentKey(agent), { ...unknownReading(reason), ctl });
    }
  });
  return readings;
}

/**
 * Whether the pane still holds a running agent: tmux, the pane runs (an
 * exited retained pane does not); herdr, an agent still occupies the pane
 * (it outlives its occupant as a shell). `undefined` when the mux cannot
 * say: unknown, never a death.
 */
async function paneUp(paneId: string): Promise<boolean | undefined> {
  try {
    const mux = await activeMux();
    if (mux.paneResult !== undefined) return (await mux.paneResult(paneId)).state === "running";
    if (mux.paneOccupied !== undefined) return await mux.paneOccupied(paneId);
    return await mux.paneAlive(paneId);
  } catch {
    return undefined;
  }
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
      if (again.kind === "ok") return lost("unknown", "ctl wait interrupted");
      // No answer is not a death while the pane is up: a remote agent's socket
      // is a forward that a dropped connection (a lease's mule master) takes
      // down while the pane and the job on the host live on. Only a pane that
      // is gone (or unreadable as alive) is a dead pi.
      const up = await paneUp(agent.paneId);
      if (up === undefined) return lost("unknown", "control socket lost; the mux cannot say");
      return up ? lost("unknown", "control socket lost; the pane is alive") : lost(null);
    },
  );
  return { initial, afterRuns, settled };
}

/**
 * Ask the extension whether it accepted the send/fresh/interrupt that
 * carried `msgId`: one `status {msgId}` request. Never throws: a socket
 * that is silent, missing, or an extension that does not answer with a
 * `msg` is `unreachable`, which is not the same as `not-accepted`.
 */
export async function checkMessage(
  sock: string,
  msgId: string,
  timeoutMs: number = MSG_PROBE_MS,
): Promise<MessageCheck> {
  try {
    const r = await ctlRequest(sock, { op: "status", msgId }, { timeoutMs });
    if (!r.ok) return { state: "unreachable", id: msgId, reason: r.error };
    if (r.msg === undefined) {
      return { state: "unreachable", id: msgId, reason: "the extension does not report receipts" };
    }
    if (!r.msg.accepted) return { state: "not-accepted", id: msgId };
    return {
      state: "accepted",
      id: msgId,
      ...(r.msg.runs !== undefined ? { runs: r.msg.runs } : {}),
      ...(r.msg.at !== undefined ? { at: r.msg.at } : {}),
      ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
    };
  } catch (e) {
    return { state: "unreachable", id: msgId, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The probed run count and incarnation; undefined when the agent is not on ctl or does not answer. */
async function ctlBaseline(t: ChannelTarget): Promise<RunBaseline | undefined> {
  const sock = socketOf(t);
  if (!expectsCtl(t.agent, sock)) return undefined;
  const probe = await ctlProbe(sock);
  if (probe.kind !== "ok") return undefined;
  return {
    runs: probe.status.runs,
    ...(probe.incarnation !== undefined ? { incarnation: probe.incarnation } : {}),
  };
}

/** The ctl `wait` past `afterRuns`, bounded by `ms` (a settled run is answered at once). */
async function ctlLastRun(
  t: ChannelTarget,
  o: { afterRuns: number; inc?: string; signal?: AbortSignal; ms: number },
): Promise<AgentObservation | undefined> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), o.ms);
  const onAbort = (): void => stop.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const watch = await watchAgentRun(t.agent, socketOf(t), stop.signal, {
      afterRuns: o.afterRuns,
      ...(o.inc !== undefined ? { inc: o.inc } : {}),
    });
    return watch === undefined ? undefined : await watch.settled;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

export const ctlChannel: AgentChannel = {
  name: "ctl",
  fence: true,
  readStates: readCtlStates,
  watch: (t, signal, opts) => watchAgentRun(t.agent, socketOf(t), signal, opts),
  baseline: ctlBaseline,
  receipt: (t, msgId, timeoutMs) => checkMessage(socketOf(t), msgId, timeoutMs),
  lastRun: ctlLastRun,
};
