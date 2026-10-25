// Run a binary and capture its output, never rejecting on a non-zero exit.
// Shared by the tmux, herdr and murmur-status executors. Uses
// node:child_process rather than execa: execa's ~110 modules cost 25-40 ms
// of import time on every process that touches a multiplexer.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { onExit } from "signal-exit";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  /** Numeric exit code; null on spawn failure (ENOENT), signal, or timeout. */
  exitCode: number | null;
}

/** execa's default `maxBuffer` (100 MiB); execFile's own default is 1 MiB. */
const MAX_BUFFER = 100 * 1024 * 1024;

/** Drop one trailing LF or CRLF (what execa does), not all trailing whitespace. */
function stripFinalNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

// execa killed in-flight children when the parent exited or was signalled
// (`cleanup: true`, via signal-exit); a bare execFile does not, so an orphaned
// tmux client or murmur process would outlive mu and its timeout timer. Reuse
// signal-exit (what execa used) so every catchable signal is covered and the
// parent still terminates correctly next to other signal-exit users. The hook
// is installed only while a child is live.
const live = new Set<ChildProcess>();
let removeExitHook: (() => void) | undefined;

/** Children spawned as their own process group leader (`execGroupCapture`). */
const groups = new WeakSet<ChildProcess>();

function killLive(): void {
  for (const c of live) {
    if (groups.has(c) && c.pid !== undefined) signalGroup(c.pid, "SIGKILL");
    else c.kill("SIGKILL");
  }
}

/** Signal a whole process group; false once no member is left (or it was never ours to signal). */
function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

/** TERM the group, give it `graceMs`, then KILL; resolves once no member is left. */
async function reapGroup(pgid: number, graceMs: number): Promise<void> {
  if (!signalGroup(pgid, 0)) return;
  signalGroup(pgid, "SIGTERM");
  for (let waited = 0; waited < graceMs && signalGroup(pgid, 0); waited += 10) await sleep(10);
  while (signalGroup(pgid, "SIGKILL")) await sleep(10);
}

function install(): void {
  removeExitHook = onExit(killLive);
}

function uninstall(): void {
  removeExitHook?.();
  removeExitHook = undefined;
}

/**
 * Register `child` for kill-on-parent-exit. Returns the release. A plain
 * child releases itself on close/error; a group (`holdUntil`) is released by
 * its caller once the reap has finished, so the hook still covers the
 * interval where the shell is gone but the group is being reaped.
 */
function track(child: ChildProcess, holdUntil = false): () => void {
  if (live.size === 0) install();
  live.add(child);
  const done = (): void => {
    if (!live.delete(child)) return;
    if (live.size === 0) uninstall();
  };
  if (!holdUntil) {
    child.once("close", done);
    child.once("error", done);
  }
  return done;
}

export function execFileCapture(
  cmd: string,
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}),
      },
      (err, stdout, stderr) => {
        const code = err && "code" in err && typeof err.code === "number" ? err.code : null;
        resolve({
          stdout: stripFinalNewline(stdout ?? ""),
          stderr: stripFinalNewline(stderr ?? ""),
          exitCode: err ? code : 0,
        });
      },
    );
    // execa closes stdin when no input is given; do the same so children
    // that read stdin see EOF instead of hanging.
    child.stdin?.end();
    track(child);
  });
}

/**
 * Like execFileCapture, but the command owns a process group and everything it
 * started: on timeout, when the command exits (a leftover background job
 * included) and when the parent exits, the whole group is terminated (TERM,
 * then KILL after `graceMs`) BEFORE the promise settles. For a shell template
 * whose descendants (a transport) must not outlive the call. The child is
 * detached from the controlling terminal. A descendant that setsid()s away is
 * out of reach. The parent-exit hook stays installed until the reap is done,
 * not just until the shell closes.
 *
 * `onSpawn(pgid)` runs before the command starts (it is gated on a byte of
 * stdin, so a parent that dies, SIGKILL included, before `onSpawn` returns
 * leaves nothing running): record the group so a lease can outlive this
 * process for as long as the group does. If it throws, the group is reaped
 * and the result is a failure.
 */
export function execGroupCapture(
  cmd: string,
  args: readonly string[],
  opts: {
    timeoutMs?: number;
    graceMs?: number;
    onSpawn?: (pgid: number) => void;
    /** The command's working directory (default: this process's). */
    cwd?: string;
  } = {},
): Promise<ExecFileResult> {
  return new Promise((resolve) => {
    const gated = opts.onSpawn !== undefined;
    const spawnOpts = {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    const child = gated
      ? spawn("/bin/sh", ["-c", 'IFS= read -r _ && exec "$0" "$@"', cmd, ...args], spawnOpts)
      : spawn(cmd, [...args], spawnOpts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.stdin?.on("error", () => {});
    groups.add(child);
    const release = track(child, true);
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const done = (): void => {
        release();
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({
          stdout: stripFinalNewline(Buffer.concat(out).toString("utf8")),
          stderr: stripFinalNewline(Buffer.concat(err).toString("utf8")),
          exitCode: timedOut ? null : code,
        });
      };
      if (child.pid === undefined) done();
      else void reapGroup(child.pid, opts.graceMs ?? 500).then(done);
    };
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            finish(null);
          }, opts.timeoutMs);
    child.once("error", () => finish(null)); // spawn failure (ENOENT): no group to reap
    child.once("exit", (code) => finish(code));
    if (opts.onSpawn !== undefined && child.pid !== undefined) {
      try {
        opts.onSpawn(child.pid);
        child.stdin?.end("\n"); // open the gate: the command starts now
      } catch {
        finish(null);
        child.stdin?.end();
      }
    } else child.stdin?.end();
  });
}
