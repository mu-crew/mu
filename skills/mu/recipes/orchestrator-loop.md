# Orchestrator loop

Use when you run a workstream: you dispatch DAG tasks to workers and
merge their commits. The hard rules in SKILL.md still apply; this is
the loop and the reasons behind them.

## Every turn

1. `mu state -w <ws>` — read agents, IN_PROGRESS, ready tasks,
   parallel tracks.
2. Spawn at most one agent per independent ready track ([waves](waves.md)
   when workers share files).
3. **Claim before sending — even one-shot reviewers/scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`.
   If no task exists, `mu task add` first (`--note 'REPRO: ...'` when
   the title is not enough). Ownership is durable and waitable; agent
   state is not. Review tasks: [adversarial-review](adversarial-review.md).
4. Run `mu workspace refresh <w>`, then send a [brief](brief.md) with
   `mu agent send <w> --fresh '...'` (new session + prompt in one step;
   refuses while busy). The brief ends with its final-action block.
5. `mu task wait ... --first --on-stall exit --json`.
6. Cherry-pick the closed worker's **new** commit(s), verify the MERGE,
   then continue the loop in the same turn. Do not barrier or loop in
   shell.
   Only `CLOSED/done` ships; other closes: read the reason note.
7. Repeat from `mu state`.

## Concurrency

Write the ceiling on the umbrella before the first wave
(`CONCURRENCY: delegates 12, workers 4`) so a resumed orchestrator
keeps it.

- **[Delegate calls](tasks-or-calls.md#delegate-call)** (read-only): 10 to 20 at once is reasonable.
  Token spend and provider rate limits bind first; start near 8 and
  raise after a clean wave. `mu_delegate` runs at most
  `MU_DELEGATE_MAX` (default 16) and queues up to as many again
  (`queued-N`, started as slots free); past that it refuses.
- **Answers arrive when you stop**, as pi follow-up messages, never
  mid-turn. pi's `followUpMode: "all"` delivers every waiting answer in
  one turn instead of one turn each; each answer names its delegate and
  ends with its `VERDICT: <id>` line, so a batch still maps back. Record
  every verdict in the batch before acting on any.
- **Workers with workspaces** build and test: about one per CPU core,
  fewer when each runs the full suite. A remote host has its own
  session cap ([remote-workers](remote-workers.md)).
- **Stream, do not batch.** Keep the pool full: dispatch the next unit
  when one closes, rather than waiting for a whole wave. With the
  `codemode` tool, a [driver](codemode-driver.md) can dispatch a batch
  of workers in one script.

## Waiting

Use `--first --on-stall exit`: `--first` populates `.firing`, and
`--on-stall exit` stops an unattended wait when a worker needs attention.
Exit 6: the owner's pane died and the reaper reopened the task; exit 7:
the owner sat in `needs_input`. Read that
pane (`mu agent read <owner>`) and answer: the worker may be waiting on
you.

For an idle worker, read the pane, then answer, retry, or release its
task. `MU_IDLE_THRESHOLD_MS` defaults to 5m. A remote owner: poll once
per turn ([remote-workers](remote-workers.md#step-5-poll-once-per-turn)).

## Merging

- **Pipeline; don't barrier.** Wait for one task, cherry-pick only its
  new commits, verify, dispatch the next. An umbrella wait hides progress;
  merging stale branches can restore reverted code.
- **Verify the merge, not the worker's rerun.** Only the combination
  with moved main is new, and it breaks in ways the worker's own run
  cannot show. Remote hosts: [run the merged gate there](remote-workers.md#run-the-merged-gate-on-the-host).
- **Push only when the gate command passes.** Make `git push` the last
  line under `set -e`. Check the gate command runs what it claims: an env-gated randomized
  test once passed with zero cases.
- **Accept evidence, not close notes.** Re-run the key measurement from
  a clean checkout; close notes have claimed unpushed commits. A
  worker's "done" counts only once the diff shows the change.
- **Ask whether the check could have failed.** A gate that cannot say
  no is not evidence: a test filtered to zero cases, a script you wrote
  agreeing with itself, a fixture you tuned on. A nonzero diff is a
  failure even when the command exited 0.

## Sending

- A plain `mu agent send` appends to prior context; use it to steer or
  answer. Unrelated work to pi: `mu agent send worker-1 --fresh 'Claim
  task_x...'`.
- claude-code/codex: send `/new` (codex: `/clear`), then the prompt; a
  send it cannot confirm prints a `warning:` on stderr. For pi,
  `--fresh` does both in one step.
- Use `mu agent send`, not raw mux input. Single-quote prompts
  containing shell expansions, or use a quoted heredoc.
- Cross-workstream wait and claim use qualified refs; only task
  ownership crosses.

## Stopping a worker

`mu agent abort <w>` first for pi (exact, local or remote, keeps
context, waits for idle; exit 5 = still busy; queued follow-ups return
to the editor unsent). Then `mu agent kick` (pi unresponsive, or
non-pi; local panes only), then `mu agent close`.

Done when every task is closed, or a decision only a human can make blocks all progress (SKILL.md § Orchestrator rules).
