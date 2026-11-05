// mu — the AgentChannel seam: how mu reads a pane agent (spec D4).
//
// A pane agent is reached through exactly one channel. `ctl` is pi's control
// socket: exact state, a blocking watch of a run's end, run baselines, msgId
// receipts, a write fence and the settled run's text. `mux` is what the
// multiplexer and murmur report for any other pane: state only, polled. The
// wait engine (src/wait.ts) reads agents through this seam
// (`WaitOptions.readAgents` / `watchAgent`, built in src/wait-ctl.ts).
//
// Delivery (send, interrupt, fresh, command) still goes through
// src/agents/transport.ts. Delegates, the spawn handshake, doctor and the
// remote socket plumbing stay on src/ctl directly.

import type { StateAgentRef, StateReading } from "../agent-state.js";
import type { AgentObservation, ObservedAgent, ObservedWatch } from "../agents/observe.js";

/** The ctl protocol's state facts, as the rest of mu names them. */
export type { CtlBlocked, CtlState, CtlTool } from "../ctl/protocol.js";

/** How mu reaches a pane agent. */
export type ChannelName = "ctl" | "mux";

/** One agent on a channel: who it is, and the state dir that roots its control socket. */
export interface ChannelTarget {
  agent: ObservedAgent;
  stateDir: string;
}

/** The run a wait counts from: the settled-run count, and pi's process when the channel names one. */
export interface RunBaseline {
  runs: number;
  incarnation?: string;
}

/**
 * Whether the channel accepted the message that carried `msgId`. `unreachable`
 * (no answer, or a channel without receipts) is not `not-accepted`.
 */
export type MessageCheck =
  | { state: "accepted"; id: string; runs?: number; at?: number; incarnation?: string }
  | { state: "not-accepted"; id: string }
  | { state: "unreachable"; id: string; reason: string };

export interface ChannelReadOptions {
  now?: number;
  /** Roots the derived control socket path (spawn uses the DB's directory). */
  stateDir?: string;
  /** Keys (`<workstream>/<name>`) whose state another channel owns: read only whether the pane is alive. */
  livenessOnly?: ReadonlySet<string>;
}

export interface AgentChannel {
  readonly name: ChannelName;
  /**
   * True when a write can carry a synchronous fence (ctl's `beforeWrite`:
   * a veto writes nothing). A channel without one gets at-most-once only by
   * never resending.
   */
  readonly fence: boolean;
  /**
   * One batched, non-blocking state read of agents on this channel, keyed
   * `<workstream>/<name>`. A ctl agent whose socket does not answer reads
   * `unknown` with its `ctl` link (`missing`, `refused`).
   */
  readStates(
    agents: readonly StateAgentRef[],
    opts: ChannelReadOptions,
  ): Promise<Map<string, StateReading>>;
  /**
   * Watch the agent's current or next run end past `afterRuns` (pinned to
   * pi's process by `inc`). undefined: the channel cannot watch, so the
   * caller polls `readStates`. A rejection of `settled` is fatal (the agent
   * restarted).
   */
  watch(
    target: ChannelTarget,
    signal: AbortSignal,
    opts: { afterRuns?: number; inc?: string },
  ): Promise<ObservedWatch | undefined>;
  /** The run count a wait counts from now; undefined when the channel has none or does not answer. */
  baseline(target: ChannelTarget): Promise<RunBaseline | undefined>;
  /** Ask whether the message that carried `msgId` was accepted. Never throws. */
  receipt(target: ChannelTarget, msgId: string, timeoutMs?: number): Promise<MessageCheck>;
  /**
   * The last text: the already settled run past `afterRuns` (its text,
   * error and counts), read within `ms`. undefined when the channel has no
   * text. Callers check `settled` on the result. A restarted agent rejects
   * with AgentRestartedError.
   */
  lastRun(
    target: ChannelTarget,
    opts: { afterRuns: number; inc?: string; signal?: AbortSignal; ms: number },
  ): Promise<AgentObservation | undefined>;
}
