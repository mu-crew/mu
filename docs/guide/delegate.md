# How to delegate a one-off task

## Delegate from pi

`mu link pi` installs the `mu_delegate` and `mu_delegate_cancel` tools
in every pi session. Ask pi in plain words:

- "Delegate a review of src/x.ts to a helper."
- "Have three helpers investigate A, B, and C."

pi calls `mu_delegate`. It spawns a pi agent in the reserved `scratch`
workstream and returns at once with the delegate's name and attach
command. The answer arrives later as a follow-up message; do not poll.
Delegates called in one turn run in parallel.

| Option | Meaning |
| ------ | ------- |
| `task` (required) | All the context. The delegate starts empty. |
| `label` | Names the delegate: `review` gives `delegate-review`. |
| `brief` | Ad hoc persona or ground rules, sent first. Not enforced. |
| `cwd` | Start directory. Default: the caller's. Must exist. |
| `timeout` | Seconds to wait for the answer (default 3600). After it, the answer does not come back; the follow-up gives the `mu agent wait` command. |
| `workspace` | Own VCS checkout, for delegates that edit files. The follow-up names its path. It isolates repository edits only. |
| `cli` | Key for `$MU_<CLI>_COMMAND` (default `pi`), e.g. a cheaper model. |
| `keep` | Keep the pane after it finishes, to talk to it again. |

- Watch or steer: run the attach command.
- Stop: `mu_delegate_cancel`, or `mu agent abort <name> -w scratch`.
- The pane closes after a clean finish; died or timed-out panes stay
  as evidence.
- pi's footer shows how many delegates this session is waiting on.
- Each delegate costs a pane and a pi process.

`MU_DELEGATE=0` hides the tool ([env vars](../reference/env.md)).

## Delegate without pi

From a script or other shell, run what the tool runs:

```bash
mu agent spawn helper-1 -w scratch
mu agent send helper-1 -w scratch --fresh 'Investigate why foo.spec.ts fails. Report the cause.'
mu agent wait helper-1 -w scratch --json
```

Use `--fresh`: a plain send to a reused agent carries the previous
task's context.

`mu agent wait` fires when the agent leaves busy (including to
`needs_input`), never on an already idle agent. For pi, the `--json`
row carries:

- `outcome`: `done`, `empty`, `died`, `timeout`, or `pending`.
- `lastText`: the final message, capped at 64 KiB.

Exit codes: `0` met, `5` timeout, `6` pane died. Non-pi agents have no
`lastText`; read the pane with `mu agent read helper-1 -w scratch -n 80`.

## Keep a helper

Pass `keep: true`, or spawn a named agent in `scratch`. It is created
on first spawn, needs no tasks, and cannot be `init`ed.

```bash
mu agent spawn helper -w scratch
mu agent send helper -w scratch 'Watch CI on PR 1234 and tell me when it is green'
mu agent read helper -w scratch -n 50
mu agent close helper -w scratch
```

A watcher's chat context does not survive compaction. Log each tick
under your own `--kind`; read the latest entry on the next:

```bash
mu log -w scratch --kind pr-state 'pr=1234 sha=abc ci=red -> spawned fixer-1'
mu log -w scratch --kind pr-state -n 1 --json
```

Act only on change. `--since <seq>` replays entries a dead watcher
missed.

## Delegates vs hidden subagents

Claude Code, Codex, and pi-subagents delegate to a hidden child process
and return only its result. A mu delegate is an ordinary agent in a
pane.

|                         | Hidden subagent          | mu delegate |
| ----------------------- | ------------------------ | ----------- |
| Visibility              | none while it runs       | a pane; attach and watch |
| Steer mid-run           | no                       | `mu agent send`; stop with `mu agent abort` |
| Keep talking after it answers | no                 | yes, with `keep: true` |
| Transcript              | collapses into a result  | a normal pi session log |
| If the work grows       | re-brief a new agent     | same task DAG and workspaces |
| Cost                    | light                    | one pane and one pi process |

For many tiny calls, a hidden subagent is lighter. mu bets that seeing
and steering agent work is worth a pane.

## When to stop delegating

Dependencies, several agents, or review need a real workstream: see
[Getting started](getting-started.md) and
[How to dispatch work](dispatch.md). There, `mu task wait` keys on the
task and has `--on-stall`.
