// Run a binary and capture its output, never rejecting on a non-zero exit.
// Shared by the tmux, herdr, kick and murmur-status executors. Uses
// node:child_process rather than execa: execa's ~110 modules cost 25-40 ms
// of import time on every process that touches a multiplexer.

import { type ChildProcess, execFile } from "node:child_process";

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
// (`cleanup: true`); a bare execFile does not, so an orphaned tmux client or
// murmur process would outlive mu and its timeout timer. Track live children
// and kill them on exit / SIGTERM / SIGINT / SIGHUP. The listeners exist only
// while a child is live, so mu's default signal behaviour is otherwise intact.
const live = new Set<ChildProcess>();
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

function killLive(): void {
  for (const c of live) c.kill("SIGKILL");
}

function onSignal(sig: NodeJS.Signals): void {
  killLive();
  // Re-raise with the default action unless something else handles the signal.
  uninstall();
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}

const handlers = Object.fromEntries(SIGNALS.map((s) => [s, () => onSignal(s)])) as Record<
  (typeof SIGNALS)[number],
  () => void
>;

function install(): void {
  process.on("exit", killLive);
  for (const s of SIGNALS) process.on(s, handlers[s]);
}

function uninstall(): void {
  process.off("exit", killLive);
  for (const s of SIGNALS) process.off(s, handlers[s]);
}

function track(child: ChildProcess): void {
  if (live.size === 0) install();
  live.add(child);
  const done = (): void => {
    if (!live.delete(child)) return;
    if (live.size === 0) uninstall();
  };
  child.once("close", done);
  child.once("error", done);
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
