// mu — agent error classes.
//
// Every agent verb that can fail in a typed way has its own error class
// here. The CLI's classifyError() (src/cli/handle.ts) maps them to exit
// codes:
//   usage      → 2   (AgentAbortNeedsCtlError, AgentFreshNeedsCtlError,
//                     AgentSlashCommandUnsupportedError)
//   not found  → 3   (AgentNotFoundError)
//   conflict   → 4   (AgentExistsError, AgentNameExhaustedError,
//                     AgentNotInWorkstreamError,
//                     AgentSendUnsupportedError,
//                     AgentExtensionOutdatedError, AgentBusyError)
//   timeout    → 5   (AgentAbortTimeoutError)
//   failure    → 1   (AgentSpawnCliNotFoundError, AgentDiedOnSpawnError,
//                     AgentSpawnStartupError, AgentCtlUnreachableError)
//
// AgentDiedOnSpawnError + AgentSpawnStartupError reach into spawn.ts for
// defaultSpawnLivenessMs — a single, narrow cross-cluster import that
// documents itself in the error message ("agent died within Nms of
// spawn" / "agent reported a startup error within Nms of spawn") —
// and AgentSpawnStartupError for isExecFailureLine, to pick hints that
// fit the matched line.
//
// AgentSpawnCliNotFoundError is the pre-flight cousin of the two
// post-spawn-detect errors above: thrown BEFORE the worktree is created when
// the resolved `--cli` command's first token doesn't exist on PATH.
// Distinct from AgentSpawnStartupError so the operator can tell
// 'I never had a working CLI' from 'CLI started but parked at an error'.
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import { say } from "../messages.js";
import { defaultSpawnLivenessMs } from "./spawn.js";

/**
 * Pre-flight failure: the command mu would have spawned in the new
 * pane doesn't resolve to a binary on PATH (and isn't an absolute /
 * relative path that exists + is executable). Thrown by `spawnAgent`
 * BEFORE the worktree is created so a typo in `--cli` never leaves
 * an orphan worktree behind.
 *
 * Source: feedback ws task `fb_agent_spawn_no_validation`. Live
 * dogfood report: `mu agent spawn worker-1 --cli pi-meta` on a host
 * where the `pi-meta` binary wasn't on PATH printed `Spawned worker-1
 * (pi-meta)` and the pane immediately died with `command not found`;
 * the existing 1.5s liveness check sometimes missed it (the shell
 * stays alive after the failed exec). Pre-flighting the PATH lookup
 * surfaces the typo before any side effects (worktree, pane, DB row).
 *
 * Distinct from `AgentSpawnStartupError` (pane alive but parked at an
 * error prompt) and `AgentDiedOnSpawnError` (pane vanished within the
 * liveness window). All three carry different remediation hints, so
 * they're separate types.
 */
export class AgentSpawnCliNotFoundError extends Error {
  override readonly name = "AgentSpawnCliNotFoundError";
  constructor(
    public readonly cli: string,
    /** First whitespace-separated token of the resolved command — the
     *  thing actually missing on PATH. Surfaced verbatim in the
     *  message so the operator sees what mu searched for (which may
     *  differ from `cli` when `$MU_<UPPER_CLI>_COMMAND` rewrites it). */
    public readonly binary: string,
    /** Name of the env var that mu consulted before falling back to
     *  the bare `cli` value (e.g. `MU_PI_META_COMMAND`). Always set
     *  to the conventional name so the message can name it. */
    public readonly envVarChecked: string,
  ) {
    super(say("agent.cli_not_found", cli, binary, envVarChecked));
  }
}

export class AgentExistsError extends Error {
  override readonly name = "AgentExistsError";
  constructor(public readonly agentName: string) {
    // v5: agent names are UNIQUE per (workstream, name) — the same
    // name can legitimately exist in two different workstreams. The
    // pre-v5 message claimed global uniqueness, which (a) lied about
    // the schema and (b) misled operators into closing the existing
    // agent when the actual fix is `-w <other-ws>`.
    super(say("agent.exists", agentName));
  }
}

/** `spawn --next-free` found no free valid name near the asked one. */
export class AgentNameExhaustedError extends Error {
  override readonly name = "AgentNameExhaustedError";
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(say("agent.name_exhausted", agentName, reason));
  }
}

export class AgentNotFoundError extends Error {
  override readonly name = "AgentNotFoundError";
  constructor(
    public readonly agentName: string,
    /** Optional workstream context. When set, the message is enriched
     *  with `(in workstream <ws>)` so the verb that hit the miss
     *  (e.g. `mu agent close <agent> -w <ws>`) doesn't leave the
     *  operator guessing which scope was searched. Optional so existing
     *  call sites that only know the agent name keep their original
     *  one-line message. */
    public readonly workstream?: string,
  ) {
    super(say("agent.not_found", agentName, workstream));
  }
}

/**
 * Thrown when an entity-targeted verb is invoked with `-w/--workstream
 * <name>` but the named agent lives in a different workstream.
 * Mirrors `TaskNotInWorkstreamError`. Maps to exit code 4 (conflict /
 * wrong scope). Distinguishes "the user typo'd the workstream" from
 * "the agent doesn't exist anywhere" (which surfaces as
 * `AgentNotFoundError`).
 */
export class AgentNotInWorkstreamError extends Error {
  override readonly name = "AgentNotInWorkstreamError";
  constructor(
    public readonly agentName: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(say("agent.not_in_workstream", agentName, expectedWorkstream, actualWorkstream));
  }
}

/**
 * Thrown when an agent's pane is created and titled successfully but the
 * spawned process exits within the liveness window (default 1500ms;
 * configurable via `MU_SPAWN_LIVENESS_MS`). The most common cause is the
 * underlying CLI failing fast: a wrapper CLI blocking on a single-instance
 * lock, `claude` rejecting an invalid API key, etc. The agent's last
 * scrollback (when capturable) is attached to help diagnose.
 */
export class AgentDiedOnSpawnError extends Error {
  override readonly name = "AgentDiedOnSpawnError";
  /** The pane's transport reaches another machine (a host profile, or a hand-written ssh hop): remote causes, not wrapper locks. */
  readonly remote: boolean;
  /** The host profile the pane ran, when it was a `--host` spawn. */
  readonly host: string | undefined;
  constructor(
    public readonly agentName: string,
    public readonly paneId: string,
    public readonly scrollback: string | undefined,
    /** The command the pane ran; an `ssh ...` command gets remote hints. */
    public readonly command?: string,
    /** When it died; default `within <MU_SPAWN_LIVENESS_MS>ms of spawn`. */
    when = `within ${defaultSpawnLivenessMs()}ms of spawn`,
    host?: string,
  ) {
    const tail = scrollback?.trim();
    const detail = tail ? say("agent.scrollback", tail) : "";
    const remote = host !== undefined || /^\s*ssh\s/.test(command ?? "");
    const cause = remote ? say("agent.died_cause_remote", host) : say("agent.died_cause_local");
    super(say("agent.died_on_spawn", agentName, when, paneId, cause, detail));
    this.remote = remote;
    this.host = host;
  }
}

/**
 * Thrown when an agent's pane is alive AND staying alive after the
 * liveness window, but its first burst of output matches a known
 * provider-startup-failure pattern (missing API key, auth rejected, …).
 * Source: feedback ws task `agent_spawn_model_auth_failure_counts_as_live`.
 * Live dogfood report: `pi-meta --no-solo --model sonnet:high` printed
 * `Error: No API key found for amazon-bedrock` and parked at a prompt.
 * The pane stayed alive (1.5s liveness check passed) but the worker
 * could never do work — the orchestrator only discovered this when
 * `mu task wait` stalled minutes later.
 *
 * Distinct from `AgentDiedOnSpawnError`:
 *   - `AgentDiedOnSpawnError` → pane vanished within the liveness window
 *     (CLI exited fast).
 *   - `AgentSpawnStartupError` → pane alive, but the captured scrollback
 *     tail contains a curated provider-auth-failure pattern.
 * The two carry different remediation hints (CLI override vs. fix the
 * env var), so they're separate types instead of one with a flag.
 *
 * The pattern list is curated and short to keep false-positive risk low
 * — the scan only looks at the last ~30 lines of the 50-line capture
 * taken right after the liveness sleep, so matches naturally come from
 * the CLI's first ~1.5s of output (not arbitrary later prompts the
 * agent might type into).
 */
export class AgentSpawnStartupError extends Error {
  override readonly name = "AgentSpawnStartupError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string,
    /** The single scrollback line that matched a known startup-error
     *  pattern. Surfaced verbatim in the message so the operator sees
     *  what mu saw. */
    public readonly matchedLine: string,
    /** Full captured scrollback (tail-trimmed already by
     *  awaitSpawnLiveness). Attached to the message for context. */
    public readonly scrollback: string,
    /** When it was seen; default `within <MU_SPAWN_LIVENESS_MS>ms of spawn`. */
    when = `within ${defaultSpawnLivenessMs()}ms of spawn`,
  ) {
    super(
      say(
        "agent.startup_error",
        agentName,
        when,
        paneId,
        matchedLine.trim(),
        say("agent.scrollback", scrollback.trim()),
      ),
    );
  }
}

/**
 * The agent's pane and pi are up, but nothing answers on its control
 * socket (`MU_CTL_SOCK`): the mu pi extension is not loaded, or, for a
 * remote agent, the ssh command lacks the `-L` forward. Spawn does not
 * throw it — the agent is usable by hand — but prints it as a warning;
 * verbs that need the socket throw it.
 */
export class AgentCtlUnreachableError extends Error {
  override readonly name = "AgentCtlUnreachableError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly socket: string,
    public readonly kind: "missing" | "refused",
    /** The host profile the agent runs on, when remote: its forward is the usual cause. */
    public readonly host?: string | null,
  ) {
    super(say("agent.ctl_unreachable", agentName, kind, socket));
  }
}

/**
 * A side-effecting ctl request (send, fresh, interrupt, command) was
 * written to a live agent's socket, then no reply arrived (timeout or
 * close). pi may have queued the prompt, so a blind resend can duplicate it.
 */
export class AgentSendIndeterminateError extends Error {
  override readonly name = "AgentSendIndeterminateError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly op: string,
    public readonly reason: string,
    /** The receipt id the send carried: `mu agent check <agent> <msgId>` asks whether it landed. */
    public readonly msgId?: string,
    /** The pi process the send was written to (hello's), when the extension reports one. */
    public readonly incarnation?: string,
    /** The registry row the send went to (`AgentRow.incarnation`): its receipt check is offered only while that row stands. */
    public readonly agentId?: number,
  ) {
    super(say("agent.send_indeterminate", agentName, op, reason, msgId));
  }
}

/**
 * `mu agent wait --inc <i>` found another pi process behind the socket:
 * the agent restarted, and the run the caller waits on died with the old
 * process. Waiting more cannot recover it.
 */
export class AgentRestartedError extends Error {
  override readonly name = "AgentRestartedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly expected: string,
    public readonly actual?: string,
  ) {
    super(say("agent.restarted", agentName, expected, actual));
  }
}

/**
 * `agent close` killed the pane and it is STILL alive (moved out from under
 * the kill, or the mux refused), or the mux could not be asked in a torn-down
 * workstream. The row stays: no row is deleted while its pane may run.
 * Exit 4; the message names the retry.
 */
export class AgentPaneStillAliveError extends Error {
  override readonly name = "AgentPaneStillAliveError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly paneId: string,
    public readonly state: true | "unknown",
  ) {
    super(say("agent.pane_still_alive", agentName, workstream, paneId, state));
  }
}

/**
 * The name now belongs to another incarnation (a respawn, or the same pane
 * id reused) than the one this step meant, so nothing more was done to it.
 * `agent close`: whatever it already did to the ORIGINAL (a pane kill)
 * stands. `agent spawn --send` / `--task`: the prompt was NOT written. In
 * both the replacement's row, socket, worktree and tasks are untouched.
 * Exit 4.
 */
export class AgentReplacedError extends Error {
  override readonly name = "AgentReplacedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    during: "closed" | "sent to" | "collected" = "closed",
  ) {
    super(say("agent.replaced", agentName, workstream, during));
    this.during = during;
  }
  readonly during: "closed" | "sent to" | "collected";
}

/**
 * Another mu process holds this agent's lock (a close, or a `--worktree`
 * spawn staging the name) and did not release it in time. Nothing was
 * done: a destructive agent step never runs unlocked. Exit 4.
 */
export class AgentLockBusyError extends Error {
  override readonly name = "AgentLockBusyError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
  ) {
    super(say("agent.lock_busy", agentName, workstream));
  }
}

/**
 * A ctl verb (send, abort, ...) found the agent's control socket silent
 * AND its pane gone: the process exited (or the pane was closed behind
 * mu's back), so there is nothing to link or forward. Raised
 * instead of AgentCtlUnreachableError, which is for a live pane.
 */
export class AgentPaneDeadError extends Error {
  override readonly name = "AgentPaneDeadError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly paneId: string,
    /** Set when a send/fresh WAS written before the pane died: it may have landed. */
    public readonly msgId?: string,
  ) {
    super(say("agent.pane_dead", agentName, paneId, msgId));
  }
}

/**
 * `mu agent abort` on an agent that does not run pi: there is no control
 * socket to carry the abort, and mu does not silently signal the pane.
 */
export class AgentAbortNeedsCtlError extends Error {
  override readonly name = "AgentAbortNeedsCtlError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly cli: string,
  ) {
    super(say("agent.abort_needs_ctl", agentName, cli));
  }
}

/** The abort was delivered but pi did not settle within the timeout. */
export class AgentAbortTimeoutError extends Error {
  override readonly name = "AgentAbortTimeoutError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly timeoutMs: number,
  ) {
    super(say("agent.abort_timeout", agentName, timeoutMs));
  }
}

/**
 * `mu agent send --fresh` on an agent without a control socket (non-pi
 * CLI): there is no one-operation new session.
 */
export class AgentFreshNeedsCtlError extends Error {
  override readonly name = "AgentFreshNeedsCtlError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly cli: string,
  ) {
    super(say("agent.fresh_needs_ctl", agentName, cli));
  }
}

/**
 * The agent's pi serves the control socket with an extension it loaded
 * before mu learned `op` (e.g. `fresh`): running pi processes keep the
 * extension code they started with. pi's `/reload` re-imports the
 * extension through the pi package and keeps the socket; a
 * respawn always works. An extension that serves op `command` takes
 * `/reload` over ctl; an older one cannot be reloaded by mu: respawn it.
 */
export class AgentExtensionOutdatedError extends Error {
  override readonly name = "AgentExtensionOutdatedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    /** The op it answered "unknown op" to, or the feature (msgId, incarnation) its hello lacks. */
    public readonly op: string,
    public readonly extVersion?: string,
    /** Ops the extension serves (from its "unknown op" reply or hello); absent from old extensions. */
    public readonly ops?: readonly string[],
    /** The recovery inputs only the caller can compute (the mux and the agent row). */
    public readonly recovery: {
      /** A shell line that types /reload into the pane through the mux (herdr). */
      muxReload?: string;
      /** The agent's original spawn command, rebuilt from its row. */
      respawn?: string;
      /** `op` is a feature of the hello reply, not an op. */
      feature?: boolean;
    } = {},
  ) {
    super(
      say(
        "agent.extension_outdated",
        agentName,
        extVersion ?? "version unknown",
        recovery.feature === true,
        op,
      ),
    );
  }
}

/**
 * `send --fresh` or a session command (`/new`, `/reload`, `/compact`)
 * refused: pi is mid-turn, and running it would abandon the turn.
 */
export class AgentBusyError extends Error {
  override readonly name = "AgentBusyError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    /** The session command refused, e.g. "/new". Absent: `--fresh`. */
    public readonly command?: string,
  ) {
    super(say("agent.busy", agentName, command ?? "--fresh"));
  }
}

/**
 * A slash command other than `/new`, `/reload`, `/compact` sent to a pi
 * agent. The control socket cannot run it (pi.sendUserMessage would
 * hand it to the model as text), and mu has no paste into a pi pane:
 * the operator types it in the pane.
 */
export class AgentSlashCommandUnsupportedError extends Error {
  override readonly name = "AgentSlashCommandUnsupportedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly text: string,
    public readonly supported: readonly string[],
  ) {
    super(say("agent.slash_unsupported", agentName, supported, text));
  }
}

/**
 * An empty message sent to a pi agent over the control socket.
 * pi.sendUserMessage("") is meaningless; a bare Enter is a pane
 * keystroke, which mu does not send.
 */
export class AgentEmptySendError extends Error {
  override readonly name = "AgentEmptySendError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
  ) {
    super(say("agent.empty_send", agentName));
  }
}

/**
 * `mu agent send` to a non-pi agent on a backend with no `sendToPane`
 * (tmux): its bracketed paste cannot be confirmed, so mu refuses. Maps to
 * exit code 4 (conflict).
 */
export class AgentSendUnsupportedError extends Error {
  override readonly name = "AgentSendUnsupportedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly cli: string,
  ) {
    super(say("agent.send_unsupported", agentName, cli));
  }
}

/**
 * A pi extension answered a send/fresh with `ok: false`: it read the request
 * and took nothing. (Unlike a silent socket, an explicit refusal proves the
 * prompt was not accepted.)
 */
export class AgentSendRefusedError extends Error {
  override readonly name = "AgentSendRefusedError";
  constructor(public readonly reason: string) {
    super(say("agent.send_refused", reason));
  }
}

/**
 * `agent spawn --task`: another mu process is running this same attempt
 * (task + attempt key). Nothing was done; retry once it finishes and the
 * replay returns its outcome. Exit 4.
 */
export class SpawnAttemptBusyError extends Error {
  override readonly name = "SpawnAttemptBusyError";
  constructor(
    public readonly task: string,
    public readonly attemptKey: string,
  ) {
    super(say("agent.attempt_busy", task, attemptKey));
  }
}

/**
 * `mu next`: an executor attempt (`auto:<n>`) cannot be run or resumed: it
 * failed before anything was sent (its run stays charged), was never
 * reserved, or its saved identity is gone. It is never reset; the next
 * attempt is a new key and a new charge. Exit 4.
 */
export class SpawnAttemptFailedError extends Error {
  override readonly name = "SpawnAttemptFailedError";
  constructor(
    public readonly task: string,
    public readonly attemptKey: string,
    reason: string,
  ) {
    super(say("agent.attempt_failed", task, attemptKey, reason));
  }
}

/**
 * `mu next`: permission, readiness or the revision changed between the
 * reservation and an effect (revoked `mu task auto`, another host
 * designated, the task claimed or closed). Nothing was spawned or sent past
 * this point; a reservation made earlier stays resumable. Exit 4.
 */
export class SpawnAttemptGuardError extends Error {
  override readonly name = "SpawnAttemptGuardError";
  constructor(
    public readonly task: string,
    public readonly attemptKey: string,
    reason: string,
  ) {
    super(say("agent.attempt_stopped", task, attemptKey, reason));
  }
}

/**
 * `agent spawn --task`: the task is not claimable by this attempt any more
 * (closed, or owned by someone else since the claim). Nothing was sent; the
 * attempt's own pane is rolled back. Exit 4.
 */
export class SpawnTaskStateError extends Error {
  override readonly name = "SpawnTaskStateError";
  constructor(
    public readonly task: string,
    reason: string,
  ) {
    super(say("agent.task_state", task, reason));
  }
}

/**
 * `agent spawn --task` replayed an attempt key with a different request
 * (name, text or --next-free): a second prompt must be a new attempt. Exit 4.
 */
export class SpawnReceiptConflictError extends Error {
  override readonly name = "SpawnReceiptConflictError";
  constructor(
    public readonly task: string,
    public readonly attemptKey: string,
    public readonly savedName: string,
  ) {
    super(say("agent.receipt_conflict", task, attemptKey, savedName));
  }
}

/**
 * `agent spawn --task`: the agent came up but cannot take the prompt (Claude
 * is parked at its folder-trust dialog). Nothing was sent; the spawn was
 * rolled back. Exit 1.
 */
export class SpawnTrustDialogError extends Error {
  override readonly name = "SpawnTrustDialogError";
  constructor(public readonly agentName: string) {
    super(say("agent.trust_dialog", agentName));
  }
}
