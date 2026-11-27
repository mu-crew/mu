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
import { foreignBackend, isRetiredPane } from "../mux/binding.js";
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

/** Where an agent row's pane stands for a tag read or write on the active backend. */
export type PaneStanding =
  | { kind: "retired" } // a retired backend's pane (herdr): never live, never dead
  | { kind: "foreign" } // another live backend's pane
  | { kind: "gone" } // no pane by that id on this server, or another server's pane
  | { kind: "unverified"; have: CrewTags } // legacy tmux row: no recorded server to match
  | { kind: "live"; have: CrewTags };

/**
 * Classify `agent`'s pane against one batched read. A tmux pane id restarts per server, so a
 * row with no recorded server (`pane_identity`, a legacy row) cannot claim the `%N` it sees:
 * that pane may be another server's. It reads as `unverified`, never compared or written.
 */
export function paneStanding(
  mux: Pick<MuxBackend, "name" | "isValidPaneId">,
  agent: AgentRow,
  tags: ReadonlyMap<string, CrewTags>,
): PaneStanding {
  if (isRetiredPane(agent.paneId)) return { kind: "retired" };
  if (foreignBackend(agent.paneId, mux.name) !== undefined) return { kind: "foreign" };
  if (!mux.isValidPaneId(agent.paneId)) return { kind: "gone" };
  const have = tags.get(agent.paneId);
  if (have === undefined) return { kind: "gone" };
  if (mux.name === "tmux" && agent.paneIdentity === undefined) return { kind: "unverified", have };
  if (have.server !== undefined && have.server !== agent.paneIdentity) return { kind: "gone" };
  return { kind: "live", have };
}

const shown = (v: string): string => (v === "" ? "unset" : JSON.stringify(v));

/** The live agents among `agents` whose pane (in `tags`) carries a wrong crew identity. Pure. */
export function crewTagProblems(
  mux: Pick<MuxBackend, "name" | "isValidPaneId">,
  agents: readonly AgentRow[],
  tags: ReadonlyMap<string, CrewTags>,
): CrewTagProblem[] {
  const problems: CrewTagProblem[] = [];
  for (const agent of agents) {
    // Gone, foreign, retired or unverified: reconcile's business (or a respawn's), not a tag's.
    const standing = paneStanding(mux, agent, tags);
    if (standing.kind !== "live") continue;
    const have = standing.have;
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
  /** Legacy tmux rows (no recorded server) whose `%N` exists here: not checked. */
  unverified: string[];
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
      unverified: [],
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
      unverified: [],
      lines: [],
    };
  }
  const agents = listAgents(db);
  const problems = crewTagProblems(mux, agents, tags);
  const unverified = agents
    .filter((a) => paneStanding(mux, a, tags).kind === "unverified")
    .map((a) => `${a.workstreamName}/${a.name}`);
  const lines = problems.map(crewTagLine);
  const skipped =
    unverified.length === 0
      ? ""
      : `; ${unverified.length} unverified (${say("agent.crew_tags_unverified")}): ${unverified.join(", ")}`;
  const check: DoctorCheck =
    problems.length === 0
      ? {
          name: "crew-tags",
          status: "ok",
          detail: `every live agent's pane names its agent${skipped}`,
        }
      : {
          name: "crew-tags",
          status: "warn",
          detail: `${problems.length} agent pane${problems.length === 1 ? "" : "s"} untagged (murmur shows them as human); fix: mu agent retag${skipped}`,
        };
  return { check, problems, unverified, lines };
}

/** What `mu agent retag` did to one agent. */
export interface RetagResult {
  name: string;
  workstream: string;
  /** Absent for `not_found`. */
  paneId?: string;
  /** `changed`: written now; `ok`: already right; `failed`: the write threw;
   *  `partial`: the block label is written, the Rex session label still is not `mu-<ws>`;
   *  never written: `gone` (no live pane), `retired` (a herdr pane), `foreign` (another
   *  backend's pane), `unverified` (a legacy tmux row: no recorded server, so its `%N` may be
   *  another server's; respawn it), `not_found` (a requested name with no row). */
  status:
    | "changed"
    | "ok"
    | "gone"
    | "failed"
    | "partial"
    | "retired"
    | "foreign"
    | "unverified"
    | "not_found";
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
  const names = opts.names ?? [];
  const agents = listAgents(db, scope).filter((a) => names.length === 0 || names.includes(a.name));
  const results: RetagResult[] = names
    .filter((n) => !agents.some((a) => a.name === n))
    .map((name) => ({ name, workstream: opts.workstream ?? "", status: "not_found" as const }));
  if (mux.readCrewTags === undefined || mux.writeCrewTags === undefined) return results;
  const tags = await mux.readCrewTags();
  const problems = new Map(crewTagProblems(mux, agents, tags).map((p) => [p.agent.incarnation, p]));
  for (const agent of agents) {
    const base = { name: agent.name, workstream: agent.workstreamName, paneId: agent.paneId };
    const standing = paneStanding(mux, agent, tags);
    if (standing.kind !== "live") {
      results.push({ ...base, status: standing.kind });
      continue;
    }
    const p = problems.get(agent.incarnation);
    if (p === undefined) {
      results.push({ ...base, status: "ok" });
      continue;
    }
    const blockOk = p.have.sessionLabel !== undefined && p.have.agent === agent.name;
    try {
      // A live tmux row has its server recorded: the write is guarded to that server.
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
