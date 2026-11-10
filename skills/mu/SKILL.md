---
name: mu
description: >-
  Fresh-context checks and agent crews in tmux/herdr/Rex panes. Check before
  you commit: have a recorded check (`mu_delegate` in pi, else a native
  subagent) refute a claim, root cause, plan, fix or brief first. Also
  fan-out research, helpers, and crews with a task DAG, review gates and
  merges. Never write
  mu's DB (no `sqlite3`, no raw SQL writes): read it with `mu sql "<SELECT>"`,
  change it with a verb.
---

# mu

**`mu --help` and `mu <verb> --help` outrank this skill**; a verb they omit does not exist.

- **umbrella**: a job's parent task, blocked by every unit; holds brief, criteria, stop rule.
- **finding**: an `OPEN/triage` task. **verdict**: `VERDICT: <id>
  CONFIRMED|REFUTED|UNVERIFIED <line>` plus `EVIDENCE:`.

## Channels

Verbs follow each agent's channel (`mu agent list`):

- **ctl** (pi): exact send, `--steer` and abort.
- **hooks** (claude, codex, cursor-agent, muse on tmux): a paste confirmed by
  run count, no `--steer`; `blocked` takes `mu agent answer`
  ([sending](recipes/orchestrator-loop.md#sending)).
- **mux** (other CLIs): send; read the pane.

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
- **Wait with `mu wait`, never `sleep` loops.** All of a set: `mu wait --all task:<ws>/<a> task:<ws>/<b>`.
- **Then read every outcome:** `mu task show <id>` per task. Exit 7 ends `--all` early: act, then wait on the rest.
- **A send that timed out is unknown, never resent**: `mu agent check <a> <msgId>`.
- **New work: `send --fresh`.** A running worker never sees a note: send
  ([modes](recipes/orchestrator-loop.md#sending)).
- **`unknown` is not dead.** Read the pane and `mu doctor` first.
- **Only `CLOSED/done` ships.** Verify the merge.
- **Checks are calls, not tasks** ([tasks-or-calls](recipes/tasks-or-calls.md)):
  `mu_delegate` in pi, else native subagents under `mu task check` → run →
  `verdict` (not delegates). Refute claim, cause, plan, fix or brief;
  rewrite on REFUTED.
- **Findings are tasks** ([findings](recipes/findings.md)); each shipping unit gets a
  [review gate](recipes/adversarial-review.md).
- **Stop rule on the umbrella first.**
- **`course check due` stops dispatch**: finish merging, then
  [course-correct](recipes/course-correct.md); resume only after it.
- **Edit or build: `--worktree`.** Never make your own.

## Gotchas

- `close --as rejected|wontfix --why` unblocks dependents; `park --why` keeps them waiting.
- Prose goes through `-` and a quoted heredoc ([brief](recipes/brief.md)).

## Recipes

| Recipe | Read when |
| --- | --- |
| [orchestrator-loop](recipes/orchestrator-loop.md) | you dispatch and merge |
| [merge](recipes/merge.md) | units ready |
| [brief](recipes/brief.md) | what a worker reads |
| [tasks-or-calls](recipes/tasks-or-calls.md) | spawn, refute, check, delegate |
| [findings](recipes/findings.md) | a check reports problems |
| [adversarial-review](recipes/adversarial-review.md) | a unit needs a gate |
| [test-health](recipes/test-health.md) | gates, or verifying a merge |
| [models](recipes/models.md) | you pick a model |
| [remote-workers](recipes/remote-workers.md) | an agent runs on another host |
| [recovery](recipes/recovery.md) | teardown, rebuild, sync, `doctor` DRIFT |
| [worker](recipes/worker.md) | you are the worker |
| [course-correct](recipes/course-correct.md) | `course check due`, or a human asks |
| [move](recipes/move.md) | a workstream changes machines |
