// mu — multiplexer backend hub.
//
// Concrete backends live in the cohesive src/mux/ cluster: one file per
// backend plus shared types and detection. This root file is the public
// `import { ... } from "./mux.js"` surface, mirroring src/vcs.ts.
//
// A "mux" is the terminal multiplexer that owns panes. Exactly one is
// active per mu invocation, resolved by `activeMux()`. Everything
// backend-specific — topology, the send protocol, capture, pane-id
// validation, identity fallback — lives behind `MuxBackend`.
//
// See docs/VOCABULARY.md § "mux backend" and docs/architecture/mux.md
// § "One mux session per workstream".

export {
  type AttachTarget,
  activeMux,
  attachShellLine,
  type CaptureOptions,
  detectMux,
  type EnsureSessionResult,
  HerdrCommandOverrideError,
  HerdrError,
  HerdrSyntaxError,
  HerdrUnsupportedCliError,
  HerdrWorkspaceGroupCloseError,
  herdrBackend,
  isHerdrStatusUsable,
  MU_PLACEHOLDER_WINDOW,
  type MuxBackend,
  type MuxBackendName,
  type MuxCommand,
  type MuxDiagnostics,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxPaneStatus,
  muxByName,
  NoMultiplexerError,
  PaneNotFoundError,
  type PaneResult,
  resetHerdrExecutor,
  resetMux,
  type SendOptions,
  type SendWarning,
  type SpawnAgentPaneOptions,
  setHerdrExecutor,
  setMuxForTests,
  tmuxBackend,
} from "./mux/index.js";
