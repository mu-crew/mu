// mu — the `hooks` channel: a hook harness's pane on tmux (claude, codex,
// cursor-agent, muse), reached by paste and read from murmur's pane inbox
// (spec D3, D4).
//
// Its harness's hooks write events into murmur's inbox; `murmur pane <pane>
// --json` drains them and reports the pane's state, `session_id` and
// `run_count`. A send is gated on that report (`blocked` is answered, never
// pasted into; `running` and `unknown` need `force`), clears the input line
// with the row's clear key (an interrupted claude puts its prompt back in the
// box, and a paste would merge into it), pastes through the backend, and is
// confirmed when `run_count` rises within `MU_SEND_ACK_MS`. Otherwise it is
// `unknown`, reported through `onUndelivered`, and never resent: there is no
// write fence, so at-most-once rests on never resending. A steer is refused:
// a paste lands in the input box, not in the running turn.
//
// State reads are the pane option murmur's drain publishes (the same read as
// `mux`). No watch, no msgId receipts, and no last text yet; fresh,
// interrupt and abort are refused with the `mux` channel's typed errors.

import { readBaseStates } from "../agent-state.js";
import {
  AgentAbortNeedsCtlError,
  AgentAnswerUnsupportedError,
  AgentEmptySendError,
  AgentFreshNeedsCtlError,
  AgentNotBlockedError,
  AgentSendGateError,
  AgentSendUnsupportedError,
  AgentSteerUnsupportedError,
} from "../agents/errors.js";
import { HARNESS_TABLE, harnessOfCli } from "../harnesses.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import {
  eventArrived,
  type HooksPane,
  pollPane,
  readHooksPane,
  runStarted,
  sendAckMs,
  sendGate,
  staleMs,
  writeMuEvent,
} from "./hooks-pane.js";
import type { AgentChannel, DeliveryOptions, DeliveryTarget, SendResult } from "./types.js";

/** The key that clears the agent's input line: its harness row's, else none. */
function clearKeyOf(t: DeliveryTarget): string | null {
  const harness = harnessOfCli(t.agent.cli, t.agent.command ?? undefined);
  return harness === undefined ? null : HARNESS_TABLE[harness].clearInputKey;
}

/**
 * Gate on the pane's state, then clear and paste `text` through the backend
 * (tmux's `pasteToPane`, else a backend's own `sendToPane`). Returns the pane
 * the gate read: the ack's baseline.
 */
async function gateAndPaste(
  t: DeliveryTarget,
  text: string,
  force: boolean,
): Promise<HooksPane | undefined> {
  const { name, workstreamName, cli, paneId } = t.agent;
  const before = await readHooksPane(paneId);
  const gate = sendGate(before, Date.now(), staleMs());
  // A paste into a dialog would answer it with the text: never, --force or not.
  if (!gate.ok && (gate.state === "blocked" || !force)) {
    throw new AgentSendGateError(name, workstreamName, gate.state, gate.reason);
  }
  const mux = await activeMux();
  if (mux.pasteToPane) await mux.pasteToPane(paneId, text, { clearKey: clearKeyOf(t) });
  else if (mux.sendToPane) await mux.sendToPane(paneId, text, {});
  else throw new AgentSendUnsupportedError(name, workstreamName, cli);
  return before;
}

/** Refuse a write fence: this channel has none, and a send never skips one it was asked for. */
function refuseFence(t: DeliveryTarget, opts: DeliveryOptions): void {
  if (opts.ctlGuard?.beforeWrite !== undefined) {
    const { name, workstreamName, cli } = t.agent;
    const why = say("agent.fence_unsupported", name, "hooks");
    throw new AgentSendUnsupportedError(name, workstreamName, cli, why);
  }
}

async function send(t: DeliveryTarget, text: string, opts: DeliveryOptions): Promise<SendResult> {
  const { name, workstreamName } = t.agent;
  refuseFence(t, opts);
  if (opts.mode === "steer") throw new AgentSteerUnsupportedError(name, workstreamName, "hooks");
  if (text === "") throw new AgentEmptySendError(name, workstreamName, "hooks");
  const before = await gateAndPaste(t, text, opts.force === true);
  const ms = sendAckMs();
  const acked = await pollPane(t.agent.paneId, ms, (now) => runStarted(before, now));
  const seen = acked ?? before;
  if (acked === undefined) {
    opts.onUndelivered?.({
      paneId: t.agent.paneId,
      reason: "unconfirmed",
      message: say("agent.send_unconfirmed", t.agent.name, ms),
    });
  }
  return {
    transport: "hooks",
    ack: acked === undefined ? "unknown" : "confirmed",
    ...(seen?.runCount != null ? { runCount: seen.runCount } : {}),
    ...(seen?.sessionId != null ? { sessionId: seen.sessionId } : {}),
  };
}

export const hooksChannel: AgentChannel = {
  name: "hooks",
  fence: false,
  readStates: (agents, opts) => readBaseStates(agents, opts, opts.livenessOnly),
  watch: async () => undefined,
  // D4: `run_count` and `session_id` stand in for pi's runs and incarnation.
  baseline: async (t) => {
    const pane = await readHooksPane(t.agent.paneId);
    if (pane === undefined || pane.runCount === null) return undefined;
    return {
      runs: pane.runCount,
      ...(pane.sessionId !== null ? { incarnation: pane.sessionId } : {}),
    };
  },
  receipt: async (_target, msgId) => ({
    state: "unreachable",
    id: msgId,
    reason: "the hooks channel keeps no msgId receipts: a send is confirmed by its run count",
  }),
  lastRun: async () => undefined,
  send,
  fresh: async (t, _text, opts) => {
    refuseFence(t, opts);
    throw new AgentFreshNeedsCtlError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  },
  // The command as typed, gated like a send. A command starts no run, so there is no ack.
  command: async (t, cmd, opts) => {
    const text =
      cmd.instructions !== undefined ? `/${cmd.name} ${cmd.instructions}` : `/${cmd.name}`;
    await gateAndPaste(t, text, opts.force === true);
    return { transport: "hooks" };
  },
  interrupt: async (t) => {
    throw new AgentAbortNeedsCtlError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  },
  abort: async (t) => {
    throw new AgentAbortNeedsCtlError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  },
  answer: async (t, keys, opts) => {
    const { name, workstreamName, paneId } = t.agent;
    const before = await readHooksPane(paneId);
    const blocked = before !== undefined && before.blocked !== null;
    if (!blocked && opts.force !== true) {
      throw new AgentNotBlockedError(name, workstreamName, before?.state ?? "unknown");
    }
    const mux = await activeMux();
    if (!mux.sendKeys) throw new AgentAnswerUnsupportedError(name, workstreamName, "hooks");
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
