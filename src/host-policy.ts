// mu — the host policies (plugins spec D10): functions, not an interface
// (Principle 7), for provider hosts only. Static hosts keep today's rules.
//
// Collects. The FINAL collect is an obligation: `final_owed`, set when the job
// record of a `--worktree` job on a provider host is made (src/host-records.ts).
// Only a collect that STARTS after the job stopped or was lost clears it: the
// stop or loss bumps `stop_gen`, a collect reads it before its fetch and clears
// the flag with `WHERE stop_gen = <read value>` (src/remote-collect.ts). Reads,
// settles and in-life collects never clear it, nothing sets it again, and a
// collect that read no generation clears nothing: an older collect never
// clears a newer turn. Worktree removal and host release wait on it; only
// `--abandon-job` and `host release --abandon` skip it, logging the loss.
// IN-LIFE collects are best effort on hosts with idle reclaim or a deadline:
// each failure backs off `collect_next_at`, one poll interval doubling to 5
// minutes; they record the collected HEAD and never touch the flag.
//
// The deadline. Inside `MU_HOST_DEADLINE_MARGIN_MS` of `deadline_at` spawns
// refuse and the host drains (admission and the status read do that); mu
// never closes an agent on its own.
//
// A plugin job record's close with no agent row (`closePluginJob`): its host's
// status is asked once. On a `lost` host the tree is gone with the machine, so
// the job is recorded stopped without a call, unless its kind `outlivesHost`:
// then `job.stop` runs and its proof is awaited. An owed final collect on a lost
// host is lost work: the record stays, reason "uncollected work", until an
// abandon. On a live host the stop runs, then the final collect from the
// record's `collect_repo`, before the tree is touched.

import { CarrierJobKeptError, CarrierJobUnresolvedError } from "./agents/errors.js";
import type { LeaseClose } from "./agents/lease-carrier.js";
import {
  abandonCarrierJob,
  bumpStopGen,
  type CarrierJob,
  getCarrierJob,
  noteCarrierJob,
  setCollectNextAt,
} from "./carrier-jobs.js";
import type { Db } from "./db.js";
import { creatorGone, EffectHeldError, effectsOf } from "./effects.js";
import { observeHost } from "./host-lifecycle.js";
import type { HostRecord } from "./host-provider.js";
import { getHostRecord, hostDeadlineMarginMs, hostRecordById } from "./host-records.js";
import { pidProvenGone } from "./hosts.js";
import { emitEvent } from "./logs.js";
import { pluginJobKind, pluginJobRef } from "./plugins/job.js";
import { collectRemoteAgentLocked } from "./remote-collect.js";
import { recoveriesFor } from "./remote-recovery.js";

/** The cap of an in-life collect's backoff (D10). */
export const IN_LIFE_BACKOFF_MAX_MS = 300_000;

/** A provider host gets in-life collects when it may go away under a job: idle reclaim or a deadline. */
export const inLifeCollectsOn = (rec: HostRecord): boolean =>
  rec.idle_reclaim_ms !== null || rec.deadline_at !== null;

export type InLifeCollect = "skipped" | "collected" | "failed";

/**
 * One in-life collect of job record `token` (D10), when its host has them and its backoff has
 * passed: `collect` runs (the caller's `mu agent collect` from the record's `collect_repo`).
 * A failure backs off (`pollMs`, doubling to 5 minutes) and is the caller's warning.
 */
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

/**
 * `--abandon-job` of a plugin job record: no stop. Refuses while an effect on it has a live
 * owner; drops its effects with it, and the event names the handle, every unresolved key and
 * an owed final collect's loss (D1).
 */
function abandonPluginJob(db: Db, r: CarrierJob): LeaseClose {
  const effects = effectsOf(db, "job", r.token);
  for (const e of effects) {
    if (e.state === "pending" && !creatorGone(e))
      throw new EffectHeldError(e.key, "creator", e.creator_pid);
    if (
      e.state === "resolving" &&
      e.resolver_pid !== null &&
      !pidProvenGone(e.resolver_pid, e.resolver_start)
    ) {
      throw new EffectHeldError(e.key, "resolver", e.resolver_pid);
    }
  }
  const facts = [
    r.job === null ? "no handle" : `job ${r.job}`,
    ...effects.map((e) => `unresolved ${e.method} ${e.key}`),
    ...(r.finalOwed ? ["its final collect is lost (uncollected work)"] : []),
  ].join(", ");
  db.transaction(() => {
    for (const e of effects) db.prepare("DELETE FROM effects WHERE key = ?").run(e.key);
    if (!abandonCarrierJob(db, r)) {
      throw new CarrierJobKeptError(
        r.name,
        r.workstream,
        r.host,
        "the job record changed during the close",
      );
    }
  }).immediate();
  emitEvent(
    db,
    r.workstream,
    "agent.close",
    `agent close ${r.name}: job record on ${r.host} abandoned (${facts})`,
  );
  return { reservation: r, action: "abandon", facts };
}

/**
 * Step 4 of a close with no agent row, for a plugin job record (any host): stopped, abandoned,
 * unlaunched, or `kept` (a lost host's owed final collect). A live host's owed final collect
 * runs here, under the caller's agent lock, before the tree is touched; one that cannot run
 * refuses with the record kept (`CarrierJobKeptError`).
 */
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
  if (reservation.job === null && reservation.launch === "intent")
    await kind.resolve(reservation.token);
  const r = getCarrierJob(db, reservation.token);
  if (r === undefined) return undefined;
  const lost = hostLost(db, r.host);
  if (r.job === null) {
    if (r.launch === "none")
      return { reservation: r, action: "unlaunched", facts: "never started" };
    // An unresolved start on a lost host: whatever it made went with the machine, unless it outlives it.
    if (!lost || kind.caps.outlivesHost === true) {
      throw new CarrierJobUnresolvedError(
        r.name,
        r.workstream,
        r.host,
        `its job.start is unresolved (mu agent close --abandon-job drops it)`,
      );
    }
  }
  // A lost host's job went with the machine, unless its kind outlives it: then only a stop proves it gone.
  if (r.job !== null && (!lost || kind.caps.outlivesHost === true)) {
    const ref = pluginJobRef(db, r.token);
    if (ref !== undefined) await kind.stop(db, ref);
  }
  bumpStopGen(db, r.token);
  const facts =
    r.job === null
      ? "never started"
      : `job ${r.job}${lost && kind.caps.outlivesHost !== true ? " (gone with its host)" : ""}`;
  if (!r.finalOwed)
    return { reservation: getCarrierJob(db, r.token) ?? r, action: "stopped", facts };
  if (lost) {
    noteCarrierJob(db, r.token, "uncollected work");
    emitEvent(
      db,
      r.workstream,
      "agent.close",
      `agent close ${r.name}: host ${r.host} is lost; its final collect is uncollected work (mu agent close ${r.name} --abandon-job drops the record)`,
    );
    return { reservation: getCarrierJob(db, r.token) ?? r, action: "kept", facts };
  }
  await finalCollect(db, r);
  return { reservation: getCarrierJob(db, r.token) ?? r, action: "stopped", facts };
}

/** The final collect of a stopped job record, from its `collect_repo` (D10); refuses, record kept, when it cannot run. */
async function finalCollect(db: Db, r: CarrierJob): Promise<void> {
  const rec = recoveriesFor(db, r.workstream, r.name).find(
    (x) => x.host === r.host && x.cwd === r.treePath,
  );
  const owed = (why: string): never => {
    throw new CarrierJobKeptError(
      r.name,
      r.workstream,
      r.host,
      `job ${r.job ?? "-"} is stopped, but its final collect is owed (${why})`,
    );
  };
  if (rec === undefined) return owed("no recovery record names its tree");
  if (r.collectRepo === null)
    return owed(`mu agent collect ${r.name} --recovery ${rec.agentId} --repo <local repo>`);
  try {
    await collectRemoteAgentLocked(db, {
      workstream: r.workstream,
      name: r.name,
      repo: r.collectRepo,
      recoveryId: rec.agentId,
    });
  } catch (e) {
    owed(
      `${e instanceof Error ? e.message : String(e)}; mu agent collect ${r.name} --recovery ${rec.agentId}`,
    );
  }
  if (getCarrierJob(db, r.token)?.finalOwed !== false) owed("the collect did not clear it");
}
