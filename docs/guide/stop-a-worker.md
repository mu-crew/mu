# How to stop a worker

Use the gentlest step that works, in this order: abort, close.

## Abort the turn

```bash
mu agent abort worker-1 -w auth
```

### pi

`mu agent abort` does what Esc does in the pane, through the control
socket, and waits for pi to settle. It kills the running tool and
keeps the session and its context. It works for remote agents too.

- An idle agent is left alone (exit 0).
- Exit 5 means pi was still busy after `--timeout` (default 30 s).
  Close the agent.
- A follow-up queued before the abort does not run. pi puts it back
  into the pane's editor, unsent. Send it again if you still want it.

### Claude Code, Codex, cursor-agent and Muse Code

On tmux these are on the `hooks` channel, and `mu agent abort` presses
Escape in the pane. The session and its context stay.

- codex and muse confirm the stop with their own interrupt event,
  cursor-agent with an aborted `stop`. None within `--timeout` is exit 5.
- claude reports no interrupt, so mu records one: the agent reads `idle?`
  until its next event, and the result says `stopped: unconfirmed`. A send
  to `idle?` is allowed; if the Escape only closed an overlay, that send
  reports `ack: unknown`.
- A stopped agent gets no key (exit 0).
- A remote one records the interrupt on its host through the profile's
  `--exec`.
- A turn ended by an abort carries no final text, so no `CLOSE:` block from
  it is applied.

On herdr and Rex, a non-pi agent has no abort: close it.

To give the agent new work after the abort, send with `--fresh` (on `hooks`,
the harness's fresh command and then the text). See
[Dispatch work to a worker](dispatch.md#pick-the-send-mode).

## Close the agent

```bash
mu agent close worker-1 -w auth             # preview: writes and kills nothing, prints rev=<n>
mu agent close worker-1 -w auth --if <n>    # apply that preview
```

Bare close only previews: it names the pane, the tasks the agent owns
(an `IN_PROGRESS` one goes back to `OPEN`), the worktree's state and
the `--if` command that applies it. Pass `--if <n>` to close. It
refuses (exit 4, nothing killed) when the agent changed since the
preview: a task claimed or released, a respawn under the same name.
Another `mu` closing or spawning the same name makes it exit 4 too
(`AgentLockBusyError`; nothing was done, retry). If the agent was
replaced while the close was running, the replacement is left alone
(`AgentReplacedError`).

Close kills the pane and deletes the agent row. It is also the step
for a turn that will not stop, and for a non-pi agent on herdr or Rex,
which mu cannot abort. To prevent a
worker stuck on an unbounded `find /` or a busy-wait loop, scope worker
prompts to the worktree. Do not ask for filesystem-wide `find` or
`grep -r /`. A clean worktree is removed with it, and unmerged commits
are kept on a new branch `mu/<workstream>/<agent>-<sha>` that the close
prints. If the worktree has uncommitted edits, close refuses with exit 4
before it kills the pane, and the preview offers no apply command. Then
do one of these:

- Commit the edits in the worktree (`git -C <cwd> add -A && git -C <cwd>
  commit`), then preview and close again.
- Preview with `--discard` (`mu agent close worker-1 -w auth --discard`),
  then apply it with `--if <n>` to drop the edits in one step. You lose
  them, and no branch is made.

If the worker owned a task, its pane is gone, so the reaper returns
the task to `OPEN` on the next reconcile. A `mu wait` on that task
exits 6.
