// mu — `mu agent reattach`'s preflight and preview (reattach.ts applies), split at the
// spec's seam (docs/specs/2026-11-04-lease-adopt.md § mu_adopt). Local only: the DB, local
// files and one mux probe, never a host command. `agent list`'s leftovers share
// `reattachBlockers`, so a leftover's `next` and the verb agree.

import { getAgentForCleanup } from "../agents.js";
import { type CarrierJob, listCarrierJobsByName } from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { type HostProfile, pidProvenGone } from "../hosts.js";
import { say } from "../messages.js";
import { activeMux } from "../mux.js";
import { localPaneAlive } from "../remote-agent.js";
import * as recovery from "../remote-recovery.js";
import { agentRevision } from "../revision.js";
import { AgentExistsError, AgentReplacedError } from "./errors.js";
import { describeRead, leaseJobFile, readJobFile } from "./lease-carrier.js";

/** One reason the name cannot be reattached now; `code` names the preflight step. */
export interface Blocker {
  code: "row" | "workstream" | "reservation" | "carrier" | "profile" | "recovery" | "job-file";
  detail: string;
}

/** The preflight refused: nothing was changed. Exit 4; the message names the close preview. */
export class ReattachRefusedError extends Error {
  override readonly name = "ReattachRefusedError";
  constructor(
    public readonly agentName: string,
    public readonly blockers: readonly Blocker[],
    public readonly closeCommand: string,
  ) {
    super(say("agent.reattach_refused", agentName, blockers[0]?.detail ?? "", closeCommand));
  }
}

export interface Plan {
  r: CarrierJob & { job: string; agentId: number; paneId: string };
  profile: HostProfile;
  rec: recovery.RemoteRecovery | undefined;
  wsId: number;
  jobFile: string;
}

async function preflight(db: Db, ws: string, name: string): Promise<Blocker | Plan> {
  const no = (code: Blocker["code"], detail: string): Blocker => ({ code, detail });
  if (getAgentForCleanup(db, name, ws) !== undefined) return no("row", "it has an agent row");
  const w = db.prepare("SELECT id, torn_down_at FROM workstreams WHERE name = ?").get(ws) as
    | { id: number; torn_down_at: string | null }
    | undefined;
  if (w?.torn_down_at !== null) return no("workstream", `workstream ${ws} is gone or torn down`);
  const all = listCarrierJobsByName(db, ws, name);
  const r = all[0];
  if (r === undefined || all.length !== 1) {
    return no("reservation", `the name has ${all.length} lease reservations, not one`);
  }
  // The bind stamped the generation its row lived in; NULL predates the column: unknown.
  if (r.workstreamId === null) return no("workstream", `its binding's workstream is unknown`);
  if (r.workstreamId !== w.id) return no("workstream", `${ws} was created again since`);
  const { job, agentId, paneId } = r;
  if (job === null || r.launch !== "intent" || agentId === null || paneId === null) {
    return no("reservation", "its reservation holds no job handle bound to a spawned agent");
  }
  if (r.reason !== null || r.treePath !== null) return no("reservation", `kept: ${r.reason}`);
  const alive = await localPaneAlive(paneId).catch(() => undefined);
  if (alive !== false)
    return no("carrier", `its previous pane ${paneId} is ${alive ? "alive" : "unknown"}`);
  if (r.creatorPid === null || !pidProvenGone(r.creatorPid, r.creatorStart)) {
    return no("carrier", `its spawn's process ${r.creatorPid ?? "?"} is not proven gone`);
  }
  const profile = db.prepare("SELECT * FROM host_profiles WHERE name = ?").get(r.host) as
    | HostProfile
    | undefined;
  if (profile?.transport !== "lease" || profile.attach === null) {
    return no("profile", `host ${r.host} has no lease profile with an attach template`);
  }
  if (profile.stop !== r.hostStop) return no("profile", `host ${r.host}'s stop changed`);
  const rec = recovery.getRemoteRecovery(db, agentId);
  try {
    if (
      rec !== undefined &&
      (rec.name !== name || rec.host !== r.host || rec.workstreamId !== w.id)
    ) {
      throw new Error(`recovery ${agentId} belongs to another workstream, name or host`);
    }
    if (rec !== undefined) recovery.assertRecoveryUsable(db, rec);
  } catch (e) {
    return no("recovery", e instanceof Error ? e.message : String(e));
  }
  const jobFile = leaseJobFile(db, ws, name);
  const read = readJobFile(jobFile);
  if (read.kind !== "none" && !(read.kind === "handle" && read.job === job)) {
    return no("job-file", `the job file ${jobFile} is ${describeRead(read)}`);
  }
  const mux = await activeMux();
  if (!mux.runsShellCommand) return no("carrier", `${mux.name} cannot run the attach template`);
  return { r: { ...r, job, agentId, paneId }, profile, rec, wsId: w.id, jobFile };
}

/** Why (workstream, name) cannot be reattached now; empty when it can. Read only. */
export async function reattachBlockers(db: Db, ws: string, name: string): Promise<Blocker[]> {
  const p = await preflight(db, ws, name);
  return "code" in p ? [p] : [];
}

/** The close preview a refusal names: with `--recovery` when the name has several records. */
export function closeCommand(db: Db, ws: string, name: string): string {
  const own = listCarrierJobsByName(db, ws, name).map((j) => j.agentId);
  const recs = recovery.recoveriesFor(db, ws, name);
  const pick = recs.length > 1 ? recs.find((x) => own.includes(x.agentId)) : undefined;
  return `mu agent close ${name} -w ${ws}${pick ? ` --recovery ${pick.agentId}` : ""}`;
}

/** The preflight's plan, or its refusal thrown (a live row is AgentExistsError). */
export async function plan(db: Db, ws: string, name: string): Promise<Plan> {
  const p = await preflight(db, ws, name);
  if (!("code" in p)) return p;
  if (p.code === "row") throw new AgentExistsError(name);
  throw new ReattachRefusedError(name, [p], closeCommand(db, ws, name));
}

/** What a reattach acts on, keys as SQL names: the reaped incarnation, its job, its tree. */
export const factsOf = (ws: string, { r, rec }: Plan) => ({
  name: r.name,
  workstream: ws,
  host: r.host,
  job: r.job,
  previous_agent_id: r.agentId,
  previous_pane_id: r.paneId,
  /** The record the new row takes its tree from; null for a `--cwd` agent. */
  recovery_id: rec?.agentId ?? null,
  cwd: rec?.cwd ?? null,
  base: rec?.base ?? null,
});
export type ReattachFacts = ReturnType<typeof factsOf>;

/**
 * The plan and the revision of ONE snapshot. The plan awaits a mux probe, so the name may be
 * closed and spawned again meanwhile: the plan's DB facts are re-read with the revision in one
 * read transaction (under WAL its first read pins a snapshot) and the plan retried when they
 * moved. A name that will not hold still refuses (AgentReplacedError), like `previewClose`.
 */
export async function planSnapshot(db: Db, ws: string, name: string) {
  const facts = (agentId: number) => ({
    row: getAgentForCleanup(db, name, ws) !== undefined,
    ws: db.prepare("SELECT id, torn_down_at FROM workstreams WHERE name = ?").get(ws),
    jobs: listCarrierJobsByName(db, ws, name),
    rec: recovery.getRemoteRecovery(db, agentId),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await plan(db, ws, name);
    const was = { row: false, ws: { id: p.wsId, torn_down_at: null }, jobs: [p.r], rec: p.rec };
    const revision = db.transaction(() =>
      JSON.stringify(facts(p.r.agentId)) === JSON.stringify(was)
        ? agentRevision(db, ws, name)
        : undefined,
    )();
    if (revision !== undefined) return { p, revision };
  }
  throw new AgentReplacedError(name, ws, "reattached");
}

/** Bare `agent reattach`: the preflight, its facts, and the revision `--if` needs. Read only. */
export async function previewReattach(db: Db, ws: string, name: string) {
  const { p, revision } = await planSnapshot(db, ws, name);
  return { ...factsOf(ws, p), revision };
}
