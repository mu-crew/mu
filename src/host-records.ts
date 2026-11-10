// mu — `hosts`: provider host records (plugins spec D1, D5, D6), the table and
// nothing that calls a plugin. A record is written with its `host.acquire`
// effect (src/plugins/provider.ts) and mu alone moves its state:
//
//   acquiring → ready (the acquire's facts) → draining → releasing → deleted
//   ready | draining → lost (a `gone` status)       any → deleted (--abandon)
//
// A name is a profile's or a record's, never both: inserting a record refuses
// a profile's name, and `addHost` refuses a record's (src/hosts.ts).
//
// Two transactions here are the seam's guarantees. Atomic admission
// (`reserveProviderJob`) re-reads the record, refuses unless `ready` and
// outside the deadline margin, and counts the host's job records against
// `max_jobs`, inserting the job record in the same immediate transaction. The
// release proof (`beginHostRelease`) moves the host to `releasing` only while
// no agent row, job record or recovery record names it. SQLite's write lock
// orders the two, so a spawn and a release never both pass.

import { type CarrierJob, getCarrierJob, reserveCarrierJob } from "./carrier-jobs.js";
import type { Db } from "./db.js";
import { findHost, type HostFacts, type HostRecord, type HostState } from "./host-provider.js";
import { HostExistsError, pidStart } from "./hosts.js";

/** A host verb on a record in a state it does not accept. Exit 4. */
export class HostStateError extends Error {
  override readonly name = "HostStateError";
  constructor(
    public readonly host: string,
    public readonly state: HostState,
    want: string,
  ) {
    super(`host ${host} is ${state}: ${want}`);
  }
}

/** A spawn inside a host's deadline margin (D10): refused, and the host is draining. Exit 4. */
export class HostDeadlineError extends Error {
  override readonly name = "HostDeadlineError";
  constructor(
    public readonly host: string,
    public readonly deadlineAt: number,
  ) {
    super(
      `host ${host} reaches its deadline at ${new Date(deadlineAt).toISOString()}: no new jobs; it is draining (collect and close its agents)`,
    );
  }
}

/** A spawn on a host whose job slots (`max_jobs`) are all taken. Exit 4. */
export class HostJobsFullError extends Error {
  override readonly name = "HostJobsFullError";
  constructor(
    public readonly host: string,
    public readonly maxJobs: number,
  ) {
    super(`host ${host} runs ${maxJobs} job(s), its provider's max: close one first`);
  }
}

/** What still names a provider host: its release waits for every one. */
export interface HostReferences {
  agents: string[];
  jobs: CarrierJob[];
  recoveries: number[];
}

/** `host release` while something names the host. Exit 4. */
export class HostReferencedError extends Error {
  override readonly name = "HostReferencedError";
  constructor(
    public readonly host: string,
    public readonly refs: HostReferences,
  ) {
    const owing = refs.jobs.filter((j) => j.finalOwed);
    const bits = [
      refs.agents.length > 0 ? `agents ${refs.agents.join(", ")}` : "",
      refs.jobs.length > 0 ? `job records ${refs.jobs.map(jobName).join(", ")}` : "",
      refs.recoveries.length > 0 ? `recovery records ${refs.recoveries.join(", ")}` : "",
    ].filter((b) => b !== "");
    const owed =
      owing.length === 0
        ? ""
        : `; final collect owed by ${owing.map(jobName).join(", ")} (mu agent collect <name> --recovery <id>)`;
    super(`host ${host} is still named by ${bits.join("; ")}${owed}: close them first`);
  }
}

const jobName = (j: CarrierJob): string => `${j.workstream}/${j.name}`;

/** The margin before a provider deadline in which spawns refuse (D10). Default 10 minutes. */
export function hostDeadlineMarginMs(): number {
  const raw = Number(process.env.MU_HOST_DEADLINE_MARGIN_MS);
  return Number.isFinite(raw) && raw >= 0 && process.env.MU_HOST_DEADLINE_MARGIN_MS !== ""
    ? raw
    : 600_000;
}

const now = (): string => new Date().toISOString();

export function getHostRecord(db: Db, name: string): HostRecord | undefined {
  return db.prepare("SELECT * FROM hosts WHERE name = ?").get(name) as HostRecord | undefined;
}

export function hostRecordById(db: Db, id: number): HostRecord | undefined {
  return db.prepare("SELECT * FROM hosts WHERE id = ?").get(id) as HostRecord | undefined;
}

export function listHostRecords(db: Db): HostRecord[] {
  return db.prepare("SELECT * FROM hosts ORDER BY name").all() as HostRecord[];
}

/** The provider hosts of plugin `name` (`mu plugin rm` refuses while one names it). */
export function hostRecordsOfProvider(db: Db, name: string): string[] {
  return (
    db.prepare("SELECT name FROM hosts WHERE provider = ? ORDER BY name").all(name) as {
      name: string;
    }[]
  ).map((r) => r.name);
}

/** A new record in `acquiring`, refusing a name a profile or another record holds. Its id. */
export function insertHostRecord(
  db: Db,
  a: { name: string; provider: string; params: Record<string, string>; repo: string | null },
  instance: string,
): number {
  if (findHost(db, a.name) !== undefined) throw new HostExistsError(a.name);
  const t = now();
  return Number(
    db
      .prepare(
        `INSERT INTO hosts (name, provider, params_json, repo, instance, state, creator_pid, creator_start, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'acquiring', ?, ?, ?, ?)`,
      )
      .run(
        a.name,
        a.provider,
        JSON.stringify(a.params),
        a.repo,
        instance,
        process.pid,
        pidStart(process.pid),
        t,
        t,
      ).lastInsertRowid,
  );
}

/** The acquire's facts: `acquiring` → `ready`. */
export function fillHostRecord(db: Db, id: number, f: HostFacts): boolean {
  return (
    db
      .prepare(
        `UPDATE hosts SET state = 'ready', handle = ?, deadline_at = ?, idle_reclaim_ms = ?, max_jobs = ?, updated_at = ?
         WHERE id = ? AND state = 'acquiring'`,
      )
      .run(f.handle, f.deadlineAt ?? null, f.idleReclaimMs ?? null, f.maxJobs ?? null, now(), id)
      .changes === 1
  );
}

/** A later `up` status refreshes the facts a provider may move (deadline, idle window, slots). */
export function refreshHostFacts(db: Db, id: number, f: HostFacts): void {
  db.prepare(
    "UPDATE hosts SET deadline_at = ?, idle_reclaim_ms = ?, max_jobs = ?, updated_at = ? WHERE id = ? AND handle = ?",
  ).run(f.deadlineAt ?? null, f.idleReclaimMs ?? null, f.maxJobs ?? null, now(), id, f.handle);
}

export function deleteHostRecord(db: Db, id: number): boolean {
  return db.prepare("DELETE FROM hosts WHERE id = ?").run(id).changes === 1;
}

/** Compare-and-set the state from one of `from`. */
export function setHostState(
  db: Db,
  id: number,
  from: readonly HostState[],
  to: HostState,
  reason: string | null = null,
): boolean {
  const marks = from.map(() => "?").join(", ");
  return (
    db
      .prepare(
        `UPDATE hosts SET state = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ? AND state IN (${marks})`,
      )
      .run(to, reason, now(), id, ...from).changes === 1
  );
}

/** Every agent row, job record and recovery record naming the host. */
export function hostReferences(db: Db, rec: HostRecord): HostReferences {
  const agents = (
    db
      .prepare(
        "SELECT ws.name || '/' || a.name AS n FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.host = ? ORDER BY n",
      )
      .all(rec.name) as { n: string }[]
  ).map((r) => r.n);
  const jobs = (
    db
      .prepare("SELECT token FROM carrier_jobs WHERE host_id = ? OR host = ? ORDER BY id")
      .all(rec.id, rec.name) as { token: string }[]
  )
    .map((r) => getCarrierJob(db, r.token))
    .filter((j): j is CarrierJob => j !== undefined);
  const recoveries = (
    db
      .prepare("SELECT agent_id FROM remote_recovery WHERE host = ? ORDER BY agent_id")
      .all(rec.name) as { agent_id: number }[]
  ).map((r) => r.agent_id);
  return { agents, jobs, recoveries };
}

/**
 * The release proof (D1), inside the caller's immediate transaction: nothing names the host,
 * then `releasing`. Refuses `HostReferencedError`, or `HostStateError` outside draining, lost
 * or releasing.
 */
export function beginHostRelease(db: Db, id: number): void {
  const rec = hostRecordById(db, id);
  if (rec === undefined) throw new Error(`host record ${id} is gone`);
  if (!["draining", "lost", "releasing"].includes(rec.state)) {
    throw new HostStateError(rec.name, rec.state, "drain it first (mu host drain)");
  }
  const refs = hostReferences(db, rec);
  if (refs.agents.length + refs.jobs.length + refs.recoveries.length > 0) {
    throw new HostReferencedError(rec.name, refs);
  }
  setHostState(db, id, ["draining", "lost", "releasing"], "releasing");
}

/** Where the deadline stands (D10): inside the margin, spawns refuse and the host drains. */
export function inDeadlineMargin(rec: HostRecord, at = Date.now()): boolean {
  return rec.deadline_at !== null && at >= rec.deadline_at - hostDeadlineMarginMs();
}

/**
 * Atomic admission (D6): in ONE immediate transaction, re-read the record, refuse unless
 * `ready` (`HostStateError`), inside the deadline margin (`HostDeadlineError`, the host moved
 * to `draining`), or at `max_jobs` (`HostJobsFullError`); then the job record, naming the host
 * by id, owing its final collect when it is a `--worktree` job (D10). Undefined when the name
 * is reserved already.
 */
export function reserveProviderJob(
  db: Db,
  host: string,
  a: { workstream: string; name: string; kind: string; plugin: string; worktree: boolean },
): CarrierJob | undefined {
  const out = db
    .transaction((): CarrierJob | number | undefined => {
      const rec = getHostRecord(db, host);
      if (rec === undefined) throw new HostStateError(host, "releasing", "it has no record");
      if (rec.state !== "ready") throw new HostStateError(host, rec.state, "it takes no new jobs");
      if (inDeadlineMargin(rec)) {
        setHostState(db, rec.id, ["ready"], "draining");
        return rec.deadline_at ?? 0;
      }
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM carrier_jobs WHERE host_id = ?").get(rec.id) as {
          n: number;
        }
      ).n;
      if (rec.max_jobs !== null && n >= rec.max_jobs) {
        throw new HostJobsFullError(host, rec.max_jobs);
      }
      const job = reserveCarrierJob(db, {
        workstream: a.workstream,
        name: a.name,
        host,
        hostStop: null,
        plugin: { kind: a.kind, name: a.plugin },
        creatorPid: process.pid,
        creatorStart: pidStart(process.pid),
      });
      if (job === undefined) return undefined;
      db.prepare("UPDATE carrier_jobs SET host_id = ?, final_owed = ? WHERE token = ?").run(
        rec.id,
        a.worktree ? 1 : 0,
        job.token,
      );
      return getCarrierJob(db, job.token);
    })
    .immediate();
  // The draining move committed; the refusal follows it.
  if (typeof out === "number") throw new HostDeadlineError(host, out);
  return out;
}
