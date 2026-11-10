// mu — the provider adapter (plugins spec D6, D13): a plugin's host seam as a
// `HostProvider`, bound to one host name.
//
// `host.acquire` and `host.release` are effects, written ahead (src/effects.ts)
// and resolved by the rule table (./reconcile.ts) through the one call path;
// `host.lookup` and `host.status` are reads. The record moves with the
// effect: the acquire's intent inserts it (`acquiring`, in the intent's
// transaction), its reply fills it (`ready`), a refusal deletes it; the
// release's intent is the release proof (`releasing`), its reply deletes it.
// A read with no answer is the seam's `unknown`, never a throw for "cannot
// tell"; `human` is `needs-human`. Every call naming the record is fenced on
// the instance it was acquired from.

import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { effectsOf, getEffect } from "../effects.js";
import type { HostFacts, HostProvider, HostStatus, KeyLookup } from "../host-provider.js";
import {
  beginHostRelease,
  deleteHostRecord,
  fillHostRecord,
  getHostRecord,
  insertHostRecord,
} from "../host-records.js";
import {
  EffectFencedError,
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
} from "./errors.js";
import { hostTarget } from "./link.js";
import type { PluginMethod } from "./protocol.js";
import { pluginCall, type Resolution, resolveEffect, runEffect } from "./reconcile.js";
import { getPlugin, pluginSeams } from "./registry.js";

export interface PluginHostProvider extends HostProvider {
  readonly plugin: string;
  /** Every unresolved effect of the host's record, by the rule table (D4). */
  resolve(): Promise<Resolution[]>;
}

/** The key of a record's release: one per record, so a re-run reissues the same request. */
export const releaseKey = (id: number): string => `host:${id}:release`;

/** A fresh acquire key. */
export const acquireKey = (): string => `host:${randomUUID()}`;

/**
 * Plugin `plugin`'s provider for host `host`. `repo` is what a new record stores (acquire).
 * Refuses (at the first call) a plugin with no host seam.
 */
export function pluginProvider(
  db: Db,
  plugin: string,
  host: string,
  opts: { repo?: string | null } = {},
): PluginHostProvider {
  const record = () => getHostRecord(db, host);
  const target = () => {
    const r = record();
    return r === undefined
      ? { host: { name: host } }
      : hostTarget({ name: host, record: r } as Parameters<typeof hostTarget>[0]);
  };
  const read = async <M extends PluginMethod>(m: M, p: Record<string, unknown>) =>
    pluginCall(db, plugin, m, p, {
      kind: "read",
      needs: ["host"],
      fence: {
        instance: record()?.instance ?? "",
        subject: `${m} of host ${host}`,
        why: "instance-changed",
      },
    });
  const settleHooks = {
    record: (r: { result: unknown }) => {
      const rec = record();
      if (rec === undefined) return;
      if (rec.state === "acquiring") fillHostRecord(db, rec.id, r.result as HostFacts);
      else if (rec.state === "releasing") deleteHostRecord(db, rec.id);
    },
    none: () => {
      const rec = record();
      if (rec?.state === "acquiring") deleteHostRecord(db, rec.id);
    },
  };

  return {
    name: plugin,
    plugin,
    get caps() {
      const acquire = pluginSeams(getPlugin(db, plugin)).host?.acquire;
      return { acquire: acquire ?? { lookup: false, fenceKey: false } };
    },

    async acquire(params, key) {
      return runEffect(db, {
        key,
        subject: { kind: "host", id: "" },
        plugin,
        method: "host.acquire",
        params: { target: { host: { name: host } }, key, params },
        alongside: (instance) =>
          String(
            insertHostRecord(
              db,
              { name: host, provider: plugin, params: { ...params }, repo: opts.repo ?? null },
              instance,
            ),
          ),
        record: (f) => {
          const rec = record();
          if (rec !== undefined) fillHostRecord(db, rec.id, f);
        },
        refused: () => {
          const rec = record();
          if (rec !== undefined) deleteHostRecord(db, rec.id);
        },
      });
    },

    async lookup(key, o): Promise<KeyLookup<HostFacts>> {
      try {
        return await read("host.lookup", { target: target(), key, fence: o.fence });
      } catch (e) {
        if (e instanceof PluginAnswerUnknownError) return { unknown: e.reason };
        throw e;
      }
    },

    async status(): Promise<HostStatus> {
      try {
        return await read("host.status", { target: target() });
      } catch (e) {
        // Cannot tell, or not asked (another instance): unknown, never a throw.
        if (e instanceof PluginCallError && e.kind === "human") {
          return { state: "needs-human", remedy: e.remedy ?? e.detail };
        }
        if (
          e instanceof PluginAnswerUnknownError ||
          e instanceof EffectFencedError ||
          e instanceof PluginCallError
        ) {
          return { state: "unknown", reason: e.message };
        }
        throw e;
      }
    },

    async release() {
      const rec = record();
      if (rec === undefined) return;
      const key = releaseKey(rec.id);
      if (getEffect(db, key) !== undefined) {
        // A crashed or unanswered release: reissued (idempotent by contract, D4).
        const r = await resolveEffect(db, key, settleHooks);
        if (r?.state === "unknown")
          throw new EffectOutcomeUnknownError(plugin, "host.release", r.reason);
        return;
      }
      await runEffect(db, {
        key,
        subject: { kind: "host", id: String(rec.id) },
        plugin,
        method: "host.release",
        params: { target: target(), key },
        fence: rec.instance ?? "",
        alongside: () => beginHostRelease(db, rec.id),
        record: () => deleteHostRecord(db, rec.id),
      });
    },

    async resolve() {
      const rec = record();
      if (rec === undefined) return [];
      const out: Resolution[] = [];
      for (const row of effectsOf(db, "host", String(rec.id))) {
        const r = await resolveEffect(db, row.key, settleHooks);
        if (r !== undefined) out.push(r);
      }
      return out;
    },
  };
}
