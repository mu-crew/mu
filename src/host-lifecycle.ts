// mu — the provider host verbs (plugins spec D1, D6): `mu host acquire`,
// `drain`, `release` and `release --abandon`, and the one status read that
// moves a host to `lost`.
//
// The record moves only with its effects (src/plugins/provider.ts); this file
// sequences them. `acquire` on a name still `acquiring` reconciles the same
// effect, never acquiring a second host. `release` asks the host's status
// first (a `gone` host is `lost`, and a lost host's release is the same
// effect), proves nothing names it and reissues a crashed release. `--abandon`
// is a human decision: it calls nothing and drops the host with its job
// records, recovery records and effects in one transaction, logging each.
//
// `observeHost` is the status read (D1): asked by the host verbs, and once by a
// close or collect on a provider host before it reports. `gone` is the
// provider's proof that the machine and its worktrees no longer exist.

import type { Db } from "./db.js";
import { creatorGone, EffectHeldError, type EffectRow, effectsOf } from "./effects.js";
import { type HostRecord, type HostStatus, recordView } from "./host-provider.js";
import {
  deleteHostRecord,
  getHostRecord,
  HostReferencedError,
  HostStateError,
  hostReferences,
  inDeadlineMargin,
  refreshHostFacts,
  setHostState,
} from "./host-records.js";
import { HostExistsError, HostNotFoundError, pidProvenGone } from "./hosts.js";
import { emitEvent } from "./logs.js";
import { EffectOutcomeUnknownError } from "./plugins/errors.js";
import { acquireKey, type PluginHostProvider, pluginProvider } from "./plugins/provider.js";
import { pluginSession } from "./plugins/registry.js";

/** A `host.*` call's `Call`: the adapter's own deadlines apply (D13); this one only cancels. */
const CALL = { deadline: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal };

const providerOf = (db: Db, rec: HostRecord): PluginHostProvider =>
  recordView(db, rec).provider as PluginHostProvider;

function requireRecord(db: Db, name: string): HostRecord {
  const rec = getHostRecord(db, name);
  if (rec === undefined) throw new HostNotFoundError(name);
  return rec;
}

/**
 * Acquire host `name` from provider `provider` (D1). A record still `acquiring` (an earlier
 * acquire crashed or got no answer) is reconciled, its effect resolved by the rule table; an
 * unresolved one throws `EffectOutcomeUnknownError` with the record kept.
 */
export async function acquireHost(
  db: Db,
  a: { name: string; provider: string; params: Record<string, string>; repo: string | null },
): Promise<HostRecord | undefined> {
  const seen = getHostRecord(db, a.name);
  if (seen !== undefined) {
    if (seen.state !== "acquiring" || seen.provider !== a.provider) {
      throw new HostExistsError(a.name);
    }
    for (const r of await providerOf(db, seen).resolve()) {
      if (r.state === "unknown")
        throw new EffectOutcomeUnknownError(a.provider, "host.acquire", r.reason);
    }
    const now = getHostRecord(db, a.name);
    if (now === undefined) {
      emitEvent(
        db,
        null,
        "host.acquire",
        `host acquire ${a.name}: the provider never acquired it; nothing is held`,
      );
    }
    return now;
  }
  // A plugin without the host seam (and its link and job, D6) is refused before any intent.
  await pluginSession(db, a.provider, ["host", "link", "job"]);
  const provider = pluginProvider(db, a.provider, a.name, { repo: a.repo });
  await provider.acquire(a.params, acquireKey(), CALL);
  const rec = getHostRecord(db, a.name);
  emitEvent(
    db,
    null,
    "host.acquire",
    `host acquire ${a.name} (provider ${a.provider}, handle ${rec?.handle ?? "?"})`,
  );
  return rec;
}

/**
 * Ask the provider once what host `name` is now (D1). `gone` moves a ready or draining host to
 * `lost`; `up` refreshes its facts, and inside the deadline margin a ready host drains (D10).
 * Undefined for a host with nothing to ask (no record, no handle, or released).
 */
export async function observeHost(db: Db, name: string): Promise<HostStatus | undefined> {
  const rec = getHostRecord(db, name);
  if (rec === undefined || rec.handle === null) return undefined;
  if (rec.state !== "ready" && rec.state !== "draining") return undefined;
  const st = await providerOf(db, rec).status(rec.handle, CALL);
  if (st.state === "gone") {
    setHostState(db, rec.id, ["ready", "draining"], "lost", st.reason);
  } else if (st.state === "up") {
    refreshHostFacts(db, rec.id, st);
    const now = getHostRecord(db, name);
    if (now !== undefined && inDeadlineMargin(now)) setHostState(db, rec.id, ["ready"], "draining");
  }
  return st;
}

/** `mu host drain`: no new jobs (D1). A lost host stays lost. */
export async function drainHost(db: Db, name: string): Promise<HostRecord> {
  requireRecord(db, name);
  await observeHost(db, name);
  const rec = requireRecord(db, name);
  if (rec.state === "acquiring" || rec.state === "releasing") {
    throw new HostStateError(name, rec.state, "only a ready host drains");
  }
  setHostState(db, rec.id, ["ready"], "draining");
  return requireRecord(db, name);
}

/**
 * `mu host release` (D1): the release proof and the `host.release` effect, reissued after a
 * crash. A ready host must be drained first; a lost one releases as it is.
 */
export async function releaseHost(db: Db, name: string): Promise<void> {
  const rec = requireRecord(db, name);
  await observeHost(db, name);
  if (rec.state === "acquiring") {
    throw new HostStateError(
      name,
      rec.state,
      "its acquire is unresolved (mu host acquire again, or --abandon)",
    );
  }
  await providerOf(db, requireRecord(db, name)).release(rec.handle ?? "", "", CALL);
  if (getHostRecord(db, name) === undefined) {
    emitEvent(
      db,
      null,
      "host.release",
      `host release ${name} (provider ${rec.provider}, handle ${rec.handle ?? "-"})`,
    );
  }
}

/** What `--abandon` dropped (D1): the event names every one. */
export interface Abandoned {
  host: string;
  jobs: string[];
  recoveries: number[];
  effects: string[];
  /** `outlivesHost` jobs: possibly still running. */
  running: string[];
}

/** An effect whose creator or resolver still lives. */
function liveOwner(e: EffectRow): { by: "creator" | "resolver"; pid: number } | undefined {
  if (e.state === "pending" && !creatorGone(e)) return { by: "creator", pid: e.creator_pid };
  if (
    e.state === "resolving" &&
    e.resolver_pid !== null &&
    !pidProvenGone(e.resolver_pid, e.resolver_start)
  ) {
    return { by: "resolver", pid: e.resolver_pid };
  }
  return undefined;
}

/**
 * `mu host release <name> --abandon` (D1): a human decision. Refuses while an agent row names
 * the host, or an effect on it or its jobs has a live owner; otherwise drops the host, its job
 * records, recovery records and effect rows in one transaction, and logs them all.
 */
export function abandonHost(db: Db, name: string): Abandoned {
  const out = db
    .transaction((): Abandoned => {
      const rec = requireRecord(db, name);
      const refs = hostReferences(db, rec);
      if (refs.agents.length > 0) {
        throw new HostReferencedError(name, { agents: refs.agents, jobs: [], recoveries: [] });
      }
      const effects = [
        ...effectsOf(db, "host", String(rec.id)),
        ...refs.jobs.flatMap((j) => effectsOf(db, "job", j.token)),
      ];
      for (const e of effects) {
        const owner = liveOwner(e);
        if (owner !== undefined) throw new EffectHeldError(e.key, owner.by, owner.pid);
      }
      const outlives = recordView(db, rec).jobKind.caps.outlivesHost === true;
      const del = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
      for (const e of effects) del("DELETE FROM effects WHERE key = ?", e.key);
      for (const j of refs.jobs) del("DELETE FROM carrier_jobs WHERE token = ?", j.token);
      del("DELETE FROM remote_recovery WHERE host = ?", name);
      deleteHostRecord(db, rec.id);
      const jobs = refs.jobs.map(
        (j) =>
          `${j.workstream}/${j.name}${j.job === null ? "" : ` (job ${j.job})`}${j.finalOwed ? " uncollected work lost" : ""}`,
      );
      return {
        host: name,
        jobs,
        recoveries: refs.recoveries,
        effects: effects.map((e) => `${e.method} ${e.key}`),
        running: outlives
          ? refs.jobs.filter((j) => j.job !== null).map((j) => `${j.workstream}/${j.name}`)
          : [],
      };
    })
    .immediate();
  const bits = [
    out.jobs.length > 0 ? `job records ${out.jobs.join(", ")}` : "",
    out.recoveries.length > 0 ? `recovery records ${out.recoveries.join(", ")}` : "",
    out.effects.length > 0 ? `unresolved effects ${out.effects.join(", ")}` : "",
    out.running.length > 0 ? `possibly still running: ${out.running.join(", ")}` : "",
  ].filter((b) => b !== "");
  emitEvent(
    db,
    null,
    "host.release",
    `host release ${name} abandoned${bits.length > 0 ? `: dropped ${bits.join("; ")}` : ""}`,
  );
  return out;
}
