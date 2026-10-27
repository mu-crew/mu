// mu — `mu task` ownership + synchronisation verbs (claim / release / wait).
//
// claim   → CAS-style ownership transfer; dispatch via --for or
//           anonymous --self (owner stays NULL, actor in agent_logs).
// release → clears owner; auto-flips IN_PROGRESS → OPEN; --reopen
//           forces OPEN from CLOSED.
// wait    → polls until the listed tasks reach --status (default
//           CLOSED). Exit 0 = met; exit 5 = timeout.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { AgentNotFoundError } from "../../agents/errors.js";
import { getAgent } from "../../agents.js";
import {
  assertTaskInWorkstream,
  checkQualifiedPrefix,
  checkWorkstreamName,
  emitJson,
  parseQualifiedRef,
  resolveEntityRef,
  resolveWorkstream,
  UsageError,
} from "../../cli.js";
import { type Db, tryResolveLiveWorkstreamId, WorkstreamNotFoundError } from "../../db.js";
import { say } from "../../messages.js";
import { activeMux } from "../../mux/detect.js";
import { pc } from "../../output.js";
import { getTaskOwner } from "../../tasks/queries.js";
import { claimTask, releaseTask, resolveActorIdentity } from "../../tasks.js";
import type { WaitRef } from "../../wait.js";
import { currentCallers } from "../../wait-callers.js";
import { setNextOutcome } from "../handle.js";
import {
  parseOnStall,
  parseWaitRef,
  runWait,
  type WaitSignals,
  type WaitSpec,
  waitMode,
} from "../wait.js";
import { agentRef, armWait, taskRef } from "../wait-arm.js";

export async function cmdTaskRelease(
  db: Db,
  rawId: string,
  opts: {
    reopen?: boolean;
    evidence?: string;
    workstream?: string;
    json?: boolean;
    if?: number;
  },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sdkOpts: Parameters<typeof releaseTask>[2] = {
    reopen: opts.reopen ?? false,
    workstream: ws,
  };
  if (opts.if !== undefined) sdkOpts.ifRevision = opts.if;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.evidence) sdkOpts.author = await resolveActorIdentity();
  const r = releaseTask(db, localId, sdkOpts);
  if (opts.json) {
    emitJson({ taskName: localId, ...r });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already unowned (no-op)`));
    return;
  }
  const ownerBit = r.previousOwnerName ? `was ${pc.bold(r.previousOwnerName)}` : "was unowned";
  const statusBit = r.previousStatus !== r.status ? ` (${r.previousStatus} → ${r.status})` : "";
  console.log(`Released ${pc.bold(localId)} ${pc.dim(`(${ownerBit})${statusBit}`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
}

/** Whether the active mux can type into a non-pi pane (herdr yes, tmux no). No mux: true. */
async function muxCanSendToPanes(): Promise<boolean> {
  try {
    return (await activeMux()).sendToPane !== undefined;
  } catch {
    return true;
  }
}

export async function cmdClaim(
  db: Db,
  rawId: string,
  opts: {
    for?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
    workstream?: string;
    json?: boolean;
    force?: boolean;
    if?: number;
    /** After a `--for` dispatch, wait for the task (one JSON result; `data.claimed` is the claim). */
    andWait?: boolean;
  },
  sig?: WaitSignals,
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  if (opts.andWait === true && opts.for === undefined) {
    throw new UsageError(say("task.claim_and_wait"));
  }
  if (opts.self === true && opts.for !== undefined) {
    throw new UsageError(say("task.claim_self_and_for"));
  }
  if (opts.actor !== undefined && opts.self !== true) {
    throw new UsageError(say("task.claim_actor"));
  }
  // Parse `--for` for an optional qualified ref: bare `<name>`
  // resolves the agent in the task's workstream (today); qualified
  // `<workstream>/<name>` resolves the agent in its own workstream
  // and dispatches across the workstream boundary
  // (task_claim_for_cross_workstream).
  let forName: string | undefined;
  let forWorkstream: string | undefined;
  if (opts.for !== undefined) {
    const parsed = parseQualifiedRef(opts.for);
    forName = parsed.name;
    if (parsed.workstream !== undefined) {
      forWorkstream = checkQualifiedPrefix(opts.for, parsed.workstream);
      // Pre-flight: workstream must exist (typed error so the operator
      // sees the canonical exit-3 mapping instead of a bare
      // ClaimerNotRegisteredError pointing at the wrong cause).
      if (tryResolveLiveWorkstreamId(db, forWorkstream) === null) {
        throw new WorkstreamNotFoundError(forWorkstream);
      }
      // Pre-flight: agent must exist in that workstream. Without this
      // the SDK surfaces ClaimerNotRegisteredError (the bare-name
      // shape) which doesn't carry the qualifying workstream context
      // — AgentNotFoundError(name, workstream) is the right shape for
      // the cross-ws path.
      const wsId = tryResolveLiveWorkstreamId(db, forWorkstream);
      if (wsId !== null) {
        const row = db
          .prepare("SELECT 1 FROM agents WHERE name = ? AND workstream_id = ?")
          .get(forName, wsId);
        if (!row) throw new AgentNotFoundError(forName, forWorkstream);
      }
    }
  }
  const sdkOpts: Parameters<typeof claimTask>[2] = { workstream: ws };
  if (forName !== undefined) sdkOpts.agentName = forName;
  if (opts.force) sdkOpts.force = true;
  if (opts.if !== undefined) sdkOpts.ifRevision = opts.if;
  if (forWorkstream !== undefined) sdkOpts.agentWorkstream = forWorkstream;
  if (opts.self) sdkOpts.self = true;
  if (opts.actor !== undefined) sdkOpts.actor = opts.actor;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  // `--for` dispatch: the CLAIM note is the dispatcher's, not the
  // worker's (the SDK defaults it to the claimer).
  if (opts.evidence && forName !== undefined) sdkOpts.author = await resolveActorIdentity();
  const result = await claimTask(db, localId, sdkOpts);
  // A `--for` dispatch owes a wait: the task, in ITS workstream, and the agent that now owns
  // it (read from the task's owner_id, not from the label or the task's namespace). --self
  // (owner NULL) and a worker's own claim arm nothing: the caller would wait on its own work.
  const warnings: string[] = [];
  if (opts.for !== undefined && result.ownerName !== null) {
    const o = getTaskOwner(db, localId, ws);
    const ownerRow = o === undefined ? undefined : getAgent(db, o.name, o.workstreamName);
    const armed = armWait(db, [
      taskRef(ws, localId),
      ...(ownerRow !== undefined && `${o?.workstreamName}/${o?.name}` !== currentCallers()[0]
        ? [agentRef(ownerRow)]
        : []),
    ]);
    if (armed.warning !== undefined) warnings.push(armed.warning);
  }
  if (opts.andWait === true && sig !== undefined) {
    return runWait(
      db,
      {
        refs: [taskRef(ws, localId) as WaitRef],
        mode: "all",
        onStall: "exit",
        verb: "mu task claim --and-wait",
        scope: ws,
      },
      sig,
      {
        extraData: {
          claimed: {
            task: localId,
            workstream: ws,
            ownerName: result.ownerName,
            previousStatus: result.previousStatus,
            status: result.status,
          },
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      },
    );
  }
  if (!opts.json) for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
  // claim-before-send: a --for claim is the moment of dispatch; the owner is sent the task next.
  if (result.ownerName !== null && opts.for !== undefined) {
    setNextOutcome({
      kind: "claimed-for",
      task: { workstream: ws, id: localId },
      owner: { name: result.ownerName, workstream: forWorkstream ?? ws },
      muxCanSend: await muxCanSendToPanes(),
    });
  }
  if (opts.json) {
    emitJson({ ...result, ...(warnings.length > 0 ? { warnings } : {}) });
    return;
  }
  if (result.ownerName === null) {
    console.log(
      `Claimed ${pc.bold(localId)} ${pc.dim(`(--self by ${result.actorName}; ${result.previousStatus} → ${result.status}; owner=NULL)`)}`,
    );
  } else {
    console.log(
      `Claimed ${pc.bold(localId)} for ${pc.bold(result.ownerName)} ${pc.dim(`(${result.previousStatus} → ${result.status})`)}`,
    );
  }
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
}

/**
 * `mu task wait <ids...>`: the same wait as `mu wait`, over `task:` refs. A bare
 * id needs -w (or the worker's injected workstream); `<ws>/<id>` carries its own.
 * One engine (src/wait.ts), one JSON result; the only thing added here is the
 * hint after a closed task: the worker's worktree commits to pick from.
 */
export async function cmdTaskWait(
  db: Db,
  ids: readonly string[],
  opts: {
    status?: string;
    any?: boolean;
    first?: boolean;
    all?: boolean;
    allOf?: boolean;
    firstOf?: boolean;
    timeout?: number;
    stuckAfter?: number;
    onStall?: string;
    workstream?: string;
    json?: boolean;
  },
  sig: WaitSignals,
): Promise<void> {
  if (ids.length === 0) {
    throw new UsageError(say("task.wait_ids"));
  }
  const mode = waitMode(opts);
  const onStall = parseOnStall(opts.onStall);
  // An explicit -w is validated even when every ref is qualified.
  if (opts.workstream !== undefined) checkWorkstreamName(opts.workstream);
  const refs: WaitRef[] = [];
  for (const id of ids) {
    // `task wait` takes bare or qualified task ids; the typed form is accepted too.
    refs.push(await parseWaitRef(db, id.startsWith("task:") ? id : `task:${id}`, opts.workstream));
  }
  const spec: WaitSpec = {
    refs,
    mode,
    onStall,
    verb: "mu task wait",
    ...(opts.workstream !== undefined ? { scope: opts.workstream } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.stuckAfter !== undefined ? { stuckAfter: opts.stuckAfter } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  };
  await runWait(db, spec, sig);
}
