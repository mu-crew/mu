# Adversarial review

Use when a unit of work must be checked by someone other than its
author before it counts: a fix, a finding, a claim, a plan. The author
grades its own work generously; a fresh agent told to refute it does
not. Every other review-shaped recipe builds on this one.

The review is a task in the DAG, not a step inside the worker's
session. Its verdict, its evidence, and every gap it finds stay in the
DB: each gap is a finding task ([findings](findings.md)). For a one-off
check outside any workstream, a delegate reviewer is enough.

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
   so it has none of the author's reasoning. Use a different model from
   the worker where you can (`--cli pi_big` reviewing `pi`): a second
   model has different blind spots. Give it the worker's workspace path
   and commits read-only by instruction; it edits nothing.
5. **Send the reviewer brief** (below), claim `review_x` for it, wait.
6. **Act on the verdict:**
   - `ACCEPT`: cherry-pick `x`'s commits and verify the merge.
   - `REJECT`: the reviewer already recorded each gap as an
     `OPEN/triage` task. Add `review_x_2`, blocked by every gap task.
     Accept the gaps (or close the ones that are wrong `--as rejected`)
     and dispatch them to the original worker, whose context still
     holds the work. Repeat from step 4 when the gaps are closed. The
     DAG grows; nothing is rewritten.
   - The author checks each gap before fixing it: reproduce it, then
     fix it and close the gap task, or answer it with evidence
     (`mu task note <gap> 'not reproducible: <command + output>'`) and
     release it. A disputed gap stays open for the next reviewer to
     decide, not settled by the author.
7. **Cap the rounds.** After two rejections on the same unit, stop the
   loop and decide yourself: split the unit, change the criteria, or
   ask the human. A third round of the same argument rarely converges.

Done when the latest review task closed with `VERDICT: ACCEPT`, and the
accepted commits are merged and the merged tree passes the gate.

## Reviewer brief

Send this with the task id, the workspace path, and the commit range:

```text
You are reviewing task <x>. You did not write it. Your job is to find
where it fails the acceptance criteria in `mu task notes <x>`.

- Read the diff (<range>) and the criteria. Run the tests that cover it.
- Report gaps against the criteria: a requirement not met, an edge case
  without a test, a change outside scope, a claim the evidence does not
  support. Not style, not preferences.
- Record each gap as a finding task blocking review_<x>:
  mu task add -w <ws> --triage -t "<severity>: <gap>" -i <n> -e <days> \
    --note '<file:line or command + output>'
  then: mu task block review_<x> -w <ws> --by <gap-id>
- If you could not check something (tool failed, no access), say
  UNVERIFIED for it. Unverified is not a pass and not a fail.
- Do not edit files.

End with a note in the task note contract, plus one line:
VERDICT: ACCEPT | REJECT
Then close: mu task close review_<x> --evidence '<verdict + key check>'
```

## Traps

- **A reviewer that sees the author's reasoning agrees with it.** Send
  the diff and the criteria, not the worker's transcript or close note.
- **"Looks good" is not a verdict.** Require the `VERDICT:` line and at
  least one command the reviewer ran. A review with no evidence is a
  rejected review: re-send it.
- **Reviewers drift into fixing.** A reviewer that edits the code is now
  an author nobody reviews. The fix belongs to the gap tasks.
- **Review is not merge verification.** An accepted unit can still
  break once merged with moved main. Verify the merge as in
  [orchestrator-loop](orchestrator-loop.md#merging).
