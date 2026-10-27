# Getting started

In this tutorial we install mu, plan two tasks where one blocks the
other, hand the first task to a pi worker, and merge its commit. It
takes about ten minutes.

You need Node.js, the pi coding agent, tmux 3.0
or later, and a git repository to work in. Run every command from
inside a tmux session, in the root of that repository.

## Install mu and the pi package

First, install mu and install its pi package:

```bash
npm i -g @mu-crew/mu
pi install npm:@mu-crew/mu
mu doctor
```

`pi install` loads the mu extension, skill, and recipe prompts as one
package. Once a pi agent is running, the "mu ext" and `ctl` rows of
`mu doctor` report the live extension; before that, "mu ext" says
`unknown`. If pi was already running, restart it so it loads the package.

## Create a workstream

A workstream is one project: one tmux session, its agents, and its
task graph.

```bash
mu workstream init auth
```

```
Created workstream auth (mux session mu-auth)
attach: tmux attach -t mu-auth
```

When a verb leaves a move to make (a wait a send owes, the `--if` apply
of a preview), it ends with a `next:` line you can run as printed.

## Plan two tasks

Now add two tasks. Each needs an impact (1–100) and an effort in
days. `--blocked-by` makes `build` wait for `design`:

```bash
mu task add design -w auth -t "Design the auth module" -i 80 -e 2
mu task add build  -w auth -t "Build the auth module"  -i 80 -e 5 --blocked-by design
mu task next -w auth
```

```
task	design	OPEN	impact=80 effort_days=2	Design the auth module
```

Only `design` is ready. `build` appears when `design` closes.

## Spawn a worker

Spawn a pi agent with its own git worktree:

```bash
mu agent spawn worker-1 -w auth --worktree
```

```
Spawned worker-1 (pi) in window worker-1 of mu-auth, pane %15 with its own worktree
  cwd: ~/.local/state/mu-next/worktrees/auth/worker-1
```

The worker runs in a new window of the `mu-auth` session. To watch
it, run `tmux attach -t mu-auth`. Detach with `Ctrl+b d`.

## Claim the task for the worker

Assign the task before you send any text. The claim is what
`mu wait` watches.

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
mu wait task:design -w auth
```

```
{"ok":true,"data":{"firing":{"kind":"closed","ref":"task:auth/design"},...},"next":null}
```

The exit code tells you what happened:

| Exit | Meaning | Next move |
| ---- | ------- | --------- |
| `0` | the task closed (`firing.kind` `closed`), or the heartbeat cap passed (`heartbeat`, `timedOut: true`; default 1500 s) | merge the work, or run `data.resume` to keep waiting |
| `6` | the worker's pane died and the task went back to `OPEN` | spawn and claim again |
| `7` | the worker sat in `needs_input` for `--stuck-after` seconds (120, or 5 for a pi worker read over its control socket) | read it (`mu agent read worker-1 -w auth`), then answer it |

To keep waiting, run `data.resume` as printed (`mu wait --resume <id> -w auth`):
it replays the stored wait whole, and refuses any other flag. With
`--on-stall warn`, a stalled worker only prints a warning and the wait
keeps running. `--on-stall steer|release` act on a worker you spawned;
see [dispatch](dispatch.md).

A pi worker that ends its turn while it still owns an `IN_PROGRESS`
task gets one reminder to close it or say why not, so exit 7 mostly
means it is blocked or asking something.

## Merge the commit

Inspect the worker's commits (`git -C <worktree> log --oneline`),
cherry-pick what you want, then run your tests on the result:

```bash
git cherry-pick 26278f1
```

Before the next task, rebase the worker's worktree onto the new main.
The worker keeps its pi context:

```bash
cwd=$(mu agent list -w auth --json | jq -r '.agents[] | select(.name == "worker-1") | .cwd')
git -C "$cwd" fetch && git -C "$cwd" rebase origin/HEAD
```

In a repository without a remote, rebase onto local `main`. On a conflict,
run `git -C "$cwd" rebase --abort` and resolve it by hand.

## Check the graph

```bash
mu task next -w auth
```

`build` is ready now. You can claim it for `worker-1` and repeat the
claim, send, wait, and merge steps.

## Close the worker

When you are done, close the agent:

```bash
mu agent close worker-1 -w auth           # preview; prints the --if command
mu agent close worker-1 -w auth --if <n>  # close it
```

Close removes the worktree. It refuses while the worktree has uncommitted
edits, which protects work you have not committed. If the worker made
commits you have not merged, close keeps them on a branch
`mu/auth/worker-1-<sha>` and prints its name.

## Next steps

- [Dispatch work to a worker](dispatch.md) covers more than one
  worker and the `--fresh`, `--interrupt`, `--steer`, and plain send choices.
- [Clean up](cleanup.md) when the workstream is finished.
