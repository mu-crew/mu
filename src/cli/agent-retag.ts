// mu — `mu agent retag [-w ws] [name...]`: write the crew identity murmur reads
// (tmux `@mu_*` pane options, Rex block label) again on live agents whose pane
// lacks it. Idempotent. Kept out of src/cli/agents.ts, which is past its cap.

import type { Command } from "commander";
import { type RetagResult, retagAgents } from "../agents/crew-tags.js";
import { emitJson, handle, JSON_OPT } from "../cli.js";
import type { Db } from "../db.js";
import { say } from "../messages.js";
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
  const missing = results.filter((r) => r.status === "not_found");
  if (opts.json) {
    if (missing.length > 0) {
      throw new CliExitError(3, {
        error: "AgentNotFoundError",
        message: `no agent named ${missing.map((r) => r.name).join(", ")}${opts.workstream !== undefined ? ` in ${opts.workstream}` : ""}`,
        data: { agents: results },
      });
    }
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
    const who = r.paneId === undefined ? r.name : `${r.workstream}/${r.name} (${r.paneId})`;
    const was = r.wrong !== undefined ? pc.dim(` was: ${r.wrong.join(", ")}`) : "";
    const pad = (s: string) => s.padEnd(10);
    if (r.status === "changed") console.log(`${pc.green(pad("retagged"))} ${who}${was}`);
    else if (r.status === "ok") console.log(`${pc.dim(pad("ok"))} ${who}`);
    else if (r.status === "gone") console.log(`${pc.dim(pad("gone"))} ${who}`);
    else if (r.status === "retired") console.log(`${pc.dim(pad("retired"))} ${who}: herdr pane`);
    else if (r.status === "foreign")
      console.log(`${pc.dim(pad("foreign"))} ${who}: not a ${mux.name} pane`);
    else if (r.status === "unverified")
      console.log(`${pc.yellow(pad("unverified"))} ${who}: ${say("agent.retag_unverified")}`);
    else if (r.status === "partial") console.log(`${pc.yellow(pad("partial"))} ${who}${was}`);
    else if (r.status === "not_found") console.error(`${pc.red(pad("not found"))} ${who}`);
    else console.error(`${pc.red(pad("failed"))} ${who}: ${r.error ?? "?"}`);
  }
  if (missing.length > 0) throw new CliExitError(3);
  if (failed.length > 0) throw new CliExitError(1);
  return results;
}

export function wireRetagCommand(agent: Command): void {
  agent
    .command("retag [names...]")
    .description(
      "Rewrite the crew tags murmur reads (tmux @mu_*, Rex block label) on live agents missing them; idempotent. No names: every agent of -w (else all).",
    )
    .option("-w, --workstream <name>", "workstream (optional: without it, every agent)")
    .option(...JSON_OPT)
    .action(function (names: string[]) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle(async (db) => {
        await cmdRetag(db, names, opts);
      }, this as Command)();
    });
}
