// mu — `mu agent collect <name>`: bring a remote worker's commits home
// (src/remote-collect.ts). Kept out of src/cli/agents.ts, which is past its cap.

import type { Command } from "commander";
import {
  applyQualifiedRef,
  assertAgentInWorkstream,
  emitJson,
  handle,
  JSON_OPT,
  parseNonNegativeInt,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { say } from "../messages.js";
import { pc } from "../output.js";
import { collectRemoteAgent } from "../remote-collect.js";
import { recoveriesFor } from "../remote-recovery.js";
import { gitToplevel } from "../vcs/git.js";
import { closeScope } from "./agent-close.js";

export async function cmdCollect(
  db: Db,
  rawName: string,
  opts: { workstream?: string; json?: boolean; recovery?: number } = {},
): Promise<void> {
  const name = applyQualifiedRef(rawName, opts);
  const ws = await closeScope(db, name, opts.workstream);
  // A removed agent's recovery record is a target too (qualified ref or -w names its workstream).
  if (opts.recovery === undefined && recoveriesFor(db, ws, name).length === 0) {
    assertAgentInWorkstream(db, name, opts.workstream);
  }
  const repo = await gitToplevel(process.cwd());
  if (repo === undefined) {
    throw new UsageError(say("agent.collect_cwd"));
  }
  const r = await collectRemoteAgent(db, {
    workstream: ws,
    name,
    repo,
    ...(opts.recovery === undefined ? {} : { recoveryId: opts.recovery }),
  });
  if (opts.json) {
    emitJson({ agentName: name, ...r });
    return;
  }
  console.log(
    r.changed
      ? `Collected ${pc.bold(name)} at ${r.head.slice(0, 12)} (pinned as ${r.ref})`
      : `${pc.bold(name)} has nothing new: still ${r.head.slice(0, 12)} (pinned as ${r.ref})`,
  );
  console.log(pc.dim(`  merge it yourself (mu never merges): ${r.merge}`));
}

export function wireCollectCommand(agent: Command): void {
  agent
    .command("collect <name>")
    .description(
      "Fetch a remote worker's commits into the git repo of the current directory (the profile's --fetch template, run locally) and pin the fetched commit as refs/mu/collect/<ws>/<agent>. Records it as the collected HEAD (what `agent close` accepts) and prints the merge command with the exact sha; mu never merges. At --max-sessions 1 a live worker holds the host's only channel: refused with the holder named until its pane is gone or the cap is raised. Local and --cwd-only agents have nothing to collect (exit 2). When the agent's row is gone (reaped, torn down) but its remote worktree was kept as a recovery record, the same name collects from that worktree (a record only; --recovery <id> when several share the name), and a collect that would move the ref another record's collected commit relies on refuses.",
    )
    .option(
      "--recovery <id>",
      "collect from the remote worktree of the removed agent with this recovery id (shown by `agent close`'s preview; needed when several records share the name)",
      parseNonNegativeInt,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        recovery?: number;
      };
      return handle((db) => cmdCollect(db, name, opts), this as Command)();
    });
}
