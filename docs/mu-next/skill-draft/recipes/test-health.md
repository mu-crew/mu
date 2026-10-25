# Test health

Use when you define gates, verify a merge, add tests, or a merged slow gate exceeds its budget.

## Gate contract

Read the repo's `## Gates` (AGENTS.md or README): fast, slow and targeted commands, the slow budget. Never waive a repo check.

- **Worker:** fast while iterating; before close, slow tests for the changed area, then fast on the final commit. Record both, or why one is inapplicable.
- **Reviewer:** reuse equivalent worker records; run only what they leave uncovered.
- **Orchestrator:** one pinned merged tree per batch gets the full slow gate, plus fast if slow omits it, before push.

Record a gate in a task note:

```text
GATE: commit=<sha>; command=<exact command + filters>; scope=<full|area>
RESULT: exit=<code>; duration=<wall>; counts=<tests>; skips=<none|reasons>
CONDITIONS: <toolchain, host, env, cache state>
```

Reuse needs the same tree, command, scope and conditions. A targeted pass, zero selected cases or a skipped required check is not a full pass.

A new test sits at the lowest level that catches the failure.

## Upkeep

At a milestone or budget crossing, without stopping independent work:

1. Profile each gate step and the 20 slowest tests (BEFORE: time, counts, skips).
2. One delegate call per area: KEEP, SPEED-UP, MOVE-DOWN, MERGE or DELETE.
3. A refuter checks each MERGE/DELETE: which failure goes uncaught? Unresolved means KEEP.
4. Dispatch survivors as test-only tasks with review.
5. Re-measure (AFTER); smaller alone proves no coverage.
6. Commit `docs/test-health/<date>.md`: BEFORE/AFTER, verdicts, the remaining bottleneck.
