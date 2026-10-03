# Find, refute, synthesize

Use for audits, bug sweeps, research, and fact-checks: anything that
produces findings or claims. Finders over-report; a separate agent told
to kill each finding filters what survives. Builds on
[fan-out](fan-out.md) and [adversarial-review](adversarial-review.md).

## Steps

1. **Split the search** into dimensions or slices (security, data
   integrity, one module each). One finder task per slice. Finders read;
   they do not fix.
2. **Finders write structured findings** to their task note, one line
   each:

   ```text
   FINDING: f3 src/routes/user.ts:42 high: handler skips the auth check on PUT
   ```

3. **Dedupe** before refuting: one task reads every finder note and
   merges duplicates, keeping the ids. Refuting the same bug twice pays
   twice.
4. **One refute task per finding**, blocked by the dedupe task. The
   refuter gets the finding and the code, not the finder's reasoning,
   and tries to prove it false: run it, find the guard, read the caller.
   It ends with one line:

   ```text
   VERDICT: f3 CONFIRMED | REFUTED | UNVERIFIED <evidence>
   ```

   For high-severity findings, run three refuters and keep the finding
   only if most fail to kill it.
5. **Synthesize**: a final task blocked by every refute task writes the
   report from the verdict lines. Confirmed findings, ranked. Unverified
   ones listed apart. Refuted ones counted, not shown.

Done when every finding id from step 3 has a verdict line, and the
synthesis task closed.

## Traps

- **UNVERIFIED is not REFUTED.** A refuter that hit a rate limit or
  could not run the code did not disprove anything. Keep the finding in
  its own section.
- **Cheap finders, strong refuters.** Finders can run on `pi_mini`;
  the refute step is where the judgement is (`pi_big`).
- **No findings is a result.** A slice that finds nothing closes with
  that in its note; do not re-run it until it finds something.
