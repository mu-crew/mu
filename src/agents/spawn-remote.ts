// mu — the remote half of spawn (`spawn --host`): refuse an unrunnable spawn
// before any effect (requireHostSpawn), admit the host channel and prepare the
// remote site or worktree (admitRemoteSpawn, prestageRemote), and remove a
// remote worktree on rollback (rollbackRemoteWorktree). Split from spawn.ts;
// it takes types from spawn.ts only (no runtime import back). It also decides
// whether a remote spawn is a command gate (isCommandGate, re-exported there).

import { basename } from "node:path";
import { deleteAgent, getAgent, insertAgent, pendingPaneIdFor } from "../agents.js";
import type { Db } from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { refuseMissingHarness } from "../host-harnesses.js";
import {
  admitHostChannel,
  getHost,
  type HostLease,
  type HostProfile,
  HostProfileError,
  HostSpawnUnsupportedError,
  releaseHostChannel,
} from "../hosts.js";
import { viewRunning } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import { activeMux } from "../mux.js";
import { prepareRemote, type RemoteSite, removeRemoteWorktree } from "../remote-agent.js";
import { refuseRecoveredWorktree } from "../remote-recovery.js";
import { withAgentLock } from "./lock.js";
import type { SpawnAgentOptions, StagedWorktree } from "./spawn.js";

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

/**
 * The profile `--host` names, once the spawn is known to be runnable on it. Nothing is touched.
 * A spawn of a harness whose launcher the host's recorded probe did not find is refused here
 * (`HostHarnessMissingError`, spec D17).
 */
export async function requireHostSpawn(db: Db, opts: SpawnAgentOptions): Promise<HostProfile> {
  const host = opts.host ?? "";
  const profile = getHost(db, host);
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
  if (!mux.runsShellCommand) throw new HostSpawnUnsupportedError(host, mux.name);
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
  lease: HostLease,
  profile: HostProfile,
  reservation: string | undefined,
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
      hostTransport: profile.transport,
    });
    try {
      const made = await prepareRemote(db, lease, profile, {
        workstream: opts.workstream,
        name: opts.name,
        worktree: true,
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...remoteRoot(opts, profile),
        // An unused leftover of a prepare whose answer was lost is taken over: no
        // removed agent's recovery record names a tree there (checked above, under the lock).
        reclaim: true,
      });
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
    let staged: StagedWorktree | undefined;
    let site: RemoteSite | undefined;
    if (opts.worktree) {
      staged = await prestageRemote(db, opts, cli, spawner, lease, admittedProfile, reservation);
    } else {
      site = await prepareRemote(db, lease, admittedProfile, {
        workstream: opts.workstream,
        name: opts.name,
        worktree: false,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...remoteRoot(opts, admittedProfile),
      });
    }
    if (transient) releaseHostChannel(db, lease); // prepare is over: nothing binds to the pane
    return { lease: transient ? undefined : lease, profile: admittedProfile, staged, site };
  } catch (err) {
    releaseHostChannel(db, lease); // no pane was ever opened under it
    throw err;
  }
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
