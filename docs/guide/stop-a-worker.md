# How to stop a worker

Use the gentlest step that works, in this order: abort, kick, close.

## Abort the turn (pi agents)

```bash
mu agent abort worker-1 -w auth
```

`mu agent abort` does what Esc does in the pane, through the control
socket, and waits for pi to settle. It kills the running tool and
keeps the session and its context. It works for remote agents too.

- An idle agent is left alone (exit 0).
- Exit 5 means pi was still busy after `--timeout` (default 30 s).
  Go to the next step.
- A follow-up queued before the abort does not run. pi puts it back
  into the pane's editor, unsent. Send it again if you still want it.

To give the agent new work after the abort, send with `--fresh`. See
[Dispatch work to a worker](dispatch.md#pick-the-send-mode).

## Kick the foreground process

Use `mu agent kick` when abort failed, when the agent is not pi, or
when pi's socket is gone:

```bash
mu agent kick worker-1 -w auth                    # SIGINT
mu agent kick worker-1 -w auth --signal SIGTERM
mu agent kick worker-1 -w auth --signal SIGKILL
```

mu finds the foreground process group on the pane's TTY and signals
it. This is the fix for a worker stuck on an unbounded `find /` or a
busy-wait loop. Typing Ctrl-C into the pane does not work, because
the agent CLI catches it as input.

- Kick refuses with `NoForegroundProcessError` when the foreground
  process is the agent CLI itself. Close the agent instead.
- Kick works on local panes only. On herdr it works on Linux only.

To prevent the problem, scope worker prompts to the workspace. Do not
ask for filesystem-wide `find` or `grep -r /`.

## Close the agent

```bash
mu agent close worker-1 -w auth
```

Close kills the pane and deletes the agent row. A clean workspace is
freed with it. If the workspace has edits or commits, close refuses
with exit 4. Then do one of these:

- Run `mu workspace free worker-1 -w auth --commit` to commit pending
  changes and free the workspace, then close.
- Run `mu agent close worker-1 -w auth --discard-workspace` to free
  and close in one step. You lose the changes.

If the worker owned a task, its pane is gone, so the reaper returns
the task to `OPEN` on the next reconcile. A `mu task wait` on that task
exits 6.
