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

/**
 * Plugin channels, per DB handle, by name: loaded from that DB's registrations
 * (src/plugins/channel.ts), each with the registration it was built from. One DB's agent is
 * never served another DB's adapter (plugins spec D9; P6e1 review ruling 1).
 */
type PluginEntry = { plugin: string; registration: string; channel: AgentChannel };
const plugins = new WeakMap<object, Map<string, PluginEntry>>();
const loaded = new Set<WeakRef<object>>();

/**
 * Plugin `plugin`'s channel in DB `db`, served composed; built again when its registration
 * (`registration`: its row's declaration and instance) changed. A built-in's name is never a plugin's.
 */
export function registerPluginChannel(
  db: object,
  c: { plugin: string; name: string; registration: string; build: () => ChannelImpl },
): void {
  if (channels().has(c.name)) return;
  let byName = plugins.get(db);
  if (byName === undefined) {
    byName = new Map();
    plugins.set(db, byName);
    loaded.add(new WeakRef(db));
  }
  const had = byName.get(c.name);
  if (had?.plugin === c.plugin && had.registration === c.registration) return;
  byName.set(c.name, { ...c, channel: composeChannel(c.build()) });
}

function inDb(
  byName: Map<string, PluginEntry> | undefined,
  name: string,
): AgentChannel | undefined {
  if (byName === undefined) return undefined;
  const c = byName.get(name)?.channel;
  if (c !== undefined || !name.startsWith("plugin:")) return c;
  const plugin = name.slice("plugin:".length);
  return [...byName.values()].find((p) => p.plugin === plugin)?.channel;
}

/**
 * The channel registered as `name` (a reading's `source` `plugin:<plugin>` names its plugin's):
 * a built-in, else `db`'s plugin channel. Without `db` (a caller holding only a name, for its
 * capabilities), a plugin channel only when exactly one loaded DB declares it. Undefined for a
 * null, absent or unknown name.
 */
export function channelNamed(
  name: ChannelName | null | undefined,
  db?: object,
): AgentChannel | undefined {
  if (name == null) return undefined;
  const builtin = channels().get(name);
  if (builtin !== undefined) return builtin;
  if (db !== undefined) return inDb(plugins.get(db), name);
  const found = new Set<AgentChannel>();
  for (const ref of loaded) {
    const d = ref.deref();
    if (d === undefined) loaded.delete(ref);
    const c = d === undefined ? undefined : inDb(plugins.get(d), name);
    if (c !== undefined) found.add(c);
  }
  return found.size === 1 ? [...found][0] : undefined;
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

/** Every built-in channel (a plugin's is per DB: `channelNamed(name, db)`). */
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
    channelAck: reply.ack,
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
