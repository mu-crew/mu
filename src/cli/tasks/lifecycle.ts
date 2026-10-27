// mu — `mu task` lifecycle verbs (status transitions).
//
// close / open / park / accept / unpark. Each delegates to the SDK; changes are captured as ops
// and optionally reported as evidence notes.
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.

import {
  assertTaskInWorkstream,
  emitJson,
  resolveEntityRef,
  resolveExistingWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { say } from "../../messages.js";
import { pc } from "../../output.js";
import { formatPair, type TaskPair } from "../../tasks/status.js";
import {
  acceptTask,
  type CloseSubstate,
  closeTask,
  getTask,
  getTaskEdgesWithStatus,
  openTask,
  parkTask,
  resolveActorIdentity,
  unparkTask,
  weakDecisionWarning,
} from "../../tasks.js";
import { dirtyFiles } from "../../vcs/git.js";
import { getWorktreeFor } from "../../worktree.js";
import { UsageError } from "../handle.js";

export async function cmdTaskClose(
  db: Db,
  rawId: string,
  rawOpts: {
    evidence?: string;
    note?: string;
    report?: string;
    ifReady?: boolean;
    as?: string;
    why?: string;
    workstream?: string;
    json?: boolean;
  } = {},
): Promise<void> {
  // `--note` is the guessed spelling of `--evidence`: one source only.
  if (rawOpts.note !== undefined && rawOpts.evidence !== undefined) {
    throw new UsageError(say("task.close_note_alias"), { showHelp: false });
  }
  const opts = { ...rawOpts, evidence: rawOpts.evidence ?? rawOpts.note };
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const actor = await resolveActorIdentity();
  const sdkOpts: Parameters<typeof closeTask>[2] = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.report !== undefined && opts.report.trim() !== "") {
    sdkOpts.report = opts.report;
    sdkOpts.author = actor;
  }
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
  // 'orchestrator') and so the dirty-worktree warning can inspect that
  // actor's worktree without resolving identity a second time.
  if (opts.evidence !== undefined && opts.evidence !== "") {
    sdkOpts.author = actor;
  }
  // Capture the owner BEFORE closeTask so we can refresh their title
  // even though closeTask doesn't return owner info. owner won't
  // change as a result of close (FK SET NULL only fires on delete).
  const taskRow = getTask(db, localId, ws);
  // A close to done needs --evidence. Refuse before any write, with one
  // line naming the flag. A no-op retry of an already-CLOSED task needs
  // none; with --if-ready the SDK decides (a skip writes nothing).
  const closeAs = sdkOpts.as ?? (taskRow?.status === "CLOSED" ? taskRow.substate : "done");
  const retry = taskRow?.status === "CLOSED" && taskRow.substate === closeAs;
  // The --if-ready skip (a blocker not CLOSED) is the one case left to the SDK.
  const wouldSkip =
    opts.ifReady === true &&
    taskRow !== undefined &&
    getTaskEdgesWithStatus(db, localId, ws).blockers.some((e) => e.status !== "CLOSED");
  if (
    taskRow &&
    !retry &&
    !wouldSkip &&
    closeAs === "done" &&
    (opts.evidence ?? "").trim() === ""
  ) {
    // One line, command included: no --help after it.
    throw new UsageError(say("task.close_done_evidence", localId, ws), { showHelp: false });
  }
  // Read before the close: the warning is about the finding as it was.
  const warnings = decisionWarnings(db, localId, ws, sdkOpts.as ?? "done", opts.why);
  const r = closeTask(db, localId, sdkOpts);
  // --if-ready can return a CloseSkippedResult (no mutation). Branch
  // first so the typed `skipped` field stays in scope below.
  if ("skipped" in r) {
    if (opts.json) {
      emitJson({ taskName: localId, ...r });
      return;
    }
    const total = r.blockingIds.length;
    const shown = r.blockingIds.slice(0, 8).join(", ");
    const tail = total > 8 ? ", \u2026" : "";
    console.log(
      pc.dim(
        `Skipped ${pc.bold(localId)}: blocked by ${total} task(s) (${shown}${tail}); close again once they are CLOSED`,
      ),
    );
    return;
  }
  if (r.changed && r.status === "CLOSED") {
    const commit = await dirtyWorktreeWarning(db, actor, ws, taskRow?.title ?? localId);
    if (commit !== undefined) warnings.push(commit);
  }
  if (opts.json) {
    emitJson({ taskName: localId, ...r, warnings });
    return;
  }
  printDecisionWarnings(warnings);
  if (!r.changed) {
    console.log(pc.dim(`${localId} already CLOSED (no-op)`));
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Closed ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  if (ev) console.log(ev);
  if (r.unblocked.length > 0) console.log(`Unblocked: ${r.unblocked.join(", ")}`);
}

/** The weak-decision warning for this accept / close, as a 0-or-1 list
 *  (the `warnings` array in --json). Never blocks the verb. */
function decisionWarnings(
  db: Db,
  localId: string,
  ws: string,
  kind: Parameters<typeof weakDecisionWarning>[3],
  reason: string | undefined,
): string[] {
  const w = weakDecisionWarning(db, localId, ws, kind, reason);
  return w === undefined ? [] : [w];
}

function printDecisionWarnings(warnings: readonly string[]): void {
  for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
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

/** The commit command for a dirty worktree. Picks up untracked files
 *  (`git commit -am` alone would refuse with "nothing added"), and names
 *  the path so it works from any cwd. Exported for the fast-tier test. */
export function commitHintCommand(worktree: string, taskTitle: string): string {
  const dir = shellSingleQuote(worktree);
  return `git -C ${dir} add -A && git -C ${dir} commit -m ${shellSingleQuote(taskTitle)}`;
}

/** The closer's worktree has uncommitted changes: a warning naming the commit. */
async function dirtyWorktreeWarning(
  db: Db,
  actor: string,
  workstream: string,
  taskTitle: string,
): Promise<string | undefined> {
  if (actor.length === 0) return undefined;
  try {
    const row = getWorktreeFor(db, workstream, actor);
    if (row === undefined) return undefined;
    if ((await dirtyFiles(row.path)).length === 0) return undefined;
    return say("task.close_uncommitted", row.path, commitHintCommand(row.path, taskTitle));
  } catch {
    // Best-effort: a VCS probe failure must never make
    // `mu task close` fail after the task successfully closed.
    return undefined;
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
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const sdkOpts: Parameters<typeof openTask>[2] = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.evidence) sdkOpts.author = await resolveActorIdentity();
  const r = openTask(db, localId, sdkOpts);
  if (opts.json) {
    emitJson({ taskName: localId, ...r });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN (no-op)`));
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Reopened ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  if (ev) console.log(ev);
}

export async function cmdTaskPark(
  db: Db,
  rawId: string,
  opts: { why: string; evidence?: string; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const sdkOpts: Parameters<typeof parkTask>[2] = {
    workstream: ws,
    why: opts.why,
    author: await resolveActorIdentity(),
  };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = parkTask(db, localId, sdkOpts);
  if (opts.json) {
    emitJson({ taskName: localId, ...r });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN/parked (no-op)`));
  } else {
    console.log(`Parked ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  }
}

export async function cmdTaskAccept(
  db: Db,
  rawId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const sdkOpts: Parameters<typeof acceptTask>[2] = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.evidence) sdkOpts.author = await resolveActorIdentity();
  const warnings = decisionWarnings(db, localId, ws, "accept", opts.evidence);
  const r = acceptTask(db, localId, sdkOpts);
  if (opts.json) {
    emitJson({ taskName: localId, ...r, warnings });
    return;
  }
  printDecisionWarnings(warnings);
  if (!r.changed) {
    const pair = formatPair({ status: r.status, substate: r.substate });
    console.log(pc.dim(`${localId} is ${pair}, not in triage (no-op)`));
  } else {
    console.log(`Accepted ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  }
}

export async function cmdTaskUnpark(
  db: Db,
  rawId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const sdkOpts: Parameters<typeof unparkTask>[2] = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.evidence) sdkOpts.author = await resolveActorIdentity();
  const r = unparkTask(db, localId, sdkOpts);
  if (opts.json) {
    emitJson({ taskName: localId, ...r });
    return;
  }
  if (!r.changed) {
    const pair = formatPair({ status: r.status, substate: r.substate });
    console.log(pc.dim(`${localId} is ${pair}, not parked (no-op)`));
  } else {
    console.log(`Unparked ${pc.bold(localId)} ${pc.dim(`(${transition(r)})`)}`);
  }
}
