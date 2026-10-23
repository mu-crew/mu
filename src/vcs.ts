// mu — VCS workspace abstraction hub (git worktrees only).
//
// The backend lives in the cohesive src/vcs/ cluster. This root file
// preserves the public `import { ... } from "./vcs.js"` surface.

export {
  backendByName,
  type CommitSummary,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  detectBackend,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  gitBackend,
  type VcsBackend,
  type VcsBackendName,
  WorkspaceVcsRequiredError,
} from "./vcs/index.js";
