// mu — the channel adapter (plugins spec D9, D13): a plugin's channel seam as
// a `ChannelImpl`, served composed by the registry.
//
// Reads (`readStates`, `baseline`, `receipt`, `lastRun`, `watch`) go through the
// one call path; every delivery (`send`, `fresh`, `command`, `interrupt`,
// `abort`, `answer`) is an effect, written ahead under a mu-generated key with
// the agent's next `delivery_seq` (src/effects.ts) and resolved by the rule
// table (./reconcile.ts). A capability that is false or `none` refuses with the
// typed error the built-ins use, before anything is written.
//
// A plugin never decides liveness: its readings carry turn state, its dense turn
// count and its incarnation, and `liveness` (the job's `job.status`) decides
// whether the agent is alive, unconditionally (src/channels/compose.ts).

import { randomUUID } from "node:crypto";
import {
  AgentAbortNeedsCtlError,
  AgentAnswerUnsupportedError,
  AgentFreshNeedsCtlError,
  AgentRestartedError,
  AgentSendUnsupportedError,
  AgentSteerUnsupportedError,
} from "../agents/errors.js";
import type { ObservedAgent } from "../agents/observe.js";
import { getAgent } from "../agents.js";
import { type CarrierJob, getCarrierJobByAgent } from "../carrier-jobs.js";
import { registerPluginChannel, toSendResult } from "../channels/registry.js";
import type {
  ChannelCaps,
  ChannelImpl,
  ChannelObservation,
  ChannelReading,
  DeliveryTarget,
  SendResult,
} from "../channels/types.js";
import type { Db } from "../db.js";
import { getHostRecord } from "../host-records.js";
import { jobLiveness } from "../jobs/kinds.js";
import { pluginJobRef } from "./job.js";
import { hostTarget } from "./link.js";
import type {
  MethodReplies,
  Obj,
  PluginMethod,
  WireObservation,
  WireTurnState,
} from "./protocol.js";
import { type Fence, pluginCall, pluginWatch, runEffect } from "./reconcile.js";
import { getPlugin, listPlugins, pluginSeams } from "./registry.js";

/** A plugin's turn state as mu's runtime state: idle is waiting for input, blocked a dialog. */
const RUNTIME = {
  idle: "needs_input",
  busy: "busy",
  blocked: "needs_permission",
  unknown: "unknown",
} as const satisfies Record<WireTurnState, string>;

/** Register every plugin channel of `db` (reads the plugins table only; no plugin starts). */
export function loadPluginChannels(db: Db): void {
  for (const row of listPlugins(db)) {
    const c = pluginSeams(row).channel;
    if (c === undefined) continue;
    registerPluginChannel(db, {
      plugin: row.name,
      name: c.name,
      registration: `${row.caps_json}\0${row.instance}`,
      build: () => pluginChannel(db, row.name, c),
    });
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Plugin `plugin`'s channel seam `decl` as a channel implementation over `db`. */
export function pluginChannel(
  db: Db,
  plugin: string,
  decl: { name: string; caps: ChannelCaps },
): ChannelImpl {
  const { name, caps } = decl;
  const atStart = (): boolean => pluginSeams(getPlugin(db, plugin)).job?.firstTurn === "at-start";
  const source = `plugin:${plugin}` as const;

  /** The agent's row and job record: the wire target (D13) and the instance its job went to. */
  const facts = (a: { workstreamName: string; name: string }) => {
    const row = getAgent(db, a.name, a.workstreamName);
    const job: CarrierJob | undefined =
      row === undefined ? undefined : getCarrierJobByAgent(db, row.incarnation);
    const target: Obj = {
      ...(row !== undefined
        ? { agent: { workstream: a.workstreamName, name: a.name, incarnation: row.incarnation } }
        : {}),
      ...(job !== undefined
        ? { job: { kind: job.kind ?? "", key: job.token, ...(job.job ? { handle: job.job } : {}) } }
        : {}),
      ...hostTarget(db, job?.host ?? row?.host ?? ""),
    };
    const fence: Fence | undefined =
      job?.instance == null
        ? undefined
        : {
            instance: job.instance,
            subject: `the channel of ${a.workstreamName}/${a.name}`,
            why: "instance-changed",
          };
    return { row, job, target, fence };
  };

  const read = <M extends PluginMethod>(
    m: M,
    a: { workstreamName: string; name: string },
    p: Obj,
    ms?: number,
  ): Promise<MethodReplies[M]> => {
    const f = facts(a);
    return pluginCall(
      db,
      plugin,
      m,
      // readStates takes a list of targets (D13); this adapter asks one agent per call.
      { ...(m === "channel.readStates" ? { targets: [f.target] } : { target: f.target }), ...p },
      {
        kind: "read",
        needs: ["channel"],
        ...(f.fence !== undefined ? { fence: f.fence } : {}),
        ...(ms !== undefined ? { timeoutMs: ms } : {}),
      },
    );
  };

  const observed = (a: ObservedAgent, o: WireObservation): ChannelObservation => ({
    workstream: a.workstreamName,
    name: a.name,
    agentId: a.incarnation,
    paneId: a.paneId,
    source,
    status: RUNTIME[o.status],
    since: o.since,
    settled: o.settled,
    runs: o.runs,
    incarnation: o.incarnation,
    ...(o.reason !== undefined ? { reason: o.reason } : {}),
    ...(o.pending !== undefined ? { pending: o.pending } : {}),
    ...(o.lastText !== undefined ? { lastText: o.lastText } : {}),
    ...(o.lastTextTruncated !== undefined ? { lastTextTruncated: o.lastTextTruncated } : {}),
    ...(o.lastError !== undefined ? { lastError: o.lastError } : {}),
  });

  /** A delivery: refused while it cannot go, else the effect, written ahead (D4). */
  const deliver = async <M extends PluginMethod>(
    t: DeliveryTarget,
    method: M,
    p: Obj,
    msgId: string,
  ): Promise<MethodReplies[M]> => {
    const f = facts(t.agent);
    // A job that outlives its lost host takes no turn mu cannot collect (D1).
    if (f.job !== undefined && getHostRecord(db, f.job.host)?.state === "lost") {
      throw new AgentSendUnsupportedError(
        t.agent.name,
        t.agent.workstreamName,
        t.agent.cli,
        `its host ${f.job.host} is lost: close the agent (mu agent close ${t.agent.name})`,
      );
    }
    return runEffect(db, {
      key: `delivery:${msgId}`,
      subject: { kind: "delivery", agentId: t.agent.incarnation, msgId },
      plugin,
      method,
      params: { target: f.target, ...p },
      needs: ["channel"],
      ...(f.job?.instance != null ? { fence: f.job.instance } : {}),
    });
  };
  const expect = (inc: string | undefined) => (inc !== undefined ? { expectIncarnation: inc } : {});
  const who = (t: DeliveryTarget) => [t.agent.name, t.agent.workstreamName] as const;
  const noFence = (t: DeliveryTarget, guard: unknown): void => {
    // fence "none" (D11): a caller that needs a write guard is refused before any write.
    if (guard !== undefined) throw new AgentSendUnsupportedError(...who(t), t.agent.cli);
  };
  const sent = (r: MethodReplies["channel.send"]): SendResult =>
    toSendResult({ ...r, channel: name });

  return {
    name,
    caps,
    fence: false,
    liveness: async (a) => {
      const { job } = facts(a);
      const ref = job === undefined ? undefined : pluginJobRef(db, job.token);
      if (ref === undefined) return { state: "unknown", reason: "no job record names the agent" };
      return jobLiveness(db, ref);
    },
    sendRun: (s) => ({
      channel: name,
      ack: s.channelAck ?? caps.receipt,
      ...(s.msgId !== undefined ? { msgId: s.msgId } : {}),
      ...(s.runs !== undefined
        ? {
            baseline: {
              runs: s.runs,
              ...(s.incarnation !== undefined ? { incarnation: s.incarnation } : {}),
            },
          }
        : {}),
    }),
    describeSend: (s, o) =>
      `via ${name}${o.fresh ? ", fresh session" : ""}${s.runs !== undefined ? `, runs ${s.runs}` : ""}`,
    describeInterrupt: (r) =>
      `via ${name}, ${r.wasBusy ? "interrupted a busy turn" : "it was idle"}`,

    readTurns: async (agents) => {
      const out = new Map<string, ChannelReading>();
      await Promise.all(
        agents.map(async (a) => {
          const key = `${a.workstreamName}/${a.name}`;
          try {
            const r = (await read("channel.readStates", a, {}))[key];
            if (r === undefined) throw new Error("no reading");
            out.set(key, {
              state: RUNTIME[r.state],
              source,
              since: r.since,
              runs: r.runs,
              incarnation: r.incarnation,
              ...(r.reason !== undefined ? { reason: r.reason } : {}),
              ...(r.pending !== undefined ? { pending: r.pending } : {}),
            });
          } catch (e) {
            out.set(key, { state: "unknown", source, since: null, reason: message(e) });
          }
        }),
      );
      return out;
    },

    async watch(t, signal, opts) {
      const f = facts(t.agent);
      let w: Awaited<ReturnType<typeof pluginWatch>>;
      try {
        w = await pluginWatch(
          db,
          plugin,
          {
            target: f.target,
            ...(opts.afterRuns !== undefined ? { afterRuns: opts.afterRuns } : {}),
            ...(opts.inc !== undefined ? { inc: opts.inc } : {}),
          },
          f.fence,
          signal,
        );
      } catch {
        return undefined; // no watch: the caller polls
      }
      const settled = w.end.then((end): ChannelObservation => {
        if ("observation" in end) return observed(t.agent, end.observation);
        if ("incarnation" in end) {
          throw new AgentRestartedError(
            t.agent.name,
            t.agent.workstreamName,
            opts.inc ?? "",
            end.incarnation,
          );
        }
        return {
          ...observed(t.agent, { ...w.start.initial, settled: false }),
          status: "unknown",
          reason: end.gone,
        };
      });
      return {
        initial: observed(t.agent, w.start.initial),
        ...(w.start.afterRuns !== undefined ? { afterRuns: w.start.afterRuns } : {}),
        settled,
      };
    },

    baseline: async (t) => {
      try {
        return (await read("channel.baseline", t.agent, {})) ?? undefined;
      } catch {
        return undefined;
      }
    },

    receipt: async (t, msgId, timeoutMs) => {
      try {
        return await read("channel.receipt", t.agent, { msgId }, timeoutMs);
      } catch (e) {
        return { state: "unreachable", id: msgId, reason: message(e) };
      }
    },

    lastRun: async (t, o) => {
      try {
        const r = await read(
          "channel.lastRun",
          t.agent,
          { afterRuns: o.afterRuns, ...(o.inc !== undefined ? { inc: o.inc } : {}) },
          o.ms,
        );
        return r === null ? undefined : observed(t.agent, r);
      } catch {
        return undefined;
      }
    },

    async send(t, text, opts) {
      noFence(t, opts.ctlGuard?.beforeWrite);
      if (opts.mode === "steer" && caps.steer === "none") {
        throw new AgentSteerUnsupportedError(...who(t), name);
      }
      const msgId = opts.msgId ?? randomUUID();
      const p = {
        text,
        msgId,
        mode: opts.mode ?? "followUp",
        force: opts.force === true,
        // An at-start kind's first prompt went with job.start (D8): no send is ever one.
        firstPrompt: opts.firstPrompt === true && !atStart(),
        ...expect(opts.expectIncarnation),
      };
      return sent(await deliver(t, "channel.send", p, msgId));
    },
    async fresh(t, text, opts) {
      noFence(t, opts.ctlGuard?.beforeWrite);
      if (caps.fresh !== "in-place") throw new AgentFreshNeedsCtlError(...who(t), t.agent.cli);
      const msgId = opts.msgId ?? randomUUID();
      const p = { text, msgId, force: opts.force === true, ...expect(opts.expectIncarnation) };
      return sent(await deliver(t, "channel.fresh", p, msgId));
    },
    async command(t, cmd, opts) {
      if (!caps.command)
        throw new AgentSendUnsupportedError(...who(t), t.agent.cli, "it runs no session commands");
      const p = {
        name: cmd.name,
        ...(cmd.instructions !== undefined ? { instructions: cmd.instructions } : {}),
        force: opts.force === true,
        ...expect(opts.expectIncarnation),
      };
      return { ...sent(await deliver(t, "channel.command", p, randomUUID())), command: cmd.name };
    },
    async interrupt(t, text, opts) {
      if (caps.interrupt === "none") throw new AgentAbortNeedsCtlError(...who(t), t.agent.cli);
      const msgId = randomUUID();
      const p = { text, msgId, timeoutMs: opts.timeoutMs, ...expect(opts.expectIncarnation) };
      return { transport: name, ...(await deliver(t, "channel.interrupt", p, msgId)) };
    },
    async abort(t, opts) {
      if (caps.interrupt === "none") throw new AgentAbortNeedsCtlError(...who(t), t.agent.cli);
      const r = await deliver(t, "channel.abort", { timeoutMs: opts.timeoutMs }, randomUUID());
      if (r.aborted) await opts.onAbort?.({ before: r.before, pending: r.pending });
      return r;
    },
    async answer(t, keys, opts) {
      if (!caps.answer) throw new AgentAnswerUnsupportedError(...who(t), name, true);
      const p = { keys: [...keys], force: opts.force === true };
      return { transport: name, ...(await deliver(t, "channel.answer", p, randomUUID())) };
    },
  };
}
