// mu — `mu agent close <name>`: preview and apply (src/agents/close.ts), for a
// live agent, a local orphan worktree and a REMOVED agent's remote worktree
// (`remote_recovery`, src/agents/close-recovery.ts). Kept out of
// src/cli/agents.ts, which is past its cap.
//
// Scope: a recovery outlives its agent row, its workstream and (after a
// reinit) the workstream's generation, so the live-agent scope checks do not
// apply to it: `-w`, or a qualified `<ws>/<name>`, names the workstream the
// record was kept under, and `--recovery <id>` picks one of several.

import type { Command } from "commander";
import { closePreviewToOutput } from "../agent-output.js";
import { type ClosePreview, closeAgent, previewClose } from "../agents.js";
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
}

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
    ...new Set([...findEntityWorkstreams(db, "agent", name), ...recoveryWorkstreams(db, name)]),
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
  if (opts.recovery === undefined && recoveriesFor(db, ws, name).length === 0) {
    assertAgentInWorkstream(db, name, opts.workstream ?? ws);
  }
  const discard = opts.discard === true;
  const keepBranch = opts.keepBranch === true;
  const recoveryId = opts.recovery;
  // Bare close is the preview: it reads, it never kills. `--if <rev>` applies.
  if (opts.if === undefined) {
    const p = await previewClose(db, name, {
      workstream: ws,
      discard,
      keepBranch,
      ...(recoveryId === undefined ? {} : { recoveryId }),
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
    ...(recoveryId === undefined ? {} : { recoveryId }),
  });
  if (opts.json) {
    emitJson({ agentName: name, ...result });
    return;
  }
  if (!result.killedPane && !result.deletedRow && result.worktree === null) {
    console.log(pc.dim(`no agent named ${name} (already closed?)`));
    return;
  }
  console.log(
    result.recovery === undefined
      ? `Closed ${pc.bold(name)}`
      : `Closed the remote worktree ${pc.bold(name)} left (recovery ${result.recovery.id})`,
  );
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
  }
}

function printClosePreview(p: ClosePreview): void {
  if (p.kind === "none") {
    console.log(pc.dim(`no agent named ${p.agentName} (already closed?)`));
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
    if (p.recovery.refusal !== null)
      console.log(pc.yellow(`  would refuse: ${p.recovery.refusal}`));
    return;
  }
  console.log(
    p.kind === "agent"
      ? `Close ${pc.bold(p.agentName)}? pane ${p.paneId} will be killed and its row removed (rev ${p.revision})`
      : `${pc.bold(p.agentName)} has no agent row, only a registered worktree (rev ${p.revision})`,
  );
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
    .option("--if <rev>", "apply the preview with this revision", parseNonNegativeInt)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as CloseOpts;
      return handle((db) => cmdClose(db, name, opts), this as Command)();
    });
}
