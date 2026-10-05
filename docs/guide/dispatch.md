# How to dispatch work to a worker

This guide assumes you finished [Getting started](getting-started.md).
The agent-facing loop and its traps are in
[recipes/orchestrator-loop.md](../../skills/mu/recipes/orchestrator-loop.md). For several workers in
one repo, see [waves](../../skills/mu/recipes/waves.md); for runs that
last hours, see [long runs](../../skills/mu/recipes/long-run.md).

## Claim before you send

Always claim the task for the worker before the first send, even for a
one-shot reviewer:

```bash
mu task claim build -w auth --for worker-1
```

`mu task wait` watches tasks, and the reaper returns a claimed task to
`OPEN` when its pane dies. An unclaimed task gets neither. If no task
exists, create one with `mu task add --note '<brief>'`.

- `--for` takes a worker name or a qualified `<workstream>/<name>`.
  The worker stays in its own workstream. Only the ownership crosses.
- Inside a worker's pane, bare `mu task claim <id>` uses the pane
  title as the worker name.
- To do the task yourself, use `mu task claim <id> --self`.

## Pick the send mode

For a pi agent, `mu agent send` goes through the agent's control
socket. Pick the mode by what the agent is doing:

| Situation | Command |
| --------- | ------- |
| New task, any state | `mu agent send worker-1 --fresh '<brief>'` |
| Busy, and you want to interrupt the current run | `mu agent send worker-1 --steer '<text>'` |
| Answering a question, or adding to the same task | `mu agent send worker-1 '<text>'` |

- `--fresh` starts a new pi session and sends the prompt into it as
  one operation. It refuses with exit 4 while pi is busy. Run
  `mu agent abort` first, or pass `--force` to drop the running turn.
- Never send `/new` and then the prompt as two sends to pi. The prompt
  can land during the reset and vanish.
- A plain send to a busy agent queues as a follow-up.
- `/new`, `/reload` and `/compact [instructions]` run inside pi through
  the socket and report pi's answer (for example `Nothing to compact`).
  They refuse with exit 4 while pi is busy; `--force` overrides. Any
  other slash command exits 2; add `--via mux` to type it into the pane.
- If the socket does not answer, the send fails with exit 1 and
  pastes nothing. `--via mux` pastes into the pane on purpose.

After a claim, spawn, or wait, the `Next:` block prints the right send.

### Non-pi agents

Agents other than pi have no control socket, so mu pastes the text
into the pane. To start a new session, send `/new` (codex: `/clear`),
then the prompt. If mu prints `warning: ... was NOT submitted`, the
agent has not seen the text. Read the pane before you wait. On a slow
tmux link, raise `MU_SEND_DELAY_MS` (default 500 ms).

## Write the brief

Put the full brief in a task note, so it survives context compaction
and the next agent can read it. Send a short prompt that points at it:

```bash
mu task note build -w auth 'FILES: src/auth/\nVERIFY: npm test\nSCOPE: no schema changes'
mu agent send worker-1 -w auth --fresh 'Work on build. Read: mu task notes build -w auth'
```

End the brief with the exact final action, for example:

```text
⚠️ FINAL ACTION
git commit -am '...' THEN
mu task close build -w auth --evidence '...'
```

Single-quote prompts that contain `$` or backticks. To see only what the worker wrote after the claim, run
`mu task notes build -w auth --since-claim`.

## Give each worker a workspace

`mu agent spawn --workspace` creates a jj, sl, or git worktree for the
agent (`cp -a` outside a repo). You cherry-pick from it.

Refresh the workspace between tasks. The rebase keeps the agent's pi
context:

```bash
mu workspace refresh worker-1 -w auth
```

It rebases onto the remote's main (`origin/HEAD`); without a remote,
pass `--from main`. It refuses on a dirty tree. On a conflict it exits 5
with a `cd` hint. To throw the workspace away instead, run
`mu workspace free worker-1 -w auth`.

Claim and send warn when the worker's workspace is 10 or more commits
behind main. `--strict-staleness` makes that a refusal (exit 4).

## Wait for the first task to close

Wait on every in-flight task and handle the first one that closes:

```bash
mu task wait auth/build auth/docs --first --on-stall exit --json
```

- `--first` prints the closed ref and fills `firing` in `--json`.
  `--any` leaves `firing` null even on success.
- `nextSteps[0]` is the cherry-pick command for the worker's new
  commits. If the worker closed without committing, it says so.
- Exit codes: `0` met, `5` timeout, `6` the owner's pane died,
  `7` the owner sat in `needs_input` for `--stuck-after` seconds
  (default 120, or 5 for a pi worker read over its control socket). Exit 7 is the default; `--on-stall warn` keeps
  polling instead.

Exit 7 has several causes: the worker finished but did not close, it
asked a question, or it hit a prompt. In each case, run the exit's
`Next:` first. For a pi owner, it starts with
`mu agent wait <owner> --after-runs <runs-1> --json`, which prints the
last answer at once. Then it shows `mu agent read <owner>`, for the
dialogs and crashes that only the pane shows.

Pipeline the work: merge one task, run your tests on the merged tree,
then dispatch the next task. Waiting for a whole wave hides partial
progress.

## Close and park tasks

```bash
mu task close spike -w auth --as wontfix --why "superseded by v2"
mu task close umbrella -w auth --if-ready
mu task park polish -w auth --why "after the release"
mu task release build -w auth
```

- Closed substates other than `done` need `--why`. Every `CLOSED`
  substate satisfies a blocker.
- Deciding a finding (`accept`, or `close --as rejected|wontfix|duplicate`)
  with a reason under 40 characters and no `VERDICT:` or `REFUTER` note
  prints a warning. The exit code stays the same. A `REJECTED` or `SUPERSEDED`
  note appends the title of each task id it names.
- `--if-ready` closes only when every blocker is closed. Otherwise it
  lists the open blockers and exits 0.
- A parked task leaves the ready set, and its dependents keep waiting.
- `release` clears the owner and returns `IN_PROGRESS` to `OPEN`.

To wait on something outside the repo, such as an upstream release,
block on a placeholder task and close it when the thing lands.
