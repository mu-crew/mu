// mu — the host policies (plugins spec D10), provider hosts only: functions, not
// an interface. The final collect (`final_owed`) is cleared only by a collect
// that read `stop_gen` before its fetch (src/remote-collect.ts); in-life collects
// back off and never touch it. `closePluginJob` closes a plugin job record with
// no agent row: on a lost host the job went with the machine (unless
// `outlivesHost`) and an owed collect is kept as uncollected work.

import { CarrierJobKeptError, CarrierJobUnresolvedError } from "./agents/errors.js";
import type { LeaseClose } from "./agents/lease-carrier.js";
import { getAgent } from "./agents.js";
import {
  abandonCarrierJob,
  bumpStopGen,
  type CarrierJob,
  getCarrierJob,
  getCarrierJobByAgent,
  noteCarrierJob,
  setCollectNextAt,
} from "./carrier-jobs.js";
import type { Db } from "./db.js";
import { deleteEffect, effectsOf, refuseLiveOwner } from "./effects.js";
import { observeHost } from "./host-lifecycle.js";
import type { HostRecord } from "./host-provider.js";
import { getHostRecord, hostDeadlineMarginMs, hostRecordById } from "./host-records.js";
import { emitEvent } from "./logs.js";
import { pluginJobKind, pluginJobRef } from "./plugins/job.js";
import { collectRemoteAgent, collectRemoteAgentLocked } from "./remote-collect.js";
import { recoveriesFor } from "./remote-recovery.js";
import type { WaitResult } from "./wait-types.js";

/** The cap of an in-life collect's backoff (D10). */
export const IN_LIFE_BACKOFF_MAX_MS = 300_000;

/** A provider host gets in-life collects when it may go away under a job: idle reclaim or a deadline. */
export const inLifeCollectsOn = (rec: HostRecord): boolean =>
  rec.idle_reclaim_ms !== null || rec.deadline_at !== null;

export type InLifeCollect = "skipped" | "collected" | "failed";

/** One in-life collect of job record `token` once its backoff passed; a failure doubles it (D10). */
export async function inLifeCollect(
  db: Db,
  token: string,
  collect: (job: CarrierJob) => Promise<unknown>,
  opts: { pollMs: number; at?: number },
): Promise<InLifeCollect> {
  const job = getCarrierJob(db, token);
  const host = job?.hostId == null ? undefined : hostRecordById(db, job.hostId);
  if (job === undefined || host === undefined || !inLifeCollectsOn(host)) return "skipped";
  const at = opts.at ?? Date.now();
  if (job.collectNextAt !== null && at < job.collectNextAt) return "skipped";
  try {
    await collect(job);
  } catch {
    const delay = Math.min(
      IN_LIFE_BACKOFF_MAX_MS,
      job.collectDelayMs === null ? opts.pollMs : job.collectDelayMs * 2,
    );
    setCollectNextAt(db, token, at + delay, delay);
    return "failed";
  }
  setCollectNextAt(db, token, null, null);
  return "collected";
}

/**
 * The in-life collects a wait's result triggers (D10), after it is decided: each agent whose
 * settle it fired, and on a `deadline` every agent it watched. Only a provider-host job record
 * with a tree and a collect repo; `inLifeCollect` skips the rest. One warning per failure.
 */
export async function collectAtSettles(
  db: Db,
  result: Pick<WaitResult, "event" | "refs">,
  pollMs: number,
): Promise<string[]> {
  const warnings: string[] = [];
  const due = result.refs.filter(
    (s) =>
      s.ref.kind === "agent" &&
      ((s.fired && s.settled === true) || result.event.kind === "deadline"),
  );
  for (const { ref } of due) {
    const agent = getAgent(db, ref.id, ref.workstream);
    const job = agent === undefined ? undefined : getCarrierJobByAgent(db, agent.incarnation);
    const repo = job?.collectRepo;
    if (job?.plugin == null || job.treePath === null || repo == null) continue;
    let why = "";
    const r = await inLifeCollect(
      db,
      job.token,
      () =>
        collectRemoteAgent(db, { workstream: ref.workstream, name: ref.id, repo }).catch((e) => {
          why = e instanceof Error ? e.message : String(e);
          throw e;
        }),
      { pollMs },
    );
    if (r === "failed") {
      warnings.push(
        `in-life collect of ${ref.workstream}/${ref.id} failed (${why}); retried at a later settle (mu agent collect ${ref.id} -w ${ref.workstream})`,
      );
    }
  }
  return warnings;
}

export interface DeadlineNotice {
  deadlineAt: number;
  /** Ms left until the deadline (negative: past). */
  leftMs: number;
  /** Inside the margin: spawns refuse and the host drains. */
  inMargin: boolean;
}

/** Where host `rec`'s deadline stands (D10); undefined for a host without one. */
export function deadlineNotice(rec: HostRecord, at = Date.now()): DeadlineNotice | undefined {
  if (rec.deadline_at === null) return undefined;
  const leftMs = rec.deadline_at - at;
  return { deadlineAt: rec.deadline_at, leftMs, inMargin: leftMs <= hostDeadlineMarginMs() };
}

/** True when host `name` is a provider host mu recorded `lost`. */
export function hostLost(db: Db, name: string): boolean {
  return getHostRecord(db, name)?.state === "lost";
}

/** Ask a provider host's status once before a close reports (D1); a no-op for a static host. */
export async function observeBeforeClose(db: Db, name: string): Promise<void> {
  const rec = getHostRecord(db, name);
  if (rec !== undefined && (rec.state === "ready" || rec.state === "draining")) {
    await observeHost(db, name);
  }
}

/** `--abandon-job` of a plugin job record: no stop; its effects and loss event in one transaction. */
function abandonPluginJob(db: Db, r: CarrierJob): LeaseClose {
  let facts = "";
  db.transaction(() => {
    const effects = effectsOf(db, "job", r.token);
    for (const e of effects) refuseLiveOwner(e);
    facts = [
      r.job === null ? "no handle" : `job ${r.job}`,
      ...effects.map((e) => `unresolved ${e.method} ${e.key}`),
      ...(r.finalOwed ? ["its final collect is lost (uncollected work)"] : []),
    ].join(", ");
    for (const e of effects) deleteEffect(db, e.key);
    if (!abandonCarrierJob(db, r)) {
      throw new CarrierJobKeptError(r.name, r.workstream, r.host, "the job record changed");
    }
    emitEvent(
      db,
      r.workstream,
      "agent.close",
      `agent close ${r.name}: job record on ${r.host} abandoned (${facts})`,
    );
  }).immediate();
  return { reservation: r, action: "abandon", facts };
}

/** A job gone with its lost host: in ONE transaction its effects are logged lost and dropped. */
function settleLostJob(db: Db, r: CarrierJob): LeaseClose {
  const out = db
    .transaction((): LeaseClose => {
      const effects = effectsOf(db, "job", r.token);
      for (const e of effects) refuseLiveOwner(e);
      for (const e of effects) deleteEffect(db, e.key);
      bumpStopGen(db, r.token);
      if (r.finalOwed) noteCarrierJob(db, r.token, "uncollected work");
      const facts = [
        r.job === null ? "no handle" : `job ${r.job}`,
        "gone with its host",
        ...effects.map((e) => `${e.method} ${e.key} lost with the host`),
      ].join(", ");
      emitEvent(
        db,
        r.workstream,
        "agent.close",
        `agent close ${r.name}: host ${r.host} is lost (${facts})${r.finalOwed ? `; its final collect is uncollected work (mu agent close ${r.name} --abandon-job drops the record)` : ""}`,
      );
      const now = getCarrierJob(db, r.token) ?? r;
      return { reservation: now, action: r.finalOwed ? "kept" : "stopped", facts };
    })
    .immediate();
  return out;
}

/** Step 4 of a no-row close for a plugin job record; a live host's final collect runs before the tree. */
export async function closePluginJob(
  db: Db,
  reservation: CarrierJob,
  opts: { abandon?: boolean } = {},
): Promise<LeaseClose | undefined> {
  if (getCarrierJob(db, reservation.token) === undefined) return undefined;
  if (opts.abandon === true) return abandonPluginJob(db, reservation);
  await observeBeforeClose(db, reservation.host);
  const kind = pluginJobKind(db, reservation.plugin ?? "");
  if (kind === undefined) {
    throw new CarrierJobUnresolvedError(
      reservation.name,
      reservation.workstream,
      reservation.host,
      `plugin ${reservation.plugin} has no job seam to stop it with`,
    );
  }
  // A lost host's job went with the machine, unless its kind outlives it: then only a stop proves it gone.
  if (hostLost(db, reservation.host) && kind.caps.outlivesHost !== true) {
    if (reservation.launch === "none" && reservation.job === null) {
      return { reservation, action: "unlaunched", facts: "never started" };
    }
    return settleLostJob(db, reservation);
  }
  if (reservation.job === null && reservation.launch === "intent")
    await kind.resolve(reservation.token);
  const r = getCarrierJob(db, reservation.token);
  if (r === undefined) return undefined;
  if (r.job === null) {
    if (r.launch === "none")
      return { reservation: r, action: "unlaunched", facts: "never started" };
    throw new CarrierJobUnresolvedError(
      r.name,
      r.workstream,
      r.host,
      `its job.start is unresolved (mu agent close --abandon-job drops it)`,
    );
  }
  const ref = pluginJobRef(db, r.token);
  if (ref !== undefined) await kind.stop(db, ref);
  bumpStopGen(db, r.token);
  const facts = `job ${r.job}`;
  if (r.finalOwed) {
    // On a lost host an outlivesHost job is stopped, but its tree went with the machine.
    if (hostLost(db, r.host)) return settleLostJob(db, getCarrierJob(db, r.token) ?? r);
    await finalCollect(db, r);
  }
  return { reservation: getCarrierJob(db, r.token) ?? r, action: "stopped", facts };
}

/** The final collect of a stopped job record, from its `collect_repo` (D10); refuses, record kept, when it cannot run. */
async function finalCollect(db: Db, r: CarrierJob): Promise<void> {
  const rec = recoveriesFor(db, r.workstream, r.name).find(
    (x) => x.host === r.host && x.cwd === r.treePath,
  );
  // A live agent's close (its row still names the tree): collected from the row.
  const live = getAgent(db, r.name, r.workstream);
  const fromRow = live?.host === r.host && live.cwd === r.treePath;
  const owed = (why: string): never => {
    throw new CarrierJobKeptError(
      r.name,
      r.workstream,
      r.host,
      `job ${r.job ?? "-"} is stopped, but its final collect is owed (${why})`,
    );
  };
  if (rec === undefined && !fromRow) return owed("no recovery record names its tree");
  const by = rec === undefined ? "" : ` --recovery ${rec.agentId}`;
  if (r.collectRepo === null) return owed(`mu agent collect ${r.name}${by} --repo <local repo>`);
  try {
    await collectRemoteAgentLocked(db, {
      workstream: r.workstream,
      name: r.name,
      repo: r.collectRepo,
      ...(rec !== undefined && !fromRow ? { recoveryId: rec.agentId } : {}),
    });
  } catch (e) {
    owed(`${e instanceof Error ? e.message : String(e)}; mu agent collect ${r.name}${by}`);
  }
  if (getCarrierJob(db, r.token)?.finalOwed !== false) owed("the collect did not clear it");
}
