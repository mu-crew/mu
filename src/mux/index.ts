// mu — multiplexer backend dispatcher.

export { activeMux, detectMux, muxByName, resetMux, setMuxForTests } from "./detect.js";
export {
  HerdrCommandOverrideError,
  HerdrError,
  HerdrSyntaxError,
  HerdrUnsupportedCliError,
  HerdrWorkspaceGroupCloseError,
  herdrBackend,
  isHerdrStatusUsable,
  resetHerdrExecutor,
  setHerdrExecutor,
} from "./herdr.js";
export { tmuxBackend } from "./tmux.js";
export {
  type AttachTarget,
  attachShellLine,
  type CaptureOptions,
  type EnsureSessionResult,
  MU_PLACEHOLDER_WINDOW,
  type MuxBackend,
  type MuxBackendName,
  type MuxCommand,
  type MuxDiagnostics,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxPaneStatus,
  NoMultiplexerError,
  PaneNotFoundError,
  type PaneResult,
  type SendOptions,
  type SendWarning,
  type SpawnAgentPaneOptions,
} from "./types.js";
