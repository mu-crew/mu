// mu — workspace SDK hub.
//
// Per-agent git-worktree implementation lives in the cohesive
// src/workspace/ cluster. This root file preserves the public
// `import { ... } from "./workspace.js"` surface.

export {
  HomeDirAsProjectRootError,
  type RawWorkspaceRow,
  rowFromDb,
  SELECT_WS_COLS,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  type WorkspaceRow,
  WS_FROM_JOIN,
  workspacePath,
} from "./workspace/core.js";
export {
  type CreateWorkspaceOptions,
  createWorkspace,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  freeWorkspace,
  getWorkspaceForAgent,
  isWorkspaceClean,
  listWorkspaces,
} from "./workspace/crud.js";
