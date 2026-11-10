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
import type { HostView, KeyLookup } from "../host-provider.js";
import { HANDED_BACK, type HostCheckStep, HostHandbackError } from "../hosts.js";
import {
  HONOURS_DEFAULT,
  type JobKind,
  type JobLiveness,
  type JobRef,
  type JobSpec,
  type JobStart,
  type PaneCommand,
} from "../jobs/types.js";
import { PLUGIN_READ_TIMEOUT_MS } from "./client.js";
import {
  EffectFencedError,
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
} from "./errors.js";
import {
  type Narrowed,
  narrowCheckSteps,
  narrowJobLiveness,
  narrowJobLookup,
  narrowJobStart,
  narrowNull,
  narrowPaneCommand,
  type PluginJobCaps,
} from "./protocol.js";
import { type Resolution, resolveEffect, runEffect } from "./reconcile.js";
import { getPlugin, pluginSeams, pluginSession } from "./registry.js";

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
  lookup(
    host: HostView,
    key: string,
    opts: { fence: boolean },
  ): Promise<KeyLookup<Partial<JobStart> & { handle: string }>>;
  /** Idempotent; resolves only on proof the job is gone. Refuses a changed instance. */
  stop(db: Db, job: JobRef): Promise<void>;
  attach(db: Db, job: JobRef): Promise<PaneCommand>;
  /** Every unresolved effect of job record `token`, by the rule table (D4). */
  resolve(token: string): Promise<Resolution[]>;
}

/** The wire `target` of a job call (D13). */
function target(job: { kind: string; key: string; handle?: string | null; host: string }) {
  return {
    job: { kind: job.kind, key: job.key, ...(job.handle != null ? { handle: job.handle } : {}) },
    host: { name: job.host },
  };
}

/** The key of a job's stop effect: one per job, so a re-run reissues the same request. */
export const stopKey = (token: string): string => `${token}:stop`;

/** Plugin `name`'s job kind, from its registration; undefined when it has no job seam. */
export function pluginJobKind(db: Db, name: string): PluginJobKind | undefined {
  const declared = pluginSeams(getPlugin(db, name)).job;
  if (declared === undefined) return undefined;
  const caps: PluginJobCaps = { ...declared, honours: declared.honours ?? HONOURS_DEFAULT };
  const session = () => pluginSession(db, name, ["job"]);
  const instance = () => getPlugin(db, name).instance;

  const readCall = async <T>(
    method: string,
    params: Record<string, unknown>,
    narrow: (x: unknown) => Narrowed<T>,
  ): Promise<T> =>
    (await session()).call(
      method,
      params,
      { kind: "read", timeoutMs: PLUGIN_READ_TIMEOUT_MS },
      narrow,
    );

  const jobTarget = (job: JobRef) =>
    target({
      kind: declared.kind,
      key: job.key ?? "",
      handle: job.handle ?? null,
      host: job.host?.name ?? "",
    });

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
      const params = { target: target({ kind: declared.kind, key, host: host.name }), key, spec };
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
          narrow: narrowJobStart,
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
      try {
        return await readCall(
          "job.lookup",
          { target: target({ kind: declared.kind, key, host: host.name }), key, fence: opts.fence },
          narrowJobLookup,
        );
      } catch (e) {
        if (e instanceof PluginAnswerUnknownError) return { unknown: e.reason };
        throw e;
      }
    },

    async status(_db, job): Promise<JobLiveness> {
      try {
        return await readCall("job.status", { target: jobTarget(job) }, narrowJobLiveness);
      } catch (e) {
        if (e instanceof PluginAnswerUnknownError) return { state: "unknown", reason: e.reason };
        if (e instanceof PluginCallError && e.kind !== "human") {
          return { state: "unknown", reason: e.message };
        }
        throw e;
      }
    },

    async stop(_db, job) {
      const token = job.key ?? "";
      const host = job.host?.name ?? "";
      const key = stopKey(token);
      const current = (await session()).init.instance;
      if (job.identity !== current) {
        throw new EffectFencedError(name, key, job.identity ?? "(none)", current);
      }
      try {
        if (getEffect(db, key) !== undefined) {
          const r = await resolveEffect(db, key);
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
          narrow: narrowNull,
        });
      } catch (e) {
        handBack(host, "stop", e);
      }
    },

    async attach(_db, job) {
      return readCall("job.attach", { target: jobTarget(job) }, narrowPaneCommand);
    },

    async resolve(token) {
      const out: Resolution[] = [];
      for (const row of effectsOf(db, "job", token)) {
        const r = await resolveEffect(db, row.key, {
          record: ({ result }) => {
            const handle = (result as JobStart | null)?.handle;
            if (row.method === "job.start" && handle !== undefined)
              fillCarrierJob(db, token, handle);
          },
          none: () => {
            if (row.method === "job.start")
              unlaunchPluginJob(db, token, "lookup proved the start never happened");
          },
        });
        if (r !== undefined) out.push(r);
      }
      return out;
    },

    async checkSteps(ctx: CheckContext): Promise<HostCheckStep[]> {
      if (!declared.checks?.includes(ctx.phase)) return [];
      const params = {
        target: { host: { name: ctx.host.name } },
        phase: ctx.phase,
        ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
      };
      try {
        const steps = await readCall("job.checkSteps", params, narrowCheckSteps);
        return steps.map((st) =>
          st.step === "handback" ? st : { ...st, step: `${name}:${st.step}` },
        );
      } catch (e) {
        if (e instanceof PluginAnswerUnknownError) {
          return [{ step: `${name}:job`, ok: false, detail: `no answer: ${e.reason}` }];
        }
        if (e instanceof PluginCallError && e.kind === "human") {
          const back = new HostHandbackError(ctx.host.name, "exec", e.remedy ?? e.detail);
          return [
            { step: `${name}:job`, ok: null, detail: HANDED_BACK },
            { step: "handback", ok: false, detail: `${name}:job: ${back.message}` },
          ];
        }
        throw e;
      }
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
