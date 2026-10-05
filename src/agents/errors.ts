// mu — agent error classes.
//
// Every agent verb that can fail in a typed way has its own error class
// here. The CLI's classifyError() (src/cli/handle.ts) maps them to exit
// codes:
//   usage      → 2   (AgentAbortNeedsCtlError, AgentFreshNeedsCtlError,
//                     AgentSlashCommandUnsupportedError)
//   not found  → 3   (AgentNotFoundError)
//   conflict   → 4   (AgentExistsError, AgentNotInWorkstreamError,
//                     PaneNotInSessionError, WorkspacePreservedError,
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
// post-spawn-detect errors above: thrown BEFORE prestageWorkspace when
// the resolved `--cli` command's first token doesn't exist on PATH.
// Distinct from AgentSpawnStartupError so the operator can tell
// 'I never had a working CLI' from 'CLI started but parked at an error'.
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import type { HasNextSteps, NextStep } from "../output.js";
import { defaultSpawnLivenessMs, isExecFailureLine } from "./spawn.js";

/**
 * Pre-flight failure: the command mu would have spawned in the new
 * pane doesn't resolve to a binary on PATH (and isn't an absolute /
 * relative path that exists + is executable). Thrown by `spawnAgent`
 * BEFORE `prestageWorkspace` so a typo in `--cli` never leaves an
 * orphan workspace dir behind.
 *
 * Source: feedback ws task `fb_agent_spawn_no_validation`. Live
 * dogfood report: `mu agent spawn worker-1 --cli pi-meta` on a host
 * where the `pi-meta` binary wasn't on PATH printed `Spawned worker-1
 * (pi-meta)` and the pane immediately died with `command not found`;
 * the existing 1.5s liveness check sometimes missed it (the shell
 * stays alive after the failed exec). Pre-flighting the PATH lookup
 * surfaces the typo before any side effects (workspace, pane, DB row).
 *
 * Distinct from `AgentSpawnStartupError` (pane alive but parked at an
 * error prompt) and `AgentDiedOnSpawnError` (pane vanished within the
 * liveness window). All three carry different remediation hints, so
 * they're separate types.
 */
export class AgentSpawnCliNotFoundError extends Error implements HasNextSteps {
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
     *  to the conventional name so the nextSteps hint can recommend
     *  exporting it. */
    public readonly envVarChecked: string,
  ) {
    super(
      `--cli ${cli} resolved to binary "${binary}" which is not on PATH (and not an executable absolute/relative path). Refusing to spawn — would create a pane that dies immediately on "command not found".`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Try the default CLI (the one mu's substrate ships against)",
        command: "mu agent spawn <name> --cli pi",
      },
      {
        intent: "If you meant a custom alias, set the env var to its real path",
        command: `export ${this.envVarChecked}="<absolute-path-to-binary> [args...]"`,
      },
      {
        intent: "List installed CLIs typically supported by mu",
        command: "which pi pi-meta claude codex",
      },
    ];
  }
}

export class AgentExistsError extends Error implements HasNextSteps {
  override readonly name = "AgentExistsError";
  constructor(public readonly agentName: string) {
    // v5: agent names are UNIQUE per (workstream, name) — the same
    // name can legitimately exist in two different workstreams. The
    // pre-v5 message claimed global uniqueness, which (a) lied about
    // the schema and (b) misled operators into closing the existing
    // agent when the actual fix is `-w <other-ws>`.
    super(`agent already exists in this workstream: ${agentName}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        // v5: agents.workstream_id → workstreams.id; there is no
        // `agents.workstream` column. Use the join so this hint
        // actually runs against a v5 DB.
        intent: "List which workstream(s) already have an agent by this name",
        command: `mu sql "SELECT a.name, ws.name AS workstream FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = '${this.agentName}'"`,
      },
      {
        intent: "Spawn it in a different workstream (per-workstream unique → no clash)",
        command: `mu agent spawn ${this.agentName} -w <other-workstream>`,
      },
      {
        intent: "Or close the existing agent in this workstream and re-spawn",
        command: `mu agent close ${this.agentName}  &&  mu agent spawn ${this.agentName}`,
      },
      { intent: "Or pick a different name", command: "mu agent spawn <new-name>" },
    ];
  }
}

export class AgentNotFoundError extends Error implements HasNextSteps {
  override readonly name = "AgentNotFoundError";
  constructor(
    public readonly agentName: string,
    /** Optional workstream context. When set, the message is enriched
     *  with `(in workstream <ws>)` so the verb that hit the miss
     *  (e.g. `mu workspace path <agent> -w <ws>`) doesn't leave the
     *  operator guessing which scope was searched. Optional so existing
     *  call sites that only know the agent name keep their original
     *  one-line message. */
    public readonly workstream?: string,
  ) {
    super(
      workstream === undefined
        ? `no such agent: ${agentName}`
        : `no such agent: ${agentName} (in workstream ${workstream})`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List agents in current workstream", command: "mu agent list" },
      { intent: "List workstreams to choose the right scope", command: "mu workstream list" },
      {
        intent: "Spawn it now",
        command: `mu agent spawn ${this.agentName} -w <workstream>`,
      },
    ];
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
export class AgentNotInWorkstreamError extends Error implements HasNextSteps {
  override readonly name = "AgentNotInWorkstreamError";
  constructor(
    public readonly agentName: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`agent ${agentName} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Use the agent's actual workstream",
        command: `mu agent show ${this.agentName} -w ${this.actualWorkstream}`,
      },
      {
        intent: "List agents in the requested workstream",
        command: `mu agent list -w ${this.expectedWorkstream}`,
      },
    ];
  }
}

/**
 * `mu agent adopt` of a pane that exists but is not in the workstream's
 * mux session. Distinct from AgentNotInWorkstreamError: the subject is a
 * pane, not an agent, and its owning session is not known without
 * another mux query. Maps to exit code 4 (conflict).
 */
export class PaneNotInSessionError extends Error implements HasNextSteps {
  override readonly name = "PaneNotInSessionError";
  constructor(
    public readonly paneId: string,
    public readonly workstream: string,
    public readonly expectedSession: string,
  ) {
    super(
      `pane ${paneId} is not in session ${expectedSession}; adopt only takes panes from workstream ${workstream}'s own session`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "List the workstream's agents and orphan panes to pick one",
        command: `mu agent list -w ${this.workstream}`,
      },
      {
        intent: "Or adopt it into the workstream whose session holds the pane",
        command: `mu agent adopt ${this.paneId} -w <workstream>`,
      },
    ];
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
export class AgentDiedOnSpawnError extends Error implements HasNextSteps {
  override readonly name = "AgentDiedOnSpawnError";
  /** The spawned command is an ssh hop: remote causes, not wrapper locks. */
  readonly remote: boolean;
  constructor(
    public readonly agentName: string,
    public readonly paneId: string,
    public readonly scrollback: string | undefined,
    /** The command the pane ran; an `ssh ...` command gets remote hints. */
    public readonly command?: string,
    /** When it died; default `within <MU_SPAWN_LIVENESS_MS>ms of spawn`. */
    when = `within ${defaultSpawnLivenessMs()}ms of spawn`,
  ) {
    const tail = scrollback?.trim();
    const detail = tail ? `\n\n--- pane scrollback ---\n${tail}\n--- end scrollback ---` : "";
    const remote = /^\s*ssh\s/.test(command ?? "");
    const cause = remote
      ? 'The command is an ssh hop, so the likely causes are remote: the remote binary is missing, or its env (PATH, provider keys) is absent because ssh runs a non-interactive shell that skips ~/.zshrc / ~/.bashrc (wrap it: $SHELL -ilc "pi --approve"); or sshd refused the socket forward (ExitOnForwardFailure=yes kills the connection; check AllowStreamLocalForwarding).'
      : "Most common cause: the spawned CLI exited immediately (e.g. a wrapper CLI blocking on its instance lock; set MU_<UPPER_CLI>_COMMAND to a non-blocking variant to bypass).";
    super(`agent ${agentName} died ${when} (pane ${paneId}). ${cause}${detail}`);
    this.remote = remote;
  }
  errorNextSteps(): NextStep[] {
    if (this.remote) {
      return [
        {
          intent: "See the ssh pieces and the interactive-login-shell recipe",
          command: "mu agent remote-env --help",
        },
        {
          intent: "Check the remote binary resolves in a login shell",
          command: "ssh <host> '$SHELL -ilc \"command -v pi\"'",
        },
        {
          intent: "Keep the pane open to read the remote error (one-off)",
          command: "export MU_SPAWN_LIVENESS_MS=0",
        },
        { intent: "Run health check", command: "mu doctor" },
      ];
    }
    return [
      {
        intent: "Inspect the dead pane's scrollback for the underlying error",
        command: `mu agent read ${this.agentName} -n 100`,
      },
      {
        // agent_spawn_liveness_check_trips_on: per-spawn override is
        // the right scope for one-offs (e.g. wrapper CLIs blocking
        // on a per-project solo lock). Listed first so operators
        // reach for it before exporting an env var that leaks into
        // every subsequent spawn in the shell.
        intent: "Override per spawn (one-off; no env-var leak)",
        command: `mu agent spawn ${this.agentName} --command "<cli> <bypass-flag>"   (e.g. pi-meta --no-solo)`,
      },
      {
        intent:
          "Make the override the default for this CLI (applies to every subsequent spawn in this shell)",
        command: 'export MU_PI_COMMAND="pi-alt --some-flag"',
      },
      {
        intent: "Disable the liveness check (CI / known long-lived sh subprocess)",
        command: "export MU_SPAWN_LIVENESS_MS=0",
      },
      { intent: "Run health check", command: "mu doctor" },
    ];
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
export class AgentSpawnStartupError extends Error implements HasNextSteps {
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
      `agent ${agentName} reported a startup error ${when} (pane ${paneId}). The pane is alive but the spawned CLI parked at an error prompt instead of becoming a working agent.\n\nMatched line: ${matchedLine.trim()}\n\n--- pane scrollback ---\n${scrollback.trim()}\n--- end scrollback ---`,
    );
  }
  errorNextSteps(): NextStep[] {
    const inspect: NextStep = {
      intent: "Inspect the parked pane's scrollback for the full error",
      command: `mu agent read ${this.agentName} -n 100`,
    };
    const disable: NextStep = {
      intent:
        "Disable the startup-error scan if you actually wanted that prompt (CI / scripted recovery)",
      command: "export MU_SPAWN_LIVENESS_MS=0",
    };
    if (isExecFailureLine(this.matchedLine.trim())) {
      // A shell exec failure, not a provider error: the API-key hints
      // below would point the operator at the wrong problem.
      return [
        inspect,
        {
          intent: "Check the spawned command resolves in the pane's shell (PATH, typo)",
          command: `mu agent spawn ${this.agentName} --command "<full path to the CLI>"`,
        },
        disable,
      ];
    }
    return [
      inspect,
      {
        // Most common today: the operator picked a model whose
        // provider has no credentials in this env. Default Anthropic
        // is the safe fallback for pi-meta.
        intent: "Re-spawn with a CLI command whose provider credentials are present",
        command: `mu agent spawn ${this.agentName} --command "pi-meta --no-solo"   # default Anthropic`,
      },
      {
        intent: "Or set the missing API key env var for the provider you wanted, then re-spawn",
        command:
          "export ANTHROPIC_API_KEY=...   # or AWS_BEARER_TOKEN_BEDROCK, OPENAI_API_KEY, ...",
      },
      disable,
    ];
  }
}

/**
 * Thrown when `closeAgent` is called on an agent that has an associated
 * workspace AND the caller didn't explicitly opt into discarding it.
 *
 * Background: the FK on `vcs_workspaces.agent` cascades on agent
 * delete, so a naive `closeAgent` drops the workspace registry row
 * but leaves the on-disk dir orphaned (mu can't see it via
 * `mu workspace list / free / path` afterwards). Surfaced during
 * the multi-agent dogfood teardown when three workspaces went
 * orphaned silently.
 *
 * The fix: refuse close if a workspace exists; force the caller to
 * decide. Two actionable resolutions:
 *   - `mu workspace free <agent>` first, then close cleanly.
 *   - `mu agent close <agent> --discard-workspace` to free the
 *     workspace AND close the agent in one shot (lossy: pending
 *     changes in the workspace are gone).
 *
 * Maps to exit code 4 (conflict) via the cli.ts handler.
 */
export class WorkspacePreservedError extends Error implements HasNextSteps {
  override readonly name = "WorkspacePreservedError";
  constructor(
    public readonly agentName: string,
    public readonly workspacePath: string,
  ) {
    super(
      `agent ${agentName} has a workspace at ${workspacePath}; refusing to close (would orphan the on-disk dir)`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Free the workspace first (preserves agent for next step)",
        command: `mu workspace free ${this.agentName}  (--commit to commit pending changes first)`,
      },
      {
        intent: "Or close + discard the workspace in one shot (lossy)",
        command: `mu agent close ${this.agentName} --discard-workspace`,
      },
      {
        intent: "Or just inspect what's in the workspace",
        command: `cd ${this.workspacePath}`,
      },
    ];
  }
}

/**
 * The agent's pane and pi are up, but nothing answers on its control
 * socket (`MU_CTL_SOCK`): the mu pi extension is not loaded, or, for a
 * remote agent, the ssh command lacks the `-L` forward. Spawn does not
 * throw it — the agent is usable by hand — but prints it as a warning;
 * verbs that need the socket throw it.
 */
export class AgentCtlUnreachableError extends Error implements HasNextSteps {
  override readonly name = "AgentCtlUnreachableError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly socket: string,
    public readonly kind: "missing" | "refused",
  ) {
    super(
      `agent ${agentName} has no control socket (ctl: ${kind}) at ${socket}; mu cannot send to or wait on it exactly`,
    );
  }
  errorNextSteps(): NextStep[] {
    // A pi at its trust prompt has not bound the socket yet, so it reads
    // "missing"; a "refused" socket exists, so trust is not the cause.
    const trust: NextStep[] =
      this.kind === "missing"
        ? [
            {
              intent:
                "Just spawned? pi may sit at its project trust prompt: answer /trust in the pane, or respawn with --command 'pi --approve'",
              command: `mu agent read ${this.agentName} -w ${this.workstream}`,
            },
          ]
        : [];
    return [
      ...trust,
      { intent: "Check whether the mu pi extension is linked", command: "mu doctor" },
      {
        intent: "Stop a runaway tool without the socket",
        command: `mu agent kick ${this.agentName} -w ${this.workstream}`,
      },
      { intent: "Link the extension, then re-spawn", command: "mu link pi" },
      {
        intent: "Remote agent: forward the socket in your ssh command",
        command: `ssh -L ${this.socket}:<remote sock> ...   (see mu agent remote-env)`,
      },
    ];
  }
}

/**
 * `mu agent abort` on an agent that does not run pi: there is no control
 * socket to carry the abort, and mu does not silently signal the pane.
 */
export class AgentAbortNeedsCtlError extends Error implements HasNextSteps {
  override readonly name = "AgentAbortNeedsCtlError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly cli: string,
  ) {
    super(
      `agent ${agentName} runs ${cli}, not pi: abort needs the mu pi extension; use mu agent kick`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Signal the pane's foreground process instead",
        command: `mu agent kick ${this.agentName} -w ${this.workstream}`,
      },
    ];
  }
}

/** The abort was delivered but pi did not settle within the timeout. */
export class AgentAbortTimeoutError extends Error implements HasNextSteps {
  override readonly name = "AgentAbortTimeoutError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly timeoutMs: number,
  ) {
    super(`agent ${agentName} was still busy ${timeoutMs}ms after the abort`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Signal the pane's foreground process group",
        command: `mu agent kick ${this.agentName} -w ${this.workstream}`,
      },
      {
        intent: "Read the pane to see what it is stuck on",
        command: `mu agent read ${this.agentName} -n 30 -w ${this.workstream}`,
      },
    ];
  }
}

/**
 * `mu agent send --fresh` on an agent without a control socket (non-pi
 * CLI, or forced `--via mux`): there is no one-operation new session.
 */
export class AgentFreshNeedsCtlError extends Error implements HasNextSteps {
  override readonly name = "AgentFreshNeedsCtlError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly cli: string,
  ) {
    super(
      `agent ${agentName} runs ${cli} without a control socket: --fresh needs the mu pi extension`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Reset the session through the pane, then send (verify it landed)",
        command: `mu agent send ${this.agentName} '/new' -w ${this.workstream}`,
      },
    ];
  }
}

/**
 * The agent's pi serves the control socket with an extension it loaded
 * before mu learned `op` (e.g. `fresh`): running pi processes keep the
 * extension code they started with. pi's `/reload` re-imports the
 * extension through the `mu link pi` shim and keeps the socket; a
 * respawn always works. An extension that serves op `command` takes
 * `/reload` over ctl; an older one needs it typed (`--via mux`).
 */
export class AgentExtensionOutdatedError extends Error implements HasNextSteps {
  override readonly name = "AgentExtensionOutdatedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly op: string,
    public readonly extVersion?: string,
    /** Ops the extension serves (from its "unknown op" reply); absent from old extensions. */
    public readonly ops?: readonly string[],
  ) {
    super(
      `agent ${agentName}'s mu pi extension (${extVersion ?? "version unknown"}) predates op ${op}: its pi loaded an older mu build; reload or respawn it`,
    );
  }
  errorNextSteps(): NextStep[] {
    const w = `-w ${this.workstream}`;
    // An extension that serves op command runs /reload over ctl itself;
    // an older one only reloads when /reload is typed into the pane.
    const via = this.ops?.includes("command") ? "" : " --via mux";
    return [
      {
        intent: "Reload pi's extensions (keeps the session and context)",
        command: `mu agent send ${this.agentName} '/reload'${via} ${w}`,
      },
      {
        intent: "Or respawn the agent (loses its context)",
        command: `mu agent close ${this.agentName} ${w} && mu agent spawn ${this.agentName} ${w} ...`,
      },
    ];
  }
}

/**
 * `send --fresh` or a session command (`/new`, `/reload`, `/compact`)
 * refused: pi is mid-turn, and running it would abandon the turn.
 */
export class AgentBusyError extends Error implements HasNextSteps {
  override readonly name = "AgentBusyError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    /** The session command refused, e.g. "/new". Absent: `--fresh`. */
    public readonly command?: string,
  ) {
    super(`agent ${agentName} is busy: ${command ?? "--fresh"} would abandon its running turn`);
  }
  errorNextSteps(): NextStep[] {
    const retry =
      this.command === undefined
        ? `mu agent send ${this.agentName} --fresh --force '...' -w ${this.workstream}`
        : `mu agent send ${this.agentName} '${this.command}' --force -w ${this.workstream}`;
    return [
      {
        intent: "Stop the turn first, then retry",
        command: `mu agent abort ${this.agentName} -w ${this.workstream}`,
      },
      { intent: "Or abandon the turn in one step", command: retry },
    ];
  }
}

/**
 * A slash command other than `/new`, `/reload`, `/compact` sent to a pi
 * agent. The control socket cannot run it (pi.sendUserMessage would
 * hand it to the model as text), and mu does not silently paste into a
 * pi pane: `--via mux` is the explicit way to type it there.
 */
export class AgentSlashCommandUnsupportedError extends Error implements HasNextSteps {
  override readonly name = "AgentSlashCommandUnsupportedError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly text: string,
    public readonly supported: readonly string[],
  ) {
    super(
      `agent ${agentName} runs pi: over the control socket mu runs only ${supported.join(", ")}; ${JSON.stringify(text.split("\n")[0])} is not one of them. Pass --via mux to type it into the pane`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Type it into the pane on purpose (tmux paste; unconfirmed)",
        command: `mu agent send ${this.agentName} '${this.text.split("\n")[0]}' --via mux -w ${this.workstream}`,
      },
    ];
  }
}
