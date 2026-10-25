// mu — `mu human-needed <reason>`: the loop's one explicit stop for a human decision.

import type { Command } from "commander";
import { spawnerFromEnv } from "../agents/spawn.js";
import { emitJson, handle, JSON_OPT, resolveWorkstream, WORKSTREAM_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { recordHumanNeeded } from "../human-needed.js";
import { type NextStep, pc, printNextSteps } from "../output.js";

async function cmdHumanNeeded(
  db: Db,
  reason: string,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const ws = await resolveWorkstream(opts.workstream);
  const r = recordHumanNeeded(db, { workstream: ws, caller: spawnerFromEnv() ?? "", reason });
  const nextSteps: NextStep[] = [
    {
      intent: "Close it once the human has decided",
      command: `mu task close ${r.id} -w ${ws} --evidence "<the decision>"`,
    },
  ];
  if (opts.json) {
    emitJson({ workstream: ws, id: r.id, changed: r.changed, nextSteps });
    return;
  }
  console.log(
    r.changed
      ? `Recorded human-needed ${pc.bold(r.id)} in ${ws}`
      : pc.dim(`${r.id} already records this reason (no-op)`),
  );
  printNextSteps(nextSteps);
}

export function wireHumanNeededCommand(program: Command): void {
  program
    .command("human-needed <reason>")
    .description(
      "Stop the loop for a human decision: record a parked `human` task with <reason>. Scoped to the caller; closes only by `mu task close`. Never recorded automatically.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (reason: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdHumanNeeded(db, reason, opts), this as Command)();
    });
}
