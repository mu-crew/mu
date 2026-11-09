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
import type {
  AgentChannel,
  ChannelName,
  ChannelSendReply,
  SendResult,
  SentFacts,
  SentRun,
} from "./types.js";

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

/** True for a reply in the normalized form (it names its `channel`; today's results name a `transport`). */
export function isSendReply(x: SentFacts | ChannelSendReply): x is ChannelSendReply {
  return "channel" in x && typeof x.channel === "string";
}

/**
 * A normalized reply as today's SendResult, the shape `--json` prints and the
 * wait arming reads: its baseline as `runs` and `incarnation`, its msgId kept.
 */
export function toSendResult(reply: ChannelSendReply): SendResult {
  return {
    transport: reply.channel,
    ...(reply.baseline !== undefined ? { runs: reply.baseline.runs } : {}),
    ...(reply.baseline?.incarnation !== undefined
      ? { incarnation: reply.baseline.incarnation }
      : {}),
    ...(reply.msgId !== undefined ? { msgId: reply.msgId } : {}),
  };
}

/**
 * The run a delivery started, as its wait counts it. A normalized reply
 * carries its baseline. Today's result is asked of the channel that carried
 * it (`AgentChannel.sendRun`); with no `transport`, or an unregistered one,
 * its own `runs` (when present) is the baseline. null: no run started.
 */
export function sentRun(sent: SentFacts | ChannelSendReply): SentRun | null {
  if (isSendReply(sent)) return sent.baseline !== undefined ? { baseline: sent.baseline } : {};
  const channel = channelNamed(sent.transport);
  if (channel !== undefined) {
    const reply = channel.sendRun(sent);
    if (reply === null) return null;
    return reply.baseline !== undefined ? { baseline: reply.baseline } : {};
  }
  if (sent.runs === undefined) return {};
  return {
    baseline: {
      runs: sent.runs,
      ...(sent.incarnation !== undefined ? { incarnation: sent.incarnation } : {}),
    },
  };
}
