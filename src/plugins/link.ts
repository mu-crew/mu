// mu — the link adapter (spec 2026-11-09-mu-plugins.md, D7, D13): `HostLink`
// over a plugin's `link.exec`, `link.fetch`, `link.push` and `link.checkSteps`,
// for a `--plugin` profile and for a provider host (its provider's link).
//
// What mu computes stays mu's: the fingerprint (`plugin:<name>:<instance>`,
// the registration's instance), `fits` (the script's bytes against the
// declared `maxScriptBytes`), FETCH_HEAD's deletion before a fetch and every
// parse of a script's output. The plugin only runs and reports.
//
// A `--plugin` profile keeps its `fetch` template: where the plugin's link
// declares `fetch: false`, the profile's fetch runs through the template link,
// so the view's link always fetches. With `slots: "mu"` each call holds a
// host channel as the template link's does; with `slots: "self"` the plugin
// arbitrates its own connection and mu admits nothing. A provider host has no
// profile and no session cap (its job slots are `max_jobs`): nothing to admit,
// no fetch template, and its fingerprint is `provider:<id>:<instance>`.
//
// Errors: `human` is the host's hand-back (`HostHandbackError`); `permanent`
// and an exhausted `retryable` propagate (`PluginCallError`); no answer or
// `unknown-outcome` is a run with no exit code, the outcome a timed-out
// template leaves (the link's `remoteOnTimeout` says what may still run; a
// declared `stopping` is waited out for one grace, then `stopped`).
// A check read with no answer is one failed step; a check's hand-back is the
// template runner's `handback` step, so checkHost skips the rest.

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../db.js";
import {
  type CheckContext,
  type HostLink,
  type LinkCall,
  type LinkRun,
  templateLink,
} from "../host-link.js";
import { type HostView, providerIdentity } from "../host-provider.js";
import { HANDED_BACK, type HostCheckStep, HostHandbackError, withHostChannel } from "../hosts.js";
import { git } from "../vcs/git.js";
import { PLUGIN_READ_TIMEOUT_MS, type PluginSession } from "./client.js";
import {
  EffectOutcomeUnknownError,
  PluginAnswerUnknownError,
  PluginCallError,
  PluginRefusedError,
} from "./errors.js";
import { narrowCheckSteps, narrowLinkRun, type WireCheckStep } from "./protocol.js";
import { getPlugin, pluginSeams, pluginSession } from "./registry.js";

/** The wire `target` of a link call (D13): the host's name, and a provider host's handle and instance. */
export function hostTarget(host: HostView): {
  host: { name: string; handle?: string; instance?: string };
} {
  const r = host.record;
  return {
    host: {
      name: host.name,
      ...(r?.handle != null ? { handle: r.handle } : {}),
      ...(r?.instance != null ? { instance: r.instance } : {}),
    },
  };
}
const target = hostTarget;

/**
 * The link of plugin `name`, from its registration. Refuses a plugin with no link seam. A
 * provider host's (`provider`) has no fetch template behind it: it fetches only as declared.
 */
export function pluginLink(db: Db, name: string, opts: { provider?: boolean } = {}): HostLink {
  const row = getPlugin(db, name);
  const declared = pluginSeams(row).link;
  if (declared === undefined) {
    throw new PluginRefusedError(name, ["it implements no link seam, which a --plugin host needs"]);
  }
  // `stopping` is `stopped` once the adapter has waited the grace out after a timed-out run.
  // A provider host's link has no fetch template behind it: it fetches only as declared.
  const caps = {
    ...declared,
    fetch: declared.fetch || opts.provider !== true,
    remoteOnTimeout: declared.remoteOnTimeout === "unknown" ? "unknown" : "stopped",
  } as const;
  const session = (): Promise<PluginSession> => pluginSession(db, name, ["link"]);

  /** Admission per `slots`, then `admitted` on the snapshot, then `body`. */
  const admit = async <T>(
    host: HostView,
    call: LinkCall,
    admitted: ((h: HostView) => void) | undefined,
    body: (h: HostView) => Promise<T>,
  ): Promise<T> => {
    if (declared.slots === "self" || "lease" in call || host.record !== undefined) {
      admitted?.(host);
      return body(host);
    }
    const { holder, ...opts } = call;
    return withHostChannel(
      db,
      host.name,
      holder,
      (profile) => {
        const h = { ...host, profile };
        admitted?.(h);
        return body(h);
      },
      opts,
    );
  };

  /** One run: the plugin's reply, its hand-back, or no answer (no exit code). */
  const run = async (
    host: HostView,
    method: "link.exec" | "link.fetch" | "link.push",
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<LinkRun> => {
    const s = await session();
    try {
      // The plugin enforces `timeoutMs` and answers. mu's timer allows one grace on top, so
      // an answer at the deadline is a reply, not a kill (D13); past it, $/cancel, the
      // grace, the group killed.
      const r = await s.call(
        method,
        { target: target(host), ...params, timeoutMs },
        { kind: "effect", timeoutMs: timeoutMs + s.process.graceMs },
        narrowLinkRun,
      );
      // `stopping`: the remote run stops within one grace after the reply. Wait it out, still
      // under the call's admission, so a timed-out run returns stopped.
      if (r.exitCode === null && declared.remoteOnTimeout === "stopping") {
        await delay(s.process.graceMs);
      }
      return r;
    } catch (e) {
      if (e instanceof PluginCallError && e.kind === "human") {
        throw new HostHandbackError(
          host.name,
          method === "link.fetch" ? "fetch" : "exec",
          e.remedy ?? e.detail,
        );
      }
      if (e instanceof EffectOutcomeUnknownError) {
        return {
          exitCode: null,
          stdout: "",
          stderr: `plugin ${name}: ${e.reason}`,
          partial: false,
        };
      }
      throw e;
    }
  };

  const fetchByTemplate = opts.provider === true ? undefined : templateLink(db).fetch;
  const link: HostLink = {
    name,
    caps,
    fingerprint: (host) =>
      host.record !== undefined
        ? providerIdentity(host.record)
        : `plugin:${name}:${getPlugin(db, name).instance}`,
    fits: (_host, script) => {
      const bytes = Buffer.byteLength(script);
      return { ok: bytes <= declared.maxScriptBytes, bytes, limit: declared.maxScriptBytes };
    },
    exec: (host, req, call, admitted) =>
      admit(host, call, admitted, (h) =>
        run(h, "link.exec", { script: req.script, cwd: req.cwd }, req.timeoutMs),
      ),
    ...(caps.fetch
      ? {
          fetch: (host, req, call, admitted) => {
            if (!declared.fetch && fetchByTemplate !== undefined) {
              return fetchByTemplate(host, req, call, admitted);
            }
            return admit(host, call, admitted, async (h) => {
              // A stale FETCH_HEAD must not pass for this fetch's answer.
              const fetchHead = await git(["rev-parse", "--git-path", "FETCH_HEAD"], req.localRepo);
              await rm(resolve(req.localRepo, fetchHead), { force: true });
              return run(
                h,
                "link.fetch",
                { remoteCwd: req.remoteCwd, localRepo: req.localRepo },
                req.timeoutMs,
              );
            });
          },
        }
      : {}),
    // Declared by `push: true` only (D7 G3): mu never calls an undeclared method.
    ...(declared.push === true
      ? {
          push: (host, req, call, admitted) =>
            admit(host, call, admitted, (h) =>
              run(
                h,
                "link.push",
                { localRepo: req.localRepo, remoteRepo: req.remoteRepo, rev: req.rev },
                req.timeoutMs,
              ),
            ),
        }
      : {}),
    // The check runs under the caller's channel; the plugin only reads.
    async checkSteps(ctx: CheckContext, _call: LinkCall): Promise<HostCheckStep[]> {
      if (!declared.checks?.includes(ctx.phase)) return [];
      const params = {
        target: target(ctx.host),
        phase: ctx.phase,
        ...(ctx.root !== undefined ? { root: ctx.root } : {}),
        ...(ctx.agent !== undefined ? { agent: ctx.agent } : {}),
      };
      const timeoutMs = Math.max(PLUGIN_READ_TIMEOUT_MS, ctx.timeoutMs);
      return checkReport(name, ctx.host.name, "checks", async () =>
        (await session()).call(
          "link.checkSteps",
          params,
          { kind: "read", timeoutMs },
          narrowCheckSteps,
        ),
      );
    },
  };
  return link;
}

/**
 * A plugin's check steps, named `<plugin>:<step>` (`handback` keeps its name: checkHost skips the
 * rest on it); a `warn` step passes, marked `warn`. No answer is one failed `<plugin>:<label>` step; a `human` answer is the template
 * runner's hand-back report (checkRunner): the step skipped, then the `handback` step.
 */
export async function checkReport(
  name: string,
  host: string,
  label: string,
  steps: () => Promise<WireCheckStep[]>,
): Promise<HostCheckStep[]> {
  try {
    return (await steps()).map(({ ok, ...st }): HostCheckStep => {
      const level = ok === "warn" ? { ok: true, warn: true as const } : { ok };
      return st.step === "handback"
        ? { ...st, ...level }
        : { ...st, step: `${name}:${st.step}`, ...level };
    });
  } catch (e) {
    if (e instanceof PluginAnswerUnknownError) {
      return [{ step: `${name}:${label}`, ok: false, detail: `no answer: ${e.reason}` }];
    }
    if (e instanceof PluginCallError && e.kind === "human") {
      const back = new HostHandbackError(host, "exec", e.remedy ?? e.detail);
      return [
        { step: `${name}:${label}`, ok: null, detail: HANDED_BACK },
        { step: "handback", ok: false, detail: `${name}:${label}: ${back.message}` },
      ];
    }
    throw e;
  }
}
