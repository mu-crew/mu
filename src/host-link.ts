// mu — the host link seam (spec 2026-11-09-mu-plugins.md, D7): how mu runs a
// script on a host and brings a remote HEAD home.
//
// A link runs mu's POSIX sh scripts (`exec`) and, optionally, fetches
// (`fetch`). It never decides anything: worktree rules, collect's ref pin and
// every parse of an answer stay in mu (src/remote-worktree.ts,
// src/remote-collect.ts). The built-in `template` link is today's profile
// `exec` and `fetch` templates, run by the template runner in src/hosts.ts
// (`runLeasedTemplate`): admission and the pgid record before the command, the
// timeout plus `HOST_GRACE_MS`, exit 3 as a hand-back. The runner has three
// callers: this link, the lease kind (`stop`, src/carrier-stop.ts) and
// `checkHost`. A plugin link joins in P6b, mule's in P7.
//
// A link call names the channel it runs under (`LinkCall`), as every caller
// does today. The spec's `Call` (deadline, abort signal, src/host-provider.ts)
// replaces it at the plugin adapter (P6b). The `HostView` a link is handed
// comes from `resolveHost` or an admitted snapshot (src/host-provider.ts).

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Db } from "./db.js";
import { type HostView, requireProfile } from "./host-provider.js";
import {
  type ChannelOpts,
  expandHostTemplate,
  type HostCheckStep,
  type HostLease,
  type HostRun,
  runLeasedTemplate,
  withHostChannel,
} from "./hosts.js";
import { git } from "./vcs/git.js";

/** Linux's cap on one exec argument (MAX_ARG_STRLEN), its terminating NUL included. */
export const EXEC_ARG_MAX_BYTES = 128 * 1024;

export interface LinkRun extends HostRun {
  /** The output was cut (mule's exit 7): never parsed. The template link never cuts. */
  partial: boolean;
}

/** The `checkHost` phases a link or a job kind contributes steps to (spec D11). */
export type CheckPhase = "template" | "reach" | "agent";

export interface CheckContext {
  db: Db;
  host: HostView;
  phase: CheckPhase;
  root?: string;
  agent?: { name: string; workstream: string };
}

export interface LinkCaps {
  fetch: boolean;
  /** "mu": every call holds a host channel (src/hosts.ts admission). "self": the link arbitrates its connection. */
  slots: "mu" | "self";
  /** After a timeout: the remote script proven stopped, or possibly still running. */
  remoteOnTimeout: "stopped" | "unknown";
  /** Whether a scan over exec sees the processes the host's jobs run as (same user, same PID namespace). */
  quiescence: "provable" | "unprovable";
  /** Plugins: the largest script, in bytes. The template link measures the expanded argument instead. */
  maxScriptBytes?: number;
  /** The CheckContext phases this link contributes steps for (spec D11). */
  checks?: CheckPhase[];
}

/**
 * The channel a call runs under: a new transient one for `holder` (admitted,
 * and released when the call ends), or `lease`, one the caller already holds
 * and passes to several calls (spawn's prepare, close's two execs, as today).
 */
export type LinkCall = ({ holder: string } & ChannelOpts) | { lease: HostLease };

/** Whether a script fits the link: `bytes` as the link measures it, under `limit`. */
export interface ScriptFit {
  ok: boolean;
  bytes: number;
  limit: number;
}

export interface HostLink {
  /** "template", or the plugin's name. */
  readonly name: string;
  readonly caps: LinkCaps;
  /** Computed by mu, never a wire call: the host identity a recovery pins (a template profile's exec bytes). */
  fingerprint(host: HostView): string;
  /** Template: the expanded exec under EXEC_ARG_MAX_BYTES. Plugin: maxScriptBytes. */
  fits(host: HostView, script: string, cwd: string): ScriptFit;
  /**
   * Run `script` (a POSIX sh command line: the exec template's `{cmd}`) in the remote `cwd`
   * (`.` is the login directory). Returns once nothing it started locally still runs.
   * `admitted` runs inside admission, before the command, on the admitted snapshot:
   * a throw runs nothing.
   */
  exec(
    host: HostView,
    req: { script: string; cwd: string; timeoutMs: number },
    call: LinkCall,
    admitted?: (h: HostView) => void,
  ): Promise<LinkRun>;
  /**
   * Bring `remoteCwd`'s HEAD home: on success, `localRepo`'s FETCH_HEAD names that commit.
   * The link deletes FETCH_HEAD after `admitted` and before the command; the caller accepts
   * only `FETCH_HEAD^{commit}` afterwards, so a fetch that leaves none is a failed collect.
   */
  fetch?(
    host: HostView,
    req: { remoteCwd: string; localRepo: string; timeoutMs: number },
    call: LinkCall,
    admitted?: (h: HostView) => void,
  ): Promise<LinkRun>;
  checkSteps?(ctx: CheckContext): Promise<HostCheckStep[]>;
}

/** Run `body` under the call's channel, given the profile it runs from and the lease. */
async function underChannel(
  db: Db,
  host: HostView,
  call: LinkCall,
  admitted: ((h: HostView) => void) | undefined,
  body: (h: HostView, lease: HostLease) => Promise<HostRun>,
): Promise<LinkRun> {
  const run = async (h: HostView, lease: HostLease): Promise<LinkRun> => {
    admitted?.(h);
    return { ...(await body(h, lease)), partial: false };
  };
  if ("lease" in call) return run(host, call.lease);
  const { holder, ...opts } = call;
  return withHostChannel(
    db,
    host.name,
    holder,
    (profile, lease) => run({ ...host, profile }, lease),
    opts,
  );
}

/** The built-in link over `db`'s profiles: today's `exec` and `fetch` templates. */
export function templateLink(db: Db): HostLink {
  return {
    name: "template",
    caps: {
      fetch: true,
      slots: "mu",
      // A killed local ssh does not stop the remote command.
      remoteOnTimeout: "unknown",
      quiescence: "provable",
    },
    fingerprint: (host) => requireProfile(host).exec,
    fits: (host, script, cwd) => {
      // The filled template is ONE argument of the local `/bin/sh -c`, and holds every
      // argument the host's shells get: measured as exec'd, before anything runs.
      const bytes = Buffer.byteLength(
        expandHostTemplate(requireProfile(host).exec, { cmd: script, cwd }, "exec"),
      );
      return { ok: bytes < EXEC_ARG_MAX_BYTES, bytes, limit: EXEC_ARG_MAX_BYTES };
    },
    exec: (host, req, call, admitted) =>
      underChannel(db, host, call, admitted, (h, lease) =>
        runLeasedTemplate(
          db,
          lease,
          requireProfile(h),
          "exec",
          { cmd: req.script, cwd: req.cwd },
          req.timeoutMs,
        ),
      ),
    fetch: (host, req, call, admitted) =>
      underChannel(db, host, call, admitted, async (h, lease) => {
        // Under the channel, so a refused fetch touches nothing. A stale FETCH_HEAD must
        // not pass for this fetch's answer.
        const fetchHead = await git(["rev-parse", "--git-path", "FETCH_HEAD"], req.localRepo);
        await rm(resolve(req.localRepo, fetchHead), { force: true });
        return runLeasedTemplate(
          db,
          lease,
          requireProfile(h),
          "fetch",
          { cwd: req.remoteCwd },
          req.timeoutMs,
          req.localRepo,
        );
      }),
  };
}
