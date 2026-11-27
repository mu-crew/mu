// mu — `mu agent model <name> <provider/id> [--effort <e>]`: switch a running
// pi agent's model over its control socket. Kept out of src/cli/agents.ts,
// which is past its cap.

import type { Command } from "commander";
import { setAgentModel } from "../agents/model.js";
import { CTL_EFFORTS, type CtlEffort, parseModelRef } from "../channels/index.js";
import {
  assertAgentInWorkstream,
  emitJson,
  handle,
  JSON_OPT,
  resolveEntityRef,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { pc } from "../output.js";

function parseEffort(raw: string): CtlEffort {
  const e = CTL_EFFORTS.find((x) => x === raw);
  if (e === undefined) {
    throw new UsageError(`--effort must be one of ${CTL_EFFORTS.join(", ")} (got ${raw})`);
  }
  return e;
}

export async function cmdModel(
  db: Db,
  rawName: string,
  model: string,
  opts: { workstream?: string; effort?: string; json?: boolean } = {},
): Promise<void> {
  if (parseModelRef(model) === undefined) {
    throw new UsageError(
      `model must be <provider>/<id>, e.g. anthropic/claude-sonnet-4-5 (got ${model})`,
    );
  }
  const effort = opts.effort === undefined ? undefined : parseEffort(opts.effort);
  const { name, workstream: ws } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const r = await setAgentModel(db, name, model, {
    workstream: ws,
    ...(effort !== undefined ? { effort } : {}),
  });
  if (opts.json) {
    emitJson(r);
    return;
  }
  const thinking = r.thinkingLevel === undefined ? "" : pc.dim(` (thinking ${r.thinkingLevel})`);
  console.log(`${pc.bold(name)} → ${r.model ?? model}${thinking}`);
}

export function wireModelCommand(agent: Command): void {
  agent
    .command("model <name> <model>")
    .description(
      "Switch a running pi agent's model (<provider>/<id>, as pi's /model) over its control socket; a busy turn finishes on the old one. Refused (exit 2) for an agent not on the ctl channel.",
    )
    .option(
      "--effort <level>",
      `also set the thinking level: ${CTL_EFFORTS.join("|")} (pi clamps it to the model)`,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string, model: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        effort?: string;
        json?: boolean;
      };
      return handle((db) => cmdModel(db, name, model, opts), this as Command)();
    });
}
