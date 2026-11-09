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
export { ANSWER_KEY_NAMES, hooksChannel, hooksRunBaseline } from "./hooks.js";
export { sendAckMs, writeMuEvent } from "./hooks-pane.js";
export {
  acknowledgeTurnFailure,
  awaitHooksSession,
  type HooksReadiness,
  type HooksRunCheck,
  type HooksTurnFailure,
  hooksRunSince,
  hooksTurnFailure,
  spawnAckMs,
} from "./hooks-spawn.js";
export { muxChannel } from "./mux.js";
export { channelNamed, registerChannel, registeredChannels, sentRun } from "./registry.js";
export { agentCtlSocket, channelOf, expectsCtl, piOnHooks, servesCtl } from "./select.js";
export {
  type AbortOutcome,
  type AgentChannel,
  type AnswerResult,
  type BuiltinChannelName,
  CHANNEL_NAMES,
  type ChannelCaps,
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
  type SentFacts,
  type SentRun,
  type SessionCommand,
} from "./types.js";
