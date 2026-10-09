# Ultrathink

Use when a task is too large or too risky for one context: a migration
across many files, a repo-wide audit, a hard bug, a design with real
alternatives, any long autonomous run where you will not read every
line. Ultrathink composes the other recipes. Every unit, gate, finding
and round is a task in the DAG, so the run is as visible as the code it
produces; the checks on them are delegate calls whose verdicts land on
those tasks.

It costs many agents and many tokens. For a change one agent can hold
and check, skip it.

## Steps

1. **Define done.** Write the goal and the stop rule on an umbrella task:
   the command that must pass, the report that must exist, the criteria
   a reviewer will apply. Ask the human now for anything only they can
   decide (scope, budget, external actions); after this step, keep
   driving.
2. **Understand before you change.** If the shape of the work is not
   known, run a scout ([delegate call](tasks-or-calls.md#delegate-call))
   or a [fan-out](fan-out.md) of readers first. Their
   output is the unit list and the facts the plan needs, in notes.
3. **Pick the shape** for the main phase:

   | The work is | Recipe |
   | --- | --- |
   | the same change over many units | [fan-out](fan-out.md) |
   | finding problems or checking claims | [refute](refute.md) |
   | a cause to find | [hypothesis-panel](hypothesis-panel.md) |
   | a choice between real alternatives | [tournament](tournament.md) |
   | an unknown amount, until a check passes | [loop-until-done](loop-until-done.md) |
   | a backlog of external items | [backlog-triage](backlog-triage.md) |
   | a question across many sources | [deep-research](deep-research.md) |
   | one change to review from every angle | [review-panel](review-panel.md) |
   | a change against the repo's written rules | [rules-audit](rules-audit.md) |

   Phases chain: an audit (refute) feeds a fix sweep (fan-out); a
   tournament picks the design a fan-out then implements.
4. **Plan the whole phase as tasks** before spawning: every unit,
   blocked into the umbrella, each note written as a
   [brief](brief.md) ([plan](plan.md) for a spec-driven build). Rounds
   of a loop are the one exception: add each when the last closes.
5. **Review every unit that ships.** Each commit-producing task gets a
   review task ([adversarial-review](adversarial-review.md)) on a
   [comparable model](models.md#checkers). Every finding is a triage task,
   refuted before it is accepted ([findings](findings.md)).
6. **Run the loop** ([orchestrator-loop](orchestrator-loop.md)): pipeline
   merges, verify each merge, keep workers busy
   ([waves](waves.md) when they share files). Long runs follow
   [long-run](long-run.md). With codemode, a
   [driver](codemode-driver.md) can dispatch a wave.
7. **Close against the stop rule**, checked by you on the merged tree,
   not by any worker's note. Then
   `mu task close <umbrella> --if-ready --evidence '...'`.

Done when the umbrella is closed, its stop rule holds on the merged
tree, every shipped unit's latest review task is `CLOSED/done`
(ACCEPT), and
`mu task list --substate triage` is empty or only `UNVERIFIED`.

## Budget

- Agree a ceiling in step 1 and write it on the umbrella
  ([orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency)).
- Checks are calls, not tasks ([tasks-or-calls](tasks-or-calls.md)): a
  50-unit run should add about 50 units, 50 gates and the findings that
  survive, not a task per refuter and judge.
- The run gets its own workstream, `<project>-ut-<topic>`, torn down
  when the umbrella closes ([recovery](recovery.md) before teardown).
- Tiers per phase ([models](models.md#roles)): cheap scouts and finds,
  mid builds, strong plans and synthesizes; each checker at the tier of
  whoever wrote what it checks, or higher, another family. Calibrate the
  tier split on the slice, not only the cost.
- Calibrate on a slice: run the phase on a few units, check the result
  and the cost, then fan out the rest.

## What the human sees

`mu state` shows every unit, its reviewer, and what is still running.
`mu task notes <id>` shows why any unit was accepted or rejected. A
rejected unit stays in the DAG next to its fix. Nothing about the run
lives only in your context.
