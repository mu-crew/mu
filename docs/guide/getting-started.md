# Getting started

In this tutorial we install mu, plan two tasks where one blocks the
other, hand the first task to a pi worker, and merge its commit. It
takes about ten minutes.

You need Node.js, the pi coding agent, tmux 3.0
or later, and a git repository to work in. Run every command from
inside a tmux session, in the root of that repository.

## Install mu and link pi

First, install mu and connect it to pi:

```bash
npm i -g @mu-crew/mu
mu link pi
mu doctor
```

`mu link pi` installs the mu pi extension and the mu skill. In the
output of `mu doctor`, the extension, skill, and `ctl` rows say `ok`.
If pi was already running, restart it so it loads the extension.

## Create a workstream

A workstream is one project: one tmux session, its agents, and its
task graph.

```bash
mu workstream init auth
```

```
Created workstream auth (mux session mu-auth)
Next:
  Attach the session : tmux attach -t mu-auth
  ...
```

Every verb ends with a `Next:` block of follow-up commands. We use
them as we go.

## Plan two tasks

Now add two tasks. Each needs an impact (1–100) and an effort in
days. `--blocked-by` makes `build` wait for `design`:

```bash
mu task add design -w auth -t "Design the auth module" -i 80 -e 2
mu task add build  -w auth -t "Build the auth module"  -i 80 -e 5 --blocked-by design
mu task next -w auth
```

```
┌────────┬────────┬────────────────────────┬────────┬────────┬──────┬───────┐
│ name   │ status │ title                  │ impact │ effort │ ROI  │ owner │
├────────┼────────┼────────────────────────┼────────┼────────┼──────┼───────┤
│ design │ OPEN   │ Design the auth module │ 80     │ 2      │ 40.0 │ —     │
└────────┴────────┴────────────────────────┴────────┴────────┴──────┴───────┘
```

Only `design` is ready. `build` appears when `design` closes.

## Spawn a worker

Spawn a pi agent with its own git worktree:

```bash
mu agent spawn worker-1 -w auth --workspace
```

```
Spawned worker-1 (pi) in window worker-1 of mu-auth, pane %15 with auto-workspace
  workspace: ~/.local/state/mu/workspaces/auth/worker-1 (git)
```

The worker runs in a new window of the `mu-auth` session. To watch
it, run `tmux attach -t mu-auth`. Detach with `Ctrl+b d`.

## Claim the task for the worker

Assign the task before you send any text. The claim is what
`mu task wait` watches.

```bash
mu task note design -w auth 'SCOPE: write docs/auth.md with the token design'
mu task claim design -w auth --for worker-1
```

```
Claimed design for worker-1 (OPEN → IN_PROGRESS)
```

## Send the task

`--fresh` starts a new pi session and sends the prompt into it in
one step:

```bash
mu agent send worker-1 -w auth --fresh 'Work on task design. Read: mu task notes design -w auth.
When done: git commit -am "Design auth", then mu task close design -w auth --evidence "<what you verified>"'
```

The worker reads its notes, does the work, commits in its worktree,
and closes the task.

## Wait for the task to close

```bash
mu task wait design -w auth --first --on-stall exit
```

```
auth/design
any-of 1 reached CLOSED in 41094ms
Next:
  Cherry-pick worker-1's commit onto your branch : git cherry-pick 26278f1...
  Refresh worker-1's workspace onto current main : mu workspace refresh worker-1 -w auth
```

The exit code tells you what happened:

| Exit | Meaning | Next move |
| ---- | ------- | --------- |
| `0` | the task closed | merge the work |
| `5` | `--timeout` expired (default 600 s) | wait again |
| `6` | the worker's pane died and the task went back to `OPEN` | spawn and claim again |
| `7` | the worker sat in `needs_input` for 5 minutes | `mu agent read worker-1 -w auth`, then answer it |

Without `--on-stall exit`, a stalled worker only prints a warning and
the wait keeps running.

## Merge the commit

Run the cherry-pick command from the `Next:` block, then run your
tests on the result:

```bash
git cherry-pick 26278f1
```

Before the next task, rebase the worker's worktree onto the new main.
The worker keeps its pi context:

```bash
mu workspace refresh worker-1 -w auth
```

The default target is the remote's main branch (`origin/HEAD`). In a
repository without a remote, name the branch: `--from main`.

## Check the graph

```bash
mu task next -w auth
```

`build` is ready now. You can claim it for `worker-1` and repeat the
claim, send, wait, and merge steps.

## Close the worker

When you are done, free the worktree and close the agent:

```bash
mu workspace free worker-1 -w auth
mu agent close worker-1 -w auth
```

`mu agent close` refuses while the worktree has commits or edits that
mu has not freed. That protects work you have not merged.

## Next steps

- [Dispatch work to a worker](dispatch.md) covers more than one
  worker and the `--fresh`, `--steer`, and plain send choices.
- [Use the TUI dashboard](tui.md): run bare `mu` to see every
  workstream at once.
- [Clean up](cleanup.md) when the workstream is finished.
