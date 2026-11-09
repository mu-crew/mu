// mu — the base state read: the batched pane read (murmur's pane options or
// remote rows, else the multiplexer's own status) that the `hooks` and `mux`
// channels share. One function, so `readAgentStates` reads every agent on
// either channel in one batch (./dispatch.ts groups agents by their channel's
// read).

import { readBaseStates } from "../agent-state.js";
import type { AgentChannel } from "./types.js";

export const baseReadStates: AgentChannel["readStates"] = (agents, opts) =>
  readBaseStates(agents, opts, opts.livenessOnly);
