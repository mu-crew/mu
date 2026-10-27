// mu — spawnAgent + supporting helpers (resolveCliCommand,
// awaitSpawnLiveness, defaultSpawnLivenessMs,
// prestageWorktree, finalizeAgentRow, rollbackSpawn).
//
// spawnAgent's flow is documented inline. The interesting bit is the
// `--worktree` cycle (the pane starts IN the worktree, so the worktree
// exists before the pane, while the agent name must already be claimed) —
// see prestageWorktree.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  type AgentRow,
  deleteAgent,
  getAgent,
  insertAgent,
  isValidAgentName,
  MAX_AGENT_NAME_LEN,
  pendingPaneIdFor,
} from "../agents.js";
import { type CtlProbe, ctlProbe } from "../ctl/client.js";
import { CTL_SOCK_ENV, ctlSocketPath } from "../ctl/path.js";
import {
  type Db,
  defaultDbPath,
  defaultStateDir,
  tornDownAtOf,
  WorkstreamTornDownError,
} from "../db.js";
import {
  admitHostChannel,
  bindHostChannel,
  getHost,
  type HostLease,
  type HostProfile,
  HostProfileError,
  HostSpawnUnsupportedError,
  releaseHostChannel,
  releaseHostChannelsForAgent,
} from "../hosts.js";
import { emitEvent } from "../logs.js";
import { say } from "../messages.js";
import type { CommandSource } from "../mux/types.js";
import { activeMux } from "../mux.js";
import { isJsonMode } from "../output.js";
import {
  localPaneAlive,
  prepareRemote,
  type RemoteSite,
  remoteShellCommand,
  removeRemoteWorktree,
} from "../remote-agent.js";
import { recoveriesFor } from "../remote-recovery.js";
import { resolveActorIdentity } from "../tasks/claim.js";
// `sleep` is the shared poll-sleep TEST SEAM (setSleepForTests), not a
// multiplexer operation, so it stays on the tmux module rather than
// joining the MuxBackend contract.
import { sleep } from "../tmux.js";
import { discardWorktree, git, gitToplevel, owningRoot } from "../vcs/git.js";
import { isScratchWorkstream } from "../workstream.js";
import {
  createWorktree,
  getWorktreeAt,
  reclaimWorktreePath,
  registerWorktree,
  releaseWorktree,
  WorktreeVcsRequiredError,
  worktreePath,
} from "../worktree.js";
import {
  AgentDiedOnSpawnError,
  AgentExistsError,
  AgentNameExhaustedError,
  AgentReplacedError,
  AgentSpawnCliNotFoundError,
  AgentSpawnStartupError,
} from "./errors.js";
import { gateWrapper, newGateToken } from "./gate.js";
import { withAgentLock } from "./lock.js";
import { withSpawnLock } from "./spawn-lock.js";
import { reclaimDeadStagings } from "./staging.js";

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
   *  command (herdr), and with `root` (a local repo). */
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
    getAgent(db, n, workstream) === undefined && !existsSync(worktreePath(workstream, n));
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

/** Outcome of the spawn-time control-socket handshake. */
export type SpawnCtl = "ok" | "missing" | "refused" | "skipped";

/** A ctl probe's outcome as spawn reports it. */
export function probeToSpawnCtl(kind: CtlProbe["kind"]): Exclude<SpawnCtl, "skipped"> {
  return kind === "ok" ? "ok" : kind === "missing" ? "missing" : "refused";
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

/**
 * True when a REMOTE spawn is a command gate, not a worker: an explicit
 * `--command` that is not pi. An explicit `--cli pi` and a `pi` / `pi-meta`
 * argv0 stay workers (an opaque wrapper around pi needs `--cli pi`). Decided
 * before any effect; `--cli` omitted classifies by the command alone, so
 * `--host dev --command 'npm test'` is a gate even though `cli` defaults to pi.
 */
export function isCommandGate(opts: { host?: string; cli?: string; command?: string }): boolean {
  if (opts.host === undefined || opts.command === undefined) return false;
  if (opts.cli === "pi") return false;
  const argv0 = basename(parseFirstToken(opts.command));
  return argv0 !== "pi" && argv0 !== "pi-meta";
}

/**
 * Handshake budget in ms after the agent is live. 0 disables. Override
 * via `MU_SPAWN_CTL_MS`.
 */
export function defaultSpawnCtlMs(): number {
  const raw = process.env.MU_SPAWN_CTL_MS;
  if (raw === undefined) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 30_000;
  return parsed;
}

/** Cadence of `onMiss` (pane-alive check + capture: ~2 forks per call). */
const CTL_POLL_INTERVAL_MS = 250;
/** Cadence of the socket-path stat, which costs no fork. */
const CTL_STAT_INTERVAL_MS = 50;

/** Clock + sleep the ctl handshake runs on. Real by default. */
interface HandshakeClock {
  now(): number;
  delay(ms: number): Promise<void>;
}
let handshakeClock: HandshakeClock = { now: () => Date.now(), delay: (ms) => delay(ms) };

/** TEST SEAM: drive the handshake on a virtual clock so deadline timing is counted, not elapsed. */
export function setHandshakeClockForTests(clock: HandshakeClock): void {
  handshakeClock = clock;
}

export function resetHandshakeClockForTests(): void {
  handshakeClock = { now: () => Date.now(), delay: (ms) => delay(ms) };
}

/**
 * Poll the control socket until the extension answers or the budget
 * runs out. Returns the last probe outcome. The socket path is stat'd
 * every ~50 ms and probed as soon as it exists, so readiness is seen
 * within ~50 ms of pi binding it. `onMiss` (the pane-alive check) keeps
 * its 250 ms cadence plus one final check at the deadline, and may
 * throw to abort (the pane died); otherwise this never throws. Uses the
 * `handshakeClock` (real by default), not the `sleep` seam: tests stub
 * that to a no-op, which would turn this into a busy loop.
 */
async function awaitCtlHandshake(
  sock: string,
  onMiss?: () => Promise<void>,
  signal?: AbortSignal,
): Promise<{ ctl: Exclude<SpawnCtl, "skipped">; incarnation?: string }> {
  const budgetMs = defaultSpawnCtlMs();
  const deadline = handshakeClock.now() + budgetMs;
  let last: Exclude<SpawnCtl, "skipped"> = "missing";
  let lastMissAt = Number.NEGATIVE_INFINITY;
  let first = true;
  for (;;) {
    signal?.throwIfAborted();
    if (first || existsSync(sock)) {
      first = false;
      const remaining = deadline - handshakeClock.now();
      const probe = await ctlProbe(
        sock,
        Math.max(1, Math.min(remaining, CTL_POLL_INTERVAL_MS * 4)),
      );
      if (probe.kind === "ok") {
        return {
          ctl: "ok",
          ...(probe.incarnation !== undefined ? { incarnation: probe.incarnation } : {}),
        };
      }
      last = probeToSpawnCtl(probe.kind);
    }
    // The final check at the deadline always runs, throttle or not: a pane
    // that dies in the last <250 ms keeps the scrollback onMiss captured.
    const atDeadline = handshakeClock.now() >= deadline;
    if (onMiss && (atDeadline || handshakeClock.now() - lastMissAt >= CTL_POLL_INTERVAL_MS)) {
      lastMissAt = handshakeClock.now();
      await onMiss();
    }
    const left = deadline - handshakeClock.now();
    if (left <= 0) return { ctl: last };
    await handshakeClock.delay(Math.min(CTL_STAT_INTERVAL_MS, left));
  }
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

  const session = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const windowName = opts.tab ?? opts.name;
  const cli = opts.cli ?? "pi";
  const resolved = resolveCliCommandWithSource(cli);
  // A remote command runs on the host: the local PATH and local
  // $MU_<CLI>_COMMAND knobs say nothing about it.
  // Admission (below) re-reads it inside the transaction that counts the cap:
  // from then on the ADMITTED snapshot is the one every template runs from.
  let profile = opts.host === undefined ? undefined : await requireHostSpawn(db, opts);
  // A command gate: decided here, before any effect, and recorded on its row.
  const gateToken = isCommandGate(opts) ? newGateToken() : undefined;
  if (gateToken !== undefined && opts.worktree) {
    throw new HostProfileError(
      "--worktree cannot be used with a remote command gate (--host with a non-pi --command): a gate runs in the profile's repo or --cwd",
    );
  }
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
      ({ lease, profile } = await admitHostChannel(
        db,
        profile.name,
        `spawn:${opts.workstream}/${opts.name}`,
        { paneAlive: localPaneAlive },
      ));
      if (opts.worktree) staged = await prestageRemote(db, opts, cli, spawner, lease, profile);
      else
        site = await prepareRemote(db, lease, profile, {
          workstream: opts.workstream,
          name: opts.name,
          worktree: false,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        });
    } else if (opts.worktree) {
      staged = await prestageWorktree(db, opts, cli, spawner);
    }
  } catch (err) {
    if (lease !== undefined) releaseHostChannel(db, lease); // no pane was ever opened under it
    emitSpawnFailed(db, opts, "worktree", err);
    throw err;
  }
  // Without a worktree the pane starts in --cwd, else the caller's cwd,
  // and the row records it. A remote agent's cwd is a REMOTE path: the
  // local pane never starts in it.
  const paneCwd = staged?.path ?? site?.cwd ?? resolve(opts.cwd ?? process.cwd());

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
  // Exactly these six (plus SSH_AUTH_SOCK below). tmux panes inherit the
  // tmux server's env, not ours: pin the DB and state dir this spawn used,
  // absolute and always (the default ones too), so the worker's `mu` hits
  // the same taskgraph from any cwd.
  // A remote agent's identity travels in the filled shell template (`{env}`:
  // five whitelisted variables, never the local DB, state or sync dir); the
  // local pane (the transport) is given none of it.
  const paneEnv: Record<string, string> = profile
    ? {}
    : {
        MU_MANAGED_AGENT: "1",
        MU_AGENT_NAME: opts.name,
        MU_WORKSTREAM: opts.workstream,
        [CTL_SOCK_ENV]: ctlSocket,
        MU_DB_PATH: resolve(db.name !== "" && db.name !== ":memory:" ? db.name : defaultDbPath()),
        MU_STATE_DIR: resolve(defaultStateDir()),
      };
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
    const created = await withSpawnLock(session, async () => {
      // Re-check under the lock: a parallel spawn of the same name may
      // have inserted its row since the fast-path check. (With a
      // worktree, the placeholder row already claimed the name.)
      if (!hasWorktree && getAgent(db, opts.name, opts.workstream) !== undefined) {
        throw new AgentExistsError(opts.name);
      }
      // A staged spawn holds the name through its placeholder row, which
      // the agent lock no longer covers: a close of the placeholder frees
      // the name, and a replacement may own it (and its socket) by now.
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
      // The name is ours: no live agent owns a socket at this path.
      rmSync(ctlSocket, { force: true });
      const mux = await activeMux();
      // `scratch` is never `workstream init`-ed: ensure its session (with
      // the placeholder `_mu` window) so it outlives its last agent.
      if (isScratchWorkstream(opts.workstream)) await mux.ensureSession(session);
      // Resolves with the pane id at creation; `done` settles when the
      // backend considers the agent started.
      let onCreated: (pid: string) => void = () => {};
      const createdPane = new Promise<string>((res) => {
        onCreated = res;
      });
      const done = mux.spawnAgent({
        session,
        window: windowName,
        name: opts.name,
        cli,
        command: profile
          ? remoteShellCommand(profile, {
              workstream: opts.workstream,
              name: opts.name,
              command: gateToken === undefined ? command : gateWrapper(command, gateToken),
              localSock: ctlSocket,
              cwd: paneCwd,
            })
          : command,
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
      readiness = done;
      phase = "finalize";
      const row = finalizeAgentRow(db, {
        opts,
        cli,
        paneId: pid,
        cwd: paneCwd,
        staged,
        command,
        commandSource,
        spawner,
        host: profile?.name,
        gateToken,
      });
      ownedIncarnation = row.incarnation;
      // The lease now rides this pane (registry id + pane): freed when it dies.
      if (
        lease !== undefined &&
        !bindHostChannel(db, lease, { agentId: row.incarnation, paneId: pid })
      ) {
        throw new Error(say("host.channel_lost", lease.host, lease.holder));
      }
      opts.onIdentity?.(row);
      return { pid, row };
    });
    paneId = created.pid;
    agent = created.row;
    phase = "liveness";
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
        if (await mux.paneAlive(pid)) return;
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
    try {
      await rollbackSpawn(db, opts.name, paneId, staged, ownedIncarnation, opts.workstream, lease);
    } catch (cleanupErr) {
      if (err instanceof Error && err.cause === undefined) {
        try {
          err.cause = cleanupErr;
        } catch {
          // frozen error: keep original as-is
        }
      }
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
  /** Set for a worktree on a REMOTE host (`path` is a remote path, `root` the profile's repo
   *  there): rollback removes it through the profile's `exec`, never through the local registry. */
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
    await reclaimWorktreePath(db, { agent: opts.name, workstream: opts.workstream, path });
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

/** The profile `--host` names, once the spawn is known to be runnable on it. Nothing is touched. */
async function requireHostSpawn(db: Db, opts: SpawnAgentOptions): Promise<HostProfile> {
  const host = opts.host ?? "";
  const profile = getHost(db, host);
  if (opts.root !== undefined) {
    throw new HostProfileError(
      "--root names a local repo and cannot be used with --host (the worktree is made in the profile's --repo)",
    );
  }
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
): Promise<StagedWorktree> {
  return withAgentLock(db, opts.workstream, opts.name, async () => {
    const placeholder = insertAgent(db, {
      name: opts.name,
      workstream: opts.workstream,
      cli,
      paneId: pendingPaneIdFor(opts.name),
      role: opts.role,
      tab: opts.tab ?? null,
      cwd: null,
      spawner,
      host: profile.name,
    });
    try {
      const made = await prepareRemote(db, lease, profile, {
        workstream: opts.workstream,
        name: opts.name,
        worktree: true,
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        // An unused leftover of a prepare whose answer was lost is taken over;
        // never while a removed agent's recovery record may name that tree.
        reclaim: !recoveriesFor(db, opts.workstream, opts.name).some(
          (r) => r.host === profile.name,
        ),
      });
      return {
        path: made.cwd,
        base: made.base ?? "",
        root: profile.repo,
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
function finalizeAgentRow(
  db: Db,
  args: {
    opts: SpawnAgentOptions;
    cli: string;
    paneId: string;
    cwd: string;
    staged: StagedWorktree | undefined;
    command: string;
    commandSource: CommandSource;
    spawner: string | null;
    host: string | undefined;
    gateToken: string | undefined;
  },
): AgentRow {
  const { opts, cli, paneId, cwd, staged, command, commandSource, spawner, host, gateToken } = args;
  if (staged === undefined) {
    return insertAgent(db, {
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
      gateToken: gateToken ?? null,
    });
  }
  // Scope the patch to the spawn's workstream so a same-named worker
  // in another workstream isn't repointed at this pane.
  // And to the placeholder this spawn inserted (by incarnation, still
  // pending): a row replaced since is not ours to repoint.
  const patched = db
    .prepare(
      `UPDATE agents SET pane_id = ?, cwd = ?, base = ?, command = ?, command_source = ?, spawner = ?, host = ?, updated_at = ?
      WHERE id = ? AND pane_id = ?
        AND name = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
    )
    .run(
      paneId,
      staged.path,
      staged.base,
      command,
      commandSource,
      spawner,
      host ?? null,
      new Date().toISOString(),
      staged.incarnation,
      pendingPaneIdFor(opts.name),
      opts.name,
      opts.workstream,
    );
  const row = getAgent(db, opts.name, opts.workstream);
  if (patched.changes === 0 || !row || row.incarnation !== staged.incarnation)
    throw new Error(`spawnAgent: agent vanished after worktree stage: ${opts.name}`);
  return row;
}

/**
 * Roll back a failed spawn. Idempotent and best-effort: every step
 * swallows its own errors so a partial-cleanup substrate (already-killed
 * pane, no agent row) never masks the original failure.
 *
 * `paneId` is `undefined` when spawnAgent itself threw before returning a
 * pane id — there's nothing to kill. `staged` is set when prestageWorktree
 * succeeded: once the pane is proven gone, the worktree this spawn made goes
 * through the close rule (`releaseWorktree`; its pane may have worked in it):
 * clean and merged is removed, commits are kept on `mu/<ws>/<name>-<sha12>`
 * first, and dirty files or a writer keep the tree and its registry row for
 * `mu agent close <name>`; each outcome but the plain removal is logged. A pane NOT proven gone
 * keeps the row and the worktree (the row rule): `mu agent close` finishes
 * them once it is. deleteAgent is idempotent (no-op on a missing row).
 *
 * `ownedIncarnation` is undefined when the spawn failed before inserting
 * its own row (e.g. it lost a same-name race); the row then belongs to
 * another agent and is left alone. Otherwise only that incarnation is
 * deleted, never a replacement under the same name.
 */
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

export async function rollbackSpawn(
  db: Db,
  name: string,
  paneId: string | undefined,
  staged: StagedWorktree | undefined,
  ownedIncarnation: number | undefined,
  workstream: string,
  /** The spawn's host channel lease, while it is still the reservation (before or after its bind). */
  lease?: HostLease,
): Promise<void> {
  // Is the pane (the host transport) proven gone? A channel is freed only on that proof.
  let paneGone = paneId === undefined;
  if (paneId !== undefined) {
    // Best-effort: rollback runs on an already-failing path and must not
    // mask the original error, even if the mux itself went away.
    const mux = await activeMux().catch(() => undefined);
    // The mux is in hand before the check, and the kill is issued in the
    // same step: a row of another incarnation on this very pane id (a
    // replacement that reused it) means the pane is no longer ours.
    // A pane id registered to ANY other incarnation (any name, any
    // workstream) is not ours either: leave it alone and say so.
    const foreign = db
      .prepare("SELECT 1 FROM agents WHERE pane_id = ? AND id IS NOT ? LIMIT 1")
      .get(paneId, ownedIncarnation ?? null);
    if (foreign === undefined) {
      await mux?.killPane(paneId).catch(() => {});
      paneGone = mux !== undefined && (await mux.paneAlive(paneId).catch(() => true)) === false;
    } else {
      paneGone = true; // another agent holds the id: ours is not that pane

      try {
        emitEvent(
          db,
          workstream,
          "agent.spawn_failed",
          `agent spawn rollback ${name}: pane ${paneId} now belongs to another agent, left alone`,
        );
      } catch {
        // best-effort
      }
    }
  }
  if (paneGone) {
    try {
      if (lease !== undefined) releaseHostChannel(db, lease);
      if (paneId !== undefined && ownedIncarnation !== undefined) {
        releaseHostChannelsForAgent(db, ownedIncarnation, paneId);
      }
    } catch {
      // best-effort: the next admission reclaims a channel whose pane is dead
    }
  }
  // The remote tree this rollback proved gone: the row's delete then owes no recovery record.
  let remoteGone = false;
  if (staged?.host !== undefined) {
    // A worktree on a remote host: its own exec, under its own channel, once
    // the pane's is free. Only while the name is still this spawn's.
    const remote = staged;
    try {
      if (!paneGone) throw new Error("pane not proven gone");
      await withAgentLock(db, workstream, name, async () => {
        const cur = getAgent(db, name, workstream);
        if (cur !== undefined && cur.incarnation !== remote.incarnation) return;
        remoteGone = await removeRemoteWorktree(
          db,
          remote.host ?? "",
          `rollback:${workstream}/${name}`,
          remote,
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
  } else if (staged !== undefined && paneGone) {
    // Only once the pane is proven gone: a surviving pane may be running in
    // the tree (the row is kept below, so `mu agent close` finishes it).
    // The worker may have worked before the spawn failed: the tree goes
    // through the close rule, never a forced removal. Commits are kept on a
    // branch first; dirty files or a writer keep the tree and its registry
    // row (the record `mu agent close` finishes).
    const say = (what: string): void => {
      try {
        emitEvent(db, workstream, "agent.spawn_failed", `agent spawn rollback ${name}: ${what}`);
      } catch {
        // best-effort
      }
    };
    try {
      // Under the agent lock, and only while the name is still this spawn's
      // (or gone) AND the registry row at the path is the one this spawn
      // wrote: a replacement staged there, or a newer orphan, owns it now.
      await withAgentLock(db, workstream, name, async () => {
        const cur = getAgent(db, name, workstream);
        if (cur !== undefined && cur.incarnation !== staged.incarnation) return;
        const reg = getWorktreeAt(db, staged.path);
        if (reg !== undefined && (reg.createdAt !== staged.createdAt || reg.base !== staged.base))
          return;
        const done = await releaseWorktree(
          db,
          reg ?? { ...staged, agent: name, workstream, lastCollectedHead: null },
        );
        if (done.action === "kept-branch")
          say(`worktree ${staged.path} had commits; kept on branch ${done.branch}, tree removed`);
        for (const w of done.warnings ?? []) say(w);
      });
    } catch (err) {
      const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
      say(
        `worktree ${staged.path} kept (${why}); once handled: mu agent close ${name} -w ${workstream}`,
      );
    }
  }
  // A row whose pane is not proven gone is kept (the row rule, as in close),
  // with its worktree: the pane may still run in it. A host row's death would
  // also free the channel the live pane (the transport) holds.
  if (ownedIncarnation !== undefined && !paneGone) {
    try {
      emitEvent(
        db,
        workstream,
        "agent.spawn_failed",
        `agent spawn rollback ${name}: pane ${paneId} not proven gone, row${staged === undefined ? "" : " and worktree"}${getAgent(db, name, workstream)?.host ? " and host channel" : ""} kept; once it is gone: mu agent close ${name} -w ${workstream}`,
      );
    } catch {
      // best-effort
    }
    return;
  }
  // Only the row this spawn inserted: never a replacement under the name. A remote
  // tree this rollback removed (or found gone) leaves no `remote_recovery` record:
  // the record is for a worktree someone must still deal with.
  if (ownedIncarnation !== undefined)
    deleteAgent(db, name, workstream, { incarnation: ownedIncarnation }, { preserve: !remoteGone });
}

/**
 * Default liveness window in milliseconds. 0 disables the check (useful
 * for fast tests that don't want to wait). Override via env var
 * `MU_SPAWN_LIVENESS_MS`.
 */
export function defaultSpawnLivenessMs(): number {
  const raw = process.env.MU_SPAWN_LIVENESS_MS;
  if (raw === undefined) return 1500;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 1500;
  return parsed;
}

/**
 * Curated list of patterns that indicate the spawned CLI hit a fatal
 * provider/auth error during startup and is now parked at an error
 * prompt instead of becoming a working agent.
 *
 * Kept short and case-insensitive on purpose: every entry must match a
 * real, observed dogfood failure mode. Don't add patterns speculatively
 * — the false-positive cost is to roll back a healthy spawn, which the
 * operator then has to re-attempt without the scan (`MU_SPAWN_LIVENESS_MS=0`).
 *
 * Mitigation against scrollback noise from harmless prior-session text:
 * `checkSpawnHealth` only scans the LAST `STARTUP_ERROR_TAIL_LINES`
 * lines of the capture, and after an ok ctl handshake it skips
 * `EXEC_FAILURE_PATTERN` (a resumed pi session re-renders old tool
 * output, which often ends in `No such file or directory`).
 */
const AUTH_ERROR_PATTERNS: readonly RegExp[] = [
  /No API key found for [\w-]+/i,
  /Error: invalid API key/i,
  /Authentication failed/i,
  /401 Unauthorized/i,
  /Could not authenticate/i,
];

/**
 * The spawned command failed to exec: post-spawn detection of the
 * "binary not found at exec time" failure mode. The pre-flight check
 * above catches the common typo BEFORE any side effect, but a few
 * edge cases still slip through and only surface in the pane:
 *   - `--command "..."` skips the pre-flight (operator opt-out).
 *   - PATH inside the spawned shell differs from PATH in mu's
 *     process (login shell rc files, /etc/paths.d, etc.).
 *   - Race: binary on PATH at spawn time, gone 1.5s later.
 *
 * Anchored to lines that LOOK like a shell error rather than prose
 * mentioning the marker:
 * require the marker at end-of-line, optionally followed by a single
 * `: <name>` token (the zsh form: `zsh: command not found: pi-meta`).
 * This still trips the canonical cases —
 *   `bash: pi-meta: command not found`
 *   `zsh: command not found: pi-meta`
 *   `sh: pi-meta: No such file or directory`
 * — but rejects banner prose like
 *   `I noticed earlier you saw 'command not found'`
 *   `type \`mu\` — command not found? install with …`
 * that previously triggered a full spawn rollback. The pre-flight
 * PATH check remains the deterministic safety net for typo'd `--cli`.
 */
const EXEC_FAILURE_PATTERN =
  /^(?:.*: )?(?:command not found|No such file or directory)(?::\s*\S+)?$/i;

/**
 * Number of trailing lines of the post-liveness scrollback to scan for
 * the startup-error patterns. The capture is `lines: 50`; tailing the last
 * 30 keeps the scan focused on the spawned CLI's own startup output
 * (the pane is brand-new, so anything earlier than that is the shell
 * banner / our own command-line, both safe).
 */
const STARTUP_ERROR_TAIL_LINES = 30;

/**
 * Scan the tail of a freshly-captured pane buffer for known startup-
 * failure patterns. Returns the matched line on first hit, or undefined
 * if the buffer is clean. `cliStarted` (the CLI answered the ctl
 * handshake) drops the exec-failure pattern: the CLI demonstrably ran.
 *
 * Exported for the test suite; not part of the SDK surface.
 */
export function detectSpawnStartupError(
  scrollback: string,
  cliStarted = false,
): string | undefined {
  const patterns = cliStarted
    ? AUTH_ERROR_PATTERNS
    : [...AUTH_ERROR_PATTERNS, EXEC_FAILURE_PATTERN];
  const lines = scrollback.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - STARTUP_ERROR_TAIL_LINES));
  for (const line of tail) {
    for (const pattern of patterns) {
      if (pattern.test(line)) return line;
    }
  }
  return undefined;
}

async function awaitSpawnLiveness(
  paneId: string,
  agentName: string,
  command: string,
  host?: string,
): Promise<boolean> {
  const ms = defaultSpawnLivenessMs();
  if (ms === 0) return false;
  await sleep(ms);
  return checkSpawnHealth(paneId, agentName, command, undefined, false, host);
}

/**
 * Claude's "Is this a project you trust?" dialog, recorded from claude
 * 2.1.x (test/fixtures/claude-trust-dialog.txt). It is unnumbered and
 * defaults to "No, exit", so the Enter that ends a send makes claude
 * quit. Matched on the short option line, which survives line wraps.
 *
 * NOT an error: the pane and agent are kept, so this is a warning that
 * spawn reports and that skips the initial --send. Startup scan only: it
 * does not protect a later `mu agent send`, and the herdr spawn path
 * never runs this scan. No keypress is ever sent for the operator.
 */
const CLAUDE_TRUST_DIALOG = /Yes, I trust this folder/i;

/** True when the tail of `scrollback` shows Claude's folder-trust dialog. */
export function detectClaudeTrustDialog(scrollback: string): boolean {
  const lines = scrollback.split(/\r?\n/);
  const tail = lines.slice(Math.max(0, lines.length - STARTUP_ERROR_TAIL_LINES));
  return tail.some((line) => CLAUDE_TRUST_DIALOG.test(line));
}

/**
 * One liveness verdict: throw AgentDiedOnSpawnError when the pane is
 * gone, AgentSpawnStartupError when its scrollback tail shows a known
 * startup failure. Returns true (non-fatal) when Claude's trust dialog is
 * showing.
 */
async function checkSpawnHealth(
  paneId: string,
  agentName: string,
  command: string,
  /** When the failure happened, for the error text; default: the liveness window. */
  when?: string,
  /** The CLI answered the ctl handshake; see detectSpawnStartupError. */
  cliStarted = false,
  /** The host profile the pane's transport reaches, when remote. */
  host?: string,
): Promise<boolean> {
  // Capture-pane first so we have something to attach to the error if the
  // pane is in the process of being torn down (the buffer survives a beat
  // longer than the pane's existence in some tmux builds).
  const mux = await activeMux();
  const scrollback = await mux.capture(paneId, { lines: 50 }).catch(() => undefined);
  if (!(await mux.paneAlive(paneId))) {
    throw new AgentDiedOnSpawnError(agentName, paneId, scrollback, command, when, host);
  }
  // Pane is alive — but "alive" doesn't mean "working". Scan the tail of
  // the capture for known provider/auth startup errors. The pane stays at
  // an error prompt forever otherwise, and the orchestrator only
  // discovers the dud minutes later when `mu task wait` stalls.
  if (scrollback !== undefined) {
    const matchedLine = detectSpawnStartupError(scrollback, cliStarted);
    if (matchedLine !== undefined) {
      throw new AgentSpawnStartupError(agentName, paneId, matchedLine, scrollback, when);
    }
    return detectClaudeTrustDialog(scrollback);
  }
  return false;
}
