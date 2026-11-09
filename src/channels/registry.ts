// mu — the channel registry (plugins spec D9): every channel mu can reach an
// agent through, by name. The built-ins (`ctl`, `hooks`, `mux`) register here;
// a plugin channel joins through `registerChannel` (P6e). `agentChannel`
// (./dispatch.ts) resolves an agent's channel by its name here, and a caller
// that holds only a name (a saved receipt's `transport`, a reading's `source`)
// asks `channelNamed` for the channel and branches on its `caps`, never on the
// name itself (test/channel-names.test.ts).

import { ctlChannel } from "./ctl.js";
import { hooksChannel } from "./hooks.js";
import { muxChannel } from "./mux.js";
import type { AgentChannel, ChannelName, SentFacts, SentRun } from "./types.js";

let registry: Map<string, AgentChannel> | undefined;

/**
 * The registry, the built-ins in it. Filled on first use, not at module load:
 * the channel modules sit in import cycles, so their singletons may not exist
 * yet while this module evaluates.
 */
function channels(): Map<string, AgentChannel> {
  if (registry === undefined) {
    registry = new Map();
    for (const builtin of [ctlChannel, hooksChannel, muxChannel]) {
      registry.set(builtin.name, builtin);
    }
  }
  return registry;
}

/** Add a channel under its name. A name already taken throws: a channel never replaces another. */
export function registerChannel(channel: AgentChannel): void {
  const all = channels();
  if (all.has(channel.name)) throw new Error(`channel ${channel.name} is already registered`);
  all.set(channel.name, channel);
}

/** The channel registered as `name`; undefined for a null, absent or unknown name. */
export function channelNamed(name: ChannelName | null | undefined): AgentChannel | undefined {
  return name == null ? undefined : channels().get(name);
}

/** Every registered channel, built-ins first. */
export function registeredChannels(): AgentChannel[] {
  return [...channels().values()];
}

/** Test-only: drop a channel a test registered. The built-ins cannot be dropped. */
export function unregisterChannelForTests(name: ChannelName): void {
  if (name === ctlChannel.name || name === hooksChannel.name || name === muxChannel.name) {
    throw new Error(`channel ${name} is built in`);
  }
  channels().delete(name);
}

/**
 * The run a delivery started (see `AgentChannel.sendRun`), asked of the channel
 * that carried it. A result with no `transport` is ctl's (an interrupt reply
 * that predates the field) only where the caller says so; with none here, or
 * an unregistered name, its own `runs` (when present) is the baseline.
 */
export function sentRun(sent: SentFacts): SentRun | null {
  const channel = channelNamed(sent.transport);
  if (channel !== undefined) return channel.sendRun(sent);
  if (sent.runs === undefined) return {};
  return {
    baseline: {
      runs: sent.runs,
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
    },
  };
}
