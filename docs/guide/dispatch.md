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
| Busy, and the current work is wasted (wrong input, changed rule): act now | `mu agent send worker-1 --interrupt '<text>'` |
| Busy, advice that can wait for the next tool boundary | `mu agent send worker-1 --steer '<text>'` |
| Answering a question, or adding to the same task | `mu agent send worker-1 '<text>'` |

- `--fresh` starts a new pi session and sends the prompt into it as
  one operation. It refuses with exit 4 while pi is busy. Run
  `mu agent abort` first, or pass `--force` to drop the running turn.
- Never send `/new` and then the prompt as two sends to pi. The prompt
  can land during the reset and vanish.
- A plain send to a busy agent queues as a follow-up: pi sees it after
  the run ends. `--steer` lands between tool calls, after the running
  tool returns; it does not stop a long tool such as a test batch, a
  wait, or a `sleep`.
- `--interrupt` aborts the run (kills the running tool), waits for pi
  to settle, then sends the text as a new run. Queued messages go back
  to the pane's editor unsent. Exit 5 when pi does not settle within
  `--timeout` (default 30 s); the text is then not sent.
- `/new`, `/reload` and `/compact [instructions]` run inside pi through
  the socket and report pi's answer (for example `Nothing to compact`).
  They refuse with exit 4 while pi is busy; `--force` overrides. Any
  other slash command exits 2.
- If the socket does not answer, the send fails with exit 1 and
  pastes nothing.
- A send's `--json` carries `msgId`, `incarnation` and `delivery`
  (`delivered`, or `unknown` in the error JSON of a send that got no
  reply). Its `Next:` block is ONE line, the exact wait: `mu agent wait <a> -w <ws> --after-runs <n>
  --inc <i> --json`. `--inc` refuses (exit 4) when the agent restarted:
  its run is gone, so re-send the brief.
- A send written to the socket but never answered is checked, not
  repeated: mu asks once for the `msgId` and either reports success
  (`receipt: confirmed-after-timeout`) or exits 1 naming
  `mu agent check <a> <msgId>`. That verb prints `accepted runs=<n>
  at=<iso>` (0), `not-accepted` (3) or `unreachable` (1). Only `accepted`
  is an answer: **`not-accepted` is not "unsent"**. The extension keeps
  its last 64 ids, so an old send reads `not-accepted` after eviction,
  and a send that is still in flight can too. Look at the pane
  (`mu agent read`) before any resend.

After a claim, spawn, or wait, the `Next:` block prints the right send.
`mu agent spawn --send <text>` spawns and sends the first prompt in one
call; with `--task <id>` it is one journaled attempt (below); `--next-free` takes the next free name when `<name>` is taken
(`worker-1` → `worker-2`; the stem is cut to keep the name within 32
chars, and it gives up with exit 4 when no free name is near).

### Spawn for a task

`mu agent spawn <name> --task <id> --send <text>` spawns, **claims the task
for the new agent**, sends the text and pins it as the task's `brief` (kept
when the task has one), as one attempt. A journal (`spawn_receipts`) is
written before each step, so the same command never sends a second prompt.

- Same command again = replay: it returns the saved delivery
  (`task.replay: true`, same `msgId`). `--attempt <key>` names the attempt
  (default: the task id); a changed text or name under one key exits 4, and
  reopened work needs a new key.
- Fails **before** the prompt could be written (no ctl, Claude's trust
  dialog, a claim that lost the task, the extension refused): its own pane,
  claim and worktree are rolled back, the key is reusable.
- Delivery **unknown** (written, no reply; the pane died after the write):
  exit 1, the pane and the claim stay, `task.state` is `unknown`, and a
  replay asks the extension once. Never reaped, never resent. Check it
  with `mu agent check`, read the pane, then decide.
- A replay after the agent was deleted, or its name reused, reports the
  historical delivery with `task.stale` (`deleted` | `replaced`); the
  replacement is never claimed or sent to.
- The prompt goes only to the agent the spawn created (also plain
  `spawn --send`): a replaced name, a closed task, or a task someone else
  owns now refuses it (exit 4) with nothing sent.
- Another mu process running the same attempt exits 4 (`SpawnAttemptBusyError`);
  retry and the replay returns its outcome.

### Non-pi agents

Agents other than pi have no control socket. On herdr, mu sends the
text with herdr's atomic `agent prompt`. To start a new session, send
`/new` (codex: `/clear`), then the prompt. If mu prints
`warning: ... was NOT submitted`, the agent has not seen the text.
Read the pane before you wait. On tmux, a send to a non-pi agent exits
4 (`AgentSendUnsupportedError`): spawn it on herdr (`MU_MUX=herdr`) or
use pi.

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

Single-quote short prompts. Pass prose (apostrophes, `$`, backticks) as `-` with a
quoted heredoc: `mu agent send worker-1 - <<'EOF'`; see
[brief](../../skills/mu/recipes/brief.md#quoting). To see only what the worker wrote after the claim, run
`mu task notes build -w auth --since-claim`.

## Give each worker a worktree

`mu agent spawn --worktree` creates a git worktree for the agent and starts
its pane there: the worker's cwd is its worktree. Outside a git repo it
fails with exit 4. `--from <ref>` picks the starting commit and `--root <repo>`
the repo; both default to the HEAD of the checkout you run in (a linked one included). You cherry-pick from it.

Refresh the worktree between tasks. The rebase keeps the agent's pi
context. Before a `--fresh` send:

```bash
cwd=$(mu agent list -w auth --json | jq -r '.agents[] | select(.name == "worker-1") | .cwd')
git -C "$cwd" fetch && git -C "$cwd" rebase origin/HEAD
```

Use `origin/HEAD` as the base, or local main when you merged locally. On a
conflict, run `git -C "$cwd" rebase --abort` and tell the human. To throw
the worktree away instead, preview `mu agent close worker-1 -w auth --discard`
and apply it with `--if <n>`.

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

- `close` needs `--evidence "<command + result>"` for `done`; the other
  substates need `--why`, which is their evidence. `done` also refuses
  while a blocker is open (exit 4, `mu task tree <id>` lists them); the
  other substates may close over open blockers. Every `CLOSED` substate
  satisfies a blocker.
- Deciding a finding (`accept`, or `close --as rejected|wontfix|duplicate`)
  with a reason under 40 characters and no `VERDICT:` or `REFUTER` note
  prints a warning. The exit code stays the same. A `REJECTED` or `SUPERSEDED`
  note appends the title of each task id it names.
- `--if-ready` closes only when every blocker is closed. Otherwise it
  lists the open blockers and exits 0.
- A parked task leaves the ready set, and its dependents keep waiting.
- `release` clears the owner and returns `IN_PROGRESS` to `OPEN`.

## Authorise tasks for the executor

```bash
mu task auto build --cli pi --max 2 -w auth
mu task auto --blockers-of umbrella --cli pi -w auth
mu task auto build --off -w auth
```

Ready is not permission: the executor acts only on an `auto` task, and only on
the machine that authorised it. `--off` keeps the run counter.

To wait on something outside the repo, such as an upstream release,
block on a placeholder task and close it when the thing lands.
