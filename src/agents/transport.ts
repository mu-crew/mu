// mu — send transport: how `mu agent send` reaches an agent.
//
// A pi agent (speaksMuCtl) is reached through its control socket, served
// by the mu pi extension inside the pane's own pi. Everything else, and
// slash commands (pi.sendUserMessage does not run them), goes through
// the mux paste path. No silent fallback: a pi agent whose socket does
// not answer is an AgentCtlUnreachableError, never a paste.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRow } from "../agents.js";
import { CtlUnknownOpError, CtlVersionError, ctlRequest } from "../ctl/client.js";
import { ctlSocketPath } from "../ctl/path.js";
import type { CtlState } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { activeMux, type SendOptions } from "../mux.js";
import {
  AgentBusyError,
  AgentCtlUnreachableError,
  AgentExtensionOutdatedError,
  AgentFreshNeedsCtlError,
} from "./errors.js";
import { resolveCliCommand, speaksMuCtl } from "./spawn.js";

export type Transport = "ctl" | "mux";

export type SendResult = { transport: Transport; state?: CtlState };

export type TransportSendOptions = SendOptions & {
  /** How a busy pi queues the message. Default followUp. ctl only. */
  mode?: "steer" | "followUp";
  /** Force a transport instead of choosing by agent and text. */
  via?: Transport;
  /** Control socket path. Default: derived from the agent's identity. */
  socket?: string;
  /** Start a new pi session and send the text into it, as one ctl op. */
  fresh?: boolean;
  /** With fresh: abandon a running turn instead of refusing. */
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

/** The transport a send of `text` to `agent` uses when not forced. */
export function chooseTransport(agent: AgentRow, text: string, sock?: string): Transport {
  // Slash commands (/new, /compact, ...) are TUI input: the extension's
  // sendUserMessage would send them to the model as plain text.
  if (text.startsWith("/")) return "mux";
  return expectsCtl(agent, sock) ? "ctl" : "mux";
}

function errCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
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
  return new AgentExtensionOutdatedError(agent.name, agent.workstreamName, e.op, extVersion);
}

export async function sendViaTransport(
  agent: AgentRow,
  text: string,
  opts: TransportSendOptions = {},
): Promise<SendResult> {
  const sock = opts.socket ?? ctlSocketPath(agent.workstreamName, agent.name);
  if (opts.fresh && (opts.via === "mux" || !expectsCtl(agent, sock))) {
    throw new AgentFreshNeedsCtlError(agent.name, agent.workstreamName, agent.cli);
  }
  const transport = opts.fresh ? "ctl" : (opts.via ?? chooseTransport(agent, text, sock));
  if (transport === "mux") {
    // Load-bearing: a send that cannot reach a pane is a failed send.
    await (await activeMux()).sendToPane(agent.paneId, text, opts);
    return { transport };
  }
  const unreachable = (kind: "missing" | "refused") =>
    new AgentCtlUnreachableError(agent.name, agent.workstreamName, sock, kind);
  let reply: Awaited<ReturnType<typeof ctlRequest>>;
  try {
    reply = await ctlRequest(
      sock,
      opts.fresh
        ? { op: "fresh", text, ...(opts.force ? { force: true } : {}) }
        : { op: "send", text, mode: opts.mode ?? "followUp" },
    );
  } catch (e) {
    if (e instanceof CtlVersionError) throw e;
    if (e instanceof CtlUnknownOpError) throw await extensionOutdated(agent, sock, e);
    throw unreachable(errCode(e) === "ENOENT" ? "missing" : "refused");
  }
  if (!reply.ok) {
    if (opts.fresh && reply.error === "busy") {
      throw new AgentBusyError(agent.name, agent.workstreamName);
    }
    throw new Error(`control socket refused the send: ${reply.error}`);
  }
  return reply.state === undefined ? { transport } : { transport, state: reply.state };
}
