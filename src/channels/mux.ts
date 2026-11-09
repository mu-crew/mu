// mu — the `mux` channel: any pane that is not on ctl, read from what the
// multiplexer (herdr's classifier, Rex's status records) or murmur reports.
//
// State only, and polled: no watch, no run baseline, no receipts, no write
// fence (at-most-once comes from never resending) and no last text.
//
// Delivery is the backend's own `sendToPane` (herdr's atomic `agent prompt`,
// Rex's send), with no receipt. A backend without one (tmux) refuses
// (AgentSendUnsupportedError): tmux's paste belongs to the `hooks` channel,
// where a hook event confirms it, and nothing confirms it here. Fresh,
// interrupt and abort need ctl and are refused with their typed errors; a send
// that asks for a write fence is refused rather than sent unfenced. A dialog
// answer is typed as keys where the backend can (tmux), unconfirmed.

import { agentKey, readBaseStates } from "../agent-state.js";
import {
  AgentAbortNeedsCtlError,
  AgentAnswerUnsupportedError,
  AgentFreshNeedsCtlError,
  AgentNotBlockedError,
  AgentSendUnsupportedError,
} from "../agents/errors.js";
import { activeMux, type SendOptions } from "../mux.js";
import { baseReadStates } from "./base-read.js";
import { typeKeys } from "./hooks.js";
import type {
  AgentChannel,
  ChannelCaps,
  DeliveryOptions,
  DeliveryTarget,
  SendResult,
} from "./types.js";

/** Refuse a write fence this channel cannot honour. */
function refuseFence(t: DeliveryTarget, opts: DeliveryOptions): void {
  if (opts.ctlGuard?.beforeWrite !== undefined) {
    throw new AgentSendUnsupportedError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  }
}

/** The text through the backend's `sendToPane`; load-bearing, so a send that cannot reach a pane fails. */
async function sendToPane(t: DeliveryTarget, text: string, opts: SendOptions): Promise<SendResult> {
  const mux = await activeMux();
  if (!mux.sendToPane) {
    throw new AgentSendUnsupportedError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  }
  await mux.sendToPane(t.agent.paneId, text, opts);
  return { transport: "mux" };
}

/**
 * The mux channel's row of the D9 matrix. A steer is sent as plain text
 * (`as-send`); `answer` and `command` hold where the backend can type keys
 * or send (each refuses with its typed error where it cannot).
 */
const MUX_CAPS: ChannelCaps = {
  fence: "none",
  receipt: "none",
  steer: "as-send",
  interrupt: "none",
  fresh: "none",
  answer: true,
  command: true,
  watch: "poll",
  settleText: "none",
};

export const muxChannel: AgentChannel = {
  name: "mux",
  caps: MUX_CAPS,
  fence: MUX_CAPS.fence === "sync",
  // A mux send is owed a wait with no baseline: its busy-to-idle is all there is.
  sendRun: () => ({ channel: "mux", ack: "none" }),
  describeSend: () => "via mux",
  // Never reached: the mux channel refuses an interrupt.
  describeInterrupt: () => "via mux",
  readStates: baseReadStates,
  watch: async () => undefined,
  baseline: async () => undefined,
  receipt: async (_target, msgId) => ({
    state: "unreachable",
    id: msgId,
    reason: "the mux channel keeps no receipts",
  }),
  lastRun: async () => undefined,
  send: async (t, text, opts) => {
    refuseFence(t, opts);
    return sendToPane(t, text, opts);
  },
  fresh: async (t, _text, opts) => {
    refuseFence(t, opts);
    throw new AgentFreshNeedsCtlError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  },
  // The command as typed, like any other text: the pane's own CLI decides what it means.
  command: async (t, cmd) =>
    sendToPane(
      t,
      cmd.instructions !== undefined ? `/${cmd.name} ${cmd.instructions}` : `/${cmd.name}`,
      {},
    ),
  interrupt: async (t) => {
    throw new AgentAbortNeedsCtlError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  },
  abort: async (t) => {
    throw new AgentAbortNeedsCtlError(t.agent.name, t.agent.workstreamName, t.agent.cli);
  },
  answer: async (t, keys, opts) => {
    const { name, workstreamName, paneId } = t.agent;
    const mux = await activeMux();
    if (!mux.sendKeys) throw new AgentAnswerUnsupportedError(name, workstreamName, "mux");
    if (opts.force !== true) {
      const reading = (await readBaseStates([t.agent], {})).get(agentKey(t.agent));
      if (reading?.state !== "needs_permission") {
        throw new AgentNotBlockedError(name, workstreamName, reading?.state ?? "unknown");
      }
    }
    await typeKeys(mux.sendKeys, paneId, keys);
    return { transport: "mux", keys, ack: "unknown" };
  },
};
