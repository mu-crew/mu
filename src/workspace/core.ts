// mu — shared workspace row shapes, path helpers, and typed errors.

import { join } from "node:path";
import { defaultStateDir } from "../db.js";
import type { HasNextSteps, NextStep } from "../output.js";
import type { VcsBackendName } from "../vcs.js";

export interface WorkspaceRow {
  agentName: string;
  workstreamName: string;
  backend: VcsBackendName;
  path: string;
  parentRef: string | null;
  createdAt: string;
}

export interface RawWorkspaceRow {
  /** Joined from agents.name. */
  agent: string;
  /** Joined from workstreams.name. */
  workstream: string;
  backend: string;
  path: string;
  parent_ref: string | null;
  created_at: string;
}

// SELECT clause that joins vcs_workspaces back to operator-facing
// agent + workstream names (v5 stores surrogate ids; the JS row shape
// is operator-facing TEXT names).
export const SELECT_WS_COLS = `
  ag.name AS agent,
  ws.name AS workstream,
  v.backend AS backend,
  v.path AS path,
  v.parent_ref AS parent_ref,
  v.created_at AS created_at
`;

export const WS_FROM_JOIN = `FROM vcs_workspaces v
  JOIN agents      ag ON ag.id = v.agent_id
  JOIN workstreams ws ON ws.id = v.workstream_id`;

export function rowFromDb(row: RawWorkspaceRow): WorkspaceRow {
  return {
    agentName: row.agent,
    workstreamName: row.workstream,
    backend: row.backend as VcsBackendName,
    path: row.path,
    parentRef: row.parent_ref,
    createdAt: row.created_at,
  };
}

export class WorkspaceExistsError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceExistsError";
  constructor(public readonly agent: string) {
    super(`workspace already exists for agent: ${agent}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Show its on-disk path", command: `mu workspace path ${this.agent}` },
      {
        intent: "Free it (optionally --commit pending changes first)",
        command: `mu workspace free ${this.agent}  (--commit to commit pending changes first)`,
      },
      {
        intent: "Then re-spawn the agent with a fresh workspace",
        command: `mu agent spawn ${this.agent} --workspace --workspace-from <ref>`,
      },
    ];
  }
}

export class WorkspaceNotFoundError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceNotFoundError";
  constructor(public readonly agent: string) {
    super(`no workspace for agent: ${agent}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List workspaces in current workstream", command: "mu workspace list" },
      { intent: "List workspaces across all workstreams", command: "mu workspace list --all" },
      {
        intent: "Spawn the agent with a workspace (creation happens at spawn)",
        command: `mu agent spawn ${this.agent} --workspace`,
      },
    ];
  }
}

/**
 * Thrown by createWorkspace when the on-disk path it would create is
 * already occupied. Distinct from WorkspaceExistsError (which is about
 * the DB row) so the recovery is clear: the dir is orphaned (no DB
 * row points at it) and needs cleanup.
 *
 * Maps to exit code 4 (conflict).
 */
export class WorkspacePathNotEmptyError extends Error implements HasNextSteps {
  override readonly name = "WorkspacePathNotEmptyError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly workspacePath: string,
  ) {
    super(
      `workspace dir already on disk for agent ${agent} (${workspacePath}); refusing to overwrite`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Check it for uncommitted work",
        command: `git -C ${this.workspacePath} status --short`,
      },
      {
        // No row points at the dir (createWorkspace throws
        // WorkspaceExistsError first when one does), so `mu workspace
        // free` has nothing to free.
        intent: "Then remove it by hand (git: also drops the worktree registration)",
        command: `(cd <project-root> && git worktree remove --force ${this.workspacePath}) || rm -rf ${this.workspacePath}`,
      },
    ];
  }
}

/**
 * Thrown by createWorkspace when the resolved projectRoot is the
 * user's $HOME.
 *
 * Maps to exit code 4 (conflict).
 */
export class HomeDirAsProjectRootError extends Error implements HasNextSteps {
  override readonly name = "HomeDirAsProjectRootError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly homeDir: string,
  ) {
    super(
      `refusing to create workspace with projectRoot=$HOME (${homeDir}); a recursive copy/clone of your home directory is almost never what you want`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Re-run from inside a real project directory",
        command: `cd <your-project> && mu agent spawn ${this.agent} -w ${this.workstream} --workspace`,
      },
      {
        intent: "Or pass --workspace-project-root explicitly",
        command: `mu agent spawn ${this.agent} -w ${this.workstream} --workspace --workspace-project-root <your-project>`,
      },
    ];
  }
}

/**
 * Compose the canonical on-disk path for an agent's workspace. Used by
 * createWorkspace and reachable from `mu workspace path` so the user
 * can `cd $(mu workspace path foo)` even before the directory exists.
 */
export function workspacePath(workstream: string, agent: string): string {
  return join(defaultStateDir(), "workspaces", workstream, agent);
}
