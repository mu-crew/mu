// mu — the channel cluster barrel. Call sites import channels from here.
//
// ctl's raw-socket functions (`checkMessage`, `watchAgentRun`,
// `ctlRuntimeState`) are deliberately not re-exported: a call site reaches an
// agent through `agentChannel`, not a socket path. Only the SDK hubs and
// ctl delivery (until U6) import them from ./ctl.js, and
// test/channel-imports.test.ts holds that list.

export {
  blockedReason,
  CTL_DEFAULT_TIMEOUT_MS,
  CtlWriteVetoedError,
  ctlChannel,
  newMsgId,
} from "./ctl.js";
export { agentChannel, channelTarget, readAgentStates } from "./dispatch.js";
export { muxChannel } from "./mux.js";
export { channelOf, expectsCtl } from "./select.js";
export type {
  AgentChannel,
  ChannelName,
  ChannelReadOptions,
  ChannelTarget,
  CtlBlocked,
  CtlState,
  CtlTool,
  MessageCheck,
  RunBaseline,
} from "./types.js";
