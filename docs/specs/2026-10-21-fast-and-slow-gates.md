# Fast and slow gates, and test upkeep as routine work

Status: approved design, not implemented. Battle-test on swaywardlock first (see [Rollout](#rollout)).
Date: 2026-10-21

## Problem

Crews slow down as a project grows, and the gate is where the time goes.
swaywardlock (repo `swayward-wm/swaywardlock`, started 2026-10-19) is the
clearest case. From 225 museum sessions over its first three days:

| | Oct 19 | Oct 20 | Oct 21 |
|---|---|---|---|
| `contrib/e2e-sway` lines | 273 → 980 | → 2,437 | → 3,587 |
| unit tests (`#[test]`) | 0 → 69 | → 165 | → 224 |
| test + harness share of the day's diff | 12% | 43% | 36% |
| median full `contrib/gate` run | 1–3 min | 2.3 → 5.9 min | 5.5 → 7.9 min |
| full gate runs | 88 | 152 | 92 (by 15:00) |
| hours spent in gate commands | 3.3 | 8.4 | 7.0 |

- A task got about 6 full gate runs (13 at most): about 4–5 by the
  worker and 2–3 by its reviewer, then a merge-time run by the
  orchestrator.
- A worker's median tool calls per session went from 45 to 95, and the
  gate's share of its wall time from 10–20% to 22–49%.
- Up to 4 gates ran at once on the same machine, which slows each one
  down.

**Tests are not the cost.** A representative gate log
(`scratch/review-e2e_scaffold_2/gate.log`) shows:
- the 214 unit tests take **0.96 s**
- a cold compile of 583 crates for dev, test and release takes about
  3 min, because every review worktree starts with an empty `target/`
- the rest is `contrib/e2e-sway`: 64 cases, 406 checks, and 178 fixed
  `sleep`s in the script

What kills progress is the slow, unprofiled part of the gate, run
redundantly and with nobody whose job is to look at it.

Our own rules caused part of this:
- `recipes/adversarial-review.md` lists "an edge case without a test" as
  a finding.
- The swaywardlock briefs told each worker to "re-run the gate" after
  every rebase, and each reviewer to re-run the full `contrib/gate`,
  then build the parent in a second worktree to prove every new test
  fails there.
- Nothing in any recipe ever removes, merges, moves or speeds up a test.

## Goal

Testing stays encouraged. What changes is where tests live, how often
the expensive ones run, and that looking after the test suite becomes
normal project work instead of something that never happens.

## Concepts

- **Fast gate.** The checks anyone runs at any time, in seconds: format,
  lint, unit tests, and cheap integration tests. A worker runs it every
  time it iterates.
- **Slow gate.** Everything else the merge needs: e2e against a real
  environment (headless compositor, real PAM), release builds, packaging
  checks. Run once per tree, by whoever has to.
- **Gate budget.** The slow gate's target wall time, written next to the
  gate commands. The default is 5 min, and the project can change it.
- **Gate record.** `GATE fast|slow ok @ <git tree sha> (<seconds>s)` in a
  task note. A matching tree hash means the run counts. Nobody re-runs a
  gate on a tree that already has a record.
- **Test upkeep.** Profile the gate, then speed up, move down a level,
  merge or delete tests, so the gate stays inside its budget. It is
  ordinary work in the DAG, not a cleanup that happens when someone
  remembers.
- **Test level.** Unit < integration < e2e. A test belongs at the lowest
  level that can catch the failure it guards against.

## Decisions

1. **The gates are defined in the repo.** The project defines its gates
   in AGENTS.md (or the README), in a `## Gates` section: the fast
   command, the slow command, the budget, and how to run one slow test,
   e.g. `TESTS=preview contrib/e2e-sway`. Workstream plan notes point to
   it. Recipes say "the fast gate" and "the slow gate" instead of "the
   gate command".
   *Why:* gates outlive workstreams. A plan note copy goes out of date.
2. **Who runs which gate:**
   - **Worker:** the fast gate while iterating. Before closing, the
     slow tests for its own area once, then the fast gate on the final
     commit, and records both.
   - **Reviewer:** reuses the worker's gate record when the tree hash
     matches. It runs only the tests that cover the diff, and reproduces
     a finding when one is claimed. It no longer runs the full gate or
     builds the parent to show a test fails there.
   - **Orchestrator:** the full slow gate once per merge batch, on the
     merged tree. When it fails, it bisects the batch.

   *Why:* this takes the full slow gate from about 6 runs per task to
   about 1 per batch. The merged-tree run backstops any worker whose
   record is wrong. In swaywardlock about 10 of the full runs I could
   classify failed, so a batch rarely needs bisecting.
3. **Red-green only for bug fixes.** A fix shows the test failing on the
   base and passing on the fix, and the worker shows it, not the
   reviewer. Feature work does not have to show a test failing first.
4. **Rules for adding a test:**
   - it goes at the lowest level that can catch the failure
   - it covers behaviour no existing test covers
   - a new slow-gate case states what only it can see, in a comment or
     the commit message
   - waits poll for the condition, never sleep a fixed time
5. **Reviewer findings about tests** change from "an edge case without a
   test" to:
   - a risky behaviour that is untested, or broken
   - a test at the wrong level
   - a test that duplicates test X
   - a new fixed sleep
   - a gate that got noticeably slower in this diff
6. **Build cache across workspaces.** A recipe section covers sharing
   build output between worktrees: sccache or a shared
   `CARGO_TARGET_DIR` (or the same idea for other build systems), and
   warming a new workspace from main's build output. It is not a mu
   feature yet.
   *Why:* about 3 min of every swaywardlock gate was cold compilation,
   and that is the cheapest thing to fix.
7. **When test upkeep happens.** A test upkeep task is queued:
   - when a merged slow gate goes over its budget (it comes before any
     new feature work)
   - at the end of every phase or milestone
8. **Gate timing is visible.** The gate prints how long each step takes
   and names its slowest tests. The orchestrator adds the slow gate's
   duration to its merge note, so the trend is visible in `mu log`
   without any new tooling.
9. **No `mu gate` command yet.** Gate records are note text. Add a
   command only if agents keep re-running gates despite the records.

## The `test-health` recipe (new)

`skills/mu/recipes/test-health.md`. It runs when a decision 7 trigger
fires, or when the user asks.

1. **Profile.**
   - Time every gate step.
   - List the 20 slowest tests at each level.
   - Count the fixed sleeps in slow tests.
   - Find build work that runs more than once: cold caches, duplicate
     profiles, the same build in dev and release.
   - Record the gate's wall time and test counts as a BEFORE note.
2. **Classify.** One finder per area (parallel delegate calls). Each
   slow or overlapping test gets one verdict:
   - KEEP
   - SPEED-UP: poll instead of sleep, share the setup
   - MOVE-DOWN: rewrite at a lower level
   - MERGE: fold into another test, which it names
   - DELETE: covered by the test it names
   Every verdict comes with its evidence.
3. **Refute.** Every MERGE and DELETE goes to a refuter: "which failure
   would no longer be caught?" A refuted verdict becomes KEEP.
4. **Do.** The surviving verdicts run as normal tasks. They are
   test-only diffs, and their review checks only that the coverage the
   refuter accepted is still there.
5. **Measure.** Run the slow gate again and record an AFTER note. A pass
   that leaves the gate neither faster nor smaller did not do its job:
   say so, and say why.

Done when the AFTER note is recorded, and the slow gate is within its
budget or the note says what still keeps it over.

## Changes

| File | Change |
|---|---|
| `skills/mu/SKILL.md` | Vocabulary: replace the single gate command with fast gate / slow gate / gate budget / gate record / test upkeep. Orchestrator rules: one slow gate per merge batch; queue test-health when a trigger fires. |
| `skills/mu/recipes/test-health.md` | New, as above. |
| `skills/mu/recipes/adversarial-review.md` | Reviewer brief: reuse gate records; run only the tests for the diff; the new test findings (decision 5). |
| `skills/mu/recipes/worker.md`, `recipes/brief.md` | Who runs which gate (decision 2); the gate record line in the DONE note; red-green only for fixes; rules for adding a test. |
| `skills/mu/recipes/orchestrator-loop.md` § Merging | Batch merge, then one slow gate, then bisect when it fails. Add the slow gate's duration to the merge note. Section on sharing the build cache. |
| `skills/mu/recipes/waves.md`, `review-panel.md`, `remote-workers.md` | "Gate command" → "slow gate" where they mean the merge gate. |
| `skills/mu/recipes/plan.md` | A new project's plan defines `## Gates` in the repo first. Every phase ends with a test-health task. |

Out of scope: a `mu gate` command, caching gate results in the mu DB,
and test-coverage tooling.

## Rollout

1. **Battle-test on swaywardlock** before editing any recipe:
   - add `## Gates` to its AGENTS.md
   - split `contrib/gate` into fast and slow modes, with timing per step
   - set up a shared build cache
   - run `test-health` by hand, from this spec
   - write down where the spec was wrong
2. Write the recipe changes from what we learned.
3. **Measure** with `museum-search stats` (museum spec
   `2026-10-21-session-stats.md`): full gate runs per task, gate share
   of worker time, slow gate duration. Compare swaywardlock Phase 3 with
   the next phase.

## Open questions

- Where the line between the fast and slow gate falls when a project has
  a cheap integration test that needs a daemon. Settle it on
  swaywardlock, where `contrib/test-real-pam` and the converter tests
  are candidates for either side.
- Whether the gate record should carry the commit sha as well as the
  tree hash, for readability. It costs nothing, so probably yes.
