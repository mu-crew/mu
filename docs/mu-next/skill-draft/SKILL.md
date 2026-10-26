---
name: mu
description: >-
  Fresh-context delegates and crews in tmux/herdr panes. Check before you
  commit: have a `mu_delegate` call refute a claim, root cause, plan, fix or
  brief before you act on it. Also parallel read-only research, fan-out,
  background helpers, and persistent crews with a task DAG, review gates and
  merges. Outside pi, delegate through the `scratch` workstream.
---

# mu

Agents in tmux/herdr panes, coordinated by a SQLite task DAG. **`mu --help` and
`mu <verb> --help` outrank this skill**; a verb they omit does not exist. A verb takes
`-w <workstream>` only if its `--help` lists it (`doctor`, `sync`, `delegates
show` do not); workers: injected.

`--json` returns `{ok,data,next}`; errors come on stdout as
`{ok:false,error,message,next,exit}`. TODO(v_hints): `next` is null today; hints
are in `data.nextSteps` (errors: top-level `nextSteps`). Collections are
`{items,count}`; `agent list` is `{workstreamName,agents,orphans}`. Keys are SQL
column names; `id` is the task's name. A capped reader names its way back
(`more=N next=<command>`).

- **umbrella**: the parent task of a job, blocked by every unit; holds brief,
  criteria and stop rule. Close it with `--if-ready`.
- **finding**: an `OPEN/triage` task. **verdict**: `VERDICT: <id>
  CONFIRMED|REFUTED|UNVERIFIED <line>` plus `EVIDENCE:`.
- `mu task block A --by B`: B blocks A. Chain tasks that edit the same files.

## Orchestrator rules

<!-- mu:keep-driving -->
**While workers run, keep driving.** Your turn ends only when everything you own
is closed, or only a human can decide (scope, spend, irreversible or external
action, hardware-key handback): record it with `mu human-needed -w <ws>
"<reason>"`, then stop. A status summary is a `mu log` line, not a stopping
point: one per wave, then back to waiting. An error never means a
human is needed. Ending a turn mid-run stalls the crew.
<!-- /mu:keep-driving -->

Read [orchestrator-loop](recipes/orchestrator-loop.md) before you dispatch.
These hold even if you skip it:

- **Claim before work is sent.** `agent spawn --task <id> --send ...` does both.
- **Wait with `mu task wait`, never `sleep` loops** (flags and exits:
  [orchestrator-loop](recipes/orchestrator-loop.md)).
- **A send that timed out is unknown, never resent**: `mu agent check <a> <msgId>`.
- **New work to pi: `send --fresh`.** A running worker never sees a note: send
  ([modes](recipes/orchestrator-loop.md#sending)).
- **`unknown` is not dead.** Read the pane and `mu doctor` before you release.
- **Only `CLOSED/done` ships.** Verify the merged tree.
- **Checks are calls, not tasks** ([tasks-or-calls](recipes/tasks-or-calls.md)).
  Before you act on a claim, cause, plan, fix or brief, have a recorded call
  refute it; rewrite on REFUTED.
- **Findings are tasks** ([findings](recipes/findings.md)); each shipping unit gets a
  [review gate](recipes/adversarial-review.md).
- **Stop rule on the umbrella first.**
- **Edit or build: `--worktree`.** Never make your own.

## Gotchas

- `close --as rejected|wontfix --why` unblocks dependents; `park --why` keeps them waiting.
- Prose goes through `-` and a quoted heredoc ([brief](recipes/brief.md)).
- Checker tier and family, and which model: [models](recipes/models.md).
- Teardown, rebuild, sync, `doctor` DRIFT: [recovery](recipes/recovery.md) first.
- Claimed for you: [worker](recipes/worker.md). Remote host:
  [remote-workers](recipes/remote-workers.md).

## Recipes

| Recipe | Read when |
| --- | --- |
| [orchestrator-loop](recipes/orchestrator-loop.md) | you dispatch and merge |
| [brief](recipes/brief.md) | you write what a worker reads |
| [tasks-or-calls](recipes/tasks-or-calls.md) | a step spawns an agent |
| [findings](recipes/findings.md) | a check reports problems |
| [adversarial-review](recipes/adversarial-review.md) | a unit needs a gate |
| [test-health](recipes/test-health.md) | you set gates or verify a merge |
| [models](recipes/models.md) | you pick a model |
| [remote-workers](recipes/remote-workers.md) | an agent runs on another host |
| [recovery](recipes/recovery.md) | teardown, rebuild, sync |
| [worker](recipes/worker.md) | a task was claimed for you |
| [course-correct](recipes/course-correct.md) | a job has run a day, or ~10 units merged |
