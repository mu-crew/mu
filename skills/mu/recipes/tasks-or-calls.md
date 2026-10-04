# Tasks or calls

Use when a recipe step spawns an agent: decide whether that agent's job
is a **task** in the DAG or a **call** to a delegate. Getting it wrong
one way loses track of work; the other way, one PR review creates
hundreds of tasks and a workstream nobody wanted.

## Delegate call

A **delegate call** is one `mu_delegate` tool call in pi. Without the
tool (another harness, a script):

```bash
mu agent spawn refuter-1 -w scratch
runs=$(mu agent send refuter-1 -w scratch --fresh '<brief>' --json | jq .runs)
mu agent wait refuter-1 -w scratch --after-runs "$runs" --json   # answer in lastText
```

`--after-runs` takes the run count the send reported, so a run that
finished before the wait started still counts. A plain wait would sit
until `--timeout`.

- **It starts empty.** The brief carries everything: the finding or
  claim, file paths, the criteria, and the answer line to end with
  (`VERDICT: ...`, `WINNER: ...`). See [brief](brief.md).
- **Fan out in one turn.** Issue every call for a step together; in pi
  the answers arrive later as follow-up messages. Calling one, waiting,
  then the next runs them in series.
- **It leaves no task.** Its `scratch` pane stays attachable while it
  runs. `mu_delegate` closes it after a clean finish and keeps it on a
  crash, timeout, or API error (`keep: true` always keeps it); the bash
  form needs `mu agent close <name> -w scratch`. You record its verdict
  on the task it judged.
- **An API error is yours to decide.** Re-issue the call, or record the
  check as `UNVERIFIED` on its task, then close the kept pane
  (`mu_delegate_cancel`, or `mu agent close`).

## The rule

**A task is a thing the graph tracks. Checking a thing is a call.**

| Make it a task | Make it a delegate call |
| --- | --- |
| a unit of work that produces commits | refuting a finding |
| a gate that decides whether work counts (`review_x`) | checking a claim against its source |
| a finding, claim, or hypothesis that survives into the workstream | judging a pair in a tournament |
| the umbrella, and each round of a loop | a skeptic or dedupe pass |
| anything that needs its own workspace | a reader or scout whose output feeds one step |

A call writes nothing to mu. Its answer lands on the task it judged:
the orchestrator records the verdict as a note and a state change
(`mu task accept`, `close --as rejected --why '<evidence>'`). The graph
keeps the decision and its evidence without a node per check.

## Examples

- A refuter checks 30 findings: 30 delegate calls, 0 new tasks; each
  finding task gets the refuter's evidence and is accepted or closed.
- A tournament over 16 names: 15 judge delegate calls; the winner goes
  in the umbrella's note.
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
