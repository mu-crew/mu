// mu — the provider adapter (plugins spec D6, D13): a plugin's host seam as a
// `HostProvider` bound to one host name. Acquire and release are journaled
// effects that move the record; lookup and status are reads that answer
// `unknown` for cannot-tell. Every call is fenced on the record's instance.

import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { effectsOf, getEffect } from "../effects.js";
import type { Call, HostFacts, HostProvider, HostStatus, KeyLookup } from "../host-provider.js";
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
  resolve(call?: Call): Promise<Resolution[]>;
}

/** The key of a record's release: one per record, so a re-run reissues the same request. */
export const releaseKey = (id: number): string => `host:${id}:release`;

/** A fresh acquire key. */
export const acquireKey = (): string => `host:${randomUUID()}`;

/** Plugin `plugin`'s provider for host `host`; `repo` is what a new record stores. */
export function pluginProvider(
  db: Db,
  plugin: string,
  host: string,
  opts: { repo?: string | null } = {},
): PluginHostProvider {
  const record = () => getHostRecord(db, host);
  /** The record's target, with the handle the caller names (D6: the call is about that handle). */
  const target = (handle?: string) => {
    const t = hostTarget(db, host);
    return handle === undefined ? t : { host: { ...t.host, handle } };
  };
  const read = async <M extends PluginMethod>(m: M, p: Record<string, unknown>, call: Call) =>
    pluginCall(db, plugin, m, p, {
      kind: "read",
      needs: ["host"],
      call,
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

    async acquire(params, key, call) {
      return runEffect(db, {
        key,
        call,
        needs: ["host", "link", "job"],
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

    async lookup(key, o, call): Promise<KeyLookup<HostFacts>> {
      try {
        return await read("host.lookup", { target: target(), key, fence: o.fence }, call);
      } catch (e) {
        if (e instanceof PluginAnswerUnknownError) return { unknown: e.reason };
        throw e;
      }
    },

    async status(handle, call): Promise<HostStatus> {
      try {
        return await read("host.status", { target: target(handle) }, call);
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

    async release(handle, key, call) {
      const rec = record();
      if (rec === undefined) return;
      if (getEffect(db, key) !== undefined) {
        // A crashed or unanswered release: reissued (idempotent by contract, D4).
        const r = await resolveEffect(db, key, settleHooks, call);
        if (r?.state === "unknown")
          throw new EffectOutcomeUnknownError(plugin, "host.release", r.reason);
        return;
      }
      await runEffect(db, {
        key,
        call,
        subject: { kind: "host", id: String(rec.id) },
        plugin,
        method: "host.release",
        params: { target: target(handle), key },
        fence: rec.instance ?? "",
        alongside: () => beginHostRelease(db, rec.id),
        record: () => deleteHostRecord(db, rec.id),
      });
    },

    async resolve(call) {
      const rec = record();
      if (rec === undefined) return [];
      const out: Resolution[] = [];
      for (const row of effectsOf(db, "host", String(rec.id))) {
        const r = await resolveEffect(db, row.key, settleHooks, call);
        if (r !== undefined) out.push(r);
      }
      return out;
    },
  };
}
