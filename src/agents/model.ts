// mu — model: switch a running agent's model (and thinking level) through
// its channel. Only ctl can (pi's extension API, never a typed `/model`); a
// channel without `model` refuses with AgentModelNeedsCtlError.

import { getAgent } from "../agents.js";
import {
  agentChannel,
  type CtlEffort,
  channelOf,
  channelTarget,
  type ModelResult,
} from "../channels/index.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { resolveActorIdentity } from "../tasks/claim.js";
import { AgentModelNeedsCtlError, AgentNotFoundError } from "./errors.js";

export type SetModelResult = ModelResult & { agent: string; workstream: string };

export async function setAgentModel(
  db: Db,
  name: string,
  model: string,
  opts: { workstream: string; effort?: CtlEffort; socket?: string },
): Promise<SetModelResult> {
  const agent = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name, opts.workstream);
  const target = channelTarget(db, agent, opts.socket);
  const channel = agentChannel(target);
  if (!channel.model) {
    throw new AgentModelNeedsCtlError(name, opts.workstream, channelOf(agent));
  }
  const r = await channel.model(target, model, {
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
  });
  emitEvent(
    db,
    opts.workstream,
    "agent.model",
    `agent model ${name} ${r.model ?? model}${r.thinkingLevel !== undefined ? ` (thinking ${r.thinkingLevel})` : ""}`,
    await resolveActorIdentity(),
  );
  return { agent: name, workstream: opts.workstream, ...r };
}
