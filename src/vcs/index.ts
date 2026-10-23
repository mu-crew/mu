// mu — VCS backend dispatcher. Git worktrees are the only backend.

import { gitBackend } from "./git.js";
import type { VcsBackend, VcsBackendName } from "./types.js";
import { WorkspaceVcsRequiredError } from "./types.js";

export { gitBackend, upstreamRefs } from "./git.js";
export {
  type CommitSummary,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  type VcsBackend,
  type VcsBackendName,
  WorkspaceVcsRequiredError,
} from "./types.js";

/** Return the git backend when `projectRoot` is inside a git work tree
 *  (detection shells out to `git rev-parse --show-toplevel`, so worktrees
 *  and gitdir-pointer files are handled by git itself); otherwise throw
 *  WorkspaceVcsRequiredError. */
export async function detectBackend(projectRoot: string): Promise<VcsBackend> {
  if (await gitBackend.detect(projectRoot)) return gitBackend;
  throw new WorkspaceVcsRequiredError(projectRoot);
}

/** Look up a backend by name (rows store it; "git" is the only value).
 *  Throws on an unknown name. */
export function backendByName(name: VcsBackendName): VcsBackend {
  if (name === gitBackend.name) return gitBackend;
  throw new Error(`unknown vcs backend: ${name}`);
}
