// mu — the AgentChannel seam: how mu reads a pane agent (spec D4).
//
// A pane agent is reached through exactly one channel. `ctl` is pi's control
// socket: exact state, a blocking watch of a run's end, run baselines, msgId
// receipts, a write fence and the settled run's text. `hooks` is a hook
// harness's pane on tmux: state from murmur's pane inbox, delivery by paste,
// confirmed by the harness's `run_count`. `mux` is what the multiplexer and
// murmur report for any other pane: state only, polled. The
// wait engine (src/wait.ts) reads agents through this seam
// (`WaitOptions.readAgents` / `watchAgent`, built in src/wait-ctl.ts).
//
// Delivery goes through the same seam: send, fresh, `command` (pi's session
// commands), interrupt, abort and answer. Each agents row records its channel at spawn
// (`agents.channel`), and every verb reads it from the row. Delegates, the
// spawn handshake, doctor and the remote socket plumbing stay on src/ctl
// directly.

import type { StateAgentRef, StateReading } from "../agent-state.js";
import type { AgentObservation, ObservedAgent, ObservedWatch } from "../agents/observe.js";
import type { AgentRow } from "../agents.js";
import type { CtlCommandName, CtlState } from "../ctl/protocol.js";
import type { SendOptions } from "../mux.js";

/** The ctl protocol's state facts, as the rest of mu names them. */
export type { CtlBlocked, CtlCommandName, CtlState, CtlTool } from "../ctl/protocol.js";

/** How mu reaches a pane agent; also the values of `agents.channel`. */
export type ChannelName = "ctl" | "hooks" | "mux";

/** The values `agents.channel` may hold, in the order a row is checked. */
export const CHANNEL_NAMES: readonly ChannelName[] = ["ctl", "hooks", "mux"];

/**
 * One agent on a channel: who it is, and the state dir that roots its control
 * socket. `socket` overrides the derived socket path (a caller that already
 * holds it, or a test's fake extension).
 */
export interface ChannelTarget {
  agent: ObservedAgent;
  stateDir?: string;
  socket?: string;
}

/** A delivery's target: the whole agents row, which the typed errors and recovery hints name. */
export interface DeliveryTarget extends ChannelTarget {
  agent: AgentRow;
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

export interface AgentChannel extends ChannelDelivery {
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

/** What a delivery did. The ctl-only fields are absent on `hooks` and `mux`. */
export type SendResult = {
  transport: ChannelName;
  /**
   * hooks only: `confirmed` when the agent's `run_count` rose (or a new
   * session started a run) within `MU_SEND_ACK_MS` of the paste, else
   * `unknown`. An `unknown` send is never resent.
   */
  ack?: "confirmed" | "unknown";
  /** hooks only: the agent's `run_count` at the ack, else the one the gate read before the paste. */
  runCount?: number;
  /** hooks only: the harness session the run count belongs to. */
  sessionId?: string;
  state?: CtlState;
  /**
   * ctl only: pi's completed-run count. For a plain send it is measured
   * before dispatch (the `mu agent wait --after-runs` baseline); for
   * `--fresh` it is the new session's count once its run started.
   * Absent from an extension that predates it.
   */
  runs?: number;
  /** ctl only: when pi entered `state` (epoch ms), from the same status. */
  since?: number;
  /** ctl only: pi's session file, from the same status. */
  sessionFile?: string;
  /** Set when the text ran as a pi session command over ctl. */
  command?: CtlCommandName;
  /** ctl send/fresh/interrupt: the id this send carried; `mu agent check` asks about it later. */
  msgId?: string;
  /** ctl only: the pi process's incarnation, the `--inc` for `mu agent wait`. */
  incarnation?: string;
  /** Set when the reply never arrived and a `status {msgId}` probe confirmed the send landed. */
  receipt?: "confirmed-after-timeout";
};

/** See DeliveryOptions.ctlGuard. */
export interface CtlGuard {
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeWrite?: () => boolean;
}

export type DeliveryOptions = SendOptions & {
  /** How a busy pi queues the message. Default followUp. ctl only: hooks refuses a steer. */
  mode?: "steer" | "followUp";
  /**
   * With fresh or a session command: abandon a running turn instead of
   * refusing. On hooks also a plain send: paste into a running agent, or one
   * whose state is unknown (never into a blocked one).
   */
  force?: boolean;
  /**
   * Internal: a msgId the caller reserved (and journaled) BEFORE the send, so
   * a crash leaves a receipt a later `status {msgId}` can ask about. ctl
   * send/fresh only; absent, the send mints its own. Never reuse one that was
   * already written: a saved id is checked, never resent.
   */
  msgId?: string;
  /**
   * Internal: the ctl incarnation the caller's own handshake saw (a spawn's
   * hello). The send is refused, nothing written, when the socket's pi is
   * another process (AgentReplacedError); the extension re-checks it
   * atomically with the dispatch (`expectIncarnation`). ctl send/fresh only.
   */
  expectIncarnation?: string;
  /**
   * Internal, opt-in (a stall action): bound the ctl round trips and fence the
   * write. `signal` aborts the hello and the request (an abort before the
   * write writes nothing; after it the delivery is indeterminate and probed,
   * never resent); `timeoutMs` bounds each ctl request; `beforeWrite` runs
   * synchronously on connect, immediately before the one write: false or a
   * throw writes nothing and the send throws CtlWriteVetoedError. ctl
   * send only; a route that cannot honour it (mux, session command) refuses rather than skip it.
   */
  ctlGuard?: CtlGuard;
};

/** A pi session command: `/new`, `/reload`, or `/compact` with optional instructions. */
export interface SessionCommand {
  name: CtlCommandName;
  instructions?: string;
}

export type InterruptResult = {
  /** The channel that carried it; absent from ctl, which predates the field. */
  transport?: ChannelName;
  /** The agent was busy, so its turn was aborted before the send. */
  wasBusy: boolean;
  /** pi had queued messages before the abort; pi put them back in the pane's editor. */
  pending: boolean;
  /**
   * Settled runs before the text's run started: the `mu agent wait
   * --after-runs` baseline for the run the text starts. On hooks, set only
   * when the paste was confirmed (its `run_count` less one).
   */
  runs?: number;
  /** ctl only: the id the interrupt carried: `mu agent check <agent> <msgId>` asks whether it landed. */
  msgId?: string;
  /** pi's incarnation (the `--inc` for `mu agent wait`); on hooks, the harness session of the text's run. */
  incarnation?: string;
  /** ctl only: set when the reply never arrived and `status {msgId}` confirmed the interrupt landed. */
  receipt?: "confirmed-after-timeout";
  /**
   * hooks only, when the agent was busy: `confirmed` when the harness itself
   * reported the stop (codex's and muse's `Interrupt`, cursor-agent's aborted
   * `stop`, or a turn that ended on its own), `unconfirmed` when it reports
   * none (claude): mu wrote `interrupted`, which murmur reads as `idle?`.
   */
  stopped?: "confirmed" | "unconfirmed";
  /** hooks only: the text's paste, confirmed by `run_count` as a send is (SendResult.ack). */
  ack?: "confirmed" | "unknown";
  /** hooks only: the agent's `run_count` at the ack, else the one read before the paste. */
  runCount?: number;
  /** hooks only: the harness session the run count belongs to. */
  sessionId?: string;
};

/** What an abort found and did. */
export interface AbortOutcome {
  before: CtlState;
  after: CtlState;
  /** True when pi settled (or was never busy). */
  settled: boolean;
  /** False when the agent was not busy, so no abort was sent. */
  aborted: boolean;
  /** pi had queued messages before the abort (pi returns them to the editor). */
  pending: boolean;
  /** hooks only, when an abort was sent: as InterruptResult.stopped (`unconfirmed`: settled is false). */
  stopped?: "confirmed" | "unconfirmed";
}

/** What `mu agent answer` did. */
export interface AnswerResult {
  transport: ChannelName;
  /** The keys typed into the pane. */
  keys: readonly string[];
  /**
   * `confirmed` when the next hook event arrived within `MU_SEND_ACK_MS`
   * (hooks), else `unknown`; a channel with no events (mux) reads `unknown`.
   */
  ack: "confirmed" | "unknown";
}

/**
 * The delivery verbs of a channel (spec D4). A channel that cannot do one
 * refuses with a typed error naming the agent's cli, and never falls back to
 * another channel.
 */
export interface ChannelDelivery {
  /**
   * Deliver `text` as a prompt. On ctl an empty text is refused, a session
   * command runs as `command`, and any other slash command is refused.
   */
  send(target: DeliveryTarget, text: string, opts: DeliveryOptions): Promise<SendResult>;
  /** Start a new session and send `text` into it, as one step. */
  fresh(target: DeliveryTarget, text: string, opts: DeliveryOptions): Promise<SendResult>;
  /** Run a session command (`/new`, `/reload`, `/compact`). */
  command(
    target: DeliveryTarget,
    cmd: SessionCommand,
    opts: { force?: boolean; expectIncarnation?: string },
  ): Promise<SendResult>;
  /**
   * Abort a running turn, wait for the agent to settle (AgentAbortTimeoutError
   * after `timeoutMs`, text not sent), then send `text` as a new run.
   */
  interrupt(
    target: DeliveryTarget,
    text: string,
    opts: { timeoutMs: number; expectIncarnation?: string },
  ): Promise<InterruptResult>;
  /**
   * Stop the current turn and wait for it to settle. An agent that is not
   * busy gets no abort. `onAbort` runs once, only when an abort was sent.
   */
  abort(
    target: DeliveryTarget,
    opts: {
      timeoutMs: number;
      onAbort?: (o: { before: CtlState; pending: boolean }) => Promise<void>;
    },
  ): Promise<AbortOutcome>;
  /**
   * Answer a pending permission dialog by typing `keys` into the pane. On
   * hooks it is refused unless the agent reads `blocked` (`force` skips that
   * check). A channel that cannot type keys refuses with a typed error.
   */
  answer(
    target: DeliveryTarget,
    keys: readonly string[],
    opts: { force?: boolean },
  ): Promise<AnswerResult>;
}
