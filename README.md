# mu

**A small control plane for a crew of AI coding agents working in
parallel.** Agents run in multiplexer panes you can attach to. Work is a
task DAG in SQLite. Each agent gets its own VCS workspace.

![mu dashboard](docs/img/tui-dashboard.png)

*Bare `mu` opens a read-only dashboard: agents, tracks, ready,
in-progress, and blocked tasks, the log tail, workspaces, and doctor.*

- **Parallel work that does not collide.** Per-agent workspaces (jj
  workspaces, sl shares, or git worktrees) and a task DAG with
  `blocks` edges keep agents out of each other's way.
- **State that outlives a pane.** One SQLite DB holds agents, tasks,
  owners, notes, and workspaces. An append-only ops log records every
  change, so `mu undo <group>` reverses one action and `mu rebuild`
  replays the whole history.
- **Exact control of pi agents.** mu's pi extension serves a control
  socket inside each agent, so send, state, wait, and abort are exact,
  locally and over ssh. The pane stays pi's normal TUI.

mu persists state and coordinates handoffs. Every read path has
`--json`, and every change goes through a typed CLI verb. See
[What mu is not](#what-mu-is-not).

## Install

```bash
npm i -g @mu-crew/mu
mu link pi       # pi extension (control socket, mu_delegate) + the mu skill
mu doctor
```

To drive mu from another agent CLI (claude-code, codex), install the
skill with `npx skills add mu-crew/mu` instead of `mu link pi`.

You need:

- Node 22.12–26 (see `.nvmrc`).
- tmux ≥ 3.0 or [herdr](https://github.com/herdrdev/herdr). `mu doctor`
  reports which one is active.
- pi, or another agent CLI.
- jj, sl, or git on `PATH` for `--workspace`.

[murmur](https://github.com/mu-crew/murmur) is optional for pi agents.
Non-pi agents on tmux need it for state: without it their state is
`unknown`, so `mu agent wait` and stall detection never fire for them.
On herdr, herdr reports state.

To update or run from a checkout, see
[How to upgrade mu](docs/guide/upgrade.md).

## Quick start

Run this inside tmux or herdr:

```bash
mu workstream init auth
export MU_SESSION=auth   # init does not attach you; or pass -w auth to each verb
mu task add design_auth --title "Design auth" --impact 80 --effort-days 2
mu task add build_auth  --title "Build auth"  --impact 80 --effort-days 5 --blocked-by design_auth
mu agent spawn worker-1 --workspace
mu task claim design_auth --for worker-1
mu agent send worker-1 --fresh 'Do task design_auth. Close it with evidence.'
mu task wait design_auth --first --on-stall exit   # exit 7 = worker needs you
mu                                                  # dashboard
mu workstream teardown --yes                        # without --yes: dry run
```

For one helper, ask pi to delegate (`mu_delegate` ships with `mu link
pi`), or spawn into the reserved `scratch` workstream:
`mu agent spawn scout-1 -w scratch`.

## Ultrathink, the mu way

Long agent runs fail in two ways: the agent stops at 35 of 50 items and
calls it done, and it grades its own work generously. The fix is to
take the plan out of the agent's head, fan the work out to fresh
agents, and have other agents try to refute each result before it
counts. Claude Code's ultracode does this with a hidden script. mu does
it in the open:

- **The plan is the DAG.** Every unit, review gate, finding and round
  is a task before an agent spawns. `mu state` shows 35 of 50 done, so
  nobody can declare victory early.
- **Findings are tasks.** A reviewer records each problem as a task in
  triage ([findings](skills/mu/recipes/findings.md)), and it blocks the
  review until someone accepts it as work or closes it rejected or
  duplicate. The graph holds the whole review.
- **Checks are calls.** Refuters, claim checkers and judges are
  [delegate calls](skills/mu/recipes/tasks-or-calls.md): fresh agents,
  ideally on another model, whose verdicts land on the task they
  judged. A 50-unit run adds about 50 units, 50 review gates and the
  findings that survive, not a task per check.
- **Every agent is a pane.** Attach to any worker, reviewer, or judge
  mid-run and steer it.
- **Nothing lives only in a context window.** Verdicts, evidence, and
  stop rules are task notes. The run survives compaction, crashes, and
  a new orchestrator.

Not every review needs a record. Reviewing someone's PR or a doc runs
as delegates only: findings come back in their answers, and nothing
lands in the ops log.

Ask your orchestrator to *ultrathink* a job, and it follows
[skills/mu/recipes/ultrathink.md](skills/mu/recipes/ultrathink.md).
That recipe composes smaller ones you can also use on their own:

| Recipe | Shape |
| ------ | ----- |
| [fan-out](skills/mu/recipes/fan-out.md) | one task per unit, merged as each closes |
| [adversarial-review](skills/mu/recipes/adversarial-review.md) | a review gate per unit: a fresh agent tries to reject it before it ships |
| [refute](skills/mu/recipes/refute.md) | finders record findings, one refuter call per finding, report from the graph |
| [hypothesis-panel](skills/mu/recipes/hypothesis-panel.md) | independent theories from separate evidence, each attacked |
| [tournament](skills/mu/recipes/tournament.md) | competing attempts, judged in pairs |
| [loop-until-done](skills/mu/recipes/loop-until-done.md) | rounds until a stop rule written up front holds |
| [backlog-triage](skills/mu/recipes/backlog-triage.md) | quarantined readers classify, a trusted actor acts |
| [deep-research](skills/mu/recipes/deep-research.md) | searchers by angle, one checker per claim, a cited report |
| [review-panel](skills/mu/recipes/review-panel.md) | one reviewer per angle on a diff; delegates by default, tasks when fixes follow |
| [rules-audit](skills/mu/recipes/rules-audit.md) | one checker per AGENTS.md rule plus a skeptic; or mine repeated corrections into new rules |

In pi, `mu link pi` adds them as commands: `/ultrathink <job>`,
`/mu-research <question>`, `/mu-review [target]`, `/mu-refute <scope>`,
`/mu-tournament <task>`, `/mu-rules-audit [check <target> | mine]`,
`/mu-debug <symptom>`, `/mu-sweep <change>`, and `/mu-until <stop rule>`.

All recipes, including the orchestrator loop and remote workers, are
in [skills/mu/recipes/](skills/mu/recipes/).

## What mu is not

- **Not a hidden subagent.** Every agent, including a one-off
  `mu_delegate` helper, is an ordinary agent in a pane: attach, steer,
  abort, or keep talking to it. That costs a pane and a pi process per
  agent; for many tiny calls a hidden subagent is lighter. See
  [the comparison](docs/guide/delegate.md#delegates-vs-hidden-subagents).
- **Not a workflow engine.** No DSL, no hidden plan, no script runner.
  The plan is the task DAG; recipes are instructions an agent follows,
  and every step is a CLI verb.
- **Not a model router.** mu does not pick models, thinking levels, or
  tools. Pass them in the spawn command (`--cli pi_big`).
- **Not a chat bus.** Agents coordinate through task notes, claims, and
  the ops log, not messages to each other.
- **Not a daemon or a service.** No background process, config file, web
  UI, or RPC. State is one SQLite file; sync rides on ordinary commands.
- **Not a test runner or a judge.** `--evidence` records what an agent
  observed; checking it is the orchestrator's job, and the recipes say how.

The full list, with reasons: [VISION § What it is not](docs/VISION.md#what-it-is-not)
and [ROADMAP § Anti-feature pledges](docs/ROADMAP.md#anti-feature-pledges).

## Documentation

- [Getting started](docs/guide/getting-started.md): the first
  workstream, end to end. Start here.
- [User guide](docs/guide/README.md): how-tos for dispatch, remote
  workers, sync, recovery, and the dashboard.
- [skills/mu/SKILL.md](skills/mu/SKILL.md): what an orchestrating
  agent reads. [skills/mu/recipes/](skills/mu/recipes/) holds the
  recipes it points to, such as
  [remote workers](skills/mu/recipes/remote-workers.md).
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) and
  [docs/architecture/](docs/architecture/): the module map and deep
  dives.
- [VISION.md](docs/VISION.md): the design pillars.
  [ROADMAP.md](docs/ROADMAP.md): what is next and what is rejected.
- [VOCABULARY.md](docs/VOCABULARY.md): canonical terms.
- [CHANGELOG.md](CHANGELOG.md): release notes.

`mu <verb> --help` is the reference for every flag.

## License

MIT. Part of [mu-crew](https://github.com/mu-crew). Written mostly by AI
coding agents, with a human reviewing what ships.
