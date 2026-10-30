---
name: mu
description: >-
  Fresh-context delegates and crews in tmux/herdr panes. Check before you
  commit: have a `mu_delegate` call refute a claim, root cause, plan, fix or
  brief before you act on it. Also parallel read-only research, fan-out,
  background helpers, and persistent crews with a task DAG, review gates and
  merges. Outside pi, delegate through the `scratch` workstream. Never write
  mu's DB (no `sqlite3`, no raw SQL writes): read it with `mu sql "<SELECT>"`,
  change it with a verb.
---

# mu

Agents in tmux/herdr panes, coordinated by a SQLite task DAG. **`mu --help` and
`mu <verb> --help` outrank this skill**; a verb they omit does not exist. A verb takes
`-w <workstream>` only if its `--help` lists it (`doctor`, `sync`, `delegates
show` do not); workers get it.

- **umbrella**: a job's parent task, blocked by every unit; holds brief, criteria, stop rule.
- **finding**: an `OPEN/triage` task. **verdict**: `VERDICT: <id>
  CONFIRMED|REFUTED|UNVERIFIED <line>` plus `EVIDENCE:`.
- `mu task block A --by B`: B blocks A. Chain tasks sharing files.

## Orchestrator rules

<!-- mu:keep-driving -->
**While workers run, keep driving.** Your turn ends only when everything you own
is closed, or only a human can decide (scope, spend, irreversible or external
action, hardware-key handback): record it with `mu human-needed -w <ws>
"<reason>"`, then stop. A to-do for the human that blocks nothing ("tag it",
"the rollout week") is `--no-stop`. A status summary is a `mu log` line, not a stopping
point: one per wave, then back to waiting. An error never means a
human is needed. Ending a turn mid-run stalls the crew.
<!-- /mu:keep-driving -->

Read [orchestrator-loop](recipes/orchestrator-loop.md) before you dispatch. Always:

- **Claim before work is sent.** `agent spawn --task <id> --send ...` does both.
- **Wait with `mu wait`, never `sleep` loops** (exits:
  [orchestrator-loop](recipes/orchestrator-loop.md)).
- **A send that timed out is unknown, never resent**: `mu agent check <a> <msgId>`.
- **New work to pi: `send --fresh`.** A running worker never sees a note: send
  ([modes](recipes/orchestrator-loop.md#sending)).
- **`unknown` is not dead.** Read the pane and `mu doctor` first.
- **Only `CLOSED/done` ships.** Verify the merge.
- **Checks are calls, not tasks** ([tasks-or-calls](recipes/tasks-or-calls.md)).
  Before you act on a claim, cause, plan, fix or brief, have a recorded call
  refute it; rewrite on REFUTED.
- **Findings are tasks** ([findings](recipes/findings.md)); each shipping unit gets a
  [review gate](recipes/adversarial-review.md).
- **Stop rule on the umbrella first.**
- **`course check due` stops dispatch**: finish merging, then
  [course-correct](recipes/course-correct.md) to its `mu human-needed`.
- **Edit or build: `--worktree`.** Never make your own.

## Gotchas

- `close --as rejected|wontfix --why` unblocks dependents; `park --why` keeps them waiting.
- Prose goes through `-` and a quoted heredoc ([brief](recipes/brief.md)).
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
| [course-correct](recipes/course-correct.md) | a `course check due` hint, or a human asks |
| [move](recipes/move.md) | a human asks to move a 3.x workstream |
