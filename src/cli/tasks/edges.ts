// mu — `mu task` graph-edge verbs (block / unblock / reparent / delete).
//
// All four mutate task_edges (block/unblock/reparent) or cascade through
// it via FK (delete). Each is idempotent and emits typed errors that
// `handle()` in src/cli.ts maps to exit codes.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import {
  assertTaskInWorkstream,
  emitJson,
  parseCsvFlag,
  resolveEntityRef,
  resolveWorkstream,
  UsageError,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { say } from "../../messages.js";
import { pc } from "../../output.js";
import { withTaskFence } from "../../revision.js";
import { candidateTaskIds } from "../../tasks/id.js";
import { addBlockEdge, deleteTask, getTask, removeBlockEdge, reparentTask } from "../../tasks.js";
import { setNextOutcome } from "../handle.js";

/** Canonicalise the `-b/--by` value into a non-empty blocker list.
 *
 *  dogfood-block-multi: `--by` used to be single-valued while
 *  `mu task add --blocked-by` was variadic + comma-aware, so the
 *  natural `mu task block X --by a,b,c` failed with
 *  "no such task: a,b,c". Both flags now funnel through the SAME
 *  canonical helper (parseCsvFlag), so repeat / comma / mixed forms
 *  all work and the two verbs can no longer drift apart.
 *
 *  Commander hands us `string` for the legacy `<blocker>` shape and
 *  `string[]` for the variadic one; accept both so a programmatic
 *  caller passing the old single-string shape keeps working. */
export function parseByFlag(by: string | readonly string[]): string[] {
  const blockers = parseCsvFlag(typeof by === "string" ? [by] : by, "-b/--by");
  if (blockers.length === 0) {
    throw new UsageError(say("task.by_required"));
  }
  // De-dupe so `--by a,a` is a single edge attempt rather than an
  // added-then-no-op pair that would read as a confusing partial.
  return [...new Set(blockers)];
}

export async function cmdTaskBlock(
  db: Db,
  rawBlocked: string,
  opts: { by: string | readonly string[]; workstream?: string; json?: boolean; if?: number },
): Promise<void> {
  const { name: blocked } = await resolveEntityRef(db, rawBlocked, opts, "task");
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const blockers = parseByFlag(opts.by);
  // Sequential, fail-fast: the first bad blocker throws its typed
  // error (not-found / cycle / cross-workstream) and earlier edges
  // stay added. Same semantics as running the single-blocker form N
  // times, which is what this replaces. With --if the whole batch sits
  // behind ONE revision check in one transaction (a batch cannot
  // invalidate its own fence), so a failure rolls every edge back.
  const results = withTaskFence(db, ws, blocked, opts.if, () =>
    blockers.map((blocker) => ({
      blockerName: blocker,
      ...addBlockEdge(db, ws, blocked, blocker),
    })),
  );
  const added = results.filter((r) => r.added).length;
  if (opts.json) {
    const first = results[0];
    emitJson({
      blockedName: blocked,
      // Single-blocker callers keep the pre-existing scalar shape.
      blockerName: first !== undefined && results.length === 1 ? first.blockerName : undefined,
      blockerNames: blockers,
      results,
      added: added > 0,
      addedEdges: added,
    });
    return;
  }
  for (const r of results) {
    if (!r.added) {
      console.log(pc.dim(`${r.blockerName} → ${blocked}: edge already exists (no-op)`));
      continue;
    }
    console.log(`Added edge ${pc.bold(r.blockerName)} → ${pc.bold(blocked)}`);
  }
}

export async function cmdTaskUnblock(
  db: Db,
  rawBlocked: string,
  opts: { by: string | readonly string[]; workstream?: string; json?: boolean; if?: number },
): Promise<void> {
  const { name: blocked } = await resolveEntityRef(db, rawBlocked, opts, "task");
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // Symmetric with `block`: same --by parsing on both halves of the
  // same edge operation, so a multi-blocker block is a single
  // invocation too.
  const blockers = parseByFlag(opts.by);
  const results = withTaskFence(db, ws, blocked, opts.if, () =>
    blockers.map((blocker) => ({
      blockerName: blocker,
      ...removeBlockEdge(db, ws, blocked, blocker),
    })),
  );
  const removed = results.filter((r) => r.removed).length;
  // The no-op for an unknown id stays a no-op; it only says which ids of
  // THIS workstream the typo may have meant (read-only).
  const candidates = [
    ...new Set(
      [blocked, ...blockers]
        .filter((id) => getTask(db, id, ws) === undefined)
        .flatMap((id) => candidateTaskIds(db, ws, id)),
    ),
  ];
  if (opts.json) {
    const first = results[0];
    emitJson({
      blockedName: blocked,
      blockerName: first !== undefined && results.length === 1 ? first.blockerName : undefined,
      blockerNames: blockers,
      results,
      removed: removed > 0,
      removedEdges: removed,
      ...(candidates.length > 0 ? { candidate_ids: candidates } : {}),
    });
    return;
  }
  for (const r of results) {
    if (!r.removed) {
      console.log(pc.dim(`${r.blockerName} → ${blocked}: no such edge (no-op)`));
      continue;
    }
    console.log(`Removed edge ${pc.bold(r.blockerName)} → ${pc.bold(blocked)}`);
  }
  if (candidates.length > 0) console.log(pc.dim(`  similar: ${candidates.join(", ")}`));
}

export async function cmdTaskReparent(
  db: Db,
  rawId: string,
  opts: { blockedBy: string[]; workstream?: string; json?: boolean; if?: number },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // An all-EMPTY --blocked-by '' is the documented clear-all-blockers
  // sentinel here (unlike --by, where zero blockers is meaningless),
  // so [] stays legal. A BLANK ' ' still throws from parseCsvFlag.
  const blockers = parseCsvFlag(opts.blockedBy, "-b/--blocked-by");
  const r = withTaskFence(db, ws, localId, opts.if, () =>
    reparentTask(db, localId, blockers, { workstream: ws }),
  );
  if (opts.json) {
    emitJson({ taskName: localId, blockerNames: blockers, ...r });
    return;
  }
  console.log(
    `Reparented ${pc.bold(localId)} ${pc.dim(`(removed ${r.removedEdges} edges, added ${r.addedEdges})`)}`,
  );
}

export async function cmdTaskDelete(
  db: Db,
  rawId: string,
  opts: { workstream?: string; json?: boolean; yes?: boolean; if?: number } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // Two-phase: bare = dry-run preview; --yes commits. Mirrors
  // `mu workstream teardown`. Surfaced by feedback
  // ws task fb_task_delete_no_yes
  // (impact=30): the dogfood report typed `mu task delete X --yes`
  // (mirroring workstream teardown) and got 'unknown option --yes'
  // because the verb took no confirmation flag at all; two failed
  // deletes left long-named tasks lingering until noticed.
  // --if <rev> (the preview's revision) applies the delete and refuses a
  // task that changed since; --yes still applies unfenced.
  const dryRun = opts.yes !== true && opts.if === undefined;
  const r = deleteTask(db, localId, ws, {
    dryRun,
    ...(opts.if !== undefined ? { ifRevision: opts.if } : {}),
  });
  if (r.present && r.dryRun && r.revision !== undefined) {
    setNextOutcome({
      kind: "preview",
      apply: ["mu", "task", "delete", localId, "-w", ws],
      revision: r.revision,
    });
  }

  // Missing row — idempotent no-op (same outcome whether dry-run or
  // --yes). The `present: false` discriminator keeps this distinct
  // from a dry-run that found an existing task with no edges/notes.
  if (!r.present) {
    // Read-only near ids of THIS workstream; nothing resolves through them.
    const candidates = candidateTaskIds(db, ws, localId);
    if (opts.json) {
      emitJson({
        taskName: localId,
        ...r,
        ...(candidates.length > 0 ? { candidate_ids: candidates } : {}),
      });
      return;
    }
    console.log(pc.dim(`no task named ${localId} (already deleted?)`));
    if (candidates.length > 0) console.log(pc.dim(`  similar: ${candidates.join(", ")}`));
    return;
  }

  // Dry-run: print the cascade preview. The task DOES exist (present
  // checked above); zero edges + zero notes is a real cascade-of-one.
  if (r.dryRun) {
    if (opts.json) {
      emitJson({ taskName: localId, ...r });
      return;
    }
    console.log(
      r.deletedEdges === 0 && r.deletedNotes === 0
        ? `Would delete ${pc.bold(localId)} ${pc.dim("(no edges, no notes)")}`
        : `Would delete ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
    );
    console.log("");
    console.log(pc.dim(`(dry-run; rerun with --if ${r.revision} (or --yes) to actually delete)`));
    return;
  }

  // Commit path.
  if (opts.json) {
    emitJson({ taskName: localId, ...r });
    return;
  }
  console.log(
    `Deleted ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
  );
}
