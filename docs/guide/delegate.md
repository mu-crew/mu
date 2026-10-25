# How to delegate a one-off task

## Delegate from pi

The mu pi package (`pi install npm:@mu-crew/mu`) installs the
`mu_delegate` and `mu_delegate_cancel` tools in every pi session. Ask pi in plain words:

- "Delegate a review of src/x.ts to a helper."
- "Have three helpers investigate A, B, and C."

pi calls `mu_delegate`. It registers the call as a task (`kind=delegate`,
see [Every call is a task](#every-call-is-a-task)), spawns a pi agent in
the reserved `scratch` workstream and returns at once with the task, the
delegate's name and attach command. The answer arrives later as a
follow-up message; do not poll. Delegates called in one turn run in
parallel.

| Option | Meaning |
| ------ | ------- |
| `task` (required) | All the context. The delegate starts empty. |
| `label` | Names the delegate: `review` gives `delegate-review`. |
| `brief` | Ad hoc persona or ground rules, sent first. Not enforced. |
| `cwd` | Start directory. Default: the caller's. Must exist. |
| `timeout` | Seconds to wait for the answer (default 3600). After it, the answer does not come back; the follow-up gives the `mu agent wait` command. |
| `workspace` | Own git worktree, for delegates that edit files. The follow-up names its path. It isolates repository edits only. |
| `cli` | Key for `$MU_<CLI>_COMMAND` (default `pi`). Only keys set in pi's environment exist. |
| `model` | pi `--model` value, appended to the cli's command (`sonnet`, `<provider>/<model>:high`, copied from `pi --list-models`). Varies models across a panel. tmux only: herdr refuses a command override. |
| `keep` | Keep the pane after it finishes, to talk to it again. |
| `record` | `{ task, workstream? }` (or `task: "<ws>/<task>"`): write the answer's verdict onto that task as a note. See [Record a verdict](#record-a-verdict). |
| `wave` | A label for one fan-out; `mu delegates tally` counts its verdicts per judged task. |
| `workstream` | Holds the delegate task and runs the delegate (default `scratch`). |

- Watch or steer: run the attach command.
- Stop: `mu_delegate_cancel` (a delegate name, a `queued-N` handle or a
  call id), or `mu agent abort <name> -w scratch`. A cancel is recorded:
  the task closes `wontfix` with a report.
- The pane closes after a clean finish; died or timed-out panes stay
  as evidence.
- An answer that finishes while a turn is running queues behind it.
  Escape drops those queued answers from pi. The extension then writes
  one line per answer into the conversation, without starting a turn,
  pointing at a copy under `~/.cache/mu/delegate-answers/` and
  at the delegate's own pi session file. An answer that lands after
  Escape arrives as usual. The dequeue key (alt+up) clears the same
  queue without aborting; the run then ends normally, so the extension
  sends each answer lost that way once more, one at a time, when pi is
  idle. A repeat of an answer that already arrived shows as a one-line
  "already handled" stub.
- `MU_DELEGATE_TRACE=1` logs every follow-up send and pi lifecycle
  event to `~/.cache/mu/delegate-trace.log`, for finding a lost answer.
- Each delegate costs a pane and a pi process. A session runs at most
  `MU_DELEGATE_MAX` at once (default 16). Further calls are queued, up
  to four times the cap: each starts when a slot frees, and `mu_delegate_cancel queued-N`
  drops one. Past the queue a call is **refused**, not lost: its task
  and brief exist, its state is `refused`, and it does not start on its
  own. Reissue it with `mu_delegate_reissue { call_id }` in its pi
  session once a slot frees: same call, same task, never a second
  verdict. Only that live runtime can start or drain a call, so
  `mu delegates reissue` refuses and names the tool. A refused call is not in murmur's pending
  count. A queued call has no pane yet, so quitting pi or `/reload`
  parks it as `refused` (reissue it); pi warns which ones.
- A delegate that stops on an API error (overloaded, connection, auth)
  keeps its pane. The answer names the error and leaves the choice to
  the model: re-issue, or record the check as unverified.
- Every answer without a final text (API error, empty, timeout, died,
  `mu_delegate_cancel`) names the delegate's pi session file and, when
  it wrote anything, a copy of its last message so far under
  `~/.cache/mu/delegate-answers/` (`*.partial.md`). Quitting pi or
  `/reload` lists each running delegate's session file.
- Answers arrive as follow-up messages when pi would otherwise stop,
  never mid-turn. To get several at once, set pi's `followUpMode` to
  `"all"`.

`MU_DELEGATE=0` hides the tool ([env vars](../reference/env.md)).

### Every call is a task

Each `mu_delegate` call creates, in one transaction, a task of
`kind=delegate` in `scratch` (or the `workstream` you name) with the
prompt as its brief, plus a call row keyed by a session-qualified
`call_id` (`pi:<session>:<n>`). The tool result names both:
`{ task, state, call_id }`. A repeat of the same call id with the same
request is a no-op; a changed request under it is refused (exit 4).

| State | Meaning |
| ----- | ------- |
| `queued` | waits for a slot (the task is parked, so it never reaches `mu task next`) |
| `starting`, `running` | the pane is coming up, then working |
| `recording` | the answer is being written |
| `done` | verdict, report and close are all on record |
| `failed` | no answer, or the record failed: the task is closed `rejected`, the answer kept as its report, the pane kept |
| `refused` | past the queue; parked; reissue it |
| `cancelled` | closed `wontfix` with a report |

```bash
mu delegates list --caller pi:<session>       # every call and its state
mu delegates list --all --wave review-1       # one wave
mu delegates tally -w scratch --wave review-1 # CONFIRMED/REFUTED/UNVERIFIED per judged task
mu task notes <task> -w scratch               # its brief, and its report: the full answer
```

The answer is the delegate task's `report`, whole; the pi follow-up is
only an echo, so a dropped echo (Escape, compaction, `/reload`) loses
nothing. `tally` counts one result per call: a done answer by its last
first `VERDICT:` label (none: UNVERIFIED), a failed or cancelled call as
UNVERIFIED, queued, running and refused ones as pending.

### Record a verdict

For a refuter or check, pass `record` so the verdict lands on the task
it judged. The task must exist (`mu task show`), else the call fails
and nothing spawns. When the answer arrives, the tool runs
`mu task note <task> -w <ws> --author <delegate>` once:

- Done: `REFUTER <label> (<delegate>, <elapsed>):`, then the first
  verdict line (`VERDICT:` at the start of a line, behind at most one
  role word such as `REFUTER:`) and everything after it, a multi-line
  `EVIDENCE:` body included, uncapped. Later `VERDICT:` lines are
  evidence text, kept verbatim. Without a verdict line, the whole answer after
  `NO VERDICT LINE:`.
- Timeout, died, empty, error, or cancelled:
  `REFUTER <label>: no verdict (<outcome>)`.

The note, the delegate task's report and its close are written together,
in that order, in one op group (`mu delegates finish`); the delegate
task is closed before its pane. If the record fails the call is
`failed`, never `done`, and the answer is kept as the report.

The follow-up still carries the full answer and ends with
`Recorded on <ws>/<task> as a note.` and where the report is, or the reason
recording failed.

## Delegate without pi

From a script or other shell, run what the tool runs:

```bash
mu agent spawn helper-1 -w scratch
runs=$(mu agent send helper-1 -w scratch --fresh --json 'Investigate why foo.spec.ts fails. Report the cause.' | jq .runs)
mu agent wait helper-1 -w scratch --after-runs "$runs" --json
```

`--after-runs` waits for the first run past the count the send
reported, so a run that settles before the wait starts still counts.

Use `--fresh`: a plain send to a reused agent carries the previous
task's context.

`mu agent wait` fires when the agent leaves busy (including to
`needs_input`), never on an already idle agent unless it finished a run
past `--after-runs`. For pi, the `--json`
row carries:

- `outcome`: `done`, `empty`, `error`, `died`, `blocked`, `timeout`, or
  `pending`. `error` means the run stopped on an API error after pi's
  own retries; `lastError` holds the message and the pane is kept.
  `blocked` means pi is waiting on an extension dialog (`blocked` holds
  its kind and title); the run is not finished.
- `lastText`: the final message, capped at 64 KiB.
- `sessionFile`: the agent's pi session file, holding the full
  transcript (absent for an ephemeral pi or an older extension).

Exit codes: `0` met, `5` timeout, `6` pane died, `7` blocked on a dialog. Non-pi agents have no
`lastText`; read the pane with `mu agent read helper-1 -w scratch -n 80`.

## Keep a helper

Pass `keep: true`, or spawn a named agent in `scratch`. It is created
on first spawn, needs no tasks, and cannot be `init`ed. Its `mu-scratch`
session stays open after the last agent closes; remove it with
`mu workstream teardown scratch` (preview), then `--if <rev>`.

```bash
mu agent spawn helper -w scratch
mu agent send helper -w scratch 'Watch CI on PR 1234 and tell me when it is green'
mu agent read helper -w scratch -n 50
mu agent close helper -w scratch            # preview; prints rev=<n>
mu agent close helper -w scratch --if <n>   # close it
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
| If the work grows       | re-brief a new agent     | same task DAG and worktrees |
| Cost                    | light                    | one pane and one pi process |

For many tiny calls, a hidden subagent is lighter. mu bets that seeing
and steering agent work is worth a pane.

## When to stop delegating

Use delegates when you only need the answer: reviewing someone's PR or
a doc, a fact-check, a go/no-go. Nothing they find lands in the ops
log, which is permanent and syncs to every machine.

Move to a workstream when the findings become work agents will fix, or
the job has dependencies or several stages: see
[Getting started](getting-started.md) and
[How to dispatch work](dispatch.md). There, `mu task wait` keys on the
task and has `--on-stall`. The agent-facing rules for both are in
[recipes/findings.md](../../skills/mu/recipes/findings.md) and
[recipes/tasks-or-calls.md](../../skills/mu/recipes/tasks-or-calls.md).
