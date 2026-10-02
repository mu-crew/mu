# How to delegate a one-off task

Use this when you want one helper, not a crew with a task graph.
There are three ways to get one, from least to most ceremony:

| You want | Use |
| -------- | --- |
| A one-shot answer delivered back to your pi session | the `mu_delegate` tool |
| The same, from a shell or script | spawn, send, and `mu agent wait` |
| A helper you keep talking to | an agent in the `scratch` workstream |

## Delegate from pi

`mu link pi` installs two tools in every pi session: `mu_delegate`
and `mu_delegate_cancel`. Ask pi to delegate, or call the tool with a
`task` that holds all the context the delegate needs.

The tool spawns a pi agent in the `scratch` workstream, sends the
task, and returns at once. When the delegate finishes, its final
answer arrives in your session as a follow-up message. Several
delegates run in parallel.

- The pane stays attachable while the delegate works. You can watch
  it, steer it, or abort it.
- After a clean finish the pane closes. Pass `keep: true` to keep it
  and keep talking to the delegate.
- A pane that died or timed out stays open as evidence.
- `mu_delegate_cancel` aborts the delegate and closes its pane.

Each delegate costs one pane and one pi process.

## Delegate from a shell

```bash
mu agent spawn helper-1 -w scratch
mu agent send helper-1 -w scratch 'Investigate why foo.spec.ts fails. Report the cause.'
mu agent wait helper-1 -w scratch --json
```

`mu agent wait` fires when the agent goes from busy to any other
state. An agent that is already idle does not fire, so the wait is
for this work only. For a pi agent, the `--json` row carries:

- `outcome`: `done`, `empty`, `died`, `timeout`, or `pending`.
- `lastText`: the text of the agent's final message, capped at 64 KiB.

Exit codes: `0` met, `5` timeout, `6` the agent's pane died. For
non-pi agents there is no `lastText`. Read the pane with
`mu agent read helper-1 -w scratch -n 80`.

`mu agent wait` also fires on `needs_input`. For task-graph work, use
`mu task wait` instead. It keys on the task and has `--on-stall`.

## Keep a helper in `scratch`

`scratch` is a reserved workstream for helpers. It is created on the
first spawn, needs no tasks, and you cannot `init` it.

```bash
mu agent spawn helper -w scratch
mu agent send helper -w scratch 'Watch CI on PR 1234 and tell me when it is green'
mu agent read helper -w scratch -n 50
mu agent close helper -w scratch
```

`mu state` and the TUI flag idle scratch agents so they do not pile up.

When the work needs more than one agent, dependencies, or review,
create a real workstream with `mu workstream init <name>`.

## Remember state across watcher ticks

A watcher loop must remember what it last saw, and its chat context
does not survive compaction. Write a log entry with your own `--kind`
on every tick, and read the latest one on the next:

```bash
mu log -w scratch --kind pr-state 'pr=1234 sha=abc ci=red -> spawned fixer-1'
mu log -w scratch --kind pr-state -n 1 --json
```

Act only when the new observation differs from the last entry.
`--since <seq>` replays entries that a dead watcher missed.
