// mu — the host policies (plugins spec D10), provider hosts only: functions, not
// an interface. The final collect (`final_owed`) is cleared only by a collect
// that read `stop_gen` before its fetch (src/remote-collect.ts); in-life collects
// back off and never touch it. `closePluginJob` closes a plugin job record with
// no agent row: on a lost host the job went with the machine (unless
// `outlivesHost`) and an owed collect is kept as uncollected work. A `handle: "file"`
// kind's record with no handle reads its job file first (`recoverFileHandle`).

import { dirname } from "node:path";
import { CarrierJobKeptError, CarrierJobUnresolvedError } from "./agents/errors.js";
import type { LeaseClose } from "./agents/lease-carrier.js";
import { withAgentLock } from "./agents/lock.js";
import { getAgent } from "./agents.js";
import {
  abandonCarrierJob,
  bumpStopGen,
  type CarrierJob,
  fillCarrierJob,
  getCarrierJob,
  getCarrierJobByAgent,
  noteCarrierJob,
  setCollectNextAt,
} from "./carrier-jobs.js";
import { beginRelease } from "./carrier-wire.js";
import { carrierJobFilePath } from "./ctl/path.js";
import type { Db } from "./db.js";
import { deleteEffect, effectsOf, refuseLiveOwner } from "./effects.js";
import { observeHost } from "./host-lifecycle.js";
import { findHost, type HostRecord } from "./host-provider.js";
import { getHostRecord, hostDeadlineMarginMs, hostRecordById } from "./host-records.js";
import { describeRead, readJobFile } from "./jobs/lease.js";
import { viewOnServer } from "./jobs/view.js";
import { emitEvent } from "./logs.js";
import type { MuxBackend } from "./mux/types.js";
import { activeMux } from "./mux.js";
import { PluginCallError } from "./plugins/errors.js";
import { type PluginJobKind, pluginJobKind, pluginJobRef } from "./plugins/job.js";
import { collectInLifeLocked, collectRemoteAgentLocked } from "./remote-collect.js";
import { recoveriesFor } from "./remote-recovery.js";
import type { WaitResult } from "./wait-types.js";

/** The cap of an in-life collect's backoff (D10). */
export const IN_LIFE_BACKOFF_MAX_MS = 300_000;

/** A provider host gets in-life collects when it may go away under a job: idle reclaim or a deadline. */
export const inLifeCollectsOn = (rec: HostRecord): boolean =>
  rec.idle_reclaim_ms !== null || rec.deadline_at !== null;

export type InLifeCollect = "skipped" | "collected" | "failed";

/**
 * One in-life collect of job record `token` once its backoff passed; a failure doubles it, and
 * so does a success inside the deadline margin (D10). Its caller holds the agent lock, so the
 * backoff is read and written under it.
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
  const delay = Math.min(
    IN_LIFE_BACKOFF_MAX_MS,
    job.collectDelayMs === null ? opts.pollMs : job.collectDelayMs * 2,
  );
  try {
    await collect(job);
  } catch {
    setCollectNextAt(db, token, at + delay, delay);
    return "failed";
  }
  // Inside the deadline margin every wait may observe the host: a success backs off too.
  if (deadlineNotice(host, at)?.inMargin === true) setCollectNextAt(db, token, at + delay, delay);
  else setCollectNextAt(db, token, null, null);
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
    const collect = () =>
      collectInLifeLocked(db, { workstream: ref.workstream, name: ref.id, repo }).catch((e) => {
        why = e instanceof Error ? e.message : String(e);
        throw e;
      });
    let r: InLifeCollect;
    try {
      // The backoff's read-modify-write and the fetch under one agent lock (ruling 2).
      r = await withAgentLock(db, ref.workstream, ref.id, () =>
        inLifeCollect(db, job.token, collect, { pollMs }),
      );
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
      r = "failed";
    }
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
  const file = kind.caps.handle === "file";
  if (file) {
    // Proved on the record as it is now: the snapshot predates the awaited observation. The
    // proof's revision is what the release below compares (a rollback runs unlocked).
    const now = getCarrierJob(db, reservation.token);
    if (now === undefined) return undefined;
    await assertViewGone(now);
    reservation = now;
  }
  const proved = reservation;
  /** A file kind's record enters `released` on the proof's revision, or the close retains it. */
  const release = (r: CarrierJob): CarrierJob => {
    if (!file) return r;
    const rev = beginRelease(db, proved);
    const now = getCarrierJob(db, r.token);
    if (rev === undefined || now === undefined || now.wireRev !== rev) {
      throw new CarrierJobKeptError(
        r.name,
        r.workstream,
        r.host,
        "its view changed during the close (another view was dispatched)",
      );
    }
    return now;
  };
  // A lost host's job went with the machine, unless its kind outlives it: then only a stop proves it gone.
  if (hostLost(db, reservation.host) && kind.caps.outlivesHost !== true) {
    if (reservation.launch === "none" && reservation.job === null) {
      return { reservation, action: "unlaunched", facts: "never started" };
    }
    return settleLostJob(db, release(reservation));
  }
  let unresolved = "its job.start is unresolved";
  if (reservation.job === null && reservation.launch === "intent") {
    if (kind.caps.handle === "file") {
      const got = await recoverFileHandle(db, reservation, kind);
      if ("why" in got) unresolved = got.why;
    } else await kind.resolve(reservation.token);
  }
  const cur = getCarrierJob(db, reservation.token);
  if (cur === undefined) return undefined;
  if (cur.job === null) {
    const r = cur;
    if (r.launch === "none")
      return { reservation: r, action: "unlaunched", facts: "never started" };
    throw new CarrierJobUnresolvedError(
      r.name,
      r.workstream,
      r.host,
      `${unresolved} (mu agent close --abandon-job drops it)`,
    );
  }
  const r = release(cur);
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

/** What is known of a file kind's view: proven gone, alive, or neither. */
export type ViewProof = { state: "gone" } | { state: "alive" | "unknown"; why: string };

/**
 * THE rule of a `handle: "file"` kind's view (ladder placement §10): the view is its job's
 * dispatcher, so its record and job file are retained until the view's absence is PROVEN.
 * Every path that would stop the job, drop the record or remove the file asks this, and acts
 * only through a wire transition on the revision the proof read (src/carrier-wire.ts): close,
 * the spawn's rollback, a reattach (before its view), and a recovery's close. `unknown` always
 * retains, like `alive`. By the record's wire state:
 * - `claimed`: no view: gone. `released`: proven gone on entering, and none opens again.
 * - `dispatching`: a view asked for, its pane id never recorded: unknown.
 * - `bound`: its pane asked of the mux server recorded with it, and only that one
 *   (`viewOnServer`): another server's answer, no recorded server, or a failing probe is
 *   unknown. The pane and server are written together by the bind, never inferred from an
 *   equal pane id (another server, or a restarted one, reuses `%N`).
 * - null: a record older than the column (an upgrade): unknown.
 */
export async function proveViewGone(r: CarrierJob, mux?: MuxBackend): Promise<ViewProof> {
  const dispatcher = "(the job's dispatcher)";
  switch (r.wireState) {
    case "claimed":
    case "released":
      return { state: "gone" };
    case "dispatching":
      return { state: "unknown", why: `its view ${dispatcher} opened with no pane id recorded` };
    case "bound": {
      if (r.paneId === null) return { state: "unknown", why: `its view ${dispatcher} has no pane` };
      if (r.viewServer === null) {
        return {
          state: "unknown",
          why: `its view ${r.paneId} ${dispatcher} has no recorded mux server`,
        };
      }
      // D15: a backend without carrierViews (Rex) cannot tie an absent reply to its server.
      const m = mux ?? (await activeMux().catch(() => undefined));
      if (m !== undefined && !m.carrierViews && r.viewServer.startsWith(`${m.name}:`)) {
        return {
          state: "unknown",
          why: `its view ${r.paneId} ${dispatcher} is on ${m.name}, which cannot prove it gone yet (lease and plugin job views are tmux-only for now)`,
        };
      }
      const seen =
        m === undefined
          ? undefined
          : await viewOnServer(r.paneId, r.viewServer, m).catch(() => undefined);
      if (seen === "absent") return { state: "gone" };
      if (seen === "present") {
        return { state: "alive", why: `its view ${r.paneId} ${dispatcher} is alive` };
      }
      return {
        state: "unknown",
        why:
          seen === "elsewhere"
            ? `its view ${r.paneId} ${dispatcher} is on mux server ${r.viewServer}, which this mu does not drive (MU_TMUX_SOCKET, MU_MUX): close it from there`
            : `its view ${r.paneId} ${dispatcher} is not proven gone`,
      };
    }
    default:
      return {
        state: "unknown",
        why: `its view ${dispatcher} is unknown (the record predates view tracking)`,
      };
  }
}

/** `proveViewGone` or `CarrierJobKeptError`, everything kept; `--abandon-job` is the way out. */
async function assertViewGone(r: CarrierJob): Promise<void> {
  const p = await proveViewGone(r);
  if (p.state !== "gone") throw new CarrierJobKeptError(r.name, r.workstream, r.host, p.why);
}

/**
 * The handle of a `handle: "file"` plugin job record that may have launched and holds none
 * (ladder placement §10). The local job file first, which needs no master; then the unresolved
 * `job.start` by the rule table; then `job.lookup` by key, which finds a claim the view made
 * before it published the file. A found handle fills the record, token-guarded. An absent file
 * and a lookup's `none`, `pending` or `unknown` never act: the view is the dispatcher, and it
 * may still claim and publish (plugins spec D4). An invalid or unreadable file is noted on the
 * record and still asks the lookup. Errors of the lookup are reasons, except a `human` answer
 * (the master's hand-back), which is thrown as is: the record stays, and a close is human needed.
 */
export async function recoverFileHandle(
  db: Db,
  rec: CarrierJob,
  kind: PluginJobKind,
): Promise<{ handle: string } | { why: string }> {
  const now = () => getCarrierJob(db, rec.token);
  const r = now();
  if (r === undefined) return { why: "its job record is gone" };
  if (r.job !== null) return { handle: r.job };
  if (r.launch !== "intent") return { why: "its job was never started" };
  const path = carrierJobFilePath(r.workstream, r.name, dirname(db.name));
  const read = readJobFile(path);
  if (read.kind === "handle") {
    if (fillCarrierJob(db, r.token, read.job)) return { handle: read.job };
    const other = now()?.job;
    return other == null ? { why: "its job record changed" } : { handle: other };
  }
  const file = `the job file ${path} is ${describeRead(read)}`;
  if (read.kind !== "none") noteCarrierJob(db, r.token, file);
  let why = `${file}, and the view may still write one`;
  try {
    if (effectsOf(db, "job", r.token).length > 0) {
      for (const x of await kind.resolve(r.token)) {
        if (x.state === "unknown") why = `${file}; its job.start is unresolved: ${x.reason}`;
      }
    } else if (kind.caps.start.lookup) {
      const host = findHost(db, r.host);
      if (host === undefined) return { why: `${file}, and host ${r.host} is gone` };
      const l = await kind.lookup(host, r.token, { fence: false });
      if ("found" in l) fillCarrierJob(db, r.token, l.found.handle);
      else if ("none" in l) why = `${file}, and lookup by key found no claim yet`;
      else why = `${file}; lookup by key: ${"unknown" in l ? l.unknown : "still in flight"}`;
    }
  } catch (e) {
    // A hand-back (the master asks for a person) stays one: the caller's exit-5 lane (§5.1).
    if (e instanceof PluginCallError && e.kind === "human") throw e;
    why = `${file}; lookup by key failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const filled = now()?.job;
  return filled == null ? { why } : { handle: filled };
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
