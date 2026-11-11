// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Failed probe rows (f_rig_infra_retry_2). Under load (~250) a probe row can fail for the host's
// sake: a sandbox that never came up, a seed call that exits on git's or tmux's stderr (or with
// none), a lead-in step killed by the shell limit. Scored as recorded, one such row marks the
// variant OUT as "invalid lead-in". So every failed row is retried up to 2 times (each try under
// its own claim, after a backoff). A row that still fails is invalid as before: the variant's own
// failure. Only when base's row of the same pairing (case, model, arm, paraphrase, rep) also failed
// every try does scoring drop that pairing from both sides (tournament-score.ts): the host, not the
// variant. Stderr never decides; `host` is a label for the report.
import type { ProbeRow } from "./nextstep.ts";

/** Retries after the first try. */
export const INFRA_RETRIES = 2;
/** Wait before retry 1 and 2: load spikes last tens of seconds. */
export const INFRA_BACKOFF_MS: readonly number[] = [15_000, 60_000];
/** Above this share of a variant's clusters dropped, the variant is undecided: no win. */
export const MAX_DROPPED_SHARE = 0.1;

/** stderr the host writes (tmux, git fatals, process limits, the sandbox): a report label only. */
export const INFRA_STDERR =
  /\btmux\b|\bfatal: |index\.lock|\bsandbox\b|EAGAIN|Resource temporarily unavailable|\bfork: |Cannot allocate memory|Too many open files|no server running|server exited|lost server/i;

export interface Failure {
  reason: string;
  /** Label: the failure names the host (tmux, git, sandbox). Never decides exclusion. */
  host: boolean;
}

const SEED_FAIL = /^seed invalid: (?:seed|sh) failed \((-?\d+)\)/;

/** Why a row failed (the rig threw, a seed call exited non-zero, a lead-in step timed out), or null. */
export function rowFailure(
  row: Pick<ProbeRow, "why"> & Partial<Pick<ProbeRow, "rigError" | "leadInFault">>,
): Failure | null {
  if (row.rigError !== undefined) return { reason: row.rigError, host: true };
  for (const w of row.why) {
    if (!SEED_FAIL.test(w)) continue;
    return { reason: w.slice(0, 300), host: INFRA_STDERR.test(w) };
  }
  if (row.leadInFault !== undefined)
    return { reason: row.leadInFault, host: INFRA_STDERR.test(row.leadInFault) };
  return null;
}

/** A lead-in record's fault: a step killed at the shell limit that did not ask to be killed. */
export function leadInFault(
  recs: readonly { cmd: string; killed: boolean; limitMs: number }[],
  expectKill: readonly boolean[],
): string | undefined {
  for (const [i, r] of recs.entries())
    if (r.killed && expectKill[i] !== true)
      return `lead-in step ${i + 1} timed out after ${Math.round(r.limitMs / 1000)} s: ${r.cmd.slice(0, 120)}`;
  return undefined;
}

export interface RetryOpts {
  retries?: number;
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Run `attempt` (one row under its own claim) until its row has not failed, at most 1 + retries
 * times. The row gets `infraRetries` when it retried, and when every try failed `infraFail` (the
 * reason), `infraHost` (the label) and `invalid`.
 */
export async function withInfraRetry(
  attempt: () => Promise<ProbeRow>,
  o: RetryOpts = {},
): Promise<ProbeRow> {
  const retries = o.retries ?? INFRA_RETRIES;
  const backoff = o.backoffMs ?? INFRA_BACKOFF_MS;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let row = await attempt();
  let f = rowFailure(row);
  let n = 0;
  while (f !== null && n < retries) {
    o.log?.(`retry ${n + 1}/${retries} (${row.surface} ${row.case}): ${f.reason.split("\n")[0]}`);
    await sleep(backoff[n] ?? backoff[backoff.length - 1] ?? 0);
    n++;
    row = await attempt();
    f = rowFailure(row);
  }
  if (n > 0) row.infraRetries = n;
  if (f !== null) {
    row.invalid = true;
    row.infraFail = f.reason.split("\n").slice(0, 3).join(" | ").slice(0, 300);
    row.infraHost = f.host;
  }
  return row;
}

/** A row's pairing: base's row with the same key is the one it is compared beside. */
export const pairing = (
  r: Pick<ProbeRow, "case" | "model" | "arm" | "paraphrase" | "rep">,
): string => `${r.case}|${r.model}|${r.arm}|${r.paraphrase}|${r.rep}`;

/** A row's cluster across reps: the unit of the undecided share. */
export const clusterOf = (r: Pick<ProbeRow, "case" | "model" | "arm" | "paraphrase">): string =>
  `${r.case}|${r.model}|${r.arm}|${r.paraphrase}`;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
