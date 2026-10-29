// mu — `mu agent close <name>`: preview and apply (src/agents/close.ts), for a
// live agent, a local orphan worktree and a REMOVED agent's remote worktree
// (`remote_recovery`, src/agents/close-recovery.ts). Kept out of
// src/cli/agents.ts, which is past its cap.
//
// Scope: a recovery outlives its agent row, its workstream and (after a
// reinit) the workstream's generation, so the live-agent scope checks do not
// apply to it: `-w`, or a qualified `<ws>/<name>`, names the workstream the
// record was kept under, and `--recovery <id>` picks one of several. A lease
// job's `carrier_jobs` reservation outlives its agent row the same way.

import type { Command } from "commander";
import { closePreviewToOutput } from "../agent-output.js";
import { type ClosePreview, closeAgent, previewClose } from "../agents.js";
import { listCarrierJobs } from "../carrier-jobs.js";
import {
  applyQualifiedRef,
  assertAgentInWorkstream,
  emitJson,
  findEntityWorkstreams,
  handle,
  injectedWorkstream,
  JSON_OPT,
  missingWorkstreamError,
  parseNonNegativeInt,
  resolveWorkstream,
  WORKSTREAM_OPT,
} from "../cli.js";
import type { Db } from "../db.js";
import { pc } from "../output.js";
import { recoveriesFor, recoveryWorkstreams } from "../remote-recovery.js";
import { NameAmbiguousError, setNextOutcome } from "./handle.js";

interface CloseOpts {
  workstream?: string;
  json?: boolean;
  discard?: boolean;
  keepBranch?: boolean;
  if?: number;
  recovery?: number;
  force?: boolean;
  abandonJob?: boolean;
}

/** The workstream names holding a lease reservation of `name` (the workstream may be gone). */
function carrierJobWorkstreams(db: Db, name: string): string[] {
  return listCarrierJobs(db)
    .filter((j) => j.name === name)
    .map((j) => j.workstream);
}

const hasCarrierJob = (db: Db, ws: string, name: string): boolean =>
  carrierJobWorkstreams(db, name).includes(ws);

/**
 * The workstream a close means. Explicit or injected scope as everywhere; with
 * none, the workstreams holding a live agent OR a recovery record of the
 * name: several are ambiguous, one is offered as the qualified ref.
 */
export async function closeScope(
  db: Db,
  name: string,
  explicit: string | undefined,
): Promise<string> {
  if (explicit !== undefined || injectedWorkstream() !== undefined) {
    return resolveWorkstream(explicit);
  }
  const matches = [
    ...new Set([
      ...findEntityWorkstreams(db, "agent", name),
      ...recoveryWorkstreams(db, name),
      ...carrierJobWorkstreams(db, name),
    ]),
  ].sort();
  if (matches.length >= 2) throw new NameAmbiguousError(name, matches, "agent");
  const only = matches[0];
  throw await missingWorkstreamError(only !== undefined ? { extra: `${only}/${name}?` } : {});
}

export async function cmdClose(db: Db, rawName: string, opts: CloseOpts = {}): Promise<void> {
  const name = applyQualifiedRef(rawName, opts);
  const ws = await closeScope(db, name, opts.workstream);
  // A record kept under `ws` is a legitimate target even when a live agent of
  // that name sits in another workstream; the live-agent check is for rows.
  if (
    opts.recovery === undefined &&
    recoveriesFor(db, ws, name).length === 0 &&
    !hasCarrierJob(db, ws, name)
  ) {
    assertAgentInWorkstream(db, name, opts.workstream ?? ws);
  }
  const discard = opts.discard === true;
  const keepBranch = opts.keepBranch === true;
  const recoveryId = opts.recovery;
  const force = opts.force === true;
  const abandonJob = opts.abandonJob === true;
  // Bare close is the preview: it reads, it never kills. `--if <rev>` applies.
  if (opts.if === undefined) {
    const p = await previewClose(db, name, {
      workstream: ws,
      discard,
      keepBranch,
      ...(recoveryId === undefined ? {} : { recoveryId }),
      ...(abandonJob ? { abandonJob: true } : {}),
    });
    if (p.kind !== "none" && !p.refusesDirty && p.recovery?.refusal == null) {
      setNextOutcome({
        kind: "preview",
        apply: [
          "mu",
          "agent",
          "close",
          name,
          "-w",
          ws,
          ...(p.recovery === null ? [] : ["--recovery", String(p.recovery.id)]),
          ...(discard ? ["--discard"] : []),
          ...(keepBranch ? ["--keep-branch"] : []),
          ...(force ? ["--force"] : []),
          ...(abandonJob ? ["--abandon-job"] : []),
        ],
        revision: p.revision,
      });
    }
    if (opts.json) {
      emitJson({ ...closePreviewToOutput(p), dryRun: true });
      return;
    }
    printClosePreview(p);
    return;
  }
  const result = await closeAgent(db, name, {
    workstream: ws,
    ifRevision: opts.if,
    ...(discard ? { discard: true } : {}),
    ...(keepBranch ? { keepBranch: true } : {}),
    ...(force ? { force: true } : {}),
    ...(abandonJob ? { abandonJob: true } : {}),
    ...(recoveryId === undefined ? {} : { recoveryId }),
  });
  if (opts.json) {
    emitJson({ agentName: name, ...result });
    return;
  }
  const jobs = result.carrierJobs ?? [];
  if (!result.killedPane && !result.deletedRow && result.worktree === null && jobs.length === 0) {
    console.log(pc.dim(`no agent named ${name} (already closed?)`));
    return;
  }
  console.log(
    result.recovery !== undefined
      ? `Closed the remote worktree ${pc.bold(name)} left (recovery ${result.recovery.id})`
      : !result.killedPane && result.worktree === null
        ? `Closed the lease job ${pc.bold(name)} left`
        : `Closed ${pc.bold(name)}`,
  );
  for (const j of jobs) {
    const what = j.job === null ? "lease reservation" : `job ${j.job}`;
    console.log(
      pc.dim(
        j.action === "stopped"
          ? `  ${what} on ${j.host} stopped`
          : j.action === "abandon"
            ? `  ${what} on ${j.host} abandoned without a stop: it may still run there`
            : `  ${what} on ${j.host} released (its carrier was never launched)`,
      ),
    );
  }
  if (result.worktree !== null) {
    const w = result.worktree;
    console.log(
      pc.dim(
        w.action === "kept-branch"
          ? `  worktree removed; unmerged commits kept on branch ${w.branch}`
          : w.action === "discarded"
            ? "  worktree discarded"
            : w.action === "gone"
              ? "  worktree already gone"
              : "  worktree removed",
      ),
    );
    for (const warn of w.warnings ?? []) console.error(pc.yellow(`warning: ${warn}`));
  }
}

/** The preview line of the name's lease job: stopped first, or with --abandon-job dropped. */
function printCarrierJob(p: ClosePreview): void {
  const j = p.carrierJob;
  if (j === null) return;
  const what =
    j.job !== null
      ? `job ${j.job}`
      : `a lease reservation with no job handle (launch ${j.launch}, pane ${j.paneId ?? "none"}${j.reason === null ? "" : `, ${j.reason}`})`;
  console.log(
    p.abandonJob
      ? pc.yellow(
          `  ${what} on ${j.host}: --abandon-job drops it WITHOUT a stop (the job may keep running; the job file is left)`,
        )
      : j.job !== null
        ? `  ${what} on ${j.host}: stopped (its stop template) before anything else; a failed stop keeps everything`
        : `  ${what} on ${j.host}: released only if its carrier was never launched; otherwise the close refuses (then --abandon-job)`,
  );
}

function printClosePreview(p: ClosePreview): void {
  if (p.kind === "none") {
    console.log(pc.dim(`no agent named ${p.agentName} (already closed?)`));
    return;
  }
  if (p.kind === "lease-job") {
    console.log(
      `${pc.bold(p.agentName)} has no agent row, only a lease job reservation (rev ${p.revision}): no pane is killed, no task changes`,
    );
    printCarrierJob(p);
    return;
  }
  if (p.kind === "recovery" && p.recovery !== null && p.remote !== null) {
    const head = p.remote.collectedHead;
    console.log(
      `${pc.bold(p.agentName)} has no agent row, only the remote worktree it left (recovery ${p.recovery.id}, kept on ${p.recovery.preservedAt}, rev ${p.revision}): no pane is killed, no task changes`,
    );
    console.log(
      `  remote worktree ${p.remote.path} on ${p.remote.host}: removed only if clean and at ${p.remote.base.slice(0, 12)}${head === null ? "" : ` or ${head.slice(0, 12)} (collected)`}; otherwise it refuses${p.keepBranch ? " (--keep-branch: unmerged commits go on a remote branch first; dirty still refuses)" : ""}`,
    );
    printCarrierJob(p);
    if (p.recovery.refusal !== null)
      console.log(pc.yellow(`  would refuse: ${p.recovery.refusal}`));
    return;
  }
  console.log(
    p.kind === "agent"
      ? `Close ${pc.bold(p.agentName)}? pane ${p.paneId} will be killed and its row removed (rev ${p.revision})`
      : `${pc.bold(p.agentName)} has no agent row, only a registered worktree (rev ${p.revision})`,
  );
  printCarrierJob(p);
  for (const t of p.ownedTasks) {
    console.log(`  owns ${t.ref} (${t.status}${t.reverts ? ": goes back to OPEN" : ""})`);
  }
  if (p.remote !== null) {
    const head = p.remote.collectedHead;
    console.log(
      `  remote worktree ${p.remote.path} on ${p.remote.host}: removed after the pane dies, only if clean and at ${p.remote.base.slice(0, 12)}${head === null ? "" : ` or ${head.slice(0, 12)} (collected)`}; otherwise it refuses${p.keepBranch ? " (--keep-branch: unmerged commits go on a remote branch first; dirty still refuses)" : ""}`,
    );
  }
  if (p.worktree !== null) {
    console.log(`  worktree ${p.worktree.path}: ${p.worktree.state}`);
    if (p.refusesDirty) {
      console.log(
        pc.yellow("  uncommitted work: close refuses. Commit it, or preview with --discard"),
      );
    }
  }
}

export function wireCloseCommand(agent: Command): void {
  agent
    .command("close <name>")
    .alias("stop")
    .description(
      "Close an agent: previews without --if; --if <rev> kills the pane, removes the row and its clean worktree (unmerged commits keep a branch; a dirty tree refuses first). Remote and recovery-record rules: docs/guide/remote.md.",
    )
    .option(
      "--discard",
      "close even with uncommitted work in the worktree (lossy: it is thrown away)",
    )
    .option(
      "--keep-branch",
      "a remote worktree whose HEAD was never collected: keep it as the remote branch mu/<ws>/<agent>-<sha12>, then remove it (dirty still refuses, with or without --discard)",
    )
    .option(
      "--recovery <id>",
      "close the remote worktree of the removed agent whose recovery id this is (shown by the preview; needed when several records share the name)",
      parseNonNegativeInt,
    )
    .option(
      "--force",
      "close past what you vouch for: a pane mu cannot ask, or a worktree a process writes in or no scan can check (a cwd or reader there only warns); never overrides a live pane or uncommitted work",
    )
    .option(
      "--abandon-job",
      "a lease job whose host is gone for good: drop its handle WITHOUT stopping it (logged with host and handle; the job may keep running). --force never skips the stop",
    )
    .option("--if <rev>", "apply the preview with this revision", parseNonNegativeInt)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as CloseOpts;
      return handle((db) => cmdClose(db, name, opts), this as Command)();
    });
}
