// mu — shared VCS backend contracts and typed errors.

import type { HasNextSteps, NextStep } from "../output.js";

export type VcsBackendName = "git";

export interface CommitSummary {
  /** Full commit id. */
  sha: string;
  /** First-line subject. */
  subject: string;
  /** Remainder of the commit message (may be empty). */
  body: string;
  /** Author display name. */
  author: string;
  /** ISO-8601 author timestamp. */
  authorDate: string;
  /** Compact relative author time (e.g. "3m", "2d"). */
  relTime: string;
}

/**
 * Thrown when `--workspace` is asked of a project root that is not a git
 * repo: git worktrees are the only workspace kind. Maps to exit code 4.
 */
export class WorkspaceVcsRequiredError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceVcsRequiredError";
  constructor(public readonly projectRoot: string) {
    super(`--workspace requires a git repository; ${projectRoot} is not inside one`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Run from inside a git repo, or name one",
        command: "mu agent spawn <agent> --workspace --workspace-project-root <git-repo>",
      },
    ];
  }
}

export interface CreateWorkspaceOptions {
  /** The repository being branched from. Absolute path. */
  projectRoot: string;
  /** Where to place the new workspace. Absolute path; must NOT exist. */
  workspacePath: string;
  /** Optional commit / branch id to base off (`git worktree add`'s ref).
   *  Undefined = current head. */
  parentRef?: string;
}

export interface CreateWorkspaceResult {
  /** The actual ref the workspace points at (resolved to a stable id
   *  when possible). Stored on the row; useful for `mu workspace list`
   *  and for `--commit` flows. */
  parentRef: string | null;
}

export interface FreeWorkspaceOptions {
  workspacePath: string;
  /** If true, attempt to commit any pending changes BEFORE removal.
   *  git needs an explicit commit on the worktree. If pending changes exist and `commit`
   *  is false, the on-disk directory still gets removed and changes are
   *  lost — the verb prints a clear warning. */
  commit: boolean;
}

export interface FreeWorkspaceResult {
  /** The commit id that captured the pending changes, when `commit` was
   *  true and there was something to commit. Otherwise undefined. */
  committedRef?: string;
  /** Branch created to keep the workspace's commits reachable after the
   *  worktree is removed (git with `commit`, when HEAD was on no branch,
   *  remote or tag). Otherwise undefined. */
  branch?: string;
  /** True iff the on-disk path was actually removed (vs. already gone). */
  removed: boolean;
}

export interface VcsBackend {
  readonly name: VcsBackendName;

  /** True iff `projectRoot` is inside a git work tree. */
  detect(projectRoot: string): Promise<boolean>;

  createWorkspace(opts: CreateWorkspaceOptions): Promise<CreateWorkspaceResult>;

  freeWorkspace(opts: FreeWorkspaceOptions): Promise<FreeWorkspaceResult>;

  /**
   * Cheap "is the working copy clean?" probe used by close-auto-free:
   * empty `git status --porcelain` (no working-tree modifications, no
   * staged changes, no untracked-not-ignored files). Pure observation.
   * Returns false on any command failure: refuse a close rather than
   * auto-free a workspace whose cleanliness could not be verified.
   */
  isClean(workspacePath: string): Promise<boolean>;

  /**
   * Commits the workspace has on top of `baseRef`, oldest-first. Used by
   * close's refuse-unmerged check. `[]` when the workspace is exactly at
   * baseRef. Throws on command failure (unknown ref, missing repo).
   */
  commitsSinceBase(workspacePath: string, baseRef: string): Promise<CommitSummary[]>;

  /** Dirty (uncommitted / unstaged / untracked-not-ignored) paths in the
   *  workspace; empty = clean. Throws on command failure. */
  listDirtyFiles(workspacePath: string): Promise<string[]>;
}
