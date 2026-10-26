// mu — every `mu agent ...` verb + spawn / send / read / list / show /
// close + the top-level `mu me` agent-self
// verb (default + `tasks` / `next` subcommands).
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.
//
// `whoami` / `my-tasks` / `my-next` were merged into `mu me` /
// `mu me tasks` / `mu me next` in audit_merge_self_verbs_into_mu_me
// (audit_cleanups_post_schema_v5_wave). The three old verbs are
// gone; `cmdMyTasks` and `cmdMyNext` stayed.

import { dirname } from "node:path";
import { agentToOutput, liveAgentToOutput, workstreamIdOf } from "../agent-output.js";
import { agentKey, blockedReason, type RuntimeState, readAgentStates } from "../agent-state.js";
import { isCommandGate } from "../agents/spawn.js";
import {
  AgentCtlUnreachableError,
  AgentNotFoundError,
  AgentSendIndeterminateError,
  abortAgent,
  agentCtlSocket,
  checkMessage,
  delegateOutcome,
  expectsCtl,
  getAgent,
  interruptAgent,
  isSlashCommand,
  listLiveAgents,
  parseSessionCommand,
  readAgent,
  requireFeature,
  resolveCliCommand,
  resolveCliCommandWithSource,
  type SpawnedAgent,
  sendToAgent,
  spawnAgent,
  spawnForTask,
  type Transport,
} from "../agents.js";
import {
  applyQualifiedRef,
  assertAgentInWorkstream,
  CliExitError,
  classifyError,
  emitJson,
  formatAgentsTable,
  resolveEntityRef,
  resolveWorkstream,
  statusIcon,
  UsageError,
} from "../cli.js";
import type { Db } from "../db.js";
import { say } from "../messages.js";
import { activeMux, attachShellLine, type SendWarning } from "../mux.js";
import { pc } from "../output.js";
import { type WaitRef, type WaitSnapshot, waitForEvents } from "../wait.js";
import { ctlAgentHooks } from "../wait-ctl.js";
import { wireCloseCommand } from "./agent-close.js";
import { wireCollectCommand } from "./agent-collect.js";
import { setNextOutcome } from "./handle.js";
import { readStdinText, STDIN_ARG } from "./stdin.js";
import { installWaitSignals, runWait, type WaitSignals } from "./wait.js";
import { armSend, taskRef } from "./wait-arm.js";

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
      throw new UsageError(say("agent.spawn_cwd_worktree"));
    }
    return;
  }
  for (const flag of ["from", "root"] as const) {
    if (opts[flag] !== undefined) throw new UsageError(say("agent.spawn_needs_worktree", flag));
  }
}

// A remote command gate runs one command and reports its exit: it takes no
// brief, task or worktree. Refused before any effect (stdin read included).
function assertGateFlags(opts: SpawnOpts): void {
  if (!isCommandGate(opts)) return;
  for (const flag of ["task", "send", "attempt"] as const) {
    if (opts[flag] !== undefined) {
      throw new UsageError(say("agent.spawn_gate_flag", flag));
    }
  }
  if (opts.worktree) {
    throw new UsageError(say("agent.spawn_gate_worktree"));
  }
}

export async function cmdSpawn(db: Db, rawName: string, opts: SpawnOpts): Promise<void> {
  assertGateFlags(opts);
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
    throw new UsageError(say("agent.spawn_attempt_task"));
  }
  if (opts.task !== undefined) {
    if (sendText === undefined) {
      throw new UsageError(say("agent.spawn_task_send"));
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
    if (!opts.json) console.error(pc.yellow(`warning: ${warn.message}`));
  }
  // Claude parks at a trust dialog whose default is "No, exit": the Enter
  // that ends a send would quit it. Keep the pane, skip the send, say why.
  const trustSkip = agent.trustDialog === true && sendText !== undefined;
  if (agent.trustDialog === true) {
    const trustWarning = say("agent.spawn_trust_warning", name, trustSkip);
    warnings.push(trustWarning);
    if (!opts.json) console.error(pc.yellow(`warning: ${trustWarning}`));
  }
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
  // A DELIVERED --send owes a wait: arm it for the ACTUAL agent (--next-free may have
  // renamed it), fenced by the runs/incarnation the send measured. Trust-skipped,
  // undelivered and failed or UNKNOWN sends arm nothing.
  if (sent?.ok && sent.delivered) {
    const armed = armSend(
      db,
      { name, workstreamName: workstream },
      { transport: sent.transport, runs: sent.runs, incarnation: sent.incarnation },
    );
    if (armed.warning !== undefined) {
      warnings.push(armed.warning);
      if (!opts.json) console.error(pc.yellow(`warning: ${armed.warning}`));
    }
  }
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
  // What the spawn owes next: a gate's wait, or the exact wait of a delivered --send.
  if (agent.gateToken != null) {
    setNextOutcome({ kind: "gate-spawned", agent: { name, workstream } });
  } else if (sent?.ok && sent.runs !== undefined) {
    setNextOutcome({
      kind: "sent",
      agent: { name, workstream },
      runs: sent.runs,
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
    });
  }
  // The attach line is data (the delegate tool prints it), not a hint. Best effort.
  let attach: string | undefined;
  try {
    const mux = await activeMux();
    attach = attachShellLine(
      await mux.attachCommands({
        session: `mu-${workstream}`,
        window: agent.tab ?? name,
        inside: Boolean(process.env.TMUX),
      }),
    );
  } catch {
    // no attach line
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
      ...(attach !== undefined ? { attach } : {}),
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
  if (attach !== undefined) console.log(pc.dim(`  attach: ${attach}`));
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
  // Arm what this attempt owes: the task and its agent, from the SAVED receipt (a replay
  // answers with the original run and incarnation). A stale identity (the agent was deleted
  // or the name now belongs to a replacement) arms nothing: never a replacement under an
  // old receipt. A delivery-UNKNOWN attempt arms its task only (the prompt may be running).
  const warnings: string[] = [];
  if (out.stale === undefined && rec.state !== "reserved" && rec.state !== "pane") {
    const armed =
      out.state === "sent" && out.agent !== undefined
        ? armSend(
            db,
            { name: agentName, workstreamName: workstream },
            {
              transport: rec.transport ?? "ctl",
              ...(rec.runs !== null ? { runs: rec.runs } : {}),
              ...(rec.incarnation !== null ? { incarnation: rec.incarnation } : {}),
            },
            [taskRef(workstream, task)],
          )
        : armSend(db, { name: agentName, workstreamName: workstream }, { transport: "ctl" }, [
            taskRef(workstream, task),
          ]);
    if (armed.warning !== undefined) {
      warnings.push(armed.warning);
      if (!opts.json) console.error(pc.yellow(`warning: ${armed.warning}`));
    }
  }
  if (out.state === "sent" && rec.runs !== null && out.stale === undefined) {
    setNextOutcome({
      kind: "sent",
      agent: { name: agentName, workstream },
      runs: rec.runs,
      ...(rec.incarnation !== null ? { incarnation: rec.incarnation } : {}),
    });
  } else if (out.state === "unknown" && rec.transport === "ctl" && out.stale === undefined) {
    const row = getAgent(db, agentName, workstream);
    if (row !== undefined) {
      setNextOutcome({
        kind: "send-unknown",
        agent: { name: agentName, workstream },
        msgId: rec.msgId,
        agentId: row.incarnation,
      });
    }
  }
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
      ...(warnings.length > 0 ? { warnings } : {}),
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
    /** Enter the wait for the run this send starts (one JSON document: the receipt in `sent`, then the wait). */
    wait?: boolean;
  } = {},
  sig?: WaitSignals,
): Promise<void> {
  const text = rawText === STDIN_ARG ? await readStdinText("send text") : rawText;
  if (opts.interrupt) {
    for (const [on, flag] of [
      [opts.fresh, "--fresh"],
      [opts.steer, "--steer"],
      [opts.force, "--force"],
    ] as const) {
      if (on) throw new UsageError(say("agent.send_interrupt_excl", flag));
    }
    if (isSlashCommand(text)) {
      throw new UsageError(say("agent.send_interrupt_slash"));
    }
    // Refuse before the abort: an empty prompt would kill the running turn
    // and then send nothing.
    if (text === "") throw new UsageError(say("agent.send_interrupt_empty"));
  } else if (opts.timeout !== undefined) {
    throw new UsageError(say("agent.send_timeout"));
  }
  if (opts.force && !opts.fresh && parseSessionCommand(text) === undefined) {
    throw new UsageError(say("agent.send_force"));
  }
  if (opts.fresh && opts.steer) throw new UsageError(say("agent.send_fresh_steer"));
  if (opts.wait) {
    if (sig === undefined) throw new UsageError(say("agent.send_wait_sig"));
    // A slash command starts no run: there is nothing to wait for (refused before the send).
    if (isSlashCommand(text)) {
      throw new UsageError(say("agent.send_wait_slash"));
    }
  }
  if (opts.interrupt) return cmdSendInterrupt(db, rawName, text, opts, sig);
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
  // Arm the wait this send owes (a delivered prompt; fenced by the runs measured BEFORE it).
  const armed =
    undelivered === undefined
      ? armSend(db, { name, workstreamName: ws }, sent)
      : { armed: false as const };
  const warnings = armed.warning === undefined ? [] : [armed.warning];
  if (!opts.json && !opts.wait) for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
  if (opts.wait && sig !== undefined) {
    return enterSendWait(db, { name, workstreamName: ws }, sent, {
      sig,
      verb: "mu agent send --wait",
      undelivered: undelivered === undefined ? undefined : undelivered.message,
      receipt: {
        agentName: name,
        sentBytes: Buffer.byteLength(text),
        transport: sent.transport,
        ...(sent.runs !== undefined ? { runs: sent.runs } : {}),
        ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
        ...(sent.msgId !== undefined ? { msgId: sent.msgId } : {}),
        ...(sent.receipt !== undefined ? { receipt: sent.receipt } : {}),
      },
      warnings,
    });
  }
  // ONE next: a delivered ctl reply with runs gives the exact wait baseline (the wait
  // returns the run's final text). An undelivered or mux send owes no wait.
  if (sent.transport === "ctl" && sent.runs !== undefined && undelivered === undefined) {
    setNextOutcome({
      kind: "sent",
      agent: { name, workstream: ws },
      runs: sent.runs,
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
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
      ...(warnings.length > 0 ? { warnings } : {}),
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
}

/**
 * `send --wait`: the prompt is delivered (and armed); now wait for exactly the run it
 * started: one explicit agent ref pinned by the measured runs + incarnation, `all` mode so a
 * sibling's event does not end it (an urgent one still does: the worker died, a dialog, a
 * delegate report). ONE document: the wait's, with the send's receipt as `sent`.
 * An UNDELIVERED send waits for nothing: it fails with the receipt (the prompt may not have landed).
 */
async function enterSendWait(
  db: Db,
  agent: { name: string; workstreamName: string },
  sent: { transport?: "ctl" | "mux"; runs?: number; incarnation?: string },
  o: {
    sig: WaitSignals;
    verb: string;
    receipt: Record<string, unknown>;
    warnings: string[];
    undelivered?: string | undefined;
  },
): Promise<void> {
  if (o.undelivered !== undefined) {
    throw new CliExitError(1, {
      error: "SendUndelivered",
      message: say("agent.send_undelivered", o.undelivered),
      data: { sent: { ...o.receipt, delivered: false } },
    });
  }
  const ref: WaitRef = {
    kind: "agent",
    workstream: agent.workstreamName,
    id: agent.name,
    ...(sent.transport !== "mux" && sent.runs !== undefined ? { afterRuns: sent.runs } : {}),
    ...(sent.transport !== "mux" && sent.incarnation !== undefined
      ? { incarnation: sent.incarnation }
      : {}),
  };
  await runWait(
    db,
    {
      refs: [ref],
      mode: "all",
      onStall: "exit",
      verb: o.verb,
      scope: agent.workstreamName,
    },
    o.sig,
    {
      extraData: {
        sent: { ...o.receipt, delivered: true },
        ...(o.warnings.length > 0 ? { warnings: o.warnings } : {}),
      },
    },
  );
}

/** `mu agent send --interrupt`: abort a busy pi, wait for settle, send. */
async function cmdSendInterrupt(
  db: Db,
  rawName: string,
  text: string,
  opts: { workstream?: string; json?: boolean; timeout?: number; wait?: boolean },
  sig?: WaitSignals,
): Promise<void> {
  const { name } = await resolveEntityRef(db, rawName, opts, "agent");
  assertAgentInWorkstream(db, name, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = await interruptAgent(db, name, text, {
    workstream: ws,
    ...(opts.timeout === undefined ? {} : { timeoutMs: Math.round(opts.timeout * 1000) }),
  });
  // The interrupt is delivered (it threw otherwise): arm the run it started, same fence rule.
  const armed = armSend(db, { name, workstreamName: ws }, { transport: "ctl", ...r });
  const warnings = armed.warning === undefined ? [] : [armed.warning];
  if (!opts.json && !opts.wait) for (const w of warnings) console.error(pc.yellow(`warning: ${w}`));
  if (opts.wait && sig !== undefined) {
    return enterSendWait(
      db,
      { name, workstreamName: ws },
      { transport: "ctl", ...r },
      {
        sig,
        verb: "mu agent send --interrupt --wait",
        receipt: {
          agentName: name,
          sentBytes: Buffer.byteLength(text),
          transport: "ctl",
          interrupt: true,
          wasBusy: r.wasBusy,
          ...(r.pending ? { pending: true } : {}),
          ...(r.runs !== undefined ? { runs: r.runs } : {}),
          ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
          msgId: r.msgId,
          ...(r.receipt !== undefined ? { receipt: r.receipt } : {}),
        },
        warnings,
      },
    );
  }
  if (r.runs !== undefined) {
    setNextOutcome({
      kind: "sent",
      agent: { name, workstream: ws },
      runs: r.runs,
      ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
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
      ...(warnings.length > 0 ? { warnings } : {}),
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
            : say("agent.check_not_accepted", name, msgId),
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
  if (opts.json) {
    emitJson(result);
    return;
  }
  console.log(
    result.aborted
      ? `Aborted ${pc.bold(name)} ${pc.dim(`(${result.before} → ${result.after} in ${result.elapsedMs}ms)`)}`
      : `${pc.bold(name)} was ${result.before}; nothing to abort`,
  );
}

/** One agent of the `mu agent wait` document (the extension reads these fields; JSON drops the undefined ones). A gate that exited nonzero is a failure here: never a clean finish. */
function agentWaitState(
  ref: { workstreamName: string; name: string },
  snap: WaitSnapshot | undefined,
) {
  const failedGate = snap?.exit !== undefined && snap.exit !== 0;
  return {
    ...ref,
    status: (snap?.status ?? null) as RuntimeState | null,
    wasBusy: snap?.wasBusy === true,
    fired: snap?.fired === true && !failedGate,
    dead: snap?.dead === true || failedGate,
    exit: snap?.exit,
    unknownReason: snap?.unknownReason,
    lastText: snap?.lastText,
    lastError: snap?.lastError,
    sessionFile: snap?.sessionFile,
    blocked: snap?.blocked,
    afterRuns: snap?.afterRuns,
  };
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
    throw new UsageError(say("agent.wait_names"));
  }
  // --first is a CLI alias for --any with a richer output shape.
  const wantAny = opts.any === true || opts.first === true;

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
          say("agent.wait_after_runs_pi", `${ref.workstreamName}/${ref.name}`, agent.cli),
        );
      }
    }
  }

  // --inc pins the pi process the run belongs to: it needs an extension that
  // reports incarnations (else AgentExtensionOutdatedError with the reload
  // ladder), and it only makes sense for pi agents.
  if (opts.inc !== undefined) {
    if (rawNames.length > 1) {
      throw new UsageError(say("agent.wait_inc_one"));
    }
    for (const ref of refs) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      if (agent === undefined) continue;
      const sock = agentCtlSocket(db, agent);
      if (!expectsCtl(agent, sock)) {
        throw new UsageError(
          say("agent.wait_inc_pi", `${ref.workstreamName}/${ref.name}`, agent.cli),
        );
      }
      await requireFeature(agent, sock, "incarnation");
    }
  }

  // `waitForEvents` over these refs only: no caller, no CLOSE applied, no sync. pi agents wait on
  // the ctl `wait` (src/wait-ctl.ts), resolved by the extension on agent_settled; `afterRuns` is
  // --after-runs (the `runs` a send replied with, so a run that settled before this wait still
  // counts), else a status read taken BEFORE the wait starts.
  const res = await waitForEvents(
    db,
    refs.map((r) => ({
      kind: "agent" as const,
      workstream: r.workstreamName,
      id: r.name,
      ...(opts.afterRuns !== undefined ? { afterRuns: opts.afterRuns } : {}),
      ...(opts.inc !== undefined ? { incarnation: opts.inc } : {}),
    })),
    {
      callers: [],
      mode: wantAny ? "first" : "all",
      eventScope: "refs",
      stuckAfterMs: 0,
      uncapped: true,
      timeoutMs: (opts.timeout ?? 600) * 1000,
      sync: false,
      applyClose: false,
      ...ctlAgentHooks(db),
      onInitialUnknown: (snaps) => {
        // --json carries the same reasons per agent (`unknownReason`) in the document.
        if (opts.json) return;
        const names = snaps.map((s) => `${s.ref.workstream}/${s.ref.id}`).join(", ");
        const reasons = [...new Set(snaps.map((s) => s.unknownReason ?? "no reason"))].join(", ");
        process.stderr.write(say("agent.wait_unknown", names, reasons));
      },
    },
  );
  const byKey = new Map(res.refs.map((s) => [`${s.ref.workstream}/${s.ref.id}`, s]));
  const result = {
    timedOut: res.timedOut,
    agents: refs.map((ref) => agentWaitState(ref, byKey.get(`${ref.workstreamName}/${ref.name}`))),
  };

  const dead = result.agents.filter((a) => a.dead);
  const blocked = result.agents.filter((a) => a.blocked !== undefined);
  const fired = result.agents.filter((a) => a.fired);
  // --any and --first share one contract: the result names the agent that fired.
  const firing = wantAny && fired.length > 0 ? fired[0] : null;
  const qualified = (a: { workstreamName: string; name: string }): string =>
    `${a.workstreamName}/${a.name}`;
  if (opts.json) {
    emitJson({
      agents: result.agents.map((a) => ({
        ...a,
        outcome: delegateOutcome(a, result.timedOut),
      })),
      timedOut: result.timedOut,
      ...(firing ? { firing: { workstream: firing.workstreamName, name: firing.name } } : {}),
      ...(dead.length > 0 ? { dead: dead.map(qualified) } : {}),
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
    // A blocked run is not finished: the dialog lines above say so.
    if (blocked.length === 0 && result.timedOut) {
      console.log(
        pc.yellow(
          `Timed out after ${opts.timeout ?? 600}s; ${fired.length}/${result.agents.length} finished`,
        ),
      );
    } else if (blocked.length === 0 && firing) {
      console.log(`${pc.bold(qualified(firing))} finished`);
    } else if (blocked.length === 0 && fired.length === result.agents.length) {
      console.log(`All ${result.agents.length} agent(s) finished`);
    } else if (blocked.length === 0 && fired.length > 0) {
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
import { cmdState } from "./state.js";
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
      "agent CLI key (default: pi); also used as the lookup key for $MU_<UPPER_CLI>_COMMAND, e.g. --cli pi_big resolves $MU_PI_BIG_COMMAND. Omitted, a --host --command that is not pi is a command gate",
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
      "run on this host profile (mu host add): the pane runs its --shell template, which starts the remote pi and forwards its control socket here; --cwd and --worktree name REMOTE paths (the worktree is made by its --exec, under ~/.local/state/mu-next/remote-worktrees/<ws>/<name>); the pane dying is the agent dying. tmux only; not with --root",
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
    .option(
      "--wait",
      "after the send, wait for exactly the run it started and print the wait's ONE JSON result (`data.sent` is the send's receipt, `data.snapshots[].lastText` the answer; `mu wait` semantics: SIGINT/SIGTERM print a snapshot and a `resume`). Not for slash commands",
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
        wait?: boolean;
      };
      // --wait: listen before the DB opens, like `mu wait` (a signal during setup still prints a snapshot).
      const sig = opts.wait ? installWaitSignals() : undefined;
      const run = handle((db) => cmdSend(db, name, text, opts, sig), this as Command)();
      return sig === undefined ? run : run.finally(() => sig.dispose());
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

  wireCloseCommand(agent);
  wireCollectCommand(agent);

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
  // `mu me` IS `mu state --me` (src/cli/state.ts): one identity path, one JSON read.
  //   mu me tasks       — just the owned-tasks records (paged)
  //   mu me next [-n K] — top-K ready in the agent's workstream
  const me = program
    .command("me")
    .description(
      "The caller's own state: exactly `mu state --me` (JSON: identity, owned tasks, ready, its delegate queue and human needs). Identity is the injected $MU_AGENT_NAME in $MU_WORKSTREAM, or pi:$PI_SESSION_ID; a tmux pane is never guessed. Subcommands: `mu me tasks` for the owned-tasks records; `mu me next [-n K]` for the top-K ready tasks in this agent's workstream.",
    )
    .option(...JSON_OPT)
    .option("--full", "no cap: the whole read (a cut result names `mu state --me --full`)")
    .action(function () {
      const opts = (this as Command).opts() as { full?: boolean };
      return handle((db) => cmdState(db, { me: true, ...opts }), this as Command)();
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
