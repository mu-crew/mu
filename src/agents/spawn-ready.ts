// mu — spawn readiness: the control-socket handshake (awaitCtlHandshake),
// the liveness window (awaitSpawnLiveness, defaultSpawnLivenessMs) and the
// startup-health scan of a fresh pane (checkSpawnHealth,
// detectSpawnStartupError, detectClaudeTrustDialog). Split from spawn.ts;
// spawn.ts re-exports the public names, so import paths keep working.

import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { type CtlProbe, ctlProbe } from "../ctl/client.js";
import { activeMux } from "../mux.js";
// `sleep` is the shared poll-sleep TEST SEAM (setSleepForTests), not a
// multiplexer operation, so it stays on the tmux module rather than
// joining the MuxBackend contract.
import { sleep } from "../tmux.js";
import { AgentDiedOnSpawnError, AgentSpawnStartupError } from "./errors.js";

/** Outcome of the spawn-time control-socket handshake. */
export type SpawnCtl = "ok" | "missing" | "refused" | "skipped";

/** A ctl probe's outcome as spawn reports it. */
export function probeToSpawnCtl(kind: CtlProbe["kind"]): Exclude<SpawnCtl, "skipped"> {
  return kind === "ok" ? "ok" : kind === "missing" ? "missing" : "refused";
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
export async function awaitCtlHandshake(
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

export async function awaitSpawnLiveness(
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
export async function checkSpawnHealth(
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
