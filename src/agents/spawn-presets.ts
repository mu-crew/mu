// mu — the launch command of a spawn, with its harness row's spawn presets
// (spec D6, D17): the row's model flag for `--model` (pi included); locally,
// for a worker launched from a command mu resolved (its cli key or
// `MU_<KEY>_COMMAND`, not a literal `--command`), the row's in-sandbox
// auto-approve flags (pi has none: its `--approve` is folder trust); and for a
// worktree mu just created, the row's trust flag on its real path (folder
// trust is per exact path). The argv0 is untouched, so every rule that reads
// it (speaksMuCtl, the harness) reads the same; the agents row keeps the
// command as given.

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
  if (where.remote) return withSpawnPresets(command, harness, { ...model, approve: false });
  return withSpawnPresets(command, harness, {
    ...model,
    approve: opts.command === undefined && opts.orchestrator !== true,
    ...(where.worktree !== undefined ? { trustPath: realPathOf(where.worktree) } : {}),
  });
}
