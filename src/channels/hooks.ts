// mu — the `hooks` channel: a hook harness's pane on tmux (claude, codex,
// cursor-agent, muse, and pi on its fallback, spec D15), reached by paste and
// read from murmur's pane inbox (spec D3, D4).
//
// Its harness's hooks write events into murmur's inbox; `murmur pane <pane>
// --json` drains them and reports the pane's state, `session_id`, `run_count`
// and the last turn's text. A send is gated on that report (`blocked` is
// answered, never pasted into; `running` and `unknown` need `force`, except
// mu's first send since spawn to a codex or muse pane murmur has no row for
// yet, which passes while the pane lives, confirmed by `run_count` 1), clears
// the input line with the row's clear key (an interrupted claude puts its
// prompt back in the box, and a paste would merge into it), pastes through
// the backend, and is confirmed when `run_count` rises within
// `MU_SEND_ACK_MS`. Otherwise it is `unknown`, reported through
// `onUndelivered`, and never resent: there is no write fence, so at-most-once
// rests on never resending. A steer is refused: a paste lands in the input
// box, not in the running turn. mu's first paste to a codex pane with no turn
// waits for codex's own ready screen first, and a late ack whose text still
// sits in the input line gets the submit key once more, never a second paste
// (./hooks-ready.ts).
//
// Interrupt presses the row's interrupt key (Escape). codex and muse confirm
// it with their `Interrupt` event, cursor-agent with an aborted `stop`;
// claude reports nothing, so mu writes `interrupted` through `murmur hook mu`,
// which murmur reads as `idle?` until the harness speaks again. An `idle?`
// agent is sendable. Abort is the interrupt without the text. Fresh pastes the
// row's fresh command like a prompt and is confirmed by the new session
// (`session_start`, or a run in a new `session_id` where the harness starts
// its session only on the first prompt).
//
// Settle is the pane's `turn_stopped`: the watch polls `murmur pane` until a
// turn past the baseline has ended, and returns that turn's text (the last
// text, from the event, never a transcript) when it can tie the text to the
// turn (ownText: by murmur's `last_text_run`, or with an older murmur by what
// the watch saw before the turn ended); a dialog ends it as `blocked`, the
// wait's `input`. State reads are the pane option
// murmur's drain publishes (the same read as `mux`). No msgId receipts.
//
// A remote worker (`--host`, spec D11) reports on its own node; its target's
// `remote` reader brings that node's events into the local pane's inbox
// (./hooks-remote.ts). It reads on a send gate (send, `command`, interrupt,
// abort, answer), at the start of a watch and every few polls after, and on
// collect; never in an ack poll. So a remote paste is `sent`, confirmed by
// the next read; a remote interrupt records mu's `interrupted` on the node in
// the same exec unless the read before it brought the harness's own
// interrupt; `--fresh` is refused (its confirmation needs a poll).

import { murmurAvailable } from "../agent-state.js";
import {
  AgentAbortNeedsCtlError,
  AgentAbortTimeoutError,
  AgentAnswerUnsupportedError,
  AgentEmptySendError,
  AgentFreshNeedsCtlError,
  AgentFreshUnconfirmedError,
  AgentInterruptUnrecordedError,
  AgentNotBlockedError,
  AgentRestartedError,
  AgentSendGateError,
  AgentSendUnsupportedError,
  AgentSteerUnsupportedError,
} from "../agents/errors.js";
import type { AgentObservation, ObservedAgent, ObservedWatch } from "../agents/observe.js";
import { speaksMuCtl } from "../agents/spawn.js";
import { HARNESS_TABLE, type HarnessRow, harnessOfCli, type ReadyMarks } from "../harnesses.js";
import { paneUp } from "../jobs/pane.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import { sleep } from "../tmux.js";
import { baseReadStates } from "./base-read.js";
import {
  eventArrived,
  firstSendAckMs,
  freshStarted,
  type HooksPane,
  pollPane,
  readHooksPane,
  runInNewSession,
  runStarted,
  sendAckMs,
  sendGate,
  settledRuns,
  staleMs,
  writeMuEvent,
} from "./hooks-pane.js";
import {
  awaitReadyScreen,
  pasteUnsubmitted,
  type ReadyWait,
  SUBMIT_GRACE_MS,
  SUBMIT_KEY,
} from "./hooks-ready.js";
import type {
  AgentChannel,
  ChannelCaps,
  ChannelSendReply,
  ChannelTarget,
  DeliveryOptions,
  DeliveryTarget,
  InterruptResult,
  RemoteReader,
  RemoteReadResult,
  SendResult,
  SentFacts,
} from "./types.js";

/**
 * The harness row of an agent; undefined for a cli outside the blessed five. A
 * pi on the fallback (spec D15) whose cli key names no harness (`--cli helper
 * --command 'pi-meta …'`) still gets pi's row: its keys and fresh command.
 */
export function rowOf(agent: { cli: string; command?: string | null }): HarnessRow | undefined {
  const harness =
    harnessOfCli(agent.cli, agent.command ?? undefined) ??
    (speaksMuCtl(agent.cli, agent.command ?? "") ? "pi" : undefined);
  return harness === undefined ? undefined : HARNESS_TABLE[harness];
}

/** The key that clears the agent's input line: its harness row's, else none. */
function clearKeyOf(t: DeliveryTarget): string | null {
  return rowOf(t.agent)?.clearInputKey ?? null;
}

/** How long a verb's second remote read may reuse its first (an interrupt's gate, then its send's). */
const REMOTE_REUSE_MS = 5000;

/** A remote worker's node, read and relayed into the local inbox; undefined for a local agent. */
async function readRemote(t: ChannelTarget, maxAgeMs = 0): Promise<RemoteReadResult | undefined> {
  return t.remote === undefined ? undefined : await t.remote.read({ maxAgeMs });
}

/** The gate's refusal reason for a remote worker whose node could not be read. */
const unread = (r: { reason: string }): string => `its host was not read: ${r.reason}`;

/**
 * True when the pane is a first-prompt harness (codex, muse) waiting for its
 * first prompt: murmur claims a pane only on the harness's first event, which
 * for these is that prompt (`startupSessionStart`), so a worker mu just
 * spawned reads no agent row. No row alone is not that: a rebuilt or moved
 * murmur store, or hooks that never fire, read the same. So the caller's
 * evidence comes first: mu has sent this incarnation nothing since its spawn
 * (`firstPrompt`, from the ops log). Then murmur must have answered (no row,
 * no dialog, no crash), a local worker's harness must have murmur's hooks
 * installed, and the pane must still be up: mu runs the harness as the pane's
 * own command, not under a shell, so a harness that exited leaves its pane
 * gone (or dead, for a gate spawn's `retainOnExit` pane), never a prompt a
 * paste could reach. The ack then needs `run_count` 1
 * (`runStarted` with no baseline row), as a task spawn's does.
 */
async function awaitsFirstPrompt(t: DeliveryTarget, pane: HooksPane | undefined): Promise<boolean> {
  if (pane === undefined || pane.activity !== null) return false;
  if (pane.blocked !== null || pane.attention.includes("crashed")) return false;
  const harness = harnessOfCli(t.agent.cli, t.agent.command ?? undefined);
  if (harness === undefined || HARNESS_TABLE[harness].startupSessionStart !== "first-prompt") {
    return false;
  }
  if (t.remote === undefined && !murmurAvailable(harness)) return false;
  return (await paneUp(t.agent.paneId)) === true;
}

/**
 * Gate on the pane's state, then clear and paste `text` through the backend
 * (tmux's `pasteToPane`, else a backend's own `sendToPane`). Returns the pane
 * the gate read: the ack's baseline. A remote worker's node is read first
 * (spec D11); a read that fails reads `unknown`, which `force` overrides.
 * `firstPrompt` (a plain send, mu's first since spawn) also passes a
 * first-prompt harness's pane before its first prompt (`awaitsFirstPrompt`)
 * without `force`.
 */
async function gateAndPaste(
  t: DeliveryTarget,
  text: string,
  force: boolean,
  remoteMaxAgeMs = 0,
  firstPrompt = false,
  beforePaste?: (before: HooksPane | undefined) => Promise<void>,
): Promise<HooksPane | undefined> {
  const { name, workstreamName, cli, paneId } = t.agent;
  const remote = await readRemote(t, remoteMaxAgeMs);
  if (remote !== undefined && !remote.ok && !force) {
    throw new AgentSendGateError(name, workstreamName, "unknown", unread(remote));
  }
  const before = await readHooksPane(paneId);
  const gate = sendGate(before, Date.now(), staleMs());
  // A paste into a dialog would answer it with the text: never, --force or not.
  if (!gate.ok && (gate.state === "blocked" || !force)) {
    const passes = gate.state === "unknown" && firstPrompt && (await awaitsFirstPrompt(t, before));
    if (!passes) throw new AgentSendGateError(name, workstreamName, gate.state, gate.reason);
  }
  await beforePaste?.(before);
  const mux = await activeMux();
  if (mux.pasteToPane) await mux.pasteToPane(paneId, text, { clearKey: clearKeyOf(t) });
  else if (mux.sendToPane) await mux.sendToPane(paneId, text, {});
  else throw new AgentSendUnsupportedError(name, workstreamName, cli);
  return before;
}

/**
 * True when the paste is the first prompt of a first-prompt harness (codex,
 * muse), so its ack gets `firstSendAckMs`: a launcher may still be starting
 * the harness. mu's own evidence comes first, as for `awaitsFirstPrompt`: the
 * caller sends this incarnation's first prompt (`firstPrompt`). Then murmur
 * answered for the pane with no agent row, which such a pane has until that
 * prompt (`startupSessionStart`), and the harness has murmur's hooks (a
 * hookless pane never confirms, so it keeps the usual window). Hooks count
 * however their command names murmur (`runsMurmurHook`): matching only
 * `murmur hook <harness>` gave a hook config that ran murmur by path the 10 s
 * window.
 */
function beforeFirstPrompt(
  t: DeliveryTarget,
  before: HooksPane | undefined,
  firstPrompt: boolean,
): boolean {
  if (!firstPrompt || before === undefined || before.activity !== null) return false;
  const harness = harnessOfCli(t.agent.cli, t.agent.command ?? undefined);
  if (harness === undefined || HARNESS_TABLE[harness].startupSessionStart !== "first-prompt") {
    return false;
  }
  return murmurAvailable(harness);
}

/** Refuse a write fence: this channel has none, and a send never skips one it was asked for. */
function refuseFence(t: DeliveryTarget, opts: DeliveryOptions): void {
  if (opts.ctlGuard?.beforeWrite !== undefined) {
    const { name, workstreamName, cli } = t.agent;
    const why = say("agent.fence_unsupported", name, "hooks");
    throw new AgentSendUnsupportedError(name, workstreamName, cli, why);
  }
}

/** The run count and session a confirming (or, failing that, baseline) pane reports. */
function counts(seen: HooksPane | undefined): Pick<SendResult, "runCount" | "sessionId"> {
  return {
    ...(seen?.runCount != null ? { runCount: seen.runCount } : {}),
    ...(seen?.sessionId != null ? { sessionId: seen.sessionId } : {}),
  };
}

/**
 * The ready marks to wait for before mu's first paste to this pane: a
 * first-prompt harness (codex) with known marks, on mu's first prompt since
 * spawn (`firstPrompt`), to a pane with no turn yet (no murmur row, or no
 * murmur answer). undefined: paste at once, as before.
 */
function readyMarksBeforeFirst(
  t: DeliveryTarget,
  before: HooksPane | undefined,
  firstPrompt: boolean,
): ReadyMarks | undefined {
  if (!firstPrompt || (before !== undefined && before.activity !== null)) return undefined;
  const harness = harnessOfCli(t.agent.cli, t.agent.command ?? undefined);
  if (harness === undefined) return undefined;
  const row = HARNESS_TABLE[harness];
  return row.startupSessionStart === "first-prompt" ? (row.readyMarks ?? undefined) : undefined;
}

async function send(
  t: DeliveryTarget,
  text: string,
  opts: DeliveryOptions,
  remoteMaxAgeMs = 0,
): Promise<SendResult> {
  const { name, workstreamName, paneId } = t.agent;
  refuseFence(t, opts);
  if (opts.mode === "steer") throw new AgentSteerUnsupportedError(name, workstreamName, "hooks");
  if (text === "") throw new AgentEmptySendError(name, workstreamName, "hooks");
  const first = opts.firstPrompt === true;
  // A launcher wrapper may still be starting a first-prompt harness: a paste
  // then loses its Enter. So the first one waits for the harness's own ready
  // screen, within MU_FIRST_SEND_ACK_MS; the ack gets what is left of it.
  const startedAt = Date.now();
  let readyScreen: ReadyWait | undefined;
  const before = await gateAndPaste(
    t,
    text,
    opts.force === true,
    remoteMaxAgeMs,
    first,
    async (gated) => {
      const marks = readyMarksBeforeFirst(t, gated, first);
      if (marks !== undefined)
        readyScreen = await awaitReadyScreen(paneId, marks, firstSendAckMs());
    },
  );
  const waited = readyScreen === undefined ? {} : { readyScreen };
  // D11: a remote paste is not polled for (each read is an exec); the next
  // wait or send gate reads the node, which confirms it.
  if (t.remote !== undefined) {
    return { transport: "hooks", ack: "sent", ...counts(before), ...waited };
  }
  const firstWindow = beforeFirstPrompt(t, before, first);
  const ms = firstWindow
    ? Math.max(sendAckMs(), firstSendAckMs() - (Date.now() - startedAt))
    : sendAckMs();
  const done = (now: HooksPane | undefined): boolean => runStarted(before, now);
  const marks = rowOf(t.agent)?.readyMarks ?? null;
  let acked: HooksPane | undefined;
  let submitRetry = false;
  if (marks === null) {
    acked = await pollPane(paneId, ms, done);
  } else {
    // A late ack, with the text still in the input line: its Enter was lost.
    // Press the submit key once more, at most once; never paste again.
    const grace = Math.min(SUBMIT_GRACE_MS, ms);
    acked = await pollPane(paneId, grace, done);
    if (acked === undefined && (await pasteUnsubmitted(paneId, marks, text))) {
      const mux = await activeMux();
      try {
        await mux.sendKeys?.(paneId, [SUBMIT_KEY]);
        submitRetry = mux.sendKeys !== undefined;
      } catch {
        // best effort: the paste stands, and the ack poll below says what came of it
      }
    }
    if (acked === undefined) acked = await pollPane(paneId, ms - grace, done);
  }
  if (acked === undefined) {
    opts.onUndelivered?.({
      paneId,
      reason: "unconfirmed",
      message: say("agent.send_unconfirmed", name, ms, submitRetry),
    });
  }
  return {
    transport: "hooks",
    ack: acked === undefined ? "unknown" : "confirmed",
    ...counts(acked ?? before),
    ...waited,
    ...(submitRetry ? { submitRetry: true } : {}),
  };
}

/** What stopping a turn found and did. */
interface Stopped {
  wasBusy: boolean;
  /** Set when a key was pressed: whether the harness itself reported the stop. */
  stopped?: "confirmed" | "unconfirmed";
}

/** True when `after` shows the turn `before` was running has stopped, by an event since. */
function stoppedSince(before: HooksPane, after: HooksPane | undefined): boolean {
  return after !== undefined && after.activity === "stopped" && eventArrived(before, after);
}

/**
 * Stop the agent's running turn (spec D4 `interrupt`). A stopped agent gets
 * no key: the verb is idempotent. A running or blocked one gets the row's
 * interrupt key (Escape; on a dialog it declines it). Where the harness
 * reports its own interrupt (codex, muse, cursor-agent), the stop is
 * confirmed by that event within `timeoutMs`, else AgentAbortTimeoutError.
 * Where it reports none (claude), a turn that ended on its own is still
 * confirmed; otherwise mu writes `interrupted` through `murmur hook mu`, read
 * as `idle?` (unconfirmed) until the harness's next event replaces it, and
 * one murmur will not record is AgentInterruptUnrecordedError (the agent still
 * reads running). A pane murmur cannot report is refused (AgentSendGateError,
 * `unknown`).
 */
async function stopTurn(
  t: DeliveryTarget,
  timeoutMs: number,
  onKey?: () => Promise<void>,
): Promise<Stopped> {
  const { name, workstreamName, cli, paneId } = t.agent;
  const remote = await readRemote(t);
  if (remote !== undefined && !remote.ok) {
    throw new AgentSendGateError(name, workstreamName, "unknown", unread(remote));
  }
  const before = await readHooksPane(paneId);
  if (before === undefined || (before.activity !== "running" && before.activity !== "stopped")) {
    const gate = sendGate(before, Date.now(), staleMs());
    throw new AgentSendGateError(name, workstreamName, "unknown", gate.ok ? "" : gate.reason);
  }
  if (before.attention.includes("crashed")) {
    throw new AgentSendGateError(name, workstreamName, "unknown", "its harness crashed");
  }
  if (before.activity === "stopped") return { wasBusy: false };
  const mux = await activeMux();
  if (!mux.sendKeys) throw new AgentAbortNeedsCtlError(name, workstreamName, cli);
  const row = rowOf(t.agent);
  await mux.sendKeys(paneId, [row?.interruptKey ?? "Escape"]);
  await onKey?.();
  const reports = row !== undefined && row.events.interrupted.length > 0;
  if (t.remote !== undefined) return remoteStopped(t, t.remote, before, reports);
  if (reports) {
    const done = await pollPane(paneId, timeoutMs, (now) => stoppedSince(before, now));
    if (done === undefined) throw new AgentAbortTimeoutError(name, workstreamName, timeoutMs);
    return { wasBusy: true, stopped: "confirmed" };
  }
  // No interrupt event: a Stop that raced the key still confirms it.
  if (stoppedSince(before, await readHooksPane(paneId))) {
    return { wasBusy: true, stopped: "confirmed" };
  }
  const recorded = await writeMuEvent(paneId, {
    event: "interrupted",
    ...(before.sessionId !== null ? { session_id: before.sessionId } : {}),
  });
  if (!recorded) throw new AgentInterruptUnrecordedError(name, workstreamName);
  return { wasBusy: true, stopped: "unconfirmed" };
}

/**
 * A remote worker's stop, once its key was pressed (spec D11). A harness that
 * reports its own interrupt (codex, muse, cursor-agent) has usually done so
 * by the time an exec reaches its node, so the node is read first: its
 * interrupt, relayed as the harness's (`murmur hook mu --by harness`), is a
 * confirmed stop, and mu writes nothing. Otherwise (claude, or an interrupt
 * not yet reported) mu records `interrupted` on the node and reads it back in
 * one exec, so the local pane reads `idle?` until the harness's next event
 * replaces it. No poll: a later interrupt event arrives with the next read. A
 * node that did not record mu's is AgentInterruptUnrecordedError.
 */
async function remoteStopped(
  t: DeliveryTarget,
  remote: RemoteReader,
  before: HooksPane,
  reports: boolean,
): Promise<Stopped> {
  if (reports && (await remote.read()).ok) {
    const now = await readHooksPane(t.agent.paneId);
    if (stoppedSince(before, now) && now?.confirmed === true) {
      return { wasBusy: true, stopped: "confirmed" };
    }
  }
  const r = await remote.read({
    write: {
      event: "interrupted",
      ...(before.sessionId !== null ? { session_id: before.sessionId } : {}),
    },
  });
  if (!r.ok) throw new AgentInterruptUnrecordedError(t.agent.name, t.agent.workstreamName);
  const after = await readHooksPane(t.agent.paneId);
  return {
    wasBusy: true,
    stopped: stoppedSince(before, after) && after?.confirmed === true ? "confirmed" : "unconfirmed",
  };
}

/**
 * The run baseline a confirmed paste gives a wait: the turns settled before its run
 * (`run_count` less one) in its session. A remote paste (`sent`) gives the
 * prompts the gate counted before it, so the next read confirms its run. An
 * unconfirmed paste gives none.
 */
export function hooksRunBaseline(
  sent: Pick<SendResult, "ack" | "runCount" | "sessionId">,
): Pick<InterruptResult, "runs" | "incarnation"> {
  if (sent.ack === "unknown" || sent.ack === undefined || sent.runCount === undefined) return {};
  return {
    runs: sent.ack === "sent" ? sent.runCount : Math.max(0, sent.runCount - 1),
    ...(sent.sessionId !== undefined ? { incarnation: sent.sessionId } : {}),
  };
}

async function interrupt(
  t: DeliveryTarget,
  text: string,
  opts: { timeoutMs: number },
): Promise<InterruptResult> {
  const { name, workstreamName } = t.agent;
  // Before the key: an empty prompt would stop the turn and then send nothing.
  if (text === "") throw new AgentEmptySendError(name, workstreamName, "hooks");
  const stop = await stopTurn(t, opts.timeoutMs);
  const sent = await send(t, text, {}, REMOTE_REUSE_MS);
  return {
    transport: "hooks",
    wasBusy: stop.wasBusy,
    pending: false,
    ...(stop.stopped !== undefined ? { stopped: stop.stopped } : {}),
    ...hooksRunBaseline(sent),
    ack: sent.ack ?? "unknown",
    ...(sent.runCount !== undefined ? { runCount: sent.runCount } : {}),
    ...(sent.sessionId !== undefined ? { sessionId: sent.sessionId } : {}),
  };
}

/**
 * A new session, then `text` in it (spec D4 `fresh`). The row's fresh command
 * is pasted like a prompt (gated like one; `force` first stops a running
 * turn, as ctl's fresh abandons it). Where the harness reports the new
 * session at once (claude's `/clear`), the text waits for that
 * `session_start` and is not sent without it (AgentFreshUnconfirmedError).
 * Where the new session reports itself only on its first prompt (codex,
 * muse, and an unverified row), the text follows at once, and is confirmed
 * only by a run in a session other than the old one: a fresh command the
 * harness ignored leaves the send `unknown`, never confirmed.
 */
async function fresh(t: DeliveryTarget, text: string, opts: DeliveryOptions): Promise<SendResult> {
  const { name, workstreamName, cli, paneId } = t.agent;
  refuseFence(t, opts);
  if (opts.mode === "steer") throw new AgentSteerUnsupportedError(name, workstreamName, "hooks");
  if (text === "") throw new AgentEmptySendError(name, workstreamName, "hooks");
  const row = rowOf(t.agent);
  if (row === undefined) throw new AgentFreshNeedsCtlError(name, workstreamName, cli);
  const command = row.freshCommand;
  // D11: a fresh session is confirmed by polling for it, and a remote node is never polled.
  if (t.remote !== undefined) {
    const why = say("agent.fresh_remote", name, workstreamName, command);
    throw new AgentSendUnsupportedError(name, workstreamName, cli, why);
  }
  const ms = sendAckMs();
  if (opts.force === true) {
    const now = await readHooksPane(paneId);
    if (now?.activity === "running" && now.blocked === null) await stopTurn(t, ms);
  }
  const before = await gateAndPaste(t, command, opts.force === true);
  let started: HooksPane | undefined;
  if (row.freshSessionStart === "immediate") {
    started = await pollPane(paneId, ms, (now) => freshStarted(before, now));
    if (started === undefined) {
      throw new AgentFreshUnconfirmedError(name, workstreamName, command, ms);
    }
  }
  // The new session may have no agent row yet (it starts on this prompt):
  // that is not a refusal here. A dialog still is.
  await gateAndPaste(t, text, true);
  const acked = await pollPane(paneId, ms, (now) =>
    started !== undefined ? runStarted(started, now) : runInNewSession(before, now),
  );
  if (acked === undefined) {
    opts.onUndelivered?.({
      paneId,
      reason: "unconfirmed",
      message: say("agent.fresh_text_unconfirmed", name, command, ms),
    });
  }
  return {
    transport: "hooks",
    ack: acked === undefined ? "unknown" : "confirmed",
    ...counts(acked ?? started),
  };
}

/** How often a watch reads the pane. Each read is one `murmur pane` process. */
const WATCH_POLL_MS = 1000;
/** Reads in a row murmur may miss before a watch hands the agent back to polling. */
const WATCH_MISSES = 3;
/**
 * How often a watch asks the multiplexer whether the pane still runs: murmur
 * may keep a dead pane's row running, and a held watch is never polled.
 */
const WATCH_PANE_CHECK_MS = 5000;
/**
 * A remote worker's watch reads its node every this many polls (about 5 s
 * apart, plus the exec itself): each read is an exec, several serialized ssh
 * round trips on a lease host (spec D11).
 */
const REMOTE_WATCH_POLLS = 5;
/** murmur's cap on a turn's text (bytes); it keeps the head, so a capped text lost its tail. */
const LAST_TEXT_CAP_BYTES = 64 * 1024;
/**
 * How long a settled turn waits for text that can follow its stop
 * (`textFollowsStop`: cursor-agent's `afterAgentResponse` landed 11-16 ms
 * after `stop` in U0, each hook its own process).
 */
const LATE_TEXT_MS = 3000;

/** Let timers and I/O run between reads, whatever `sleep` is (tests make it a no-op). */
const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** One pane report as an observation, never settled. */
function paneObservation(agent: ObservedAgent, pane: HooksPane): AgentObservation {
  const runs = settledRuns(pane);
  const status =
    pane.blocked !== null && pane.activity === "running"
      ? "needs_permission"
      : pane.activity === "running"
        ? "busy"
        : pane.activity === "stopped"
          ? "needs_input"
          : "unknown";
  return {
    workstream: agent.workstreamName,
    name: agent.name,
    agentId: agent.incarnation,
    paneId: agent.paneId,
    status,
    source: "murmur",
    since: pane.updatedAt,
    // A dialog is the wait's `input` event, as ctl's: `since` (the dialog's event) names it.
    ...(status === "needs_permission"
      ? {
          reason: `permission dialog: ${pane.blocked}`,
          blocked: { kind: "permission", title: pane.blocked ?? "", since: pane.updatedAt ?? 0 },
        }
      : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(pane.sessionId !== null ? { incarnation: pane.sessionId } : {}),
    settled: false,
  };
}

/** What the pane said while the turn past the baseline had not yet ended. */
interface Witness {
  session: string | null;
  text: string | null;
  error: string | null;
}

const witnessOf = (p: HooksPane): Witness => ({
  session: p.sessionId,
  text: p.lastText,
  error: p.error,
});

/**
 * The settled turn's own text, or undefined when it cannot be told apart from
 * an earlier turn's. murmur keeps the previous text when a turn ends without
 * one (an interrupt, a failure). It names the run that wrote it
 * (`last_text_run`), so the text counts when that run is the settled turn's,
 * however late the watch first read it and whatever an earlier turn wrote.
 * An older murmur names none: then the text counts only when it changed since
 * a read (`witness`) taken before the turn ended, in its session; or, in a
 * session the watch never saw unsettled, when that session's one turn wrote
 * it (a new session starts with no text), and a watch that first reads the
 * turn already over or a text equal to the previous turn's gives none. An
 * `idle?` turn (an interrupt mu wrote) gives none either way: a CLOSE block
 * that cannot be tied to its turn is never applied.
 */
function ownText(
  pane: HooksPane,
  witness: Witness | undefined,
  session: string | null,
): string | undefined {
  if (!pane.confirmed || pane.lastText === null) return undefined;
  if (pane.lastTextRun !== undefined) {
    return pane.lastTextRun !== null && pane.lastTextRun === pane.runCount
      ? pane.lastText
      : undefined;
  }
  if (witness !== undefined && witness.session === pane.sessionId) {
    return pane.lastText !== witness.text ? pane.lastText : undefined;
  }
  return pane.sessionId !== session && settledRuns(pane) === 1 ? pane.lastText : undefined;
}

/**
 * A turn that ended past the baseline, with its own text (ownText). An error
 * the pane already carried before that turn ended belongs to an earlier one.
 */
function settledObservation(
  agent: ObservedAgent,
  pane: HooksPane,
  witness: Witness | undefined,
  session: string | null,
): AgentObservation {
  const text = ownText(pane, witness, session);
  const error =
    pane.error !== null &&
    (witness === undefined || witness.session !== pane.sessionId || pane.error !== witness.error)
      ? pane.error
      : undefined;
  return {
    ...paneObservation(agent, pane),
    settled: true,
    ...(text !== undefined ? { lastText: text } : {}),
    ...(text !== undefined && Buffer.byteLength(text) > LAST_TEXT_CAP_BYTES - 4
      ? { lastTextTruncated: true }
      : {}),
    ...(error !== undefined ? { lastError: error } : {}),
  };
}

/** The agent as a watch reports it when murmur's pane says nothing about its turn. */
function lostObservation(
  agent: ObservedAgent,
  reason?: string,
  status: "unknown" | "busy" | null = "unknown",
): AgentObservation {
  return {
    workstream: agent.workstreamName,
    name: agent.name,
    agentId: agent.incarnation,
    paneId: agent.paneId,
    status,
    source: "murmur",
    since: null,
    ...(reason !== undefined ? { reason } : {}),
    settled: false,
  };
}

/**
 * Watch the agent's current or next turn end past `afterRuns` (spec D4
 * `settle`): poll `murmur pane` until a turn past it has stopped, a dialog
 * opens (returned unsettled, `needs_permission`), or the agent leaves
 * murmur's view (returned `unknown`: the caller polls), or its pane is gone
 * (dead: murmur may keep a dead pane's row, so the multiplexer is asked every
 * few seconds). Without `afterRuns`
 * the baseline is the turns settled now, so a running turn's end counts. A
 * new session (a fresh command) counts its own turns from zero; `inc` pins
 * the session, and another one rejects with AgentRestartedError. undefined:
 * murmur has no run count for the pane, so the caller polls; a remote
 * worker's pane with no row yet is watched until its node reports one
 * (awaitRow). `signal` ends the watch `unknown`, never settled.
 */
async function watchHooks(
  t: ChannelTarget,
  signal: AbortSignal,
  opts: { afterRuns?: number; inc?: string },
): Promise<ObservedWatch | undefined> {
  const { agent, remote } = t;
  // A remote worker's events reach the local inbox only by a read of its node;
  // a failed read is retried on the next round, never a reason to give the
  // agent up. The local pane read before it is what the relayed turns found
  // (ownText's witness); a pane with no row then had seen no session, so a
  // session the read brings in is new to the watch (ownText's new-session rule).
  const before = remote !== undefined ? await readHooksPane(agent.paneId) : undefined;
  await remote?.read();
  const first = await readHooksPane(agent.paneId);
  if (first === undefined) return undefined;
  if (settledRuns(first) === undefined) {
    return remote === undefined ? undefined : awaitRow(t, remote, signal, opts);
  }
  const unseen = before !== undefined && settledRuns(before) === undefined;
  return follow(t, signal, opts, first, before, unseen ? null : first.sessionId);
}

/**
 * A remote worker whose local pane has no row yet: just spawned, its harness
 * not yet started, or its node not read yet (no admission slot, an ssh
 * hiccup). Poll the pane, reading the node every few polls, until a row
 * appears, then watch from it (`follow`, the session new to the watch).
 * Reported busy meanwhile; `afterRuns` stands as given, and without one the
 * baseline is fixed at the first row (so a turn the node ran before mu could
 * read it never counts as this one).
 */
function awaitRow(
  t: ChannelTarget,
  remote: RemoteReader,
  signal: AbortSignal,
  opts: { afterRuns?: number; inc?: string },
): ObservedWatch {
  const { agent } = t;
  const settled = (async (): Promise<AgentObservation> => {
    let misses = 0;
    let polls = 0;
    let checkedAt = Date.now();
    for (;;) {
      await sleep(WATCH_POLL_MS);
      await yieldTurn();
      if (signal.aborted) return lostObservation(agent);
      if (Date.now() - checkedAt >= WATCH_PANE_CHECK_MS) {
        checkedAt = Date.now();
        if ((await paneUp(agent.paneId)) === false) {
          return lostObservation(agent, "the pane is gone", null);
        }
      }
      polls += 1;
      if (polls % REMOTE_WATCH_POLLS === 0) {
        await remote.read();
        if (signal.aborted) return lostObservation(agent);
      }
      const pane = await readHooksPane(agent.paneId);
      if (pane === undefined) {
        misses += 1;
        if (misses >= WATCH_MISSES) return lostObservation(agent, "murmur pane did not answer");
        continue;
      }
      misses = 0;
      if (settledRuns(pane) === undefined) continue;
      return await follow(t, signal, opts, pane, undefined, null).settled;
    }
  })();
  return {
    initial: lostObservation(agent, "its node has reported no session yet", "busy"),
    ...(opts.afterRuns !== undefined ? { afterRuns: opts.afterRuns } : {}),
    settled,
  };
}

/**
 * The watch from its first pane read that has a run count. `textSession` is
 * the session the watch saw first, for ownText: null when the turns arrived in
 * a session the watch never saw (a remote worker's first read).
 */
function follow(
  t: ChannelTarget,
  signal: AbortSignal,
  opts: { afterRuns?: number; inc?: string },
  first: HooksPane,
  before: HooksPane | undefined,
  textSession: string | null,
): ObservedWatch & { afterRuns: number } {
  const { agent, remote } = t;
  const afterRuns = opts.afterRuns ?? settledRuns(first) ?? 0;
  const session = first.sessionId;
  const past = (p: HooksPane): boolean => {
    const runs = settledRuns(p) ?? -1;
    return p.sessionId === session ? runs > afterRuns : runs >= 1;
  };
  // Updated on every read before the turn ends: what an earlier turn left (ownText).
  let witness = !past(first)
    ? witnessOf(first)
    : before !== undefined && before.sessionId === session && !past(before)
      ? witnessOf(before)
      : undefined;
  const row = rowOf(agent);
  const lost = (reason?: string, status: "unknown" | null = "unknown"): AgentObservation =>
    lostObservation(agent, reason, status);
  const restarted = (actual: string): AgentRestartedError =>
    new AgentRestartedError(agent.name, agent.workstreamName, opts.inc ?? "", actual);
  // With a baseline the turn past it is the pending work: busy until it ends.
  const initial: AgentObservation =
    opts.afterRuns !== undefined && !past(first) && first.blocked === null
      ? { ...paneObservation(agent, first), status: "busy" }
      : paneObservation(agent, first);
  const settled = (async (): Promise<AgentObservation> => {
    let pane: HooksPane | undefined = first;
    let misses = 0;
    let checkedAt = Date.now();
    let polls = 0;
    for (;;) {
      if (signal.aborted) return lost();
      if (pane === undefined) {
        misses += 1;
        if (misses >= WATCH_MISSES) return lost("murmur pane did not answer");
      } else {
        misses = 0;
        if (opts.inc !== undefined && pane.sessionId !== null && pane.sessionId !== opts.inc) {
          throw restarted(pane.sessionId);
        }
        if (pane.activity === null) return lost("murmur has no harness row for the pane");
        if (pane.blocked !== null && pane.activity === "running") {
          return paneObservation(agent, pane);
        }
        if (pane.activity === "stopped" && past(pane)) {
          const late =
            row?.textFollowsStop === true
              ? await lateText(agent.paneId, pane, witness, textSession, remote)
              : undefined;
          return settledObservation(agent, late ?? pane, witness, textSession);
        }
        if (!past(pane)) witness = witnessOf(pane);
      }
      await sleep(WATCH_POLL_MS);
      await yieldTurn();
      if (signal.aborted) return lost();
      if (Date.now() - checkedAt >= WATCH_PANE_CHECK_MS) {
        checkedAt = Date.now();
        // Gone is dead; a mux that cannot say is not a death.
        if ((await paneUp(agent.paneId)) === false) return lost("the pane is gone", null);
      }
      polls += 1;
      if (remote !== undefined && polls % REMOTE_WATCH_POLLS === 0) {
        await remote.read();
        if (signal.aborted) return lost();
      }
      pane = await readHooksPane(agent.paneId);
    }
  })();
  return { initial, afterRuns, settled };
}

/**
 * A settled turn whose text can follow its stop (cursor-agent) and has none
 * yet, where a text would count (ownText): read the pane for up to
 * LATE_TEXT_MS until the text lands, while that turn is still the last.
 * murmur clears the text at a named turn's stop (and names that turn's run as
 * the text's), so a turn that ended any other way (an interrupt, a failure)
 * keeps an earlier text and is not waited for. undefined: no text came, or
 * another turn started.
 */
async function lateText(
  paneId: string,
  pane: HooksPane,
  witness: Witness | undefined,
  session: string | null,
  remote?: RemoteReader,
): Promise<HooksPane | undefined> {
  if (!pane.confirmed || pane.lastText !== null) return undefined;
  const named = pane.lastTextRun !== undefined;
  const counts = named
    ? pane.lastTextRun === pane.runCount
    : witness?.session === pane.sessionId ||
      (pane.sessionId !== session && settledRuns(pane) === 1);
  if (!counts) return undefined;
  // A remote worker's late text is on its node: one more read brings it in.
  await remote?.read();
  return await pollPane(
    paneId,
    LATE_TEXT_MS,
    (p) =>
      p !== undefined &&
      p.lastText !== null &&
      (!named || p.lastTextRun === pane.runCount) &&
      p.activity === "stopped" &&
      p.sessionId === pane.sessionId &&
      p.runCount === pane.runCount,
  );
}

/** The turn past `afterRuns`, read within `ms` (an ended one is answered at once). */
async function hooksLastRun(
  t: ChannelTarget,
  o: { afterRuns: number; inc?: string; signal?: AbortSignal; ms: number },
): Promise<AgentObservation | undefined> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), o.ms);
  const onAbort = (): void => stop.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const watch = await watchHooks(t, stop.signal, {
      afterRuns: o.afterRuns,
      ...(o.inc !== undefined ? { inc: o.inc } : {}),
    });
    return watch === undefined ? undefined : await watch.settled;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** The hooks channel's row of the D9 matrix. */
const HOOKS_CAPS: ChannelCaps = {
  fence: "none",
  receipt: "acknowledged",
  steer: "none",
  interrupt: "unconfirmed",
  fresh: "in-place",
  answer: true,
  command: true,
  watch: "stream",
  settleText: "tied",
};

/**
 * The run a hooks delivery started: an interrupt carries it as `runs`; a
 * paste gives its confirmed run count's baseline (`hooksRunBaseline`).
 */
function hooksSendRun(sent: SentFacts): ChannelSendReply {
  // A paste confirmed by its run count (`sent`: the next read confirms it) is acknowledged.
  const reply = {
    channel: "hooks",
    ack: sent.ack === "confirmed" || sent.ack === "sent" ? "acknowledged" : "none",
  } as const;
  if (sent.runs !== undefined) {
    return {
      ...reply,
      baseline: {
        runs: sent.runs,
        ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
      },
    };
  }
  const b = hooksRunBaseline(sent);
  return b.runs === undefined
    ? reply
    : {
        ...reply,
        baseline: {
          runs: b.runs,
          ...(b.incarnation !== undefined ? { incarnation: b.incarnation } : {}),
        },
      };
}

function describeHooksSend(sent: SendResult, o: { fresh?: boolean }): string {
  if (sent.ack === "sent") return "via hooks to its host, sent: the next wait confirms it";
  const run = sent.runCount !== undefined ? `: run ${sent.runCount}` : "";
  return `via hooks${o.fresh ? ", fresh session" : ""}, confirmed${run}`;
}

function describeHooksInterrupt(r: InterruptResult): string {
  const what = !r.wasBusy
    ? "it was idle"
    : r.stopped === "unconfirmed"
      ? "interrupted a busy run, unconfirmed: idle?"
      : "interrupted a busy run";
  const run = r.runCount !== undefined ? `: run ${r.runCount}` : "";
  const how = r.ack === "sent" ? "sent: the next wait confirms it" : `confirmed${run}`;
  return `via hooks, ${what}, ${how}`;
}

export const hooksChannel: AgentChannel = {
  name: "hooks",
  caps: HOOKS_CAPS,
  fence: HOOKS_CAPS.fence === "sync",
  sendRun: hooksSendRun,
  describeSend: describeHooksSend,
  describeInterrupt: describeHooksInterrupt,
  readStates: baseReadStates,
  watch: watchHooks,
  // D4: settled turns and `session_id` stand in for pi's runs and incarnation.
  // A remote worker's baseline is the local count, not a fresh read of its node:
  // the watch that follows reads the node, and a turn that read brings in must
  // still find the text it replaced (ownText's witness). A remote pane with no
  // row yet has no baseline here; the wait watches it anyway (src/wait-ctl.ts).
  baseline: async (t) => {
    const pane = await readHooksPane(t.agent.paneId);
    const runs = pane === undefined ? undefined : settledRuns(pane);
    if (pane === undefined || runs === undefined) return undefined;
    return { runs, ...(pane.sessionId !== null ? { incarnation: pane.sessionId } : {}) };
  },
  receipt: async (_target, msgId) => ({
    state: "unreachable",
    id: msgId,
    reason: "the hooks channel keeps no msgId receipts: a send is confirmed by its run count",
  }),
  lastRun: hooksLastRun,
  send,
  fresh,
  // The command as typed, gated like a send. A command starts no run, so there is no ack.
  command: async (t, cmd, opts) => {
    const text =
      cmd.instructions !== undefined ? `/${cmd.name} ${cmd.instructions}` : `/${cmd.name}`;
    await gateAndPaste(t, text, opts.force === true);
    return { transport: "hooks" };
  },
  interrupt,
  // D4: the interrupt without the text. A turn that will not stop is closed (`mu agent close`).
  abort: async (t, opts) => {
    const stop = await stopTurn(t, opts.timeoutMs, async () => {
      await opts.onAbort?.({ before: "busy", pending: false });
    });
    if (!stop.wasBusy) {
      return { before: "idle", after: "idle", settled: true, aborted: false, pending: false };
    }
    return {
      before: "busy",
      after: "idle",
      settled: stop.stopped === "confirmed",
      aborted: true,
      pending: false,
      ...(stop.stopped !== undefined ? { stopped: stop.stopped } : {}),
    };
  },
  answer: async (t, keys, opts) => {
    const { name, workstreamName, paneId } = t.agent;
    const remote = await readRemote(t);
    if (remote !== undefined && !remote.ok && opts.force !== true) {
      throw new AgentSendGateError(name, workstreamName, "unknown", unread(remote));
    }
    const before = await readHooksPane(paneId);
    const blocked = before !== undefined && before.blocked !== null;
    if (!blocked && opts.force !== true) {
      throw new AgentNotBlockedError(name, workstreamName, before?.state ?? "unknown");
    }
    const mux = await activeMux();
    if (!mux.sendKeys) throw new AgentAnswerUnsupportedError(name, workstreamName, "hooks");
    if (t.remote !== undefined) {
      // D11: no poll for the next event. mu records `continued` on the node
      // BEFORE the keys, so the dialog stops reading pending and every event
      // the answer causes lands after it; the next read relays them. (Written
      // after, it could land after the turn the answer let finish, and read
      // that turn as running.) As locally, `mu agent answer` clears the dialog
      // whatever the keys did with it; keys that never reached the pane put it
      // back.
      const session = before?.sessionId != null ? { session_id: before.sessionId } : {};
      if (blocked) {
        const w = await t.remote.read({ write: { event: "continued", ...session } });
        if (!w.ok) throw new AgentSendGateError(name, workstreamName, "unknown", unread(w));
      }
      try {
        await typeKeys(mux.sendKeys, paneId, keys);
      } catch (e) {
        if (blocked) {
          await t.remote.read({
            write: { event: "permission_requested", message: before.blocked ?? "", ...session },
          });
        }
        throw e;
      }
      return { transport: "hooks", keys, ack: "unknown" };
    }
    await typeKeys(mux.sendKeys, paneId, keys);
    // D4: confirmed by the next event (the dialog closing, or the turn moving on).
    const next = await pollPane(paneId, sendAckMs(), (now) => eventArrived(before, now));
    // The vocabulary: `blocked` clears on the next event or on `mu agent answer`.
    // With no harness event yet (a long tool call hooks nothing), mu writes
    // `continued`, so murmur stops reading the answered dialog as pending and
    // sends are no longer refused as blocked. An event that did arrive cleared it.
    if (blocked && next === undefined) {
      await writeMuEvent(paneId, {
        event: "continued",
        ...(before.sessionId !== null ? { session_id: before.sessionId } : {}),
      });
    }
    return { transport: "hooks", keys, ack: next === undefined ? "unknown" : "confirmed" };
  },
};

/** The tmux key names an answer may use; any other key is typed as text. */
export const ANSWER_KEY_NAMES: readonly string[] = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Up",
  "Down",
  "Left",
  "Right",
];

/** Type each key in order: a named key as a key, anything else as literal text. */
export async function typeKeys(
  sendKeys: NonNullable<Awaited<ReturnType<typeof activeMux>>["sendKeys"]>,
  paneId: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    if (ANSWER_KEY_NAMES.includes(key)) await sendKeys(paneId, [key]);
    else await sendKeys(paneId, [key], { literal: true });
  }
}
