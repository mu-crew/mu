// mu — `mu agent retag [-w ws] [name...]`: write the crew identity murmur reads
// (tmux `@mu_*` pane options, Rex block label) again on live agents whose pane
// lacks it. Idempotent. Kept out of src/cli/agents.ts, which is past its cap.

import type { Command } from "commander";
import { type RetagResult, retagAgents } from "../agents/crew-tags.js";
import { emitJson, handle, JSON_OPT, WORKSTREAM_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { activeMux } from "../mux.js";
import { pc } from "../output.js";
import { CliExitError } from "./handle.js";

export async function cmdRetag(
  db: Db,
  names: readonly string[],
  opts: { workstream?: string; json?: boolean } = {},
): Promise<RetagResult[]> {
  const mux = await activeMux();
  const results = await retagAgents(db, mux, {
    ...(opts.workstream !== undefined ? { workstream: opts.workstream } : {}),
    names,
  });
  const failed = results.filter((r) => r.status === "failed");
  if (opts.json) {
    if (failed.length > 0) {
      throw new CliExitError(1, {
        error: "RetagFailedError",
        message: `${failed.length} agent pane(s) could not be retagged`,
        data: { agents: results },
      });
    }
    emitJson({ agents: results });
    return results;
  }
  if (results.length === 0) console.log(pc.dim("no agents to retag"));
  for (const r of results) {
    const who = `${r.workstream}/${r.name} (${r.paneId})`;
    const was = r.wrong !== undefined ? pc.dim(` was: ${r.wrong.join(", ")}`) : "";
    if (r.status === "changed") console.log(`${pc.green("retagged")} ${who}${was}`);
    else if (r.status === "ok") console.log(`${pc.dim("ok")}       ${who}`);
    else if (r.status === "gone") console.log(`${pc.dim("gone")}     ${who}`);
    else if (r.status === "partial") console.log(`${pc.yellow("partial")}  ${who}${was}`);
    else console.error(`${pc.red("failed")}   ${who}: ${r.error ?? "?"}`);
  }
  if (failed.length > 0) throw new CliExitError(1);
  return results;
}

export function wireRetagCommand(agent: Command): void {
  agent
    .command("retag [names...]")
    .description(
      "Rewrite the crew tags murmur reads (tmux @mu_*, Rex block label) on live agents missing them; idempotent. No names: every agent of -w (else all).",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (names: string[]) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle(async (db) => {
        await cmdRetag(db, names, opts);
      }, this as Command)();
    });
}
