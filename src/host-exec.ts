// mu — `mu host exec` (spec 2026-11-20-placement.md §6): one synchronous call through
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
import { hostExecFence, resolveHost } from "./host-provider.js";
import { warnProviderIdleReclaim } from "./host-records.js";
import { HostExecChangedError, HostHandbackError, HostProfileError } from "./hosts.js";

export { HostExecChangedError };

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

/** `s` cut to at most `n` UTF-8 bytes, at a code point boundary. */
function cutUtf8(s: string, n: number): string {
  const b = Buffer.from(s);
  if (b.length <= n) return s;
  let end = n;
  while (end > 0 && ((b[end] as number) & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString("utf8");
}

/**
 * Keep `max` bytes in all: each stream gets half, and what one leaves unused goes to the other.
 * Counted on the strings as returned (UTF-8) and cut at code points, so the result never exceeds it.
 */
export function clipOutput(
  stdout: string,
  stderr: string,
  max = HOST_EXEC_OUTPUT_MAX_BYTES,
): { stdout: string; stderr: string; clipped: boolean } {
  const outLen = Buffer.byteLength(stdout);
  const errLen = Buffer.byteLength(stderr);
  if (outLen + errLen <= max) return { stdout, stderr, clipped: false };
  const half = Math.floor(max / 2);
  const outKeep = Math.min(outLen, Math.max(half, max - errLen));
  const errKeep = Math.min(errLen, max - outKeep);
  return { stdout: cutUtf8(stdout, outKeep), stderr: cutUtf8(stderr, errKeep), clipped: true };
}

/** An error's category for the record: never its text. */
function errorCategory(e: unknown): string {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && e instanceof Error ? kind : "error";
}

/**
 * Run `opts.script` on `host` through its link. Returns the link's reply (an exit code, or none);
 * throws `HostHandbackError` for a hand-back, and a typed refusal (host unknown, too large,
 * admission) before anything ran. Once the link dispatches, one `host.exec` op is recorded:
 * for a reply, a no-exit and a failure alike.
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
  const fit = view.link.fits(view, opts.script, cwd);
  if (!fit.ok) throw new HostExecTooLargeError(host, fit.bytes, fit.limit);
  // Reject a different profile before counting it, and re-check the same target at dispatch.
  const fence = hostExecFence(db, view);
  const started = Date.now();
  let dispatched = false;
  const record = (outcome: string): void => {
    if (!dispatched) return;
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
      {
        script: opts.script,
        cwd,
        timeoutMs,
        cwdFallback: true,
        once: true,
        maxStreamBytes: HOST_EXEC_OUTPUT_MAX_BYTES,
        dispatch: {
          check: () => {
            fence();
            warnProviderIdleReclaim(db, view.record?.id);
          },
          sent: () => {
            dispatched = true;
          },
        },
      },
      { holder: `exec:${process.pid}`, fence },
    );
    record(
      r.exitCode === null
        ? `outcome=${r.unanswered === true ? "no-answer" : "no-exit"}`
        : `exit=${r.exitCode}`,
    );
    const kept = clipOutput(r.stdout, r.stderr);
    return {
      host,
      link: view.link.name,
      exit: r.exitCode,
      // The link's word only for a run it answered; no answer proves nothing about the remote.
      ...(r.exitCode === null
        ? { remote: r.unanswered === true ? "unknown" : view.link.caps.remoteOnTimeout }
        : {}),
      partial: r.partial,
      clipped: kept.clipped || r.truncated === true,
      stdout: kept.stdout,
      stderr: kept.stderr,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    record(
      e instanceof HostHandbackError ? "outcome=handback" : `outcome=error:${errorCategory(e)}`,
    );
    throw e;
  }
}
