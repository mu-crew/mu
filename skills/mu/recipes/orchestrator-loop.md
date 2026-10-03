# Orchestrator loop

Use when you run a workstream: you dispatch DAG tasks to workers and
merge their commits. The hard rules in SKILL.md still apply; this is
the loop and the reasons behind them.

## Every turn

1. `mu state -w <ws>` — read agents, IN_PROGRESS, ready tasks,
   parallel tracks.
2. Spawn at most one agent per independent ready track.
3. **Claim before sending — even one-shot reviewers/scouts.**
   `mu task claim <id> -w <ws> --for <agent> --evidence "..."`.
   If no task exists, `mu task add` first (`--note 'REPRO: ...'` when
   the title is not enough). Ownership is durable and waitable; agent
   state is not.
4. Send each new task with `mu agent send <w> --fresh '...'` (new
   session + prompt in one step; refuses while busy): task id,
   files/notes to read, workspace path, validation command, scope
   guards, task note contract. Follow the `Next:` block; it picks
   `--fresh` vs `--steer` for you.
5. End with a loud final-action block:

   ```text
   ⚠️ FINAL ACTION
   git commit -am '...' THEN
   mu task close <id> -w <ws> --evidence '...'
   ```

6. `mu task wait ... --first --on-stall exit --json`.
7. Cherry-pick the closed worker's **new** commit(s), verify the MERGE,
   then continue the loop in the same turn. Do not barrier or loop in
   shell.
   Only `CLOSED/done` ships; other closes: read the reason note.
8. Repeat from `mu state`.

## Waiting

Use `--first --on-stall exit`: `--first` populates `.firing`, and
`--on-stall exit` stops an unattended wait when a worker needs attention.
Exit 6 is a dead pane; exit 7 is an owner in `needs_input`. Read that
pane (`mu agent read <owner>`) and answer: the worker may be waiting on
you. Questions are cheaper than rework.

For an idle worker, read the pane, then answer, retry, or release its
task. `MU_IDLE_THRESHOLD_MS` defaults to 5m.

## Merging

- **Pipeline; don't barrier.** Wait for one task, cherry-pick only its
  new commits, verify, dispatch the next. An umbrella wait hides progress;
  merging stale branches can restore reverted code.
- **Verify the merge, not the worker's rerun.** Only the combination
  with moved main is new; that found three breaks rerunning found none
  of. Remote hosts: [run the merged gate there](remote-workers.md#run-the-merged-gate-on-the-host).
- **Push only from a green gate.** Make `git push` the last line under
  `set -e`. Check the gate runs what it claims: an env-gated randomized
  test once passed with zero cases.
- **Accept evidence, not close notes.** Re-run the key measurement from
  a clean checkout; close notes have claimed unpushed commits.
- **Dispatch from current main.** Reset the worker's worktree to main
  before each task.

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
