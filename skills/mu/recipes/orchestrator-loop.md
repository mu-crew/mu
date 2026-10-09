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
  `MU_DELEGATE_MAX` (default 16) and queues up to four times that
  (`queued-N`, started as slots free); past that it refuses.
- **Answers arrive when you stop**, as pi follow-up messages, never
  mid-turn. pi's `followUpMode: "all"` delivers every waiting answer in
  one turn instead of one turn each; each answer names its delegate and
  ends with its `VERDICT: <id>` block, so a batch still maps back. Read
  every verdict in the batch before deciding any.
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
the owner sat in `needs_input`. Run the exit's `Next:` and answer: the
worker may be waiting on you. For a pi owner it leads with
`mu agent wait <owner> --after-runs <runs-1> --json`, which returns the
last answer at once. The pane read follows because dialogs and crashes
show only in the pane.

For an idle worker, read its last answer (the same `--after-runs`
wait for pi, else the pane), then answer, retry, or release its task.
`MU_IDLE_THRESHOLD_MS` defaults to 5m. A remote owner: for pi,
`mu agent wait --after-runs` first, then poll once; otherwise poll once
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
  worker's "done" counts only once the diff shows the change. Your own
  accept and close notes name the check run and the commit.
- **Ask whether the check could have failed.** A gate that cannot say
  no is not evidence: a test filtered to zero cases, a script you wrote
  agreeing with itself, a fixture you tuned on. A nonzero diff is a
  failure even when the command exited 0.

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
