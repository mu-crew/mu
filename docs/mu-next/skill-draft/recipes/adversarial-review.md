# Adversarial review

Use when a unit that produces commits must be checked by someone other than its author before it counts. Checking a claim is a delegate call ([findings](findings.md)).

1. **Criteria first**, on the work task: requirements, risky behaviour needing coverage, files that must not change.
2. **Gate**, blocked by the work:

   ```bash
   mu task add review_x -w <ws> -t "Review x" --blocked-by x --note 'ACCEPTANCE: see x notes. Refute; findings, not style.'
   ```

3. **Fresh reviewer**, a checker per [models](models.md). Send the diff range, criteria and gate records, not the worker's reasoning. Its only writes are findings, the verdict note and the close.
4. **Reviewer brief:** reproduce claimed failures; report unmet requirements, untested or broken behaviour, scope creep, unsupported evidence, each as a [finding](findings.md); `UNVERIFIED` for what it could not check. Close:
   - ACCEPT: `mu task close review_x --evidence "<command it ran>: <result>"`
   - REJECT: `mu task close review_x --as rejected --why "<n> findings: <ids>"`
5. **Act.** ACCEPT: cherry-pick `x`, verify the merge ([orchestrator-loop](orchestrator-loop.md)). REJECT: rejecting unblocked `x`'s dependents; add `review_x_2` blocked by every finding, re-block them on it, decide the findings, send accepted ones to the original worker, then a fresh reviewer.
6. **Two rejections of one unit end the loop**: split it, change the criteria, or ask the human.

- A review that ran no command is no verdict: re-send it.
- Only `UNVERIFIED` items is a report to the human, not a REJECT.
