// mu — the channel-backed agent readers for waitForEvents.
//
// `readAgents` is one `readAgentStates` pass (one batched read per tick, each
// agent on its channel); `watchAgent` is the agent's channel's watch (on ctl,
// the `wait` that the extension answers on `agent_settled`; a channel that
// cannot watch is polled). They live apart from src/wait.ts so the engine
// imports neither the registry nor a channel.

import { observeAgentStates } from "./agents/observe.js";
import { getAgent } from "./agents.js";
import { agentChannel, channelTarget } from "./channels/index.js";
import type { Db } from "./db.js";
import { activeMux } from "./mux.js";
import { WAIT_TEXT_MAX } from "./wait-regex.js";
import type { AgentBaseline, AgentReading, WaitOptions } from "./wait-types.js";

/**
 * `paneText` (a wait with `--until-text`): also read the pane tail of an agent whose control
 * socket does not answer (a non-pi command, a `--no-ctl` pane). A pi agent that answers has
 * authoritative ctl `lastText` and is never read from its pane. Best effort: a pane the mux
 * cannot read just has no text and never matches.
 */
export function ctlAgentHooks(
  db: Db,
  opts: { paneText?: boolean } = {},
): Required<Pick<WaitOptions, "readAgents" | "watchAgent">> {
  return {
    readAgents: async (refs) => {
      const agents = refs.flatMap((r) => {
        const a = getAgent(db, r.id, r.workstream);
        return a === undefined ? [] : [a];
      });
      const observed = await observeAgentStates(db, agents);
      if (opts.paneText !== true) return observed;
      const out = new Map<string, AgentReading>(observed);
      for (const a of agents) {
        const key = `${a.workstreamName}/${a.name}`;
        const base = out.get(key);
        if (base === undefined || base.status === null) continue;
        // A pi agent whose control socket ANSWERS has authoritative ctl text: never its pane.
        // Only an agent with no answering socket (a non-pi command, `--no-ctl`) has none.
        if (base.ctl === "ok") continue;
        try {
          const text = await (await activeMux()).capture(a.paneId, { lines: 200 });
          out.set(key, { ...base, lastText: text.slice(-WAIT_TEXT_MAX), textSource: "pane" });
        } catch {
          // no pane text: the agent just never matches
        }
      }
      return out;
    },
    watchAgent: async (ref, signal, ctx) => {
      const agent = getAgent(db, ref.id, ref.workstream);
      if (agent === undefined) return undefined;
      const target = channelTarget(db, agent);
      const channel = agentChannel(target);
      let afterRuns = ref.afterRuns;
      let unknownBaseline: AgentBaseline | undefined;
      if (
        afterRuns === undefined &&
        (ctx.owed || ctx.baseline !== undefined || ctx.cursor !== undefined)
      ) {
        // Explicit or owned, the same rule: count from the producer's UNCONSUMED
        // baseline (a send that settles before this wait started is still
        // caught), maxed with the last consumed run of THIS pi process. A
        // baseline of another incarnation or registry row is not this agent's.
        // With neither, an owed ref counts from the run count probed now and
        // says so (`unknownBaseline`): a historical run is never completion.
        const probe = await channel.baseline(target);
        if (probe === undefined) {
          // A remote hooks worker whose pane has no row yet (just spawned, its
          // node not read yet): its producer's baseline, when it names no
          // incarnation to check, still holds, and the watch reads the node
          // until a row appears. Without one it counts from that first row.
          if (target.remote === undefined) return undefined;
          const b = ctx.baseline;
          if (
            b !== undefined &&
            b.incarnation === undefined &&
            (b.agentId === undefined || b.agentId === agent.incarnation)
          ) {
            afterRuns = b.afterRuns;
          }
          return await channel.watch(target, signal, {
            ...(afterRuns !== undefined ? { afterRuns } : {}),
            ...(ref.incarnation !== undefined ? { inc: ref.incarnation } : {}),
          });
        }
        const inc = probe.incarnation;
        const b = ctx.baseline;
        const baseOk =
          b !== undefined &&
          (b.agentId === undefined || b.agentId === agent.incarnation) &&
          (b.incarnation === undefined || (inc !== undefined && b.incarnation === inc));
        const cursorOk =
          ctx.cursor !== undefined && inc !== undefined && ctx.cursor.incarnation === inc;
        const fromCursor = cursorOk && ctx.cursor !== undefined ? ctx.cursor.runs : undefined;
        if (baseOk && b !== undefined) {
          // The consumed cursor only ever raises the baseline: never re-deliver.
          afterRuns = Math.max(b.afterRuns, fromCursor ?? 0);
        } else if (fromCursor !== undefined) afterRuns = fromCursor;
        else if (ctx.owed) {
          afterRuns = probe.runs;
          unknownBaseline = {
            afterRuns,
            ...(inc !== undefined ? { incarnation: inc } : {}),
            agentId: agent.incarnation,
          };
        }
      }
      const handle = await channel.watch(target, signal, {
        ...(afterRuns !== undefined ? { afterRuns } : {}),
        ...(ref.incarnation !== undefined ? { inc: ref.incarnation } : {}),
      });
      return handle !== undefined && unknownBaseline !== undefined
        ? { ...handle, unknownBaseline }
        : handle;
    },
  };
}
