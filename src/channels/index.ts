// mu — the channel cluster barrel. Call sites import channels from here.
//
// ctl's raw-socket functions (`checkMessage`, `watchAgentRun`,
// `ctlRuntimeState`) are deliberately not re-exported: a call site reaches an
// agent through `agentChannel` or `deliver`, not a socket path. Only the SDK
// hubs import them from ./ctl.js, and test/channel-imports.test.ts holds that
// list.

export {
  blockedReason,
  CTL_DEFAULT_TIMEOUT_MS,
  CtlWriteVetoedError,
  ctlChannel,
  newMsgId,
} from "./ctl.js";
export {
  CTL_SLASH_COMMANDS,
  isSlashCommand,
  parseSessionCommand,
  requireFeature,
  respawnCommand,
} from "./ctl-deliver.js";
export { deliver } from "./deliver.js";
export { agentChannel, channelTarget, readAgentStates } from "./dispatch.js";
export { ANSWER_KEY_NAMES, hooksChannel, hooksFence } from "./hooks.js";
export { sendAckMs, writeMuEvent } from "./hooks-pane.js";
export { muxChannel } from "./mux.js";
export { agentCtlSocket, channelOf, expectsCtl } from "./select.js";
export {
  type AbortOutcome,
  type AgentChannel,
  type AnswerResult,
  CHANNEL_NAMES,
  type ChannelDelivery,
  type ChannelName,
  type ChannelReadOptions,
  type ChannelTarget,
  type CtlBlocked,
  type CtlCommandName,
  type CtlGuard,
  type CtlState,
  type CtlTool,
  type DeliveryOptions,
  type DeliveryTarget,
  type InterruptResult,
  type MessageCheck,
  type RunBaseline,
  type SendResult,
  type SessionCommand,
} from "./types.js";
