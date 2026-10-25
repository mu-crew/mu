// mu — the ctl-backed agent readers for waitForEvents.
//
// `readAgents` is one `readAgentStates` pass (one batched probe per tick);
// `watchAgent` is the ctl `wait` (`watchAgentRun`) that the extension answers
// on `agent_settled`. They live apart from src/wait.ts so the engine imports
// neither the registry nor the ctl client.

import { observeAgentStates, watchAgentRun } from "./agents/observe.js";
import { agentCtlSocket, expectsCtl } from "./agents/transport.js";
import { getAgent } from "./agents.js";
import { ctlProbe } from "./ctl/client.js";
import type { Db } from "./db.js";
import type { AgentBaseline, WaitOptions } from "./wait-types.js";

export function ctlAgentHooks(db: Db): Required<Pick<WaitOptions, "readAgents" | "watchAgent">> {
  return {
    readAgents: async (refs) => {
      const agents = refs.flatMap((r) => {
        const a = getAgent(db, r.id, r.workstream);
        return a === undefined ? [] : [a];
      });
      return observeAgentStates(db, agents);
    },
    watchAgent: async (ref, signal, ctx) => {
      const agent = getAgent(db, ref.id, ref.workstream);
      if (agent === undefined) return undefined;
      const sock = agentCtlSocket(db, agent);
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
        if (!expectsCtl(agent, sock)) return undefined;
        const probe = await ctlProbe(sock);
        if (probe.kind !== "ok") return undefined;
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
          afterRuns = probe.status.runs;
          unknownBaseline = {
            afterRuns,
            ...(inc !== undefined ? { incarnation: inc } : {}),
            agentId: agent.incarnation,
          };
        }
      }
      const handle = await watchAgentRun(agent, sock, signal, {
        ...(afterRuns !== undefined ? { afterRuns } : {}),
        ...(ref.incarnation !== undefined ? { inc: ref.incarnation } : {}),
      });
      return handle !== undefined && unknownBaseline !== undefined
        ? { ...handle, unknownBaseline }
        : handle;
    },
  };
}
