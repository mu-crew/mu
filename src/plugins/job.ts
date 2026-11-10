// mu — the job adapter (plugins spec D8, D13): a plugin's job seam as a
// `JobKind`, bound views only until P6e drives the spawn path.
//
// What mu computes stays mu's: the kind's identity (the stop fence: the
// registration's handshake instance), every key (a job's start key is its job
// record's token, its stop key `<token>:stop`) and every record. The plugin's
// `job.start` and `job.stop` are effects, written ahead (src/effects.ts) and
// resolved by the rule table (./reconcile.ts); `job.lookup`, `job.status`,
// `job.attach` and `job.checkSteps` are reads. A read with no answer is the
// seam's `unknown`, never a throw for "cannot tell"; `human` is the host's
// hand-back. Every stop and resend is fenced on the instance.

import {
  fillCarrierJob,
  getCarrierJob,
  markPluginJobLaunch,
  unlaunchPluginJob,
} from "../carrier-jobs.js";
import type { Db } from "../db.js";
import { effectsOf, getEffect } from "../effects.js";
import type { CheckContext } from "../host-link.js";
import type { Call, HostView, KeyLookup } from "../host-provider.js";
import { type HostCheckStep, HostHandbackError } from "../hosts.js";
import {
  HONOURS_DEFAULT,
  type JobKind,
  type JobLiveness,
  type JobRef,
  type JobSpec,
  type JobStart,
  type PaneCommand,
} from "../jobs/types.js";
import {
  EffectFencedError,
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
} from "./errors.js";
import { checkReport, hostTarget } from "./link.js";
import type { JobFound, Obj, PluginJobCaps, PluginMethod } from "./protocol.js";
import { pluginCall, type Resolution, resolveEffect, runEffect } from "./reconcile.js";
import { getPlugin, pluginSeams } from "./registry.js";

export interface PluginJobKind extends JobKind {
  readonly plugin: string;
  readonly caps: PluginJobCaps;
  /** The stop fence: the registration's instance. Computed, never a wire call. */
  identity(): string;
  /**
   * The `job.start` effect for job record `key` (its token), written ahead with the record's
   * launch (`launching`, the instance recorded). A reply's handle fills the record; an error
   * that says nothing happened puts it back to unlaunched; no answer leaves it to `resolve`.
   */
  start(host: HostView, spec: JobSpec, key: string): Promise<JobStart>;
  lookup(host: HostView, key: string, opts: { fence: boolean }): Promise<KeyLookup<JobFound>>;
  /** Idempotent; resolves only on proof the job is gone. Refuses a changed instance. */
  stop(db: Db, job: JobRef, call?: Call): Promise<void>;
  attach(db: Db, job: JobRef): Promise<PaneCommand>;
  /** Every unresolved effect of job record `token`, by the rule table (D4). */
  resolve(token: string, call?: Call): Promise<Resolution[]>;
}

/** The key of a job's stop effect: one per job, so a re-run reissues the same request. */
export const stopKey = (token: string): string => `${token}:stop`;

/** Plugin `name`'s job kind, from its registration; undefined when it has no job seam. */
export function pluginJobKind(db: Db, name: string): PluginJobKind | undefined {
  const declared = pluginSeams(getPlugin(db, name)).job;
  if (declared === undefined) return undefined;
  const caps: PluginJobCaps = { ...declared, honours: declared.honours ?? HONOURS_DEFAULT };
  const instance = () => getPlugin(db, name).instance;

  /**
   * A read through the one call path. `recorded`: the instance the job was started under, for
   * a call naming a recorded job; another one refuses before sending (`instance-changed`).
   */
  const ask = <M extends PluginMethod>(m: M, p: Obj, key: string, recorded?: string | null) => {
    const fence = {
      instance: recorded ?? "",
      subject: `${m} of job ${key}`,
      why: "instance-changed" as const,
    };
    return pluginCall(db, name, m, p, {
      kind: "read",
      needs: ["job"],
      ...(recorded === undefined ? {} : { fence }),
    });
  };

  /** The wire `target` of a job call (D13). */
  const target = (key: string, host: string, handle?: string | null) => ({
    job: { kind: declared.kind, key, ...(handle != null ? { handle } : {}) },
    ...hostTarget(db, host),
  });
  const jobTarget = (job: JobRef) => target(job.key ?? "", job.host?.name ?? "", job.handle);

  /** A plugin's `human` answer is the host's hand-back. */
  const handBack = (host: string, field: "exec" | "stop", e: unknown): never => {
    if (e instanceof PluginCallError && e.kind === "human") {
      throw new HostHandbackError(host, field, e.remedy ?? e.detail);
    }
    throw e;
  };

  const kind: PluginJobKind = {
    name: declared.kind,
    plugin: name,
    caps,
    identity: instance,

    async start(host, spec, key) {
      const params = { target: target(key, host.name), key, spec };
      try {
        return await runEffect(db, {
          key,
          subject: {
            kind: "job",
            id: key,
            ...(spec.firstPrompt ? { msgId: spec.firstPrompt.msgId } : {}),
          },
          plugin: name,
          method: "job.start",
          params,
          alongside: (inst) => {
            if (!markPluginJobLaunch(db, key, inst)) {
              throw new Error(`job record ${key} is not an unlaunched ${name} job`);
            }
          },
          record: (r) => {
            if (r.handle !== undefined) fillCarrierJob(db, key, r.handle);
          },
          refused: () => unlaunchPluginJob(db, key, "the plugin refused the start"),
        });
      } catch (e) {
        return handBack(host.name, "exec", e);
      }
    },

    async lookup(host, key, opts) {
      // A recorded job's (or effect's) key is asked only of the instance it went to.
      const recorded =
        getEffect(db, key)?.instance ?? getCarrierJob(db, key)?.instance ?? undefined;
      try {
        return await ask(
          "job.lookup",
          { target: target(key, host.name), key, fence: opts.fence },
          key,
          recorded,
        );
      } catch (e) {
        if (e instanceof PluginAnswerUnknownError) return { unknown: e.reason };
        throw e;
      }
    },

    async status(_db, job): Promise<JobLiveness> {
      try {
        return await ask(
          "job.status",
          { target: jobTarget(job) },
          job.key ?? "",
          job.identity ?? null,
        );
      } catch (e) {
        // Cannot tell, or not asked (another instance): unknown, never a throw.
        if (e instanceof PluginAnswerUnknownError) return { state: "unknown", reason: e.reason };
        if (e instanceof EffectFencedError) return { state: "unknown", reason: e.message };
        if (e instanceof PluginCallError && e.kind !== "human") {
          return { state: "unknown", reason: e.message };
        }
        throw e;
      }
    },

    async stop(_db, job, call) {
      const token = job.key ?? "";
      const host = job.host?.name ?? "";
      const key = stopKey(token);
      try {
        if (getEffect(db, key) !== undefined) {
          const r = await resolveEffect(db, key, {}, call);
          if (r?.state === "unknown")
            throw new EffectOutcomeUnknownError(name, "job.stop", r.reason);
          return;
        }
        await runEffect(db, {
          key,
          subject: { kind: "job", id: token },
          plugin: name,
          method: "job.stop",
          params: { target: jobTarget(job), key },
          fence: job.identity ?? "",
          ...(call !== undefined ? { call } : {}),
        });
      } catch (e) {
        handBack(host, "stop", e);
      }
    },

    async attach(_db, job) {
      return ask("job.attach", { target: jobTarget(job) }, job.key ?? "", job.identity ?? null);
    },

    async resolve(token, call) {
      const out: Resolution[] = [];
      for (const row of effectsOf(db, "job", token)) {
        const r = await resolveEffect(
          db,
          row.key,
          {
            record: ({ result }) => {
              const handle = (result as JobStart | null)?.handle;
              if (row.method === "job.start" && handle !== undefined)
                fillCarrierJob(db, token, handle);
            },
            none: () => {
              if (row.method === "job.start")
                unlaunchPluginJob(db, token, "lookup proved the start never happened");
            },
          },
          call,
        );
        if (r !== undefined) out.push(r);
      }
      return out;
    },

    async checkSteps(ctx: CheckContext): Promise<HostCheckStep[]> {
      if (!declared.checks?.includes(ctx.phase)) return [];
      const params = {
        target: hostTarget(db, ctx.host.name),
        phase: ctx.phase,
        ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
      };
      return checkReport(name, ctx.host.name, "job", () => ask("job.checkSteps", params, ""));
    },
  };
  return kind;
}

/** The `JobRef` of a plugin job record. */
export function pluginJobRef(db: Db, token: string): JobRef | undefined {
  const r = getCarrierJob(db, token);
  if (r === undefined || r.plugin === null) return undefined;
  return {
    kind: r.kind ?? "",
    plugin: r.plugin,
    viewPaneId: r.paneId ?? "",
    key: r.token,
    host: { name: r.host },
    ...(r.job !== null ? { handle: r.job } : {}),
    ...(r.instance !== null ? { identity: r.instance } : {}),
    ...(r.agentId !== null ? { agentId: r.agentId } : {}),
  };
}
