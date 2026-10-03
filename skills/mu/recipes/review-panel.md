# Review panel

Use to review one diff, branch, or PR from several angles before it
ships: correctness, security, simplicity, tests, the repo's own rules.
One reviewer looking at everything finds the obvious; one reviewer per
angle, each in a fresh context, finds more. Findings are refuted before
anyone acts on them.

This is a sweep over one change. To gate each unit of a larger job,
use [adversarial-review](adversarial-review.md) instead.

## Steps

1. **Pin the target.** Record the exact range on an umbrella task:
   `git diff main...HEAD`, a PR number, or a commit range. Every
   reviewer reads the same range.
2. **One reviewer task per angle.** Pick the angles that apply:

   | Angle | Looks for |
   | --- | --- |
   | correctness | logic errors, edge cases, error paths, races |
   | security | injection, auth and permission checks, secrets, unsafe input |
   | simplicity | duplication, dead code, needless abstraction, an existing helper not reused |
   | tests | changed behaviour without a test, tests that cannot fail |
   | rules | the repo's `AGENTS.md` / contributing rules, one line per rule checked |

   Each reviewer gets the range, its angle, and the
   [brief](brief.md) rules; it edits nothing. Findings go in its note:

   ```text
   FINDING: s2 src/api/user.ts:88 high security: id from the URL reaches the query unescaped
   ```

   A reviewer that finds nothing closes with `FINDINGS: none` and the
   commands it ran.
3. **Dedupe** the findings across angles in one task.
4. **Refute each finding** with a fresh agent, as in
   [refute](refute.md) step 4. Low-severity style findings can skip this
   and go straight to the report.
5. **Act on confirmed findings:**
   - fix mode: one `fix_` task per finding or file cluster, each with
     its own review ([adversarial-review](adversarial-review.md));
   - report mode: a synthesis task writes one ranked list with
     file:line, the evidence, and a suggested fix.

Done when every finding id has a verdict, and either every confirmed
finding has a closed fix with an `ACCEPT` review, or the report lists
them all.

## Traps

- **Reviewers padding the list.** Tell them a clean result is a valid
  result. A panel that always finds ten things is guessing.
- **Use different models across angles** where you can; one model's
  blind spot repeated five times is still one blind spot.
- **The panel is not the gate.** Merge verification still runs on the
  merged tree ([orchestrator-loop](orchestrator-loop.md#merging)).
