// The `@mu_pending` pane option: on tmux, the delegates still owed to this pi,
// as a user pane option beside the @mu_* crew tags, so a status line or murmur
// reads the count with `#{@mu_pending}`. Set while N > 0, unset at 0 and on
// shutdown, and unset at session start (a predecessor in the pane may have
// died with it set). Only the pane's own pi writes it: one that serves
// `$MU_CTL_SOCK`, or, without one, a pi started outside mu; a nested pi
// (`pi -p` in a mu pi pane, which finds the socket served) never does. The OSC
// 7501 record stays the primary signal (Rex, the hourglass); this is
// tmux-only and fail-silent.

import { execFile } from "node:child_process";

export const PENDING_PANE_OPTION = "@mu_pending";

/** Bounds one tmux call: a hung server costs a status hint, never pi. */
const TMUX_TIMEOUT_MS = 1000;

/** Runs `tmux <argv>`; resolves its stdout, or undefined on any failure. Never rejects. */
export type PaneOptionRunner = (argv: readonly string[]) => Promise<string | undefined>;

const execTmux: PaneOptionRunner = (argv) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        "tmux",
        [...argv],
        { timeout: TMUX_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
        (err, stdout) => resolve(err ? undefined : String(stdout)),
      );
      child.on("error", () => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });

let runner: PaneOptionRunner = execTmux;

/** Swap the tmux runner (tests); null restores the real one. Resets all state. */
export function setPaneOptionRunnerForTests(r: PaneOptionRunner | null): void {
  runner = r ?? execTmux;
  applied = undefined;
  wanted = undefined;
  inFlight = undefined;
  target = undefined;
  claim = undefined;
}

export interface OwnPane {
  socket: string;
  pane: string;
  /** The tmux server's pid, as `$TMUX` names it. */
  pid: string;
}

/**
 * The pane this process runs in, on the server it runs on: `$TMUX`
 * (`<socket path>,<server pid>,<session>`; the path may hold commas, so it is
 * everything before the last two fields) and `$TMUX_PANE` (`%<n>`). Undefined
 * unless both are well formed, and on Rex (`TERM_PROGRAM=rex`: tmux sets its
 * own, so a Rex pane with `$TMUX` inherited it stale). Fails closed.
 */
export function ownTmuxPane(env: NodeJS.ProcessEnv = process.env): OwnPane | undefined {
  if (env.TERM_PROGRAM === "rex") return undefined;
  const tmux = env.TMUX;
  const pane = env.TMUX_PANE;
  if (!tmux || pane === undefined || !/^%\d+$/.test(pane)) return undefined;
  const fields = tmux.split(",");
  if (fields.length < 3) return undefined;
  const session = fields.pop() ?? "";
  const pid = fields.pop() ?? "";
  const socket = fields.join(",");
  if (!/^\d+$/.test(pid) || !/^\d+$/.test(session) || !socket.startsWith("/")) return undefined;
  return { socket, pane, pid };
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
/** The latest count asked for. */
let wanted: number | undefined;
let inFlight: Promise<void> | undefined;
/** The verified pane, once this pi claimed it; undefined: write nothing. */
let target: OwnPane | undefined;
/** The claim in progress or done (once per runtime). */
let claim: Promise<void> | undefined;

/** One tmux call at a time, latest value wins: writes never land out of order. */
function drain(): Promise<void> {
  if (inFlight) return inFlight;
  const t = target;
  // Nothing to send returns here, so step() always awaits once and its
  // `finally` runs after `inFlight` is assigned, never before.
  if (!t || wanted === undefined || wanted === applied) return Promise.resolve();
  const step = async (): Promise<void> => {
    try {
      while (wanted !== undefined && wanted !== applied) {
        const n = wanted;
        try {
          await runner(pendingOptionArgv(t.socket, t.pane, n));
        } catch {
          // fail-silent: a status hint is never worth an error
        }
        applied = n;
      }
    } finally {
      // Synchronously with the loop's last check: a change after it starts a new drain.
      inFlight = undefined;
    }
  };
  inFlight = step();
  return inFlight;
}

/**
 * Session start: decide whether this pi writes `@mu_pending` on its pane.
 * `owner` false (a nested pi) or a pane whose server does not answer with the
 * pid `$TMUX` names: never. Otherwise unset it once (a predecessor may have
 * died with it set) or write the count already owed. Bounded; never rejects.
 */
export function claimPendingPaneOption(owner: boolean): Promise<void> {
  if (claim) return claim.then(drain);
  if (!owner) {
    claim = Promise.resolve();
    return claim;
  }
  const own = ownTmuxPane();
  if (!own) {
    claim = Promise.resolve();
    return claim;
  }
  claim = (async () => {
    let pid: string | undefined;
    try {
      pid = (await runner(["-S", own.socket, "display", "-p", "-t", own.pane, "#{pid}"]))?.trim();
    } catch {
      pid = undefined;
    }
    if (pid !== own.pid) return;
    target = own;
    wanted ??= 0;
    applied = undefined; // the first write goes out whatever was left behind
  })();
  return claim.then(drain);
}

/**
 * Record `count` pending delegates on this pane's `@mu_pending` (unset at 0).
 * Fire-and-forget: only a change reaches tmux, and only once this pi claimed
 * the pane. The promise settles when tmux has the value (bounded per call);
 * it never rejects.
 */
export function reportPendingPaneOption(count: number): Promise<void> {
  wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return drain();
}

/** Shutdown: unset `@mu_pending` if this pi owns it. Bounded; never rejects. */
export function clearPendingPaneOption(): Promise<void> {
  wanted = 0;
  return drain();
}
