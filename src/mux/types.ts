// mu — shared multiplexer backend contracts and typed errors.
//
// A "mux" is the terminal multiplexer that owns panes. mu supports one
// active backend per invocation, chosen by `detectMux()` in ./detect.js.
// Everything backend-specific lives behind `MuxBackend`:
//
//   - session / window / pane topology, behind `ensureSession` and
//     `spawnAgent` (a spawn is ONE backend operation: create the pane and
//     run the command in one step)
//   - the send protocol (Rex: paste + Enter; tmux: clear, paste + Enter
//     for the `hooks` channel)
//   - scrollback capture
//   - PANE ID VALIDATION — tmux `%15`, Rex `block:<uuid>`, which is why
//     there is no global pane-id regex (retired herdr `w1:p1` rows: src/mux/binding.ts)
//
// Agent identity is `$MU_AGENT_NAME`; no backend reads or writes pane
// titles.
//
// Same shape as src/vcs/: a types module, one file per impl, and an
// index that dispatches. See docs/VOCABULARY.md § "mux backend".

import { say } from "../messages.js";
import { shellWord } from "../shell-quote.js";
import type { ActionPaneRef, PaneRef, VerifiedPaneRef } from "./pane-ref.js";

/** The multiplexers mu can drive. */
export type MuxBackendName = "rex" | "tmux";

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
 * The crew identity murmur derives a pane's driver from: tmux reads the pane's
 * `@mu_agent` / `@mu_workstream` / `@mu_role` options; Rex reads the block's label
 * (the agent) and its session's label (`mu-<workstream>`). `role` is a tmux pane
 * option; on Rex the pane's pi reports it as the OSC 7501 `mu/role` record.
 */
export interface CrewIdentity {
  agent: string;
  workstream: string;
  role?: string;
}

/** A pane's crew identity as read (`""` for unset). */
export interface CrewTags extends CrewIdentity {
  /** tmux: the server identity it was read on (pane ids restart per server). */
  server?: string;
  /** Rex: the session's raw label (the workstream is `""` when it is not `mu-<ws>`). */
  sessionLabel?: string;
}

/** The crew roles `@mu_role` holds. */
export const CREW_ROLES = ["worker", "orchestrator"] as const;

/** The tmux pane options of a crew identity (a role defaults to `worker`). */
export function crewPaneOptions(id: CrewIdentity): Record<string, string> {
  return {
    "@mu_agent": id.agent,
    "@mu_workstream": id.workstream,
    "@mu_role": id.role ?? "worker",
  };
}

/** What `spawnAgent` needs. mu has already resolved the command it would run. */
export interface SpawnAgentPaneOptions {
  /** Mux session (tmux session / Rex session), e.g. `mu-auth`. */
  session: string;
  /** Window (tmux window / Rex tab) the agent's pane lives in: created
   *  when missing, otherwise the pane is split into it. */
  window: string;
  /** mu's agent name. Backends with their own agent registry use it as
   *  the mux-level handle too. */
  name: string;
  /** mu's `--cli` key, e.g. "pi". */
  cli: string;
  /** Fully resolved command string mu would run. */
  command: string;
  /** Initial working directory for the pane. */
  cwd?: string;
  /** Pane-scoped user options (`@mu_agent`, ...) to set on the new pane. tmux only. */
  paneOptions?: Record<string, string>;
  /** Called with a warning line when `paneOptions` could not be set: the pane lives on
   *  untagged (murmur shows it as a human's pane until `mu agent retag`). tmux only. */
  onTagFailure?: (warning: string) => void;
  /** Identity and state env for the pane (tmux `-e`). */
  env: Record<string, string>;
  /**
   * Called as soon as the pane exists, before any readiness wait. The
   * caller records the pane id under its topology lock and lets the lock
   * go before the spawn settles.
   */
  onPaneCreated?: (paneId: string, identity?: string) => void;
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
  /** Stable target for an agent attach on tmux (a legacy row's: unverified). Session-only attaches have no pane. */
  pane?: PaneRef;
}

export type SessionKillTarget =
  | { backend: "tmux"; session: string; pane: PaneRef }
  | { backend: "rex"; session: string };

/**
 * The pane option naming the host a remote worker runs on, set on its local
 * pane. That pane holds only the ssh client, so murmur, which owns the row of
 * the pane, would otherwise call the worker local (it reads this to say where).
 */
export const MU_HOST_PANE_OPTION = "@mu_host";

/** Label `paneId` with the host its worker runs on. Best effort: a backend
 *  without pane options, or a failed set, leaves the pane unlabelled. */
export async function markPaneHost(
  mux: MuxBackend,
  pane: ActionPaneRef,
  host: string,
): Promise<void> {
  try {
    await mux.setPaneOption?.(pane, MU_HOST_PANE_OPTION, host);
  } catch {
    // presentation only: the worker runs the same without it
  }
}

/** Where a spawn's command came from: the cli key itself, `MU_<CLI>_COMMAND`, or `--command`. */
export type CommandSource = "cli-key" | "env" | "explicit";

/** One argv the caller may execute to hand the terminal to the mux. */
export interface MuxCommand {
  command: string;
  args: readonly string[];
  /** Best-effort step: a non-zero exit is not a failure of the attach
   *  as a whole (tmux's post-attach `select-window`, for instance). */
  optional?: boolean;
  /** Why an `optional` step may fail (shown when it does). */
  reason?: string;
  /** A client deliberately nested inside another tmux server's client: run it with
   *  `$TMUX` removed (tmux refuses to nest otherwise). The shell line spells it `env -u TMUX`. */
  nested?: boolean;
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
  /** tmux only: set when the server is vtmux (OSC 7501 pane state). */
  vtmux?: { version: string; programStatus: boolean };
  /** Ambient env facts this backend cares about, in display order
   *  (tmux: $TMUX / $TMUX_PANE). Values are null when unset. */
  env: readonly { name: string; value: string | null }[];
  /** Remediation line shown when `ok` is false. */
  remediation: string;
}

export interface SendOptions {
  /** Called when the send could not be confirmed as submitted. */
  onUndelivered?: (warning: SendWarning) => void;
}

/** Why a send could not be confirmed as submitted. */
export interface SendWarning {
  paneId: string;
  /**
   * 'unconfirmed' — the paste was made, but no hook event confirmed that the
   * agent took it (the `hooks` channel); it is never resent.
   */
  reason: "unconfirmed";
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
 * throws and omit the line.
 */
export function attachShellLine(steps: readonly MuxCommand[]): string {
  return steps
    .map((step) => {
      const words = [
        ...(step.nested === true ? ["env", "-u", "TMUX"] : []),
        step.command,
        ...step.args,
      ]
        .map(shellWord)
        .join(" ");
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
 * A row's pane is a retired herdr pane (`w1:p1`): no backend mu drives can read,
 * send to, kill or probe it, so it is neither alive nor dead. Every pane-addressed
 * verb refuses with this; only `mu agent close --force` drops such a row.
 */
export class RetiredPaneError extends MuxError {
  override name = "RetiredPaneError";
  constructor(
    public readonly paneId: string,
    public readonly agentName?: string,
    public readonly workstream?: string,
  ) {
    super(say("mux.retired_pane", paneId, agentName, workstream));
  }
}

/**
 * Thrown when a verb references a pane id that doesn't exist on the
 * running multiplexer. Distinct from `MuxError` (which wraps any mux
 * command failure) so callers can map it to a specific exit code
 * (`mu` maps it to 5 alongside other mux issues, but the message is
 * more actionable than raw backend stderr).
 *
 * The backend-specific half of the remediation comes from the backend
 * that raised it: showing a Rex user `tmux info | head` would be
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
  /** True when a hook harness's pane starts through the anchor wrapper
   *  (src/anchors.ts, spec D3): murmur's hooks place an event through the
   *  tmux server the pane belongs to, so only tmux panes have a reader.
   *  A capability flag, never a backend-name check. */
  readonly anchorsPanes: boolean;
  /** True when a lease carrier or a plugin job's view (a carrier job's dispatcher) may run
   *  here: the backend binds each reply to the server instance that gave it, so a view's
   *  birth and absence are proven on its own server (tmux: the acting call reports it).
   *  Rex is false until its replies carry their instance (rex_plugin_views_instance_bound).
   *  Read only by `refuseCarrierViewMux` and `proveViewGone`.
   *  A capability flag, never a backend-name check. */
  readonly carrierViews: boolean;

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
  /** Idempotent. tmux requires proof of a recorded pane in the session
   * and returns false if it refused the kill or the session was already gone. */
  killSession(target: SessionKillTarget): Promise<boolean>;

  // — panes —
  /** Create the agent's pane (new window, or a split of the existing
   *  `opts.window`; the session is created when missing) and run the
   *  agent in it, one step running `opts.command`. Returns the pane id. */
  spawnAgent(opts: SpawnAgentPaneOptions): Promise<string>;
  /** Every pane in `session`. `[]` when the session (or server) is gone;
   *  any other failure throws, so a caller that prunes on absence never
   *  reads an unreachable mux as "zero panes". */
  listPanes(session: string): Promise<MuxPane[]>;
  /** False only when the mux reports the pane (or server) gone; throws
   *  when the probe itself fails, so liveness gates fail closed. */
  paneAlive(pane: string | VerifiedPaneRef): Promise<boolean>;
  killPane(pane: ActionPaneRef): Promise<void>;
  /** The argv an operator runs by hand to do the same guarded kill (for a diagnostic
   *  naming a pane mu could not prove gone). */
  killPaneCommand(pane: ActionPaneRef): MuxCommand;
  capture(pane: ActionPaneRef, opts?: CaptureOptions): Promise<string>;

  // — attach —
  /** Ordered argv steps that land the user on `target` (some optional,
   *  see `MuxCommand.reason`). May throw when the target cannot be
   *  resolved. Join with
   *  `attachShellLine` for a printable line. */
  attachCommands(target: AttachTarget): Promise<readonly MuxCommand[]>;

  // — optional capabilities —
  /** tmux only: set a user option (`@name`) on one pane, for a reader such
   *  as murmur that looks the pane up by id (MU_HOST_PANE_OPTION). */
  setPaneOption?(pane: ActionPaneRef, name: string, value: string): Promise<void>;
  /** tmux and Rex: the crew identity of every live pane, keyed by pane id, in one
   *  batched read (tmux: one `list-panes -a`; Rex: one block listing per session).
   *  Empty when no server runs; throws when the read fails. */
  readCrewTags?(): Promise<Map<string, CrewTags>>;
  /** tmux and Rex: write the crew identity on one pane (tmux: the `@mu_*` options in one
   *  guarded call; Rex: the block label). Throws on failure. A Rex session label is the
   *  workstream's, never changed per pane. */
  writeCrewTags?(pane: ActionPaneRef, tags: CrewIdentity): Promise<void>;
  /** The pane's runtime state as the mux itself reports it, or undefined
   *  when the pane is gone or unclassified. vtmux and Rex (the program's
   *  OSC 7501 report): for non-pi agents. */
  paneStatus?(paneId: string): Promise<MuxPaneStatus | undefined>;
  /** tmux and Rex: whether the pane runs, exited (a retained pane: `retainOnExit`)
   *  or is gone. Unlike `paneAlive` (handle existence), an exited pane is NOT
   *  running here. Throws when the probe itself fails: unknown, never a result. */
  paneResult?(pane: string | VerifiedPaneRef): Promise<PaneResult>;
  /** tmux (`#{pane_pid}`) and Rex: the pid of the pane's first process, so a
   *  caller can tell the agent's own processes from others; undefined when
   *  the pane is gone. Throws when the probe itself fails. */
  panePid?(pane: string | VerifiedPaneRef): Promise<number | undefined>;
  /** tmux: the identity of the server mu drives (`<pid>|<start time>`), or undefined when
   *  no server runs. Pane ids restart at `%0` per server, so a recorded pane is the agent's
   *  only while this equals the identity recorded at spawn. Rex: the server's `instance_id`
   *  (a new one per server run). Throws when the probe fails. */
  serverIdentity?(): Promise<string | undefined>;
  /** tmux and Rex: the pane asked of the server `identity` names (`serverIdentity`), and only
   *  of it. `foreign`: another server, or none, answered, so the answer proves nothing about
   *  the pane. tmux checks the server in the same call that looks for the pane; Rex reads its
   *  instance before and after the lookup. Throws when the probe fails. */
  paneOnServer?(paneId: string, identity: string): Promise<"present" | "absent" | "foreign">;
  /** Rex: a paste event, then Enter. The `mux`
   *  channel's send. tmux has none: its paste is `pasteToPane`, which only the
   *  `hooks` channel uses, because only there does a hook event confirm it.
   *  Callers branch on the method's presence, never on `mux.name`, and refuse
   *  when it is absent. */
  sendToPane?(paneId: string, text: string, opts?: SendOptions): Promise<void>;
  /** tmux only: clear the input line with `clearKey` (a tmux key name, e.g.
   *  `C-u`), paste `text` as one bracketed paste, then submit it with Enter.
   *  The paste itself is unconfirmed: the `hooks` channel (src/channels/hooks.ts)
   *  confirms it by the harness's `run_count`, and never resends. */
  pasteToPane?(
    pane: ActionPaneRef,
    text: string,
    opts?: { clearKey?: string | null },
  ): Promise<void>;
  /** tmux only: type `keys` into the pane, as tmux key names (`Enter`, `Escape`)
   *  or, with `literal`, as text. `mu agent answer` answers a dialog with it. */
  sendKeys?(
    pane: ActionPaneRef,
    keys: readonly string[],
    opts?: { literal?: boolean },
  ): Promise<void>;

  /**
   * Name of the session the CALLER is running inside, or undefined when
   * outside one.
   * Suggestion only (the no-scope hint, the TUI start workstream); never routes a verb.
   */
  currentSessionName(): Promise<string | undefined>;
  /** Version + ambient facts for `mu doctor`. Never throws: an
   *  unreachable backend reports `ok: false`. */
  healthCheck(): Promise<MuxHealth>;
}
