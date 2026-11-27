// The `@mu_pending` pane option: on tmux, the delegates still owed to this pi,
// as a user pane option beside the @mu_* crew tags, so a status line or murmur
// reads the count with `#{@mu_pending}` whatever state the pane reports. Set
// while N > 0, unset at 0 and on shutdown. The OSC 7501 record stays the
// primary signal (Rex, the hourglass); this is tmux-only and fail-silent.

import { execFile } from "node:child_process";

export const PENDING_PANE_OPTION = "@mu_pending";

/** Bounds one tmux call: a hung server costs a status hint, never pi. */
const TMUX_TIMEOUT_MS = 1000;

export type PaneOptionRunner = (argv: readonly string[]) => Promise<void>;

const execTmux: PaneOptionRunner = (argv) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        "tmux",
        [...argv],
        { timeout: TMUX_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
        () => resolve(),
      );
      child.on("error", () => resolve());
    } catch {
      resolve();
    }
  });

let runner: PaneOptionRunner = execTmux;

/** Swap the tmux runner (tests); null restores the real one. Resets the coalescer. */
export function setPaneOptionRunnerForTests(r: PaneOptionRunner | null): void {
  runner = r ?? execTmux;
  applied = undefined;
  wanted = undefined;
  inFlight = undefined;
}

/**
 * The pane this process runs in, on the server it runs on: `$TMUX`
 * (`<socket path>,<pid>,<session>`) and `$TMUX_PANE` (`%<n>`). Undefined
 * unless both are present and well formed (fails closed: no guessing a pane).
 */
export function ownTmuxPane(
  env: NodeJS.ProcessEnv = process.env,
): { socket: string; pane: string } | undefined {
  const socket = env.TMUX?.split(",")[0];
  const pane = env.TMUX_PANE;
  if (!socket?.startsWith("/") || pane === undefined || !/^%\d+$/.test(pane)) return undefined;
  return { socket, pane };
}

/** The tmux argv that records `count` (unset at 0) on `pane` of `socket`. */
export function pendingOptionArgv(socket: string, pane: string, count: number): string[] {
  const head = ["-S", socket, "set-option", "-p", "-t", pane];
  return count > 0
    ? [...head, PENDING_PANE_OPTION, String(count)]
    : [...head, "-u", PENDING_PANE_OPTION];
}

/** The count tmux last got (undefined: nothing sent yet). */
let applied: number | undefined;
/** The count to send next, once the call in flight settles. */
let wanted: number | undefined;
let inFlight: Promise<void> | undefined;

/** One tmux call at a time, latest value wins: writes never land out of order. */
function drain(): Promise<void> {
  if (inFlight) return inFlight;
  const target = ownTmuxPane();
  if (!target) return Promise.resolve();
  const step = async (): Promise<void> => {
    while (wanted !== undefined && wanted !== applied) {
      const n = wanted;
      try {
        await runner(pendingOptionArgv(target.socket, target.pane, n));
      } catch {
        // fail-silent: a status hint is never worth an error
      }
      applied = n;
    }
  };
  inFlight = step().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

/**
 * Record `count` pending delegates on this pane's `@mu_pending` (unset at 0).
 * Fire-and-forget: only a change reaches tmux, and nothing outside tmux.
 * The promise settles when tmux has the value (bounded per call); it never rejects.
 */
export function reportPendingPaneOption(count: number): Promise<void> {
  wanted = Math.max(0, count);
  return drain();
}

/**
 * Shutdown: unset `@mu_pending` even if this process never set it (a crashed
 * predecessor in the same pane may have). Bounded; never rejects.
 */
export function clearPendingPaneOption(): Promise<void> {
  wanted = 0;
  if (applied === 0) applied = undefined;
  return drain();
}
