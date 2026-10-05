# Tasks or calls

Use when a recipe step spawns an agent: decide whether that agent's job
is a **task** in the DAG or a **call** to a delegate. Getting it wrong
one way loses track of work; the other way, one PR review creates
hundreds of tasks and a workstream nobody wanted.

## Delegate call

A **delegate call** is one `mu_delegate` tool call in pi.

- **It starts empty.** The brief carries everything: the finding or
  claim, file paths, the criteria, and the answer to end with. See
  [brief](brief.md). A tournament judge ends with `WINNER: ...`
  ([tournament](tournament.md)). A refuter or claim checker passes
  `record: { task: "<ws>/<id>" }` and ends with:

  ```text
  VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <one line>
  EVIDENCE: <file:line or command + result>   (3-6 lines)
  ```

- **Fan out in one turn.** Issue every call for a step together; in pi
  the answers arrive later as follow-up messages. Calling one, waiting,
  then the next runs them in series.
- **Its `scratch` pane** stays attachable while it runs; `mu_delegate`
  closes it after a clean finish and keeps it on a crash, timeout, or
  API error (or always, with `keep: true`).
- **An API error is yours to decide.** Re-issue the call, or record the
  check as `UNVERIFIED` on its task, then close the kept pane
  (`mu_delegate_cancel`, or `mu agent close`).

Without the tool, write the note `record` would, before deciding:

```bash
mu agent spawn refuter-1 -w scratch
runs=$(mu agent send refuter-1 -w scratch --fresh - --json <<'EOF' | jq .runs
<brief, ending with the VERDICT block>
EOF
)
mu agent wait refuter-1 -w scratch --after-runs "$runs" --json   # answer in lastText
mu task note <id> -w <ws> - <<'EOF'
REFUTER 1 (refuter-1, 4m 05s):
<the VERDICT line and EVIDENCE lines, verbatim>
EOF
mu agent close refuter-1 -w scratch
```

A wait that times out or dies leaves `REFUTER 1: no verdict (<outcome>)`.
`--after-runs` counts a run that finished before the wait started; the
quoted heredocs keep the evidence verbatim ([brief § Quoting](brief.md#quoting)).

## The rule

**A task is a thing the graph tracks. Checking a thing is a call.**

| Make it a task | Make it a delegate call |
| --- | --- |
| a unit of work that produces commits | refuting a finding |
| a gate that decides whether work counts (`review_x`) | checking a claim against its source |
| a finding, claim, or hypothesis that survives into the workstream | judging a pair in a tournament |
| the umbrella, and each round of a loop | a skeptic or dedupe pass |
| anything that needs its own workspace | a reader or scout whose output feeds one step |

A call adds no node: its note and your decision land on the task it
judged ([findings § Triage](findings.md#triage)).

## Examples

- 30 findings to refute: 30 delegate calls, 0 new tasks; each finding
  gets a `REFUTER` note, then your decision.
- A tournament over 16 names: 15 judge calls; each round's `WINNER:`
  lines go on the umbrella.
- A hypothesis test that reverts commits or forces a race needs a
  workspace: that one is a task.

## Counting

Before a wave, count what it will add: units + gates + expected
findings. If the count is more than a few hundred for one change, the
steps that only check things are probably tasks by mistake.

`mu_delegate` runs 16 at once (`MU_DELEGATE_MAX`) and queues the rest
up to four times the cap; see
[orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency).

Done when every agent a recipe step spawns is either a task in the DAG
or a delegate call whose verdict is recorded on a task.
