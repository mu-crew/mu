# Test health

Read when defining gates, choosing worker/reviewer verification, adding tests,
or doing upkeep at a milestone, a budget crossing, or the user's request.
Testing stays encouraged; upkeep protects coverage and the iteration loop.

## Gate contract

Use the repo's `## Gates` in AGENTS.md or README: fast and slow commands,
slow-gate budget (default 5 min), and a targeted slow-test command. Plan notes
point there. Until a split is approved, keep the existing repo gate intact;
recipe guidance does not waive project checks. Fast means iteration checks,
not a universal seconds promise: measure cold and warm costs.

- **Worker:** run the fast gate while iterating; before closing, run slow
  tests for the changed area once, then fast on the final commit. Record
  both, or why a scope is inapplicable/unavailable. Changes invalidate records.
- **Reviewer:** inspect the diff and reuse equivalent worker records. Run
  uncovered tests for the diff and reproduce claimed failures, rather than
  repeating the full suite or building the parent for every new test.
- **Orchestrator:** verify one pinned merged tree per batch with the full
  slow gate, plus fast if slow does not include it. All required integration,
  auth, release and packaging checks still pass before push. Bisect a failed
  batch; record the corrected tree's pass. See [merging](orchestrator-loop.md#merging).

Gate records are task-note text, not a mu command or stored result cache:

```text
GATE: commit=<sha> tree=<hash>; command=<exact command + filters>; scope=<full/area>
RESULT: exit=<code>; duration=<wall time>; counts=<tests/assertions>; skips=<none or reasons>
CONDITIONS: <toolchain, host/platform, privileges, relevant env/features, cache state>
```

Reuse requires the same tree, command/scope and equivalent execution
conditions. Record uncommitted inputs too; a dirty tree hash alone is not
an identity. A targeted pass, zero selected cases, or a skipped privileged
check is not a full pass. Clear/reject inherited selectors for full runs;
report skips explicitly and resolve required missing checks before push.

## Adding or changing tests

Use the lowest level that catches the failure, covering behaviour not
already guarded. A new slow case states what only it can see in a comment
or commit message. For a bug with a cheap, obvious local target, the worker
shows red on the base and green on the fix; feature work and integration-heavy
paths need no mandatory red-green ceremony. Use direct executable evidence
when stronger, recording the reason.

Poll readiness/completion with a bound and useful failure output. Retain
necessary temporal sampling, negative-observation windows and deliberately
sleeping process fixtures; explain their timing contract.

Reviewer findings identify risky untested/broken behaviour, a wrong test
level, duplication of a named test, avoidable readiness padding, or measured
gate slowdown—not every conceivable edge case without a test.

## Upkeep loop

Queue ordinary upkeep work at each phase/milestone end or when a merged slow
gate exceeds budget. Prioritise it before new features; continue independent
work. A budget is a scheduling trigger, not an indefinite crew-wide stop.

1. **Profile.** Time each gate step and test, including setup/teardown.
   List up to 20 slowest tests per level; inspect waits and repeated builds,
   cold caches and profiles. BEFORE records wall time, counts, skips and
   conditions. Use inspected execution logs, not commands merely mentioning
   a gate or compound-command durations attributed entirely to tests.
2. **Classify.** Parallel [delegate calls](tasks-or-calls.md#delegate-call),
   one per area, give slow/overlapping tests an evidenced verdict:
   KEEP; SPEED-UP (poll or share setup with isolation); MOVE-DOWN;
   MERGE into a named test; DELETE as covered by a named test.
3. **Refute.** Send every MERGE/DELETE verdict to a refuter: which failure
   would no longer be caught? A refuted or unresolved verdict becomes KEEP.
4. **Do.** Dispatch surviving changes as normal test-only tasks. Review
   coverage preservation, isolation and correctness of the harness changes.
   Preserve auth lanes, privilege checks and release scans; measure safe
   [build reuse](orchestrator-loop.md#build-cache) separately.
5. **Measure.** Run the merged gates and record AFTER under comparable
   conditions, including coverage/count changes. If neither faster nor
   smaller, say so and why; smaller alone does not prove preserved coverage.

Done when AFTER records the outcome and the slow gate is within budget, or
names the remaining bottleneck and prioritised follow-up. Keep unmet required
checks distinct from a time-budget overrun.
