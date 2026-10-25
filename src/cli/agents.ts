// mu — every `mu agent ...` verb + spawn / send / read / list / show /
// close + the top-level `mu me` agent-self
// verb (default + `tasks` / `next` subcommands).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.
//
// `whoami` / `my-tasks` / `my-next` were merged into `mu me` /
// `mu me tasks` / `mu me next` in audit_merge_self_verbs_into_mu_me
// (audit_cleanups_post_schema_v5_wave). The three old verbs are
// gone; the three cmd functions (`cmdMe`, `cmdMyTasks`, `cmdMyNext`)
// stayed (with `cmdMe` formerly `cmdWhoami`).

import { dirname } from "node:path";
import {
  agentToOutput,
  closePreviewToOutput,
  liveAgentToOutput,
  workstreamIdOf,
} from "../agent-output.js";
import { agentKey, blockedReason, ctlRuntimeState, readAgentStates } from "../agent-state.js";
import {
  AgentCtlUnreachableError,
  AgentNotFoundError,
  AgentRestartedError,
  AgentSendIndeterminateError,
  type AgentStatusSnapshot,
  type AgentWatch,
  abortAgent,
  agentCtlSocket,
  type ClosePreview,
  checkMessage,
  closeAgent,
  delegateOutcome,
  expectsCtl,
  getAgent,
  interruptAgent,
  isSlashCommand,
  listLiveAgents,
  parseSessionCommand,
  previewClose,
  readAgent,
  requireFeature,
  resolveCliCommand,
  resolveCliCommandWithSource,
  respawnCommand,
  type SpawnedAgent,
  sendToAgent,
  spawnAgent,
  spawnForTask,
  type Transport,
  waitForAgents,
} from "../agents.js";
import {
  applyQualifiedRef,
  assertAgentInWorkstream,
  CliExitError,
  classifyError,
  emitJson,
  formatAgentsTable,
  formatTaskListTable,
  resolveEntityRef,
  resolveSelf,
  resolveWorkstream,
  statusIcon,
  UsageError,
} from "../cli.js";
import { ctlProbe, ctlRequest } from "../ctl/client.js";
import { type CtlBlocked, INCARNATION_MISMATCH } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { activeMux, attachShellLine, type SendWarning } from "../mux.js";
import { type NextStep, pc, printNextSteps, printNextStepsTo } from "../output.js";
import { listTasksByOwner } from "../tasks.js";
import { dispatchHint, waitHint } from "./dispatch-hints.js";
import { readStdinText, STDIN_ARG } from "./stdin.js";

interface SpawnOpts {
  cli?: string;
  command?: string;
  tab?: string;
  role?: string;
  cwd?: string;
  workstream?: string;
  worktree?: boolean;
  from?: string;
  root?: string;
  /** commander's `--no-ctl` negation: false skips the ctl handshake. */
  ctl?: boolean;
  /** Take the next free name when `<name>` is taken. */
  nextFree?: boolean;
  /** Run on this host profile (`mu host add`): the pane runs its shell template. */
  host?: string;
  /** Send this text once the agent is up (`-` reads stdin). */
  send?: string;
  /** Bind the spawn to this task: claim it for the new agent and send the text as its brief (needs `--send`). */
  task?: string;
  /** With `--task`: the attempt's name (default: the task id). Replays of a name never send twice. */
  attempt?: string;
  json?: boolean;
}
// --from / --root only mean something with --worktree; refuse a stray one
// before any side effect rather than silently ignoring it.
function assertWorktreeFlags(opts: SpawnOpts): void {
  if (opts.worktree) {
    if (opts.cwd !== undefined) {
      throw new UsageError("--cwd conflicts with --worktree (the worktree is the cwd)");
    }
    return;
  }
  for (const flag of ["from", "root"] as const) {
    if (opts[flag] !== undefined) throw new UsageError(`--${flag} requires --worktree`);
  }
}

export async function cmdSpawn(db: Db, rawName: string, opts: SpawnOpts): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // Read stdin before any side effect: an empty pipe must not leave a pane.
  const sendText =
    opts.send === undefined
      ? undefined
      : opts.send === STDIN_ARG
        ? await readStdinText("send text")
        : opts.send;

  assertWorktreeFlags(opts);
  if (opts.attempt !== undefined && opts.task === undefined) {
    throw new UsageError("--attempt needs --task");
  }
  if (opts.task !== undefined) {
    if (sendText === undefined) {
      throw new UsageError("--task needs --send: the sent text is the task's brief");
    }
    return cmdSpawnTask(db, rawName, workstream, opts.task, sendText, opts);
  }

  const agent = await spawnAgent(db, {
    name: rawName,
    workstream,
    ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.worktree === true ? { worktree: true } : {}),
    ...(opts.from !== undefined ? { from: opts.from } : {}),
    ...(opts.root !== undefined ? { root: opts.root } : {}),
    ...(opts.ctl === false ? { ctl: false } : {}),
    ...(opts.nextFree === true ? { nextFree: true } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
  });
  // --next-free may have picked another name than the one asked for.
  const name = agent.name;
  // A pi agent whose control socket never answered still spawned (the
  // pane is usable by hand), but say so loudly on stderr: every exact
  // send / wait on it will fail until the extension answers.
  // Under --json the warnings ride in the one document (`warnings`), never stderr.
  const warnings: string[] = [];
  if (agent.ctl === "missing" || agent.ctl === "refused") {
    const warn = new AgentCtlUnreachableError(
      name,
      workstream,
      agent.ctlSocket,
      agent.ctl,
      agent.host,
    );
    warnings.push(warn.message);
    if (!opts.json) {
      console.error(pc.yellow(`warning: ${warn.message}`));
      printNextStepsTo(warn.errorNextSteps(), "stderr");
    }
  }
  // Claude parks at a trust dialog whose default is "No, exit": the Enter
  // that ends a send would quit it. Keep the pane, skip the send, say why.
  const trustSkip = agent.trustDialog === true && sendText !== undefined;
  if (agent.trustDialog === true) {
    const trustWarning = `${name} is showing Claude's folder-trust dialog (default "No, exit")${trustSkip ? "; --send skipped" : ""}`;
    warnings.push(trustWarning);
    if (!opts.json) console.error(pc.yellow(`warning: ${trustWarning}`));
  }
  const trustNext: NextStep[] =
    agent.trustDialog === true
      ? [
          {
            intent: "Answer the trust dialog by hand (attach the pane), then send",
            command: `mu agent send ${name} <text> -w ${workstream}`,
          },
        ]
      : [];
  const sent: SpawnSend | undefined = trustSkip
    ? {
        ok: false,
        error: "TrustDialogPending",
        message: "send skipped: Claude's folder-trust dialog is waiting in the pane",
        exitCode: 0,
      }
    : sendText === undefined
      ? undefined
      : await spawnSend(db, agent, sendText);
  // Resolve the actual command that landed in the pane, so the operator
  // can confirm `--command 'pi-meta --no-solo'` (etc.) took effect.
  // Mirrors the resolution chain in spawnAgent: explicit --command >
  // $MU_<UPPER_CLI>_COMMAND > the cli value itself. Surfaced from
  // mufeedback note #159: 'Spawned ... (pi)' was misleading when
  // --command overrode the binary.
  const resolvedCommand = opts.command ?? resolveCliCommand(agent.cli);
  const commandOverridden = resolvedCommand !== agent.cli;
  // fb_agent_spawn_no_validation part C: when the override came from
  // an env var (no explicit --command), surface the env-var name in
  // the success line so config issues ("Spawned ... (pi-meta)" but I
  // never set $MU_PI_META_COMMAND — wait, I did, and it's stale")
  // are visible without `mu agent show`. Explicit --command takes
  // priority and is shown via the existing `(cmd: ...)` suffix below.
  const envSourced =
    opts.command === undefined ? resolveCliCommandWithSource(agent.cli) : undefined;
  const nextSteps: NextStep[] = [
    ...trustNext,
    // After --send the next step is the wait (or the pane read below).
    ...(!sent?.ok
      ? [dispatchHint(agent)]
      : sent.runs !== undefined
        ? [waitHint({ name, workstreamName: workstream }, sent.runs, sent.incarnation, sent.msgId)]
        : []),
    { intent: "Read pane", command: `mu agent read ${name} -w ${workstream}` },
    { intent: "Watch live events", command: `mu log -w ${workstream} --tail` },
    {
      intent: "Preview closing it (prints the --if apply that kills the pane)",
      command: `mu agent close ${name} -w ${workstream}`,
    },
  ];
  // Best-effort: the pane exists, so a mux is up; the hint is decoration.
  try {
    const mux = await activeMux();
    const steps = await mux.attachCommands({
      session: `mu-${workstream}`,
      window: agent.tab ?? name,
      inside: Boolean(process.env.TMUX),
    });
    nextSteps.push({ intent: "Attach the pane", command: attachShellLine(steps) });
  } catch {
    // no hint
  }
  if (opts.json) {
    const payload = {
      agent: agentToOutput(agent, workstreamIdOf(db, workstream), {
        ctl: agent.ctl,
        ctlSocket: agent.ctlSocket,
        ...(agent.trustDialog === true ? { trustDialog: true } : {}),
      }),
      resolvedCommand,
      commandOverridden,
      // env-var attribution for machine consumers: present iff the
      // resolution came from $MU_<UPPER_CLI>_COMMAND. Mirrors the
      // human `(via $MU_PI_META_COMMAND)` suffix below.
      ...(envSourced?.resolvedFromEnv ? { resolvedFromEnvVar: envSourced.envVar } : {}),
      ctl: agent.ctl,
      ctlSocket: agent.ctlSocket,
      ...(sent !== undefined ? { send: sent } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      nextSteps,
    };
    // A failed --send is ONE failure document: the spawn evidence (the pane is
    // up) rides in `data` with the nested `send.ok:false`, and the delivery
    // receipt (msgId / incarnation / delivery) stays structured beside it.
    if (sent !== undefined && !sent.ok && sent.exitCode !== 0) {
      throw new CliExitError(sent.exitCode, {
        error: sent.error,
        message: sent.message,
        data: payload,
        extra: {
          ...(sent.msgId !== undefined ? { msgId: sent.msgId } : {}),
          ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
          ...(sent.delivery !== undefined ? { delivery: sent.delivery } : {}),
        },
      });
    }
    emitJson(payload);
    return;
  }
  const wsBit = opts.worktree ? pc.dim(" with its own worktree") : "";
  // Three display modes (precedence top-down):
  //   1. --command was explicit       → 'pi (cmd: pi-meta --no-solo)'
  //   2. resolved via env var override → 'pi (via $MU_PI_COMMAND)'
  //   3. bare CLI name on PATH         → 'pi'
  // Env-var attribution is preferred over the generic '(cmd: ...)'
  // suffix because the env-var name is the actionable knob the
  // operator can grep for / unset (fb_agent_spawn_no_validation pt C).
  const cliDisplay =
    opts.command !== undefined
      ? `${agent.cli} ${pc.dim(`(cmd: ${resolvedCommand})`)}`
      : envSourced?.resolvedFromEnv
        ? `${agent.cli} ${pc.dim(`(via $${envSourced.envVar})`)}`
        : agent.cli;
  console.log(
    `Spawned ${pc.bold(agent.name)} (${cliDisplay}) in window ${pc.bold(agent.tab ?? agent.name)} of ${pc.bold(`mu-${workstream}`)}, pane ${pc.dim(agent.paneId)}${wsBit}`,
  );
  if (agent.cwd !== null) console.log(pc.dim(`  cwd: ${agent.cwd}`));
  console.log(pc.dim(`  ctl: ${agent.ctl} (${agent.ctlSocket})`));
  if (sent?.ok) {
    const runs = sent.runs !== undefined ? `, runs ${sent.runs}` : "";
    console.log(pc.dim(`  sent ${sent.sentBytes} bytes (via ${sent.transport}${runs})`));
  } else if (sent !== undefined) {
    console.error(
      sent.exitCode === 0
        ? pc.yellow(`warning: ${sent.message}`)
        : pc.red(`error: --send failed: ${sent.message}`),
    );
  }
  printNextSteps(nextSteps);
  if (sent !== undefined && !sent.ok && sent.exitCode !== 0) throw new CliExitError(sent.exitCode);
}

/**
 * `mu agent spawn --task <id> --send <text>`: spawn, claim the task for the
 * new agent and send the brief as ONE journaled attempt (spawnForTask). A
 * delivered attempt (now or by an earlier run) prints the same spawn record
 * as a plain `--send`; an UNKNOWN one exits 1 with the receipt, never a
 * resend. An unsent failure rolls back its own resources and rethrows.
 */
async function cmdSpawnTask(
  db: Db,
  name: string,
  workstream: string,
  task: string,
  text: string,
  opts: SpawnOpts,
): Promise<void> {
  const out = await spawnForTask(db, {
    task,
    text,
    ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {}),
    spawn: {
      name,
      workstream,
      ...(opts.cli !== undefined ? { cli: opts.cli } : {}),
      ...(opts.command !== undefined ? { command: opts.command } : {}),
      ...(opts.tab !== undefined ? { tab: opts.tab } : {}),
      ...(opts.role !== undefined ? { role: opts.role } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.worktree === true ? { worktree: true } : {}),
      ...(opts.from !== undefined ? { from: opts.from } : {}),
      ...(opts.root !== undefined ? { root: opts.root } : {}),
      ...(opts.ctl === false ? { ctl: false } : {}),
      ...(opts.nextFree === true ? { nextFree: true } : {}),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
    },
  });
  const rec = out.receipt;
  const agentName = out.agent?.name ?? rec.name;
  const fresh = out.agent !== undefined && "ctl" in out.agent ? out.agent : undefined;
  const sent: SpawnSend =
    out.state === "sent"
      ? {
          ok: true,
          sentBytes: Buffer.byteLength(text),
          transport: rec.transport ?? "ctl",
          ...(out.send?.state !== undefined ? { state: out.send.state } : {}),
          ...(rec.runs !== null ? { runs: rec.runs } : {}),
          msgId: rec.msgId,
          ...(rec.incarnation !== null ? { incarnation: rec.incarnation } : {}),
          delivery: "delivered",
          ...(out.send?.sessionFile !== undefined ? { sessionFile: out.send.sessionFile } : {}),
          delivered: true,
        }
      : {
          ok: false,
          error: "AgentSendIndeterminateError",
          message: out.reason ?? "delivery unknown",
          exitCode: 1,
          msgId: rec.msgId,
          ...(rec.incarnation !== null ? { incarnation: rec.incarnation } : {}),
          delivery: "unknown",
        };
  const nextSteps: NextStep[] = [];
  if (out.state === "sent" && rec.runs !== null && out.stale === undefined) {
    nextSteps.push(
      waitHint(
        { name: agentName, workstreamName: workstream },
        rec.runs,
        rec.incarnation ?? undefined,
        rec.msgId,
      ),
    );
  } else if (out.state === "unknown" && rec.transport === "ctl" && out.stale === undefined) {
    nextSteps.push({
      intent: "Ask whether it landed (a receipt check; never resend first)",
      command: `mu agent check ${agentName} ${rec.msgId} -w ${workstream}`,
    });
  }
  nextSteps.push({ intent: "Read pane", command: `mu agent read ${agentName} -w ${workstream}` });
  const taskInfo = {
    id: task,
    attempt: rec.attemptKey,
    state: rec.state,
    replay: out.replay,
    brief: out.brief,
    claimed: rec.state !== "reserved" && rec.state !== "pane" && rec.state !== "failed",
    ...(out.stale !== undefined ? { stale: out.stale } : {}),
    ...(out.checked !== undefined ? { checked: out.checked } : {}),
  };
  if (opts.json) {
    const payload = {
      ...(out.agent !== undefined
        ? {
            agent: agentToOutput(out.agent, workstreamIdOf(db, workstream), {
              ...(fresh !== undefined
                ? {
                    ctl: fresh.ctl,
                    ctlSocket: fresh.ctlSocket,
                    ...(fresh.trustDialog === true ? { trustDialog: true } : {}),
                  }
                : {}),
            }),
          }
        : {}),
      ...(fresh !== undefined ? { ctl: fresh.ctl, ctlSocket: fresh.ctlSocket } : {}),
      send: sent,
      task: taskInfo,
      delivery: sent.delivery,
      msgId: rec.msgId,
      nextSteps,
    };
    if (!sent.ok) {
      throw new CliExitError(1, {
        error: sent.error,
        message: sent.message,
        data: payload,
        extra: {
          msgId: rec.msgId,
          ...(rec.incarnation !== null ? { incarnation: rec.incarnation } : {}),
          delivery: "unknown",
        },
      });
    }
    emitJson(payload);
    return;
  }
  const verb = out.replay ? "Replayed" : "Spawned";
  console.log(
    `${verb} ${pc.bold(agentName)} for ${pc.bold(task)} (${rec.attemptKey}): ${
      out.state === "sent" ? "prompt delivered" : pc.yellow("delivery UNKNOWN; never resent")
    }`,
  );
  if (out.stale !== undefined) {
    console.log(
      pc.yellow(`  the agent of this attempt is ${out.stale}; the replacement was left alone`),
    );
  }
  if (out.state === "unknown") {
    console.error(pc.yellow(`warning: ${out.reason ?? "delivery unknown"}`));
  }
  if (out.brief === "pending")
    console.log(pc.dim("  brief not recorded yet; a replay records it once delivery is confirmed"));
  printNextSteps(nextSteps);
  if (out.state === "unknown") throw new CliExitError(1);
}

/** `mu agent spawn --send`: the outcome of the send, as `--json` reports it. */
type SpawnSend =
  | {
      ok: true;
      sentBytes: number;
      transport: Transport;
      state?: string;
      runs?: number;
      /** The send's receipt id (`mu agent check`) and pi's incarnation (`wait --inc`). */
      msgId?: string;
      incarnation?: string;
      delivery?: "delivered";
      /** pi's session file, where the delegate's transcript is written. */
      sessionFile?: string;
      delivered: boolean;
    }
  | {
      ok: false;
      error: string;
      message: string;
      exitCode: number;
      msgId?: string;
      incarnation?: string;
      delivery?: "unknown";
    };

/**
 * Send the first prompt to a just-spawned agent, so a caller that would
 * run spawn then send pays one mu process instead of two. The pane stays
 * up when the send fails: the spawn succeeded, and the caller decides.
 * A pi whose control socket never answered is not sent to (the send
 * could not be confirmed).
 */
async function spawnSend(db: Db, agent: SpawnedAgent, text: string): Promise<SpawnSend> {
  const fail = (err: unknown): SpawnSend => ({
    ok: false,
    error: err instanceof Error ? err.name : "Error",
    message: err instanceof Error ? err.message : String(err),
    exitCode: classifyError(err).exitCode,
    // A delivery-unknown send names its receipt: `mu agent check <agent> <msgId>`.
    ...(err instanceof AgentSendIndeterminateError && err.msgId !== undefined
      ? {
          msgId: err.msgId,
          delivery: "unknown" as const,
          ...(err.incarnation !== undefined ? { incarnation: err.incarnation } : {}),
        }
      : {}),
  });
  if (agent.ctl === "missing" || agent.ctl === "refused")
    return fail(
      new AgentCtlUnreachableError(
        agent.name,
        agent.workstreamName,
        agent.ctlSocket,
        agent.ctl,
        agent.host,
      ),
    );
  let undelivered = false;
  try {
    const sent = await sendToAgent(db, agent.name, text, {
      workstream: agent.workstreamName,
      expect: { incarnation: agent.incarnation, paneId: agent.paneId },
      // Bound to the pi the spawn handshake saw: a replacement bound at the same socket path is refused.
      ...(agent.ctlIncarnation !== undefined ? { expectIncarnation: agent.ctlIncarnation } : {}),
      onUndelivered: () => {
        undelivered = true;
      },
    });
    return {
      ok: true,
      sentBytes: Buffer.byteLength(text),
      transport: sent.transport,
      ...(sent.state !== undefined ? { state: sent.state } : {}),
      ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
      ...(sent.msgId !== undefined ? { msgId: sent.msgId, delivery: "delivered" as const } : {}),
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
      ...(sent.sessionFile !== undefined ? { sessionFile: sent.sessionFile } : {}),
      delivered: !undelivered,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function cmdSend(
  db: Db,
  rawName: string,
  rawText: string,
  opts: {
    workstream?: string;
    json?: boolean;
    steer?: boolean;
    fresh?: boolean;
    force?: boolean;
    interrupt?: boolean;
    timeout?: number;
  } = {},
): Promise<void> {
  const text = rawText === STDIN_ARG ? await readStdinText("send text") : rawText;
  if (opts.interrupt) {
    for (const [on, flag] of [
      [opts.fresh, "--fresh"],
      [opts.steer, "--steer"],
      [opts.force, "--force"],
    ] as const) {
      if (on) throw new UsageError(`--interrupt and ${flag} are mutually exclusive`);
    }
    if (isSlashCommand(text)) {
      throw new UsageError("--interrupt sends a prompt, not a slash command");
    }
    // Refuse before the abort: an empty prompt would kill the running turn
    // and then send nothing.
    if (text === "") throw new UsageError("--interrupt needs a non-empty prompt");
  } else if (opts.timeout !== undefined) {
    throw new UsageError("--timeout only applies with --interrupt");
  }
  if (opts.force && !opts.fresh && parseSessionCommand(text) === undefined) {
    throw new UsageError("--force only applies with --fresh or a /new, /reload, /compact");
  }
  if (opts.fresh && opts.steer) throw new UsageError("--fresh and --steer are mutually exclusive");
  if (opts.interrupt) return cmdSendInterrupt(db, rawName, text, opts);
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // dogfood_send_after_new_dropped: capture the undelivered warning
  // rather than letting it print raw, so it lands in the JSON payload
  // too. `exit 0` must not be able to mean "silently dropped".
  let undelivered: SendWarning | undefined;
  const sent = await sendToAgent(db, name, text, {
    workstream: ws,
    ...(opts.steer ? { mode: "steer" as const } : {}),
    ...(opts.fresh ? { fresh: true } : {}),
    ...(opts.force ? { force: true } : {}),
    onUndelivered: (w) => {
      undelivered = w;
    },
  });
  // ONE next hint. A ctl reply with runs gives the exact wait baseline: the
  // wait returns the run's final text, so no pane read is needed.
  const nextSteps: NextStep[] = [
    sent.transport === "ctl" && sent.runs !== undefined
      ? waitHint({ name, workstreamName: ws }, sent.runs, sent.incarnation, sent.msgId)
      : { intent: "Read response", command: `mu agent read ${name} -n 50 -w ${ws}` },
  ];
  if (undelivered !== undefined) {
    nextSteps.unshift({
      intent: "VERIFY the prompt landed before waiting on it",
      command: `mu agent read ${name} -n 30 -w ${ws}`,
    });
  }
  if (opts.json) {
    emitJson({
      agentName: name,
      sentBytes: Buffer.byteLength(text),
      transport: sent.transport,
      fresh: opts.fresh === true,
      ...(sent.command !== undefined ? { command: sent.command } : {}),
      ...(sent.state !== undefined ? { state: sent.state } : {}),
      ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
      ...(sent.msgId !== undefined ? { msgId: sent.msgId, delivery: "delivered" } : {}),
      ...(sent.receipt !== undefined ? { receipt: sent.receipt } : {}),
      delivered: undelivered === undefined,
      ...(undelivered !== undefined
        ? { undelivered: { reason: undelivered.reason, message: undelivered.message } }
        : {}),
      nextSteps,
    });
    return;
  }
  if (undelivered !== undefined) {
    console.error(pc.yellow(`warning: ${undelivered.message}`));
  } else {
    const how =
      sent.transport === "mux"
        ? "via mux"
        : opts.fresh
          ? "via ctl, fresh session"
          : sent.command !== undefined
            ? `via ctl, pi ran /${sent.command}`
            : sent.runs !== undefined
              ? `via ctl, pi was ${sent.state ?? "?"}, runs ${sent.runs}`
              : `via ctl, pi ${sent.state ?? "?"}`;
    const receipt =
      sent.receipt === undefined ? "" : "; no reply, but its receipt confirms it landed";
    console.log(pc.dim(`sent ${Buffer.byteLength(text)} bytes to ${name} (${how}${receipt})`));
  }
  printNextSteps(nextSteps);
}

/** `mu agent send --interrupt`: abort a busy pi, wait for settle, send. */
async function cmdSendInterrupt(
  db: Db,
  rawName: string,
  text: string,
  opts: { workstream?: string; json?: boolean; timeout?: number },
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = await interruptAgent(db, name, text, {
    workstream: ws,
    ...(opts.timeout === undefined ? {} : { timeoutMs: Math.round(opts.timeout * 1000) }),
  });
  const nextSteps: NextStep[] = [
    r.runs !== undefined
      ? waitHint({ name, workstreamName: ws }, r.runs, r.incarnation, r.msgId)
      : { intent: "Read response", command: `mu agent read ${name} -n 50 -w ${ws}` },
  ];
  if (r.pending) {
    nextSteps.push({
      intent: "Queued messages went back to the pane's editor unsent: read them there",
      command: `mu agent read ${name} -n 30 -w ${ws}`,
    });
  }
  if (opts.json) {
    emitJson({
      agentName: name,
      sentBytes: Buffer.byteLength(text),
      transport: "ctl",
      interrupt: true,
      ...r,
      ...(r.msgId !== undefined ? { delivery: "delivered" } : {}),
      nextSteps,
    });
    return;
  }
  const what = r.wasBusy ? "interrupted a busy run" : "pi was idle";
  const runs = r.runs !== undefined ? `, runs ${r.runs}` : "";
  const receipt = r.receipt === undefined ? "" : "; no reply, but its receipt confirms it landed";
  console.log(
    pc.dim(`sent ${Buffer.byteLength(text)} bytes to ${name} (via ctl, ${what}${runs}${receipt})`),
  );
  if (r.pending) console.log(pc.yellow("queued messages went back to the pane's editor unsent"));
  printNextSteps(nextSteps);
}

/** Lines in captured scrollback: a final newline ends the last line, it
 *  does not start an empty one, and empty text has none. `scrollbackLines`
 *  in `agent read --json` and `agent show --json` both mean this. */
function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function cmdRead(
  db: Db,
  rawName: string,
  opts: { lines?: number; workstream?: string; json?: boolean },
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const text = await readAgent(db, name, {
    workstream: ws,
    ...(opts.lines !== undefined ? { lines: opts.lines } : {}),
  });
  if (opts.json) {
    emitJson({
      agentName: name,
      lines: opts.lines ?? null,
      scrollback: text,
      scrollbackLines: countLines(text),
    });
    return;
  }
  process.stdout.write(text);
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

export async function cmdList(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const view = await listLiveAgents(db, { workstream });
  if (opts.json) {
    const wsId = workstreamIdOf(db, workstream);
    emitJson({
      workstreamName: workstream,
      agents: view.agents.map((a) => liveAgentToOutput(a, wsId)),
      orphans: view.orphans,
    });
    return;
  }
  console.log(pc.bold(`mu-${workstream}`));
  console.log(formatAgentsTable(view.agents));
  if (view.orphans.length > 0) {
    console.log("");
    console.log(pc.yellow(`Orphan panes (${view.orphans.length})`));
    console.log(pc.dim("  Panes that look like agents but aren't in the registry."));
    console.log(pc.dim("  Kill one with tmux/herdr or ignore it."));
    for (const orphan of view.orphans) {
      console.log(`  ${pc.dim(orphan.paneId)} cli=${orphan.command}`);
    }
  }
}

export async function cmdAgentShow(
  db: Db,
  rawName: string,
  opts: { lines?: number; json?: boolean; workstream?: string },
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  // v5: agents.name is per-workstream unique. Resolve the operator's
  // workstream up front so the lookup scopes correctly.
  const ws = await resolveWorkstream(opts.workstream);
  const agent = getAgent(db, name, ws);
  if (!agent) throw new AgentNotFoundError(name);
  const lines = opts.lines ?? 20;
  let scrollback: string;
  try {
    // Best-effort: `mu agent show` still has a registry row to print
    // when the mux is unreachable. Empty scrollback degrades the
    // status refresh below, it doesn't fail the verb.
    scrollback = await (await activeMux()).capture(agent.paneId, { lines });
  } catch {
    scrollback = "";
  }

  const reading = (await readAgentStates([agent], { stateDir: dirname(db.name) })).get(
    agentKey(agent),
  );
  const displayed = {
    ...agent,
    state: reading?.state ?? ("unknown" as const),
    source: reading?.source ?? ("none" as const),
    ctl: reading?.ctl ?? ("n/a" as const),
    since:
      reading?.since === null || reading?.since === undefined
        ? null
        : new Date(reading.since).toISOString(),
    ...(reading?.reason !== undefined ? { reason: reading.reason } : {}),
  };

  if (opts.json) {
    emitJson({
      agent: liveAgentToOutput(displayed, workstreamIdOf(db, agent.workstreamName)),
      scrollback,
      scrollbackLines: countLines(scrollback),
    });
    return;
  }

  console.log(pc.bold(`${displayed.name}  ${statusIcon(displayed.state)} ${displayed.state}`));
  console.log(`  workstream : ${agent.workstreamName}`);
  console.log(`  cli        : ${agent.cli}`);
  console.log(`  pane       : ${pc.dim(agent.paneId)}`);
  console.log(`  window     : ${agent.tab ?? agent.name}`);
  console.log(`  role       : ${agent.role}`);
  if (agent.host !== null) console.log(`  host       : ${agent.host}`);
  console.log(`  cwd        : ${agent.cwd ?? pc.dim("—")}`);
  console.log(`  created    : ${pc.dim(agent.createdAt)}`);
  console.log(`  updated    : ${pc.dim(agent.updatedAt)}`);

  console.log("");
  console.log(pc.bold(`Recent scrollback (last ${lines} lines)`));
  if (scrollback.trim() === "") {
    console.log(pc.dim("  (pane gone or empty)"));
    return;
  }
  for (const line of scrollback.replace(/\n+$/, "").split("\n")) {
    console.log(`  ${line}`);
  }
}

export async function cmdMe(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  const reading = (await readAgentStates([self], { stateDir: dirname(db.name) })).get(
    agentKey(self),
  );
  const displayed = {
    ...self,
    state: reading?.state ?? ("unknown" as const),
    source: reading?.source ?? ("none" as const),
    ctl: reading?.ctl ?? ("n/a" as const),
    since:
      reading?.since === null || reading?.since === undefined
        ? null
        : new Date(reading.since).toISOString(),
    ...(reading?.reason !== undefined ? { reason: reading.reason } : {}),
  };
  const owned = listTasksByOwner(db, self.workstreamName, self.name, {
    includeClosed: opts.includeClosed ?? false,
  });

  if (opts.json) {
    emitJson({
      agent: liveAgentToOutput(displayed, workstreamIdOf(db, self.workstreamName)),
      ownedTasks: owned,
    });
    return;
  }

  console.log(pc.bold(`${self.name}  ${statusIcon(displayed.state)} ${displayed.state}`));
  console.log(`  workstream : ${self.workstreamName}`);
  console.log(`  cli        : ${self.cli}`);
  console.log(`  pane       : ${pc.dim(self.paneId)}`);
  console.log(`  role       : ${self.role}`);
  console.log("");
  if (owned.length === 0) {
    console.log(pc.dim("Currently owns no tasks. Try `mu me next` for a recommendation."));
    return;
  }
  console.log(pc.bold(`Currently owns ${owned.length} task${owned.length === 1 ? "" : "s"}`));
  console.log(formatTaskListTable(owned));
}

export async function cmdClose(
  db: Db,
  rawName: string,
  opts: { workstream?: string; json?: boolean; discard?: boolean; if?: number } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const discard = opts.discard === true;
  // Bare close is the preview: it reads, it never kills. `--if <rev>` applies.
  if (opts.if === undefined) {
    const p = await previewClose(db, name, { workstream: ws, discard });
    const next: NextStep[] =
      p.kind === "none" || p.refusesDirty
        ? []
        : [
            {
              intent: "Apply this close",
              command: `mu agent close ${name} -w ${ws}${discard ? " --discard" : ""} --if ${p.revision}`,
            },
          ];
    if (opts.json) {
      emitJson({ ...closePreviewToOutput(p), dryRun: true, nextSteps: next });
      return;
    }
    printClosePreview(p);
    printNextSteps(next);
    return;
  }
  // The row is gone after the close: a remote agent's re-spawn line needs its host.
  const closing = getAgent(db, name, ws);
  const result = await closeAgent(db, name, {
    workstream: ws,
    ifRevision: opts.if,
    ...(discard ? { discard: true } : {}),
  });
  const next: NextStep[] = [];
  const kept = result.worktree?.branch;
  if (kept !== undefined) {
    next.push({
      intent: `Its unmerged commits are on ${kept}; merge or inspect them`,
      command: `git log --oneline HEAD..${kept}`,
    });
  }
  next.push({
    intent: "Re-spawn under the same name",
    command:
      (closing?.host != null ? respawnCommand(closing) : undefined) ??
      `mu agent spawn ${name} -w ${ws}`,
  });
  if (opts.json) {
    emitJson({ agentName: name, ...result, nextSteps: next });
    return;
  }
  if (!result.killedPane && !result.deletedRow && result.worktree === null) {
    console.log(pc.dim(`no agent named ${name} (already closed?)`));
    printNextSteps(next);
    return;
  }
  console.log(`Closed ${pc.bold(name)}`);
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
  printNextSteps(next);
}

function printClosePreview(p: ClosePreview): void {
  if (p.kind === "none") {
    console.log(pc.dim(`no agent named ${p.agentName} (already closed?)`));
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
  if (p.worktree !== null) {
    console.log(`  worktree ${p.worktree.path}: ${p.worktree.state}`);
    if (p.refusesDirty) {
      console.log(
        pc.yellow("  uncommitted work: close refuses. Commit it, or preview with --discard"),
      );
    }
  }
}

/**
 * `mu agent check <agent> <msgId>`: one `status {msgId}` probe. Exit 0
 * `accepted runs=<n> at=<iso>`; 3 `not-accepted` (the extension never took
 * it, or no longer remembers it: NOT proof it was never sent); 1 `unreachable` (no answer: still unknown).
 */
export async function cmdAgentCheck(
  db: Db,
  rawName: string,
  msgId: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const agent = getAgent(db, name, ws);
  if (agent === undefined) throw new AgentNotFoundError(name, ws);
  const check = await checkMessage(agentCtlSocket(db, agent), msgId);
  const exit = check.state === "accepted" ? 0 : check.state === "not-accepted" ? 3 : 1;
  if (opts.json) {
    // A check that is not "accepted" fails with ONE document: the verdict
    // rides in `data`, the reason is the message.
    if (exit !== 0) {
      throw new CliExitError(exit, {
        error: check.state === "unreachable" ? "AgentCtlUnreachableError" : "MessageNotAccepted",
        message:
          check.state === "unreachable"
            ? check.reason
            : `${name}: message ${msgId} was not accepted (an evicted or in-flight send reads the same): read the pane before any resend`,
        data: { agentName: name, ...check },
      });
    }
    emitJson({ agentName: name, ...check });
  } else if (check.state === "accepted") {
    const at = check.at === undefined ? "?" : new Date(check.at).toISOString();
    console.log(`accepted runs=${check.runs ?? "?"} at=${at}`);
  } else if (check.state === "not-accepted") {
    console.log("not-accepted");
  } else {
    console.log("unreachable");
    console.error(pc.dim(check.reason));
  }
  if (exit !== 0) throw new CliExitError(exit);
}

export async function cmdAbort(
  db: Db,
  rawName: string,
  opts: { workstream?: string; timeout?: number; json?: boolean } = {},
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const result = await abortAgent(db, name, {
    workstream: ws,
    ...(opts.timeout === undefined ? {} : { timeoutMs: Math.round(opts.timeout * 1000) }),
  });
  // An abort that reported idle is the exact after state: no pane read.
  const nextSteps: NextStep[] = [
    {
      intent: "Steer it with the next instruction",
      command: `mu agent send ${name} '...' -w ${ws}`,
    },
    ...(result.after === "idle"
      ? []
      : [{ intent: "Read the pane", command: `mu agent read ${name} -n 30 -w ${ws}` }]),
  ];
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  console.log(
    result.aborted
      ? `Aborted ${pc.bold(name)} ${pc.dim(`(${result.before} → ${result.after} in ${result.elapsedMs}ms)`)}`
      : `${pc.bold(name)} was ${result.before}; nothing to abort`,
  );
  printNextSteps(nextSteps);
}

/**
 * `mu agent wait <names...>` — block until agents finish working.
 *
 * The task-less counterpart to `mu task wait`: scratch / off-the-cuff
 * helpers have no task in the DAG, so the only "done" signal is the
 * agent's own runtime status. An agent fires when it goes **busy → any
 * other state** (it must be observed busy first, so an already-idle
 * agent doesn't fire instantly — you're waiting for THIS work to end).
 *
 * Mirrors `mu task wait` output/exit shape:
 *   exit 0 = condition met; 5 = timeout; 6 = a watched agent's pane died;
 *   7 = a pi agent is waiting on an extension dialog (needs a human).
 * `--any`/`--first` fire on the first agent; default = all must fire.
 * `--first` additionally prints the firing agent's qualified ref.
 */
export async function cmdAgentWait(
  db: Db,
  rawNames: readonly string[],
  opts: {
    any?: boolean;
    first?: boolean;
    timeout?: number;
    afterRuns?: number;
    /** pi's incarnation from `send --json`: refuse to wait on another pi process. */
    inc?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  if (rawNames.length === 0) {
    throw new UsageError("mu agent wait: at least one agent name is required");
  }
  // --first is a CLI alias for --any with a richer output shape.
  const wantAny = opts.any === true || opts.first === true;
  const wantFirstShape = opts.first === true;

  // Resolve each ref — cross-workstream-aware via `<ws>/<name>`; bare
  // names resolve through -w or the injected worker scope.
  const refs = await Promise.all(
    rawNames.map(async (raw) => {
      const local: { workstream?: string } = { workstream: opts.workstream };
      const name = applyQualifiedRef(raw, local);
      const workstreamName = await resolveWorkstream(local.workstream);
      return { name, workstreamName };
    }),
  );

  // --after-runs is a ctl run count: refuse an agent that has none
  // rather than silently polling it with no baseline.
  if (opts.afterRuns !== undefined) {
    for (const ref of refs) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      if (agent !== undefined && !expectsCtl(agent, agentCtlSocket(db, agent))) {
        throw new UsageError(
          `--after-runs needs a pi agent (control socket); ${ref.workstreamName}/${ref.name} runs ${agent.cli}. Drop --after-runs to wait on its pane state.`,
        );
      }
    }
  }

  // --inc pins the pi process the run belongs to: it needs an extension that
  // reports incarnations (else AgentExtensionOutdatedError with the reload
  // ladder), and it only makes sense for pi agents.
  if (opts.inc !== undefined) {
    if (rawNames.length > 1) {
      throw new UsageError("--inc names one pi process: wait on one agent at a time");
    }
    for (const ref of refs) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      if (agent === undefined) continue;
      const sock = agentCtlSocket(db, agent);
      if (!expectsCtl(agent, sock)) {
        throw new UsageError(
          `--inc needs a pi agent (control socket); ${ref.workstreamName}/${ref.name} runs ${agent.cli}. Drop --inc.`,
        );
      }
      await requireFeature(agent, sock, "incarnation");
    }
  }

  const readStatuses = async (
    pending: readonly { name: string; workstreamName: string }[],
  ): Promise<
    Map<
      string,
      {
        status: "busy" | "needs_input" | "needs_permission" | "unknown" | null;
        unknownReason?: string;
        blocked?: CtlBlocked;
      }
    >
  > => {
    const agents = pending.flatMap((ref) => {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      return agent === undefined ? [] : [agent];
    });
    const readings = await readAgentStates(agents, { stateDir: dirname(db.name) });
    const snapshots = new Map<
      string,
      {
        status: "busy" | "needs_input" | "needs_permission" | "unknown" | null;
        unknownReason?: string;
        blocked?: CtlBlocked;
      }
    >();
    for (const ref of pending) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      const reading = agent === undefined ? undefined : readings.get(agentKey(agent));
      snapshots.set(agentKey(ref), {
        status: reading?.alive === false ? null : (reading?.state ?? "unknown"),
        ...(reading?.reason !== undefined ? { unknownReason: reading.reason } : {}),
        ...(reading?.blocked !== undefined ? { blocked: reading.blocked } : {}),
      });
    }
    return snapshots;
  };

  // pi agents: one ctl `wait` per agent, resolved by the extension on
  // agent_settled. `afterRuns` is --after-runs (the `runs` a send
  // replied with, so a run that settled before this wait still counts),
  // else a status read taken BEFORE the wait starts: a followUp queued
  // while busy runs in the same pi run.
  const watch = async (
    ref: { name: string; workstreamName: string },
    signal: AbortSignal,
  ): Promise<AgentWatch | undefined> => {
    const agent = getAgent(db, ref.name, ref.workstreamName);
    if (agent === undefined) return undefined;
    const sock = agentCtlSocket(db, agent);
    if (!expectsCtl(agent, sock)) return undefined;
    // With --after-runs the run past the baseline is the pending work:
    // read as busy until the wait settles; no status probe needed.
    let initial: AgentStatusSnapshot = { status: "busy" };
    let afterRuns = opts.afterRuns;
    if (afterRuns === undefined) {
      const probe = await ctlProbe(sock);
      if (probe.kind !== "ok") return undefined;
      afterRuns = probe.status.runs;
      initial = { status: ctlRuntimeState(probe.status.state, probe.status.blocked) };
    }
    // returnOnBlocked: a dialog opening mid-run ends the wait (exit 7)
    // instead of holding it to --timeout. Older extensions ignore it.
    const req = {
      op: "wait",
      afterRuns,
      returnOnBlocked: true,
      ...(opts.inc !== undefined ? { incarnation: opts.inc } : {}),
    } as const;
    const restarted = (actual?: string): AgentRestartedError =>
      new AgentRestartedError(ref.name, ref.workstreamName, opts.inc ?? "", actual);
    const settled = ctlRequest(sock, req, { signal }).then(
      (reply): AgentStatusSnapshot => {
        // A refused incarnation is fatal, never "unknown": the run is gone.
        if (!reply.ok && reply.error === INCARNATION_MISMATCH) throw restarted(reply.incarnation);
        if (reply.ok && reply.ended === "blocked" && reply.blocked !== undefined) {
          return { status: "needs_permission", blocked: reply.blocked };
        }
        if (reply.ok && reply.state !== undefined) {
          return {
            status: ctlRuntimeState(reply.state),
            ...(reply.lastText !== undefined ? { lastText: reply.lastText } : {}),
            ...(reply.lastError !== undefined ? { lastError: reply.lastError } : {}),
            ...(reply.sessionFile !== undefined ? { sessionFile: reply.sessionFile } : {}),
          };
        }
        return {
          status: "unknown",
          unknownReason: reply.ok ? "ctl wait: no state" : reply.error,
        };
      },
      // The connection dropped. A socket that still answers (pi's /new
      // restarts the session) hands back to polling; one that does not
      // means the pi that served it is gone. With --inc an answering
      // process must also BE that incarnation: another one means the agent
      // restarted and the run is gone (fatal, never polled).
      async (): Promise<AgentStatusSnapshot> => {
        if (signal.aborted) return { status: "unknown" };
        const again = await ctlProbe(sock);
        if (
          opts.inc !== undefined &&
          again.kind === "ok" &&
          again.incarnation !== undefined &&
          again.incarnation !== opts.inc
        ) {
          throw restarted(again.incarnation);
        }
        return again.kind === "ok"
          ? { status: "unknown", unknownReason: "ctl wait interrupted" }
          : { status: null };
      },
    );
    return { initial, settled, afterRuns };
  };

  const timeoutMs = (opts.timeout ?? 600) * 1000;
  const result = await waitForAgents(db, refs, {
    any: wantAny,
    timeoutMs,
    readStatuses,
    watch,
    onInitialUnknown: (agents) => {
      // --json carries the same reasons per agent (`unknownReason`) in the document.
      if (opts.json) return;
      const names = agents.map((agent) => `${agent.workstreamName}/${agent.name}`).join(", ");
      const reasons = [...new Set(agents.map((agent) => agent.unknownReason ?? "no reason"))].join(
        ", ",
      );
      process.stderr.write(
        `mu agent wait: state unknown for ${names} (${reasons}); waiting until --timeout\n`,
      );
    },
  });

  const dead = result.agents.filter((a) => a.dead);
  const blocked = result.agents.filter((a) => a.blocked !== undefined);
  const fired = result.agents.filter((a) => a.fired);
  const firing = wantFirstShape && fired.length > 0 ? fired[0] : null;
  const qualified = (a: { workstreamName: string; name: string }): string =>
    `${a.workstreamName}/${a.name}`;
  // A pi run that settled with its final text already returned it:
  // read the pane only when the text is empty or the run errored.
  const readHint: NextStep[] =
    firing && (!firing.lastText || firing.lastError !== undefined)
      ? [
          {
            intent: "Read the finished agent",
            command: `mu agent read ${firing.name} -w ${firing.workstreamName}`,
          },
        ]
      : [];
  // A blocked run is not finished: point at the dialog and the re-wait.
  for (const a of blocked) {
    readHint.push(
      {
        intent: "Read the dialog pi is waiting on",
        command: `mu agent read ${a.name} -w ${a.workstreamName}`,
      },
      {
        intent: "Wait again once it is answered",
        command: `mu agent wait ${a.name} -w ${a.workstreamName}${a.afterRuns !== undefined ? ` --after-runs ${a.afterRuns}` : ""}`,
      },
    );
  }

  if (opts.json) {
    emitJson({
      agents: result.agents.map((a) => ({
        ...a,
        outcome: delegateOutcome(a, result.timedOut),
      })),
      timedOut: result.timedOut,
      ...(firing ? { firing: { workstream: firing.workstreamName, name: firing.name } } : {}),
      ...(dead.length > 0 ? { dead: dead.map(qualified) } : {}),
      nextSteps: readHint,
    });
  } else {
    // A dead pane is reported whenever one happened, even beside agents
    // that fired: the wait counts a death as done, so "All N finished"
    // would hide a crashed worker.
    if (dead.length > 0) {
      console.log(pc.red(`Agent pane(s) died: ${dead.map(qualified).join(", ")}`));
    }
    for (const a of blocked) {
      const why = a.blocked ? blockedReason(a.blocked) : "dialog";
      console.log(pc.magenta(`${qualified(a)} is waiting on a ${why}; its run is not finished`));
    }
    if (blocked.length > 0) {
      printNextSteps(readHint);
    } else if (result.timedOut) {
      console.log(
        pc.yellow(
          `Timed out after ${opts.timeout ?? 600}s; ${fired.length}/${result.agents.length} finished`,
        ),
      );
    } else if (firing) {
      console.log(`${pc.bold(qualified(firing))} finished`);
      printNextSteps(readHint);
    } else if (fired.length === result.agents.length) {
      console.log(`All ${result.agents.length} agent(s) finished`);
    } else if (fired.length > 0) {
      // --any, or --all where the rest died: name who finished.
      console.log(
        `${fired.map(qualified).join(", ")} finished (${fired.length}/${result.agents.length})`,
      );
    }
  }

  // Exit-code mapping mirrors `mu task wait`: 6 (a watched pane died,
  // even when others finished) wins over 5 (timeout); a clean
  // met-condition is 0.
  if (dead.length > 0) {
    process.exitCode = 6;
  } else if (blocked.length > 0) {
    process.exitCode = 7;
  } else if (result.timedOut) {
    process.exitCode = 5;
  }
}

// ─── commander wiring ──────────────────────────────────────────
//
// wireAgentCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import {
  handle,
  JSON_OPT,
  normalizeInheritedWorkstream,
  parseLines,
  parseNonNegativeInt,
  parsePositiveNumber,
  parseSeconds,
  WORKSTREAM_OPT,
} from "../cli.js";
// wireSelfCommands needs cmdMyTasks / cmdMyNext which live in cli/tasks.ts
// (they're task queries scoped to the resolved-self agent). Lateral
// cluster→cluster import documented as the single intentional edge.
import { cmdMyNext, cmdMyTasks } from "./tasks.js";

export function wireAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Agent-level commands")
    // Every agent verb needs a multiplexer, including the ones that only
    // read a registry row (show): no backend at all is exit 5
    // with the install line, before any DB or scope work.
    .hook("preAction", async () => {
      await activeMux();
    });

  agent
    .command("spawn <name>")
    .description("Spawn a new agent in a mux pane")
    .option(
      "--cli <cli>",
      "agent CLI key (default: pi); also used as the lookup key for $MU_<UPPER_CLI>_COMMAND, e.g. --cli pi_big resolves $MU_PI_BIG_COMMAND",
      "pi",
    )
    .option(
      "--command <cmd>",
      "executable to run in the pane (defaults to $MU_<CLI>_COMMAND or the cli value)",
    )
    .option("--tab <tab>", "mux window/tab name to group under (defaults to agent name)")
    .option("--role <role>", "full-access | read-only", "full-access")
    .option(
      "--cwd <dir>",
      "directory the pane starts in (default: yours); conflicts with --worktree",
    )
    .option(
      "--worktree",
      "run in its own git worktree (git worktree add --detach under the state dir); its path is the cwd",
    )
    .option("--from <ref>", "with --worktree: start at this commit or branch (default: HEAD)")
    .option(
      "--root <repo>",
      "with --worktree: the repo to add it to (default: the git root of your cwd)",
    )
    .option(
      "--host <profile>",
      "run on this host profile (mu host add): the pane runs its --shell template, which starts the remote pi and forwards its control socket here; --cwd and --worktree name REMOTE paths (the worktree is made by its --exec, under ~/.local/state/mu/remote-worktrees/<ws>/<name>); the pane dying is the agent dying. tmux only; not with --root",
    )
    .option("--no-ctl", "skip the control-socket handshake with the mu pi extension")
    .option(
      "--next-free",
      "if <name> is taken, take the next free one (worker-1 → worker-2, review → review-2); --json's agent.name says which",
    )
    .option(
      "--send <text>",
      "send this text once the agent is up (one mu call for spawn + send; `-` reads stdin). A failed send keeps the pane and exits non-zero; --json still prints the spawn with send.error",
    )
    .option(
      "--task <id>",
      "with --send: bind the spawn to this task: claim it for the new agent after the pane exists, then send the text as its brief (pinned once delivered, kept when the task already has one). One journaled attempt: a failure before the send rolls back its own pane and claim; an unknown delivery keeps both and is never resent",
    )
    .option(
      "--attempt <key>",
      "with --task: name this attempt (default: the task id). The same key replays its saved outcome and never sends a second prompt; reopened work needs a new key",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        nextFree?: boolean;
        host?: string;
        send?: string;
        task?: string;
        attempt?: string;
        cli?: string;
        command?: string;
        tab?: string;
        role?: string;
        cwd?: string;
        workstream?: string;
        worktree?: boolean;
        from?: string;
        root?: string;
        ctl?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdSpawn(db, name, opts), this as Command)();
    });

  agent
    .command("send <name> <text>")
    .description(
      "Send text to an agent. pi agents: through the control socket (fails loud if it does not answer; no paste fallback); '/new', '/reload' and '/compact [instructions]' run inside pi over the socket (refused while busy unless --force), any other slash command is refused. Non-pi CLIs: herdr only (atomic `agent prompt`); on tmux the send is refused. --fresh (pi only): start a new session and send the text into it as one operation; returns once the prompt's run has started, so an immediate next send cannot be lost. Use it instead of sending '/new' then the prompt. Text `-` reads stdin: single-quote short text; pipe prose (apostrophes, $, backticks) as a quoted heredoc: mu agent send <name> - <<'EOF'",
    )
    .option(
      "--steer",
      "if pi is busy, deliver after the current tool calls finish, before the next model call (default: after the run ends); does not stop a running tool: use --interrupt",
    )
    .option(
      "--interrupt",
      "pi only: if busy, abort the current run (kills the running tool; queued messages go back to the editor), wait for pi to settle, then send the text as a new run. Exit 5 if pi does not settle; the text is then not sent",
    )
    .option(
      "--timeout <seconds>",
      "with --interrupt: max seconds to wait for pi to settle (default 30)",
      parsePositiveNumber,
    )
    .option(
      "--fresh",
      "pi only: new session + this prompt, one operation (refused with exit 4 while pi is busy)",
    )
    .option(
      "--force",
      "with --fresh or a pi /new, /reload, /compact: abandon a running turn instead of refusing",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string, text: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        steer?: boolean;
        fresh?: boolean;
        force?: boolean;
        interrupt?: boolean;
        timeout?: number;
      };
      return handle((db) => cmdSend(db, name, text, opts), this as Command)();
    });

  agent
    .command("check <name> <msgId>")
    .description(
      "Ask whether a send landed: one status probe for its msgId (from `send --json`, or a delivery-unknown error). Prints `accepted runs=<n> at=<iso>` (exit 0), `not-accepted` (exit 3: the extension has no such id; an evicted or in-flight send reads the same, so read the pane before resending) or `unreachable` (exit 1: still unknown).",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string, msgId: string) {
      const opts = (this as Command).optsWithGlobals() as {
        workstream?: string | string[];
        json?: boolean;
      };
      return handle(
        (db) =>
          cmdAgentCheck(db, name, msgId, {
            ...opts,
            workstream: normalizeInheritedWorkstream(opts.workstream),
          }),
        this as Command,
      )();
    });

  agent
    .command("read <name>")
    .description("Read an agent's pane scrollback")
    .option("-n, --lines <n>", "show last N lines (default: full scrollback)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        lines?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdRead(db, name, opts), this as Command)();
    });

  agent
    .command("list")
    .description("List agents in the current workstream (reconciled with the active mux)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdList(db, opts), this as Command)();
    });

  agent
    .command("show <name>")
    .description("Show an agent: registry row + recent scrollback (last N lines, default 20)")
    .option("-n, --lines <n>", "how many scrollback lines to show (default 20)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        lines?: number;
        json?: boolean;
        workstream?: string;
      };
      return handle((db) => cmdAgentShow(db, name, opts), this as Command)();
    });

  agent
    .command("close <name>")
    .description(
      "Close an agent. Without --if it only previews (revision, owned tasks, worktree state) and prints the apply command; with --if <rev> it kills the pane and removes its registry row (refused if the agent changed since the preview). Its worktree goes with it: removed when clean, a branch mu/<ws>/<agent>-<sha> keeps unmerged commits; a dirty worktree refuses before anything is killed.",
    )
    .option(
      "--discard",
      "close even with uncommitted work in the worktree (lossy: it is thrown away)",
    )
    .option("--if <rev>", "apply the preview with this revision", parseNonNegativeInt)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        discard?: boolean;
        if?: number;
      };
      return handle((db) => cmdClose(db, name, opts), this as Command)();
    });

  // `mu agent abort` — stop a pi agent's turn through its control socket.
  agent
    .command("abort <name>")
    .description(
      "Stop a pi agent's current turn through its control socket (what Esc does in the pane), then wait until pi settles. Kills the running tool. A follow-up queued before the abort does not run: pi puts it back into the pane's editor unsent. Idle agents are left alone (exit 0). Exit 5 when still busy after --timeout; then use `mu agent close`. Works for remote agents through the forwarded socket. Non-pi agents have no socket: use `mu agent close`.",
    )
    .option(
      "--timeout <seconds>",
      "max seconds to wait for pi to settle (default 30)",
      parsePositiveNumber,
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (name: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        timeout?: number;
        json?: boolean;
      };
      return handle((db) => cmdAbort(db, name, opts), this as Command)();
    });

  // `mu agent wait` — the task-less counterpart to `mu task wait`. Block
  // until agents finish (busy → any other state). For scratch /
  // off-the-cuff helpers that own no task to wait on.
  agent
    .command("wait <names...>")
    .description(
      "Block until agents finish working (busy → any other state). Keys on AGENTS, so it fires on needs_input too — a worker that stopped to ask a question satisfies it. For task-driven work prefer `mu task wait`, which keys on the task reaching CLOSED and has `--stuck-after` / `--on-stall` for the needs_input case; reach for this verb when the agent owns no task to wait on. A pi agent that opens an extension dialog (a confirm or question) ends the wait early with outcome `blocked`: its run is not finished. Exit 0 = met; 5 = timeout; 6 = a pane died; 7 = a pi agent is waiting on a dialog.",
    )
    .option("--any", "succeed as soon as ONE listed agent finishes (default: all)")
    .option("--first", "alias for --any that also prints the firing agent's ref")
    .option(
      "--timeout <seconds>",
      "max seconds to wait, fractions allowed (0 = forever, default 600)",
      parseSeconds,
    )
    .option(
      "--after-runs <n>",
      "pi agents only: fire on the first run settled past N (the `runs` that `mu agent send --json` printed), even one that settled before this wait started. One N applies to every named agent",
      parseNonNegativeInt,
    )
    .option(
      "--inc <incarnation>",
      "pi agents only: the `incarnation` that `mu agent send --json` printed. Refuses (exit 4) when the agent restarted since: its run is gone",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (names: string[]) {
      const opts = (this as Command).optsWithGlobals() as {
        any?: boolean;
        first?: boolean;
        timeout?: number;
        afterRuns?: number;
        inc?: string;
        workstream?: string | string[];
        json?: boolean;
      };
      return handle(
        (db) =>
          cmdAgentWait(db, names, {
            ...opts,
            workstream: normalizeInheritedWorkstream(opts.workstream),
          }),
        this as Command,
      )();
    });

  // ─── task ───────────────────────────────────────────────────────────
}

export function wireSelfCommands(program: Command): void {
  // `mu me` is the merged self-identity verb (audit_merge_self_verbs_into_mu_me).
  // Default action: identity block + owned tasks (was `mu whoami`).
  // Subcommands:
  //   mu me tasks       — just the owned-tasks table (was `mu my-tasks`)
  //   mu me next [-n K] — top-K ready in self.workstream (was `mu my-next`)
  const me = program
    .command("me")
    .description(
      "Identify the agent running this process (via the injected $MU_AGENT_NAME/$MU_WORKSTREAM; a managed tmux pane is the fallback) plus its currently-owned tasks (excludes CLOSED by default). Subcommands: `mu me tasks` for just the owned-tasks table; `mu me next [-n K]` for the top-K ready tasks in this agent's workstream.",
    )
    .option("--include-closed", "include CLOSED tasks in the owned-tasks list")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdMe(db, opts), this as Command)();
    });

  me.command("tasks")
    .description(
      "List tasks owned by the current agent (the second half of `mu me`'s output). Excludes CLOSED by default.",
    )
    .option("--include-closed", "include CLOSED tasks in the list")
    .option("--all", "no cap: every record, whole (a cut result names this command)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        json?: boolean;
        includeClosed?: boolean;
        all?: boolean;
      };
      return handle((db) => cmdMyTasks(db, opts), this as Command)();
    });

  me.command("next")
    .description(
      "Top-K ready tasks in the current agent's workstream (alias for `task next -w <self.workstream>`)",
    )
    .option(
      "-n, --lines <k>",
      "how many top-K tasks to return (default 1; 0 = all ready)",
      parseLines,
    )
    .option("--all", "no cap: every record, whole (a cut result names this command)")
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { lines?: number; json?: boolean; all?: boolean };
      return handle((db) => cmdMyNext(db, opts), this as Command)();
    });
}
