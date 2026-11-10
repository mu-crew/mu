// mu — the provider host verbs (plugins spec D1, D6): acquire (a re-run resolves
// the same effect), drain, release (a crashed release reissued), --abandon (one
// transaction with its loss record), and `observeHost`, the status read that
// moves a `gone` host to `lost`.

import { abandonCarrierJob } from "./carrier-jobs.js";
import type { Db } from "./db.js";
import { deleteEffect, effectsOf, refuseLiveOwner } from "./effects.js";
import { type Call, type HostRecord, type HostStatus, recordView } from "./host-provider.js";
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
import { HostExistsError, HostNotFoundError } from "./hosts.js";
import { emitEvent } from "./logs.js";
import { EffectOutcomeUnknownError } from "./plugins/errors.js";
import {
  acquireKey,
  type PluginHostProvider,
  pluginProvider,
  releaseKey,
} from "./plugins/provider.js";
import { effectTimeoutMs } from "./plugins/reconcile.js";
import { deleteRecoveryById } from "./remote-recovery.js";

/** A verb's `Call` for `method`: the method's own bound (D13), cancelled by mu's process latch. */
const callFor = (method: string): Call => ({
  deadline: Date.now() + effectTimeoutMs(method),
  signal: new AbortController().signal,
});

const providerOf = (db: Db, rec: HostRecord): PluginHostProvider =>
  recordView(db, rec).provider as PluginHostProvider;

function requireRecord(db: Db, name: string): HostRecord {
  const rec = getHostRecord(db, name);
  if (rec === undefined) throw new HostNotFoundError(name);
  return rec;
}

/** Acquire host `name` (D1); a record still `acquiring` has its effect resolved instead. */
export async function acquireHost(
  db: Db,
  a: { name: string; provider: string; params: Record<string, string>; repo: string | null },
): Promise<HostRecord | undefined> {
  const seen = getHostRecord(db, a.name);
  if (seen !== undefined) {
    if (seen.state !== "acquiring" || seen.provider !== a.provider) {
      throw new HostExistsError(a.name);
    }
    for (const r of await providerOf(db, seen).resolve(callFor("host.acquire"))) {
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
    } else if (now.state !== "acquiring") {
      // The lookup found the host: the acquire happened, so it is logged as one.
      logAcquired(db, a.name, a.provider, now.handle);
    }
    return now;
  }
  const provider = pluginProvider(db, a.provider, a.name, { repo: a.repo });
  await provider.acquire(a.params, acquireKey(), callFor("host.acquire"));
  const rec = getHostRecord(db, a.name);
  logAcquired(db, a.name, a.provider, rec?.handle ?? null);
  return rec;
}

const logAcquired = (db: Db, name: string, provider: string, handle: string | null): void =>
  emitEvent(
    db,
    null,
    "host.acquire",
    `host acquire ${name} (provider ${provider}, handle ${handle ?? "?"})`,
  );

/** Ask host `name`'s status once (D1): `gone` makes it `lost`; `up` refreshes its facts. */
export async function observeHost(db: Db, name: string): Promise<HostStatus | undefined> {
  const rec = getHostRecord(db, name);
  if (rec === undefined || rec.handle === null) return undefined;
  if (rec.state !== "ready" && rec.state !== "draining") return undefined;
  const st = await providerOf(db, rec).status(rec.handle, callFor("host.status"));
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

/** `mu host release` (D1): the proof and the `host.release` effect, reissued after a crash. */
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
  await providerOf(db, requireRecord(db, name)).release(
    rec.handle ?? "",
    releaseKey(rec.id),
    callFor("host.release"),
  );
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

/** `--abandon` (D1): drops the host and its records with the loss event in one transaction. */
export function abandonHost(db: Db, name: string): Abandoned {
  return db
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
      for (const e of effects) refuseLiveOwner(e);
      const outlives = recordView(db, rec).jobKind?.caps.outlivesHost === true;
      for (const e of effects) deleteEffect(db, e.key);
      for (const j of refs.jobs) abandonCarrierJob(db, j);
      for (const id of refs.recoveries) deleteRecoveryById(db, id);
      deleteHostRecord(db, rec.id);
      const out: Abandoned = {
        host: name,
        jobs: refs.jobs.map(
          (j) =>
            `${j.workstream}/${j.name}${j.job === null ? "" : ` (job ${j.job})`}${j.finalOwed ? " uncollected work lost" : ""}`,
        ),
        recoveries: refs.recoveries,
        effects: effects.map((e) => `${e.method} ${e.key}`),
        running: outlives
          ? refs.jobs.filter((j) => j.job !== null).map((j) => `${j.workstream}/${j.name}`)
          : [],
      };
      const bits = [
        out.jobs.length > 0 ? `job records ${out.jobs.join(", ")}` : "",
        out.recoveries.length > 0 ? `recovery records ${out.recoveries.join(", ")}` : "",
        out.effects.length > 0 ? `unresolved effects ${out.effects.join(", ")}` : "",
        out.running.length > 0 ? `possibly still running: ${out.running.join(", ")}` : "",
      ].filter((b) => b !== "");
      // The loss record commits with the loss: a crash after the deletions cannot drop it.
      emitEvent(
        db,
        null,
        "host.release",
        `host release ${name} abandoned${bits.length > 0 ? `: dropped ${bits.join("; ")}` : ""}`,
      );
      return out;
    })
    .immediate();
}
