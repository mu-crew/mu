# Review panel

Use to review one diff, branch, or PR from several angles before it
ships: correctness, security, simplicity, tests, the repo's own rules.
One reviewer looking at everything finds the obvious; one reviewer per
angle, each in a fresh context, finds more. Findings are refuted before
anyone acts on them.

This is a sweep over one change. To gate each unit of a larger job,
use [adversarial-review](adversarial-review.md) instead.

**Mode:** delegates by default: reviewing a PR, a doc, or a draft needs
an answer, not a permanent record. Switch to workstream mode when the
panel's findings will be fixed by agents. Both modes are in
[findings](findings.md).

## Steps

1. **Pin the target**: `git diff main...HEAD`, a PR number, or a commit
   range. Put it in every reviewer's brief (delegate mode) or on an
   umbrella task (workstream mode), so every reviewer reads the same
   range.
2. **One reviewer per angle**: a delegate in delegate mode, a task in
   workstream mode. Pick the angles that apply:

   | Angle | Looks for |
   | --- | --- |
   | correctness | logic errors, edge cases, error paths, races |
   | security | injection, auth and permission checks, secrets, unsafe input |
   | simplicity | duplication, dead code, needless abstraction, an existing helper not reused |
   | tests | changed behaviour without a test, tests that cannot fail |
   | rules | the repo's written rules (see [rules-audit](rules-audit.md)) |

   Each reviewer gets the range, its angle, and the [brief](brief.md)
   rules; it edits nothing. A clean result (`FINDINGS: none` plus the
   commands it ran) is a valid result.
3. **Record findings** by mode:
   - delegate: each reviewer ends its answer with `FINDING:` lines;
   - workstream: each finding is an `OPEN/triage` task blocking the
     umbrella ([findings § Record](findings.md#record)).
4. **Merge and refute.** Merge duplicates across angles, then refute
   with [delegate calls](tasks-or-calls.md#delegate-call) in both modes,
   following the skip and three-refuter rules in
   [findings § Triage](findings.md#triage).
5. **Act:**
   - delegate mode: post the comments or edit the doc from the merged
     list, citing file:line and evidence;
   - workstream mode: accept the confirmed findings, dispatch the
     fixes, each with its own review
     ([adversarial-review](adversarial-review.md)).

Done when every finding is acted on (delegate mode) or decided in
triage and the umbrella closes with `--if-ready` (workstream mode).

## Traps

- **Reviewers padding the list.** A panel that always finds ten things
  is guessing.
- **Vary models across angles** ([Models](../SKILL.md#models-and-thinking-effort)); one model's blind spot
  repeated five times is still one blind spot. In delegate mode pass
  `model` to `mu_delegate`; `cli` keys exist only if `$MU_<KEY>_COMMAND` is set.
- **The panel is not the gate command.** Merge verification still runs on the
  merged tree ([orchestrator-loop](orchestrator-loop.md#merging)).
