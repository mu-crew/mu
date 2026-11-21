// mu — `mu host exec` (spec 2026-11-20-ladder-placement.md §6): one synchronous call through
// the host's link, with no row, task, pane or job record.
//
// Admission is the link's: a `slots: "mu"` link (the template) holds one transient channel for
// the call; a `slots: "self"` link (a plugin such as mule) takes none, so nothing is admitted
// twice (§4.2). `link.fits` runs before admission and again on the admitted profile. A
// command's own exit code is the link's reply and is never reinterpreted here: the only hand-back
// is the link's (`HostHandbackError`). A legacy TEMPLATE link reads every exit 3 as a hand-back
// (src/hosts.ts `runLeasedTemplate`: the documented exception, so a template's `exit 3` is the
// host asking for a human, exit 5); the mule link passes `--strict-codes`, so there 3 is only
// mule's and a command's 3 arrives as 8, which is a plain reply. Nothing is retried.
//
// The record (§6.6) is one `host.exec` log op: host, link, outcome or exit, duration and the
// command's byte length. Never the command text or any output.

import type { Db } from "./db.js";
import { resolveHost } from "./host-provider.js";
import { HostHandbackError, HostProfileError } from "./hosts.js";
import { emitEvent } from "./logs.js";

/** Default deadline (§6.4), seconds. */
export const HOST_EXEC_DEFAULT_TIMEOUT_S = 600;
/** What mu keeps of stdout plus stderr (§6.3). */
export const HOST_EXEC_OUTPUT_MAX_BYTES = 1024 * 1024;

/** The command does not fit the link (§6.2): nothing was run. Exit 2 (profile lane). */
export class HostExecTooLargeError extends HostProfileError {
  override readonly name: string = "HostExecTooLargeError";
  constructor(
    host: string,
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(
      `host ${host}: the command is ${bytes} bytes, over its link's limit of ${limit}; nothing ran`,
    );
  }
}

export interface HostExecOptions {
  /** The POSIX sh command line to run. */
  script: string;
  /** The remote working directory (default `.`, the login directory). */
  cwd?: string;
  /** The deadline, seconds (default 600). */
  timeoutS?: number;
}

export interface HostExecResult {
  host: string;
  link: string;
  /** The link's code, or null: the command was cut by the deadline or nothing answered. */
  exit: number | null;
  /** With `exit: null`: whether the remote command is proven stopped or may still run. */
  remote?: "stopped" | "unknown";
  /** The link cut the output (a plugin's exit 7 under `--strict-codes`). */
  partial: boolean;
  /** mu clipped the output to its 1 MiB bound; the command still ran. */
  clipped: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Keep `max` bytes in all: each stream gets half, and what one leaves unused goes to the other. */
export function clipOutput(
  stdout: string,
  stderr: string,
  max = HOST_EXEC_OUTPUT_MAX_BYTES,
): { stdout: string; stderr: string; clipped: boolean } {
  const out = Buffer.from(stdout);
  const err = Buffer.from(stderr);
  if (out.length + err.length <= max) return { stdout, stderr, clipped: false };
  const half = Math.floor(max / 2);
  const outKeep = Math.min(out.length, Math.max(half, max - err.length));
  const errKeep = Math.min(err.length, max - outKeep);
  return {
    stdout: out.subarray(0, outKeep).toString("utf8"),
    stderr: err.subarray(0, errKeep).toString("utf8"),
    clipped: true,
  };
}

/**
 * Run `opts.script` on `host` through its link. Returns the link's reply (an exit code, or none);
 * throws `HostHandbackError` for a hand-back, and a typed refusal (host unknown, too large,
 * admission) before anything ran. Once the link was called, one `host.exec` op is recorded.
 */
export async function hostExec(
  db: Db,
  host: string,
  opts: HostExecOptions,
): Promise<HostExecResult> {
  const view = resolveHost(db, host);
  const cwd = opts.cwd ?? ".";
  const timeoutMs = (opts.timeoutS ?? HOST_EXEC_DEFAULT_TIMEOUT_S) * 1000;
  const bytes = Buffer.byteLength(opts.script);
  const fit = (h: typeof view): void => {
    const f = h.link.fits(h, opts.script, cwd);
    if (!f.ok) throw new HostExecTooLargeError(host, f.bytes, f.limit);
  };
  fit(view);
  const started = Date.now();
  let called = false;
  const record = (outcome: string): void => {
    if (!called) return;
    try {
      emitEvent(
        db,
        null,
        "host.exec",
        `host exec ${host} link=${view.link.name} ${outcome} duration=${Date.now() - started}ms cmd=${bytes}B`,
      );
    } catch {
      // The record is best effort: the command already ran.
    }
  };
  try {
    const r = await view.link.exec(
      view,
      { script: opts.script, cwd, timeoutMs },
      { holder: `exec:${process.pid}` },
      (admitted) => {
        fit(admitted);
        called = true;
      },
    );
    record(r.exitCode === null ? "outcome=no-exit" : `exit=${r.exitCode}`);
    const kept = clipOutput(r.stdout, r.stderr);
    return {
      host,
      link: view.link.name,
      exit: r.exitCode,
      ...(r.exitCode === null ? { remote: view.link.caps.remoteOnTimeout } : {}),
      partial: r.partial,
      clipped: kept.clipped,
      stdout: kept.stdout,
      stderr: kept.stderr,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    if (e instanceof HostHandbackError) record("outcome=handback");
    throw e;
  }
}
