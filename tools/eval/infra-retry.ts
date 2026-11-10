// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Host-noise rows (f_rig_infra_retry). Under load (~250) a probe row can fail for the host's sake:
// a sandbox that never came up (tmux new-session or git init exit 128), a seed call that exits on
// git's or tmux's stderr, a lead-in step killed by the shell limit. Scored as today, one such row
// marks the variant OUT as "invalid lead-in". So a suspect row is retried (each try under its own
// claim, after a backoff); a row still failing with tmux, git or sandbox stderr is recorded
// infra-invalid (`infra`) and left out of scoring, with its base pairing (tournament-score.ts). A
// row still failing without that stderr reproduced on every try: the variant's own failure, kept
// invalid, today's OUT rule. Classification reads the row's own record; no judge text is added.
import type { ProbeRow } from "./nextstep.ts";

/** Retries after the first try. */
export const INFRA_RETRIES = 2;
/** Wait before retry 1 and 2: load spikes last tens of seconds. */
export const INFRA_BACKOFF_MS: readonly number[] = [15_000, 60_000];
/** Persistent non-infra failures of one (surface, case) after which its rows are not retried. */
export const VARIANT_FAILS_TO_STOP = 2;

/** stderr the host writes, not the AUT's logic: tmux, git fatals, process limits, the sandbox. */
export const INFRA_STDERR =
  /\btmux\b|\bfatal: |index\.lock|\bsandbox\b|EAGAIN|Resource temporarily unavailable|\bfork: |Cannot allocate memory|Too many open files|no server running|server exited|lost server/i;

export interface Suspect {
  reason: string;
  /** The failure names the host (tmux, git, sandbox, a signal): still failing, the row is excluded. */
  host: boolean;
}

const SEED_FAIL = /^seed invalid: (?:seed|sh) failed \((-?\d+)\)/;

/** Why a row may be host noise, or null when its outcome stands as recorded. */
export function infraSuspect(
  row: Pick<ProbeRow, "why"> & Partial<Pick<ProbeRow, "rigError" | "leadInFault">>,
): Suspect | null {
  if (row.rigError !== undefined) return { reason: row.rigError, host: true };
  for (const w of row.why) {
    const m = SEED_FAIL.exec(w);
    if (!m) continue;
    // the first line names the command; the stderr follows it
    const stderr = w.slice(w.indexOf("\n") + 1 || w.length);
    const code = Number(m[1]);
    return { reason: w.slice(0, 300), host: code > 128 || INFRA_STDERR.test(stderr) };
  }
  if (row.leadInFault !== undefined)
    return { reason: row.leadInFault, host: INFRA_STDERR.test(row.leadInFault) };
  return null;
}

/** A lead-in record's fault: a timeout the step did not ask for, or a 128+ exit with host stderr. */
export function leadInFault(
  recs: readonly { cmd: string; exit: number; killed: boolean; output: string; limitMs: number }[],
  expectKill: readonly boolean[],
): string | undefined {
  for (const [i, r] of recs.entries()) {
    if (r.killed && expectKill[i] !== true)
      return `lead-in step ${i + 1} timed out after ${Math.round(r.limitMs / 1000)} s: ${r.cmd.slice(0, 120)}`;
    if (!r.killed && r.exit >= 128 && INFRA_STDERR.test(r.output))
      return `lead-in step ${i + 1} exit ${r.exit}: ${r.output.trim().slice(-200)}`;
  }
  return undefined;
}

export interface RetryOpts {
  retries?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** False: a non-host suspect is not retried (its variant already failed that way on every try). */
  mayRetry?: () => boolean;
  log?: (line: string) => void;
}

/**
 * Run `attempt` (one row under its own claim) until its row is not suspect, at most 1 + retries
 * times. The row gets `infraRetries` (when it retried) and `infra` when it still fails on host
 * stderr. `persistent` says the last row is still suspect.
 */
export async function withInfraRetry(
  attempt: () => Promise<ProbeRow>,
  o: RetryOpts = {},
): Promise<{ row: ProbeRow; persistent: Suspect | null }> {
  const retries = o.retries ?? INFRA_RETRIES;
  const backoff = o.backoffMs ?? INFRA_BACKOFF_MS;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let row = await attempt();
  let s = infraSuspect(row);
  let n = 0;
  while (s !== null && n < retries && (s.host || (o.mayRetry?.() ?? true))) {
    o.log?.(
      `infra retry ${n + 1}/${retries} (${row.surface} ${row.case}): ${s.reason.split("\n")[0]}`,
    );
    await sleep(backoff[n] ?? backoff[backoff.length - 1] ?? 0);
    n++;
    row = await attempt();
    s = infraSuspect(row);
  }
  if (n > 0) row.infraRetries = n;
  if (s?.host) row.infra = s.reason.split("\n").slice(0, 3).join(" | ").slice(0, 300);
  return { row, persistent: s };
}

/** Pairing key of a row's cluster: both sides of a comparison drop it when either side is infra. */
export const infraCluster = (r: Pick<ProbeRow, "case" | "model" | "arm" | "paraphrase">): string =>
  `${r.case}|${r.model}|${r.arm}|${r.paraphrase}`;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
