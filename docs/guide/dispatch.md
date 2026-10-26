# How to dispatch work to a worker

This guide assumes you finished [Getting started](getting-started.md).
The agent-facing loop and its traps are in
[recipes/orchestrator-loop.md](../../skills/mu/recipes/orchestrator-loop.md).

## Claim before you send

Always claim the task for the worker before the first send, even for a
one-shot reviewer:

```bash
mu task claim build -w auth --for worker-1
```

`mu wait` watches tasks, and the reaper returns a claimed task to
`OPEN` when its pane dies. An unclaimed task gets neither. If no task
exists, create one with `mu task add --note '<brief>'`.

- `--for` takes a worker name or a qualified `<workstream>/<name>`.
  The worker stays in its own workstream. Only the ownership crosses.
- Inside a worker's pane, bare `mu task claim <id>` claims for
  `$MU_AGENT_NAME`, which spawn injects.
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
  reply). Its `next` is ONE line, the exact wait: `mu wait 'agent:<ws>/<a>@<n>#<inc>'`.
  The `#<inc>` pin refuses (exit 4) when the agent restarted: its run is gone, so
  re-send the brief. `--wait` enters that wait at once: one JSON document, the wait's, with the
  send's receipt as `data.sent`. A delivered send (also `spawn --send`, `spawn --task`,
  `send --interrupt`, `task claim --for`) is registered for the caller, so a bare `mu wait`
  finds it with no ref; `mu task claim <id> --for <w> --and-wait` dispatches and waits.
- A send written to the socket but never answered is checked, not
  repeated: mu asks once for the `msgId` and either reports success
  (`receipt: confirmed-after-timeout`) or exits 1 with `next` the receipt
  check `mu agent check <a> <msgId> -w <ws> --json` (only while the agent the
  send went to is still registered). That verb prints `accepted runs=<n>
  at=<iso>` (0), `not-accepted` (3) or `unreachable` (1). Only `accepted`
  is an answer: **`not-accepted` is not "unsent"**. The extension keeps
  its last 64 ids, so an old send reads `not-accepted` after eviction,
  and a send that is still in flight can too. Look at the pane
  (`mu agent read`) before any resend.

After `mu task claim <id> --for <w>`, `next` is the send that hands the task over (`--fresh` for a pi worker).
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
mu wait task:auth/build task:auth/docs
```

`mu wait` prints ONE JSON document, with no `--json` flag. Refs are typed
(`task:`, `agent:`, `delegate:`); with none, it waits on what you started.

- `data.firing` is the event: `closed`, `settled`, `input`, `dead`, `stall`,
  `delegate`, or `heartbeat` on a timeout (`ok:true`, `timedOut`, exit 0).
- `data.snapshots` are the refs' real states; `data.resume` is the command
  that keeps waiting, with every flag you gave. Run it as printed: it takes
  no other flag (only a matching `-w`). When two watched owners die in one
  wait, only the first fires; follow `resume` to hear the second. A fresh
  `mu wait` with the same refs starts a new anchor and reports the earlier
  death as history.
- `data.cursor` is what this result consumed per ref (`incarnation`, `runs`);
  the next wait starts after it, so the same event is never reported twice.
  `cursorCut` counts entries dropped to fit the 4 KB result.
- `next` is the stored resume while something is still owed, else null.
- Exit codes: `0` event or timeout, `6` the owner's pane died, `7` the owner
  sat in `needs_input` for `--stuck-after` seconds (default 120, or 5 for a pi
  worker read over its control socket), `130`/`143` SIGINT/SIGTERM (the
  snapshot and `resume` are still printed). `--on-stall warn` flags the stall
  on the snapshot and keeps waiting; `steer` sends the stalled pi worker you
  spawned one fixed reminder and keeps waiting; `release` frees its task and
  ends the wait. `data.action` (and a stderr line) says `sent`, `released`,
  `refused` or `unknown`; both refuse a worker you did not spawn or a task not
  permitted with `mu task auto`. `mu task wait` is the same wait over task
  refs.
- `--all` waits for every ref; `--until-text <re>` waits for a run's final
  text; `--wave <name>` waits on your delegate wave and `data.tally` says
  `6/12 CONFIRMED, ...`.

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
- `mu human-needed <reason>` records a parked `human` task for a decision only a
  person can make. It never becomes ready and resolves only by `mu task close`
  (unpark, claim and a CLOSE block are refused).
- `release` clears the owner and returns `IN_PROGRESS` to `OPEN`.

## Authorise tasks for the executor

```bash
mu task auto build --cli pi --max 2 -w auth
mu task auto --blockers-of umbrella --cli pi -w auth
mu task auto build --off -w auth
```

Ready is not permission: the executor acts only on an `auto` task, and only on
the machine that authorised it. `--off` keeps the run counter.

```bash
mu next --dry -w auth              # the plan; no pane, socket or write
mu next --hold -w auth             # dispatch, then wait; recover deaths and API errors
mu next --workers 2 -w auth        # never more than 2 working; a CLOSED task's idle pane is free
```

`mu next` also recovers. A worker whose pane died is reaped and its task retried as a new
attempt; a live worker whose run ended in an API error is sent its brief again in place (never
reaped, never duplicated). Each retry costs one run of the ceiling; a remote worker's tree is never
touched. At the ceiling, or for anything it will not guess, it reports an `attention` move.

`mu next --refute [--refute-cli <key>]` also launches ONE checker per task a worker closed as `done`
(a delegate call in `scratch`, wave `refute-<ws>`, briefed from the task's pinned brief and its
report). Its `VERDICT:` is recorded on the task before the call closes; the checker never accepts,
reopens or closes the work, and a wontfix/rejected close gets none. It needs a caller identity
(`PI_SESSION_ID` or a managed agent) and a cli that speaks ctl (default: the task's own). A repeat
`mu next --refute` reads a running checker and records its answer (or its death or timeout as
UNVERIFIED); `--dry` lists the owed checks. `mu delegates tally --wave refute-<ws>` counts them.

To wait on something outside the repo, such as an upstream release,
block on a placeholder task and close it when the thing lands.
