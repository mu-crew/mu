// mu — send transport: how `mu agent send` reaches an agent.
//
// A pi agent (speaksMuCtl) is reached through its control socket, served
// by the mu pi extension inside the pane's own pi. `/new`, `/reload` and
// `/compact` become the ctl `command` op; any other slash command is
// refused (pi.sendUserMessage would hand it to the model as text).
// A non-pi agent goes to `mux.sendToPane` when the backend has one (herdr's
// atomic `agent prompt`), else AgentSendUnsupportedError (tmux). No
// silent fallback: a pi agent whose socket does not answer is an
// AgentCtlUnreachableError, never a paste.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRow } from "../agents.js";
import {
  CtlDeliveryUnknownError,
  CtlUnknownOpError,
  CtlVersionError,
  ctlRequest,
  ctlServes,
  errCode,
  newMsgId,
} from "../ctl/client.js";
import { ctlSocketPath } from "../ctl/path.js";
import {
  CTL_COMMANDS,
  type CtlCommandName,
  type CtlFeature,
  type CtlReply,
  type CtlRequest,
  type CtlState,
} from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { activeMux, attachShellLine, type SendOptions } from "../mux.js";
import { shellWord } from "../shell-quote.js";
import {
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentEmptySendError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
  AgentPaneDeadError,
  AgentSendIndeterminateError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
} from "./errors.js";
import { resolveCliCommand, speaksMuCtl } from "./spawn.js";

export type Transport = "ctl" | "mux";

export type SendResult = {
  transport: Transport;
  state?: CtlState;
  /**
   * ctl only: pi's completed-run count. For a plain send it is measured
   * before dispatch (the `mu agent wait --after-runs` baseline); for
   * `--fresh` it is the new session's count once its run started.
   * Absent from an extension that predates it.
   */
  runs?: number;
  /** ctl only: when pi entered `state` (epoch ms), from the same status. */
  since?: number;
  /** ctl only: pi's session file, from the same status. */
  sessionFile?: string;
  /** Set when the text ran as a pi session command over ctl. */
  command?: CtlCommandName;
  /** ctl send/fresh/interrupt: the id this send carried; `mu agent check` asks about it later. */
  msgId?: string;
  /** ctl only: the pi process's incarnation, the `--inc` for `mu agent wait`. */
  incarnation?: string;
  /** Set when the reply never arrived and a `status {msgId}` probe confirmed the send landed. */
  receipt?: "confirmed-after-timeout";
};

export type TransportSendOptions = SendOptions & {
  /** How a busy pi queues the message. Default followUp. ctl only. */
  mode?: "steer" | "followUp";
  /** Control socket path. Default: agentCtlSocket(db, agent). */
  socket?: string;
  /** Start a new pi session and send the text into it, as one ctl op. */
  fresh?: boolean;
  /** With fresh or a session command: abandon a running turn instead of refusing. */
  force?: boolean;
};

/** The agent's derived control socket, rooted at the DB's directory (as spawn does). */
export function agentCtlSocket(db: Db, agent: AgentRow): string {
  return ctlSocketPath(agent.workstreamName, agent.name, dirname(db.name));
}

/**
 * True when the agent runs pi, so sends go through its control socket.
 * The cli key decides when it names pi (or MU_<KEY>_COMMAND here runs
 * pi). Otherwise the agent's own socket file decides: spawn removes any
 * stale file before the pane starts, so a file at the derived path was
 * bound by this agent's extension (or its ssh forward). That covers
 * `--cli helper --command "pi-meta ..."`, whose command is not stored,
 * without a schema change. `sock` defaults to the derived path; pass
 * agentCtlSocket(db, agent) when a DB is at hand.
 */
export function expectsCtl(
  agent: Pick<AgentRow, "cli" | "name" | "workstreamName">,
  sock: string = ctlSocketPath(agent.workstreamName, agent.name),
): boolean {
  return speaksMuCtl(agent.cli, resolveCliCommand(agent.cli)) || existsSync(sock);
}

/** The slash commands a pi agent runs over ctl, as typed. */
export const CTL_SLASH_COMMANDS = CTL_COMMANDS.map((n) => `/${n}`);

/**
 * `text` as a pi session command: `/new`, `/reload`, or `/compact` with
 * optional instructions. undefined for anything else (a plain prompt, or
 * another slash command: see isSlashCommand).
 */
export function parseSessionCommand(
  text: string,
): { name: CtlCommandName; instructions?: string } | undefined {
  const t = text.trim();
  if (t === "/new") return { name: "new" };
  if (t === "/reload") return { name: "reload" };
  const m = /^\/compact(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return undefined;
  const instructions = m[1]?.trim();
  return instructions ? { name: "compact", instructions } : { name: "compact" };
}

/** True when `text` reads as a TUI slash command (`/word ...`), not a path or prose. */
export function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(text.trimStart());
}

/**
 * The recovery inputs of an outdated-extension error that only mu can
 * compute: the mux's own /reload line (when its backend can type one) and
 * the agent's spawn command, rebuilt from its row. Each is omitted when it
 * cannot be filled exactly (a hint mu cannot fill is not printed).
 */
export async function outdatedRecovery(
  agent: AgentRow,
): Promise<{ muxReload?: string; respawn?: string }> {
  let muxReload: string | undefined;
  try {
    const mux = await activeMux();
    if (mux.reloadCommands) muxReload = attachShellLine(mux.reloadCommands(agent.paneId));
  } catch {
    // no reachable mux: the respawn step still stands
  }
  const respawn = respawnCommand(agent);
  return {
    ...(muxReload !== undefined ? { muxReload } : {}),
    ...(respawn !== undefined ? { respawn } : {}),
  };
}

/**
 * The `mu agent spawn` line that recreates `agent`, or undefined for a row
 * older than the stored command. An explicit --command is replayed
 * verbatim; an env or cli-key command is replayed as --cli only (the same
 * resolution happens again). A worktree agent respawns with --worktree.
 */
export function respawnCommand(agent: AgentRow): string | undefined {
  if (agent.command === null || agent.commandSource === null) return undefined;
  const parts = [
    "mu agent spawn",
    shellWord(agent.name),
    "-w",
    shellWord(agent.workstreamName),
    "--cli",
    shellWord(agent.cli),
  ];
  if (agent.commandSource === "explicit") parts.push("--command", shellWord(agent.command));
  if (agent.role !== "full-access") parts.push("--role", shellWord(agent.role));
  if (agent.tab !== null) parts.push("--tab", shellWord(agent.tab));
  if (agent.base !== null) parts.push("--worktree");
  else if (agent.cwd !== null) parts.push("--cwd", shellWord(agent.cwd));
  return parts.join(" ");
}

/**
 * Map a CtlUnknownOpError to AgentExtensionOutdatedError, asking the
 * socket's `hello` (best effort) for the extension's build version.
 */
export async function extensionOutdated(
  agent: AgentRow,
  sock: string,
  e: CtlUnknownOpError,
): Promise<AgentExtensionOutdatedError> {
  let extVersion: string | undefined;
  try {
    const hello = await ctlRequest(sock, { op: "hello" });
    if (hello.ok) extVersion = hello.extVersion;
  } catch {
    // The refusal already proved the socket answers; the version is a nicety.
  }
  return new AgentExtensionOutdatedError(
    agent.name,
    agent.workstreamName,
    e.op,
    extVersion,
    e.ops,
    await outdatedRecovery(agent),
  );
}

/**
 * Before a verb relies on `feature` (msgId for send/fresh/interrupt,
 * incarnation for `wait --inc`): ask the extension's `hello` which features
 * it serves. A pi that loaded an older mu build lacks them: refuse before
 * anything is written, with the reload/respawn ladder. One hello per verb
 * per agent; the reply is returned for the caller.
 */
export async function requireFeature(
  agent: AgentRow,
  sock: string,
  feature: CtlFeature,
): Promise<void> {
  const hello = await ctlRequestFor(agent, sock, { op: "hello" });
  if (!hello.ok) throw new Error(`control socket refused hello: ${hello.error}`);
  if (ctlServes(hello, feature)) return;
  throw new AgentExtensionOutdatedError(
    agent.name,
    agent.workstreamName,
    feature,
    hello.extVersion,
    hello.ops,
    { ...(await outdatedRecovery(agent)), feature: true },
  );
}

/**
 * One ctl request to `agent`, with the failure mapping every ctl verb
 * shares: a version mismatch rethrows, an unknown op becomes
 * AgentExtensionOutdatedError, anything else AgentCtlUnreachableError
 * (missing on ENOENT, else refused).
 */
export async function ctlRequestFor(
  agent: AgentRow,
  sock: string,
  req: CtlRequest,
): Promise<CtlReply> {
  try {
    return await ctlRequest(sock, req);
  } catch (e) {
    throw await ctlFailure(agent, sock, e);
  }
}

/** The error ctlRequestFor raises for a failed ctl request (see there). */
export async function ctlFailure(
  agent: AgentRow,
  sock: string,
  e: unknown,
  /** The msgId the failed request carried: lets an ambiguous delivery name its receipt. */
  msgId?: string,
): Promise<unknown> {
  if (e instanceof CtlVersionError) return e;
  if (e instanceof CtlUnknownOpError) return extensionOutdated(agent, sock, e);
  // A silent socket on a vanished pane is a dead agent, not a link problem.
  if (await paneGone(agent.paneId)) {
    return new AgentPaneDeadError(agent.name, agent.workstreamName, agent.paneId);
  }
  if (e instanceof CtlDeliveryUnknownError) {
    return new AgentSendIndeterminateError(
      agent.name,
      agent.workstreamName,
      e.op,
      e.cause.message,
      msgId,
    );
  }
  return new AgentCtlUnreachableError(
    agent.name,
    agent.workstreamName,
    sock,
    errCode(e) === "ENOENT" ? "missing" : "refused",
  );
}

/** The one `status {msgId}` probe a failed send gets, and `mu agent check`. */
const MSG_PROBE_MS = 5000;

export type MessageCheck =
  | { state: "accepted"; id: string; runs?: number; at?: number; incarnation?: string }
  | { state: "not-accepted"; id: string }
  | { state: "unreachable"; id: string; reason: string };

/**
 * Ask the extension whether it accepted the send/fresh/interrupt that
 * carried `msgId`: one `status {msgId}` request. Never throws: a socket
 * that is silent, missing, or an extension that does not answer with a
 * `msg` is `unreachable`, which is not the same as `not-accepted`.
 */
export async function checkMessage(
  sock: string,
  msgId: string,
  timeoutMs: number = MSG_PROBE_MS,
): Promise<MessageCheck> {
  try {
    const r = await ctlRequest(sock, { op: "status", msgId }, { timeoutMs });
    if (!r.ok) return { state: "unreachable", id: msgId, reason: r.error };
    if (r.msg === undefined) {
      return { state: "unreachable", id: msgId, reason: "the extension does not report receipts" };
    }
    if (!r.msg.accepted) return { state: "not-accepted", id: msgId };
    return {
      state: "accepted",
      id: msgId,
      ...(r.msg.runs !== undefined ? { runs: r.msg.runs } : {}),
      ...(r.msg.at !== undefined ? { at: r.msg.at } : {}),
      ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
    };
  } catch (e) {
    return { state: "unreachable", id: msgId, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A side-effecting ctl request carrying a fresh msgId. When the reply
 * never arrives (written, then silence) it asks `status {msgId}` ONCE:
 * accepted => the send landed (`receipt`); anything else =>
 * AgentSendIndeterminateError naming the msgId. It never resends.
 */
export async function ctlSendWithReceipt(
  agent: AgentRow,
  sock: string,
  req: Extract<CtlRequest, { msgId?: string }>,
): Promise<{
  reply?: Extract<CtlReply, { ok: true }> | { ok: false; error: string };
  msgId: string;
  confirmed?: Extract<MessageCheck, { state: "accepted" }>;
}> {
  const msgId = newMsgId();
  try {
    return { reply: await ctlRequest(sock, { ...req, msgId }), msgId };
  } catch (e) {
    if (!(e instanceof CtlDeliveryUnknownError)) {
      throw await ctlFailure(agent, sock, e, msgId);
    }
    const check = await checkMessage(sock, msgId);
    if (check.state === "accepted") return { msgId, confirmed: check };
    throw await ctlFailure(agent, sock, e, msgId);
  }
}

/** True only when the mux positively reports the pane gone (a mux error is "unknown"). */
async function paneGone(paneId: string): Promise<boolean> {
  try {
    return !(await (await activeMux()).paneAlive(paneId));
  } catch {
    return false;
  }
}

/** How `mu agent send` delivered: the `mode=` of an `agent.send` op. */
export type SendMode = "plain" | "steer" | "interrupt" | "fresh";

/**
 * Record a delivered send as an `agent.send` op. `agents` is machine-local
 * and a send mutates no table, so this emit is the only record that a
 * running worker was told something, and when. `fields` carries pi's
 * pre-send state (`since` as ISO) so an audit can see a worker stuck in
 * one long turn when a plain/steer send queued behind it.
 */
export function recordSend(
  db: Db,
  agent: Pick<AgentRow, "name" | "workstreamName">,
  mode: SendMode,
  bytes: number,
  fields: Record<string, string | number | boolean | undefined>,
  /** Who sent it (resolveActorIdentity); lands in `ops.actor`. */
  source = "system",
): void {
  const detail = Object.entries({ mode, ...fields })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${k === "since" ? new Date(Number(v)).toISOString() : v}`)
    .join(" ");
  emitEvent(
    db,
    agent.workstreamName,
    "agent.send",
    `agent send ${agent.name} (${detail}, ${bytes} bytes)`,
    source,
  );
}

export async function sendViaTransport(
  agent: AgentRow,
  text: string,
  // Required: only the caller knows the DB whose directory roots the socket.
  opts: TransportSendOptions & { socket: string },
): Promise<SendResult> {
  const sock = opts.socket;
  if (!expectsCtl(agent, sock)) {
    if (opts.fresh) throw new AgentFreshNeedsCtlError(agent.name, agent.workstreamName, agent.cli);
    // Load-bearing: a send that cannot reach a pane is a failed send.
    const mux = await activeMux();
    if (!mux.sendToPane) {
      throw new AgentSendUnsupportedError(agent.name, agent.workstreamName, agent.cli);
    }
    await mux.sendToPane(agent.paneId, text, opts);
    return { transport: "mux" };
  }
  if (text === "") throw new AgentEmptySendError(agent.name, agent.workstreamName);
  if (!opts.fresh) {
    const cmd = parseSessionCommand(text);
    if (cmd) return runSessionCommand(agent, sock, cmd, opts.force === true);
    if (isSlashCommand(text)) {
      throw new AgentSlashCommandUnsupportedError(
        agent.name,
        agent.workstreamName,
        text,
        CTL_SLASH_COMMANDS,
      );
    }
  }
  // Receipts need an extension that remembers msgIds: refuse before writing.
  await requireFeature(agent, sock, "msgId");
  const sent = await ctlSendWithReceipt(
    agent,
    sock,
    opts.fresh
      ? { op: "fresh", text, ...(opts.force ? { force: true } : {}) }
      : { op: "send", text, mode: opts.mode ?? "followUp" },
  );
  const { reply, msgId } = sent;
  if (reply !== undefined && !reply.ok) {
    if (opts.fresh && reply.error === "busy") {
      throw new AgentBusyError(agent.name, agent.workstreamName);
    }
    throw new Error(`control socket refused the send: ${reply.error}`);
  }
  if (reply === undefined) {
    // No reply, but status {msgId} says it landed: the run count is the
    // one the reply would have carried; state and since are unknown.
    const c = sent.confirmed;
    return {
      transport: "ctl",
      msgId,
      receipt: "confirmed-after-timeout",
      ...(c?.runs !== undefined ? { runs: c.runs } : {}),
      ...(c?.incarnation !== undefined ? { incarnation: c.incarnation } : {}),
    };
  }
  return {
    transport: "ctl",
    msgId,
    ...(reply.incarnation !== undefined ? { incarnation: reply.incarnation } : {}),
    ...(reply.state !== undefined ? { state: reply.state } : {}),
    ...(reply.runs !== undefined ? { runs: reply.runs } : {}),
    ...(reply.since !== undefined ? { since: reply.since } : {}),
    ...(reply.sessionFile !== undefined ? { sessionFile: reply.sessionFile } : {}),
  };
}

/** `/new`, `/reload` or `/compact` inside pi, through the ctl `command` op. */
async function runSessionCommand(
  agent: AgentRow,
  sock: string,
  cmd: { name: CtlCommandName; instructions?: string },
  force: boolean,
): Promise<SendResult> {
  const reply = await ctlRequestFor(agent, sock, {
    op: "command",
    name: cmd.name,
    ...(cmd.instructions !== undefined ? { instructions: cmd.instructions } : {}),
    ...(force ? { force: true } : {}),
  });
  if (!reply.ok) {
    if (reply.error === "busy") {
      throw new AgentBusyError(agent.name, agent.workstreamName, `/${cmd.name}`);
    }
    throw new Error(`pi refused /${cmd.name}: ${reply.error}`);
  }
  return {
    transport: "ctl",
    command: cmd.name,
    ...(reply.state !== undefined ? { state: reply.state } : {}),
  };
}
