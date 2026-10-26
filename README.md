# mu

**A small control plane for a crew of AI coding agents working in
parallel.** Agents run in multiplexer panes you can attach to. Work is a
task DAG in SQLite. Each agent gets its own git worktree.

- **Parallel work that does not collide.** Per-agent git worktrees and a task DAG with
  `blocks` edges keep agents out of each other's way.
- **State that outlives a pane.** One SQLite DB holds agents, tasks,
  owners, notes, and worktrees. An append-only ops log records every
  change, so `mu log --group <group>` shows one action and `mu rebuild`
  replays the whole history.
- **Exact control of pi agents.** mu's pi extension serves a control
  socket inside each agent, so send, state, wait, and abort are exact,
  locally and over ssh. The pane stays pi's normal TUI.

mu persists state and coordinates handoffs. Every read path has
`--json`, and every change goes through a typed CLI verb. See
[What mu is not](#what-mu-is-not).

**Status:** this branch is mu-next (`mu --version` prints `4.0.0-next.0`),
unreleased. It runs beside mu 3.x with its own DB and state dir and never
imports a 3.x DB; workstreams move over one at a time
([Switch to mu-next](docs/guide/upgrade.md#switch-to-mu-next)). One part
is still landing: routing `mu_delegate` with no multiplexer
(`v_delegate_nomux`; `mu delegates run` already works without one).
<!-- TODO(v_delegate_nomux): drop that sentence once it merges. -->

## Install

```bash
npm i -g @mu-crew/mu
pi install npm:@mu-crew/mu   # extension (control socket, mu_delegate), the mu skill, recipe prompts
mu doctor
```

To drive mu from another agent CLI (claude-code, codex), install the
skill with `npx skills add mu-crew/mu` instead of the pi package.

You need:

- Node 22.12–26 (see `.nvmrc`).
- tmux ≥ 3.0 or [herdr](https://github.com/herdrdev/herdr). `mu doctor`
  reports which one is active.
- pi, or another agent CLI.
- git on `PATH` for `--worktree`.

[murmur](https://github.com/mu-crew/murmur) is optional for pi agents.
Non-pi agents on tmux need it for state: without it their state is
`unknown`, so a wait never sees them finish and stall detection never fires.
On herdr, herdr reports state.

To update or run from a checkout, see
[How to upgrade mu](docs/guide/upgrade.md).

## Quick start

Run this inside tmux or herdr:

```bash
mu workstream init auth                             # every verb below names it with -w
mu task add design_auth -w auth --title "Design auth" --impact 80 --effort-days 2
mu task add build_auth  -w auth --title "Build auth"  --impact 80 --effort-days 5 --blocked-by design_auth
mu agent spawn worker-1 -w auth --worktree
mu task claim design_auth -w auth --for worker-1
mu agent send worker-1 -w auth --fresh 'Do task design_auth. Close it with evidence.'
mu wait task:design_auth -w auth   # one JSON result; exit 7 = worker needs you
mu workstream teardown auth                         # preview (rev=<n>); apply with --if <n>
```

For one helper, ask pi to delegate (`mu_delegate` ships in the pi
package), or spawn into the reserved `scratch` workstream:
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

Ask your orchestrator to *ultrathink* a job, and it follows the
[orchestrator loop](skills/mu/recipes/orchestrator-loop.md): every unit,
review and round is a task, and checks are calls. The recipes it composes
you can also use on their own:

| Recipe | Shape |
| ------ | ----- |
| [orchestrator-loop](skills/mu/recipes/orchestrator-loop.md) | dispatch, wait, merge; also sweeps and loops until a stop rule holds |
| [adversarial-review](skills/mu/recipes/adversarial-review.md) | a review gate per unit: a fresh agent tries to reject it before it ships |
| [findings](skills/mu/recipes/findings.md) | reviewers record findings, one refuter call per finding, report from the graph |
| [tasks-or-calls](skills/mu/recipes/tasks-or-calls.md) | refuters, judges and checkers as delegate calls |
| [course-correct](skills/mu/recipes/course-correct.md) | a periodic look at whether a long job is on course |
| [move](skills/mu/recipes/move.md) | move a 3.x workstream to mu-next |

In pi, the package adds them as commands: `/ultrathink <job>`,
`/mu-research <question>`, `/mu-review [target]`, `/mu-refute <scope>`,
`/mu-tournament <task>`, `/mu-rules-audit [target]`,
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
  workers, sync, and recovery.
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
