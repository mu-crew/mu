// mu — agent output boundary: what `--json` prints for an agent.
//
// Pure (no I/O). Keys equal the SQL column names of `agents` and `id` is the
// real primary key, which IS the registry incarnation (`AgentRow.incarnation`,
// what `agent close --if` and every destructive write compare; not pi's string
// `incarnation`). `workstream_id` is the real foreign key; `workstream` is its
// name. Computed live facts (runtime state, ctl link) ride after the columns,
// snake_cased, only when known. The deprecated `agents.status` column is never
// emitted. The SDK keeps camelCase `AgentRow`; ONLY the CLI maps (README
// Interface: output keys equal SQL column names).

import type { ClosePreview } from "./agents/close.js";
import type { AgentRow, LiveAgent } from "./agents.js";
import type { Db } from "./db.js";
import { harnessOfCli } from "./harnesses.js";

/** `workstreams.id` for a name, torn down or not (an agent row can outlive its workstream's teardown). */
export function workstreamIdOf(db: Db, workstream: string): number {
  const row = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
    | { id: number }
    | undefined;
  return row?.id ?? 0;
}

/** The live, computed half of an agent record (all optional: only what was read). */
export interface AgentLiveFacts {
  state?: string;
  source?: string;
  ctl?: string;
  ctlSocket?: string;
  since?: string | null;
  reason?: string;
  idle?: boolean;
  trustDialog?: boolean;
  queued?: boolean;
}

/** One agent as `--json` emits it. */
export interface AgentOutput {
  /** `agents.id`: the registry incarnation. */
  id: number;
  name: string;
  workstream_id: number;
  workstream: string;
  cli: string;
  pane_id: string;
  role: string;
  tab: string | null;
  cwd: string | null;
  base: string | null;
  command: string | null;
  command_source: string | null;
  spawner: string | null;
  host: string | null;
  collected_head: string | null;
  repo: string | null;
  gate_token: string | null;
  /** The channel spawn recorded (`ctl`, `hooks`, `mux`); null: a row older than the column (derived per read). */
  channel: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Computed: the blessed harness the agent runs (`claude`, `codex`, `cursor-agent`,
   * `muse`, `pi`; spec D17), from its command's argv0, else its cli key and the key's
   * prefix; a ctl or hooks row that names none runs pi. null: a CLI outside the five.
   */
  harness: string | null;
  state?: string;
  source?: string;
  ctl?: string;
  ctl_socket?: string;
  since?: string | null;
  reason?: string;
  idle?: boolean;
  trust_dialog?: boolean;
  /** A muzzle run in the pane waits for slots (spec D14); present only when true. */
  queued?: boolean;
}

/** The harness a row runs (see `AgentOutput.harness`). Pure: reads only the row. */
export function harnessOf(
  row: Pick<AgentRow, "cli" | "command" | "channel" | "gateToken">,
): string | null {
  // A remote command gate runs a command, not an agent.
  if (row.gateToken !== null) return null;
  const harness = harnessOfCli(row.cli, row.command ?? undefined);
  if (harness !== undefined) return harness;
  // Only pi speaks ctl, and only pi (on its fallback) is on hooks without a harness name.
  return row.channel === "ctl" || row.channel === "hooks" ? "pi" : null;
}

/** Boundary mapper: AgentRow (camelCase) plus its real workstream id → output record. */
export function agentToOutput(
  row: AgentRow,
  workstreamId: number,
  live: AgentLiveFacts = {},
): AgentOutput {
  return {
    id: row.incarnation,
    name: row.name,
    workstream_id: workstreamId,
    workstream: row.workstreamName,
    cli: row.cli,
    pane_id: row.paneId,
    role: row.role,
    tab: row.tab,
    cwd: row.cwd,
    base: row.base,
    command: row.command,
    command_source: row.commandSource,
    spawner: row.spawner,
    host: row.host,
    collected_head: row.collectedHead,
    repo: row.repo,
    gate_token: row.gateToken,
    channel: row.channel,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    harness: harnessOf(row),
    ...(live.state !== undefined ? { state: live.state } : {}),
    ...(live.source !== undefined ? { source: live.source } : {}),
    ...(live.ctl !== undefined ? { ctl: live.ctl } : {}),
    ...(live.ctlSocket !== undefined ? { ctl_socket: live.ctlSocket } : {}),
    ...(live.since !== undefined ? { since: live.since } : {}),
    ...(live.reason !== undefined ? { reason: live.reason } : {}),
    ...(live.idle !== undefined ? { idle: live.idle } : {}),
    ...(live.trustDialog !== undefined ? { trust_dialog: live.trustDialog } : {}),
    ...(live.queued === true ? { queued: true } : {}),
  };
}

/**
 * A close preview with its identity under the SQL names (`id`, `pane_id`);
 * every verb-level field is kept. `id` is the REGISTRY incarnation (null for a
 * recovery: no row); a recovery's own id is `recovery_id` (the original
 * incarnation it was kept from), null otherwise.
 */
export function closePreviewToOutput(p: ClosePreview): Record<string, unknown> {
  const { incarnation, paneId, ...rest } = p;
  return { ...rest, id: incarnation, pane_id: paneId, recovery_id: p.recovery?.id ?? null };
}

/** A live agent (`list`, `state`, `show`, `me`) as its record: columns plus the computed state and ctl link. */
export function liveAgentToOutput(agent: LiveAgent, workstreamId: number): AgentOutput {
  return agentToOutput(agent, workstreamId, {
    state: agent.state,
    source: agent.source,
    ...(agent.ctl !== undefined ? { ctl: agent.ctl } : {}),
    since: agent.since,
    ...(agent.reason !== undefined ? { reason: agent.reason } : {}),
    ...(agent.idle !== undefined ? { idle: agent.idle } : {}),
    ...(agent.queued === true ? { queued: true } : {}),
  });
}
