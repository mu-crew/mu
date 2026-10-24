# How to stop a worker

Use the gentlest step that works, in this order: abort, close.

## Abort the turn (pi agents)

```bash
mu agent abort worker-1 -w auth
```

`mu agent abort` does what Esc does in the pane, through the control
socket, and waits for pi to settle. It kills the running tool and
keeps the session and its context. It works for remote agents too.

- An idle agent is left alone (exit 0).
- Exit 5 means pi was still busy after `--timeout` (default 30 s).
  Close the agent.
- A follow-up queued before the abort does not run. pi puts it back
  into the pane's editor, unsent. Send it again if you still want it.

To give the agent new work after the abort, send with `--fresh`. See
[Dispatch work to a worker](dispatch.md#pick-the-send-mode).

## Close the agent

```bash
mu agent close worker-1 -w auth
```

Close kills the pane and deletes the agent row. It is also the step
for a non-pi agent, which has no socket to abort through. To prevent a
worker stuck on an unbounded `find /` or a busy-wait loop, scope worker
prompts to the worktree. Do not ask for filesystem-wide `find` or
`grep -r /`. A clean worktree is removed with it, and unmerged commits
are kept on a new branch `mu/<workstream>/<agent>-<sha>` that the close
prints. If the worktree has uncommitted edits, close refuses with exit 4
before it kills the pane. Then do one of these:

- Commit the edits in the worktree (`git -C <cwd> add -A && git -C <cwd>
  commit`), then close again.
- Run `mu agent close worker-1 -w auth --discard` to close and drop the
  edits in one step. You lose them, and no branch is made.

If the worker owned a task, its pane is gone, so the reaper returns
the task to `OPEN` on the next reconcile. A `mu task wait` on that task
exits 6.
