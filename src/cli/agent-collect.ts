// mu — `mu agent collect <name>`: bring a remote worker's commits home
// (src/remote-collect.ts). Kept out of src/cli/agents.ts, which is past its cap.

import type { Command } from "commander";
import {
  assertAgentInWorkstream,
  emitJson,
  handle,
  JSON_OPT,
  resolveEntityRef,
  resolveWorkstream,
  UsageError,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import { collectRemoteAgent } from "../remote-collect.js";
import { gitToplevel } from "../vcs/git.js";

export async function cmdCollect(
  db: Db,
  rawName: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const repo = await gitToplevel(process.cwd());
  if (repo === undefined) {
    throw new UsageError(
      "agent collect fetches into the git repo of the current directory: cd into it",
    );
  }
  const r = await collectRemoteAgent(db, { workstream: ws, name, repo });
  const next: NextStep[] = [{ intent: "Merge it (mu never merges)", command: r.merge }];
  if (opts.json) {
    emitJson({ agentName: name, ...r, nextSteps: next });
    return;
  }
  console.log(
    r.changed
      ? `Collected ${pc.bold(name)} at ${r.head.slice(0, 12)} (pinned as ${r.ref})`
      : `${pc.bold(name)} has nothing new: still ${r.head.slice(0, 12)} (pinned as ${r.ref})`,
  );
  printNextSteps(next);
}

export function wireCollectCommand(agent: Command): void {
  agent
    .command("collect <name>")
    .description(
      "Fetch a remote worker's commits into the git repo of the current directory (the profile's --fetch template, run locally) and pin the fetched commit as refs/mu/collect/<ws>/<agent>. Records it as the collected HEAD (what `agent close` accepts) and prints the merge command with the exact sha; mu never merges. At --max-sessions 1 a live worker holds the host's only channel: refused with the holder named until its pane is gone or the cap is raised. Local and --cwd-only agents have nothing to collect (exit 2).",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdCollect(db, name, opts), this as Command)();
    });
}
