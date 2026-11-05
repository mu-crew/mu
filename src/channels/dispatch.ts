// mu — route reads to each agent's channel.
//
// `agentChannel` picks one agent's channel; `readAgentStates` is the one
// batched state read over a mixed set: ctl agents first, then every other
// pane (and the liveness of a ctl agent whose socket did not answer) from
// the mux channel. A remote command gate is read from its pane. Delivery is
// routed the same way, by `deliver` (./deliver.ts).

import { dirname } from "node:path";
import { agentKey, readGatePanes, type StateAgentRef, type StateReading } from "../agent-state.js";
import type { ObservedAgent } from "../agents/observe.js";
import type { Db } from "../db.js";
import { ctlChannel } from "./ctl.js";
import { muxChannel } from "./mux.js";
import { channelOf } from "./select.js";
import type { AgentChannel, ChannelTarget } from "./types.js";

/**
 * `agent` as a channel target: its control socket is rooted at the DB's
 * directory, as spawn does, unless `socket` names it. Pass the whole row
 * (`AgentRow`) to get a target the delivery verbs take.
 */
export function channelTarget<A extends ObservedAgent>(
  db: Db,
  agent: A,
  socket?: string,
): ChannelTarget & { agent: A } {
  return { agent, stateDir: dirname(db.name), ...(socket !== undefined ? { socket } : {}) };
}

/** The channel `target.agent` is on: the one its row recorded at spawn (see `expectsCtl`). */
export function agentChannel(target: ChannelTarget): AgentChannel {
  return channelOf(target.agent, target.stateDir, target.socket) === "ctl"
    ? ctlChannel
    : muxChannel;
}

/**
 * Read the runtime state of each agent. Order per agent: control socket
 * (pi agents) → murmur pane option → murmur remote → herdr. A pi agent
 * whose socket does not answer reads `unknown` with reason `ctl missing`
 * or `ctl refused`, never a murmur reading, so the gap stays visible.
 * `stateDir` roots the derived socket path (spawn uses the DB's directory).
 * A remote command gate has neither: it reads from its pane (see `readGatePanes`).
 */
export async function readAgentStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number; stateDir?: string } = {},
): Promise<Map<string, StateReading>> {
  const gates = agents.filter((a) => a.gateToken !== undefined && a.gateToken !== null);
  if (gates.length === 0) return readChannelStates(agents, opts);
  const readings = await readChannelStates(
    agents.filter((a) => !gates.includes(a)),
    opts,
  );
  for (const [key, reading] of await readGatePanes(gates)) readings.set(key, reading);
  return readings;
}

async function readChannelStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number; stateDir?: string },
): Promise<Map<string, StateReading>> {
  const onCtl = agents.filter((a) => channelOf(a, opts.stateDir) === "ctl");
  const readings = await ctlChannel.readStates(onCtl, opts);
  // A socket that did not answer: its `unknown` reading stands only while the pane lives.
  const failed = new Map<string, StateReading>();
  for (const [key, r] of readings) {
    if (r.ctl === "missing" || r.ctl === "refused") failed.set(key, r);
  }
  for (const key of failed.keys()) readings.delete(key);
  const rest = agents.filter((a) => !readings.has(agentKey(a)));
  if (rest.length === 0) return readings;
  // A ctl-failed agent keeps only the mux reading's liveness, so it never
  // needs the murmur remote read (whose rows are always alive).
  const read = await muxChannel.readStates(rest, { ...opts, livenessOnly: new Set(failed.keys()) });
  for (const [key, reading] of read) {
    const lost = failed.get(key);
    if (lost === undefined) readings.set(key, reading);
    else if (!reading.alive) readings.set(key, { ...reading, ctl: lost.ctl });
    else readings.set(key, lost);
  }
  return readings;
}
