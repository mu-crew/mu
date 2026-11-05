// mu — the `mux` channel: any pane that is not on ctl, read from what the
// multiplexer (herdr's classifier, Rex's status records) or murmur reports.
//
// State only, and polled: no watch, no run baseline, no receipts, no write
// fence (at-most-once comes from never resending) and no last text.
//
// Delivery is the backend's own `sendToPane` (herdr's atomic `agent prompt`,
// Rex's send), with no receipt. A backend without one (tmux) refuses
// (AgentSendUnsupportedError): there is no paste. Fresh, interrupt and abort
// need ctl and are refused with their typed errors; a send that asks for a
// write fence is refused rather than sent unfenced.

import { readBaseStates } from "../agent-state.js";
import {
  AgentAbortNeedsCtlError,
  AgentFreshNeedsCtlError,
  AgentSendUnsupportedError,
} from "../agents/errors.js";
import { activeMux, type SendOptions } from "../mux.js";
import type { AgentChannel, DeliveryOptions, DeliveryTarget, SendResult } from "./types.js";

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

export const muxChannel: AgentChannel = {
  name: "mux",
  fence: false,
  readStates: (agents, opts) => readBaseStates(agents, opts, opts.livenessOnly),
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
};
