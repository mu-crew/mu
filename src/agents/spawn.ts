// mu — spawnAgent + supporting helpers (resolveCliCommand,
// prestageWorktree, finalizeAgentRow). The readiness helpers (handshake,
// liveness, startup scan) live in spawn-ready.ts, the remote half in
// spawn-remote.ts and rollbackSpawn in spawn-rollback.ts; all are re-exported
// here, so imports of agents/spawn.js keep working.
//
// spawnAgent's flow is documented inline. The interesting bit is the
// `--worktree` cycle (the pane starts IN the worktree, so the worktree
// exists before the pane, while the agent name must already be claimed) —
// see prestageWorktree.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type AgentRow,
  deleteAgent,
  getAgent,
  type InsertAgentInput,
  insertAgent,
  isValidAgentName,
  MAX_AGENT_NAME_LEN,
  pendingPaneIdFor,
} from "../agents.js";
import { anchorWrapper, newRemoteKey, pruneAnchors, remoteAnchorWrapper } from "../anchors.js";
import {
  bindCarrierJobAgent,
  getCarrierJobByName,
  markCarrierLaunch,
  recordCarrierPane,
  setCarrierJobStop,
} from "../carrier-jobs.js";
import type { ChannelName, SendResult } from "../channels/types.js";
import { CTL_SOCK_ENV, ctlSocketPath } from "../ctl/path.js";
import {
  type Db,
  defaultDbPath,
  defaultStateDir,
  tornDownAtOf,
  WorkstreamTornDownError,
} from "../db.js";
import { harnessOfCli } from "../harnesses.js";
import { resolveHost } from "../host-provider.js";
import {
  bindHostChannel,
  type HostLease,
  type HostProfile,
  HostProfileError,
  releaseHostChannel,
} from "../hosts.js";
import { awaitLeaseJob } from "../jobs/lease.js";
import { viewPresent } from "../jobs/view.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import { attachShellLine, type CommandSource } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { isJsonMode } from "../output.js";
import { remoteShellCommand } from "../remote-agent.js";
import { RemotePathOwnedError, refuseOwnedRemotePath } from "../remote-recovery.js";
import type { RemoteSite } from "../remote-worktree.js";
import { resolveActorIdentity } from "../tasks/claim.js";
import { discardWorktree, git, gitToplevel, owningRoot } from "../vcs/git.js";
import { isScratchWorkstream } from "../workstream.js";
import {
  createWorktree,
  reclaimWorktreePath,
  registerWorktree,
  WorktreeVcsRequiredError,
  worktreePath,
} from "../worktree.js";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNameExhaustedError,
  AgentReplacedError,
  AgentSpawnCliNotFoundError,
} from "./errors.js";
import { gateWrapper, newGateToken } from "./gate.js";
import {
  assertLeaseSpawnable,
  claimLeaseJobFile,
  refuseReserved,
  releaseLeaseReservation,
  reserveLeaseJob,
} from "./lease-carrier.js";
import { withAgentLock } from "./lock.js";
import { withSpawnLock } from "./spawn-lock.js";
import { pluginKindOf, spawnPluginAgent } from "./spawn-plugin.js";
import { launchCommand } from "./spawn-presets.js";
import {
  awaitCtlHandshake,
  awaitSpawnLiveness,
  checkSpawnHealth,
  defaultSpawnCtlMs,
  defaultSpawnLivenessMs,
  type SpawnCtl,
} from "./spawn-ready.js";
import { admitRemoteSpawn, isCommandGate, requireHostSpawn } from "./spawn-remote.js";
import { rollbackSpawn } from "./spawn-rollback.js";
import { reclaimDeadStagings } from "./staging.js";

export {
  defaultSpawnCtlMs,
  defaultSpawnLivenessMs,
  detectClaudeTrustDialog,
  detectSpawnStartupError,
  probeToSpawnCtl,
  resetHandshakeClockForTests,
  type SpawnCtl,
  setHandshakeClockForTests,
} from "./spawn-ready.js";
export { isCommandGate } from "./spawn-remote.js";
export { rollbackSpawn } from "./spawn-rollback.js";

/**
 * Smallest-unused-suffix naming convention for agent names: a role
 * (lowercase alpha + digits) followed by `-<n>` where `<n>` is one or
 * more digits. Examples that pass: `worker-1`, `reviewer-2`, `scout-12`.
 * Examples that warn: `worker-tests`, `alice`, `db-leader`, `x-y-1`.
 *
 * The dogfood report was operators (LLMs included) drifting to descriptive names like
 * `worker-tests` after a few spawns, breaking the convention silently.
 * The hint surfaced by `maybeWarnNonConventionalAgentName` is a lint, not
 * a rule — `isValidAgentName` still accepts the broader
 * `^[a-z][a-z0-9_-]{0,31}$` shape.
 */
const AGENT_NAME_CONVENTION_RE = /^[a-z][a-z0-9]*(?:-[0-9]+)$/;

/**
 * Stderr lint when an agent name doesn't match the smallest-unused-suffix
 * convention. Mirrors the slugify-truncation stderr hint in cmdTaskAdd
 * (commit 28a13af): stderr-only, exit 0, suppressed under --json so
 * machine consumers stay clean. The spawn already succeeded by the time
 * this runs — we're just nudging the operator toward `<role>-<n>`.
 */
function maybeWarnNonConventionalAgentName(name: string): void {
  if (AGENT_NAME_CONVENTION_RE.test(name)) return;
  if (isJsonMode()) return;
  process.stderr.write(say("agent.spawn_name_hint", name));
}

/**
 * Resolve the actual executable to launch in an agent's pane for a given
 * `cli`. Honours the env var `MU_<UPPER_CLI>_COMMAND` (e.g. `MU_PI_COMMAND=
 * pi-alt` makes `--cli pi` actually exec `pi-alt`). Falls back to the cli
 * name itself, which is what users expect when their `pi` binary is on
 * `$PATH` under that exact name.
 *
 * Used by `spawnAgent` to pick the spawned command, and by reconcile's
 * orphan detector so externally-spawned panes running the resolved binary
 * are still recognised as agents.
 */
export function resolveCliCommand(cli: string): string {
  const envName = envVarNameForCli(cli);
  const override = process.env[envName];
  return override && override.trim() !== "" ? override : cli;
}

/**
 * Compute the `MU_<UPPER_CLI>_COMMAND` env var name mu consults when
 * resolving `--cli <key>`. Hyphens in the cli key become underscores
 * (env var names can't contain `-`); this matches the operator-aliases
 * convention documented in the mu skill (e.g. `--cli pi-meta` →
 * `MU_PI_META_COMMAND`).
 */
export function envVarNameForCli(cli: string): string {
  return `MU_${cli.toUpperCase().replace(/-/g, "_")}_COMMAND`;
}

/**
 * Resolve `--cli <key>` to its actual command string AND tell the
 * caller whether the resolution came from a `MU_<UPPER_CLI>_COMMAND`
 * env var or fell through to the bare cli name. The CLI uses this to
 * surface env-var attribution in the spawn-success line so config
 * issues are visible without `mu agent show`.
 */
export function resolveCliCommandWithSource(cli: string): {
  command: string;
  envVar: string;
  resolvedFromEnv: boolean;
} {
  const envVar = envVarNameForCli(cli);
  const override = process.env[envVar];
  if (override !== undefined && override.trim() !== "") {
    return { command: override, envVar, resolvedFromEnv: true };
  }
  return { command: cli, envVar, resolvedFromEnv: false };
}

// ─── Pre-flight PATH check ──
//
// Operator typo'd `mu agent spawn worker-1 --cli pi-meta` on a host
// where `pi-meta` wasn't on PATH; the spawn appeared to succeed but
// the pane died with `command not found` and the existing 1.5s
// liveness check sometimes missed it (shells stay alive past a failed
// exec). Pre-flight the PATH resolution so a typo never:
//   1. creates an orphan worktree
//   2. creates an orphan tmux pane
//   3. inserts a half-spawned DB row
// The check fires AFTER `resolveCliCommand` so `MU_<UPPER>_COMMAND`
// overrides are honoured AND the diagnostic mentions the env var by
// name. Hookable via `setCommandResolverForTests` so the test suite
// can simulate "binary present" / "binary absent" without polluting
// the real PATH.

export interface CommandResolutionResult {
  ok: boolean;
  /** First whitespace-separated token of the command — the binary
   *  whose presence on PATH we checked. */
  binary: string;
  /** Absolute path of the resolved binary on PATH, when ok=true. */
  resolvedPath?: string;
}

export type CommandResolver = (command: string) => Promise<CommandResolutionResult>;

const execFileP = promisify(execFile);

/** Default resolver: shell-out to `command -v <binary>` (POSIX-portable
 *  equivalent of `which`). Returns ok=false when the lookup exits
 *  non-zero. Always returns the parsed `binary` field so the typed
 *  error can quote what we actually searched for. */
async function defaultCommandResolver(command: string): Promise<CommandResolutionResult> {
  const binary = parseFirstToken(command);
  if (binary === "") return { ok: false, binary };
  try {
    // `command -v` is the POSIX builtin lookup. Spawned via /bin/sh
    // -c so the builtin is available (it's not an external program).
    const { stdout } = await execFileP("/bin/sh", ["-c", `command -v -- ${shellQuote(binary)}`], {
      env: process.env,
    });
    const resolvedPath = stdout.trim();
    if (resolvedPath === "") return { ok: false, binary };
    return { ok: true, binary, resolvedPath };
  } catch {
    return { ok: false, binary };
  }
}

/** Single-quote a token for /bin/sh -c. Only used on the binary name,
 *  which `parseFirstToken` already restricted to a non-whitespace run
 *  — no embedded single-quotes expected. Escape defensively anyway. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** First whitespace-separated token of a command string ("pi-meta
 *  --no-solo" → "pi-meta"). Returns "" on an empty / whitespace-only
 *  input. */
function parseFirstToken(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "") return "";
  const match = trimmed.match(/^\S+/);
  return match ? match[0] : "";
}

let activeCommandResolver: CommandResolver = defaultCommandResolver;

/** Override the PATH resolver. Tests use this to simulate "binary
 *  absent" / "binary present" without depending on what's actually
 *  installed. Production callers should never touch this. */
export function setCommandResolverForTests(resolver: CommandResolver): void {
  activeCommandResolver = resolver;
}

/** Restore the default PATH resolver. */
export function resetCommandResolverForTests(): void {
  activeCommandResolver = defaultCommandResolver;
}

/**
 * Verify the first token of `command` resolves to a binary on PATH.
 * Public so tests can call it directly; spawnAgent calls it before
 * the worktree is created so a bad --cli never creates an orphan worktree.
 */
export async function checkCommandResolvable(command: string): Promise<CommandResolutionResult> {
  return activeCommandResolver(command);
}

export interface SpawnAgentOptions {
  name: string;
  workstream: string;
  /** Defaults to "pi". Any CLI is accepted: pi is driven over its control
   *  socket; others run `MU_<CLI>_COMMAND` (or the cli name) and get
   *  text by herdr `agent prompt` (a send to them on tmux is refused). */
  cli?: string;
  /** The actual command to run in the pane. Defaults to the cli value. */
  command?: string;
  /** Window name to group this agent under. Defaults to the agent's name
   *  (so each agent gets its own window). Multiple agents sharing a `tab`
   *  share a window with multiple panes. */
  tab?: string;
  /** "full-access" (default) or "read-only". The schema stores it; today
   *  the role isn't enforced (deferred to a future capabilities pass). */
  role?: string;
  /** Initial working directory of the pane, recorded as `agents.cwd`.
   *  Defaults to the caller's cwd. Ignored when `worktree: true`: the
   *  worktree path is the cwd then. */
  cwd?: string;
  /** Override the tmux session name. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
  /** Run the agent in its own `git worktree add --detach` at
   *  `<state dir>/worktrees/<workstream>/<name>`; its path is the cwd and
   *  its base commit is recorded as `agents.base`. A root outside a git
   *  repo throws WorktreeVcsRequiredError. */
  worktree?: boolean;
  /** Commit / branch the worktree starts at (only with `worktree: true`). */
  from?: string;
  /** Repo the worktree is added to (only with `worktree: true`). Defaults
   *  to the git toplevel of the caller's cwd. */
  root?: string;
  /** Run on this host profile (`mu host add`): the pane runs the profile's
   *  `shell` template, which starts the remote pi and forwards its ctl socket
   *  here; `cwd` and `worktree` name REMOTE paths (the worktree is made by the
   *  profile's `exec`). One channel is held from before the first remote
   *  command until the pane dies. Refused on a mux that cannot run a shell
   *  command (herdr). With `host`, `root` is a REMOTE repo (default the
   *  profile's `repo`); a `worktree` needs one of them. */
  host?: string;
  /** Run the control-socket handshake for pi agents (default true).
   *  `false` skips it and reports `ctl: "skipped"`. */
  ctl?: boolean;
  /** When `name` is taken in the workstream, take the next free one
   *  (see `nextFreeAgentName`) instead of failing with AgentExistsError. */
  nextFree?: boolean;
  /** Abort (the CLI's SIGINT/SIGTERM): kills a running `git worktree add` and
   *  rolls the spawn back like a thrown error, up to its end. */
  signal?: AbortSignal;
  /**
   * Called synchronously, inside the spawn lock, the moment the agent row
   * exists for the new pane (nothing awaited between the row write and this
   * call). A durable journal of the created registry identity (`agents.id` +
   * pane): a throw rolls the spawn back like a failed finalize.
   */
  onIdentity?: (agent: AgentRow) => void;
  /** Where a local pi agent keeps its session (`PI_CODING_AGENT_SESSION_DIR`
   *  in the pane env) instead of pi's per-cwd default. Set for delegates, so
   *  their sessions stay out of the caller's `/resume` list. */
  piSessionDir?: string;
  /** Start an orchestrator (`mu orchestrate`): the pane also gets
   *  `MU_ORCHESTRATOR=1`, which keeps `mu_delegate` visible to a pi and turns
   *  off the worker-only close nudge and implicit `-w`. Local only. */
  orchestrator?: boolean;
  /** `--model`: passed to the harness through its row's model flag (spec D17). Local only. */
  model?: string;
  /** `--send`'s text: an at-start plugin kind's job.start carries it (plugins spec D8); others ignore it. */
  firstPrompt?: string;
  /**
   * A task spawn's first prompt on an at-start plugin kind (plugins spec D8 G1): its msgId (the
   * receipt's), `begin` on the placeholder before job.start (claim, journal `sending`; a throw is
   * unsent), `undo` before the rollback of a definite failure after it. Others ignore it.
   */
  firstTurn?: {
    msgId: string;
    begin: (placeholder: AgentRow) => Promise<void>;
    undo: (placeholder: AgentRow) => void;
  };
}

/** How many taken names a `nextFree` spawn skips past before it gives up. */
const NEXT_FREE_ATTEMPTS = 32;

/** How many names `nextFreeAgentName` looks up before it gives up. */
const NEXT_FREE_LOOKUPS = 1000;

/**
 * `name` when it is free in `workstream`, else the next free name: a
 * trailing `-<n>` counts up (`delegate-1` → `delegate-2`), and a name
 * without one gets `-2`, `-3`, … (`delegate-review` → `delegate-review-2`).
 * The stem is cut so a candidate stays within the 32-char name limit.
 * A name whose worktree dir is still on disk counts as taken: a dead
 * agent's worktree outlives its row (kept as evidence), and spawning
 * that name with --worktree would refuse on the dir instead of moving on.
 * Throws AgentNameExhaustedError after NEXT_FREE_LOOKUPS taken names,
 * or when no valid candidate is left (the suffix alone outgrows it).
 */
export function nextFreeAgentName(db: Db, name: string, workstream: string): string {
  const free = (n: string) =>
    getAgent(db, n, workstream) === undefined &&
    getCarrierJobByName(db, workstream, n) === undefined &&
    !existsSync(worktreePath(workstream, n));
  if (free(name)) return name;
  const m = /^(.*)-(\d+)$/.exec(name);
  const [stem, first] = m ? [m[1] ?? "", BigInt(m[2] ?? "1")] : [name, 1n];
  for (let i = 1n; i <= BigInt(NEXT_FREE_LOOKUPS); i++) {
    const suffix = `-${first + i}`;
    const candidate = `${stem.slice(0, MAX_AGENT_NAME_LEN - suffix.length)}${suffix}`;
    if (!isValidAgentName(candidate)) {
      throw new AgentNameExhaustedError(name, `no valid name left (tried ${candidate})`);
    }
    if (free(candidate)) return candidate;
  }
  throw new AgentNameExhaustedError(name, `the next ${NEXT_FREE_LOOKUPS} names are taken`);
}

/** What spawnAgent returns: the registered row plus the handshake outcome. */
export type SpawnedAgent = AgentRow & {
  ctl: SpawnCtl;
  ctlSocket: string;
  /**
   * The pi process the handshake's hello/status named. A send right after
   * the spawn carries it (`expectIncarnation`), so a replacement that binds
   * the same socket path is refused instead of handed the prompt. Absent
   * when the handshake did not run or the extension predates incarnations.
   */
  ctlIncarnation?: string;
  /** Set when the startup scan saw a Claude trust dialog parked in the pane. */
  trustDialog?: true;
  /** An at-start plugin kind's first prompt, delivered by its job.start (plugins spec D8). */
  firstSend?: SendResult;
};

/**
 * True when the agent runs pi, so the mu pi extension should answer on
 * its control socket: `cli` is "pi", or the command's argv0 basename is
 * `pi` / `pi-meta`.
 */
export function speaksMuCtl(cli: string, command: string): boolean {
  if (cli === "pi") return true;
  const argv0 = basename(parseFirstToken(command));
  return argv0 === "pi" || argv0 === "pi-meta";
}

/** The env var that asks for the pi fallback (spec D15). murmur's pi extension reads the same one. */
export const PI_CHANNEL_ENV = "MU_PI_CHANNEL";

/**
 * True when the caller asks for the pi fallback (spec D15): `MU_PI_CHANNEL=hooks`
 * spawns a local pi on tmux on the `hooks` channel, for a pi build that breaks
 * murmur's store or a native module. Only `hooks` selects it, exactly as
 * murmur's pi extension reads the variable, so the two never disagree; unset
 * or any other value, pi stays on ctl. Read at spawn only: every verb after
 * reads the agents row.
 */
export function piHooksRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PI_CHANNEL_ENV] === "hooks";
}

/**
 * Spawn a new agent in its tmux pane and register it in the DB.
 *
 * Phases:
 *   1. Validate name + uniqueness.
 *   2. If --worktree: prestageWorktree() (placeholder agent row +
 *      worktree dir + registry row).
 *   3. mux.spawnAgent() in the worktree (or opts.cwd, default the
 *      caller's cwd); the scratch session is ensured first.
 *   4. finalizeAgentRow() — patch the placeholder to the real pane id,
 *      cwd and base (worktree path), or insert a fresh agent row.
 *   5. Liveness: awaitSpawnLiveness() (fixed sleep, then pane + scan
 *      check), or for a tmux pi agent the ctl handshake with a pane
 *      check per tick and the scan at the end. A backend with
 *      `spawnAgentWaitsReady` (herdr) is ready when spawnAgent settles.
 *   6. ctl handshake for herdr pi agents (outside the rollback).
 *
 * Failure between any of (3)–(5) calls rollbackSpawn() to undo the
 * pane + row + worktree. The caller-visible error is preserved.
 */
export async function spawnAgent(db: Db, opts: SpawnAgentOptions): Promise<SpawnedAgent> {
  // A --worktree spawn that died before its pane (SIGKILL) frees its name here.
  await reclaimDeadStagings(db, opts.workstream);
  if (opts.nextFree === true) {
    // A parallel spawn can take the picked name between the pick and the
    // insert (the in-lock re-check throws before any side effect): pick again.
    for (let attempt = 1; ; attempt++) {
      const name = nextFreeAgentName(db, opts.name, opts.workstream);
      try {
        return await spawnAgent(db, { ...opts, name, nextFree: false });
      } catch (err) {
        if (!(err instanceof AgentExistsError) || attempt >= NEXT_FREE_ATTEMPTS) throw err;
      }
    }
  }
  if (!isValidAgentName(opts.name)) {
    throw new TypeError(
      `invalid agent name: ${JSON.stringify(opts.name)} (expected /^[a-z][a-z0-9_-]{0,31}$/)`,
    );
  }
  // A torn-down workstream takes no new agents. Refuse BEFORE any side
  // effect (worktree, session, pane): the failure would otherwise surface at
  // insertAgent, after the pane exists.
  const tornDownAt = tornDownAtOf(db, opts.workstream);
  if (tornDownAt !== null) throw new WorkstreamTornDownError(opts.workstream, tornDownAt);
  // Per-workstream uniqueness check: v5 allows the same agent name in
  // different workstreams. Scope the existence check to the spawn's
  // workstream so two operators spawning 'worker-1' in wsA and wsB
  // both succeed. A fast path only:
  // a parallel spawn of the same name can pass it too, so the check is
  // repeated inside the spawn lock, and insertAgent maps the UNIQUE
  // violation to AgentExistsError as the last line.
  if (getAgent(db, opts.name, opts.workstream) !== undefined) {
    throw new AgentExistsError(opts.name);
  }
  // The name fence, for every spawn (lease or not): a carrier_jobs reservation of the
  // name (an unstopped job, or a launch whose job is unknown) refuses before any effect.
  // Repeated inside the spawn lock, and atomically by every agent-row insert.
  refuseReserved(db, opts.workstream, opts.name);

  const session = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const windowName = opts.tab ?? opts.name;
  const cli = opts.cli ?? "pi";
  const resolved = resolveCliCommandWithSource(cli);
  // A host whose job kind is a plugin's takes the plugin spawn path (plugins spec D8).
  const pluginHost = opts.host === undefined ? undefined : resolveHost(db, opts.host);
  const pluginKind = pluginHost === undefined ? undefined : pluginKindOf(pluginHost);
  if (pluginHost !== undefined && pluginKind !== undefined) {
    return spawnPluginAgent(db, opts, pluginHost, pluginKind, spawnerFromEnv());
  }
  // A remote command runs on the host: the local PATH and local
  // $MU_<CLI>_COMMAND knobs say nothing about it.
  // Admission (below) re-reads it inside the transaction that counts the cap:
  // from then on the ADMITTED snapshot is the one every template runs from.
  let profile = opts.host === undefined ? undefined : await requireHostSpawn(db, opts);
  // A command gate: decided here, before any effect, and recorded on its row.
  const gateToken = isCommandGate(opts) ? newGateToken() : undefined;
  if (gateToken !== undefined && opts.worktree) {
    throw new HostProfileError(
      "--worktree cannot be used with a remote command gate (--host with a non-pi --command): a gate runs in --cwd, else the profile's default repo",
    );
  }
  if (profile) assertLeaseSpawnable(profile, gateToken !== undefined);
  // A lease spawn reserves the name in carrier_jobs BEFORE any effect: from here until a
  // stop (or an abandon) the reservation is the durable pointer to whatever job its
  // carrier may dispatch, and every other spawn of the name refuses.
  const reservation =
    profile?.transport === "lease"
      ? await reserveLeaseJob(db, opts.workstream, opts.name, profile)
      : undefined;
  // The ADMITTED snapshot is checked again: a lease spawn runs from a lease profile only.
  const leaseCheck = (p: HostProfile): void => {
    assertLeaseSpawnable(p, gateToken !== undefined);
    if ((p.transport === "lease") !== (reservation !== undefined)) {
      throw new HostProfileError(say("carrier.transport_changed", p.name));
    }
    if (reservation !== undefined) setCarrierJobStop(db, reservation.token, p.stop ?? "");
  };
  const command = opts.command ?? (profile ? cli : resolved.command);
  // Where `command` came from. Backends that resolve the executable
  // themselves may not silently ignore an operator's choice, and need to
  // know WHICH knob to name (see `SpawnAgentPaneOptions.commandSource`).
  const commandSource =
    opts.command !== undefined
      ? "explicit"
      : !profile && resolved.resolvedFromEnv
        ? "env"
        : "cli-key";

  // Pre-flight PATH resolution. Catches `--cli does-not-exist` (and
  // typos in `MU_<UPPER>_COMMAND` overrides) before any side effect.
  // See `checkCommandResolvable` / `AgentSpawnCliNotFoundError` for
  // the rationale; in short: prevents orphan worktrees + orphan
  // panes + half-spawned DB rows on a typo.
  //
  // We do NOT pre-flight an explicit `--command "..."` value: the
  // operator who passed --command gave us the literal string they
  // want spawned (often a wrapper like `pi-meta --no-solo` whose
  // first token IS on PATH but with arg-quoting that the resolver
  // would mis-parse; or a shell snippet like `bash -lc '...'`). For
  // those, the existing post-spawn liveness check is the safety net.
  if (opts.command === undefined && !profile) {
    const check = await checkCommandResolvable(command);
    if (!check.ok) {
      throw new AgentSpawnCliNotFoundError(cli, check.binary, envVarNameForCli(cli));
    }
  }

  // Who is spawning: read from the PARENT's env, before the child's env
  // below replaces it, and recorded by both row writes (placeholder insert
  // and finalize). Never guessed from task ownership.
  const spawner = spawnerFromEnv();

  // Worktree pre-stage. See `prestageWorktree` for the ordering
  // rationale. Yields the worktree (its path is the pane's cwd) or
  // undefined when --worktree wasn't requested.
  let staged: StagedWorktree | undefined;
  // A remote spawn holds its channel lease from here until the pane dies
  // (bound to the agent's id + pane when the row exists): reserved BEFORE any
  // remote command, so every exec below rides it and a full host refuses now.
  let lease: HostLease | undefined;
  let site: RemoteSite | undefined;
  try {
    if (profile) {
      ({ lease, profile, staged, site } = await admitRemoteSpawn(
        db,
        opts,
        cli,
        spawner,
        profile,
        leaseCheck,
        reservation?.token,
      ));
      // The resolved path, before any pane: another agent's managed tree or a recovery's is
      // refused here, and again with the row's insert (an owner may land meanwhile).
      if (site) refuseOwnedRemotePath(db, opts, profile.name, site.cwd, gateToken && opts.command);
    } else if (opts.worktree) {
      staged = await prestageWorktree(db, opts, cli, spawner);
    }
  } catch (err) {
    if (lease !== undefined) releaseHostChannel(db, lease); // no pane was ever opened under it
    // Nothing was launched under the reservation: its creator releases it.
    if (reservation !== undefined) releaseLeaseReservation(db, reservation.token, "none");
    emitSpawnFailed(db, opts, "worktree", err);
    throw err;
  }
  // Without a worktree the pane starts in --cwd, else the caller's cwd,
  // and the row records it. A remote agent's cwd is a REMOTE path: the
  // local pane never starts in it.
  const paneCwd = staged?.path ?? site?.cwd ?? resolve(opts.cwd ?? process.cwd());
  // A lease pane runs a carrier: it holds no channel, and its handle fills the reservation.
  const carrier = reservation !== undefined ? { token: reservation.token } : undefined;

  // Inject identity env vars into the pane so anything running inside
  // (pi extensions, claim-protocol scripts, status segments) can branch
  // on 'I am a mu-managed worker' without scraping pane titles or DB
  // lookups. Set via tmux `-e KEY=VALUE` (per-pane; doesn't pollute the
  // tmux server's global env).
  //
  // These are NOT exposed via SpawnAgentOptions — mu identity is not
  // user-tunable. Adding more keys here means every spawned pane sees
  // them automatically.
  //
  // MU_CTL_SOCK goes to every CLI (harmless for non-pi). Its directory
  // must exist before the pane starts: for a remote agent, ssh's
  // `-L <local>:<remote>` binds the LOCAL path and does not mkdir. A
  // socket file left by a previous agent of this name is removed inside
  // the spawn lock below, once this spawn owns the name, since ssh
  // refuses to bind over it.
  //
  // The base is the DB's directory: in production that is exactly
  // ctlSocketPath's own default (MU_DB_PATH dir or the state dir), and
  // a test DB in a temp dir keeps its sockets there too.
  const ctlSocket = ctlSocketPath(opts.workstream, opts.name, dirname(db.name));
  mkdirSync(dirname(ctlSocket), { recursive: true, mode: 0o700 });
  // Exactly these (plus SSH_AUTH_SOCK and piSessionDir below). tmux
  // panes inherit the tmux server's env, not ours: pin the DB and state dir this spawn used,
  // absolute and always (the default ones too), so the worker's `mu` hits
  // the same taskgraph from any cwd.
  // A remote agent's identity travels in the filled shell template (`{env}`:
  // five whitelisted variables, never the local DB, state or sync dir); the
  // local pane (the transport) is given none of it.
  // MU_AGENT_CLI names the harness the pane runs (the cli key outside the
  // blessed five); MU_ORCHESTRATOR marks an orchestrator (spec D9). Neither
  // is inherited by anything the agent spawns: every pane's env is built here.
  const harness = harnessOfCli(cli, command);
  const paneEnv: Record<string, string> = profile
    ? {}
    : {
        MU_MANAGED_AGENT: "1",
        MU_AGENT_NAME: opts.name,
        MU_WORKSTREAM: opts.workstream,
        MU_AGENT_CLI: harness ?? cli,
        ...(opts.orchestrator === true ? { MU_ORCHESTRATOR: "1" } : {}),
        [CTL_SOCK_ENV]: ctlSocket,
        MU_DB_PATH: resolve(db.name !== "" && db.name !== ":memory:" ? db.name : defaultDbPath()),
        MU_STATE_DIR: resolve(defaultStateDir()),
      };
  // pi reads its session dir from this env (its --session-dir still wins).
  // Local pi only: a remote pi has no business with a local path.
  if (!profile && opts.piSessionDir !== undefined && speaksMuCtl(cli, command)) {
    paneEnv.PI_CODING_AGENT_SESSION_DIR = resolve(opts.piSessionDir);
  }
  // mu sessions are created detached and may never be attached, so tmux's
  // update-environment never refreshes them and a pane would inherit a
  // stale SSH_AUTH_SOCK. Forward the caller's. File-type check only (is it
  // a socket?), not a liveness probe: mu stays ssh-free. Best-effort.
  const sshSock = process.env.SSH_AUTH_SOCK;
  if (sshSock) {
    try {
      if (statSync(sshSock).isSocket()) paneEnv.SSH_AUTH_SOCK = sshSock;
    } catch {
      // missing or unreadable: skip forwarding
    }
  }

  // A local hook harness on tmux starts through the anchor wrapper
  // (src/anchors.ts), so its hooks find the agent without mu's env (spec D3).
  // pi keeps its plain command: its extensions read the env in-process. Other
  // backends keep it too: herdr starts the agent kind itself, and murmur's
  // hooks have no tmux server to place a Rex pane's event through (Rex keeps
  // its `$SHELL -ic` launch).
  const anchored = (cmd: string, anchorsPanes: boolean): string => {
    if (!anchorsPanes || harness === undefined || harness === "pi") return cmd;
    pruneAnchors();
    const orchestrator = opts.orchestrator === true;
    return anchorWrapper(cmd, {
      agent_name: opts.name,
      workstream: opts.workstream,
      role: orchestrator ? "orchestrator" : "worker",
      cli: harness,
      orchestrator,
      remote_key: null,
    });
  };
  // A hook harness worker on a host (spec D11): its hooks on that node write to
  // murmur's remote area under this key (in its anchor and its env), and mu
  // reads them there through the profile's exec template (src/channels/hooks-remote.ts).
  // Fixed before the pane exists: it travels in the launch command. pi keeps ctl,
  // a command gate runs no harness.
  const remoteKey =
    profile !== undefined && gateToken === undefined && harness !== undefined && harness !== "pi"
      ? newRemoteKey(opts.workstream, opts.name)
      : undefined;
  const remoteAnchored = (cmd: string, key: string): string =>
    remoteAnchorWrapper(cmd, {
      agent_name: opts.name,
      workstream: opts.workstream,
      role: "worker",
      cli: harness ?? cli,
      orchestrator: false,
      remote_key: key,
    });

  // Spawn presets (spec D6, D17; ./spawn-presets.ts). The argv0 is untouched.
  const launch =
    gateToken !== undefined
      ? command
      : launchCommand(command, harness, opts, {
          remote: profile !== undefined,
          ...(staged !== undefined ? { worktree: staged.path } : {}),
        });

  const hasWorktree = staged !== undefined;

  // Single outer try wrapping every step that can throw AFTER the
  // worktree has been prestaged: pane create/reuse,
  // agent-row finalize, liveness check. Earlier shape had pane creation
  // outside the try, so a tmux failure (e.g. no
  // workstream session and tmux refusing to create one) left the
  // prestaged worktree + placeholder agent row behind as an
  // orphan.
  //
  // paneId is undefined until spawnAgent creates the pane; rollbackSpawn
  // skips killPane in that case. The inner try/catches that previously
  // wrapped finalize and liveness were folded into this single catch
  // (clarity > belt-and-suspenders; rollbackSpawn is idempotent and
  // best-effort regardless).
  let paneId: string | undefined;
  let agent: AgentRow;
  // Whether the agent row is this spawn's to delete on rollback. A
  // spawn that lost a same-name race must not delete the winner's row.
  let ownedIncarnation: number | undefined = staged?.incarnation;
  const wantsCtl =
    gateToken === undefined &&
    opts.ctl !== false &&
    speaksMuCtl(cli, command) &&
    defaultSpawnCtlMs() !== 0;
  let ctl: SpawnCtl | undefined;
  let ctlIncarnation: string | undefined;
  // Last phase entered, recorded in agent.spawn_failed if we roll back.
  let phase: SpawnPhase = "pane";
  let trustDialog = false;
  // Settles when the backend considers the agent started (see spawnAgentWaitsReady).
  let readiness: Promise<unknown> = Promise.resolve();
  try {
    opts.signal?.throwIfAborted();
    // Cross-process critical section: the topology check-then-act inside
    // `ensureSession` / `spawnAgent` (session exists? window exists? →
    // new-session / new-window / split-window) plus the agent-row
    // finalize. Serialised per mux SESSION so a parallel fan-out
    // (`for n in …; do mu agent spawn … & done`) can't race six
    // `new-session -d -s mu-scratch` calls into five-rolled-back-losers.
    // Keyed on the session name: spawns into different sessions never
    // contend. See spawn-lock.ts.
    //
    // The lock covers the pane's CREATION, not its readiness: spawnAgent
    // calls `onPaneCreated` the moment the pane exists, the row is
    // finalized, and the lock is released while the backend is still
    // waiting for the agent (herdr: up to 30s, past the lock's own
    // 15s acquire / 30s stale budget). The liveness wait below is
    // equally outside the lock: holding it would serialise the very
    // parallelism the operator asked for.
    //
    // The STRICT agent lock of the name wraps it (taken first, so nothing
    // holds the session lock while waiting on a name): from the name fence
    // below until the name's claim is durable (the finalized row, or a lease
    // spawn's reservation), no reservation (`reserveLeaseJob`, same lock) and
    // no close of the name can land in between, so a pane command never runs
    // under a name another owner reserved after the check. Released with the
    // spawn lock: the slow readiness wait runs with the row already written.
    const created = await withAgentLock(db, opts.workstream, opts.name, () =>
      withSpawnLock(session, async () => {
        // Re-check under the lock: a parallel spawn of the same name may
        // have inserted its row since the fast-path check. (With a
        // worktree, the placeholder row already claimed the name.)
        if (!hasWorktree && getAgent(db, opts.name, opts.workstream) !== undefined) {
          throw new AgentExistsError(opts.name);
        }
        // A staged spawn holds the name through its placeholder row, which
        // the agent lock did not cover between staging and here: a close of the
        // placeholder frees the name, and a replacement may own it (and its socket) by now.
        // Unlink only while the placeholder this spawn inserted is still the
        // row, in the same step (nothing awaited between check and unlink).
        if (staged !== undefined) {
          const cur = getAgent(db, opts.name, opts.workstream);
          if (
            cur === undefined ||
            cur.incarnation !== staged.incarnation ||
            cur.paneId !== pendingPaneIdFor(opts.name)
          ) {
            throw new AgentReplacedError(opts.name, opts.workstream);
          }
        }
        // The name fence again, under the lock (a lease spawn passes with its own token).
        refuseReserved(db, opts.workstream, opts.name, carrier?.token);
        // The name is ours: no live agent owns a socket at this path (nor, holding the
        // reservation, a job file: an earlier one's is moved aside, never deleted).
        rmSync(ctlSocket, { force: true });
        const jobFile = carrier ? claimLeaseJobFile(db, opts.workstream, opts.name) : undefined;
        const mux = await activeMux();
        // `scratch` is never `workstream init`-ed: ensure its session (with
        // the placeholder `_mu` window) so it outlives its last agent.
        if (isScratchWorkstream(opts.workstream)) await mux.ensureSession(session);
        // A remote hook harness worker is on `hooks` where the local pane is
        // one mu pastes into and murmur can relay to (tmux); elsewhere it stays on `mux`.
        const hooksKey =
          remoteKey !== undefined && mux.anchorsPanes && mux.pasteToPane !== undefined
            ? remoteKey
            : undefined;
        // The pi fallback (spec D15): a local pi on tmux, asked for with MU_PI_CHANNEL=hooks,
        // is on `hooks`. Its pane gets the variable too, so murmur's pi extension writes
        // inbox events and never opens its store. mu's extension still serves ctl (the
        // handshake below, delegates, doctor). A remote pi, a pi on herdr or Rex, and a
        // gate stay as they were: murmur's walk places events only under a tmux server.
        const piHooks =
          !profile &&
          gateToken === undefined &&
          mux.anchorsPanes &&
          mux.pasteToPane !== undefined &&
          speaksMuCtl(cli, command) &&
          piHooksRequested();
        // Every other local pi pins it empty: a tmux server a fallback spawn started holds
        // `hooks` in its global env, and a pane would inherit it, putting murmur's extension
        // in store-free mode under a row that says ctl. murmur takes only `hooks`.
        if (piHooks) paneEnv[PI_CHANNEL_ENV] = "hooks";
        else if (!profile && gateToken === undefined && speaksMuCtl(cli, command)) {
          paneEnv[PI_CHANNEL_ENV] = "";
        }
        // Built before the launch intent: a template error launches nothing.
        const paneCommand = profile
          ? remoteShellCommand(profile, {
              workstream: opts.workstream,
              name: opts.name,
              command:
                gateToken !== undefined
                  ? gateWrapper(command, gateToken)
                  : hooksKey !== undefined
                    ? remoteAnchored(launch, hooksKey)
                    : launch,
              localSock: ctlSocket,
              cwd: paneCwd,
              ...(jobFile !== undefined ? { jobFile } : {}),
              ...(hooksKey !== undefined && harness !== undefined
                ? { hooks: { cli: harness, key: hooksKey } }
                : {}),
            })
          : anchored(launch, mux.anchorsPanes);
        // Resolves with the pane id at creation; `done` settles when the
        // backend considers the agent started.
        let onCreated: (pid: string) => void = () => {};
        const createdPane = new Promise<string>((res) => {
          onCreated = res;
        });
        // From the next call on a carrier may run, even if the call rejects (tmux can start
        // the command and still fail: a hook's exit, extra output): written FIRST, so a
        // rollback never mistakes a launched carrier for none.
        if (carrier && !markCarrierLaunch(db, carrier.token)) {
          throw new Error(`carrier_jobs: reservation of ${opts.workstream}/${opts.name} is gone`);
        }
        const done = mux.spawnAgent({
          session,
          window: windowName,
          name: opts.name,
          cli,
          command: paneCommand,
          commandSource,
          ...(profile ? {} : { cwd: paneCwd }),
          env: paneEnv,
          onPaneCreated: onCreated,
          // A gate's pane outlives its command: the result is read after it ends.
          ...(gateToken !== undefined ? { retainOnExit: true } : {}),
        });
        // Observe a rejection immediately: it is awaited after the lock.
        done.catch(() => {});
        const pid = await Promise.race([createdPane, done]);
        // Capture the pane id on the OUTER scope as soon as it exists so a
        // throw later in the lock (finalizeAgentRow INSERT failure) still
        // routes through rollbackSpawn -> killPane. Assigning only via the
        // returned object meant a finalize failure left paneId undefined
        // and rollbackSpawn skipped killPane, leaking the pane.
        paneId = pid;
        if (carrier) recordCarrierPane(db, carrier.token, pid);
        readiness = done;
        phase = "finalize";
        const row = finalizeAgentRow(db, {
          opts,
          cli,
          paneId: pid,
          cwd: paneCwd,
          staged,
          // The row keeps the command as given (presets and the anchor wrapper are the launch's).
          command,
          commandSource,
          spawner,
          host: profile?.name,
          hostTransport: profile?.transport,
          gateToken,
          reservation: carrier?.token,
          // A hook harness on a backend that anchors and pastes (tmux) is on `hooks`:
          // locally, or remotely with its remote key (spec D11).
          hooks:
            (!profile || hooksKey !== undefined) &&
            mux.anchorsPanes &&
            mux.pasteToPane !== undefined &&
            harness !== undefined &&
            harness !== "pi",
          piHooks,
          ...(hooksKey !== undefined ? { remoteKey: hooksKey } : {}),
        });
        ownedIncarnation = row.incarnation;
        if (carrier && !bindCarrierJobAgent(db, carrier.token, row.incarnation, pid)) {
          throw new Error(`carrier_jobs: reservation of ${opts.workstream}/${opts.name} is gone`);
        }
        // The lease now rides this pane (registry id + pane): freed when it dies.
        if (
          lease !== undefined &&
          !bindHostChannel(db, lease, { agentId: row.incarnation, paneId: pid })
        ) {
          throw new Error(say("host.channel_lost", lease.host, lease.holder));
        }
        opts.onIdentity?.(row);
        return { pid, row, jobFile };
      }),
    );
    paneId = created.pid;
    agent = created.row;
    phase = "liveness";
    // The job handshake: mandatory for a lease, before (and independent of) ctl.
    if (carrier && profile && created.jobFile !== undefined) {
      await awaitLeaseJob(db, {
        name: opts.name,
        token: carrier.token,
        paneId: created.pid,
        profile,
        jobFile: created.jobFile,
        command,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    }
    // Liveness check: wait briefly, then verify the pane is still alive.
    // Catches the silent-spawn-failure class of bugs where the CLI dies
    // immediately (lock conflict, bad credentials, etc.). On failure,
    // surface a typed error with whatever scrollback the mux still has.
    //
    // A backend with `spawnAgentWaitsReady` (herdr) starts the agent
    // inside spawnAgent and returns only once the MUX has detected it and
    // considers it ready for input — strictly stronger than what the
    // scrollback poll can prove, so MU_SPAWN_LIVENESS_MS is subsumed and
    // deliberately not consulted. Both branches live outside the spawn
    // lock on purpose — they are the slow part (1.5s+ here, up to 30s
    // there). Either throwing routes through the same `rollbackSpawn`,
    // so a pane that never became an agent never keeps its agent row.
    //
    // A tmux pi agent skips the fixed sleep: the ctl handshake is the
    // readiness signal, so the pane check rides on each handshake tick
    // and the startup-error scan runs once the handshake ends. A
    // handshake timeout with a live, clean pane is still NOT a
    // rollback (see below). MU_SPAWN_LIVENESS_MS=0 disables the checks
    // here too.
    if ((await activeMux()).spawnAgentWaitsReady) {
      await readiness;
    } else if (wantsCtl) {
      const pid = paneId;
      const check = defaultSpawnLivenessMs() !== 0;
      const when = `during the ctl handshake (up to ${defaultSpawnCtlMs()}ms after spawn)`;
      // Capture every tick and keep the last good buffer: on real tmux
      // capture-pane fails once the pane is gone, so a capture taken
      // after the death check would always come back empty.
      let lastScrollback: string | undefined;
      const assertPaneAlive = async (): Promise<void> => {
        const mux = await activeMux();
        const sb = await mux.capture(pid, { lines: 50 }).catch(() => undefined);
        lastScrollback = sb ?? lastScrollback;
        if (await viewPresent(pid, mux)) return;
        throw new AgentDiedOnSpawnError(
          opts.name,
          pid,
          lastScrollback,
          command,
          when,
          profile?.name,
        );
      };
      const hs = await awaitCtlHandshake(
        ctlSocket,
        check ? assertPaneAlive : undefined,
        opts.signal,
      );
      ctl = hs.ctl;
      ctlIncarnation = hs.incarnation;
      // Known gap: pi binds the socket in session_start (init), before
      // it renders startup diagnostics, so an ok on the first tick can
      // scan a pane that has not printed its error yet.
      //
      // An ok handshake proves the CLI started, so only provider/auth
      // patterns apply: a shell exec-failure line in the tail is then
      // transcript text (a resumed `--session` re-renders old tool
      // output such as `grep: x: No such file or directory`).
      if (check) {
        trustDialog = await checkSpawnHealth(
          pid,
          opts.name,
          command,
          when,
          ctl === "ok",
          profile?.name,
        );
      }
    } else if (gateToken === undefined) {
      trustDialog = await awaitSpawnLiveness(paneId, opts.name, command, profile?.name);
    }
    opts.signal?.throwIfAborted();
    // A gate is not scanned for startup errors or liveness: a command that ends at
    // once is a result (the retained pane), and a dead transport reads as exit-less.
  } catch (err) {
    // Record first: a throwing cleanup must neither skip the record nor
    // mask the original error.
    emitSpawnFailed(db, opts, phase, err);
    let rolled: { gone: boolean; heldBy?: string } = { gone: false };
    try {
      rolled = await rollbackSpawn(
        db,
        opts.name,
        paneId,
        staged,
        ownedIncarnation,
        opts.workstream,
        lease,
        carrier,
      );
    } catch (cleanupErr) {
      if (err instanceof Error && err.cause === undefined) {
        try {
          err.cause = cleanupErr;
        } catch {
          // frozen error: keep original as-is
        }
      }
    }
    // An owner found at the insert (it landed while the pane opened): name that pane.
    if (err instanceof RemotePathOwnedError && err.pane === undefined && paneId !== undefined) {
      const mux = await activeMux().catch(() => undefined);
      const kill = mux === undefined ? "" : attachShellLine([mux.killPaneCommand(paneId)]);
      const pane = { id: paneId, backend: mux?.name ?? "mux", ...rolled, kill };
      const { workstream, agentName, host, cwd, owner, gate } = err;
      throw new RemotePathOwnedError(workstream, agentName, host, cwd, owner, gate, pane);
    }
    throw err;
  }
  // Control-socket handshake when the tmux path above did not run it.
  // Outside the rollback: a timeout means only control is missing; the
  // pane and pi are fine. The caller reports it (see
  // AgentCtlUnreachableError).
  if (ctl === undefined) {
    if (wantsCtl) {
      const hs = await awaitCtlHandshake(ctlSocket);
      ctl = hs.ctl;
      ctlIncarnation = hs.incarnation;
    } else ctl = "skipped";
  }
  // `agents` is machine-local (it holds pane_id), so no capture trigger
  // covers it and this emit is the ONLY record. Typed intent so it
  // renders through the same formatter as captured ops.
  emitEvent(
    db,
    opts.workstream,
    "agent.spawn",
    `agent spawn ${opts.name} (cli=${cli}, role=${opts.role ?? "full-access"}, pane=${paneId}, ctl=${ctl}${profile ? `, host=${profile.name}` : ""})`,
    await resolveActorIdentity(),
  );
  // Lint-grade stderr nudge when the operator picked a name that
  // doesn't fit the <role>-<n> smallest-unused-suffix convention. The
  // spawn already succeeded; this is advice, not an error. Done LAST
  // so the hint trails the spawn's own stdout output and so a partial
  // failure (rolled back above) never emits it.
  maybeWarnNonConventionalAgentName(opts.name);
  return {
    ...agent,
    ctl,
    ctlSocket,
    ...(ctlIncarnation !== undefined ? { ctlIncarnation } : {}),
    ...(trustDialog ? { trustDialog: true as const } : {}),
  };
}

/** A worktree spawn has made and registered. */
export interface StagedWorktree {
  path: string;
  base: string;
  root: string;
  /** The registry row's `createdAt`: rollback frees the worktree only while
   *  the row at `path` is still this one (the registry has no owner column). */
  createdAt: string;
  /** The placeholder row's incarnation: finalize and rollback act on it only. */
  incarnation: number;
  /** Set for a worktree on a REMOTE host (`path` is a remote path, `root` the repo
   *  there, absolute): rollback removes it through the profile's `exec`, never through the local registry. */
  host?: string;
}

/**
 * Stage 1 of `--worktree` spawn: claim the name with a placeholder agent
 * row, then make the worktree the pane will start in.
 *
 * Why placeholder-first? The pane starts IN the worktree, so the worktree
 * must exist before the pane, yet the name has to be claimed against a
 * parallel spawn of the same name while it is made. The agent row needs a
 * pane_id (NOT NULL), so a placeholder claims the name and the real pane
 * id is patched in later (see `PENDING_PANE_PREFIX`).
 *
 * A leftover worktree at the path is reclaimed only if it is mu's own
 * clean, unused one (`reclaimWorktreePath`); anything else refuses.
 *
 * Throws after best-effort rollback (the placeholder row, a half-made
 * worktree) when creation fails.
 */
async function prestageWorktree(
  db: Db,
  opts: SpawnAgentOptions,
  cli: string,
  spawner: string | null,
): Promise<StagedWorktree> {
  // The agent lock covers the whole staging: it reclaims, creates and
  // registers disk state that a concurrent `agent close` of this name would
  // be removing. Fail closed: a busy lock refuses the spawn before any effect.
  return withAgentLock(db, opts.workstream, opts.name, () =>
    prestageLocked(db, opts, cli, spawner),
  );
}

async function prestageLocked(
  db: Db,
  opts: SpawnAgentOptions,
  cli: string,
  spawner: string | null,
): Promise<StagedWorktree> {
  const path = worktreePath(opts.workstream, opts.name);
  const dir = opts.root ?? process.cwd();
  const top = await gitToplevel(dir);
  if (top === undefined) throw new WorktreeVcsRequiredError(dir);
  // The registry records the main checkout, even when the caller runs
  // inside a linked one (which may be removed before this worktree)...
  const root = (await owningRoot(top)) ?? top;
  // ...but the start revision is the CALLER's: HEAD (or --from) resolved in
  // the checkout it works in, not in the main one. Objects and refs are
  // shared, so the pinned sha is valid from `root`.
  const from = await git(["rev-parse", "--verify", `${opts.from ?? "HEAD"}^{commit}`], top);
  const placeholder = insertAgent(db, {
    name: opts.name,
    workstream: opts.workstream,
    cli,
    paneId: pendingPaneIdFor(opts.name),
    role: opts.role,
    tab: opts.tab ?? null,
    cwd: path,
    spawner,
  });
  let creating = false;
  try {
    const reclaimed = await reclaimWorktreePath(db, {
      agent: opts.name,
      workstream: opts.workstream,
      path,
    });
    for (const w of reclaimed) {
      emitEvent(db, opts.workstream, "agent.spawn", `agent spawn ${opts.name}: reused path: ${w}`);
    }
    creating = true; // from here anything at `path` is this staging's
    const { base } = await createWorktree({ root, path, from, signal: opts.signal });
    const createdAt = new Date().toISOString();
    registerWorktree(db, {
      path,
      agent: opts.name,
      workstream: opts.workstream,
      root,
      base,
      createdAt,
    });
    return { path, base, root, createdAt, incarnation: placeholder.incarnation };
  } catch (err) {
    try {
      if (creating) await discardWorktree(root, path); // a killed `git worktree add` leaves half
      // Only the placeholder this spawn inserted, never a replacement.
      deleteAgent(db, opts.name, opts.workstream, { incarnation: placeholder.incarnation });
    } catch {
      // best-effort: never mask the worktree error
    }
    throw err;
  }
}

/**
 * Who is calling spawn, for `agents.spawner`: `<MU_WORKSTREAM>/<MU_AGENT_NAME>`
 * for a managed agent (the pair, since a bare name repeats across
 * workstreams), else `pi:<PI_SESSION_ID>` for a pi session, else null.
 * Reads the env, not a shell: it works the same however spawn was invoked.
 */
export function spawnerFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const { MU_MANAGED_AGENT: managed, MU_WORKSTREAM: ws, MU_AGENT_NAME: name } = env;
  if (managed === "1" && ws && name) return `${ws}/${name}`;
  const session = env.PI_SESSION_ID;
  return session ? `pi:${session}` : null;
}

/**
 * Stage 2 of spawn (after the real pane exists): patch the placeholder
 * row to the real pane id, cwd and base (worktree), or insert a fresh
 * agent row (no worktree). Throws if the patch UPDATE silently affects no
 * row (the placeholder vanished mid-spawn; reconcile's pending-pane
 * prune skip guards against that).
 */
export function finalizeAgentRow(
  db: Db,
  args: {
    /** A plugin job kind's channel and its plugin (plugins spec D8, D9): recorded as is. */
    channel?: ChannelName | undefined;
    channelPlugin?: string | undefined;
    opts: SpawnAgentOptions;
    cli: string;
    paneId: string;
    cwd: string;
    staged: StagedWorktree | undefined;
    command: string;
    commandSource: CommandSource;
    spawner: string | null;
    host: string | undefined;
    /** The admitted profile's transport, recorded on the row (`agents.host_transport`). */
    hostTransport: string | undefined;
    gateToken: string | undefined;
    /** A lease spawn's reservation token: the insert passes the name fence with it. */
    reservation: string | undefined;
    /** The pane runs a hook harness (claude, codex, cursor-agent, muse) on tmux, locally or remotely. */
    hooks: boolean;
    /** The pane runs pi on the `hooks` fallback (spec D15): local, on tmux, `MU_PI_CHANNEL=hooks`. */
    piHooks: boolean;
    /** A remote hook harness worker's key on its node (spec D11). */
    remoteKey?: string;
    /** An at-start plugin spawn's placeholder with no worktree (plugins spec D8): patched, not inserted. */
    placeholder?: number;
  },
): AgentRow {
  const { opts, cli, paneId, cwd, staged, command, commandSource, spawner, host, gateToken } = args;
  const hostTransport = args.hostTransport ?? null;
  // The channel every verb reaches it through, decided once from what the pane runs:
  // pi's control socket (or, on the D15 fallback, its pane inbox), a hook harness's
  // pane inbox on tmux (local or remote), else the mux.
  const channel =
    args.channel ??
    (gateToken !== undefined
      ? "mux"
      : args.piHooks
        ? "hooks"
        : speaksMuCtl(cli, command)
          ? "ctl"
          : args.hooks
            ? "hooks"
            : "mux");
  const placeholder = staged?.incarnation ?? args.placeholder;
  if (placeholder === undefined) {
    const row: InsertAgentInput = {
      ...(args.reservation !== undefined ? { reservation: args.reservation } : {}),
      name: opts.name,
      workstream: opts.workstream,
      cli,
      paneId,
      role: opts.role,
      tab: opts.tab ?? null,
      cwd,
      command,
      commandSource,
      spawner,
      host: host ?? null,
      hostTransport,
      gateToken: gateToken ?? null,
      channel,
      channelPlugin: args.channelPlugin ?? null,
      remoteKey: args.remoteKey ?? null,
    };
    if (host === undefined) return insertAgent(db, row);
    // The remote path admission again, atomic with the row: no remote I/O in here.
    return db
      .transaction(() => {
        refuseOwnedRemotePath(db, opts, host, cwd, gateToken && opts.command);
        return insertAgent(db, row);
      })
      .immediate();
  }
  // Scope the patch to the spawn's workstream so a same-named worker
  // in another workstream isn't repointed at this pane.
  // And to the placeholder this spawn inserted (by incarnation, still
  // pending): a row replaced since is not ours to repoint.
  const patched = db
    .prepare(
      `UPDATE agents SET pane_id = ?, cwd = ?, base = ?, command = ?, command_source = ?, spawner = ?, host = ?, host_transport = ?, channel = ?, channel_plugin = ?, remote_key = ?, repo = ?, updated_at = ?
      WHERE id = ? AND pane_id = ?
        AND name = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
    )
    .run(
      paneId,
      staged?.path ?? cwd,
      staged?.base ?? null,
      command,
      commandSource,
      spawner,
      host ?? null,
      hostTransport,
      channel,
      args.channelPlugin ?? null,
      args.remoteKey ?? null,
      staged?.host !== undefined ? staged.root : null,
      new Date().toISOString(),
      placeholder,
      pendingPaneIdFor(opts.name),
      opts.name,
      opts.workstream,
    );
  const row = getAgent(db, opts.name, opts.workstream);
  if (patched.changes === 0 || !row || row.incarnation !== placeholder)
    throw new Error(`spawnAgent: agent vanished after worktree stage: ${opts.name}`);
  return row;
}

type SpawnPhase = "worktree" | "pane" | "finalize" | "liveness";

/** Terminal record for a failed spawn. Best-effort; never throws. */
function emitSpawnFailed(db: Db, opts: SpawnAgentOptions, phase: SpawnPhase, err: unknown): void {
  try {
    const errName = err instanceof Error ? err.constructor.name : typeof err;
    emitEvent(
      db,
      opts.workstream,
      "agent.spawn_failed",
      `agent spawn failed ${opts.name} (phase=${phase}, error=${errName})`,
    );
  } catch {
    // logging is best-effort
  }
}
