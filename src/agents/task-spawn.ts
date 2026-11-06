// mu — `agent spawn --task`: the task-bound spawn, claim and first prompt as
// ONE journaled attempt (docs/VOCABULARY.md § spawn receipt).
//
// Order of effects, each journaled in `spawn_receipts` BEFORE it happens:
//   reserve (msgId minted, nothing else) -> spawn the pane (the registry id +
//   pane are journaled inside the spawn lock) -> claim the task for THAT id
//   -> `sending` -> write the prompt with the reserved msgId -> sent -> brief.
//
// Failure policy. Everything up to a send that provably never reached pi
// (ctl missing, refused, outdated, busy, a claim that lost its task, a pane
// dead with no write evidence) is UNSENT: the claim is released and the spawn
// rolled back, each only while it is still this attempt's own (identity
// bound; spawn.ts's guards are reused unchanged). From the moment the prompt
// may have been written, anything else is UNKNOWN: pane and claim are KEPT
// (deleteAgent would reopen the task for another dispatch), the receipt says
// `unknown`, and a replay asks the extension ONCE (`status {msgId}`) but
// never resends: an extension keeps only its last 64 ids, so "not found" is
// still UNKNOWN, not unsent.
//
// On `hooks` (spec D17) the worker was launched with no prompt, and the write
// is: wait for its `session_start` (its harness's hello), write the brief to
// `.mu/brief-<agent>-<key>.md` in its cwd (with `.mu/.gitignore`), journal
// `sending` with that read as the baseline, then paste ONE line pointing at
// the file, confirmed by `run_count`. An unconfirmed paste is UNKNOWN; a
// replay reads the inbox for a run past the baseline instead of a msgId. A
// remote `hooks` worker (spec D11) is read on its node for the session, its
// file is written there through the host's exec template (a brief over 96 KB
// is refused before the spawn), and its paste is `sent`, confirmed by the
// next read.
//
// Replay (same task + attempt key). The saved registry id + pane are compared
// with the agent now holding the name; a deleted or replaced one is reported
// `stale`, never swapped for the replacement. A manual DELIVERED attempt whose
// agent is stale has ended: the replay refuses (`SpawnAttemptEndedError`,
// naming the next free key) instead of re-reporting the old delivery. The attempt lock is strict
// (fails closed); the advisory spawn lock stays inside spawnAgent.

import { type AgentRow, getAgentForCleanup } from "../agents.js";
import {
  agentChannel,
  awaitHooksSession,
  channelTarget,
  deliver,
  type HooksReadiness,
  hooksFence,
  hooksRunSince,
  isSlashCommand,
  newMsgId,
  parseSessionCommand,
  type SendResult,
} from "../channels/index.js";
import type { Db } from "../db.js";
import { delegateSessionDir } from "../delegates.js";
import { harnessOfCli } from "../harnesses.js";
import { say } from "../messages.js";
import { claimTask, releaseTask, resolveActorIdentity } from "../tasks/claim.js";
import { addNote } from "../tasks/edit.js";
import { TaskAlreadyOwnedError, TaskNotFoundError } from "../tasks/errors.js";
import { getTask, selectTaskNotes, taskIdFor } from "../tasks.js";
import { getWorktreeAt } from "../worktree.js";
import {
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentEmptySendError,
  AgentExistsError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  AgentPaneDeadError,
  AgentReplacedError,
  AgentSendGateError,
  AgentSendRefusedError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
  AgentSteerUnsupportedError,
  SpawnAttemptBusyError,
  SpawnAttemptEndedError,
  SpawnAttemptFailedError,
  SpawnReceiptConflictError,
  SpawnTaskStateError,
  SpawnTrustDialogError,
} from "./errors.js";
import {
  assertRemoteBriefFits,
  briefPointer,
  writeBriefFile,
  writeRemoteBriefFile,
} from "./hooks-brief.js";
import { withSpawnAttemptLock } from "./lock.js";
import {
  getReceipt,
  nextAttemptKey,
  requestSha,
  reserveReceipt,
  resetReceipt,
  type SpawnReceipt,
  updateReceipt,
} from "./receipts.js";
import {
  isCommandGate,
  rollbackSpawn,
  type SpawnAgentOptions,
  type SpawnedAgent,
  type StagedWorktree,
  spawnAgent,
} from "./spawn.js";
import { recordSend } from "./transport.js";

export interface TaskSpawnRequest {
  /** The spawn itself (name, workstream, cli, worktree, ...). `onIdentity` is this module's. */
  spawn: Omit<SpawnAgentOptions, "onIdentity">;
  /** The task's local id, in `spawn.workstream`. */
  task: string;
  /** The attempt's name. Default: the task id. Stored as `manual:<key>`. */
  attempt?: string;
  /** The first prompt; also the task's pinned brief once it is delivered. */
  text: string;
}

export interface TaskSpawnOutcome {
  /** `sent`: delivered (now or by an earlier run). `unknown`: it may have landed; never resent. */
  state: "sent" | "unknown";
  /** True when a saved receipt answered and nothing new was spawned or sent. */
  replay: boolean;
  receipt: SpawnReceipt;
  /** The live agent of THIS attempt; absent when its identity is stale. */
  agent?: SpawnedAgent | AgentRow;
  /** The saved identity no longer holds: the agent was `deleted`, or the name now belongs to another `replaced` it. */
  stale?: "deleted" | "replaced";
  /** The send's own result; only on the run that sent. */
  send?: SendResult;
  /** On `unknown`: why (the error, or the replay probe's verdict). */
  reason?: string;
  /** A replay's one receipt probe, when it made one. */
  checked?: "accepted" | "not-accepted" | "unreachable";
  /** Whether the brief note was written, found, or could not be (reconciled on replay). */
  brief: "recorded" | "kept" | "pending";
}

const manualKey = (req: TaskSpawnRequest): string => `manual:${req.attempt ?? req.task}`;

/**
 * A remote spawn of a hook harness gets its brief as a file written through
 * the host's exec template (spec D17): one over the cap is refused before the
 * spawn (a manual attempt before its reservation too; the write itself
 * refuses it again). pi keeps ctl remotely, and a command gate takes no brief.
 */
function assertBriefFitsSpawn(req: TaskSpawnRequest): void {
  const s = req.spawn;
  if (s.host === undefined || isCommandGate(s)) return;
  const cli = s.cli ?? "pi";
  const harness = harnessOfCli(cli, s.command ?? cli);
  if (harness === undefined || harness === "pi") return;
  assertRemoteBriefFits(s.name, s.host, req.text);
}

/**
 * The executor's `auto:<n>` namespace (src/auto-attempt.ts reserves it and
 * charges the run). Guarded replay: the receipt must already be reserved, a
 * failed (or stale-identity) attempt is NEVER reset or reused (it throws
 * `SpawnAttemptFailedError`; the next attempt is a new key and a new charge),
 * and `guard` is asked before the pane exists (`spawn`) and again inside the
 * transaction just before the prompt is written (`send`): a throw there is an
 * unsent failure, rolled back like any other.
 */
export interface AutoAttemptRequest extends Omit<TaskSpawnRequest, "attempt"> {
  /** `auto:<n>`. */
  key: string;
  guard: (phase: "spawn" | "send") => void;
  /**
   * The attempt is an IN-PLACE retry of a live worker: an unsent failure marks
   * the receipt failed and nothing else. The worker, its claim and its worktree
   * are never released, killed or rolled back.
   */
  keepAgent?: boolean;
}

/** Errors raised BEFORE any byte of the prompt could have been written. */
export function definitelyUnsent(err: unknown): boolean {
  return (
    err instanceof AgentCtlUnreachableError ||
    err instanceof AgentExtensionOutdatedError ||
    err instanceof AgentEmptySendError ||
    err instanceof AgentFreshNeedsCtlError ||
    err instanceof AgentSendUnsupportedError ||
    err instanceof AgentSlashCommandUnsupportedError ||
    err instanceof AgentBusyError ||
    err instanceof AgentSendRefusedError ||
    // hooks: the gate read the pane and refused, or a steer was refused, before any paste.
    err instanceof AgentSendGateError ||
    err instanceof AgentSteerUnsupportedError ||
    // Another pi owns the socket now: refused before (or at) the dispatch.
    err instanceof AgentReplacedError ||
    // A pane that died WITH write evidence (a msgId) may have taken the prompt first.
    (err instanceof AgentPaneDeadError && err.msgId === undefined)
  );
}

/** INSERT `text` as the task's `brief` note unless it already has one. */
export async function pinBrief(
  db: Db,
  task: string,
  workstream: string,
  text: string,
): Promise<"recorded" | "kept"> {
  // Resolve the author first: no await may sit between the check and the INSERT.
  const author = await resolveActorIdentity();
  // One IMMEDIATE transaction takes the write lock before the check, so two
  // concurrent callers (in-process or separate CLIs) cannot both see "no brief".
  const recorded = db
    .transaction((): boolean => {
      if (selectTaskNotes(db, task, { workstream }).notes.some((n) => n.kind === "brief")) {
        return false;
      }
      addNote(db, task, text, { workstream, kind: "brief", author });
      return true;
    })
    .immediate();
  return recorded ? "recorded" : "kept";
}

/** Best-effort brief pin: a delivered prompt is never reported as failed over its note. */
async function tryPinBrief(
  db: Db,
  req: TaskSpawnRequest,
): Promise<"recorded" | "kept" | "pending"> {
  try {
    return await pinBrief(db, req.task, req.spawn.workstream, req.text);
  } catch {
    return "pending";
  }
}

/** The worktree this attempt's agent runs in, as rollbackSpawn needs it (registry row at its cwd). */
function stagedOf(db: Db, row: AgentRow): StagedWorktree | undefined {
  // A remote worktree has no local registry row: the agent row carries host, path, base and repo.
  if (row.host !== null) {
    if (row.cwd === null || row.base === null || row.repo === null) return undefined;
    return {
      path: row.cwd,
      base: row.base,
      root: row.repo,
      createdAt: row.createdAt,
      incarnation: row.incarnation,
      host: row.host,
    };
  }
  const wt = row.cwd === null ? undefined : getWorktreeAt(db, row.cwd);
  if (wt === undefined || wt.agent !== row.name) return undefined;
  return {
    path: wt.path,
    base: wt.base,
    root: wt.root,
    createdAt: wt.createdAt,
    incarnation: row.incarnation,
  };
}

/** The agent now holding the saved name, when it IS the saved incarnation. */
export function savedIdentity(
  db: Db,
  rec: SpawnReceipt,
): { agent?: AgentRow; stale?: "deleted" | "replaced" } {
  const cur = getAgentForCleanup(db, rec.name, rec.workstream);
  if (cur === undefined) return { stale: "deleted" };
  if (rec.agentId !== null && cur.incarnation === rec.agentId && cur.paneId === rec.paneId) {
    return { agent: cur };
  }
  return { stale: "replaced" };
}

/**
 * Run (or replay) one task-bound spawn attempt. Throws before any effect for
 * a bad request (unknown task, owned task, slash text, busy or conflicting
 * attempt) and, after an UNSENT failure, the original error once its own
 * resources are cleaned up. A delivered or unknown outcome is returned.
 */
export async function spawnForTask(db: Db, req: TaskSpawnRequest): Promise<TaskSpawnOutcome> {
  const ws = req.spawn.workstream;
  const taskId = taskIdFor(db, req.task, ws);
  if (taskId === null) throw new TaskNotFoundError(req.task, ws);
  // The text is a prompt, never a pi session command (those carry no receipt).
  if (req.text === "") throw new AgentEmptySendError(req.spawn.name, ws);
  if (parseSessionCommand(req.text) !== undefined || isSlashCommand(req.text)) {
    throw new AgentSlashCommandUnsupportedError(req.spawn.name, ws, req.text, []);
  }
  assertBriefFitsSpawn(req);
  const key = manualKey(req);
  return withSpawnAttemptLock(
    db,
    taskId,
    key,
    () => run(db, req, taskId, key, undefined),
    () => {
      throw new SpawnAttemptBusyError(req.task, key);
    },
  );
}

/** Run or resume one reserved executor attempt (see {@link AutoAttemptRequest}). */
export async function spawnAutoAttempt(db: Db, req: AutoAttemptRequest): Promise<TaskSpawnOutcome> {
  const ws = req.spawn.workstream;
  const taskId = taskIdFor(db, req.task, ws);
  if (taskId === null) throw new TaskNotFoundError(req.task, ws);
  if (req.text === "") throw new AgentEmptySendError(req.spawn.name, ws);
  if (parseSessionCommand(req.text) !== undefined || isSlashCommand(req.text)) {
    throw new AgentSlashCommandUnsupportedError(req.spawn.name, ws, req.text, []);
  }
  // No brief cap before the lock: the attempt is reserved and charged, so an oversized remote
  // brief fails inside it, before the spawn (the receipt `failed`), never left `reserved`.
  return withSpawnAttemptLock(
    db,
    taskId,
    req.key,
    () => run(db, req, taskId, req.key, req.guard, req.keepAgent === true),
    () => {
      throw new SpawnAttemptBusyError(req.task, req.key);
    },
  );
}

async function run(
  db: Db,
  req: TaskSpawnRequest,
  taskId: number,
  key: string,
  guard: AutoAttemptRequest["guard"] | undefined,
  keep = false,
): Promise<TaskSpawnOutcome> {
  const ws = req.spawn.workstream;
  const sha = requestSha({
    name: req.spawn.name,
    nextFree: req.spawn.nextFree === true,
    text: req.text,
    host: req.spawn.host,
    root: req.spawn.root,
  });
  const saved = getReceipt(db, taskId, key);
  const auto = guard !== undefined;
  const failedAttempt = (why: string): never => {
    throw new SpawnAttemptFailedError(req.task, key, why);
  };
  if (saved === undefined) {
    if (auto) return failedAttempt("it was never reserved");
    return fresh(db, req, taskId, key, sha);
  }
  if (saved.state === "failed") {
    // Nothing was sent: a manual key may run again, with this request. An
    // executor attempt never does: its run was charged, the next one is new.
    if (auto) return failedAttempt(saved.detail ?? "it failed before anything was sent");
    return fresh(db, req, taskId, key, sha, true);
  }
  if (saved.requestSha !== sha) throw new SpawnReceiptConflictError(req.task, key, saved.name);
  const id = savedIdentity(db, saved);

  if (saved.state === "sent") {
    // A manual replay whose agent is gone is not a delivery: nothing runs for
    // it. Refuse (exit 4) with the key that starts again; never act under it.
    if (!auto && id.stale !== undefined) {
      throw new SpawnAttemptEndedError(
        req.task,
        key,
        saved.name,
        id.stale,
        nextAttemptKey(db, taskId, key),
      );
    }
    const brief = await tryPinBrief(db, req);
    return {
      state: "sent",
      replay: true,
      receipt: saved,
      ...(id.agent !== undefined ? { agent: id.agent } : {}),
      ...(id.stale !== undefined ? { stale: id.stale } : {}),
      brief,
    };
  }

  if (saved.state === "sending" || saved.state === "unknown") return reconcile(db, req, saved, id);

  if (saved.state === "reserved" && auto) {
    // Nothing happened yet (the executor spawns `nextFree`, so a taken name is skipped).
    return drive(db, req, taskId, key, saved, undefined, guard, keep);
  }
  if (saved.state === "reserved") {
    // No identity journaled: a name that exists now is not provably ours.
    if (req.spawn.nextFree !== true && getAgentForCleanup(db, saved.name, ws) !== undefined) {
      throw new AgentExistsError(saved.name);
    }
    updateReceipt(db, taskId, key, { state: "failed", detail: "reservation never reached a pane" });
    return fresh(db, req, taskId, key, sha, true);
  }

  // pane | claimed: resume at the next step on the saved identity, or start over.
  if (id.agent === undefined) {
    const why = `saved agent ${saved.agentId ?? "?"} is ${id.stale ?? "gone"}; nothing was sent`;
    updateReceipt(db, taskId, key, { state: "failed", detail: why });
    if (auto) return failedAttempt(why);
    return fresh(db, req, taskId, key, sha, true);
  }
  return drive(db, req, taskId, key, saved, id.agent, guard, keep);
}

/** Reserve, then spawn and drive a brand new attempt (or a reset failed one). */
async function fresh(
  db: Db,
  req: TaskSpawnRequest,
  taskId: number,
  key: string,
  sha: string,
  reuse = false,
): Promise<TaskSpawnOutcome> {
  const ws = req.spawn.workstream;
  // Cheap refusals before any effect: someone else already owns the task.
  const task = getTask(db, req.task, ws);
  if (task === undefined) throw new TaskNotFoundError(req.task, ws);
  if (task.ownerId !== null) {
    throw new TaskAlreadyOwnedError(req.task, task.ownerName ?? "<unknown>");
  }
  if (task.status === "CLOSED") throw new SpawnTaskStateError(req.task, "is closed");
  const base = { name: req.spawn.name, requestSha: sha, msgId: newMsgId() };
  const rec = reuse
    ? resetReceipt(db, taskId, key, base)
    : reserveReceipt(db, { taskId, attemptKey: key, workstream: ws, ...base });
  return drive(db, req, taskId, key, rec, undefined, undefined);
}

/** A delegate task's pi spawn keeps its session in {@link delegateSessionDir}. */
function delegateSession(
  db: Db,
  task: string,
  ws: string,
): Pick<SpawnAgentOptions, "piSessionDir"> {
  if (getTask(db, task, ws)?.kind !== "delegate") return {};
  return { piSessionDir: delegateSessionDir(db.name, ws, task) };
}

/**
 * Spawn (when `agent` is absent), claim (when not yet), send, journal. The
 * rollback try covers everything up to the moment the prompt may be written.
 */
async function drive(
  db: Db,
  req: TaskSpawnRequest,
  taskId: number,
  key: string,
  start: SpawnReceipt,
  resumed: AgentRow | undefined,
  guard: AutoAttemptRequest["guard"] | undefined,
  keep = false,
): Promise<TaskSpawnOutcome> {
  const ws = req.spawn.workstream;
  // Before any effect: a refusal leaves the reservation as it is (resumable).
  if (resumed === undefined) guard?.("spawn");
  let rec = start;
  let agent: SpawnedAgent | AgentRow | undefined = resumed;
  let claimed = rec.state === "claimed";
  let staged: StagedWorktree | undefined =
    resumed !== undefined && req.spawn.worktree === true ? stagedOf(db, resumed) : undefined;
  let sending = false;
  // spawnAgent rolls its own pane, row and worktree back when it throws.
  let spawnThrew = false;
  // hooks (spec D17): the pane as read before the pointer, and the pointer itself.
  let ready: HooksReadiness | undefined;
  let hooksText: string | undefined;

  const unsent = async (err: unknown): Promise<never> => {
    // `keep`: a live worker's in-place retry. Its claim and pane are the worker's, not this attempt's.
    if (agent !== undefined && !spawnThrew && !keep) {
      const owned = agent.incarnation;
      // Only while the task is still owned by THIS incarnation (and not
      // closed): a claim committed before a crash is undone too, a task
      // someone else holds now is not touched.
      try {
        releaseTask(db, req.task, { workstream: ws, expectedOwnerId: owned });
      } catch {
        // best-effort: a held task is left for `mu task release`
      }
      try {
        await rollbackSpawn(db, agent.name, agent.paneId, staged, owned, ws);
      } catch {
        // best-effort, as in spawnAgent's own rollback
      }
    }
    try {
      updateReceipt(db, taskId, key, {
        state: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // the original error matters more
    }
    throw err;
  };

  let row: AgentRow;
  try {
    if (agent === undefined) {
      // An executor attempt's oversized remote brief: nothing is spawned for it.
      assertBriefFitsSpawn(req);
      spawnThrew = true;
      const spawned = await spawnAgent(db, {
        ...req.spawn,
        ...delegateSession(db, req.task, ws),
        onIdentity: (r) => {
          rec = updateReceipt(db, taskId, key, {
            state: "pane",
            name: r.name,
            agentId: r.incarnation,
            paneId: r.paneId,
          });
          if (req.spawn.worktree === true) staged = stagedOf(db, r);
          agent = r;
        },
      });
      agent = spawned;
      spawnThrew = false;
      // The pi this spawn's handshake saw: every send below is bound to it.
      if (spawned.ctlIncarnation !== undefined) {
        rec = updateReceipt(db, taskId, key, { incarnation: spawned.ctlIncarnation });
      }
      // The pane is up but cannot take (or confirm) a prompt: nothing was sent.
      if (spawned.ctl === "missing" || spawned.ctl === "refused") {
        throw new AgentCtlUnreachableError(
          spawned.name,
          ws,
          spawned.ctlSocket,
          spawned.ctl,
          spawned.host,
        );
      }
      if (spawned.trustDialog === true) throw new SpawnTrustDialogError(spawned.name);
    }
    const target = agent;
    if (!claimed) {
      await claimTask(db, req.task, {
        workstream: ws,
        agentName: target.name,
        expectedAgentId: target.incarnation,
      });
      claimed = true;
      rec = updateReceipt(db, taskId, key, { state: "claimed" });
    }
    // hooks: the harness's hello, then the brief file. Both before `sending`: a
    // failure here is unsent, and a replay writes the same bytes again. A remote
    // worker's file is written on its host, in its remote cwd (spec D17).
    const hooksTarget = channelTarget(db, target);
    if (agentChannel(hooksTarget).name === "hooks") {
      const t = hooksTarget.agent;
      if (t.cwd === null) {
        const why = say("agent.task_brief_hooks", t.name);
        throw new AgentSendUnsupportedError(t.name, ws, t.cli, why);
      }
      ready = await awaitHooksSession(hooksTarget);
      const file =
        t.host !== null
          ? await writeRemoteBriefFile(db, t.host, t.cwd, t.name, ws, key, req.text)
          : writeBriefFile(t.cwd, t.name, key, req.text);
      hooksText = briefPointer(file);
    }
    // One immediate transaction right before the write (no await inside):
    // the delivery targets the SAVED registry id + pane, never whatever holds
    // the name now, and only while the claim is still this agent's and the
    // task still open (a resume from 'claimed' trusts no earlier view).
    // 'sending' is journaled BEFORE the write: from here a crash means "may have landed".
    req.spawn.signal?.throwIfAborted(); // the last point an abort still rolls back
    const checked = db
      .transaction((): { row: AgentRow; rec: SpawnReceipt } => {
        const now = getAgentForCleanup(db, target.name, ws);
        if (
          now === undefined ||
          now.incarnation !== target.incarnation ||
          now.paneId !== target.paneId
        ) {
          throw new AgentReplacedError(target.name, ws, "sent to");
        }
        guard?.("send");
        const t = getTask(db, req.task, ws);
        if (t === undefined) throw new TaskNotFoundError(req.task, ws);
        if (t.status === "CLOSED") throw new SpawnTaskStateError(req.task, "was closed");
        if (t.ownerId !== now.incarnation) {
          if (t.ownerId !== null) {
            throw new TaskAlreadyOwnedError(req.task, t.ownerName ?? "<unknown>");
          }
          throw new SpawnTaskStateError(req.task, `is no longer claimed by ${now.name}`);
        }
        const transport = agentChannel(channelTarget(db, now)).name;
        // The brief file was written for a hooks agent above; a channel that changed
        // since (it cannot: the row is the same incarnation) never pastes unprepared.
        if ((transport === "hooks") !== (hooksText !== undefined)) {
          throw new AgentReplacedError(now.name, ws, "sent to");
        }
        // hooks: what the readiness read is the baseline a replay confirms the run against.
        const journaled = updateReceipt(db, taskId, key, {
          state: "sending",
          transport,
          ...(ready !== undefined ? { incarnation: ready.sessionId, runs: ready.runCount } : {}),
        });
        return { row: now, rec: journaled };
      })
      .immediate();
    row = checked.row;
    rec = checked.rec;
    sending = true;
  } catch (err) {
    return unsent(err);
  }

  // ── the write ──
  let undelivered: string | undefined;
  let sent: SendResult;
  const onUndelivered = (w: { message: string }): void => {
    undelivered = w.message;
  };
  try {
    sent =
      hooksText !== undefined
        ? // A just-launched worker has no turn to wait for, and a first-prompt harness
          // (codex, muse) no murmur row yet: the gate's unknown is expected, never a
          // dialog (a dialog is refused even so). An in-place retry is gated as usual.
          // A fresh spawn's pointer is its first prompt: a first-prompt harness's ack gets
          // MU_FIRST_SEND_ACK_MS.
          await deliver(channelTarget(db, row), hooksText, {
            force: !keep,
            ...(keep ? {} : { firstPrompt: true }),
            onUndelivered,
          })
        : await deliver(channelTarget(db, row), req.text, {
            msgId: rec.msgId,
            ...(rec.incarnation !== null ? { expectIncarnation: rec.incarnation } : {}),
            onUndelivered,
          });
  } catch (err) {
    if (sending && definitelyUnsent(err)) return unsent(err);
    const reason = err instanceof Error ? err.message : String(err);
    const inc = (err as { incarnation?: unknown }).incarnation;
    // Keep the pane, the claim and the receipt: the prompt may be running.
    const unknownRec = updateReceipt(db, taskId, key, {
      state: "unknown",
      detail: reason,
      ...(typeof inc === "string" ? { incarnation: inc } : {}),
    });
    return {
      state: "unknown",
      replay: false,
      receipt: unknownRec,
      agent: agent,
      reason,
      brief: "pending",
    };
  }
  if (undelivered !== undefined) {
    // A paste that looked calm but never registered: not provably sent.
    const unknownRec = updateReceipt(db, taskId, key, { state: "unknown", detail: undelivered });
    return {
      state: "unknown",
      replay: false,
      receipt: unknownRec,
      agent,
      reason: undelivered,
      brief: "pending",
    };
  }

  // ── delivered: nothing below may fail the attempt ──
  // hooks: the confirmed paste's fence (turns settled before its run, its session).
  const fence = hooksText !== undefined ? hooksFence(sent) : sent;
  try {
    rec = updateReceipt(db, taskId, key, {
      state: "sent",
      detail: null,
      ...(fence.incarnation !== undefined ? { incarnation: fence.incarnation } : {}),
      ...(fence.runs !== undefined ? { runs: fence.runs } : {}),
    });
  } catch {
    // stays 'sending': a replay asks the extension and records it
  }
  try {
    recordSend(
      db,
      row,
      "plain",
      Buffer.byteLength(hooksText ?? req.text),
      { transport: sent.transport, state: sent.state, since: sent.since },
      await resolveActorIdentity(),
    );
  } catch {
    // the audit line is best-effort once delivered
  }
  const brief = await tryPinBrief(db, req);
  return { state: "sent", replay: false, receipt: rec, agent: agent ?? row, send: sent, brief };
}

/** A `sending`/`unknown` receipt: ask the extension ONCE about the saved msgId; never resend. */
async function reconcile(
  db: Db,
  req: TaskSpawnRequest,
  saved: SpawnReceipt,
  id: { agent?: AgentRow; stale?: "deleted" | "replaced" },
): Promise<TaskSpawnOutcome> {
  const stay = (reason: string, checked?: TaskSpawnOutcome["checked"]): TaskSpawnOutcome => {
    const rec =
      saved.state === "unknown"
        ? saved
        : updateReceipt(db, saved.taskId, saved.attemptKey, { state: "unknown", detail: reason });
    return {
      state: "unknown",
      replay: true,
      receipt: rec,
      ...(id.agent !== undefined ? { agent: id.agent } : {}),
      ...(id.stale !== undefined ? { stale: id.stale } : {}),
      reason,
      ...(checked !== undefined ? { checked } : {}),
      brief: "pending",
    };
  };
  if (id.agent === undefined) return stay(`the sending agent is ${id.stale ?? "gone"}`);
  if (saved.transport === "hooks") return reconcileHooks(db, req, saved, id.agent, stay);
  if (saved.transport !== "ctl") return stay("the send went through the pane: no receipt to ask");
  const target = channelTarget(db, id.agent);
  const check = await agentChannel(target).receipt(target, saved.msgId);
  if (check.state !== "accepted") {
    return stay(
      check.state === "unreachable"
        ? check.reason
        : "the extension does not remember the id (it keeps the last 64): still unknown, never unsent",
      check.state,
    );
  }
  const rec = updateReceipt(db, saved.taskId, saved.attemptKey, {
    state: "sent",
    ...(check.incarnation !== undefined ? { incarnation: check.incarnation } : {}),
    ...(check.runs !== undefined ? { runs: check.runs } : {}),
  });
  const brief = await tryPinBrief(db, req);
  return { state: "sent", replay: true, receipt: rec, agent: id.agent, checked: "accepted", brief };
}

/**
 * The `hooks` branch of a replay (spec D17): no msgId to ask, so read the
 * agent's inbox for a run past the receipt's baseline (its `session_id` and
 * `run_count` before the pointer). One promotes the receipt to `sent` and pins
 * the brief; none (or an unreadable pane) stays `unknown`. Never re-pastes.
 */
async function reconcileHooks(
  db: Db,
  req: TaskSpawnRequest,
  saved: SpawnReceipt,
  agent: AgentRow,
  stay: (reason: string, checked?: TaskSpawnOutcome["checked"]) => TaskSpawnOutcome,
): Promise<TaskSpawnOutcome> {
  const ran = await hooksRunSince(channelTarget(db, agent), {
    sessionId: saved.incarnation,
    runCount: saved.runs,
  });
  if (ran.state === "unreachable") return stay(ran.reason, "unreachable");
  if (ran.state === "none") {
    return stay(say("agent.task_brief_hooks_unseen", agent.name), "not-accepted");
  }
  const rec = updateReceipt(db, saved.taskId, saved.attemptKey, {
    state: "sent",
    detail: null,
    runs: ran.runs,
    ...(ran.sessionId !== null ? { incarnation: ran.sessionId } : {}),
  });
  const brief = await tryPinBrief(db, req);
  return { state: "sent", replay: true, receipt: rec, agent, checked: "accepted", brief };
}
