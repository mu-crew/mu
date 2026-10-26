// mu — shared multiplexer backend contracts and typed errors.
//
// A "mux" is the terminal multiplexer that owns panes. mu supports one
// active backend per invocation, chosen by `detectMux()` in ./detect.js.
// Everything backend-specific lives behind `MuxBackend`:
//
//   - session / window / pane topology, behind `ensureSession` and
//     `spawnAgent` (a spawn is ONE backend operation: tmux creates and
//     runs in one step, herdr creates a shell pane and starts the agent)
//   - the send protocol (herdr only: atomic `agent prompt`)
//   - scrollback capture
//   - PANE ID VALIDATION — tmux `%15` vs herdr `w1:p1`, which is why
//     there is no global pane-id regex
//
// Agent identity is `$MU_AGENT_NAME`; no backend reads or writes pane
// titles.
//
// Same shape as src/vcs/: a types module, one file per impl, and an
// index that dispatches. See docs/VOCABULARY.md § "mux backend".

import { say } from "../messages.js";
import { shellWord } from "../shell-quote.js";

/** The multiplexers mu can drive. */
export type MuxBackendName = "herdr" | "tmux";

/** Runtime states a mux backend can report directly for one pane. */
export type MuxPaneStatus = "busy" | "needs_input" | "needs_permission";

// ─── Domain types ──────────────────────────────────────────────────────
//
// Deliberately narrow: these carry only the fields mu actually reads.
// A backend that knows more about a pane keeps that to itself.

export interface MuxPane {
  /** Backend-specific stable pane id (tmux `%15`). Never a volatile index. */
  paneId: string;
  /** Current foreground command (e.g. "claude", "node", "bash"). */
  command: string;
  /** Window this pane lives in. */
  windowId?: string;
}

/** Name of the placeholder shell window every `mu-<ws>` session keeps,
 *  so the session outlives its last agent pane. */
export const MU_PLACEHOLDER_WINDOW = "_mu";

/** What `ensureSession` did. */
export interface EnsureSessionResult {
  /** The session did not exist and was created. */
  created: boolean;
  /** The session existed but its `_mu` window was missing and was re-added. */
  repaired: boolean;
}

/**
 * What `spawnAgent` needs. mu has already resolved the command it would
 * run; a backend that starts agents itself (herdr) needs both that string
 * and the `--cli` key it came from, because those select different routes.
 */
export interface SpawnAgentPaneOptions {
  /** Mux session (tmux session / herdr workspace label), e.g. `mu-auth`. */
  session: string;
  /** Window (tmux window / herdr tab) the agent's pane lives in: created
   *  when missing, otherwise the pane is split into it. */
  window: string;
  /** mu's agent name. Backends with their own agent registry use it as
   *  the mux-level handle too. */
  name: string;
  /** mu's `--cli` key, e.g. "pi". A backend that classifies agent kinds
   *  natively maps this onto its own kind vocabulary. */
  cli: string;
  /** Fully resolved command string mu would run. */
  command: string;
  /**
   * Where `command` came from. A backend that resolves the executable
   * ITSELF must not silently discard an operator's explicit choice, and
   * needs to know which one it is so the diagnostic can name the right
   * thing to change:
   *
   *   "cli-key"  — just the `--cli` value; nothing to honour, proceed.
   *   "env"      — a `MU_<UPPER_CLI>_COMMAND` override.
   *   "explicit" — an explicit `--command "…"`.
   */
  commandSource: CommandSource;
  /** Initial working directory for the pane. */
  cwd?: string;
  /** Identity and state env for the pane (tmux `-e`, herdr `--env`). */
  env: Record<string, string>;
  /**
   * Called as soon as the pane exists, before any readiness wait. The
   * caller records the pane id under its topology lock and lets the lock
   * go while a slow readiness wait (herdr: up to 30s) is still running.
   * The returned promise settles when the agent is started.
   */
  onPaneCreated?: (paneId: string) => void;
  /**
   * Keep the pane (its row and scrollback) after its command ends, armed
   * BEFORE the command can run, so an immediate exit is still readable with
   * `paneResult`. Honoured only by a backend with `paneResult`; the pane then
   * lives until `killPane`. Never changes a session or global default.
   */
  retainOnExit?: boolean;
}

/**
 * A pane's terminal result as the mux itself reports it. `exited` carries the
 * LOCAL command's status (a remote command's status is not this: see
 * src/agents/gate.ts); `code` xor `signal` is set.
 */
export type PaneResult =
  | { state: "running" }
  | { state: "exited"; code: number | null; signal: number | null }
  | { state: "absent" };

/** Where an attach should land the user. */
export interface AttachTarget {
  /** Mux session name, e.g. `mu-auth`. */
  session: string;
  /** Window inside that session (the agent's `tab`, or its name). */
  window?: string;
  /** True when the caller is already inside a client of this mux, which
   *  on tmux means `switch-client` rather than `attach-session`. */
  inside?: boolean;
  /** True when the steps are for a shell OUTSIDE any client of this mux (the line a
   *  dashboard copies): they must open a client, whatever the ambient env says.
   *  Wins over `inside` and over a backend's own env detection. */
  outside?: boolean;
}

/** One argv the caller may execute to hand the terminal to the mux. */
/** Where a spawn's command came from: the cli key itself, `MU_<CLI>_COMMAND`, or `--command`. */
export type CommandSource = "cli-key" | "env" | "explicit";

export interface MuxCommand {
  command: string;
  args: readonly string[];
  /** Best-effort step: a non-zero exit is not a failure of the attach
   *  as a whole (tmux's post-attach `select-window`, for instance). */
  optional?: boolean;
  /** Why an `optional` step may fail (shown when it does). */
  reason?: string;
}

/** What a backend can say about its own health. Deliberately DATA, not
 *  prose: `mu doctor` owns all rendering (human and --json). */
export interface MuxHealth {
  /** Backend name, echoed so doctor can label the row. */
  name: MuxBackendName;
  /** True iff the backend answered a version probe. */
  ok: boolean;
  /** Version string as the backend reports it, or null when unreachable. */
  version: string | null;
  /** Ambient env facts this backend cares about, in display order
   *  (tmux: $TMUX / $TMUX_PANE). Values are null when unset. */
  env: readonly { name: string; value: string | null }[];
  /** Remediation line shown when `ok` is false. */
  remediation: string;
}

export interface SendOptions {
  /** 0 drops herdr's `--wait` (submit and return); any other value is ignored. */
  readinessMs?: number;
  /** Called when the send could not be confirmed as submitted. */
  onUndelivered?: (warning: SendWarning) => void;
}

/** Why a send could not be confirmed as submitted. */
export interface SendWarning {
  paneId: string;
  /** 'paste-vanished' — pane looked calm, but the text never registered. */
  reason: "paste-vanished";
  message: string;
}

export interface CaptureOptions {
  /**
   * Number of trailing lines to capture. Omitted = full scrollback.
   * 0 = visible pane only.
   */
  lines?: number;
}

// ─── Attach line ───────────────────────────────────────────────────────

/**
 * One copy-pasteable shell line for `steps`, joined with `&&` so a
 * failed required step stops everything after it. An `optional` step is
 * rendered `{ step || true; }`: its own failure never fails the line
 * and never stops what follows. Callers catch what `attachCommands`
 * throws (herdr: no such workspace) and omit the line.
 */
export function attachShellLine(steps: readonly MuxCommand[]): string {
  return steps
    .map((step) => {
      const words = [step.command, ...step.args].map(shellWord).join(" ");
      return step.optional === true ? `{ ${words} || true; }` : words;
    })
    .join(" && ");
}

// ─── Errors ────────────────────────────────────────────────────────────

/**
 * Base class for "the multiplexer itself failed". Each backend
 * subclasses it (tmux → `TmuxError`) so `handle()` can map the whole
 * family to exit code 5 (substrate unavailable) with one `instanceof`.
 */
export class MuxError extends Error {
  override name: string = "MuxError";
}

/**
 * Thrown when a verb references a pane id that doesn't exist on the
 * running multiplexer. Distinct from `MuxError` (which wraps any mux
 * command failure) so callers can map it to a specific exit code
 * (`mu` maps it to 5 alongside other mux issues, but the message is
 * more actionable than raw backend stderr).
 *
 * The backend-specific half of the remediation comes from the backend
 * that raised it: showing a herdr user `tmux info | head` would be
 * worse than showing no hint at all. Callers that construct this error
 * already hold the active backend, so passing it is free; the
 * no-backend form degrades to mu's own verbs only.
 */
export class PaneNotFoundError extends Error {
  override readonly name = "PaneNotFoundError";
  constructor(
    public readonly paneId: string,
    backend?: MuxDiagnostics,
  ) {
    super(say("mux.pane_not_found", backend?.name ?? "mux", paneId));
  }
}

/** The slice of a backend `PaneNotFoundError` needs. Structural so the
 *  error type doesn't depend on the whole backend contract. */
export interface MuxDiagnostics {
  readonly name: MuxBackendName;
}

/**
 * Thrown by `detectMux()` when no supported multiplexer is available.
 * Maps to exit 5 (substrate unavailable) — the same bucket as "tmux is
 * installed but the server is unreachable", because from the caller's
 * point of view both mean "mu cannot reach a pane right now".
 */
export class NoMultiplexerError extends Error {
  override readonly name = "NoMultiplexerError";
  constructor(public readonly tried: readonly string[]) {
    super(say("mux.none_found", tried));
  }
}

// ─── The backend contract ──────────────────────────────────────────────

/**
 * One multiplexer implementation. Methods mirror the operations mu
 * actually performs; nothing is here speculatively.
 *
 * Implementations must be stateless value objects (a frozen record of
 * functions), so swapping the active backend is a pointer assignment
 * and tests can install a fake without teardown ordering hazards.
 */
export interface MuxBackend {
  readonly name: MuxBackendName;
  /** True when `spawnAgent` returns only once the MUX considers the agent
   *  ready for input (herdr's `agent start` blocks until it detects the
   *  agent). spawn.ts then skips its own liveness/readiness polling. A
   *  capability flag, never a backend-name check. */
  readonly spawnAgentWaitsReady: boolean;
  /** True when `spawnAgent` runs `opts.command` as a shell command line in
   *  the pane (tmux). herdr starts a known agent kind itself, so it cannot
   *  run a host profile's shell template (`spawn --host`). A capability
   *  flag, never a backend-name check. */
  readonly runsShellCommand: boolean;

  /** True iff this backend can drive panes on this machine right now.
   *  Consulted by `detectMux()` in precedence order. */
  available(): Promise<boolean>;

  // — pane id validation (shape is backend-specific) —
  isValidPaneId(s: string): boolean;
  assertValidPaneId(s: string): void;

  // — sessions —
  /** Create `session` with its placeholder `_mu` window when missing;
   *  re-add a missing `_mu` window to an existing one. Load-bearing:
   *  mux errors propagate. */
  ensureSession(session: string): Promise<EnsureSessionResult>;
  /** Idempotent. herdr closes the workspace and refuses (surfacing
   *  `HerdrWorkspaceGroupCloseError`) when it has linked worktree
   *  workspaces mu did not create. */
  killSession(session: string): Promise<void>;

  // — panes —
  /** Create the agent's pane (new window, or a split of the existing
   *  `opts.window`; the session is created when missing) and run the
   *  agent in it. Returns the pane id. tmux: one step running
   *  `opts.command`. herdr: a bare shell pane, then `agent start --kind`
   *  with a busy retry; refuses `commandSource` ≠ "cli-key" with
   *  `HerdrCommandOverrideError` before touching herdr and closes the
   *  bare pane when the start fails. */
  spawnAgent(opts: SpawnAgentPaneOptions): Promise<string>;
  /** Every pane in `session`. `[]` when the session (or server) is gone;
   *  any other failure throws, so a caller that prunes on absence never
   *  reads an unreachable mux as "zero panes". */
  listPanes(session: string): Promise<MuxPane[]>;
  /** False only when the mux reports the pane (or server) gone; throws
   *  when the probe itself fails, so liveness gates fail closed. */
  paneAlive(paneId: string): Promise<boolean>;
  killPane(paneId: string): Promise<void>;
  capture(paneId: string, opts?: CaptureOptions): Promise<string>;

  // — attach —
  /** Ordered argv steps that land the user on `target` (some optional,
   *  see `MuxCommand.reason`). May throw when the target cannot be
   *  resolved (herdr: no workspace carries the label). Join with
   *  `attachShellLine` for a printable line. */
  attachCommands(target: AttachTarget): Promise<readonly MuxCommand[]>;

  // — optional capabilities —
  /** The pane's runtime state as the mux itself reports it, or undefined
   *  when the pane is gone or unclassified. herdr only: for non-pi agents. */
  paneStatus?(paneId: string): Promise<MuxPaneStatus | undefined>;
  /** tmux only: whether the pane runs, exited (a retained pane: `retainOnExit`)
   *  or is gone. Unlike `paneAlive` (handle existence), an exited pane is NOT
   *  running here. Throws when the probe itself fails: unknown, never a result. */
  paneResult?(paneId: string): Promise<PaneResult>;
  /** herdr only: atomic `agent prompt`. tmux has no reliable paste (cut in
   *  mu-next), so callers branch on the method's presence, never on
   *  `mux.name`, and refuse when it is absent. */
  sendToPane?(paneId: string, text: string, opts?: SendOptions): Promise<void>;
  /** The argv steps that type pi's `/reload` into `paneId` from outside, for
   *  an agent whose extension cannot take `/reload` over ctl. herdr only
   *  (its `agent prompt`); tmux has no reliable paste, so it omits this and
   *  callers branch on presence. */
  reloadCommands?(paneId: string): readonly MuxCommand[];

  /**
   * Name of the session the CALLER is running inside, or undefined when
   * outside one.
   * @deprecated scope fallback, removed by the -w unit.
   */
  currentSessionName(): Promise<string | undefined>;
  /** Version + ambient facts for `mu doctor`. Never throws: an
   *  unreachable backend reports `ok: false`. */
  healthCheck(): Promise<MuxHealth>;
}
