// mu — stopping a lease agent's remote job: run the profile's `stop` template with a handle.
//
// `runStop` is the one place a handle is turned into a remote effect. It never deletes
// the `carrier_jobs` row: the caller does that (`deleteCarrierJobAfterStop`) only after
// this returns, so a refusal or failure always leaves the handle where the operator
// (and the next close) can find it.
//
//   exit 0   the job is stopped (the template must be idempotent: an ended or unknown job is 0).
//   exit 3   a hand-back: `HostHandbackError` from `runLeasedTemplate`, never retried here.
//   other    `CarrierStopFailedError`, naming the handle and the template's first stderr line.
//   changed  `CarrierStopRefusedError`: the profile's `stop` is no longer byte-identical to
//            the one recorded with the handle. Nothing runs; the handle is named so the
//            operator can stop the job by hand.

import type { Db } from "./db.js";
import {
  type ChannelOpts,
  getHost,
  HOST_COMMAND_TIMEOUT_MS,
  HostNotFoundError,
  JOB_HANDLE_RE,
  runLeasedTemplate,
  withHostChannel,
} from "./hosts.js";
import { say } from "./messages.js";

/** A stop that was not run: the profile changed or is gone. Exit 4. */
export class CarrierStopRefusedError extends Error {
  override readonly name = "CarrierStopRefusedError";
  constructor(
    public readonly host: string,
    public readonly handle: string,
    why: "stop-changed" | "no-host" | "bad-handle",
  ) {
    super(say("carrier.stop_refused", host, handle, why));
  }
}

/** The stop template ran and did not prove the job stopped. Exit 5. */
export class CarrierStopFailedError extends Error {
  override readonly name = "CarrierStopFailedError";
  constructor(
    public readonly host: string,
    public readonly handle: string,
    /** The first non-blank line of stderr, else of stdout; or the timeout. */
    public readonly detail: string,
  ) {
    super(say("carrier.stop_failed", host, handle, detail));
  }
}

const firstLine = (s: string): string =>
  s
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

/**
 * Stop `handle` on `host` under a transient channel (it counts against `--max-sessions`
 * like `exec`). `hostStop` is the template recorded with the handle: it must equal the
 * profile's current `stop` byte for byte. Resolves on exit 0; throws otherwise (see the
 * file header). Never deletes a `carrier_jobs` row.
 */
export async function runStop(
  db: Db,
  host: string,
  handle: string,
  hostStop: string,
  opts: ChannelOpts & { timeoutMs?: number } = {},
): Promise<void> {
  if (!JOB_HANDLE_RE.test(handle)) throw new CarrierStopRefusedError(host, handle, "bad-handle");
  let current: string | null;
  try {
    current = getHost(db, host).stop;
  } catch (e) {
    if (e instanceof HostNotFoundError) throw new CarrierStopRefusedError(host, handle, "no-host");
    throw e;
  }
  if (current !== hostStop) throw new CarrierStopRefusedError(host, handle, "stop-changed");
  // The admission snapshot is the profile that runs: a change between the check above and
  // the channel is the same refusal, and nothing runs.
  const run = await withHostChannel(
    db,
    host,
    `stop:${handle}`,
    (profile, lease) => {
      if (profile.stop !== hostStop)
        throw new CarrierStopRefusedError(host, handle, "stop-changed");
      return runLeasedTemplate(
        db,
        lease,
        profile,
        "stop",
        { job: handle, cwd: "." },
        opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS,
      );
    },
    opts,
  );
  if (run.exitCode === 0) return;
  throw new CarrierStopFailedError(
    host,
    handle,
    run.exitCode === null
      ? "timed out"
      : `exit ${run.exitCode}${firstLine(run.stderr) || firstLine(run.stdout) ? `: ${firstLine(run.stderr) || firstLine(run.stdout)}` : ""}`,
  );
}
