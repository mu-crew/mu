// mu — tmux substrate.
//
// Single source of truth for all tmux interactions. Every tmux invocation
// goes through `tmux(args)`, which wraps child_process and produces structured
// `TmuxError`s carrying args + stderr.
//
// tmux has no `sendToPane`, so the `mux` channel refuses a send on tmux. It
// has `pasteToPane` (clear the input line, one bracketed paste, Enter) and
// `sendKeys`, which only the `hooks` channel (src/channels/hooks.ts) uses: a
// paste cannot confirm itself, and there the harness's own hook event does.
// pi agents use the control socket (src/channels/ctl-deliver.ts); herdr has
// its own atomic `agent prompt`.

import { basename } from "node:path";
import { execFileCapture } from "../exec-file.js";
import { insideAgent } from "../harnesses.js";
import { say } from "../messages.js";
import { shellQuote, shellWord } from "../shell-quote.js";
import {
  type ActionPaneRef,
  PANE_ID_RE,
  type PaneRef,
  paneRef,
  requireVerifiedPane,
  SERVER_IDENTITY_RE,
  TmuxPaneBirthError,
  tmuxPaneTarget,
  type VerifiedPaneRef,
} from "./pane-ref.js";
import {
  type AttachTarget,
  type CaptureOptions,
  type EnsureSessionResult,
  MU_PLACEHOLDER_WINDOW,
  type MuxBackend,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxPaneStatus,
  PaneNotFoundError,
  type PaneResult,
  type SessionKillTarget,
  type SpawnAgentPaneOptions,
} from "./types.js";

// Re-exported so the historical `import { ... } from "./tmux.js"` surface
// keeps resolving these names.
export {
  type AttachTarget,
  type CaptureOptions,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  PANE_ID_RE,
  PaneNotFoundError,
  paneRef,
};

/** Back-compat alias: tmux-specific name predating the MuxBackend extraction. */
export type TmuxPane = MuxPane;

// ─── Error type ────────────────────────────────────────────────────────

export class TmuxError extends MuxError {
  constructor(
    public readonly args: readonly string[],
    public readonly stderr: string,
    public readonly stdout: string,
    public readonly exitCode: number | null,
  ) {
    const detail = stderr.trim() || stdout.trim() || "no output";
    super(say("mux.tmux_failed", args, exitCode, detail));
    this.name = "TmuxError";
  }
}

/**
 * Thrown instead of starting a tmux server from inside an agent (a mu-managed
 * one, or any harness whose sandbox marker env is set). A server's panes
 * inherit the server's sandbox, not the client's, so a server born in an
 * agent would run every later agent in that agent's sandbox (spec D10). A
 * running server is used as is; only the no-server path refuses.
 */
export class TmuxServerInAgentError extends MuxError {
  override name = "TmuxServerInAgentError";
  constructor() {
    super(say("mux.tmux_no_server_in_agent"));
  }
}

// ─── Pane ID validation ────────────────────────────────────────────────

/**
 * Stable tmux pane IDs are of the form `%N` (e.g. "%15"). They never change
 * for the lifetime of the pane. **Pane indexes** (0, 1, 2…) are volatile and
 * shift when other panes close — never store or pass them.
 */
export function isValidPaneId(s: string): boolean {
  return PANE_ID_RE.test(s);
}

export function assertValidPaneId(s: string): void {
  if (!isValidPaneId(s)) {
    throw new TypeError(`invalid tmux pane id: ${JSON.stringify(s)} (expected /^%\\d+$/)`);
  }
}

// ─── Executor (swappable for tests) ────────────────────────────────────

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type TmuxExecutor = (args: readonly string[]) => Promise<TmuxExecResult>;

/**
 * Optional global-flag prefix to splice in front of every tmux args
 * vector. When `MU_TMUX_SOCKET=<name>` is set, this returns
 * `["-L", name, "-f", "/dev/null"]`:
 *
 *   `-L <name>` routes every call through a private tmux server with
 *   the given socket name (Linux: `/tmp/tmux-<uid>/<name>`,
 *   macOS: `$TMPDIR/tmux-<uid>/<name>`) instead of the user's default
 *   `/tmp/tmux-<uid>/default`. Set by the test harness so the integration suite
 *   can never observe — or contaminate — the user's interactive
 *   tmux server.
 *
 *   `-f /dev/null` skips the user's `~/.tmux.conf`. This matters
 *   because tmux auto-starts the server on the first client call if
 *   none is running (e.g. after a test’s last `kill-session`
 *   shuts the server down). A typical user config uses `run-shell`
 *   for status-bar plugins (TPM, hostname/network probes), and each
 *   such hook adds ~1–4s to that auto-start. Without `-f /dev/null`
 *   a single integration test grows from 3s to 48s on a configured
 *   dev box. The suite drives tmux through the documented protocol,
 *   not through bound keys, so the user's config is irrelevant.
 *
 * Read fresh on every call so a setupFiles hook that mutates
 * `process.env.MU_TMUX_SOCKET` mid-run takes effect immediately.
 *
 * The test suite sets this; a user may too (docs/reference/env.md).
 */
function tmuxGlobalFlags(): readonly string[] {
  const socket = process.env.MU_TMUX_SOCKET;
  if (socket === undefined || socket.length === 0) return [];
  return ["-L", socket, "-f", "/dev/null"];
}

const realExecutor: TmuxExecutor = (args) =>
  execFileCapture("tmux", [...tmuxGlobalFlags(), ...args]);

let currentExecutor: TmuxExecutor = realExecutor;

/**
 * Install a custom executor (for tests). Returns the previous executor so
 * tests can restore it cleanly. Production code should never call this.
 */
export function setTmuxExecutor(executor: TmuxExecutor): TmuxExecutor {
  const previous = currentExecutor;
  currentExecutor = executor;
  return previous;
}

/** Restore the real (child_process-backed) executor. */
export function resetTmuxExecutor(): void {
  currentExecutor = realExecutor;
}

/**
 * Run an arbitrary tmux command. The single point of contact with the
 * tmux binary; every higher-level operation in this module goes through it.
 *
 * Throws `TmuxError` on non-zero exit. Returns stdout on success.
 */
export async function tmux(args: readonly string[]): Promise<string> {
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    throw new TmuxError([...args], result.stderr, result.stdout, result.exitCode);
  }
  return result.stdout;
}

// ─── Pane refs: one identity check, in the tmux call that acts ──────────

// A verified ref's action runs on the recorded server, inside the same tmux
// invocation as the identity check. A legacy row's bare id (no recorded
// server) acts unguarded: the check mu made before the column.
/** What an action's tmux call targets: a verified ref (guarded) or a legacy row's bare id. */
type PaneTarget = string | VerifiedPaneRef;

/** A legacy (unverified) ref acts on its bare id; a verified one only on its server. */
function paneTarget(ref: PaneRef): PaneTarget {
  const checked = tmuxPaneTarget(ref);
  return checked.kind === "verified" ? checked : checked.paneId;
}

/** Exit status of the guard's else branch: the server answering is not the recorded one. */
const FOREIGN_SERVER_EXIT = 97;

/** tmux strips indentation and comments after a physical newline even inside quotes. */
function tmuxCommandWord(arg: string): string {
  // Let tmux decode the LF after lexing, without expanding the rest of the word.
  return arg.includes("\n") ? arg.split("\n").map(shellQuote).join('"\\n"') : shellWord(arg);
}

/**
 * `args` run only on the server a verified `ref` names (a bare id: any server); optionally
 * require its pane still in `session`. With neither condition, `args` run as they are.
 */
function guardedArgs(ref: PaneTarget, args: readonly string[], session?: string): string[] {
  return guardedCommands(ref, [args], session);
}

/**
 * `guardedArgs` for a command sequence, run in one tmux invocation. The `;`
 * between commands is emitted bare, so tmux splits on it; a `;` inside a
 * command (a literal key) stays quoted, so it does not.
 */
function guardedCommands(
  ref: PaneTarget,
  commands: readonly (readonly string[])[],
  session?: string,
): string[] {
  const paneId = typeof ref === "string" ? ref : ref.paneId;
  const server = typeof ref === "string" ? undefined : `#{==:#{pid}|#{start_time},${ref.identity}}`;
  const inSession =
    session === undefined
      ? undefined
      : `#{&&:#{==:#{pane_id},${paneId}},#{==:#{session_name},${session}}}`;
  const condition =
    server === undefined
      ? inSession
      : inSession === undefined
        ? server
        : `#{&&:${server},${inSession}}`;
  if (condition === undefined) return commands.flatMap((c, i) => (i === 0 ? [...c] : [";", ...c]));
  return [
    "if-shell",
    "-F",
    ...(session === undefined ? [] : ["-t", paneId]),
    condition,
    commands.map((c) => c.map(tmuxCommandWord).join(" ")).join(" ; "),
    `run-shell "exit ${FOREIGN_SERVER_EXIT}"`,
  ];
}

interface PaneExec extends TmuxExecResult {
  /** The guard refused: another server answers. Nothing ran. */
  foreign: boolean;
  args: string[];
  paneId: string;
}

/** Run `build(paneId)` against a pane ref, guarded on its identity when it has one. */
async function execOnPane(
  ref: PaneTarget,
  build: (paneId: string) => readonly string[],
): Promise<PaneExec> {
  return execCommandsOnPane(ref, (id) => [build(id)]);
}

/** `execOnPane` for a command sequence, guarded once, in one tmux invocation. */
async function execCommandsOnPane(
  ref: PaneTarget,
  build: (paneId: string) => readonly (readonly string[])[],
): Promise<PaneExec> {
  const paneId = typeof ref === "string" ? ref : ref.paneId;
  const args = guardedCommands(ref, build(paneId));
  const result = await currentExecutor(args);
  const foreign = typeof ref !== "string" && result.exitCode === FOREIGN_SERVER_EXIT;
  return { ...result, foreign, args, paneId };
}

/** `execOnPane` that throws like `tmux()` on failure, and `PaneNotFoundError` on another server. */
async function paneTmux(
  ref: PaneRef,
  build: (paneId: string) => readonly string[],
): Promise<string> {
  return paneTmuxCommands(ref, (id) => [build(id)]);
}

/** `paneTmux` for a command sequence that must run together or not at all. */
async function paneTmuxCommands(
  ref: PaneRef,
  build: (paneId: string) => readonly (readonly string[])[],
): Promise<string> {
  const r = await execCommandsOnPane(paneTarget(ref), build);
  if (r.foreign) throw new PaneNotFoundError(r.paneId);
  if (r.exitCode !== 0) throw new TmuxError(r.args, r.stderr, r.stdout, r.exitCode);
  return r.stdout;
}

// ─── Sleep helper (testable) ──────────────────────────────────────────

let currentSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setSleepForTests(
  impl: (ms: number) => Promise<void>,
): (ms: number) => Promise<void> {
  const previous = currentSleep;
  currentSleep = impl;
  return previous;
}

export function resetSleep(): void {
  currentSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-aware sleep — honours `setSleepForTests`. Public so other modules
 *  (notably `agents.ts` for spawn liveness polling) get free no-op-ing in
 *  tests without re-implementing the swap. */
export function sleep(ms: number): Promise<void> {
  return currentSleep(ms);
}

// ─── Sessions ──────────────────────────────────────────────────────────

/**
 * The `-t` form that names session `name` EXACTLY. A bare `-t mu-auth`
 * falls back to prefix matching, so it resolves to `mu-auth-refactor`
 * when `mu-auth` does not exist, and a teardown of workstream `auth`
 * kills another workstream's session. `=` disables the prefix and
 * pattern fallback. The trailing `:` makes it a session target for
 * pane- and window-scoped verbs too: `list-panes -s -t =mu-auth`
 * still prefix-matches through the pane lookup, but
 * `-t =mu-auth:` does not (verified on tmux 3.7c).
 */
function exactSessionTarget(name: string): string {
  return `=${name}:`;
}

/**
 * stderr shapes that mean "no tmux server is running", so there is no
 * session, window or pane to find. tmux prints "no server running on
 * <path>" when the socket file exists but nothing listens, and "error
 * connecting to <path> (No such file or directory)" when the socket file
 * does not exist at all (fresh boot, cleared /tmp, new TMUX_TMPDIR).
 * Other "error connecting" causes, such as permission denied, stay
 * real errors.
 */
const NO_SERVER_RE = /no server running|error connecting to .*\(No such file or directory\)/i;

/** `has-session`: the session exists, is missing, or no server answers at all. */
async function sessionState(name: string): Promise<"exists" | "missing" | "no-server"> {
  const result = await currentExecutor(["has-session", "-t", exactSessionTarget(name)]);
  if (result.exitCode === 0) return "exists";
  return NO_SERVER_RE.test(result.stderr) ? "no-server" : "missing";
}

/**
 * Whether `session` exists, refusing (TmuxServerInAgentError) when it does not
 * because no server runs and this process is inside an agent: the
 * `new-session` that follows would start the server here.
 */
async function sessionExistsOrMayStart(name: string): Promise<boolean> {
  const state = await sessionState(name);
  if (state === "no-server" && insideAgent()) throw new TmuxServerInAgentError();
  return state === "exists";
}

/**
 * A detached session otherwise gets tmux's default-size (80x24), so
 * `mu agent read` captures wrap at 80. Never resize-window: it pins
 * window-size to manual.
 */
const DETACHED_SIZE = ["-x", "200", "-y", "50"];

// In tmux 3.8 a literal tab in a format becomes `_`. Use `|` after fixed
// fields; for free-form names and commands keep the entire final field.
/** `[id, name]` of every window in `session`. */
async function listWindows(session: string): Promise<{ id: string; name: string }[]> {
  const out = await tmux([
    "list-windows",
    "-t",
    exactSessionTarget(session),
    "-F",
    "#{window_id}|#{window_name}",
  ]);
  const windows: { id: string; name: string }[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [id, ...name] = line.split("|");
    if (!id || name.length === 0) continue;
    windows.push({ id, name: name.join("|") });
  }
  return windows;
}

/**
 * Create `session` with its placeholder `_mu` window when it is missing,
 * and re-add the window when the session exists without it (the operator
 * killed it, or the session predates it). Without `_mu`, closing the last
 * agent kills the last window and tmux destroys the session.
 */
export async function ensureSession(session: string): Promise<EnsureSessionResult> {
  if (!(await sessionExistsOrMayStart(session))) {
    await tmux(["new-session", "-d", ...DETACHED_SIZE, "-s", session, "-n", MU_PLACEHOLDER_WINDOW]);
    return { created: true, repaired: false };
  }
  const windows = await listWindows(session).catch(() => []);
  if (windows.some((w) => w.name === MU_PLACEHOLDER_WINDOW)) {
    return { created: false, repaired: false };
  }
  await tmux([
    "new-window",
    "-d",
    "-t",
    exactSessionTarget(session),
    "-n",
    MU_PLACEHOLDER_WINDOW,
    process.env.SHELL ?? "/bin/sh",
  ]);
  return { created: false, repaired: true };
}

/**
 * Kill the named session if the verified pane is still in it. Returns false
 * rather than acting on an unproved session, including one already gone.
 *
 * Four absent-session errors:
 *   - "can't find session: <name>"  — session never existed.
 *   - "session not found"           — alternate phrasing on some tmux builds.
 *   - "no server running on <path>" (or "error connecting to <path> (No
 *     such file or directory)", see NO_SERVER_RE) — the tmux server itself has exited
 *     (typical when the test suite runs against a private `tmux -L
 *     <socket>` server and the just-killed session was its last; tmux
 *     quietly shuts the server down). Without this, killSession would
 *     throw on the very next idempotent call — only visible under
 *     the test harness's private socket.
 *   - "no current target"           — the server is UP but has zero
 *     sessions, so `-t <name>` has no session list to resolve against
 *     and tmux never gets as far as "can't find session". Reachable
 *     whenever the server outlives its last session: the suite's
 *     private server (`exit-empty off`, see test/_global-teardown.ts)
 *     and any user whose ~/.tmux.conf sets `exit-empty off`. Same
 *     meaning as "can't find session" for our purposes — the session
 *     we were asked to kill is gone.
 */
export async function killSession(name: string, pane: PaneRef): Promise<boolean> {
  // A legacy row's pane: membership in the session is checked in the kill, not its server.
  const ref = paneTarget(pane);
  // The name is inserted into a tmux format expression. Refuse names that could change it.
  if (!/^[\w.-]+$/.test(name)) throw new MuxError(`cannot verify tmux session name: ${name}`);
  const args = guardedArgs(ref, ["kill-session", "-t", exactSessionTarget(name)], name);
  const result = await currentExecutor(args);
  // Wrong server (verified ref), missing or moved pane: no proof the named session is ours.
  if (result.exitCode === FOREIGN_SERVER_EXIT) return false;
  if (
    result.exitCode !== 0 &&
    !/can't find session|session not found|no current target/i.test(result.stderr) &&
    !NO_SERVER_RE.test(result.stderr)
  ) {
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  return result.exitCode === 0;
}

// ─── Panes ─────────────────────────────────────────────────────────────

/** What a retained pane runs until its `remain-on-exit` is armed and the real command replaces it. */
const RETAIN_PLACEHOLDER = "exec sleep 60";

/**
 * Create the agent's pane and run `opts.command` in it, one tmux call:
 *   - session doesn't exist          → new session+window+pane
 *   - session exists, no such window → new window for this agent
 *   - session and window both exist  → split the window to add a pane
 * Returns the pane's stable id (`%15`) only after its server identity is known.
 */
export async function spawnAgent(opts: SpawnAgentPaneOptions): Promise<string> {
  const retain = opts.retainOnExit === true;
  const tail = (args: string[]): string[] => {
    // A retained pane starts as a placeholder and is respawned into the real
    // command once its remain-on-exit is armed (see `created`).
    if (!retain) {
      if (opts.cwd) args.push("-c", opts.cwd);
      appendEnvFlags(args, opts.env);
    }
    // The server's identity comes back in the SAME call that created the pane: a later lookup
    // could sample another server (a restart between the two).
    args.push(
      "-P",
      "-F",
      "#{pane_id}|#{pid}|#{start_time}",
      retain ? RETAIN_PLACEHOLDER : opts.command,
    );
    return args;
  };
  const created = async (args: string[]): Promise<string> => {
    // Exactly one line: `%N|<pid>|<start time>`. Anything else (a hook's extra output) is no pane id.
    const made = (await tmux(args)).trim();
    const [, paneId, identity] = /^(%\d+)\|(\d+\|\d+)$/.exec(made) ?? [];
    if (paneId === undefined || identity === undefined) {
      throw new TmuxPaneBirthError(/^(%\d+)(?:\||$)/.exec(made)?.[1]);
    }
    const ref = requireVerifiedPane(paneRef(paneId, identity));
    if (retain) {
      // The pane option is set while only the placeholder runs, so the real
      // command can never end before retention is armed (no set-after-spawn
      // race), and only THIS pane is touched, never a session or global default.
      try {
        await paneTmux(ref, (id) => ["set-option", "-p", "-t", id, "remain-on-exit", "on"]);
        await paneTmux(ref, (id) => {
          const respawn = ["respawn-pane", "-k", "-t", id];
          if (opts.cwd) respawn.push("-c", opts.cwd);
          appendEnvFlags(respawn, opts.env);
          respawn.push(opts.command);
          return respawn;
        });
      } catch (err) {
        await killPane(ref).catch(() => {});
        throw err;
      }
    }
    // Crew identity for murmur 3.0 (@mu_agent, @mu_workstream, @mu_role), beside the MU_* env.
    // Best effort: a tag that fails to set must not cost the agent its pane.
    // One tmux invocation (`;`-chained), so the tags land together or not at all.
    const tags = Object.entries(opts.paneOptions ?? {});
    if (tags.length > 0) {
      try {
        await paneTmuxCommands(ref, (id) =>
          tags.map(([name, value]) => ["set-option", "-p", "-t", id, name, value]),
        );
      } catch {
        // untagged is still a working pane
      }
    }
    opts.onPaneCreated?.(paneId, identity);
    return paneId;
  };

  if (!(await sessionExistsOrMayStart(opts.session))) {
    return created(
      tail(["new-session", "-d", ...DETACHED_SIZE, "-s", opts.session, "-n", opts.window]),
    );
  }
  const matching = (await listWindows(opts.session)).find((w) => w.name === opts.window);
  if (matching) {
    // tmux splits a WINDOW: target it as `=<session>:<window_id>`. A bare
    // `<session>:<name>` falls back to tmux's session prefix match, so if
    // `mu-auth` vanishes between list-windows and here, `mu-auth:Backend`
    // splits `mu-auth-refactor`'s Backend window. `=` makes the session
    // exact and the stable window id (from the listing above) must live
    // in that session, so a vanished session or window fails instead of
    // landing elsewhere.
    return created(tail(["split-window", "-h", "-d", "-t", `=${opts.session}:${matching.id}`]));
  }
  return created(
    tail(["new-window", "-d", "-t", exactSessionTarget(opts.session), "-n", opts.window]),
  );
}

/**
 * List ALL panes in a tmux session (across every window).
 *
 * Note `list-panes -t <session>` (no -s) lists panes in the current
 * *window* of that session, not the whole session — a common gotcha.
 * `-s` is the flag that says "all panes in this session."
 *
 * Returns `[]` (not throws) when the session doesn't exist or has no
 * panes. tmux destroys a session as soon as its last pane closes, so the
 * "session was just here a moment ago" case is normal during reconcile.
 * tmux's error wording in this case varies ("can't find session",
 * "can't find window", or "no current target" when the server is up
 * with zero sessions), so we match any of them. Every other failure
 * throws.
 */
export async function listPanes(session: string): Promise<MuxPane[]> {
  const args = [
    "list-panes",
    "-s",
    "-t",
    exactSessionTarget(session),
    "-F",
    "#{window_id}|#{pane_id}|#{pane_current_command}",
  ];
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    if (
      /can't find (session|window)|no sessions|no current target/i.test(result.stderr) ||
      NO_SERVER_RE.test(result.stderr)
    ) {
      return [];
    }
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  const panes: MuxPane[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [windowId, paneId, ...command] = line.split("|");
    if (!windowId || !paneId || command.length === 0) continue;
    panes.push({ paneId, command: command.join("|"), windowId });
  }
  return panes;
}

/**
 * Push one `-e KEY=VALUE` flag per entry into `args`, validating that
 * keys are non-empty and contain no `=` (tmux would error obscurely
 * otherwise; throwing TypeError keeps the failure at the call site).
 * No-op when `env` is undefined or empty.
 *
 * Iteration order follows Object.entries (insertion order); tests
 * shouldn't depend on a specific ordering, only on the presence of
 * each `-e KEY=VALUE` pair in the captured args.
 */
function appendEnvFlags(args: string[], env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    if (k.length === 0) {
      throw new TypeError("tmux env key must be non-empty");
    }
    if (k.includes("=")) {
      throw new TypeError(`tmux env key must not contain '=': ${JSON.stringify(k)}`);
    }
    args.push("-e", `${k}=${v}`);
  }
}

/** Idempotent: succeeds even if the pane is already gone. */
export function killPaneCommand(ref: PaneRef): MuxCommand {
  return {
    command: "tmux",
    args: [...tmuxGlobalFlags(), ...guardedArgs(paneTarget(ref), ["kill-pane", "-t", ref.paneId])],
  };
}

export async function killPane(ref: PaneRef): Promise<void> {
  const r = await execOnPane(paneTarget(ref), (id) => ["kill-pane", "-t", id]);
  // Another server holds the id: that pane is not the caller's, and is left alone.
  if (r.foreign) return;
  if (r.exitCode !== 0 && !/can't find pane/i.test(r.stderr) && !NO_SERVER_RE.test(r.stderr)) {
    throw new TmuxError(r.args, r.stderr, r.stdout, r.exitCode);
  }
}

export async function paneAlive(ref: string | VerifiedPaneRef): Promise<boolean> {
  if (typeof ref === "string" && !isValidPaneId(ref)) return false;
  // tmux's `display-message -t <bogus>` exits 0 but emits empty output; we
  // must check that the echoed pane id matches what we asked for.
  const result = await execOnPane(ref, (id) => ["display-message", "-t", id, "-p", "#{pane_id}"]);
  const { args, paneId } = result;
  if (result.foreign) return false;
  if (result.exitCode !== 0) {
    // Only "the pane or server is gone" means false. Any other failure
    // (permission denied, a broken socket) is unknown, not dead: callers
    // that gate destructive work on liveness must not read it as gone.
    if (/can't find pane|pane not found|no current target/i.test(result.stderr)) return false;
    if (NO_SERVER_RE.test(result.stderr)) return false;
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  return result.stdout.trim() === paneId;
}

/**
 * The pane on the server `identity` names, asked in ONE guarded tmux call: the server check and
 * the pane lookup run in the same invocation, so a socket that starts answering for another
 * server between two calls cannot turn that server's miss into this pane's absence. Another
 * server or no server answering is `foreign`; any other failure throws.
 */
export async function paneOnServer(
  paneId: string,
  identity: string,
): Promise<"present" | "absent" | "foreign"> {
  const ref = requireVerifiedPane(paneRef(paneId, identity));
  const r = await execOnPane(ref, (id) => ["display-message", "-t", id, "-p", "#{pane_id}"]);
  if (r.foreign) return "foreign";
  if (r.exitCode !== 0) {
    if (NO_SERVER_RE.test(r.stderr)) return "foreign";
    if (/can't find pane|pane not found|no current target/i.test(r.stderr)) return "absent";
    throw new TmuxError(r.args, r.stderr, r.stdout, r.exitCode);
  }
  return r.stdout.trim() === paneId ? "present" : "absent";
}

/**
 * The pane's run state: running, exited (a retained pane keeps its row, with
 * `#{pane_dead_status}` / `#{pane_dead_signal}`) or absent. Only "the pane or
 * server is gone" is absent; any other failure throws, as `paneAlive` does.
 */
export async function paneResult(ref: string | VerifiedPaneRef): Promise<PaneResult> {
  if (typeof ref === "string" && !isValidPaneId(ref)) return { state: "absent" };
  const result = await execOnPane(ref, (id) => [
    "display-message",
    "-t",
    id,
    "-p",
    "#{pane_id}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
  ]);
  const { args, paneId } = result;
  if (result.foreign) return { state: "absent" };
  if (result.exitCode !== 0) {
    if (/can't find pane|pane not found|no current target/i.test(result.stderr)) {
      return { state: "absent" };
    }
    if (NO_SERVER_RE.test(result.stderr)) return { state: "absent" };
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  const [id, dead, status, signal] = result.stdout.trim().split("|");
  if (id !== paneId) return { state: "absent" };
  if (dead !== "1") return { state: "running" };
  const num = (s: string | undefined): number | null =>
    s !== undefined && /^\d+$/.test(s) ? Number(s) : null;
  return { state: "exited", code: num(status), signal: num(signal) };
}

/**
 * The agent's state as OSC 7501 reports it through vtmux (`#{pane_program_*}`),
 * mapped as Rex's `paneStatus` is. Undefined on a tmux without vtmux, with
 * `vtmux-program-status` off, for a pane that reported nothing, or when the
 * pane or server is gone. Only the root record speaks for the agent: when a
 * sub-tool's record wins the summary (`pane_program_id` set), the root's own
 * state is read and its kind is unknown.
 */
export async function paneStatus(paneId: string): Promise<MuxPaneStatus | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const result = await execOnPane(paneId, (id) => [
    "display-message",
    "-t",
    id,
    "-p",
    "#{vtmux_version}|#{vtmux-program-status}|#{pane_program_state}|#{pane_program_kind}|#{pane_program_id}|#{pane_program_root_state}|#{pane_program_state_time}",
  ]);
  if (result.exitCode !== 0) {
    if (/can't find pane|pane not found|no current target/i.test(result.stderr)) return undefined;
    if (NO_SERVER_RE.test(result.stderr)) return undefined;
    throw new TmuxError(result.args, result.stderr, result.stdout, result.exitCode);
  }
  const [version, enabled, state, kind, id, rootState] = result.stdout.trim().split("|");
  if (!version || (enabled !== "on" && enabled !== "1")) return undefined;
  // A permission prompt is a blocked sub-record while the root keeps working (Claude, Codex):
  // it outranks the root, as in Rex. mu's own delegates record is only a "waiting" hint.
  if (state === "blocked" && kind === "permission" && id !== "mu/delegates") {
    return "needs_permission";
  }
  const root = id === "" ? state : rootState;
  if (root === "blocked") return "needs_input";
  if (root === "working") return "busy";
  if (root === "idle" || root === "done" || root === "error") return "needs_input";
  return undefined;
}

/** The pid of the pane's first process; undefined when the pane or server is gone. */
export async function panePid(ref: string | VerifiedPaneRef): Promise<number | undefined> {
  if (typeof ref === "string" && !isValidPaneId(ref)) return undefined;
  const result = await execOnPane(ref, (id) => [
    "display-message",
    "-t",
    id,
    "-p",
    "#{pane_id}|#{pane_pid}",
  ]);
  const { args, paneId } = result;
  if (result.foreign) return undefined;
  if (result.exitCode !== 0) {
    if (/can't find pane|pane not found|no current target/i.test(result.stderr)) return undefined;
    if (NO_SERVER_RE.test(result.stderr)) return undefined;
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  const [id, pid] = result.stdout.trim().split("|");
  return id === paneId && pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : undefined;
}

/**
 * The tmux server's identity, `<pid>|<start time>` (`|`: tmux 3.8 turns a tab in a format into
 * `_`); undefined when no server runs. Pane ids restart per server.
 */
export async function serverIdentity(): Promise<string | undefined> {
  const args = ["list-sessions", "-F", "#{pid}|#{start_time}"];
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    if (/no sessions|no current target/i.test(result.stderr) || NO_SERVER_RE.test(result.stderr)) {
      return undefined;
    }
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  const first = result.stdout.split("\n")[0]?.trim();
  return first !== undefined && SERVER_IDENTITY_RE.test(first) ? first : undefined;
}

/**
 * Name of the tmux session this process is running inside, or
 * undefined outside tmux. Gated on `$TMUX` so a call from a plain
 * shell doesn't get whatever session the server happens to consider
 * current. A `$TMUX` naming another server (an outer tmux around mu's
 * private one) is outside too.
 */
export async function currentSessionName(): Promise<string | undefined> {
  if (!tmuxServerIsCurrent()) return undefined;
  const result = await currentExecutor(["display-message", "-p", "#S"]);
  if (result.exitCode !== 0) return undefined;
  const name = result.stdout.trim();
  return name === "" ? undefined : name;
}

// ─── Capture ───────────────────────────────────────────────────────────

/**
 * Read pane scrollback as plain text (no ANSI escapes).
 *
 * - No options: full scrollback (`-S - -E -`)
 * - `lines: 0`: visible pane only
 * - `lines: N`: last N lines, ending at the last non-blank row
 *
 * `-S -N` counts from the TOP of the visible screen, so tmux returns the
 * N rows above the screen plus every visible row, blank rows below the
 * cursor included. That range always holds the last N non-blank-ended
 * lines, so drop the trailing blank rows and keep the last N.
 */
export async function capture(ref: PaneRef, opts: CaptureOptions = {}): Promise<string> {
  const build = (id: string): string[] => {
    const args = ["capture-pane", "-t", id, "-p"];
    if (opts.lines === undefined) args.push("-S", "-", "-E", "-");
    else if (opts.lines > 0) args.push("-S", `-${opts.lines}`);
    return args;
  };
  const out = await paneTmux(ref, build);
  return opts.lines !== undefined && opts.lines > 0 ? lastLines(out, opts.lines) : out;
}

/** The last `n` lines of `text` after dropping trailing blank lines.
 *  Keeps a trailing newline when `text` had one (tmux prints one). */
function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  if (end === 0) return "";
  const kept = lines.slice(Math.max(0, end - n), end).join("\n");
  return text.endsWith("\n") ? `${kept}\n` : kept;
}

// ─── Paste and keys (the `hooks` channel) ───────────────────────────────

/** How long a TUI gets to clear its input line before the paste (measured in U0). */
const CLEAR_SETTLE_MS = 200;
/** How long a TUI gets to take a paste before the Enter that submits it (measured in U0). */
const PASTE_SETTLE_MS = 500;
/**
 * Code points per `set-buffer` call. tmux carries a command in one message of
 * at most 16 KiB, so a long text is appended in chunks of at most 8 KiB of
 * UTF-8.
 */
const BUFFER_CHUNK = 2048;

/**
 * Clear the input line with `clearKey`, paste `text` as ONE bracketed paste
 * (`paste-buffer -p`: tmux brackets it when the program asked for that, as
 * every hook harness does, so a multi-line text never submits early), then
 * submit it with Enter. The text goes through a named buffer that the paste
 * deletes, so the user's own paste buffers are untouched. Unconfirmed: the
 * caller confirms it from the agent's own report.
 */
export async function pasteToPane(
  ref: PaneRef,
  text: string,
  opts: { clearKey?: string | null } = {},
): Promise<void> {
  if (opts.clearKey) {
    const key = opts.clearKey;
    await paneTmux(ref, (id) => ["send-keys", "-t", id, key]);
    await sleep(CLEAR_SETTLE_MS);
  }
  if (text.length > 0) {
    const buffer = `mu-paste-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const points = Array.from(text);
    try {
      for (let at = 0; at < points.length; at += BUFFER_CHUNK) {
        const chunk = points.slice(at, at + BUFFER_CHUNK).join("");
        // Staging a private buffer does not target a pane. Pass its bytes in
        // argv, not through the command parser. tmux splits argv at a final
        // semicolon unless it is escaped.
        await tmux([
          "set-buffer",
          ...(at > 0 ? ["-a"] : []),
          "-b",
          buffer,
          "--",
          chunk.endsWith(";") ? `${chunk.slice(0, -1)}\\;` : chunk,
        ]);
      }
      await paneTmux(ref, (id) => ["paste-buffer", "-p", "-d", "-b", buffer, "-t", id]);
    } catch (error) {
      try {
        await tmux(["delete-buffer", "-b", buffer]);
      } catch {
        // already gone, or tmux is: the paste's own error matters more
      }
      throw error;
    }
    await sleep(PASTE_SETTLE_MS);
  }
  await paneTmux(ref, (id) => ["send-keys", "-t", id, "Enter"]);
}

/** Set the user option `name` (`@…`) on this pane only. */
export async function setPaneOption(ref: PaneRef, name: string, value: string): Promise<void> {
  await paneTmux(ref, (id) => ["set-option", "-p", "-t", id, name, value]);
}

// Bound the quoted command, not the raw text. A UTF-16 unit can cost up to
// six bytes (LF escape plus quotes); 2048 units leave room under 16 KiB for
// the command, server guard and message framing.
const LITERAL_CHUNK = 2048;

/** Type `keys` into the pane: tmux key names, or text with `literal`. */
export async function sendKeys(
  ref: PaneRef,
  keys: readonly string[],
  opts: { literal?: boolean } = {},
): Promise<void> {
  if (keys.length === 0) return;
  const send = (parts: readonly string[]) =>
    paneTmux(ref, (id) => ["send-keys", "-t", id, ...(opts.literal ? ["-l"] : []), "--", ...parts]);
  // Count one extra unit per word for its outer quotes and separator.
  if (!opts.literal || keys.reduce((size, key) => size + key.length + 1, 0) <= LITERAL_CHUNK) {
    await send(keys);
    return;
  }
  // Keep literal key semantics and recheck the same server in every acting
  // call. If the server changes, stop: earlier chunks may already have landed.
  for (const key of keys) {
    let chunk = "";
    for (const point of key) {
      if (chunk.length + point.length > LITERAL_CHUNK) {
        await send([chunk]);
        chunk = "";
      }
      chunk += point;
    }
    if (chunk !== "") await send([chunk]);
  }
}

// ─── Backend record ────────────────────────────────────────────────────

/**
 * True iff tmux can be reached right now. `tmux -V` rather than a PATH
 * probe: a tmux binary that cannot execute (broken install, missing
 * libtinfo) is not an available backend, and the version call is the
 * cheapest thing that proves the binary actually runs.
 *
 * Deliberately does NOT require `$TMUX` — mu creates its own detached
 * sessions, so a usable tmux server is enough. `$TMUX` only tells us
 * whether the CALLER is inside a pane, which is a detection-precedence
 * signal (see ./detect.ts), not an availability one.
 */
async function tmuxAvailable(): Promise<boolean> {
  try {
    await tmux(["-V"]);
    return true;
  } catch {
    return false;
  }
}

// ─── Attach ────────────────────────────────────────────────────
//
// From INSIDE a tmux client the right verb is `switch-client`, which
// repoints the existing client and returns immediately. From outside it
// is ONE `attach-session -t <session>:<window>`: the window half of the
// target selects the window the client opens on. (A separate
// `select-window` after the attach would run only once the blocking
// client detached.) Every step carries the same `-L <socket>` as `tmux()`
// does, so the line printed for a private `MU_TMUX_SOCKET` reaches the
// server that holds the session, not the user's default one.

type TmuxAttachTarget = Omit<AttachTarget, "window" | "pane"> &
  ({ pane: PaneRef } | { pane?: never; window?: never });

/**
 * Is `$TMUX` a client of the server mu drives? With no `MU_TMUX_SOCKET`, tmux itself follows
 * `$TMUX`, so yes. With `-L <socket>`, only when `$TMUX` (`<socket path>,<pid>,<session>`)
 * names that socket file. False when `$TMUX` is unset or names an outer tmux around mu's
 * private server.
 */
function tmuxServerIsCurrent(): boolean {
  const path = process.env.TMUX?.split(",")[0];
  if (path === undefined || path === "") return false;
  const socket = process.env.MU_TMUX_SOCKET;
  return socket === undefined || socket.length === 0 || basename(path) === socket;
}

/** Inside a client of some OTHER tmux server than the one mu drives. */
const inAnotherTmux = (): boolean => Boolean(process.env.TMUX) && !tmuxServerIsCurrent();

/** How the caller gets back after an attach from here: `$TMUX` on mu's server (`switch`),
 *  on another one (`nested`: the outer tmux needs a doubled prefix), or none (`plain`). */
export function tmuxAttachMode(): "switch" | "nested" | "plain" {
  if (!process.env.TMUX) return "plain";
  return inAnotherTmux() ? "nested" : "switch";
}

export async function attachCommands(target: TmuxAttachTarget): Promise<readonly MuxCommand[]> {
  const pane = target.pane === undefined ? undefined : paneTarget(target.pane);
  if (pane === undefined && "window" in target) {
    throw new MuxError("tmux agent attach needs a pane");
  }
  const spec =
    pane === undefined
      ? exactSessionTarget(target.session)
      : typeof pane === "string"
        ? pane
        : pane.paneId;
  const socket = process.env.MU_TMUX_SOCKET;
  const route = socket === undefined || socket.length === 0 ? [] : ["-L", socket];
  const on = (verb: string) => {
    const args = [verb, "-t", spec];
    return pane === undefined ? args : guardedArgs(pane, args);
  };
  const attach = { command: "tmux", args: [...route, ...on("attach-session")] };
  if (target.outside === true) return [attach];
  // A client of ANOTHER server (an outer tmux around mu's private one) cannot be switched,
  // and tmux refuses an attach with `$TMUX` set: open a deliberately nested client.
  if (inAnotherTmux()) return [{ ...attach, nested: true }];
  if (target.inside === true) return [{ ...attach, args: [...route, ...on("switch-client")] }];
  return [attach];
}

/**
 * Version probe + the two ambient env facts tmux exposes. Returns DATA;
 * `mu doctor` owns every string the user sees, so a second backend
 * reporting different env vars needs no doctor change.
 */
/** vtmux (OSC 7501 capable tmux) and whether `vtmux-program-status` is on; {} on plain tmux or no server. */
async function vtmuxProbe(): Promise<Pick<MuxHealth, "vtmux">> {
  try {
    const out = await tmux(["list-sessions", "-F", "#{vtmux_version}|#{vtmux-program-status}"]);
    const [version, status] = (out.split("\n")[0] ?? "").trim().split("|");
    if (!version) return {};
    return { vtmux: { version, programStatus: status === "on" || status === "1" } };
  } catch {
    return {};
  }
}

export async function healthCheck(): Promise<MuxHealth> {
  let version: string | null = null;
  try {
    version = (await tmux(["-V"])).trim();
  } catch {
    version = null;
  }
  return {
    name: "tmux",
    ok: version !== null,
    version,
    ...(await vtmuxProbe()),
    env: [
      { name: "$TMUX", value: process.env.TMUX ?? null },
      { name: "$TMUX_PANE", value: process.env.TMUX_PANE ?? null },
    ],
    remediation: "install tmux ≥ 3.0",
  };
}

/**
 * The tmux implementation of `MuxBackend`. A frozen record of the
 * module's functions — no state of its own, so swapping backends is a
 * pointer assignment (see ./detect.ts).
 */
export const tmuxBackend: MuxBackend = Object.freeze({
  name: "tmux" as const,
  spawnAgentWaitsReady: false,
  runsShellCommand: true,
  anchorsPanes: true,
  carrierViews: true,
  available: tmuxAvailable,

  isValidPaneId,
  assertValidPaneId,

  ensureSession,
  killSession: async (target: SessionKillTarget) => {
    if (target.backend !== "tmux") throw new MuxError("tmux session kill needs a verified pane");
    return killSession(target.session, target.pane);
  },

  spawnAgent,
  listPanes,
  paneAlive,
  paneResult,
  panePid,
  paneStatus,
  serverIdentity,
  paneOnServer,
  killPane: async (pane: ActionPaneRef) => killPane(tmuxPaneTarget(pane)),
  killPaneCommand: (pane: ActionPaneRef) => killPaneCommand(tmuxPaneTarget(pane)),
  capture: async (pane: ActionPaneRef, opts?: CaptureOptions) =>
    capture(tmuxPaneTarget(pane), opts),
  pasteToPane: async (pane: ActionPaneRef, text: string, opts?: { clearKey?: string | null }) =>
    pasteToPane(tmuxPaneTarget(pane), text, opts),
  sendKeys: async (pane: ActionPaneRef, keys: readonly string[], opts?: { literal?: boolean }) =>
    sendKeys(tmuxPaneTarget(pane), keys, opts),
  setPaneOption: async (pane: ActionPaneRef, name: string, value: string) =>
    setPaneOption(tmuxPaneTarget(pane), name, value),

  attachCommands: async (target: AttachTarget) => {
    if (target.pane !== undefined) return attachCommands({ ...target, pane: target.pane });
    if (target.window !== undefined) throw new MuxError("tmux agent attach needs a pane");
    const { session, inside, outside } = target;
    return attachCommands({
      session,
      ...(inside === undefined ? {} : { inside }),
      ...(outside === undefined ? {} : { outside }),
    });
  },

  currentSessionName,
  healthCheck,
});
