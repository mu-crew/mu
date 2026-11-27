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
import { AgentPaneDeadError } from "../agents/errors.js";
import type { ObservedAgent } from "../agents/observe.js";
import { getCarrierJobByAgent } from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { agentJobRef, readingWithLiveness } from "../jobs/kinds.js";
import { viewOwned } from "../jobs/view.js";
import { assertDrivablePane, foreignBackend, isRetiredPane } from "../mux/binding.js";
import { activeMux } from "../mux/detect.js";
import { queuedPanes } from "../muzzle-queue.js";
import { pluginJobRef } from "../plugins/job.js";
import { composedStates } from "./compose.js";
import { remoteReader } from "./hooks-remote.js";
import { ChannelUnknownError, channelNamed } from "./registry.js";
import { channelOf } from "./select.js";
import type { AgentChannel, ChannelTarget, LastSend, RemoteReader } from "./types.js";

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
      "SELECT host, remote_key, command, host_transport, created_at FROM agents WHERE id = ? AND pane_id = ?",
    )
    .get(agent.incarnation, agent.paneId) as AgentFacts | undefined;
  const remote = agent.channel === "hooks" ? remoteOf(db, agent, row) : undefined;
  const sent = agent.channel === "hooks" && row !== undefined ? lastSend(db, agent, row) : null;
  // A plugin job's ref is its job record's (its kind, key, handle and instance).
  const record = getCarrierJobByAgent(db, agent.incarnation);
  const pluginJob = record?.plugin != null ? pluginJobRef(db, record.token) : undefined;
  return {
    agent,
    db,
    stateDir: dirname(db.name),
    ...(socket !== undefined ? { socket } : {}),
    ...(remote !== undefined ? { remote } : {}),
    ...(sent !== null ? { sent } : {}),
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
  created_at: string;
}

/**
 * mu's last prompt to this incarnation since the row was made: its latest
 * `agent.send` op that is not an answer (typed keys are no prompt), as
 * `recordSend` writes it. null: none, or an op without its `at=` time (an
 * interrupt, a send an older mu recorded): then nothing is known.
 */
function lastSend(db: Db, agent: ObservedAgent, row: AgentFacts): LastSend | null {
  const prefix = `agent send ${agent.name} (`;
  const hit = db
    .prepare(
      `SELECT payload FROM ops WHERE entity = 'agent' AND key = ?
         AND intent = 'agent.send' AND created_at >= ? AND substr(payload, 1, ?) = ?
         AND substr(payload, ?, 11) <> 'mode=answer'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(agent.workstreamName, row.created_at, prefix.length, prefix, prefix.length + 1) as
    | { payload: string }
    | undefined;
  if (hit === undefined) return null;
  const field = (k: string): string | undefined =>
    new RegExp(`[ (]${k}=([^ ,)]+)`).exec(hit.payload)?.[1];
  const at = Date.parse(field("at") ?? "");
  if (Number.isNaN(at)) return null;
  const ack = field("ack");
  const runs = Number(field("runs") ?? Number.NaN);
  return {
    at,
    ...(ack !== undefined ? { ack } : {}),
    ...(Number.isInteger(runs) ? { runs } : {}),
  };
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
  const { agent } = target;
  const channel = channelFor(agent, target.stateDir, target.socket, target.db);
  // A retired herdr pane: no channel can reach it, so every delivery refuses alike.
  if (isRetiredPane(agent.paneId)) {
    return gated(channel, async () =>
      assertDrivablePane(agent.paneId, agent.name, agent.workstreamName),
    );
  }
  // Pane ids restart per tmux server, so on another server `agent.paneId` names
  // someone else's pane, which a send, key press or abort must never reach. The
  // agent is dead (`AgentPaneDeadError`). A row with no recorded identity is
  // unverified: unguarded.
  if (!agent.paneIdentity) return channel;
  return gated(channel, async () => {
    if (!(await viewOwned(agent.paneIdentity))) {
      throw new AgentPaneDeadError(agent.name, agent.workstreamName, agent.paneId);
    }
  });
}

/** The channel with every pane-addressed delivery run after `gate`, which throws to refuse it. */
function gated(channel: AgentChannel, gate: () => Promise<void>): AgentChannel {
  const wrap =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      await gate();
      return fn.apply(channel, a);
    };
  return {
    ...channel,
    send: wrap(channel.send),
    fresh: wrap(channel.fresh),
    command: wrap(channel.command),
    interrupt: wrap(channel.interrupt),
    abort: wrap(channel.abort),
    answer: wrap(channel.answer),
  };
}

/** The registered channel named by `channelOf`; a name none provides refuses (`ChannelUnknownError`). */
function channelFor(
  agent: Parameters<typeof channelOf>[0] & { channelPlugin?: string | null },
  stateDir?: string,
  socket?: string,
  db?: object,
): AgentChannel {
  const name = channelOf(agent, stateDir, socket);
  const channel = channelNamed(name, db, agent.channelPlugin);
  if (channel === undefined) throw new ChannelUnknownError(agent.name, agent.workstreamName, name);
  return channel;
}

/**
 * Read agents by their recorded channel. If ctl does not answer, the pane
 * supplies liveness only; the turn stays unknown. A gate reads its pane.
 * `stateDir` roots the derived socket path.
 */
export async function readAgentStates(
  agents: readonly StateAgentRef[],
  opts: { now?: number; stateDir?: string; db?: Db } = {},
): Promise<Map<string, StateReading>> {
  if (agents.length === 0) return new Map();
  const active = (await activeMux().catch(() => undefined))?.name;
  const foreign = new Map<string, StateReading>();
  const local = agents.filter((a) => {
    const backend = active === undefined ? undefined : foreignBackend(a.paneId, active);
    if (backend === undefined) return true;
    // The active backend cannot prove anything about this pane, including its absence.
    const reason = `foreign backend: ${backend} (active: ${active})`;
    const turn = { state: "unknown", source: "none", since: null, reason } as const;
    foreign.set(agentKey(a), readingWithLiveness(turn, { state: "unknown", reason }));
    return false;
  });
  const gates = local.filter((a) => a.gateToken !== undefined && a.gateToken !== null);
  // A row on a channel nothing provides reads unknown (a verb on it refuses, typed).
  const known = (a: StateAgentRef) =>
    channelNamed(channelOf(a, opts.stateDir), opts.db, a.channelPlugin);
  const unregistered = local.filter((a) => !gates.includes(a) && known(a) === undefined);
  const rest = local.filter((a) => !gates.includes(a) && !unregistered.includes(a));
  const readings = await readChannelStates(rest, opts);
  for (const [key, reading] of foreign) readings.set(key, reading);
  for (const a of unregistered) {
    const reason = `channel ${channelOf(a, opts.stateDir)} is not registered`;
    const turn = { state: "unknown", source: "none", since: null, reason } as const;
    readings.set(agentKey(a), readingWithLiveness(turn, { state: "unknown", reason }));
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
