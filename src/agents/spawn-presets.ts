// mu — the launch command of a spawn, with its harness row's spawn presets
// (spec D6, D17): the row's model flag for `--model` (pi included); for a
// worker launched from a command mu resolved (its cli key or
// `MU_<KEY>_COMMAND`, not a literal `--command`), local or remote (approvals
// are per worker, D17: a remote worker's flags ride in its remote command),
// the row's auto-approve flags (pi has none: its `--approve` is
// folder trust); for any launch from a command mu resolved, orchestrators
// too, the row's launch flags (codex's `--no-daemon`); and for a worktree mu
// just created, the row's trust flag on its real path (folder trust is per
// exact path): locally its realpath, on a host the physical path the host's
// `pwd -P` answered when it made the worktree. The argv0 is
// untouched, so every rule that reads it (speaksMuCtl, the harness) reads the
// same; the agents row keeps the command as given.

import { realpathSync } from "node:fs";
import { type Harness, withSpawnPresets } from "../harnesses.js";

/** The real path of a directory mu created (`/tmp` is `/private/tmp` on macOS); itself if unreadable. */
function realPathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function launchCommand(
  command: string,
  harness: Harness | undefined,
  opts: { model?: string; command?: string; orchestrator?: boolean },
  where: { remote: boolean; worktree?: string },
): string {
  const model = opts.model !== undefined ? { model: opts.model } : {};
  const resolved = opts.command === undefined;
  const approve = resolved && opts.orchestrator !== true;
  const trustPath =
    where.worktree === undefined
      ? undefined
      : where.remote
        ? where.worktree
        : realPathOf(where.worktree);
  return withSpawnPresets(command, harness, {
    ...model,
    approve,
    resolved,
    ...(trustPath !== undefined ? { trustPath } : {}),
  });
}
