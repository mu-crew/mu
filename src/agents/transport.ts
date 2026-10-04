// mu — send transport: how `mu agent send` reaches an agent.
//
// A pi agent (speaksMuCtl) is reached through its control socket, served
// by the mu pi extension inside the pane's own pi. `/new`, `/reload` and
// `/compact` become the ctl `command` op; any other slash command is
// refused (pi.sendUserMessage would hand it to the model as text). Only
// non-pi agents and an explicit `--via mux` reach the mux paste path. No
// silent fallback: a pi agent whose socket does not answer is an
// AgentCtlUnreachableError, never a paste.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRow } from "../agents.js";
import { CtlUnknownOpError, CtlVersionError, ctlRequest, errCode } from "../ctl/client.js";
import { ctlSocketPath } from "../ctl/path.js";
import {
  CTL_COMMANDS,
  type CtlCommandName,
  type CtlReply,
  type CtlRequest,
  type CtlState,
} from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { activeMux, type SendOptions } from "../mux.js";
import {
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
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
  /** Set when the text ran as a pi session command over ctl. */
  command?: CtlCommandName;
};

export type TransportSendOptions = SendOptions & {
  /** How a busy pi queues the message. Default followUp. ctl only. */
  mode?: "steer" | "followUp";
  /** Force a transport instead of choosing by agent and text. */
  via?: Transport;
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

/** The transport a send to `agent` uses when not forced. */
export function chooseTransport(agent: AgentRow, sock?: string): Transport {
  return expectsCtl(agent, sock) ? "ctl" : "mux";
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
 * Map a CtlUnknownOpError to AgentExtensionOutdatedError, asking the
 * socket's `hello` (best effort) for the extension's build version.
 * Checked after the refusal rather than before every op: an unknown op
 * is a no-op in the extension, so the happy path pays no extra trip.
 */
export async function extensionOutdated(
  agent: Pick<AgentRow, "name" | "workstreamName">,
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
  return new AgentExtensionOutdatedError(agent.name, agent.workstreamName, e.op, extVersion, e.ops);
}

/**
 * One ctl request to `agent`, with the failure mapping every ctl verb
 * shares: a version mismatch rethrows, an unknown op becomes
 * AgentExtensionOutdatedError, anything else AgentCtlUnreachableError
 * (missing on ENOENT, else refused).
 */
export async function ctlRequestFor(
  agent: Pick<AgentRow, "name" | "workstreamName">,
  sock: string,
  req: CtlRequest,
): Promise<CtlReply> {
  try {
    return await ctlRequest(sock, req);
  } catch (e) {
    if (e instanceof CtlVersionError) throw e;
    if (e instanceof CtlUnknownOpError) throw await extensionOutdated(agent, sock, e);
    throw new AgentCtlUnreachableError(
      agent.name,
      agent.workstreamName,
      sock,
      errCode(e) === "ENOENT" ? "missing" : "refused",
    );
  }
}

export async function sendViaTransport(
  agent: AgentRow,
  text: string,
  // Required: only the caller knows the DB whose directory roots the socket.
  opts: TransportSendOptions & { socket: string },
): Promise<SendResult> {
  const sock = opts.socket;
  if (opts.fresh && (opts.via === "mux" || !expectsCtl(agent, sock))) {
    throw new AgentFreshNeedsCtlError(agent.name, agent.workstreamName, agent.cli);
  }
  const transport = opts.fresh ? "ctl" : (opts.via ?? chooseTransport(agent, sock));
  if (transport === "mux") {
    // The paste path: non-pi CLIs, adopted panes, and an explicit --via mux.
    // Load-bearing: a send that cannot reach a pane is a failed send.
    await (await activeMux()).sendToPane(agent.paneId, text, opts);
    return { transport };
  }
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
  const reply = await ctlRequestFor(
    agent,
    sock,
    opts.fresh
      ? { op: "fresh", text, ...(opts.force ? { force: true } : {}) }
      : { op: "send", text, mode: opts.mode ?? "followUp" },
  );
  if (!reply.ok) {
    if (opts.fresh && reply.error === "busy") {
      throw new AgentBusyError(agent.name, agent.workstreamName);
    }
    throw new Error(`control socket refused the send: ${reply.error}`);
  }
  return {
    transport,
    ...(reply.state !== undefined ? { state: reply.state } : {}),
    ...(reply.runs !== undefined ? { runs: reply.runs } : {}),
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
