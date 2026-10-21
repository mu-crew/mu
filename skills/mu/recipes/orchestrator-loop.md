# Orchestrator loop

Use when you run a workstream: you dispatch DAG tasks to workers and
merge their commits. The hard rules in SKILL.md still apply; this is
the loop and the reasons behind them.

## Every turn

1. `mu state -w <ws>` — read agents, IN_PROGRESS, ready tasks.
2. Spawn one agent per ready task, up to the ceiling below. Tasks that
   edit the same files are chained with `block`, so only one is ready
   ([waves](waves.md)).
3. **Claim before sending — even one-shot reviewers/scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`.
   If no task exists, `mu task add` first (`--note 'REPRO: ...'` when
   the title is not enough). Ownership is durable and waitable; agent
   state is not. Review tasks: [adversarial-review](adversarial-review.md).
4. Run `mu workspace refresh <w>`, then send a [brief](brief.md) with
   `mu agent send <w> --fresh '...'` (new session + prompt in one step;
   refuses while busy). The brief ends with its final-action block.
5. `mu task wait ... --first --on-stall exit --json`.
6. Cherry-pick the accepted worker's **new** commit(s) into a merge batch
   (below), then continue the loop in the same turn. Do not barrier or
   loop in shell.
   Only `CLOSED/done` ships; other closes: read the reason note.
7. Repeat from `mu state`.

## Concurrency

Write the ceiling on the umbrella before the first wave
(`CONCURRENCY: delegates 12, workers 4`) so a resumed orchestrator
keeps it.

- **[Delegate calls](tasks-or-calls.md#delegate-call)** (read-only): 10 to 20 at once is reasonable.
  Token spend and provider rate limits bind first; start near 8 and
  raise after a clean wave. `mu_delegate` runs at most
  `MU_DELEGATE_MAX` (default 16) and queues up to four times that
  (`queued-N`, started as slots free); past that it refuses.
- **Answers arrive when you stop**, as pi follow-up messages, never
  mid-turn. pi's `followUpMode: "all"` delivers every waiting answer in
  one turn instead of one turn each; each answer names its delegate and
  ends with its `VERDICT: <id>` block, so a batch still maps back. Read
  every verdict in the batch before deciding any.
- **Workers with workspaces** build and test: about one per CPU core,
  fewer when targeted slow checks contend for resources. A remote host has
  its own session cap ([remote-workers](remote-workers.md)).
- **Stream dispatch.** Keep the pool full: dispatch the next unit
  when one closes, rather than waiting for a whole wave. With the
  `codemode` tool, a [driver](codemode-driver.md) can dispatch a batch
  of workers in one script.

## Waiting

Use `--first --on-stall exit`: `--first` populates `.firing`, and
`--on-stall exit` stops an unattended wait when a worker needs attention.
Exit 6: the owner's pane died and the reaper reopened the task; exit 7:
the owner sat in `needs_input`. Run the exit's `Next:` and answer: the
worker may be waiting on you. For a pi owner it leads with
`mu agent wait <owner> --after-runs <runs-1> --json`, which returns the
last answer at once. The pane read follows because dialogs and crashes
show only in the pane.

Never release or reassign a task because its owner reads `unknown`:
that is degraded reading, not absence. Read the pane or run `mu doctor`
first. The reaper acts only on a dead pane.

For an idle worker, read its last answer (the same `--after-runs`
wait for pi, else the pane), then answer, retry, or release its task.
`MU_IDLE_THRESHOLD_MS` defaults to 5m. A remote owner: for pi,
`mu agent wait --after-runs` first, then poll once; otherwise poll once
per turn ([remote-workers](remote-workers.md#step-5-poll-once-per-turn)).

## Merging

- **Pipeline; don't barrier.** Cherry-pick accepted new commits as tasks
  close and dispatch the next unit. Choose a bounded merge batch; an umbrella
  wait hides progress and stale branches can restore reverted code.
- **Pin the batch tree.** Run full slow once, plus fast if slow excludes it,
  under [the gate contract](test-health.md#gate-contract). Keep the tested
  checkout unchanged during the run; independent workers continue in their
  workspaces. Later merges form the next batch, not an extension of this pass.
  Remote hosts: [run the merged gate there](remote-workers.md#run-the-merged-gate-on-the-host).
- **Bisect a failed batch.** Isolate the offending commit/interaction, fix it,
  and gate the corrected merged tree before shipping.
- **Push only the verified tree.** Make `git push` the last line under
  `set -e`; required integration and safety checks must actually run.
  Record the gate result and slow duration with the merged tree in the merge
  note/`mu log`. Queue [upkeep](test-health.md#upkeep-loop) on a budget crossing
  or milestone, rather than stopping all independent work.
- **Accept evidence, not close notes.** Re-run the key measurement from
  a clean checkout; close notes have claimed unpushed commits. A
  worker's "done" counts only once the diff shows the change. Your own
  accept and close notes name the check run and the commit.
- **Ask whether the check could have failed.** A gate that cannot say
  no is not evidence: a test filtered to zero cases, a script you wrote
  agreeing with itself, a fixture you tuned on. A nonzero diff is a
  failure even when the command exited 0.

## Build cache

Keep build targets private per workspace and auth/profile lane. Share dependency
downloads and use an existing compiler cache when available; measure cold/warm
cost and contention. Keep normal-auth, test-auth and release artifacts distinct,
with explicit executable paths for consumers. A shared writable Cargo target
can replace a binary after its build lock is released, while tests still use it.
Warm-up may copy a quiescent snapshot into private storage, never hardlinks or
a live target. This is build guidance, not a new mu cache or dependency.

## Sending

A running worker sees what you send, never a new task note: deliver
an instruction for it with a send (or the next `--fresh` brief), and
keep the note as the durable copy. pi:

| `mu agent send` | busy pi acts | Use for |
| --- | --- | --- |
| plain | after the run ends | answers, same-task additions |
| `--steer` | after the current tool call | advice that can wait for the tool boundary |
| `--interrupt` | now: kills the running tool | a correction that wastes the current work (stale input, wrong target, changed stop rule) |
| `--fresh` | refused (`--force` drops the run) | unrelated work: new session + prompt |

- claude-code/codex: send `/new` (codex: `/clear`), then the prompt; a
  send it cannot confirm prints a `warning:` on stderr.
- Use `mu agent send`, not raw mux input. Quote prompts per
  [brief](brief.md#quoting).
- Cross-workstream wait and claim use qualified refs; only task
  ownership crosses.
- A long run drifts unseen: audit it per [drift-audit](drift-audit.md).

## Stopping a worker

`mu agent abort <w>` first for pi, then `mu agent kick` (pi
unresponsive, or non-pi), then `mu agent close`.

Done when every task is closed, or a decision only a human can make blocks all progress (SKILL.md § Orchestrator rules).
