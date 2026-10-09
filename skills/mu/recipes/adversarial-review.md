# Adversarial review

Use when a unit of work must be checked by someone other than its
author before it counts: a fix, a finding, a claim, a plan. The author
grades its own work generously; a fresh agent told to refute it does
not. Every other review-shaped recipe builds on this one.

The review is a task in the DAG, not a step inside the worker's
session. Its verdict, its evidence, and every gap it finds stay in the
DB: each gap is a finding task ([findings](findings.md)). For a one-off
check outside any workstream, one
[delegate call](tasks-or-calls.md#delegate-call) is enough; to review a
PR or diff from several angles, use [review-panel](review-panel.md).

## Steps

1. **Write the criteria first.** Before dispatching the work, note on
   the work task what "accepted" means: the requirements, the edge
   cases that need tests, the files that must not change. The reviewer
   judges against this note, not against its own taste.
2. **Add the review task, blocked by the work:**

   ```bash
   mu task add review_x -w <ws> -t "Review x" -i 50 -e 0.5 --blocked-by x \
     --note 'ACCEPTANCE: see x notes. Refute; report gaps, not style.'
   ```

3. **Dispatch the work** as usual. When `x` closes, `review_x` becomes
   ready.
4. **Spawn a fresh reviewer.** A new agent, or `--fresh` on an idle one,
   so it has none of the author's reasoning, at the worker's tier or
   higher and from another family ([models](models.md#checkers)). Give it the worker's workspace path
   and commits read-only by instruction; it edits nothing.
5. **Claim `review_x` for the reviewer**, send the brief (below), wait.
6. **Act on the verdict:**
   The review's state is the verdict: `CLOSED/done` for ACCEPT,
   `CLOSED/rejected` for REJECT.
   - `ACCEPT`: cherry-pick `x`'s commits and verify the merge.
   - `REJECT`: the reviewer recorded each gap as an `OPEN/triage` task.
     Add `review_x_2` and block it on every gap
     (`mu task block review_x_2 --by <gap>`); work downstream of `x`
     waits on `review_x_2`, not on the rejected review. Decide each gap
     as a finding ([findings § Triage](findings.md#triage)), then
     dispatch the accepted gaps to the original worker, whose context
     still holds the work. Repeat from step 4 when the gaps are closed.
     The DAG grows; nothing is rewritten.
7. **Cap the rounds.** After two rejections on the same unit, stop the
   loop and decide yourself: split the unit, change the criteria, or
   ask the human. A third round of the same argument rarely converges.

Done when the latest review task is `CLOSED/done` (ACCEPT), and the
accepted commits are merged and the merged tree passes the gate command.

## Reviewer brief

Send this with the task id, the workspace path, and the commit range:

```text
You are reviewing task <x>. You did not write it. Your job is to find
where it fails the acceptance criteria in `mu task notes <x>`.

- Read the diff (<range>) and the criteria. Run the tests that cover it.
- Report gaps against the criteria: a requirement not met, an edge case
  without a test, a change outside scope, a claim the evidence does not
  support. Not style, not preferences.
- Record each gap as a finding, per findings.md § Record:
  mu task add -w <ws> --triage -t "<severity>: <gap>" -i <n> -e <days> \
    --note 'FINDING: <severity> <file:line> <gap> EVIDENCE: <command + output>'
- If you could not check something (tool failed, no access), say
  UNVERIFIED for it. Unverified is not a pass and not a fail.
- Do not edit files.

Write the verdict note (FILES/COMMANDS/FINDINGS/VERIFIED), then close
(long reasons: a heredoc variable, brief.md § Quoting):
  ACCEPT: mu task close review_<x> --evidence "<key command>: <result>"
  REJECT: mu task close review_<x> --as rejected \
            --why "<n> gaps: <id> (<why it fails, one clause>), ..."
```

mu adds each named gap's title to the REJECTED note.

**Closing a review yourself** (you fixed a finding, or accept without a
fresh reviewer): write the reviewer's note plus `COMMIT: <sha> fixes
<finding>`, and name the check in `--evidence`. Not `one finding fixed
by orchestrator`.

## Traps

- **A reviewer that sees the author's reasoning agrees with it.** Send
  the diff and the criteria, not the worker's transcript or close note.
- **"Looks good" is not a verdict.** Require a close that matches the
  verdict (`done` or `--as rejected`) and at least one command the
  reviewer ran. A review with no evidence is a
  rejected review: re-send it.
- **Reviewers drift into fixing.** A reviewer that edits the code is now
  an author nobody reviews. The fix belongs to the gap tasks.
- **Review is not merge verification.** An accepted unit can still
  break once merged with moved main. Verify the merge as in
  [orchestrator-loop](orchestrator-loop.md#merging).
