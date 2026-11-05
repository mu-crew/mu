// mu — route reads to each agent's channel.
//
// `agentChannel` picks one agent's channel; `readAgentStates` is the one
// batched state read over a mixed set: ctl agents first, then every other
// pane (and the liveness of a ctl agent whose socket did not answer) from
// the mux channel, whose read the hooks channel shares (murmur's pane option). A remote command gate is read from its pane. Delivery is
// routed the same way, by `deliver` (./deliver.ts).

import { dirname } from "node:path";
import { agentKey, readGatePanes, type StateAgentRef, type StateReading } from "../agent-state.js";
import type { ObservedAgent } from "../agents/observe.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { queuedPanes } from "../muzzle-queue.js";
import { ctlChannel } from "./ctl.js";
import { hooksChannel } from "./hooks.js";
import { remoteReader } from "./hooks-remote.js";
import { muxChannel } from "./mux.js";
import { channelOf } from "./select.js";
import type { AgentChannel, ChannelTarget, RemoteReader } from "./types.js";

/**
 * `agent` as a channel target: its control socket is rooted at the DB's
 * directory, as spawn does, unless `socket` names it. Pass the whole row
 * (`AgentRow`) to get a target the delivery verbs take. A `hooks` row with a
 * remote key (a hook harness worker on a host) gets the reader of its node
 * (spec D11).
 */
export function channelTarget<A extends ObservedAgent>(
  db: Db,
  agent: A,
  socket?: string,
): ChannelTarget & { agent: A } {
  const remote = agent.channel === "hooks" ? remoteOf(db, agent) : undefined;
  return {
    agent,
    stateDir: dirname(db.name),
    ...(socket !== undefined ? { socket } : {}),
    ...(remote !== undefined ? { remote } : {}),
  };
}

/** The remote reader of a `hooks` row spawned on a host, from its row; undefined for a local one. */
function remoteOf(db: Db, agent: ObservedAgent): RemoteReader | undefined {
  const row = db
    .prepare("SELECT host, remote_key, command FROM agents WHERE id = ? AND pane_id = ?")
    .get(agent.incarnation, agent.paneId) as
    | { host: string | null; remote_key: string | null; command: string | null }
    | undefined;
  if (row?.host == null || row.remote_key == null) return undefined;
  return remoteReader(db, {
    name: agent.name,
    workstreamName: agent.workstreamName,
    paneId: agent.paneId,
    harness: harnessOfCli(agent.cli, row.command ?? undefined) ?? agent.cli,
    host: row.host,
    key: row.remote_key,
  });
}

/** The channel `target.agent` is on: the one its row recorded at spawn (see `expectsCtl`). */
export function agentChannel(target: ChannelTarget): AgentChannel {
  const name = channelOf(target.agent, target.stateDir, target.socket);
  return name === "ctl" ? ctlChannel : name === "hooks" ? hooksChannel : muxChannel;
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
  const rest = agents.filter((a) => !gates.includes(a));
  const readings = await readChannelStates(rest, opts);
  await markQueued(rest, readings, opts);
  if (gates.length === 0) return readings;
  for (const [key, reading] of await readGatePanes(gates)) readings.set(key, reading);
  return readings;
}

/**
 * Spec D14: a live agent off ctl whose pane holds a muzzle run waiting for
 * slots reads `queued`, so no stall rule fires on its silence. pi agents are
 * not looked up: ctl reports their running tool, and their readings stay as
 * they were.
 */
async function markQueued(
  agents: readonly StateAgentRef[],
  readings: Map<string, StateReading>,
  opts: { now?: number; stateDir?: string },
): Promise<void> {
  const offCtl = agents.filter(
    (a) => readings.get(agentKey(a))?.alive === true && channelOf(a, opts.stateDir) !== "ctl",
  );
  if (offCtl.length === 0) return;
  const queued = await queuedPanes(
    offCtl.map((a) => a.paneId),
    opts.now !== undefined ? { now: opts.now } : {},
  );
  for (const a of offCtl) {
    const reading = readings.get(agentKey(a));
    if (reading !== undefined && queued.has(a.paneId)) {
      readings.set(agentKey(a), { ...reading, queued: true });
    }
  }
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
