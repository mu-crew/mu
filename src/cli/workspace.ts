// mu — `mu workspace` verbs (list / free / path).
//
// Workspace CREATION is not a standalone verb: it happens inside
// `mu agent spawn --workspace`. For destructive cleanup use `free`.
//
// Per-agent git worktrees (registry layer on top of vcs.ts).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { dirname } from "node:path";
import { agentKey, readAgentStates } from "../agent-state.js";
import { getAgent, WorkspaceOwnerBusyError } from "../agents.js";
import {
  assertAgentInWorkstream,
  emitJson,
  emitJsonCollection,
  formatWorkspacesTable,
  resolveEntityRef,
  resolveWorkstream,
} from "../cli.js";
import type { Db } from "../db.js";
import { activeMux } from "../mux.js";
import { pc } from "../output.js";
import {
  freeWorkspace,
  getWorkspaceForAgent,
  listWorkspaces,
  WorkspaceNotFoundError,
} from "../workspace.js";

export async function cmdWorkspaceList(
  db: Db,
  opts: { workstream?: string; all?: boolean; json?: boolean },
): Promise<void> {
  const workstream = opts.all ? undefined : await resolveWorkstream(opts.workstream);
  const rows = listWorkspaces(db, workstream);
  if (opts.json) {
    emitJsonCollection(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(pc.dim(workstream ? `(no workspaces in ${workstream})` : "(no workspaces)"));
    return;
  }
  console.log(formatWorkspacesTable(rows));
}

/**
 * Refuse to free a workspace under a working agent. Refuses on busy,
 * needs_permission, or unknown with a live pane; allows needs_input
 * (idle at the prompt), a dead pane, and an agent with no pane.
 * Returns the state checked, or undefined when no check applied.
 */
async function guardOwnerState(
  db: Db,
  agent: string,
  workstream: string,
): Promise<string | undefined> {
  const row = getAgent(db, agent, workstream);
  if (!row?.paneId) return undefined;
  const reading = (await readAgentStates([row], { stateDir: dirname(db.name) })).get(agentKey(row));
  const state = reading?.state ?? "unknown";
  if (state === "needs_input") return state;
  if (state === "unknown") {
    let live: boolean;
    try {
      live = await (await activeMux()).paneAlive(row.paneId);
    } catch {
      throw new WorkspaceOwnerBusyError(
        agent,
        workstream,
        state,
        "pane liveness probe failed; state unknown",
      );
    }
    if (!live) return state;
  }
  throw new WorkspaceOwnerBusyError(agent, workstream, state);
}

export async function cmdWorkspaceFree(
  db: Db,
  rawAgent: string,
  opts: { commit?: boolean; force?: boolean; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
  assertAgentInWorkstream(db, agent, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const checkedState = opts.force ? undefined : await guardOwnerState(db, agent, ws);
  const r = await freeWorkspace(db, agent, { commit: opts.commit ?? false, workstream: ws });
  if (opts.json) {
    emitJson({
      agentName: agent,
      ...r,
      ...(checkedState !== undefined ? { ownerState: checkedState } : {}),
    });
    return;
  }
  if (!r.removed && !r.rowDeleted) {
    console.log(pc.dim(`no workspace for ${agent} (already gone?)`));
    return;
  }
  const committed = r.committedRef
    ? pc.dim(` (auto-committed: ${r.committedRef.slice(0, 12)})`)
    : "";
  console.log(`Freed workspace for ${pc.bold(agent)}${committed}`);
  if (r.branch) console.log(pc.dim(`  commits kept on branch ${r.branch}`));
}

export async function cmdWorkspacePath(
  db: Db,
  rawAgent: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: agent } = await resolveEntityRef(db, rawAgent, opts, "workspace");
  assertAgentInWorkstream(db, agent, opts.workstream);
  const wsName = await resolveWorkstream(opts.workstream);
  const ws = getWorkspaceForAgent(db, agent, wsName);
  if (!ws) throw new WorkspaceNotFoundError(agent);
  if (opts.json) {
    emitJson({ agentName: agent, path: ws.path, backend: ws.backend });
    return;
  }
  // Print just the path, no decoration: usable for `cd $(mu workspace path X)`.
  console.log(ws.path);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireWorkspaceCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { handle, JSON_OPT, WORKSTREAM_OPT } from "../cli.js";

export function wireWorkspaceCommands(program: Command): void {
  const workspace = program
    .command("workspace")
    .description("Workspace commands (per-agent git worktrees)");

  workspace
    .command("list")
    .description("List workspaces in the current workstream (--all spans every workstream)")
    .option("--all", "list workspaces across every workstream")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        all?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceList(db, opts), this as Command)();
    });

  workspace
    .command("free <agent>")
    .description(
      "Tear down an agent's workspace. With --commit, attempt to auto-commit pending changes first; without it, pending changes are lost. Refuses (exit 4) while the owning agent is busy, awaiting permission, or unreadable with a live pane; --force skips only that check. For git, --commit also creates a branch mu/<workstream>/<agent>-<sha> when the worktree's commits are on no branch, so they survive removal.",
    )
    .option("--commit", "auto-commit pending changes before removing the workspace")
    .option("--force", "skip the owner-agent state check (does not make removal any safer)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as {
        commit?: boolean;
        force?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdWorkspaceFree(db, agent, opts), this as Command)();
    });

  workspace
    .command("path <agent>")
    .description(
      "Print the on-disk path of an agent's workspace. Usable as `cd $(mu workspace path foo)`.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdWorkspacePath(db, agent, opts), this as Command)();
    });
}
