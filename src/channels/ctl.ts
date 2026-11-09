// mu — the `ctl` channel: a pi agent read over its control socket.
//
// State is one `status` per agent (no hello) per read; the watch is one ctl
// `wait` that the extension answers on `agent_settled`; the baseline is a
// probe's run count and incarnation; a receipt is `status {msgId}`; the last
// text is a `wait` past the previous run, answered at once. Delivery (send,
// fresh, command, interrupt, abort) is in ./ctl-deliver.ts. The write fence
// (`beforeWrite`, CtlWriteVetoedError) and msgIds are ctl's, re-exported here
// for the callers that reserve and fence a send.

import type { RuntimeState, StateAgentRef, StateReading } from "../agent-state.js";
import { agentKey, UNKNOWN_REASON } from "../agent-state.js";
import { AgentRestartedError } from "../agents/errors.js";
import type { AgentObservation, ObservedAgent, ObservedWatch } from "../agents/observe.js";
import { ctlProbe, ctlRequest } from "../ctl/client.js";
import { ctlSocketPath } from "../ctl/path.js";
import { type CtlBlocked, type CtlState, INCARNATION_MISMATCH } from "../ctl/protocol.js";
import { stateRefJob, withJobLiveness } from "../jobs/kinds.js";
import { paneUp } from "../jobs/pane.js";
import { checkMessage, ctlDelivery } from "./ctl-deliver.js";
import { expectsCtl, targetSocket } from "./select.js";
import type {
  AgentChannel,
  ChannelCaps,
  ChannelReading,
  ChannelReadOptions,
  ChannelSendReply,
  ChannelTarget,
  InterruptResult,
  RunBaseline,
  SendResult,
  SentFacts,
} from "./types.js";

export { CTL_DEFAULT_TIMEOUT_MS, CtlWriteVetoedError, newMsgId } from "../ctl/client.js";
export { checkMessage } from "./ctl-deliver.js";

/** Per-agent budget for the control-socket status read (one connection). */
const CTL_STATE_PROBE_MS = 1000;

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

/** One status probe per agent; a socket that does not answer reads `unknown` with its link. */
async function readCtlTurns(
  agents: readonly StateAgentRef[],
  opts: ChannelReadOptions,
): Promise<Map<string, ChannelReading>> {
  const probes = await Promise.all(
    agents.map((a) =>
      ctlProbe(ctlSocketPath(a.workstreamName, a.name, opts.stateDir), CTL_STATE_PROBE_MS, {
        hello: false,
      }),
    ),
  );
  const readings = new Map<string, ChannelReading>();
  for (const [i, agent] of agents.entries()) {
    const probe = probes[i];
    if (probe?.kind === "ok") {
      const { blocked } = probe.status;
      readings.set(agentKey(agent), {
        state: ctlRuntimeState(probe.status.state, blocked),
        source: "ctl",
        since: blocked?.since ?? probe.status.since,
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
      readings.set(agentKey(agent), { state: "unknown", source: "none", since: null, reason, ctl });
    }
  }
  return readings;
}

/** The turn read, each reading's liveness the job's (`withJobLiveness`). */
async function readCtlStates(
  agents: readonly StateAgentRef[],
  opts: ChannelReadOptions,
): Promise<Map<string, StateReading>> {
  const turns = await readCtlTurns(agents, opts);
  const readings = new Map<string, StateReading>();
  for (const a of agents) {
    const turn = turns.get(agentKey(a));
    if (turn !== undefined) readings.set(agentKey(a), await withJobLiveness(turn, stateRefJob(a)));
  }
  return readings;
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

/** The probed run count and incarnation; undefined when the agent is not on ctl or does not answer. */
async function ctlBaseline(t: ChannelTarget): Promise<RunBaseline | undefined> {
  const sock = targetSocket(t);
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
    const watch = await watchAgentRun(t.agent, targetSocket(t), stop.signal, {
      afterRuns: o.afterRuns,
      ...(o.inc !== undefined ? { inc: o.inc } : {}),
    });
    return watch === undefined ? undefined : await watch.settled;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** The ctl channel's row of the D9 matrix. Its receipts keep the last 64 msgIds (protocol.ts). */
const CTL_CAPS: ChannelCaps = {
  fence: "sync",
  receipt: "exact",
  steer: "mid-turn",
  interrupt: "exact",
  fresh: "in-place",
  answer: false,
  command: true,
  watch: "stream",
  settleText: "tied",
};

/** pi's run count measured before the send (with its incarnation); none: the send started no run (a session command). */
function ctlSendRun(sent: SentFacts): ChannelSendReply | null {
  if (sent.runs === undefined) return null;
  return {
    channel: "ctl",
    ack: "exact",
    ...(sent.msgId !== undefined ? { msgId: sent.msgId } : {}),
    baseline: {
      runs: sent.runs,
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
    },
  };
}

function describeCtlSend(sent: SendResult, o: { fresh?: boolean }): string {
  if (o.fresh) return "via ctl, fresh session";
  if (sent.command !== undefined) return `via ctl, pi ran /${sent.command}`;
  if (sent.runs !== undefined) return `via ctl, pi was ${sent.state ?? "?"}, runs ${sent.runs}`;
  return `via ctl, pi ${sent.state ?? "?"}`;
}

function describeCtlInterrupt(r: InterruptResult): string {
  const what = r.wasBusy ? "interrupted a busy run" : "pi was idle";
  const runs = r.runs !== undefined ? `, runs ${r.runs}` : "";
  return `via ctl, ${what}${runs}`;
}

export const ctlChannel: AgentChannel = {
  name: "ctl",
  caps: CTL_CAPS,
  fence: CTL_CAPS.fence === "sync",
  sendRun: ctlSendRun,
  describeSend: describeCtlSend,
  describeInterrupt: describeCtlInterrupt,
  readStates: readCtlStates,
  watch: (t, signal, opts) => watchAgentRun(t.agent, targetSocket(t), signal, opts),
  baseline: ctlBaseline,
  receipt: (t, msgId, timeoutMs) => checkMessage(targetSocket(t), msgId, timeoutMs),
  lastRun: ctlLastRun,
  ...ctlDelivery,
};
