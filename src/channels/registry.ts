// mu — the channel registry (plugins spec D9): every channel mu can reach an
// agent through, by name. The built-ins (`ctl`, `hooks`, `mux`) register here;
// a plugin channel joins through `registerChannel` (P6e). `agentChannel`
// (./dispatch.ts) resolves an agent's channel by its name here, and a caller
// that holds only a name (a saved receipt's `transport`, a reading's `source`)
// asks `channelNamed` for the channel and branches on its `caps`, never on the
// name itself (test/channel-names.test.ts).

import { composeChannel } from "./compose.js";
import { ctlChannel } from "./ctl.js";
import { hooksChannel } from "./hooks.js";
import { muxChannel } from "./mux.js";
import type {
  AgentChannel,
  ChannelImpl,
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

/**
 * Add a channel implementation under its name, served composed
 * (`composeChannel`: its readings' liveness is the job's). A name already
 * taken throws: a channel never replaces another.
 */
export function registerChannel(impl: ChannelImpl): AgentChannel {
  const all = channels();
  if (all.has(impl.name)) throw new Error(`channel ${impl.name} is already registered`);
  const channel = composeChannel(impl);
  all.set(impl.name, channel);
  return channel;
}

/** Plugin channels by name, as the DB they were loaded from declared them (src/plugins/channel.ts). */
const plugins = new Map<string, { db: object; plugin: string; channel: AgentChannel }>();

/**
 * A plugin's channel, served composed. Loaded from a DB's registrations (`loadPluginChannels`),
 * again for another DB handle; a built-in's name is never a plugin's.
 */
export function registerPluginChannel(db: object, plugin: string, impl: ChannelImpl): void {
  if (channels().has(impl.name)) return;
  const had = plugins.get(impl.name);
  if (had?.db === db && had.plugin === plugin) return;
  plugins.set(impl.name, { db, plugin, channel: composeChannel(impl) });
}

/**
 * The channel registered as `name` (a reading's `source` `plugin:<plugin>` names its plugin's);
 * undefined for a null, absent or unknown name.
 */
export function channelNamed(name: ChannelName | null | undefined): AgentChannel | undefined {
  if (name == null) return undefined;
  const c = channels().get(name) ?? plugins.get(name)?.channel;
  if (c !== undefined || !name.startsWith("plugin:")) return c;
  const plugin = name.slice("plugin:".length);
  return [...plugins.values()].find((p) => p.plugin === plugin)?.channel;
}

/** An agent's row names a channel no built-in or registered plugin provides (D5, D9). Exit 4. */
export class ChannelUnknownError extends Error {
  override readonly name = "ChannelUnknownError";
  constructor(
    public readonly agentName: string,
    public readonly workstream: string,
    public readonly channel: string,
  ) {
    super(
      `agent ${agentName} is on channel ${channel}, which no built-in or registered plugin provides: register its plugin again (mu plugin add), or close the agent`,
    );
  }
}

/** Every registered channel, built-ins first, then the loaded plugin channels. */
export function registeredChannels(): AgentChannel[] {
  return [...channels().values(), ...[...plugins.values()].map((p) => p.channel)];
}

/** Test-only: drop a channel a test registered. The built-ins cannot be dropped. */
export function unregisterChannelForTests(name: ChannelName): void {
  if (name === ctlChannel.name || name === hooksChannel.name || name === muxChannel.name) {
    throw new Error(`channel ${name} is built in`);
  }
  channels().delete(name);
  plugins.delete(name);
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
