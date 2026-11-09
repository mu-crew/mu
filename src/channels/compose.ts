// mu — the channel layer's composition (plugins spec D9, the P1 ruling): a
// channel implementation (`ChannelImpl`) served as an `AgentChannel`. A channel
// reports turn state and its link; this module is where its readings get
// `alive`, from the job (`withJobLiveness`), and where its watch's verdicts
// become the wait's observations (`jobObservation`). `readAgentStates`
// (./dispatch.ts) reads through `composedStates` too, so no reading reaches
// mu with a liveness a channel chose (test/channel-registry.test.ts,
// test/channel-names.test.ts).

import { agentKey, readBaseStates, type StateAgentRef, type StateReading } from "../agent-state.js";
import type { ObservedWatch } from "../agents/observe.js";
import { jobObservation, stateRefJob, withJobLiveness } from "../jobs/kinds.js";
import type {
  AgentChannel,
  ChannelImpl,
  ChannelReading,
  ChannelReadOptions,
  ChannelWatch,
} from "./types.js";

type TurnRead = Exclude<ChannelImpl["readTurns"], "base">;

/**
 * The state of each agent, read by its channel: agents grouped by their
 * channel's own read (one call per read function), then the shared base read
 * for every agent on a `base` channel. With `views`, an agent whose channel
 * did not answer (`ctl` missing or refused) joins the base read for its
 * view's liveness only (`livenessOnly`), and the view's verdict stands;
 * without, its reading stays alive (no answer is no death), as a channel's
 * own read always reported it.
 */
export async function composedStates(
  agents: readonly StateAgentRef[],
  channelOf: (a: StateAgentRef) => Pick<ChannelImpl, "readTurns">,
  opts: ChannelReadOptions,
  views: boolean,
): Promise<Map<string, StateReading>> {
  const groups = new Map<TurnRead, StateAgentRef[]>();
  const byKey = new Map<string, StateAgentRef>();
  for (const a of agents) {
    byKey.set(agentKey(a), a);
    const read = channelOf(a).readTurns;
    if (read === "base") continue;
    groups.set(read, [...(groups.get(read) ?? []), a]);
  }
  const readings = new Map<string, StateReading>();
  const unanswered = new Map<string, ChannelReading>();
  for (const [read, group] of groups) {
    for (const [key, turn] of await read(group, opts)) {
      const agent = byKey.get(key);
      if (agent === undefined) continue;
      if (views && (turn.ctl === "missing" || turn.ctl === "refused")) unanswered.set(key, turn);
      else readings.set(key, await withJobLiveness(turn, stateRefJob(agent)));
    }
  }
  const rest = agents.filter((a) => !readings.has(agentKey(a)));
  if (rest.length === 0) return readings;
  // An unanswered agent keeps only the view's liveness, so it never needs the
  // murmur remote read (whose rows are always alive).
  const base = await readBaseStates(
    rest,
    opts,
    views ? new Set(unanswered.keys()) : opts.livenessOnly,
  );
  for (const [key, view] of base) {
    const turn = unanswered.get(key);
    const agent = byKey.get(key);
    if (turn === undefined || agent === undefined) readings.set(key, view);
    else readings.set(key, await withJobLiveness(turn, stateRefJob(agent), view));
  }
  return readings;
}

/** A channel watch as the wait reads it. */
function observedWatch(w: ChannelWatch): ObservedWatch {
  return {
    initial: jobObservation(w.initial),
    ...(w.afterRuns !== undefined ? { afterRuns: w.afterRuns } : {}),
    settled: w.settled.then(jobObservation),
  };
}

/** `watch` as the wait reads it; for the SDK's raw ctl watch too. */
export async function composedWatch(
  w: Promise<ChannelWatch | undefined>,
): Promise<ObservedWatch | undefined> {
  const watch = await w;
  return watch === undefined ? undefined : observedWatch(watch);
}

/** The channel implementation served as mu reaches it. Frozen: no caller replaces a read. */
export function composeChannel(impl: ChannelImpl): AgentChannel {
  return Object.freeze({
    ...impl,
    readStates: (agents, opts) => composedStates(agents, () => impl, opts, false),
    watch: (target, signal, opts) => composedWatch(impl.watch(target, signal, opts)),
    lastRun: async (target, opts) => {
      const r = await impl.lastRun(target, opts);
      return r === undefined ? undefined : jobObservation(r);
    },
  } satisfies AgentChannel);
}
