// mu — which channel an agent is on.
//
// The agents row records the channel at spawn (`agents.channel`), and a verb
// reads it from there, never from the env. A row older than the column falls
// back to the derived rule: an agent that runs pi (or left its control socket
// file behind) is on `ctl`; every other pane is on `mux`. Only a recorded row
// is on `hooks`: a hook harness on tmux (local or remote), or pi on its fallback (spec D15).
// A remote command gate is on `mux`, whatever its row says.

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { resolveCliCommand, speaksMuCtl } from "../agents/spawn.js";
import type { AgentRow } from "../agents.js";
import { ctlSocketPath } from "../ctl/path.js";
import type { Db } from "../db.js";
import type { ChannelName, ChannelTarget } from "./types.js";

type ChannelRef = Pick<AgentRow, "cli" | "name" | "workstreamName"> & {
  gateToken?: string | null;
  channel?: ChannelName | null;
};

/**
 * True when the agent runs pi, so sends go through its control socket.
 *
 * A row that recorded its channel at spawn is final: `ctl` is on ctl, `mux`
 * is on mux whatever files sit at the derived socket path. A remote non-pi
 * worker's ssh `-L` binds that path locally whatever runs remotely, so the
 * file proves nothing for a recorded row; an opaque wrapper around pi names
 * `--cli pi` (see isCommandGate). A row older than the column (`channel`
 * null) is derived: the cli key decides when it names pi (or
 * MU_<KEY>_COMMAND here runs pi), else the socket file does. Spawn removes
 * any stale file before the pane starts, so a file at the derived path was
 * bound by this agent's extension (or its ssh forward).
 *
 * `sock` defaults to the derived path; pass agentCtlSocket(db, agent) when a
 * DB is at hand. A command gate (`gateToken`) never speaks ctl: the
 * discriminator beats every other rule.
 */
export function expectsCtl(
  agent: ChannelRef,
  sock: string = ctlSocketPath(agent.workstreamName, agent.name),
): boolean {
  // A remote command gate runs no pi, whatever its `cli` says or a forward leaves behind.
  if (agent.gateToken != null) return false;
  if (agent.channel != null) return agent.channel === "ctl";
  return speaksMuCtl(agent.cli, resolveCliCommand(agent.cli)) || existsSync(sock);
}

/**
 * True when a `hooks` row runs pi: the pi fallback (spec D15, `MU_PI_CHANNEL=hooks`
 * at spawn). Its mu extension still serves the control socket spawn named, but
 * only for the spawn handshake, delegates and doctor: every verb reaches it
 * through `hooks`, as its row says.
 */
export function piOnHooks(agent: ChannelRef & { command?: string | null }): boolean {
  if (agent.channel !== "hooks" || agent.gateToken != null) return false;
  return speaksMuCtl(agent.cli, agent.command ?? resolveCliCommand(agent.cli));
}

/**
 * True when the agent's pane serves a control socket: every agent on `ctl`
 * (see `expectsCtl`), and a pi on the `hooks` fallback (see `piOnHooks`). For
 * doctor's probe, never for a verb: a verb reads `channelOf`.
 */
export function servesCtl(
  agent: ChannelRef & { command?: string | null },
  sock: string = ctlSocketPath(agent.workstreamName, agent.name),
): boolean {
  return piOnHooks(agent) || expectsCtl(agent, sock);
}

/**
 * The channel of `agent`, its control socket at `socket` or else rooted at
 * `stateDir`. A row that recorded `hooks` is on hooks; an agent with no cli
 * key is on `mux`.
 */
export function channelOf(
  agent: Pick<AgentRow, "name" | "workstreamName"> & {
    cli?: string;
    gateToken?: string | null;
    channel?: ChannelName | null;
  },
  stateDir?: string,
  socket?: string,
): ChannelName {
  if (agent.cli === undefined) return "mux";
  if (agent.channel === "hooks") return agent.gateToken != null ? "mux" : "hooks";
  const ref = {
    cli: agent.cli,
    name: agent.name,
    workstreamName: agent.workstreamName,
    gateToken: agent.gateToken,
    channel: agent.channel,
  };
  const sock = socket ?? ctlSocketPath(agent.workstreamName, agent.name, stateDir);
  return expectsCtl(ref, sock) ? "ctl" : "mux";
}

/** The control socket of a channel target: its explicit `socket`, else the path derived under its state dir. */
export function targetSocket(t: ChannelTarget): string {
  return t.socket ?? ctlSocketPath(t.agent.workstreamName, t.agent.name, t.stateDir);
}

/** The agent's derived control socket, rooted at the DB's directory (as spawn does). */
export function agentCtlSocket(db: Db, agent: Pick<AgentRow, "name" | "workstreamName">): string {
  return ctlSocketPath(agent.workstreamName, agent.name, dirname(db.name));
}
