---
name: mu
description: Manage AI agents in terminal-multiplexer panes (tmux or herdr) — from a single off-the-cuff helper to a persistent crew coordinated through a built-in task graph. Use when the user asks to "create/spin up a subagent to X", "run X in the background", "do this in parallel", "use one subagent per X to do Y", "kick off a helper to watch/investigate/draft X", or to spawn, send work to, observe, or coordinate one or many agents — especially work you'll keep talking to, long-lived or background agents, or anything needing a dependency graph. For zero-ceremony helpers use the reserved `scratch` workstream; for one-shot "fire and get a result back" use the `mu_delegate` tool — its pane stays attachable.
---

# mu — Multi-agent orchestration

`mu` manages long-lived AI agents in multiplexer panes (tmux or
herdr), coordinated by a SQLite task DAG at
`<XDG_STATE_HOME or ~/.local/state>/mu/mu.db`.

**Trust `mu --help` / `mu <verb> --help` over this skill.** Verbs
not in `--help` do not exist.

## Output + JSON shapes

Default output is a card on stdout plus a `Next:` block. Read both.
Every verb takes `--json`: one stdout object; collections are
`{items, count}`; `mu sql --json` is bare rows; `mu log --tail` is
NDJSON. Errors are `{error,message,nextSteps,exitCode}` on stderr
(validation errors add `usage`). **`nextSteps` survives in JSON.**

## Vocabulary

- **workstream** — one **mux session** `mu-<name>` (tmux session or
  herdr workspace) and one DB partition.
- **agent** — named worker in a pane (you may be one).
- **mux** — tmux or herdr, one per invocation. `mu doctor` names it;
  `MU_MUX` forces it. `mu agent kick` is Linux-only on herdr.
- **control socket (ctl)** — how mu drives a pi agent: the mu pi
  extension (`mu link pi`) serves exact send, state, wait and abort
  inside pi's own TUI. `ctl missing|refused` means it does not answer.
- **task** — DAG node with mandatory `impact` (1–100) and
  `effort_days`. Shown as status/substate: `OPEN/todo|parked`,
  `IN_PROGRESS/active`, `CLOSED/done|rejected|wontfix|duplicate|superseded`.
  Any `CLOSED/*` satisfies `--blocked-by`.
- **claim / release** — atomic take/clear of `tasks.owner`.
- **note** — append-only task context; survives sessions.
- **track** — independent DAG subtree; spawn at most one agent per
  ready track.
- **workspace** — per-agent VCS copy under
  `<state-dir>/workspaces/<workstream>/<agent>/`.

## When to use mu

Use mu for persistent helpers, parallel work, dependencies, gated review, or
work that must survive context compaction. Stay in one context for tiny edits
or inspection.

### Off-the-cuff helpers (`scratch`)

For one-shot work inside pi, call `mu_delegate` (installed by `mu link pi`).
Outside pi: spawn into the reserved `scratch` workstream (no task DAG,
auto-created), `send --fresh`, then `mu agent wait --json` (`lastText`).

- `mu agent wait <names...> --first` waits for busy → idle instead of a
  `sleep` loop; exit 0 met, 5 timeout, 6 pane died.
- For a watcher (PR, CI, a log), follow [recipes/watcher.md](recipes/watcher.md).
- One agent per independent unit; `--workspace` for any helper that may edit,
  build, or test the shared repo.

A helper stuck at `needs_input` right after spawn likely hit pi's
project trust prompt: add `--approve` to `MU_<CLI>_COMMAND`. Move off
`scratch` when work gains dependencies or review gates.

## Mental model

### Workstreams, DAGs, tracks

The DAG has one edge: `mu task block A --by B` means **B blocks A**.
Tracks sharing a prerequisite collapse into one, so two agents never
take the same dependency.

### Workspaces prevent trampling

If an agent may edit, build, or test while another is active in the same
repo, spawn with `--workspace`. Two builds in one checkout corrupt each
other; keep the main checkout for orchestration.

Workspaces auto-detect jj, sl, or git (else `cp -a`). `mu agent close`
frees one **only if clean** (no uncommitted changes, no commits since
fork); otherwise it fails with `WorkspacePreservedError`. Then use
`mu workspace free <agent>` or `--discard-workspace` (lossy).
Between waves, `mu workspace refresh <agent>` rebases onto main and
keeps LLM context. Claim and send warn at ≥10 commits behind
(`--strict-staleness` refuses).

### Remote agents

The PANE is local, the PROCESS is remote. **One orchestrator DB**: never
run a second mu on the host. **Read
[recipes/remote-workers.md](recipes/remote-workers.md) before spawning
your first remote agent, and again before waiting on one.**
**`mule` exit 3 is a HANDBACK** to the operator (hardware-key touch):
never retry or open `ssh -MNf` yourself.

### Agent names

Use roles with the smallest unused suffix: `worker-1`, `reviewer-1`,
`scout-1`, `auditor-1`, `planner-1`. No human names.

### Task note contract

End every delegated task with a note holding the applicable fields:

```text
FILES:    paths inspected/changed (line ranges if precise)
COMMANDS: commands run + exit codes
FINDINGS: what you observed
DECISION: what you chose, and why
NEXT:     follow-on tasks
VERIFIED: tests/checks/output
ODDITIES: weird things not acted on
```

Then close with grounding:
`mu task close <id> -w <ws> --evidence "tests pass: cargo test exit 0"`.

## Orchestrator rules

<!-- mu:keep-driving -->
**While workers run, keep driving.** Your turn ends only when every
task is closed, or when a decision only a human can make blocks all
progress (scope, spend, irreversible or external actions, a hardware-key
handback). A status summary is a log line, not a stopping point: write
it with `mu log`, then go straight back to `mu task wait`. Ending a
turn to report progress while workers are busy stalls the whole crew.
<!-- /mu:keep-driving -->

Before you dispatch, read [recipes/orchestrator-loop.md](recipes/orchestrator-loop.md):
the every-turn loop, waiting, merging, and stopping workers. These
rules hold even when you skip it:

- **Claim before sending**, even one-shot reviewers. Ownership is
  durable and waitable; agent state is not.
- **Pipeline; don't barrier.** Merge each task as it closes.
- **Verify the merge, not the worker's rerun.** Only `CLOSED/done` ships.
- **Push only from a green gate.**
- **Fix done before a long run**: the completion criterion goes in the
  task note first.
- **New work to pi is `mu agent send --fresh`.** Never chain `/new` and
  a prompt as two sends: the prompt can land mid-reset and vanish.
- **`mu task wait --first --on-stall exit`**; exit 7 means read the
  owner's pane and answer it.
- **Stop a worker gently**: `mu agent abort`, then `kick`, then `close`.

## CLI gotchas

- **`workstream teardown`** is dry-run without `--yes`.
- **`task close --if-ready`** no-ops until every blocker is CLOSED; bare
  `task release` reopens IN_PROGRESS.
- **`task close --as rejected|wontfix --why ...`** (declined | valid, not worth it) unblocks dependents (listed in
  the output). To keep dependents waiting, `task park --why` instead: parked
  leaves `next`, and `claim` refuses it without `--force`. Park refuses
  IN_PROGRESS — `task release` first.
- **For waits use `task wait`, not `log --tail`.** `--kind` is the operator's
  log-ledger channel; `--intent` is what mu recorded.
- **`mu sql`** skips ambient sync.
- **Never put `MU_DB_PATH` inside `MU_SYNC_DIR`**: it corrupts the DB.
- **`mu doctor --deep` DRIFT** (exit 5): back up and report it; do not
  rebuild.
- Before undo, rebuild, teardown, sync setup, or acting on `doctor`
  cleanup output, read [recipes/recovery.md](recipes/recovery.md).

## Models and thinking effort

mu doesn't reason about models; pi does. Controls:

```bash
mu agent spawn r --command "pi --model opus:high"
export MU_PI_COMMAND="pi --model sonnet:medium"
mu agent spawn a --cli pi_big   # uses $MU_PI_BIG_COMMAND
```

Convention: `pi_mini` for probing, `pi` for build and refactor,
`pi_big` for design, review, and incidents. List models with
`pi --list-models [search]`.

## Reaper and agent state

If an agent pane dies, or `mu agent close` kills it mid-task, its
IN_PROGRESS tasks revert to OPEN with a `[reaper]` note. No manual
release after crashes.

pi agents report state through the control socket and need no murmur.
Other CLIs report through [murmur](https://github.com/mu-crew/murmur) on
tmux, or herdr on herdr. `unknown` means no state source; `mu doctor`
says why. Before a high-stakes decision, read the pane
(`mu agent read worker-1 -n 100`), `mu log -w <ws> --tail`, and
`mu task notes <id>`.

## You are a worker

If a task was claimed for you, follow [recipes/worker.md](recipes/worker.md).
Close the task as your last action, or the orchestrator's wait hangs.

## Guardrails

Task ownership outranks agent state. Coordinate through task notes and
the activity log. Keep edges within one workstream and reserve the `mu_`
task-id prefix. Give workers bounded paths and commands.

## Recipes

Read the recipe before starting the shape it names. For a large or
risky job that needs several of them, start with
[ultrathink](recipes/ultrathink.md).

| Recipe | Read when |
| --- | --- |
| [ultrathink](recipes/ultrathink.md) | a job is too large or risky for one context; composes the rest |
| [orchestrator-loop](recipes/orchestrator-loop.md) | you dispatch tasks and merge results |
| [worker](recipes/worker.md) | a task was claimed for you |
| [recovery](recipes/recovery.md) | undo, rebuild, teardown, sync setup, `doctor` cleanup |
| [remote-workers](recipes/remote-workers.md) | an agent runs on another machine |
| [waves](recipes/waves.md) | more than one worker edits the same repo at once |
| [long-run](recipes/long-run.md) | a task or proof runs for hours, or must survive flakes |
| [watcher](recipes/watcher.md) | a helper polls a PR, CI, or log for change |
| [adversarial-review](recipes/adversarial-review.md) | work must be checked by someone other than its author before it counts |
| [fan-out](recipes/fan-out.md) | the same change or check applies to many units |
| [refute](recipes/refute.md) | an audit, sweep, or fact-check produces findings |
| [hypothesis-panel](recipes/hypothesis-panel.md) | a root cause is unknown (flaky test, intermittent bug) |
| [tournament](recipes/tournament.md) | several answers are possible and the best is a judgement call |
| [loop-until-done](recipes/loop-until-done.md) | the amount of work is unknown until a check passes |
| [triage](recipes/triage.md) | a backlog of external items needs classifying and acting on |
| [codemode-driver](recipes/codemode-driver.md) | a codemode script would dispatch a wave in parallel |

## See also

- `mu --help`, `mu <verb> --help` — canonical CLI reference.
