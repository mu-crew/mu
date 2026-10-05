import type { LiveAgent } from "../../agents.js";
import { agentStateGlyph } from "../../glyphs.js";
import type { WorkstreamSnapshot } from "../../state.js";
import type { TaskRow } from "../../tasks.js";

type AgentDisplayRow = Pick<LiveAgent, "name" | "state">;

export { agentStateGlyph };

/** Return a stable lookup of live agent rows keyed by agent name. */
export function agentByName(
  snapshot: WorkstreamSnapshot | null,
): ReadonlyMap<string, AgentDisplayRow> {
  const agents = snapshot?.view?.agents ?? [];
  return new Map(agents.map((a) => [a.name, a]));
}

/** Render a known live agent row with its status glyph. */
export function formatKnownAgentDisplayName(agent: AgentDisplayRow): string {
  return `${agentStateGlyph(agent.state)} ${agent.name}`;
}

/**
 * Render an agent reference from another TUI row.
 *
 * If the agent is present in the live-agent view, prefix the name with
 * the same status glyph used by the Agents card. If the row is an
 * owner/workspace reference whose agent is not in the live view (stale
 * snapshot, imported DB, or anonymous/self claim), keep the raw name
 * rather than inventing an unknown state. Null owners render as the
 * existing em dash.
 */
export function formatAgentRefDisplayName(
  agentName: string | null,
  agents: ReadonlyMap<string, AgentDisplayRow>,
): string {
  if (agentName === null) return "—";
  const agent = agents.get(agentName);
  if (agent === undefined) return agentName;
  return formatKnownAgentDisplayName(agent);
}

/**
 * Render a task's owner. The live state glyph means "this agent is
 * working on this task now", so only IN_PROGRESS rows get it; CLOSED
 * rows (and OPEN rows that kept an owner) show the bare name.
 */
export function formatTaskOwnerDisplay(
  task: Pick<TaskRow, "status" | "ownerName">,
  agents: ReadonlyMap<string, AgentDisplayRow>,
): string {
  if (task.status !== "IN_PROGRESS") return task.ownerName ?? "—";
  return formatAgentRefDisplayName(task.ownerName, agents);
}
