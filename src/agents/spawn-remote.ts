// mu — the remote half of spawn (`spawn --host`): refuse an unrunnable spawn
// before any effect (requireHostSpawn), admit the host channel and prepare the
// remote site or worktree (admitRemoteSpawn, prestageRemote), and remove a
// remote worktree on rollback (rollbackRemoteWorktree). Split from spawn.ts;
// it takes types from spawn.ts only (no runtime import back). It also decides
// whether a remote spawn is a command gate (isCommandGate, re-exported there).

import { basename } from "node:path";
import { deleteAgent, getAgent, insertAgent, pendingPaneIdFor } from "../agents.js";
import type { Db } from "../db.js";
import { harnessOfCli, speaksMuCtl } from "../harnesses.js";
import { refuseMissingHarness } from "../host-harnesses.js";
import type { LinkCall } from "../host-link.js";
import { type HostView, requireProfile, resolveHost } from "../host-provider.js";
import {
  admitHostChannel,
  CarrierViewUnsupportedError,
  type HostLease,
  type HostProfile,
  HostProfileError,
  HostSpawnUnsupportedError,
  isValidHostName,
  LOCAL_LOOP_TRANSPORT,
  releaseHostChannel,
} from "../hosts.js";
import { HONOURS_ALL, type JobKind } from "../jobs/types.js";
import { viewRunning } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import type { MuxBackend } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { recoveriesFor, refuseRecoveredWorktree } from "../remote-recovery.js";
import { prepareRemote, type RemoteSite, removeRemoteWorktree } from "../remote-worktree.js";
import { git, gitToplevel } from "../vcs/git.js";
import { withAgentLock } from "./lock.js";
import type { SpawnAgentOptions, StagedWorktree } from "./spawn.js";
import type { PluginJobKind } from "./spawn-plugin.js";

/** The remote repo of a `--host` spawn: `--root`, else the profile's default. */
function remoteRoot(opts: SpawnAgentOptions, profile: HostProfile): { root?: string } {
  const root = opts.root ?? profile.repo ?? undefined;
  return root === undefined ? {} : { root };
}

/**
 * True when a REMOTE spawn is a command gate, not a worker: an explicit
 * `--command` that runs no harness. An explicit `--cli pi` and a `pi` /
 * `pi-meta` argv0 stay workers (an opaque wrapper around pi needs `--cli pi`),
 * as does a command or cli key that maps to a hook harness row (`claude ...`,
 * `--cli claude-big`: spec D17, the harness from argv0, then the key and its
 * prefix), so worktrees and lease profiles work for it. Decided before any
 * effect; `--cli` omitted classifies by the command alone, so
 * `--host dev --command 'npm test'` is a gate even though `cli` defaults to pi.
 */
export function isCommandGate(opts: { host?: string; cli?: string; command?: string }): boolean {
  if (opts.host === undefined || opts.command === undefined) return false;
  if (opts.cli === "pi") return false;
  const argv0 = basename(opts.command.trim().split(/\s+/)[0] ?? "");
  if (argv0 === "pi" || argv0 === "pi-meta") return false;
  // pi keeps the rule above exactly: a key like `pi-meta` around another command is still a gate.
  const harness = harnessOfCli(opts.cli ?? "", opts.command);
  return harness === undefined || harness === "pi";
}

/** The host's plugin job kind (as opposed to a built-in pane or lease job kind). */
export function pluginKindOf(host: HostView): PluginJobKind | undefined {
  const k = host.jobKind as Partial<PluginJobKind> | undefined;
  return typeof k?.plugin === "string" ? (host.jobKind as PluginJobKind) : undefined;
}

/** Refuse before staging cleanup or a task receipt; only pane-backed host paths need this. */
export async function refuseRemoteSpawnMux(db: Db, opts: SpawnAgentOptions): Promise<void> {
  if (opts.host === undefined) return;
  const mux = await activeMux();
  if (mux.runsShellCommand && mux.carrierViews) return;
  const host = resolveHost(db, opts.host);
  if (mux.runsShellCommand) return refuseCarrierViewMux(mux, host.name, carrierViewOf(host));
  // Switching multiplexers cannot make a link-only host spawnable.
  requireHostJobKind(host);
  throw unsupportedSpawnMux(host, opts, mux.name);
}

function muleWorkspaceProfile(view: HostView): HostProfile {
  const profile = view.profile;
  if (profile?.plugin !== "mule" || view.link.caps.slots !== "self" || !view.link.fetch) {
    throw new HostProfileError(
      `--mule needs a static --plugin mule profile with a self-admitting link and fetch; configure host ${view.name} with mu host init ${view.name} --mule`,
    );
  }
  return profile;
}

/** Remote workspace preflight, before receipts, staging cleanup or a remote command. */
export async function requireMuleWorkspace(
  db: Db,
  opts: SpawnAgentOptions,
  name: string,
  command: string,
): Promise<HostProfile> {
  if (!isValidHostName(name)) {
    throw new HostProfileError("--mule takes a host profile name; mu chooses the worktree path");
  }
  if (opts.host !== undefined || opts.cwd !== undefined) {
    throw new HostProfileError(
      "--mule creates a remote worktree; do not combine it with --host or --cwd",
    );
  }
  if (opts.orchestrator === true) {
    throw new HostProfileError("--mule runs workers only; start the orchestrator locally");
  }
  const cli = opts.cli ?? "pi";
  if (!speaksMuCtl(cli, command) || harnessOfCli(cli, command) !== "pi") {
    throw new HostProfileError("--mule requires local pi; use --cli pi and a pi launch command");
  }
  const profile = muleWorkspaceProfile(resolveHost(db, name));
  if (opts.root === undefined && profile.repo === null) {
    throw new HostProfileError(`host ${name} has no default repo: pass --root <remote repo path>`);
  }
  const mux = await activeMux();
  if (!mux.runsShellCommand) {
    throw new HostSpawnUnsupportedError(name, mux.name, "local pi with a mule workspace", false);
  }
  return profile;
}

/** What a host spawn runs as a carrier job's view (D15), or undefined: none. */
export function carrierViewOf(host: HostView): CarrierViewUnsupportedError["what"] | undefined {
  if (pluginKindOf(host) !== undefined) return "a plugin job's view";
  return host.profile?.transport === "lease" ? "a lease spawn" : undefined;
}

/**
 * D15: lease and plugin job views are tmux-only for now. THE guard: a lease carrier or a
 * plugin kind's view on a backend without `carrierViews` (Rex: its replies do not yet name the
 * server instance that answered, so a view's birth and absence cannot be proven) refuses
 * before any reservation, job.start, job file, pane or row. Asked by every host spawn's
 * prepare (`refuseRemoteSpawnMux`), `requireHostSpawn`, the plugin spawn, and both reattaches
 * (src/agents/reattach-view.ts, reattach-check.ts). Any other host spawn passes.
 */
export function refuseCarrierViewMux(
  mux: Pick<MuxBackend, "name" | "carrierViews">,
  host: string,
  what: CarrierViewUnsupportedError["what"] | undefined,
): void {
  if (mux.carrierViews || what === undefined) return;
  throw new CarrierViewUnsupportedError(host, mux.name, what);
}

function unsupportedSpawnMux(host: HostView, opts: SpawnAgentOptions, mux: string) {
  const part = pluginKindOf(host)
    ? "job view command"
    : isCommandGate(opts)
      ? "command gate"
      : "managed argv";
  return new HostSpawnUnsupportedError(host.name, mux, part, carrierViewOf(host) !== undefined);
}

/**
 * A spawn requests a `JobSpec` field its host's job kind does not enforce (plugins spec D8,
 * honour or refuse): refused before any effect, never run with the field dropped. Exit 2.
 */
export class JobSpecUnsupportedError extends HostProfileError {
  override readonly name: string = "JobSpecUnsupportedError";
  constructor(
    public readonly host: string,
    public readonly kind: string,
    public readonly field: "role" | "command" | "sockets" | "prompt",
    detail: string,
  ) {
    super(`host ${host}'s job kind ${kind} does not honour ${detail}: refused before anything ran`);
  }
}

/** Honour or refuse: every requested field the kind enforces, or the spawn refuses. */
export function refuseUnhonoured(host: HostView, kind: JobKind, opts: SpawnAgentOptions): void {
  const h = kind.caps.honours ?? HONOURS_ALL;
  const role = opts.role === "read-only" ? "read-only" : "full-access";
  const refuse = (field: JobSpecUnsupportedError["field"], detail: string): never => {
    throw new JobSpecUnsupportedError(host.name, kind.name, field, detail);
  };
  // A read-only spawn never runs with a wider role.
  if (!h.roles.includes(role)) refuse("role", `role ${role}`);
  // A remote spawn's command is --command or the cli key (never the local MU_<CLI>_COMMAND).
  if (opts.command !== undefined && !h.command) refuse("command", `a --command`);
  // Sockets go only to an agent on ctl, and never to a kind with its own channel. On ctl is
  // the rule that picks the channel (speaksMuCtl), so `--cli pi --command claude` asks too.
  const cli = opts.cli ?? "pi";
  const onCtl =
    kind.caps.channel === undefined &&
    !isCommandGate(opts) &&
    speaksMuCtl(cli, opts.command ?? cli);
  if (onCtl && !h.sockets) refuse("sockets", "the control sockets a pi agent needs");
}

function requireHostJobKind(view: HostView): JobKind {
  if (view.jobKind === undefined) {
    throw new HostProfileError(
      `host ${view.name}'s provider ${view.provider.name} runs no jobs: its plugin declares no job seam`,
    );
  }
  // A link-only plugin has neither a job kind nor a shell template to run in a pane.
  if (view.profile?.plugin != null && pluginKindOf(view) === undefined) {
    throw new HostProfileError(
      `host ${view.name}'s link is plugin ${view.profile.plugin}, which declares no job seam: spawning on a link-only plugin is not supported yet`,
    );
  }
  return view.jobKind;
}

/** The profile `--host` names, with the D17 harness and worktree checks. Read only. */
export async function requireHostSpawn(db: Db, opts: SpawnAgentOptions): Promise<HostProfile> {
  const host = opts.host ?? "";
  const view = resolveHost(db, host);
  const kind = requireHostJobKind(view);
  const profile = requireProfile(view);
  refuseUnhonoured(view, kind, opts);
  if (!isCommandGate(opts)) {
    // The literal command a remote spawn runs: never the local MU_<KEY>_COMMAND.
    const cli = opts.cli ?? "pi";
    const command = opts.command ?? cli;
    refuseMissingHarness(profile, harnessOfCli(cli, command), command);
  }
  if (opts.worktree && opts.root === undefined && profile.repo === null) {
    throw new HostProfileError(
      `host ${host} has no default repo: pass --root <remote repo path> with --worktree`,
    );
  }
  // A removed agent's tree on this host may still sit at the name's path, or parked beside
  // it: a new tree there could strand that record. Refused before any effect.
  if (opts.worktree) refuseRecoveredWorktree(db, opts.workstream, opts.name, host);
  const mux = await activeMux();
  if (!mux.runsShellCommand) throw unsupportedSpawnMux(view, opts, mux.name);
  refuseCarrierViewMux(mux, host, carrierViewOf(view));
  return profile;
}

/**
 * `--worktree` on a host, the remote twin of prestageLocked: a placeholder row
 * claims the name (host recorded), then ONE exec under the spawn's lease makes
 * the detached worktree. Only a worktree this exec made is ever removed.
 */
async function prestageRemote(
  db: Db,
  opts: SpawnAgentOptions,
  cli: string,
  spawner: string | null,
  call: LinkCall,
  profile: HostProfile,
  reservation: string | undefined,
  rev: string | undefined,
): Promise<StagedWorktree> {
  return withAgentLock(db, opts.workstream, opts.name, async () => {
    refuseRecoveredWorktree(db, opts.workstream, opts.name, profile.name);
    const placeholder = insertAgent(db, {
      ...(reservation !== undefined ? { reservation } : {}),
      name: opts.name,
      workstream: opts.workstream,
      cli,
      paneId: pendingPaneIdFor(opts.name),
      role: opts.role,
      tab: opts.tab ?? null,
      cwd: null,
      spawner,
      host: profile.name,
      hostTransport: opts.mule !== undefined ? LOCAL_LOOP_TRANSPORT : profile.transport,
    });
    try {
      const made = await prepareRemote(db, call, profile, {
        workstream: opts.workstream,
        name: opts.name,
        worktree: true,
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...remoteRoot(opts, profile),
        // Profiles can share a machine. A recovery on another profile forbids
        // reclaim, not creation: prepare still claims a free path on a different machine.
        reclaim: recoveriesFor(db, opts.workstream, opts.name).length === 0,
        ...(rev !== undefined ? { rev } : {}),
      });
      // The placeholder names its tree before anything else can fail: a mu that dies from
      // here to the finalize leaves a row whose close removes that tree, and whose delete
      // writes its `remote_recovery` record (an owned remote row), never a tree no record names.
      stampPlaceholderTree(db, placeholder.incarnation, opts.name, made);
      return {
        path: made.cwd,
        base: made.base ?? "",
        root: made.repo ?? "",
        createdAt: new Date().toISOString(),
        incarnation: placeholder.incarnation,
        host: profile.name,
      };
    } catch (err) {
      try {
        deleteAgent(db, opts.name, opts.workstream, { incarnation: placeholder.incarnation });
      } catch {
        // best-effort: never mask the remote error
      }
      throw err;
    }
  });
}

/**
 * The remote half of admission: reserve the host channel (a full host refuses
 * here), then prepare the remote worktree (`--worktree`) or the remote site.
 * A plugin link with `slots: "self"` arbitrates its own connection: mu takes no
 * channel at all (placement spec §4.2, §I), and the lease returned is undefined.
 * Returns the lease and the ADMITTED profile snapshot every template runs from.
 * A failure after admission frees the channel here (no pane was opened under it).
 * A lease profile's channel is transient: released once prepare ends, so the
 * returned lease is undefined (a lease pane holds no channel).
 */
export async function admitRemoteSpawn(
  db: Db,
  opts: SpawnAgentOptions,
  cli: string,
  spawner: string | null,
  profile: HostProfile,
  /** Re-checks the ADMITTED profile before any remote command (a throw frees the channel). */
  admit?: (admitted: HostProfile) => void,
  /** A lease spawn's `carrier_jobs` reservation token: the placeholder row passes the name fence with it. */
  reservation?: string,
): Promise<{
  lease: HostLease | undefined;
  profile: HostProfile;
  staged: StagedWorktree | undefined;
  site: RemoteSite | undefined;
}> {
  // A worktree's base, resolved here before any remote call (§3.3): the host gets the sha.
  const rev = opts.worktree ? await resolveStaticBase(profile.name, opts.from) : undefined;
  const view = resolveHost(db, profile.name);
  // A profile swapped during base resolution must not turn a remote workspace prepare
  // into a template exec or take a counted channel.
  if (opts.mule !== undefined) muleWorkspaceProfile(view);
  if (view.link.caps.slots === "self") {
    const current = requireProfile(view);
    admit?.(current);
    const prepared = await prepareSite(
      db,
      opts,
      cli,
      spawner,
      { holder: `spawn:${opts.workstream}/${opts.name}` },
      current,
      reservation,
      rev,
    );
    return { lease: undefined, profile: current, ...prepared };
  }
  const admitted = await admitHostChannel(
    db,
    profile.name,
    `spawn:${opts.workstream}/${opts.name}`,
    { paneAlive: viewRunning },
  );
  const { lease } = admitted;
  const admittedProfile = admitted.profile;
  const transient = admittedProfile.transport === "lease";
  try {
    admit?.(admittedProfile);
    const { staged, site } = await prepareSite(
      db,
      opts,
      cli,
      spawner,
      { lease },
      admittedProfile,
      reservation,
      rev,
    );
    if (transient) releaseHostChannel(db, lease); // prepare is over: nothing binds to the pane
    return { lease: transient ? undefined : lease, profile: admittedProfile, staged, site };
  } catch (err) {
    releaseHostChannel(db, lease); // no pane was ever opened under it
    throw err;
  }
}

/** The remote worktree (`--worktree`) or the remote site, under `call`. */
async function prepareSite(
  db: Db,
  opts: SpawnAgentOptions,
  cli: string,
  spawner: string | null,
  call: LinkCall,
  profile: HostProfile,
  reservation: string | undefined,
  rev: string | undefined,
): Promise<{ staged: StagedWorktree | undefined; site: RemoteSite | undefined }> {
  if (opts.worktree) {
    const staged = await prestageRemote(db, opts, cli, spawner, call, profile, reservation, rev);
    return { staged, site: undefined };
  }
  const site = await prepareRemote(db, call, profile, {
    workstream: opts.workstream,
    name: opts.name,
    worktree: false,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...remoteRoot(opts, profile),
  });
  return { staged: undefined, site };
}

/** A static `--worktree` spawn's `--from` names no commit in the caller's checkout. Exit 2, nothing run. */
export class RemoteBaseRefError extends HostProfileError {
  override readonly name: string = "RemoteBaseRefError";
  constructor(
    public readonly host: string,
    public readonly ref: string,
    detail: string,
  ) {
    super(`--worktree on host ${host}: --from ${ref} ${detail}; nothing ran on ${host}`);
  }
}

/**
 * The base of a `--worktree` spawn on a static host (placement spec §3.3): `from`
 * (default `HEAD`) resolved to a sha in the caller's checkout, before any remote call, so the
 * host is asked for exactly that commit and a retry names the same one. mu never fetches or
 * pushes for it: a host that lacks it refuses with the sha (`RemoteBaseMissingError`).
 */
export async function resolveStaticBase(host: string, from: string | undefined): Promise<string> {
  const ref = from ?? "HEAD";
  const repo = await gitToplevel(process.cwd());
  if (repo === undefined) {
    throw new RemoteBaseRefError(
      host,
      ref,
      "cannot be resolved: run the spawn inside the checkout the host's repo follows",
    );
  }
  try {
    return await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
  } catch {
    throw new RemoteBaseRefError(host, ref, `names no commit in ${repo}`);
  }
}

/** A remote placeholder's tree, recorded the moment its prepare answered (only while still pending). */
function stampPlaceholderTree(db: Db, id: number, name: string, site: RemoteSite): void {
  db.prepare("UPDATE agents SET cwd = ?, base = ?, repo = ? WHERE id = ? AND pane_id = ?").run(
    site.cwd,
    site.base ?? "",
    site.repo ?? null,
    id,
    pendingPaneIdFor(name),
  );
}

/**
 * Rollback of a worktree on a remote host: its own exec, under its own
 * channel, once the pane's is free. Only while the name is still this spawn's.
 * Returns whether the tree is proven gone (the row's delete then owes no
 * recovery record). Never throws.
 */
export async function rollbackRemoteWorktree(
  db: Db,
  name: string,
  workstream: string,
  staged: StagedWorktree,
  paneGone: boolean,
): Promise<boolean> {
  let remoteGone = false;
  try {
    if (!paneGone) throw new Error("pane not proven gone");
    await withAgentLock(db, workstream, name, async () => {
      const cur = getAgent(db, name, workstream);
      if (cur !== undefined && cur.incarnation !== staged.incarnation) return;
      remoteGone = await removeRemoteWorktree(
        db,
        staged.host ?? "",
        `rollback:${workstream}/${name}`,
        staged,
      );
    });
  } catch {
    try {
      emitEvent(
        db,
        workstream,
        "agent.spawn_failed",
        `agent spawn rollback ${name}: remote worktree ${staged.path} on ${staged.host} was not removed`,
      );
    } catch {
      // best-effort
    }
  }
  return remoteGone;
}
