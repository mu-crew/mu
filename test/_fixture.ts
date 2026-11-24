// Unique fixture names for tests. A static name like `mu-alpha` collides when two
// `npm test` runs share a tmux server (`duplicate session` / `can't find session`),
// so a name encodes pid + timestamp + random base36 under a short prefix
// (workstream names cap at 32 chars):
//
//   workstream = freshWorkstream("wait");   // -> "wait-l8z-mwj1k7-7d2"
//   session = `mu-${workstream}`;
//
// Pair it with pollUntil() from ./_env.js instead of fixed sleeps.

/**
 * Produce a workstream name that's unique across:
 *
 *   - this process (random suffix; nanosecond timestamp is overkill).
 *   - concurrent processes (`process.pid` keeps two `npm test` runs
 *     on the same machine from colliding).
 *   - cross-machine reuse if the same temp DB ever escaped (random
 *     suffix is the belt; pid is the suspenders).
 *
 * The resulting name fits in the 32-char workstream-name DB column
 * (we deliberately keep the generated suffix short — 3 + 1 + 6 + 1 +
 * 6 = 17 chars worst-case, leaving 15 for the caller's prefix).
 *
 * The suffix budget is ENFORCED, not assumed: both the pid and the
 * timestamp are truncated to their low-order base36 chars. A raw
 * `Date.now().toString(36)` is 8 chars and a raw pid can be 5, which
 * silently blew the budget — prefix "claim" produced a 27-char name,
 * so callers appending their own suffix (e.g. `${ws}-other`) tripped
 * the /^[a-z][a-z0-9_-]{0,31}$/ workstream-name regex. The low-order
 * chars carry the entropy; the high-order ones are near-constant
 * across a test run anyway.
 *
 * NOTE: tmux session-name length is also bounded; the user-visible
 * `mu-` prefix adds 3, so the effective cap is 29 — still more than
 * the 17 we generate. Any prefix longer than ~12 chars and you risk
 * truncation surprises elsewhere; keep prefixes terse.
 */
export function freshWorkstream(prefix: string): string {
  const pid = process.pid.toString(36).slice(-3);
  // Low 6 base36 chars of the ms clock ≈ a 25-day rolling window —
  // far longer than any test run, and it is paired with pid + rand.
  const ts = Date.now().toString(36).slice(-6);
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `${prefix}-${pid}-${ts}-${rand}`;
}
