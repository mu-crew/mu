// mu — delivery on the `ctl` channel: send, fresh, command, interrupt and
// abort to a pi agent over its control socket, served by the mu pi extension
// inside the pane's own pi.
//
// `/new`, `/reload` and `/compact` become the ctl `command` op; any other
// slash command is refused (pi.sendUserMessage would hand it to the model as
// text). No silent fallback: a pi agent whose socket does not answer is an
// AgentCtlUnreachableError, never a paste.
//
// Every side-effecting op goes through one incarnation fence (`fencedHello`)
// and carries a msgId: a reply that never arrives is probed ONCE with
// `status {msgId}` (`checkMessage`), never resent.

import {
  AgentAbortTimeoutError,
  AgentAnswerUnsupportedError,
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentEmptySendError,
  AgentExtensionOutdatedError,
  AgentPaneDeadError,
  AgentReplacedError,
  AgentRestartedError,
  AgentSendIndeterminateError,
  AgentSendRefusedError,
  AgentSendUnsupportedError,
  AgentSlashCommandUnsupportedError,
} from "../agents/errors.js";
import type { AgentRow } from "../agents.js";
import {
  CtlDeliveryUnknownError,
  CtlUnknownOpError,
  CtlVersionError,
  CtlWriteVetoedError,
  ctlRequest,
  ctlServes,
  errCode,
  newMsgId,
} from "../ctl/client.js";
import {
  CTL_COMMANDS,
  type CtlCommandName,
  type CtlFeature,
  type CtlReply,
  type CtlRequest,
  INCARNATION_MISMATCH,
} from "../ctl/protocol.js";
import { say } from "../messages.js";
import { activeMux, attachShellLine } from "../mux.js";
import { shellWord } from "../shell-quote.js";
import { targetSocket } from "./select.js";
import type {
  AbortOutcome,
  ChannelDelivery,
  CtlGuard,
  DeliveryOptions,
  DeliveryTarget,
  InterruptResult,
  MessageCheck,
  SendResult,
  SessionCommand,
} from "./types.js";

/** The one `status {msgId}` probe a failed send gets, and `mu agent check`. */
const MSG_PROBE_MS = 5000;

/** The slash commands a pi agent runs over ctl, as typed. */
export const CTL_SLASH_COMMANDS = CTL_COMMANDS.map((n) => `/${n}`);

/**
 * `text` as a pi session command: `/new`, `/reload`, or `/compact` with
 * optional instructions. undefined for anything else (a plain prompt, or
 * another slash command: see isSlashCommand).
 */
export function parseSessionCommand(text: string): SessionCommand | undefined {
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
 * resolution happens again). A worktree agent respawns with --worktree (a
 * remote one with --root, its recorded repo).
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
  if (agent.host !== null) parts.push("--host", shellWord(agent.host));
  if (agent.role !== "full-access") parts.push("--role", shellWord(agent.role));
  if (agent.tab !== null) parts.push("--tab", shellWord(agent.tab));
  if (agent.base !== null) {
    parts.push("--worktree");
    // A remote worktree's repo was chosen at spawn: without it the respawn lands in the default.
    if (agent.host !== null && agent.repo !== null) parts.push("--root", shellWord(agent.repo));
  } else if (agent.cwd !== null) parts.push("--cwd", shellWord(agent.cwd));
  return parts.join(" ");
}

/**
 * Map a CtlUnknownOpError to AgentExtensionOutdatedError, asking the
 * socket's `hello` (best effort) for the extension's build version.
 */
async function extensionOutdated(
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
 * per agent; the hello's incarnation is returned for the caller.
 */
export async function requireFeature(
  target: DeliveryTarget,
  feature: CtlFeature,
): Promise<string | undefined> {
  return (await fencedHello(target.agent, targetSocket(target), { feature })).inc;
}

/**
 * The one incarnation fence every side-effecting ctl op (send, fresh,
 * interrupt, command) goes through. One hello, then:
 *  - `feature` (if any) must be served, else AgentExtensionOutdatedError;
 *  - an explicit `expect` that is not the hello's incarnation is refused
 *    (AgentReplacedError, nothing written);
 *  - `bound` is the field to put on the request: the explicit `expect`, else
 *    the hello's own incarnation, so a pi that binds the socket after the
 *    hello refuses the write. An op the extension may not fence (`needsFence`:
 *    interrupt, command; an older extension ignores the field there) gets the
 *    implicit fence only when hello lists `fence`, and an explicit one is
 *    refused (op `fence`) rather than silently dropped.
 */
async function fencedHello(
  agent: AgentRow,
  sock: string,
  o: { feature?: CtlFeature; expect?: string; needsFence?: boolean; guard?: CtlGuard },
): Promise<{ inc: string | undefined; bound: { expectIncarnation?: string } }> {
  // The write fence is for the send alone: the hello is a read.
  const hello = await ctlRequestFor(agent, sock, { op: "hello" }, withGuard(o.guard, false));
  if (!hello.ok) throw new Error(say("agent.ctl_refused", "hello", hello.error));
  const outdated = async (feature: string) =>
    new AgentExtensionOutdatedError(
      agent.name,
      agent.workstreamName,
      feature,
      hello.extVersion,
      hello.ops,
      { ...(await outdatedRecovery(agent)), feature: true },
    );
  if (o.feature !== undefined && !ctlServes(hello, o.feature)) throw await outdated(o.feature);
  const inc = hello.incarnation;
  const fenced = o.needsFence !== true || ctlServes(hello, "fence");
  if (o.expect !== undefined) {
    // The hello already names another pi (or none): refuse before any write.
    if (inc !== o.expect) throw new AgentReplacedError(agent.name, agent.workstreamName, "sent to");
    if (!fenced) throw await outdated("fence");
    return { inc, bound: { expectIncarnation: o.expect } };
  }
  return { inc, bound: inc !== undefined && fenced ? { expectIncarnation: inc } : {} };
}

/**
 * One ctl request to `agent`, with the failure mapping every ctl verb
 * shares: a version mismatch rethrows, an unknown op becomes
 * AgentExtensionOutdatedError, anything else AgentCtlUnreachableError
 * (missing on ENOENT, else refused).
 */
async function ctlRequestFor(
  agent: AgentRow,
  sock: string,
  req: CtlRequest,
  guard?: Pick<CtlGuard, "signal" | "timeoutMs">,
): Promise<CtlReply> {
  try {
    return await ctlRequest(sock, req, withGuard(guard));
  } catch (e) {
    throw await ctlFailure(agent, sock, e);
  }
}

const withGuard = (g?: CtlGuard, fence = true) => ({
  ...(g?.signal !== undefined ? { signal: g.signal } : {}),
  ...(g?.timeoutMs !== undefined ? { timeoutMs: g.timeoutMs } : {}),
  ...(fence && g?.beforeWrite !== undefined ? { beforeWrite: g.beforeWrite } : {}),
});

/** The error ctlRequestFor raises for a failed ctl request (see there). */
async function ctlFailure(
  agent: AgentRow,
  sock: string,
  e: unknown,
  /** The msgId the failed request carried: lets an ambiguous delivery name its receipt. */
  msgId?: string,
  incarnation?: string,
): Promise<unknown> {
  if (e instanceof CtlVersionError) return e;
  if (e instanceof CtlUnknownOpError) return extensionOutdated(agent, sock, e);
  // A silent socket on a vanished pane is a dead agent, not a link problem.
  // A request that was WRITTEN before the pane died may still have landed:
  // the error keeps its msgId as that evidence (a dead pane does not prove
  // the prompt was never delivered).
  if (await paneGone(agent.paneId)) {
    return new AgentPaneDeadError(
      agent.name,
      agent.workstreamName,
      agent.paneId,
      e instanceof CtlDeliveryUnknownError ? msgId : undefined,
    );
  }
  if (e instanceof CtlDeliveryUnknownError) {
    return new AgentSendIndeterminateError(
      agent.name,
      agent.workstreamName,
      e.op,
      e.cause.message,
      msgId,
      incarnation,
      agent.incarnation,
    );
  }
  return new AgentCtlUnreachableError(
    agent.name,
    agent.workstreamName,
    sock,
    errCode(e) === "ENOENT" ? "missing" : "refused",
    agent.host,
  );
}

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
async function ctlSendWithReceipt(
  agent: AgentRow,
  sock: string,
  req: Extract<CtlRequest, { msgId?: string }>,
  /** The incarnation the preflight hello named: the error carries it when delivery stays unknown. */
  incarnation?: string,
  /** A msgId the caller reserved before the send (see DeliveryOptions.msgId). */
  reservedMsgId?: string,
  guard?: CtlGuard,
): Promise<{
  reply?: Extract<CtlReply, { ok: true }> | { ok: false; error: string };
  msgId: string;
  confirmed?: Extract<MessageCheck, { state: "accepted" }>;
}> {
  const msgId = reservedMsgId ?? newMsgId();
  try {
    return { reply: await ctlRequest(sock, { ...req, msgId }, withGuard(guard)), msgId };
  } catch (e) {
    // The fence said no before the write: nothing was sent, and it is not a link failure.
    if (e instanceof CtlWriteVetoedError) throw e;
    if (!(e instanceof CtlDeliveryUnknownError)) {
      throw await ctlFailure(agent, sock, e, msgId, incarnation);
    }
    // The probe is its own bounded request: an abort of the send must not skip it.
    const check = await checkMessage(sock, msgId, guard?.timeoutMs);
    if (check.state === "accepted") return { msgId, confirmed: check };
    throw await ctlFailure(agent, sock, e, msgId, incarnation);
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

/** A plain send: a session command runs as `command`, any other slash command is refused. */
async function ctlSend(
  target: DeliveryTarget,
  text: string,
  opts: DeliveryOptions,
): Promise<SendResult> {
  const { agent } = target;
  if (text === "") throw new AgentEmptySendError(agent.name, agent.workstreamName);
  const cmd = parseSessionCommand(text);
  if (cmd) {
    // The command route has no write fence: refuse rather than skip it.
    if (opts.ctlGuard?.beforeWrite !== undefined) {
      throw new AgentSendUnsupportedError(agent.name, agent.workstreamName, agent.cli);
    }
    return ctlCommand(target, cmd, {
      force: opts.force === true,
      ...(opts.expectIncarnation !== undefined
        ? { expectIncarnation: opts.expectIncarnation }
        : {}),
    });
  }
  if (isSlashCommand(text)) {
    throw new AgentSlashCommandUnsupportedError(
      agent.name,
      agent.workstreamName,
      text,
      CTL_SLASH_COMMANDS,
    );
  }
  return ctlWrite(target, text, opts, false);
}

/** `--fresh`: a new pi session with `text` as its first prompt, one ctl op. */
async function ctlFresh(
  target: DeliveryTarget,
  text: string,
  opts: DeliveryOptions,
): Promise<SendResult> {
  const { agent } = target;
  if (text === "") throw new AgentEmptySendError(agent.name, agent.workstreamName);
  return ctlWrite(target, text, opts, true);
}

/** The fenced, receipted `send` or `fresh` op. */
async function ctlWrite(
  target: DeliveryTarget,
  text: string,
  opts: DeliveryOptions,
  fresh: boolean,
): Promise<SendResult> {
  const { agent } = target;
  const sock = targetSocket(target);
  // Receipts need an extension that remembers msgIds: refuse before writing.
  const { inc, bound } = await fencedHello(agent, sock, {
    feature: "msgId",
    ...(opts.expectIncarnation !== undefined ? { expect: opts.expectIncarnation } : {}),
    guard: opts.ctlGuard,
  });
  const expect = bound.expectIncarnation;
  const sent = await ctlSendWithReceipt(
    agent,
    sock,
    fresh
      ? { op: "fresh", text, ...(opts.force ? { force: true } : {}), ...bound }
      : { op: "send", text, mode: opts.mode ?? "followUp", ...bound },
    inc,
    opts.msgId,
    opts.ctlGuard,
  );
  const { reply, msgId } = sent;
  if (reply !== undefined && !reply.ok) {
    // The extension's own check: bound at the socket, atomic with the dispatch.
    if (expect !== undefined && reply.error === INCARNATION_MISMATCH) {
      throw new AgentReplacedError(agent.name, agent.workstreamName, "sent to");
    }
    if (fresh && reply.error === "busy") {
      throw new AgentBusyError(agent.name, agent.workstreamName);
    }
    throw new AgentSendRefusedError(reply.error);
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
async function ctlCommand(
  target: DeliveryTarget,
  cmd: { name: CtlCommandName; instructions?: string },
  opts: { force?: boolean; expectIncarnation?: string },
): Promise<SendResult> {
  const { agent } = target;
  const sock = targetSocket(target);
  const expect = opts.expectIncarnation;
  const { bound } = await fencedHello(agent, sock, {
    needsFence: true,
    ...(expect !== undefined ? { expect } : {}),
  });
  const reply = await ctlRequestFor(agent, sock, {
    op: "command",
    name: cmd.name,
    ...(cmd.instructions !== undefined ? { instructions: cmd.instructions } : {}),
    ...(opts.force ? { force: true } : {}),
    ...bound,
  });
  if (!reply.ok) {
    if (expect !== undefined && reply.error === INCARNATION_MISMATCH) {
      throw new AgentReplacedError(agent.name, agent.workstreamName, "sent to");
    }
    if (reply.error === "busy") {
      throw new AgentBusyError(agent.name, agent.workstreamName, `/${cmd.name}`);
    }
    throw new Error(say("agent.pi_refused", cmd.name, reply.error));
  }
  return {
    transport: "ctl",
    command: cmd.name,
    ...(reply.state !== undefined ? { state: reply.state } : {}),
  };
}

/**
 * abort + send as one ctl op with a msgId receipt; an extension without
 * msgId is refused up front (AgentExtensionOutdatedError), never half-served.
 */
async function ctlInterrupt(
  target: DeliveryTarget,
  text: string,
  opts: { timeoutMs: number; expectIncarnation?: string },
): Promise<InterruptResult> {
  const { agent } = target;
  const name = agent.name;
  const ws = agent.workstreamName;
  const sock = targetSocket(target);
  const { timeoutMs } = opts;
  const { inc, bound } = await fencedHello(agent, sock, {
    feature: "msgId",
    needsFence: true,
    ...(opts.expectIncarnation !== undefined ? { expect: opts.expectIncarnation } : {}),
  });
  const sent = await ctlSendWithReceipt(
    agent,
    sock,
    { op: "interrupt", text, timeoutMs, ...bound },
    inc,
  );
  const { reply: r, msgId } = sent;
  if (r === undefined) {
    // Written, no reply, but status {msgId} says pi took it: wasBusy and
    // pending are unknown, so they read false.
    const c = sent.confirmed;
    return {
      wasBusy: false,
      pending: false,
      msgId,
      receipt: "confirmed-after-timeout",
      ...(c?.runs !== undefined ? { runs: c.runs } : {}),
      ...(c?.incarnation !== undefined ? { incarnation: c.incarnation } : {}),
    };
  }
  if (!r.ok) {
    if (r.error === INCARNATION_MISMATCH) throw new AgentReplacedError(name, ws, "sent to");
    if (r.error === "timeout") throw new AgentAbortTimeoutError(name, ws, timeoutMs);
    throw new Error(say("agent.ctl_refused", "the interrupt", r.error));
  }
  return {
    wasBusy: r.wasBusy ?? false,
    pending: r.pending ?? false,
    msgId,
    ...(r.runs !== undefined ? { runs: r.runs } : {}),
    ...(r.incarnation !== undefined ? { incarnation: r.incarnation } : {}),
  };
}

/**
 * status → abort → wait(afterRuns). The wait keys on the run counter the
 * extension bumps on agent_settled, so an abort that settles before the
 * wait connects still resolves at once. An agent that is not busy gets no
 * abort at all: the verb is idempotent.
 */
async function ctlAbort(
  target: DeliveryTarget,
  opts: {
    timeoutMs: number;
    onAbort?: (o: { before: AbortOutcome["before"]; pending: boolean }) => Promise<void>;
  },
): Promise<AbortOutcome> {
  const { agent } = target;
  const name = agent.name;
  const ws = agent.workstreamName;
  const sock = targetSocket(target);
  const { timeoutMs } = opts;

  const st = await ctlRequestFor(agent, sock, { op: "status" });
  if (!st.ok) throw new Error(say("agent.ctl_refused", "status", st.error));
  const before = st.state ?? "idle";
  const pending = st.pending ?? false;
  if (before !== "busy") {
    return { before, after: before, settled: true, aborted: false, pending };
  }

  const ab = await ctlRequestFor(agent, sock, { op: "abort" });
  if (!ab.ok) throw new Error(say("agent.ctl_refused", "the abort", ab.error));
  // Only a real abort is reported. wasBusy=false: the run settled between the
  // status probe and the abort, so pi did nothing. Absent: older extension.
  const aborted = ab.wasBusy !== false;
  if (aborted) await opts.onAbort?.({ before, pending });

  // The incarnation the status named: a pi that restarted since is another
  // process, whose run count means nothing here.
  const w = await ctlRequestFor(agent, sock, {
    op: "wait",
    afterRuns: st.runs ?? 0,
    timeoutMs,
    ...(st.incarnation !== undefined ? { incarnation: st.incarnation } : {}),
  });
  if (!w.ok) {
    if (w.error === INCARNATION_MISMATCH && st.incarnation !== undefined) {
      throw new AgentRestartedError(name, ws, st.incarnation, w.incarnation);
    }
    if (w.error === "timeout") throw new AgentAbortTimeoutError(name, ws, timeoutMs);
    throw new Error(say("agent.ctl_refused", "the wait", w.error));
  }
  return { before, after: w.state ?? "idle", settled: true, aborted, pending };
}

/** The ctl channel's delivery verbs. */
export const ctlDelivery: ChannelDelivery = {
  send: ctlSend,
  fresh: ctlFresh,
  command: ctlCommand,
  interrupt: ctlInterrupt,
  abort: ctlAbort,
  // pi's dialogs are its own UI, with no ctl op to answer them: the human answers in the pane.
  answer: async (t) => {
    throw new AgentAnswerUnsupportedError(t.agent.name, t.agent.workstreamName, "ctl");
  },
};
