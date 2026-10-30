// mu — `mu human-needed <reason>`: the loop's one explicit stop for a human decision.

import type { Command } from "commander";
import { spawnerFromEnv } from "../agents/spawn.js";
import { emitJson, handle, JSON_OPT, resolveExistingWorkstream, WORKSTREAM_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { recordHumanNeeded } from "../human-needed.js";
import { pc } from "../output.js";

async function cmdHumanNeeded(
  db: Db,
  reason: string,
  opts: { workstream?: string; json?: boolean; stop?: boolean },
): Promise<void> {
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const stop = opts.stop !== false;
  const r = recordHumanNeeded(db, {
    workstream: ws,
    caller: spawnerFromEnv() ?? "",
    reason,
    stop,
  });
  if (opts.json) {
    emitJson({ workstream: ws, id: r.id, changed: r.changed, stop });
    return;
  }
  console.log(
    r.changed
      ? `Recorded human-needed ${pc.bold(r.id)} in ${ws}${stop ? "" : " (no stop: the loop goes on)"}`
      : pc.dim(`${r.id} already records this reason (no-op)`),
  );
}

export function wireHumanNeededCommand(program: Command): void {
  program
    .command("human-needed <reason>")
    .description(
      "Stop the loop for a human decision: record a parked `human` task with <reason>. Scoped to the caller; closes only by `mu task close`. Running work is still collected; nothing new starts.",
    )
    .option(
      "--no-stop",
      "record a human item that does NOT stop the loop (a to-do for later: 'tag it', 'the rollout week'); one task per reason",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (reason: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        stop?: boolean;
      };
      return handle((db) => cmdHumanNeeded(db, reason, opts), this as Command)();
    });
}
