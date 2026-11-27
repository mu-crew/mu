// mu — crew tags: the identity murmur reads off an agent's pane (tmux `@mu_*`
// pane options; Rex block label + `mu-<ws>` session label). A spawn sets them
// best effort (a failed write keeps the pane and warns); `mu doctor` finds the
// live agents whose pane lacks them (one batched read), and `mu agent retag`
// writes them again. A pane missing them reads as a human's in murmur.

import { type AgentRow, listAgents } from "../agents.js";
import type { Db } from "../db.js";
import type { DoctorCheck } from "../doctor-summary.js";
import { rowRef } from "../jobs/view.js";
import { say } from "../messages.js";
import { isRetiredPane } from "../mux/binding.js";
import { CREW_ROLES, type CrewIdentity, type CrewTags, type MuxBackend } from "../mux/types.js";

/** One live agent's pane whose crew identity is not what murmur needs. */
export interface CrewTagProblem {
  agent: AgentRow;
  have: CrewTags;
  /** What a retag writes (a valid role on the pane is kept). */
  want: CrewIdentity;
  /** The wrong fields, each as `field=value`, for the warning line. */
  wrong: string[];
  /** Rex: the session label is not `mu-<ws>`; no per-pane write repairs it. */
  sessionWrong: boolean;
}

/** Whether `agent`'s recorded pane is the one `have` was read from (tmux: same server). */
function samePane(agent: AgentRow, have: CrewTags): boolean {
  return (
    have.server === undefined ||
    agent.paneIdentity === undefined ||
    have.server === agent.paneIdentity
  );
}

const shown = (v: string): string => (v === "" ? "unset" : JSON.stringify(v));

/** The live agents among `agents` whose pane (in `tags`) carries a wrong crew identity. Pure. */
export function crewTagProblems(
  mux: Pick<MuxBackend, "isValidPaneId">,
  agents: readonly AgentRow[],
  tags: ReadonlyMap<string, CrewTags>,
): CrewTagProblem[] {
  const problems: CrewTagProblem[] = [];
  for (const agent of agents) {
    if (isRetiredPane(agent.paneId) || !mux.isValidPaneId(agent.paneId)) continue;
    const have = tags.get(agent.paneId);
    // Gone (or another server's pane under the same id): reconcile's business, not a tag's.
    if (have === undefined || !samePane(agent, have)) continue;
    const role = have.role;
    const roleOk = role === undefined || (CREW_ROLES as readonly string[]).includes(role);
    const want: CrewIdentity = {
      agent: agent.name,
      workstream: agent.workstreamName,
      ...(role !== undefined ? { role: roleOk ? role : "worker" } : {}),
    };
    const wrong: string[] = [];
    const sessionWrong =
      have.sessionLabel !== undefined && have.workstream !== agent.workstreamName;
    if (have.sessionLabel !== undefined) {
      if (have.agent !== agent.name) wrong.push(`block label ${shown(have.agent)}`);
      if (sessionWrong) wrong.push(`session label ${shown(have.sessionLabel)}`);
    } else {
      if (have.agent !== agent.name) wrong.push(`@mu_agent ${shown(have.agent)}`);
      if (have.workstream !== agent.workstreamName)
        wrong.push(`@mu_workstream ${shown(have.workstream)}`);
      if (!roleOk) wrong.push(`@mu_role ${shown(role ?? "")}`);
    }
    if (wrong.length > 0) problems.push({ agent, have, want, wrong, sessionWrong });
  }
  return problems;
}

export interface CrewTagsReport {
  check: DoctorCheck;
  problems: CrewTagProblem[];
  /** One warning line per problem. */
  lines: string[];
}

/** The problem's warning line (names the fix). */
export function crewTagLine(p: CrewTagProblem): string {
  const line = say(
    "agent.crew_tags_wrong",
    p.agent.name,
    p.agent.workstreamName,
    p.agent.paneId,
    p.wrong.join(", "),
  );
  return p.sessionWrong && p.have.sessionLabel !== undefined
    ? `${line} (${say("agent.rex_session_label", p.have.sessionLabel, p.agent.workstreamName)})`
    : line;
}

/** `mu doctor`'s crew-tags row: one batched read of the server, every live agent compared. */
export async function crewTagsDoctorCheck(db: Db, mux: MuxBackend): Promise<CrewTagsReport> {
  if (mux.readCrewTags === undefined) {
    return {
      check: { name: "crew-tags", status: "ok", detail: `not checked on ${mux.name}` },
      problems: [],
      lines: [],
    };
  }
  let tags: Map<string, CrewTags>;
  try {
    tags = await mux.readCrewTags();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      check: { name: "crew-tags", status: "warn", detail: `unreadable: ${why}` },
      problems: [],
      lines: [],
    };
  }
  const problems = crewTagProblems(mux, listAgents(db), tags);
  const lines = problems.map(crewTagLine);
  const check: DoctorCheck =
    problems.length === 0
      ? { name: "crew-tags", status: "ok", detail: "every live agent's pane names its agent" }
      : {
          name: "crew-tags",
          status: "warn",
          detail: `${problems.length} agent pane${problems.length === 1 ? "" : "s"} untagged (murmur shows them as human); fix: mu agent retag`,
        };
  return { check, problems, lines };
}

/** What `mu agent retag` did to one agent. */
export interface RetagResult {
  name: string;
  workstream: string;
  paneId: string;
  /** `changed`: written now; `ok`: already right; `gone`: no live pane; `failed`: the write threw;
   *  `partial`: the block label is written, the Rex session label still is not `mu-<ws>`. */
  status: "changed" | "ok" | "gone" | "failed" | "partial";
  /** What was wrong before (`field value`). */
  wrong?: string[];
  error?: string;
}

/**
 * Write the crew identity again on the live agents of `workstream` (all of them, or `names`).
 * One batched read decides who needs it; a pane already right is not written (idempotent).
 */
export async function retagAgents(
  db: Db,
  mux: MuxBackend,
  opts: { workstream?: string; names?: readonly string[] } = {},
): Promise<RetagResult[]> {
  const scope = opts.workstream !== undefined ? { workstream: opts.workstream } : {};
  const agents = listAgents(db, scope).filter(
    (a) => opts.names === undefined || opts.names.length === 0 || opts.names.includes(a.name),
  );
  if (mux.readCrewTags === undefined || mux.writeCrewTags === undefined) return [];
  const tags = await mux.readCrewTags();
  const problems = new Map(crewTagProblems(mux, agents, tags).map((p) => [p.agent.incarnation, p]));
  const results: RetagResult[] = [];
  for (const agent of agents) {
    const base = { name: agent.name, workstream: agent.workstreamName, paneId: agent.paneId };
    const have = tags.get(agent.paneId);
    if (have === undefined || !samePane(agent, have) || !mux.isValidPaneId(agent.paneId)) {
      results.push({ ...base, status: "gone" });
      continue;
    }
    const p = problems.get(agent.incarnation);
    if (p === undefined) {
      results.push({ ...base, status: "ok" });
      continue;
    }
    const blockOk = p.have.sessionLabel !== undefined && p.have.agent === agent.name;
    try {
      if (!blockOk) await mux.writeCrewTags(rowRef(mux, agent.paneId, agent.paneIdentity), p.want);
      results.push({ ...base, status: p.sessionWrong ? "partial" : "changed", wrong: p.wrong });
    } catch (err) {
      results.push({
        ...base,
        status: "failed",
        wrong: p.wrong,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
