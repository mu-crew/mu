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
import type { WaitOptions } from "./wait-types.js";

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
      if (afterRuns === undefined && ctx.owed) {
        // Owed work counts from the last consumed run of THIS pi process, else
        // from the start: a run that finished before the wait still arrives.
        if (!expectsCtl(agent, sock)) return undefined;
        const probe = await ctlProbe(sock);
        if (probe.kind !== "ok") return undefined;
        const same =
          ctx.cursor !== undefined &&
          probe.incarnation !== undefined &&
          ctx.cursor.incarnation === probe.incarnation;
        afterRuns = same && ctx.cursor !== undefined ? ctx.cursor.runs : 0;
      }
      return watchAgentRun(agent, sock, signal, {
        ...(afterRuns !== undefined ? { afterRuns } : {}),
        ...(ref.incarnation !== undefined ? { inc: ref.incarnation } : {}),
      });
    },
  };
}
