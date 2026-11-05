// mu — the `mux` channel: any pane that is not on ctl, read from what the
// multiplexer (herdr's classifier, Rex's status records) or murmur reports.
//
// State only, and polled: no watch, no run baseline, no receipts, no write
// fence (at-most-once comes from never resending) and no last text.

import { readBaseStates } from "../agent-state.js";
import type { AgentChannel } from "./types.js";

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
};
