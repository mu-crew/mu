// mu — every `mu agent ...` verb + spawn / read / list / show / close
// (send is `agent-send.ts`) + the top-level `mu me` agent-self
// verb (default + `tasks` / `next` subcommands).
//
// `mu me` / `mu me tasks` / `mu me next` are the agent-self verbs
// (`cmdMyTasks` and `cmdMyNext` back the last two).

import { dirname } from "node:path";
import { agentToOutput, liveAgentToOutput, workstreamIdOf } from "../agent-output.js";
import { agentKey, type RuntimeState } from "../agent-state.js";
import { isCommandGate } from "../agents/spawn.js";
import { resolveFirstTurn } from "../agents/spawn-plugin.js";
import {
  AgentCtlUnreachableError,
  AgentNotFoundError,
  AgentSendIndeterminateError,
  abortAgent,
  delegateOutcome,
  getAgent,
  listLiveAgents,
  readAgent,
  resolveCliCommand,
  resolveCliCommandWithSource,
  type SendChannel,
  type SpawnedAgent,
  sendToAgent,
  spawnAgent,
  spawnForTask,
} from "../agents.js";
import {
  agentChannel,
  blockedReason,
  channelNamed,
  channelTarget,
  type MessageCheck,
  readAgentStates,
  requireFeature,
} from "../channels/index.js";
import {
  applyQualifiedRef,
  assertAgentInWorkstream,
  CliExitError,
  classifyError,
  emitJson,
  formatAgentsTable,
  resolveEntityRef,
  resolveExistingWorkstream,
  resolveWorkstream,
  statusIcon,
  UsageError,
} from "../cli.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { leftoverLines, listLeftovers } from "../leftovers.js";
import { say } from "../messages.js";
import { activeMux, attachShellLine } from "../mux.js";
import { pc } from "../output.js";
import { checkDelivery } from "../plugins/channel.js";
import { buildTaskBrief, TaskBriefMissingError } from "../task-brief.js";
import { getTask } from "../tasks/queries.js";
import { type WaitSnapshot, waitForEvents } from "../wait.js";
import { ctlAgentHooks } from "../wait-ctl.js";
import { wireAnswerCommand } from "./agent-answer.js";
import { wireCloseCommand } from "./agent-close.js";
import { wireCollectCommand } from "./agent-collect.js";
import { wireReattachCommand } from "./agent-reattach.js";
import { cmdSend } from "./agent-send.js";
import { setNextOutcome } from "./handle.js";
import { readStdinText, STDIN_ARG } from "./stdin.js";
import { installWaitSignals, type WaitSignals } from "./wait.js";
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
  /** Bind the spawn to this task: claim it for the new agent and send the text as its brief (default text: the task's brief). */
  task?: string;
  /** With `--task`: the attempt's name (default: the task id). Replays of a name never send twice. */
  attempt?: string;
  /** Passed to the harness through its row's model flag (spec D17). */
  model?: string;
  json?: boolean;
  signal?: AbortSignal;
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
    // With --host, --root alone names the remote repo the agent starts in.
    if (flag === "root" && opts.host !== undefined) continue;
    if (opts[flag] !== undefined) throw new UsageError(say("agent.spawn_needs_worktree", flag));
  }
}

// A remote command gate runs one command and reports its exit: it takes no
// brief, task or worktree. Refused before any effect (stdin read included).
function assertGateFlags(opts: SpawnOpts): void {
  if (!isCommandGate(opts)) return;
  for (const flag of ["task", "send", "attempt", "model"] as const) {
    if (opts[flag] !== undefined) {
      throw new UsageError(say("agent.spawn_gate_flag", flag));
    }
  }
  if (opts.worktree) {
    throw new UsageError(say("agent.spawn_gate_worktree"));
  }
}

// `--model` goes through a harness row's model flag: a CLI outside the blessed
// five has none, so the model would be dropped without a word (spec D17).
function assertModelFlag(opts: SpawnOpts): void {
  if (opts.model === undefined || isCommandGate(opts)) return;
  const cli = opts.cli ?? "pi";
  const command = opts.command ?? (opts.host !== undefined ? cli : resolveCliCommand(cli));
  if (harnessOfCli(cli, command) === undefined) {
    throw new UsageError(say("agent.spawn_model_unknown_cli", cli));
  }
}

export async function cmdSpawn(
  db: Db,
  rawName: string,
  opts: SpawnOpts,
  sig?: WaitSignals,
): Promise<void> {
  try {
    await spawnOnce(db, rawName, { ...opts, ...(sig ? { signal: sig.signal } : {}) });
  } catch (err) {
    // SIGINT/SIGTERM rolled the spawn back (pane, row, worktree, git child).
    const which = sig?.which();
    if (which === undefined) throw err;
    const message = `${which} during spawn of ${rawName}: rolled back (${err instanceof Error ? err.message : String(err)})`;
    if (!opts.json) console.error(message);
    throw new CliExitError(
      which === "SIGTERM" ? 143 : 130,
      opts.json ? { error: "SpawnInterruptedError", message } : undefined,
    );
  }
}

/** What `--task` sends when `--send` is absent: the task's brief (as `mu task auto` builds it), or,
 *  with no brief note, one line from its title. That line carries no footer: it is pinned as the brief. */
function taskBriefText(db: Db, workstream: string, task: string): string {
  try {
    return buildTaskBrief(db, workstream, task).text;
  } catch (err) {
    if (!(err instanceof TaskBriefMissingError)) throw err;
    const title = getTask(db, task, workstream)?.title ?? task;
    return say("agent.spawn_task_default", task, workstream, title);
  }
}

async function spawnOnce(db: Db, rawName: string, opts: SpawnOpts): Promise<void> {
  assertGateFlags(opts);
  assertModelFlag(opts);
  // Spawn is a create path: the first spawn into a workstream creates it (insertAgent), as
  // `scratch` does. Every other verb refuses an unknown -w.
  const workstream = await resolveWorkstream(opts.workstream);
  // Read stdin before any side effect: an empty pipe must not leave a pane.
  // `--task` without `--send` sends the task's own brief (what `mu auto` sends).
  const sendText =
    opts.send === undefined
      ? opts.task === undefined
        ? undefined
        : taskBriefText(db, workstream, opts.task)
      : opts.send === STDIN_ARG
        ? await readStdinText("send text")
        : opts.send;

  assertWorktreeFlags(opts);
  if (opts.attempt !== undefined && opts.task === undefined) {
    throw new UsageError(say("agent.spawn_attempt_task"));
  }
  if (opts.task !== undefined && sendText !== undefined) {
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
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(sendText !== undefined ? { firstPrompt: sendText } : {}),
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
      : agent.firstSend !== undefined
        ? // An at-start plugin kind's job.start delivered it (plugins spec D8): never sent again.
          {
            ok: true,
            sentBytes: Buffer.byteLength(sendText),
            transport: agent.firstSend.transport,
            ...(agent.firstSend.runs !== undefined ? { runs: agent.firstSend.runs } : {}),
            ...(agent.firstSend.msgId !== undefined ? { msgId: agent.firstSend.msgId } : {}),
            ...(agent.firstSend.incarnation !== undefined
              ? { incarnation: agent.firstSend.incarnation }
              : {}),
            delivery: "delivered" as const,
            delivered: true,
          }
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
  // $MU_<UPPER_CLI>_COMMAND > the cli value itself. 'Spawned ... (pi)'
  // was misleading when --command overrode the binary.
  const resolvedCommand = opts.command ?? resolveCliCommand(agent.cli);
  const commandOverridden = resolvedCommand !== agent.cli;
  // When the override came from an env var (no explicit --command), the success
  // line names it, so a stale $MU_<CLI>_COMMAND is visible without `mu agent show`.
  // An explicit --command is shown via the `(cmd: ...)` suffix below.
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
  // operator can grep for / unset.
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
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
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
          ...(out.send?.readyScreen !== undefined ? { readyScreen: out.send.readyScreen } : {}),
          ...(out.send?.submitRetry ? { submitRetry: true as const } : {}),
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
  } else if (
    out.state === "unknown" &&
    channelNamed(rec.transport, db)?.caps.receipt === "exact" &&
    out.stale === undefined
  ) {
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
      pc.yellow(
        out.stale === "deleted"
          ? `  the agent of this attempt is gone; nothing runs for it`
          : `  the name now belongs to another agent; it was left alone`,
      ),
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
      transport: SendChannel;
      state?: string;
      runs?: number;
      /** The send's receipt id (`mu agent check`) and pi's incarnation (`wait --inc`). */
      msgId?: string;
      incarnation?: string;
      delivery?: "delivered";
      /** pi's session file, where the delegate's transcript is written. */
      sessionFile?: string;
      /** hooks: how the first paste's wait for the harness's ready screen ended. */
      readyScreen?: "ready" | "timeout" | "unread";
      /** hooks: the submit key was pressed once more for a paste left unsubmitted. */
      submitRetry?: true;
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
      ...(sent.readyScreen !== undefined ? { readyScreen: sent.readyScreen } : {}),
      ...(sent.submitRetry ? { submitRetry: true as const } : {}),
      delivered: !undelivered,
    };
  } catch (err) {
    return fail(err);
  }
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
  const ws = await resolveExistingWorkstream(db, opts.workstream);
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
  const workstream = await resolveExistingWorkstream(db, opts.workstream);
  const view = await listLiveAgents(db, { workstream });
  const leftovers = await listLeftovers(db, workstream);
  if (opts.json) {
    const wsId = workstreamIdOf(db, workstream);
    emitJson({
      workstreamName: workstream,
      agents: view.agents.map((a) => liveAgentToOutput(a, wsId)),
      orphans: view.orphans,
      leftovers,
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
  for (const line of leftoverLines(leftovers)) console.log(line);
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
  const ws = await resolveExistingWorkstream(db, opts.workstream);
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

  const reading = (await readAgentStates([agent], { stateDir: dirname(db.name), db })).get(
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
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const agent = getAgent(db, name, ws);
  if (agent === undefined) throw new AgentNotFoundError(name, ws);
  // A receipt is the channel's: a pi on the `hooks` fallback is never asked over ctl (spec D15).
  const target = channelTarget(db, agent);
  // An at-start kind's first prompt went with job.start: its job record answers (plugins spec D8).
  const first = await resolveFirstTurn(db, agent, msgId);
  const check: MessageCheck =
    first === undefined || first.state === "never"
      ? // An unresolved plugin delivery resolves by its rule-table row first (plugins spec D4).
        ((await checkDelivery(db, agent.incarnation, msgId)) ??
        (await agentChannel(target).receipt(target, msgId)))
      : first.state === "accepted"
        ? {
            state: "accepted",
            id: msgId,
            runs: 0,
            ...(first.incarnation ? { incarnation: first.incarnation } : {}),
          }
        : { state: "unreachable", id: msgId, reason: first.reason };
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
  const ws = await resolveExistingWorkstream(db, opts.workstream);
  const result = await abortAgent(db, name, {
    workstream: ws,
    ...(opts.timeout === undefined ? {} : { timeoutMs: Math.round(opts.timeout * 1000) }),
  });
  if (opts.json) {
    emitJson(result);
    return;
  }
  // hooks: a harness that reports no interrupt (claude) reads idle? until its next event.
  const after = result.stopped === "unconfirmed" ? "idle?" : result.after;
  console.log(
    result.aborted
      ? `Aborted ${pc.bold(name)} ${pc.dim(`(${result.before} → ${after} in ${result.elapsedMs}ms)`)}`
      : `${pc.bold(name)} was ${result.before}; nothing to abort`,
  );
  if (result.stopped === "unconfirmed")
    console.error(pc.yellow(say("agent.interrupt_unconfirmed", name)));
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
 * The task-less, agent-keyed form of `mu wait` (same engine, own document): scratch / off-the-cuff
 * helpers have no task in the DAG, so the only "done" signal is the
 * agent's own runtime status. An agent fires when it goes **busy → any
 * other state** (it must be observed busy first, so an already-idle
 * agent doesn't fire instantly — you're waiting for THIS work to end).
 *
 * One timeout rule with `mu wait`: a timeout is ok:true with `timedOut`, exit 0;
 * run the same command again to keep waiting (`--after-runs` makes that lossless:
 * a run that settled in between still fires). Exit 6 = a watched agent's pane died; 7 = a pi agent is
 * waiting on an extension dialog (needs a human).
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
      const workstreamName = await resolveExistingWorkstream(db, local.workstream);
      return { name, workstreamName };
    }),
  );

  // --after-runs is a ctl run count: refuse an agent that has none
  // rather than silently polling it with no baseline.
  if (opts.afterRuns !== undefined) {
    for (const ref of refs) {
      const agent = getAgent(db, ref.name, ref.workstreamName);
      if (agent !== undefined && agentChannel(channelTarget(db, agent)).name !== "ctl") {
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
      const target = channelTarget(db, agent);
      if (agentChannel(target).name !== "ctl") {
        throw new UsageError(
          say("agent.wait_inc_pi", `${ref.workstreamName}/${ref.name}`, agent.cli),
        );
      }
      await requireFeature(target, "incarnation");
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

  // 6 (a watched pane died, even when others finished) wins over 7 (a dialog);
  // a met condition and a timeout are both 0 (`timedOut` says which).
  if (dead.length > 0) {
    process.exitCode = 6;
  } else if (blocked.length > 0) {
    process.exitCode = 7;
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
      "with --worktree: the repo to add it to (default: the git root of your cwd). With --host: a REMOTE repo (default the profile's --repo), also without --worktree, as the start directory",
    )
    .option(
      "--host <profile>",
      "run on this host profile (mu host add): the pane runs its --shell template, which starts the remote pi and forwards its control socket here; --cwd and --worktree name REMOTE paths (the worktree is made by its --exec, under ~/.local/state/mu-next/remote-worktrees/<ws>/<name>); --root names the remote repo; the pane dying is the agent dying. tmux only",
    )
    .option("--no-ctl", "skip the control-socket handshake with the mu pi extension")
    .option(
      "--model <id>",
      "the model, passed through the harness's own model flag (--model for claude, codex, cursor-agent, muse and pi)",
    )
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
      "bind the spawn to this task: claim it for the new agent after the pane exists, then send --send's text (default: the task's brief note, else its title) as its brief (pinned once delivered, kept when the task already has one). One journaled attempt: a failure before the send rolls back its own pane and claim; an unknown delivery keeps both and is never resent",
    )
    .option(
      "--attempt <key>",
      "with --task: name this attempt (default: the task id). The same key replays its saved outcome and never sends a second prompt; a delivered attempt whose agent is gone (closed, reaped) exits 4 and names the next key; reopened work needs a new key",
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
        model?: string;
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
      const sig = installWaitSignals();
      const run = handle((db) => cmdSpawn(db, name, opts, sig), this as Command);
      return run().finally(() => sig.dispose());
    });

  agent
    .command("send <name> <text>")
    .description(
      "Send text: pi over its control socket, a hook harness on tmux by paste (confirmed by run count), other CLIs on herdr or Rex. --fresh = new session + send. Text `-` reads stdin: mu agent send <name> - <<'EOF'.",
    )
    .option(
      "--steer",
      "pi (control socket) only: if busy, deliver after the current tool calls finish, before the next model call (default: after the run ends); does not stop a running tool: use --interrupt. A hook harness refuses it; another CLI in a herdr or Rex pane gets a plain send",
    )
    .option(
      "--interrupt",
      "if busy, abort the current run (pi: kills the running tool, queued messages go back to the editor; a hook harness: Escape, confirmed by its interrupt event, or idle? on claude), wait for it to settle, then send the text as a new run. Exit 5 if it does not settle; the text is then not sent",
    )
    .option(
      "--timeout <seconds>",
      "with --interrupt: max seconds to wait for the stop to be confirmed: pi, or a local hook harness that reports its interrupt (codex, muse, cursor-agent); claude and remote hook workers are not waited on (default 30)",
      parsePositiveNumber,
    )
    .option(
      "--fresh",
      "new session + this prompt: pi in one operation, a hook harness by its fresh command (/clear, /new, /new-chat) then a paste; refused with exit 4 while it is busy",
    )
    .option(
      "--force",
      "with --fresh or a pi /new, /reload, /compact: abandon a running turn instead of refusing; to a hook harness: paste even while it runs or its state is unknown (never into a dialog)",
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
      "Ask whether a send landed: one status probe for its msgId. Prints `accepted runs=<n> at=<iso>` (0), `not-accepted` (3; an evicted or in-flight send reads the same: read the pane before resending) or `unreachable` (1).",
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
    .description(
      "List agents in the current workstream (reconciled with the active mux). One JSON document by default; --table for the human table",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .option("--table", "print the human table instead of the JSON document")
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        table?: boolean;
      };
      // JSON unless --table; an explicit --json wins (isJsonMode reads argv the same way).
      opts.json = opts.json === true || opts.table !== true;
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
  wireAnswerCommand(agent);
  wireReattachCommand(agent);

  // `mu agent abort` — stop a pi agent's turn through its control socket.
  agent
    .command("abort <name>")
    .description(
      "Stop an agent's turn and wait for it to settle: pi over its control socket, a hook harness by Escape (claude: idle?). Idle agents are left alone. Exit 5 if still busy after --timeout. Else: `mu agent close`.",
    )
    .option(
      "--timeout <seconds>",
      "max seconds to wait for the stop to be confirmed: pi, or a local hook harness that reports its interrupt (codex, muse, cursor-agent); claude and remote hook workers are not waited on (default 30)",
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

  // `mu agent wait` — the task-less, agent-keyed form of `mu wait`. Block
  // until agents finish (busy → any other state). For scratch /
  // off-the-cuff helpers that own no task to wait on.
  agent
    .command("wait <names...>")
    .description(
      "Block until agents leave busy; fires on needs_input too. For task work prefer `mu wait`. A pi agent opening a dialog ends it as `blocked`. Exit 0 met or timed out (`timedOut`), 6 pane died, 7 dialog.",
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
      "The caller's own state, exactly `mu state --me`: identity ($MU_AGENT_NAME in $MU_WORKSTREAM, or pi:$PI_SESSION_ID; never a pane), owned and ready tasks, its delegates and human needs. `mu me tasks` / `mu me next [-n K]` list them.",
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
