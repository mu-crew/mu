// mu — send transport: how `mu agent send` reaches an agent.
//
// Delivery goes through the agent's channel (src/channels): a pi agent
// (`ctl`) through its control socket, served by the mu pi extension inside
// the pane's own pi, with `/new`, `/reload` and `/compact` as the ctl
// `command` op; a non-pi agent (`mux`) through `mux.sendToPane` when the
// backend has one (herdr's atomic `agent prompt`), else
// AgentSendUnsupportedError (tmux). No silent fallback: a pi agent whose
// socket does not answer is an AgentCtlUnreachableError, never a paste.
//
// This module keeps the SDK's `sendViaTransport` and the `agent.send` audit
// op every delivery records.

import type { AgentRow } from "../agents.js";
import {
  type ChannelName,
  type DeliveryOptions,
  deliver,
  type SendResult,
} from "../channels/index.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";

export type { CtlGuard, SendResult } from "../channels/index.js";

/** How a send reached the agent: its channel. */
export type Transport = ChannelName;

export type TransportSendOptions = DeliveryOptions & {
  /** Control socket path. Default: agentCtlSocket(db, agent). */
  socket?: string;
  /** Start a new pi session and send the text into it, as one ctl op. */
  fresh?: boolean;
};

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

/** Deliver `text` to `agent` through its channel, its control socket at `opts.socket`. */
export async function sendViaTransport(
  agent: AgentRow,
  text: string,
  // Required: only the caller knows the DB whose directory roots the socket.
  opts: TransportSendOptions & { socket: string },
): Promise<SendResult> {
  return deliver({ agent, socket: opts.socket }, text, opts);
}
