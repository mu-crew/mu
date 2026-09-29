// mu — `mu task` lifecycle verbs (status transitions).
//
// close / open / park / unpark. Each delegates to the SDK; changes are captured as ops
// and optionally reported as evidence notes.
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.

import { refreshAgentTitle } from "../../agents.js";
import {
  assertTaskInWorkstream,
  emitJson,
  resolveEntityRef,
  resolveWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { formatPair, type TaskPair } from "../../tasks/status.js";
import {
  type CloseSubstate,
  closeTask,
  getTask,
  openTask,
  parkTask,
  resolveActorIdentity,
  unparkTask,
} from "../../tasks.js";
import { backendByName } from "../../vcs.js";
import { getWorkspaceForAgent } from "../../workspace.js";

export async function cmdTaskClose(
  db: Db,
  rawId: string,
  opts: {
    evidence?: string;
    ifReady?: boolean;
    as?: string;
    why?: string;
    workstream?: string;
    json?: boolean;
  } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const actor = await resolveActorIdentity();
  const sdkOpts: Parameters<typeof closeTask>[2] = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.ifReady) sdkOpts.ifReady = true;
  // closeTask validates the substate (InvalidSubstateError) and the
  // required --why (SubstateReasonRequiredError) before any write; the
  // cast only narrows the type, the SDK owns the check.
  if (opts.as !== undefined) sdkOpts.as = opts.as.toLowerCase() as CloseSubstate;
  if (opts.why !== undefined) sdkOpts.why = opts.why;
  // The reason note is attributed like the evidence note.
  if (opts.why !== undefined && opts.why !== "") sdkOpts.author = actor;
  // mufeedback task_close_evidence_does_not_append_the: closeTask
  // auto-inserts a `CLOSE: <evidence>` note when --evidence is
  // non-empty. Resolve the actor identity once per close so the note is
  // attributed to the closing worker (mu-spawned worker via
  // MU_AGENT_NAME, adopted pane via title, otherwise $USER /
  // 'orchestrator') and so the success Next: hints can inspect that
  // actor's workspace without resolving identity a second time.
  if (opts.evidence !== undefined && opts.evidence !== "") {
    sdkOpts.author = actor;
  }
  // Capture the owner BEFORE closeTask so we can refresh their title
  // even though closeTask doesn't return owner info. owner won't
  // change as a result of close (FK SET NULL only fires on delete).
  const taskRow = getTask(db, localId, ws);
  const r = closeTask(db, localId, sdkOpts);
  // --if-ready can return a CloseSkippedResult (no mutation). Branch
  // first so the typed `skipped` field stays in scope below.
  if ("skipped" in r) {
    const blockingNextSteps: NextStep[] = [
      {
        intent: "Watch the remaining blockers (returns when one closes)",
        command: `mu task wait ${r.blockingIds.join(" ")} -w ${ws} --first --any --on-stall exit`,
      },
      { intent: "Show the umbrella + blockers", command: `mu task show ${localId} -w ${ws}` },
      {
        intent: "Close anyway (override --if-ready)",
        command: `mu task close ${localId} -w ${ws}`,
      },
    ];
    if (opts.json) {
      emitJson({ taskName: localId, ...r, nextSteps: blockingNextSteps });
      return;
    }
    const total = r.blockingIds.length;
    const shown = r.blockingIds.slice(0, 8).join(", ");
    const tail = total > 8 ? ", \u2026" : "";
    console.log(
      pc.dim(
        `Skipped ${pc.bold(localId)}: blocked by ${total} task(s) (${shown}${tail}); rerun without --if-ready to close anyway`,
      ),
    );
    printNextSteps(blockingNextSteps);
    return;
  }
  if (r.changed && taskRow?.ownerName) await refreshAgentTitle(db, taskRow.ownerName, ws);
  const pickNext: NextStep = {
    intent: r.unblocked.length > 0 ? "Pick up an unblocked task" : "Pick the next ready task",
    command: `mu task next -w ${ws}`,
  };
  const reopen: NextStep = {
    intent: "Reopen if needed",
    command: `mu task open ${localId} -w ${ws}`,
  };
  // A non-done close that released dependents leads with them.
  const nextSteps: NextStep[] = [
    ...(r.unblocked.length > 0 ? [pickNext, reopen] : [reopen, pickNext]),
    { intent: "See full state", command: `mu state -w ${ws}` },
  ];
  if (r.changed && r.status === "CLOSED") {
    await maybeAppendDirtyWorkspaceCommitHint(db, nextSteps, actor, ws, taskRow?.title ?? localId);
  }
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already CLOSED (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Closed ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  if (ev) console.log(ev);
  if (r.unblocked.length > 0) console.log(`Unblocked: ${r.unblocked.join(", ")}`);
  printNextSteps(nextSteps);
}

/** "OPEN → CLOSED/wontfix": the pair transition a lifecycle verb made. */
function transition(r: {
  previousStatus: TaskPair["status"];
  previousSubstate: TaskPair["substate"];
  status: TaskPair["status"];
  substate: TaskPair["substate"];
}): string {
  const from = formatPair({ status: r.previousStatus, substate: r.previousSubstate });
  return `${from} → ${formatPair({ status: r.status, substate: r.substate })}`;
}

async function maybeAppendDirtyWorkspaceCommitHint(
  db: Db,
  nextSteps: NextStep[],
  actor: string,
  workstream: string,
  taskTitle: string,
): Promise<void> {
  if (actor.length === 0) return;
  try {
    const row = getWorkspaceForAgent(db, actor, workstream);
    if (row === undefined || row.backend === "none") return;
    const backend = backendByName(row.backend);
    const clean = await backend.isClean(row.path);
    if (clean) return;
    nextSteps.push({
      intent: "Don't forget to commit",
      command: `cd $(mu workspace path ${actor} -w ${workstream}) && git commit -am ${shellSingleQuote(taskTitle)}`,
    });
  } catch {
    // Best-effort hint only: a VCS probe failure must never make
    // `mu task close` fail after the task successfully closed.
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function cmdTaskOpen(
  db: Db,
  rawId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sdkOpts: { evidence?: string; workstream: string } = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = openTask(db, localId, sdkOpts);
  const nextSteps: NextStep[] = [
    {
      intent: "Claim it",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Close again", command: `mu task close ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Reopened ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  if (ev) console.log(ev);
  printNextSteps(nextSteps);
}

export async function cmdTaskPark(
  db: Db,
  rawId: string,
  opts: { why: string; evidence?: string; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sdkOpts: Parameters<typeof parkTask>[2] = {
    workstream: ws,
    why: opts.why,
    author: await resolveActorIdentity(),
  };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = parkTask(db, localId, sdkOpts);
  const nextSteps: NextStep[] = [
    { intent: "Unpark it later", command: `mu task unpark ${localId} -w ${ws}` },
    { intent: "List parked tasks", command: `mu task list --substate parked -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN/parked (no-op)`));
  } else {
    console.log(`Parked ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  }
  printNextSteps(nextSteps);
}

export async function cmdTaskUnpark(
  db: Db,
  rawId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sdkOpts: Parameters<typeof unparkTask>[2] = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = unparkTask(db, localId, sdkOpts);
  const nextSteps: NextStep[] = [
    {
      intent: "Claim it",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Pick the next ready task", command: `mu task next -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    const pair = formatPair({ status: r.status, substate: r.substate });
    console.log(pc.dim(`${localId} is ${pair}, not parked (no-op)`));
  } else {
    console.log(`Unparked ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  }
  printNextSteps(nextSteps);
}
