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

import type { RuntimeState, StateAgentRef, StateReading } from "../agent-state.js";
import type { AgentObservation, ObservedAgent, ObservedWatch } from "../agents/observe.js";
import type { AgentRow } from "../agents.js";
import type { CtlCommandName, CtlState } from "../ctl/protocol.js";
import type { JobGone } from "../jobs/kinds.js";
import type { JobRef } from "../jobs/types.js";
import type { SendOptions } from "../mux.js";

/** The ctl protocol's state facts, as the rest of mu names them. */
export type { CtlBlocked, CtlCommandName, CtlState, CtlTool } from "../ctl/protocol.js";

/** The built-in channels; also the values `agents.channel` may hold today. */
export type BuiltinChannelName = "ctl" | "hooks" | "mux";

/**
 * How mu reaches an agent: a name in the channel registry (./registry.ts).
 * Open, so a registered channel's name is one; a stored name the registry
 * does not know still reads null from the row (plugins spec D9).
 */
export type ChannelName = BuiltinChannelName | (string & {});

/** The values `agents.channel` may hold, in the order a row is checked. */
export const CHANNEL_NAMES: readonly BuiltinChannelName[] = ["ctl", "hooks", "mux"];

/**
 * What a channel can do (plugins spec D9, D12), declared once in code for a
 * built-in. Callers branch on these, never on the channel's name; the
 * contract suite holds each built-in to its row of the D9 matrix.
 */
export interface ChannelCaps {
  /** `sync`: an in-process veto runs immediately before the one write (ctl's `beforeWrite`). */
  fence: "sync" | "none";
  /** `exact`: answers by msgId. `acknowledged`: a turn past the journaled run baseline. */
  receipt: "exact" | "acknowledged" | "none";
  /** Per delivery method: only the methods listed dedupe a repeat with the same key (D4). */
  dedupe?: Partial<
    Record<"send" | "fresh" | "interrupt" | "answer" | "command", { exact: true; windowMs: number }>
  >;
  /** `mid-turn`: a steer joins the running turn; `as-send`: sent as plain text; `none`: refused. */
  steer: "mid-turn" | "as-send" | "none";
  /** `exact`: the stop is confirmed; `unconfirmed`: it may read `idle?`; `none`: refused. */
  interrupt: "exact" | "unconfirmed" | "none";
  /** `in-place`: a new session in the same job; `new-job`: close then spawn; `none`: refused. */
  fresh: "in-place" | "new-job" | "none";
  /** Keys reach a pending dialog (`mu agent answer`). */
  answer: boolean;
  /** Session commands run (`/new`, `/reload`, `/compact`). */
  command: boolean;
  /** `stream`: one watch per turn; `poll`: mu polls `readStates`. */
  watch: "stream" | "poll";
  /** `tied`: the last text is the settled turn's own; CLOSE blocks apply only then. */
  settleText: "tied" | "untied" | "none";
}

/**
 * One agent on a channel: who it is, and the state dir that roots its control
 * socket. `socket` overrides the derived socket path (a caller that already
 * holds it, or a test's fake extension).
 */
export interface ChannelTarget {
  agent: ObservedAgent;
  stateDir?: string;
  socket?: string;
  /**
   * A remote hook harness worker (spec D11): its state lives on its host and
   * reaches the local pane's inbox only through this reader. Set by
   * `channelTarget` for a `hooks` row with a remote key.
   */
  remote?: RemoteReader;
  /**
   * The agent's job as its row records it (plugins spec D9, D13), filled by
   * `channelTarget`: its kind and view pane, and its host. A lease job's
   * handle lives in its carrier's job file, not the row, so it is absent here.
   */
  job?: JobRef;
}

/**
 * What a remote worker's node reported on one read (`murmur pane --remote
 * <key> --json`), after its events were relayed into the local pane's inbox.
 */
export interface RemoteSnapshot {
  /** murmur's word for the worker (`working`, `idle`, `idle?`, `blocked`, ...); null: nothing claimed the key. */
  state: string | null;
  harness: string | null;
  sessionId: string | null;
  runCount: number | null;
  /** `running` or `stopped`; null: no harness ever claimed the key. */
  activity: string | null;
  lastText: string | null;
  /**
   * The run of the turn that wrote `lastText`, as murmur on the node names it
   * (`last_text_run`); null: no turn of the session has. undefined: a murmur
   * there too old to name it.
   */
  lastTextRun?: number | null;
  /** False after an interrupt mu wrote that no harness event has confirmed. */
  confirmed: boolean;
  /** Whether a live harness holds the key; a released key keeps its last turn. */
  claimed: boolean;
  /** The attention kinds the worker carries (`blocked`, `error`, `done`). */
  attention: string[];
  /** The pending dialog's message, when the worker is blocked. */
  blocked: string | null;
  /** The `error` attention's message, when the worker carries one. */
  error: string | null;
  /**
   * Whether `lastText` is the last ended turn's own: `lastTextRun` is
   * `runCount`, or, from a murmur that does not name it, mu saw the
   * `turn_stopped` that carried it arrive in run `runCount` of `sessionId`.
   * False when that turn ended without text (an interrupt, a failure) and
   * murmur kept an earlier turn's, or when neither can tell.
   */
  textTied: boolean;
  /** The events this read applied (and relayed), oldest first. */
  events: number;
  /** Of those, the ones the harness wrote (not mu). */
  harnessEvents: number;
}

export type RemoteReadResult =
  | { ok: true; snapshot: RemoteSnapshot }
  | { ok: false; reason: string };

/**
 * Reads a remote hook harness worker's state on its node through the host
 * profile's `exec` template and relays the events it applied into the local
 * (ssh or carrier) pane's inbox with `murmur hook mu --pane` (spec D11). One
 * exec per read, so only a wait, a collect and a send gate read: never an ack
 * poll.
 */
export interface RemoteReader {
  readonly host: string;
  readonly key: string;
  /**
   * Read now, or reuse a successful read younger than `maxAgeMs`. `write`
   * first records one of mu's own events on the node (`murmur hook mu
   * --remote`, an interrupt it sent) in the same exec.
   */
  read(opts?: { maxAgeMs?: number; write?: Record<string, unknown> }): Promise<RemoteReadResult>;
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

/**
 * What a channel's own read reports: turn state and its link to the agent's
 * process (`ctl`), never `alive` (a reading that carries one does not
 * typecheck). Liveness is the job's word (`withJobLiveness`, src/jobs/kinds.ts),
 * applied by the channel layer (./compose.ts), never by a channel.
 */
export type ChannelReading = Omit<StateReading, "alive"> & { readonly alive?: never };

/**
 * An observation as a channel's watch reports it: a dead agent is only the
 * job's verdict (`JobGone`, minted by `jobUp`), never a `null` the channel
 * writes. `jobObservation` makes it the wait's AgentObservation.
 */
export type ChannelObservation = Omit<AgentObservation, "status"> & {
  status: RuntimeState | JobGone;
};

/** A channel's watch (see ObservedWatch), its observations the channel's. */
export interface ChannelWatch {
  initial: ChannelObservation;
  afterRuns?: number;
  settled: Promise<ChannelObservation>;
}

export interface ChannelReadOptions {
  now?: number;
  /** Roots the derived control socket path (spawn uses the DB's directory). */
  stateDir?: string;
  /** Keys (`<workstream>/<name>`) whose state another channel owns: read only whether the pane is alive. */
  livenessOnly?: ReadonlySet<string>;
}

/**
 * What a delivery reported, as a wait counts the run it started: a SendResult,
 * an InterruptResult, or a saved receipt's fields.
 */
export interface SentFacts {
  transport?: ChannelName;
  runs?: number;
  incarnation?: string;
  ack?: "confirmed" | "unknown" | "sent";
  runCount?: number;
  sessionId?: string;
  msgId?: string;
}

/**
 * A delivery's reply in the normalized form (plugins spec D9, D13): the
 * internal channel contract a plugin channel answers in, and the form each
 * built-in's result converts to (`AgentChannel.sendRun`). `ack`: `exact` (a
 * receipt by msgId), `acknowledged` (the agent's own turn count confirmed it,
 * or will), `none`. `baseline`: the turns settled before the run it started
 * (absent: its wait is owed with none, a busy-to-idle). The CLI's `--json`
 * still prints today's SendResult (`toSendResult`).
 */
export interface ChannelSendReply {
  channel: ChannelName;
  ack: "exact" | "acknowledged" | "none";
  baseline?: RunBaseline;
  msgId?: string;
}

/** The run a delivery started, as the wait it owes counts it (a reply's `baseline`). */
export interface SentRun {
  baseline?: RunBaseline;
}

/**
 * What a channel implements (the seam, plugins spec D9). Its reads report turn
 * state and links only: `readTurns` returns ChannelReadings (no `alive`), and
 * its watch reports a dead agent only on the job's verdict. The registry
 * serves it as an AgentChannel (`composeChannel`, ./compose.ts).
 */
export interface ChannelImpl extends ChannelDelivery {
  readonly name: ChannelName;
  /** What this channel can do (plugins spec D9). */
  readonly caps: ChannelCaps;
  /**
   * `caps.fence === "sync"`: a write can carry a synchronous fence (ctl's
   * `beforeWrite`: a veto writes nothing). A channel without one gets
   * at-most-once only by never resending.
   */
  readonly fence: boolean;
  /**
   * What a delivery on this channel reported, as the normalized reply
   * (ChannelSendReply). null: the delivery started no run (a ctl session command).
   */
  sendRun(sent: SentFacts): ChannelSendReply | null;
  /** How a delivered send went, for the `sent N bytes to <agent> (...)` line. */
  describeSend(sent: SendResult, o: { fresh?: boolean }): string;
  /** How a delivered interrupt went, for the same line. */
  describeInterrupt(r: InterruptResult): string;
  /**
   * The channel's own batched, non-blocking read of its agents, keyed
   * `<workstream>/<name>`: turn state and its link (a ctl agent whose socket
   * does not answer reads `unknown` with `ctl` `missing` or `refused`).
   * `base`: the channel's state is the shared pane read (murmur's pane
   * options, the multiplexer's status), read with the view in one batch.
   */
  readonly readTurns:
    | ((
        agents: readonly StateAgentRef[],
        opts: ChannelReadOptions,
      ) => Promise<Map<string, ChannelReading>>)
    | "base";
  /**
   * Watch the agent's current or next run end past `afterRuns` (pinned to
   * pi's process by `inc`). undefined: the channel cannot watch, so the
   * caller polls. A rejection of `settled` is fatal (the agent restarted).
   */
  watch(
    target: ChannelTarget,
    signal: AbortSignal,
    opts: { afterRuns?: number; inc?: string },
  ): Promise<ChannelWatch | undefined>;
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
  ): Promise<ChannelObservation | undefined>;
}

/**
 * A channel as mu reaches it: the implementation, with its reads composed by
 * the channel layer (`composeChannel`), where the job decides liveness. The
 * composed members are read-only: no caller replaces them.
 */
export interface AgentChannel extends Omit<ChannelImpl, "watch" | "lastRun"> {
  /**
   * One batched, non-blocking state read of agents on this channel, keyed
   * `<workstream>/<name>`: the channel's turn read, its liveness the job's
   * (`withJobLiveness`). A ctl agent whose socket does not answer reads
   * `unknown` with its `ctl` link (`missing`, `refused`).
   */
  readonly readStates: (
    agents: readonly StateAgentRef[],
    opts: ChannelReadOptions,
  ) => Promise<Map<string, StateReading>>;
  /** The channel's watch, a dead agent the job's verdict (`jobObservation`). */
  readonly watch: (
    target: ChannelTarget,
    signal: AbortSignal,
    opts: { afterRuns?: number; inc?: string },
  ) => Promise<ObservedWatch | undefined>;
  /** The channel's last run, as `watch` reports it. */
  readonly lastRun: (
    target: ChannelTarget,
    opts: { afterRuns: number; inc?: string; signal?: AbortSignal; ms: number },
  ) => Promise<AgentObservation | undefined>;
}

/** What a delivery did. The ctl-only fields are absent on `hooks` and `mux`. */
export type SendResult = {
  transport: ChannelName;
  /**
   * hooks only: `confirmed` when the agent's `run_count` rose (or a new
   * session started a run) within `MU_SEND_ACK_MS` of the paste, else
   * `unknown`. An `unknown` send is never resent. A remote worker's paste is
   * `sent`: its node is read again only by the next wait or send gate, which
   * confirms it (spec D11).
   */
  ack?: "confirmed" | "unknown" | "sent";
  /** hooks only: the agent's `run_count` at the ack, else the one the gate read before the paste. */
  runCount?: number;
  /** hooks only: the harness session the run count belongs to. */
  sessionId?: string;
  /**
   * hooks only, a first paste to a first-prompt harness (codex): how the wait
   * for its ready screen ended before the paste (`ready`, `timeout`: pasted
   * anyway, `unread`: the pane could not be captured).
   */
  readyScreen?: "ready" | "timeout" | "unread";
  /**
   * hooks only: the ack was late and the pasted text still sat in the input
   * line, so mu pressed the submit key once more (at most once; never a second paste).
   */
  submitRetry?: true;
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
   * Internal, hooks only: mu has recorded no send to this agent since its
   * spawn (`sentSinceSpawn`). A plain send may then pass a codex or muse pane
   * murmur has no row for yet without `force` (spec D4); absent, it is refused.
   * Such a pane's ack also waits `MU_FIRST_SEND_ACK_MS`, not `MU_SEND_ACK_MS`.
   * A fresh task spawn's pointer passes it with `force`.
   */
  firstPrompt?: boolean;
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
  ack?: "confirmed" | "unknown" | "sent";
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
