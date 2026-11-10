// mu — route reads to each agent's channel.
//
// `agentChannel` picks one agent's channel from the registry (./registry.ts),
// by the name its row recorded; `readAgentStates` is the one batched state
// read over a mixed set (`composedStates`, ./compose.ts): agents are grouped
// by their channel's own read, and the channels on the shared base pane read
// (hooks, mux) read in one batch, last, with the liveness of every agent
// whose own channel did not answer (a ctl socket that is missing or refused).
// Every reading's `alive` is the job's (`withJobLiveness`). A remote command gate is
// read from its pane. Delivery is routed the same way, by `deliver`
// (./deliver.ts).

import { dirname } from "node:path";
import { agentKey, readGatePanes, type StateAgentRef, type StateReading } from "../agent-state.js";
import type { ObservedAgent } from "../agents/observe.js";
import { getCarrierJobByAgent } from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { agentJobRef, unregisteredReading } from "../jobs/kinds.js";
import { queuedPanes } from "../muzzle-queue.js";
import { loadPluginChannels } from "../plugins/channel.js";
import { pluginJobRef } from "../plugins/job.js";
import { composedStates } from "./compose.js";
import { remoteReader } from "./hooks-remote.js";
import { ChannelUnknownError, channelNamed } from "./registry.js";
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
  const row = db
    .prepare(
      "SELECT host, remote_key, command, host_transport FROM agents WHERE id = ? AND pane_id = ?",
    )
    .get(agent.incarnation, agent.paneId) as AgentFacts | undefined;
  const remote = agent.channel === "hooks" ? remoteOf(db, agent, row) : undefined;
  loadPluginChannels(db);
  // A plugin job's ref is its job record's (its kind, key, handle and instance).
  const record = getCarrierJobByAgent(db, agent.incarnation);
  const pluginJob = record?.plugin != null ? pluginJobRef(db, record.token) : undefined;
  return {
    agent,
    db,
    stateDir: dirname(db.name),
    ...(socket !== undefined ? { socket } : {}),
    ...(remote !== undefined ? { remote } : {}),
    job:
      pluginJob ??
      agentJobRef({
        ...agent,
        host: row?.host ?? null,
        hostTransport: row?.host_transport ?? null,
      }),
  };
}

interface AgentFacts {
  host: string | null;
  remote_key: string | null;
  command: string | null;
  host_transport: string | null;
}

/** The remote reader of a `hooks` row spawned on a host, from its row; undefined for a local one. */
function remoteOf(
  db: Db,
  agent: ObservedAgent,
  row: AgentFacts | undefined,
): RemoteReader | undefined {
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
  return channelFor(target.agent, target.stateDir, target.socket, target.db);
}

/** The registered channel named by `channelOf`; a name none provides refuses (`ChannelUnknownError`). */
function channelFor(
  agent: Parameters<typeof channelOf>[0],
  stateDir?: string,
  socket?: string,
  db?: object,
): AgentChannel {
  const name = channelOf(agent, stateDir, socket);
  const channel = channelNamed(name, db);
  if (channel === undefined) throw new ChannelUnknownError(agent.name, agent.workstreamName, name);
  return channel;
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
  opts: { now?: number; stateDir?: string; db?: Db } = {},
): Promise<Map<string, StateReading>> {
  if (opts.db !== undefined) loadPluginChannels(opts.db);
  const gates = agents.filter((a) => a.gateToken !== undefined && a.gateToken !== null);
  // A row on a channel nothing provides reads unknown (a verb on it refuses, typed).
  const unregistered = agents.filter(
    (a) => !gates.includes(a) && channelNamed(channelOf(a, opts.stateDir), opts.db) === undefined,
  );
  const rest = agents.filter((a) => !gates.includes(a) && !unregistered.includes(a));
  const readings = await readChannelStates(rest, opts);
  for (const a of unregistered) {
    readings.set(agentKey(a), unregisteredReading(channelOf(a, opts.stateDir)));
  }
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

/** Each agent's state, read by its channel and composed with its job's liveness (./compose.ts). */
function readChannelStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number; stateDir?: string; db?: Db },
): Promise<Map<string, StateReading>> {
  return composedStates(
    agents,
    (a) => channelFor(a, opts.stateDir, undefined, opts.db),
    opts,
    true,
  );
}
