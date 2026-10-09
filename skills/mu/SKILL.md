---
name: mu
description: >-
  Fresh-context subagents and crews in tmux/herdr panes. Check before you
  commit: before acting on a claim, root cause, plan, fix or brief, have a
  `mu_delegate` call refute it. Also for a fresh delegate's second look at
  your own work or diff; parallel read-only research, investigation or fan-out
  over files; background helpers (watchers, soak runs, agents you keep talking
  to); persistent crews with a task graph, review gates and merges. Outside
  pi, delegate through the reserved `scratch` workstream.
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
`{items, count}`, except `mu agent list` (`{agents, orphans}`); `mu sql --json` is bare rows; `mu log --tail` is
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
  `effort_days`. Shown as status/substate: `OPEN/todo|parked|triage`,
  `IN_PROGRESS/active`, `CLOSED/done|rejected|wontfix|duplicate|superseded`.
  Any `CLOSED/*` satisfies `--blocked-by`.
- **claim / release** — atomic take/clear of `tasks.owner`.
- **note** — append-only task context; survives sessions.
- **track** — tasks connected by `block` edges (`mu task block B --by A`
  puts B on A's track); spawn at most one agent per ready track.
- **workspace** — per-agent VCS copy under
  `<state-dir>/workspaces/<workstream>/<agent>/`.

Recipe words, the same in every recipe:

- **umbrella** — the parent task of one job, blocked by every unit,
  finding and round; holds the brief, criteria and stop rule; closes
  with `mu task close <umbrella> --if-ready`.
- **unit** — one piece of the job, one task (a file, a call site, a fix).
- **gate** — two kinds: a **gate command** (tests, build) that must
  pass on the merged tree, and a **review gate** (a `review_x` task
  blocked by `x`) that decides whether `x` counts.
- **wave** — the units dispatched from one main revision; refresh
  workspaces before the next.
- **finding** — one reported problem, recorded as an `OPEN/triage` task.
- **verdict** — a check's answer: `VERDICT: <id> CONFIRMED | REFUTED |
  UNVERIFIED <one line>` plus `EVIDENCE:` lines (or ACCEPT | REJECT for
  a review gate).
- **stop rule** — the command and condition that end a loop, written on
  the umbrella first ([loop-until-done](recipes/loop-until-done.md)).

## When to use mu

Use mu for persistent helpers, parallel work, dependencies, gated review, or
work that must survive context compaction. Stay in one context for tiny edits
or inspection.

### Quick checks and off-the-cuff helpers (`scratch`)

Before you act on a claim, root cause, plan, fix or brief, or to get a second
look at your own work or diff, make a [delegate call](recipes/tasks-or-calls.md#delegate-call)
that tries to refute it, on another model family ([models](recipes/models.md#checkers); briefs: see
Orchestrator rules; many claims: [refute](recipes/refute.md)).

For one-shot work inside pi, call `mu_delegate` (installed by `mu link pi`). Outside pi: spawn
into the reserved `scratch` workstream (no task DAG, auto-created), `send --fresh --json`, then
`mu agent wait --after-runs <its runs> --json` (`lastText`); without `--after-runs` a run that
ends first hangs the wait. Recipes call either form a **delegate call**. A check judging a mu
task lands its verdict there: `record: { task: "<ws>/<id>" }` on `mu_delegate`, a hand-written
`REFUTER` note on the spawn path; with no task, skip both.

- `mu agent wait <names...> --first` waits for busy → idle instead of a
  `sleep` loop; exit 0 met, 5 timeout, 6 pane died.
- For a watcher (PR, CI, a log), follow [recipes/watcher.md](recipes/watcher.md).
- One agent per independent unit; `--workspace` for any helper that may edit,
  build, or test the shared repo.

A pi helper showing `unknown (ctl missing)` right after spawn (spawn
warns after 30 s) likely sits at pi's project trust prompt (through a
wrapper whose argv0 is not `pi`/`pi-meta` it shows `needs_input`): add
`--approve` to `MU_<CLI>_COMMAND`. Move off
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
fork); otherwise it fails with `WorkspacePreservedError`. A `cp -a` copy is
never clean. Inspect the workspace, cherry-pick what to keep (or
`mu workspace free <agent> --commit`), and pass `--discard-workspace`
only to throw the rest away.
Before each `--fresh` send, `mu workspace refresh <agent>` rebases onto
main and keeps LLM context ([waves](recipes/waves.md) when workers share
files). Claim and send warn at ≥10 commits behind
(`--strict-staleness` refuses).

### Remote agents

The PANE is local, the PROCESS is remote. **One orchestrator DB**: never
run a second mu on the host. **Read
[recipes/remote-workers.md](recipes/remote-workers.md) before spawning
your first remote agent, and again before waiting on one.**
[mule](https://github.com/mu-crew/mule) runs remote commands without
holding an ssh channel; **`mule` exit 3 is a HANDBACK** to the operator
(hardware-key touch): never retry or open `ssh -MNf` yourself.

### Workstream names

`<project>-<purpose>` (`hail-auth`), one per effort, torn down when it
ships. Reviews nobody will track run as `scratch` delegates.

### Agent names

Use roles with the smallest unused suffix: `worker-1`, `reviewer-1`,
`scout-1`, `auditor-1`, `planner-1`. No human names.

### Task note contract

End every delegated task with a note holding the applicable fields
(write the brief that asks for it per [brief](recipes/brief.md)):

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
- **Push only when the gate command passes** on the merged tree.
- **Define done before a long run**: the completion criterion goes in
  the task note first ([long-run](recipes/long-run.md)).
- **New work to pi is `mu agent send --fresh`.** Never chain `/new` and
  a prompt as two sends: the prompt can land mid-reset and vanish.
- **`mu task wait --first --on-stall exit`**; exit 7 means read the
  owner's pane and answer it.
- **Stop a worker gently**: `mu agent abort`, then `kick`, then `close`.
  To redirect a busy pi now: `send --interrupt` (`--steer` waits for
  the running tool).
- **Send, don't note, a running worker**: it never sees new notes. The note is the durable copy
  ([how to send](recipes/orchestrator-loop.md#sending)).
- **Refute a brief claiming a cause, fix, threshold or code fact** before dispatch:
  one `record`ed refuter call; rewrite on AMEND. Others get a `REFUTE-EXEMPT: <why>` note.
- **Checks are calls, not tasks.** Refuters, claim checkers, judges and
  skeptics are [delegate calls](recipes/tasks-or-calls.md#delegate-call)
  (`mu_delegate`, or a `scratch` spawn without it), all issued in one
  turn. Refuters and claim checkers pass `record` (or hand-write the
  `REFUTER` note) to land the verdict on the task; judges report
  `WINNER:`. `MU_DELEGATE_MAX` (16) run at once; the rest queue.
- **Findings are tasks.** A reviewer's or auditor's findings become
  `mu task add --triage` tasks blocking the review, decided with
  `mu task accept` or `close --as rejected|duplicate`. A review nobody
  will track (someone's PR, a doc) runs as delegates instead. Rules:
  [recipes/findings.md](recipes/findings.md).

## CLI gotchas

- **`task close --if-ready`** no-ops until every blocker is CLOSED; bare
  `task release` reopens IN_PROGRESS.
- **`task close --as rejected|wontfix --why ...`** unblocks dependents
  (listed in the output). `rejected` = the claim is false; `wontfix` =
  true, not worth doing. To keep dependents waiting, `task park --why` instead: parked
  leaves `next`, and `claim` refuses it without `--force`. Park refuses
  IN_PROGRESS — `task release` first.
- **For waits use `task wait`, not `log --tail`.** `mu log --kind <k>`
  entries are your own durable state (a ledger); `--intent` filters what
  mu recorded.
- **Prose in notes, prompts, `--why` or `--evidence`**: an apostrophe
  ends `'...'`; use a quoted heredoc ([brief](recipes/brief.md#quoting)).
- **`mu sql`** does not pull synced ops; run any other mu command first.
- **Never put `MU_DB_PATH` inside `MU_SYNC_DIR`**: it corrupts the DB.
- Before undo, rebuild, teardown (dry-run without `--yes`), sync setup,
  a `doctor --deep` DRIFT, or `doctor` cleanup output, read
  [recipes/recovery.md](recipes/recovery.md).

## Models and thinking effort

mu passes the model through; you pick it. Before you choose one for a
spawn or a delegate call, read [recipes/models.md](recipes/models.md):
tiers, which roles need which, and local models as a last resort.

- `mu_delegate` takes `model`; a spawn takes `--command "pi --model <id>"`.
- A checker (reviewer, refuter, judge, auditor) runs at the author's tier
  or higher, from another family when one exists. A delegate with no
  `model` runs the cli's default model; pass `model` when it matters.

## Reaper and agent state

If an agent pane dies, or `mu agent close` kills it mid-task, its
IN_PROGRESS tasks revert to OPEN with a `[reaper]` note. No manual
release after crashes.

pi agents report state through the control socket and need no murmur.
Other CLIs report through [murmur](https://github.com/mu-crew/murmur) on
tmux, or herdr on herdr. `unknown` means no state source; `mu doctor`
says why. Before you merge, close `--as rejected`, abort, or tear down, read the pane
(`mu agent read worker-1 -n 100`), `mu log -w <ws> --tail`, and
`mu task notes <id>`.

## You are a worker

If a task was claimed for you, follow [recipes/worker.md](recipes/worker.md).
Close the task as your last action, or the orchestrator's wait hangs.

## Guardrails

Task ownership outranks agent state. Coordinate through task notes and
the activity log. Keep edges within one workstream. Give workers
bounded paths and commands.

## Recipes

Read the recipe before starting the shape it names. For a large or
risky job that needs several of them, start with
[ultrathink](recipes/ultrathink.md).

| Recipe | Read when |
| --- | --- |
| [ultrathink](recipes/ultrathink.md) | a job is too large or risky for one context; composes the rest |
| [orchestrator-loop](recipes/orchestrator-loop.md) | you dispatch tasks and merge results |
| [brief](recipes/brief.md) | you write a task note or prompt a worker will read |
| [plan](recipes/plan.md) | you turn a spec or requirements into a task DAG |
| [worker](recipes/worker.md) | a task was claimed for you |
| [recovery](recipes/recovery.md) | undo, rebuild, teardown, sync setup, `doctor` cleanup |
| [remote-workers](recipes/remote-workers.md) | an agent runs on another machine |
| [waves](recipes/waves.md) | more than one worker edits the same repo at once |
| [long-run](recipes/long-run.md) | a task or proof runs for hours, or must survive flakes |
| [drift-audit](recipes/drift-audit.md) | hours into a long run, after a batch, compaction or resume, before a stop rule |
| [watcher](recipes/watcher.md) | a helper polls a PR, CI, or log for change |
| [findings](recipes/findings.md) | any review, audit, or check reports problems: where they live, how they are triaged |
| [models](recipes/models.md) | you pick a model for a spawn or delegate call |
| [tasks-or-calls](recipes/tasks-or-calls.md) | a recipe step spawns an agent: DAG task or delegate call |
| [adversarial-review](recipes/adversarial-review.md) | gate each unit you dispatch before it merges (a review task per unit) |
| [fan-out](recipes/fan-out.md) | a sweep or migration: the same change over many files or call sites |
| [refute](recipes/refute.md) | you start an audit, bug hunt, or fact-check |
| [hypothesis-panel](recipes/hypothesis-panel.md) | debugging: "why does X", a regression, a flaky test, an intermittent bug |
| [tournament](recipes/tournament.md) | several answers are possible and the best is a judgement call |
| [loop-until-done](recipes/loop-until-done.md) | fix until a check is clean (tsc, lint, tests), or search until nothing new |
| [backlog-triage](recipes/backlog-triage.md) | a backlog of external items needs classifying and acting on |
| [deep-research](recipes/deep-research.md) | a question needs many sources read and cross-checked |
| [review-panel](recipes/review-panel.md) | code review of a PR, branch, or diff |
| [rules-audit](recipes/rules-audit.md) | a change must follow AGENTS.md rule by rule, or rules keep being restated |
| [codemode-driver](recipes/codemode-driver.md) | you have the `codemode` tool and one step dispatches many workers or delegate calls |

## See also

- `mu --help`, `mu <verb> --help` — canonical CLI reference.
