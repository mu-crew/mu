// mu — send transport: how `mu agent send` reaches an agent.
//
// A pi agent (speaksMuCtl) is reached through its control socket, served
// by the mu pi extension inside the pane's own pi. Everything else, and
// slash commands (pi.sendUserMessage does not run them), goes through
// the mux paste path. No silent fallback: a pi agent whose socket does
// not answer is an AgentCtlUnreachableError, never a paste.

import { dirname } from "node:path";
import type { AgentRow } from "../agents.js";
import { CtlVersionError, ctlRequest } from "../ctl/client.js";
import { ctlSocketPath } from "../ctl/path.js";
import type { CtlState } from "../ctl/protocol.js";
import type { Db } from "../db.js";
import { activeMux, type SendOptions } from "../mux.js";
import { AgentCtlUnreachableError } from "./errors.js";
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
};

/** The agent's derived control socket, rooted at the DB's directory (as spawn does). */
export function agentCtlSocket(db: Db, agent: AgentRow): string {
  return ctlSocketPath(agent.workstreamName, agent.name, dirname(db.name));
}

/** True when the agent runs pi, so sends go through its control socket. */
export function expectsCtl(agent: AgentRow): boolean {
  return speaksMuCtl(agent.cli, resolveCliCommand(agent.cli));
}

/** The transport a send of `text` to `agent` uses when not forced. */
export function chooseTransport(agent: AgentRow, text: string): Transport {
  // Slash commands (/new, /compact, ...) are TUI input: the extension's
  // sendUserMessage would send them to the model as plain text.
  if (text.startsWith("/")) return "mux";
  return expectsCtl(agent) ? "ctl" : "mux";
}

function errCode(e: unknown): string | undefined {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

export async function sendViaTransport(
  agent: AgentRow,
  text: string,
  opts: TransportSendOptions = {},
): Promise<SendResult> {
  const transport = opts.via ?? chooseTransport(agent, text);
  if (transport === "mux") {
    // Load-bearing: a send that cannot reach a pane is a failed send.
    await (await activeMux()).sendToPane(agent.paneId, text, opts);
    return { transport };
  }
  const sock = opts.socket ?? ctlSocketPath(agent.workstreamName, agent.name);
  const unreachable = (kind: "missing" | "refused") =>
    new AgentCtlUnreachableError(agent.name, agent.workstreamName, sock, kind);
  let reply: Awaited<ReturnType<typeof ctlRequest>>;
  try {
    reply = await ctlRequest(sock, { op: "send", text, mode: opts.mode ?? "followUp" });
  } catch (e) {
    if (e instanceof CtlVersionError) throw e;
    throw unreachable(errCode(e) === "ENOENT" ? "missing" : "refused");
  }
  if (!reply.ok) throw new Error(`control socket refused the send: ${reply.error}`);
  return reply.state === undefined ? { transport } : { transport, state: reply.state };
}
