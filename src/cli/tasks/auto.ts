// mu — `mu task auto` (explicit, host-fenced permission for `mu next`).
//
// Thin CLI over src/task-auto.ts: parse, resolve the workstream, check the
// cli key resolves to a binary, call authorizeTasks, print one line.

import {
  AgentSpawnCliNotFoundError,
  checkCommandResolvable,
  envVarNameForCli,
  resolveCliCommand,
} from "../../agents.js";
import {
  assertTaskInWorkstream,
  emitJson,
  parseCsvFlag,
  resolveEntityRef,
  resolveExistingWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { say } from "../../messages.js";
import { pc } from "../../output.js";
import { authorizeTasks, TaskAutoArgError } from "../../task-auto.js";
import { resolveActorIdentity } from "../../tasks.js";

export async function cmdTaskAuto(
  db: Db,
  rawIds: readonly string[],
  opts: {
    blockersOf?: string;
    cli?: string;
    worktree?: boolean;
    max?: number;
    off?: boolean;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const off = opts.off === true;
  if (!off && (opts.cli === undefined || opts.cli === "")) {
    throw new TaskAutoArgError(say("task.auto_cli_required"));
  }
  const cli = opts.cli ?? "";
  // Qualified refs carry their workstream; resolve each against the same -w.
  const ids: string[] = [];
  for (const raw of parseCsvFlag(rawIds, "task ids")) {
    const { name } = await resolveEntityRef(db, raw, opts, "task");
    assertTaskInWorkstream(db, name, opts.workstream);
    ids.push(name);
  }
  let blockersOf: string | undefined;
  if (opts.blockersOf !== undefined) {
    const { name } = await resolveEntityRef(db, opts.blockersOf, opts, "task");
    assertTaskInWorkstream(db, name, opts.workstream);
    blockersOf = name;
  }
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  if (!off) {
    const check = await checkCommandResolvable(resolveCliCommand(cli));
    if (!check.ok) throw new AgentSpawnCliNotFoundError(cli, check.binary, envVarNameForCli(cli));
  }
  const r = authorizeTasks(db, ids, {
    workstream: ws,
    cli,
    worktree: opts.worktree === true,
    maxRuns: opts.max ?? 1,
    ...(off ? { off } : {}),
    ...(blockersOf !== undefined ? { blockersOf } : {}),
    actor: await resolveActorIdentity(),
  });
  if (opts.json) {
    emitJson({ ids: r.ids, changed: r.changed, off });
    return;
  }
  const verb = off ? "Revoked auto on" : "Authorised auto for";
  console.log(
    `${verb} ${r.ids.length} task${r.ids.length === 1 ? "" : "s"}: ${pc.bold(r.ids.join(", "))}${r.changed ? "" : pc.dim(" (no change)")}`,
  );
}
