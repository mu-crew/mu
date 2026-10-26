# Orchestrator loop

Use when you dispatch tasks and merge commits.

## Each turn

1. `mu state -w <ws> --json`.
2. Write the ceiling on the umbrella (`CONCURRENCY: workers 4`); one worker per ready task.
3. Dispatch with a [brief](brief.md) on stdin. A new worker:

   ```bash
   mu agent spawn worker-1 -w <ws> --worktree --task <id> --send - <<'EOF'
   <brief>
   EOF
   ```

   Idle worker: `mu task claim <id> -w <ws> --for <w> --evidence "..."`; `git -C <cwd> fetch && git -C <cwd> rebase <base>` (conflict: `rebase --abort`, tell the human); `mu agent send <w> -w <ws> --fresh -`.
4. `mu wait -w <ws>` waits on what you started (workers, their tasks, delegate calls). `data.exit` 0: an event in `data.firing`, or `timedOut` (run `data.resume`); 6: a worker died before its task closed, re-dispatch it; 7: `mu agent read <w>`, answer.
5. Merge. Close a finished worker: `mu agent close <w> -w <ws>` only previews (it guards unmerged commits); run its printed `--if <rev>`. Then step 1, same turn.

## Merging

- Cherry-pick new commits as workers close; gate one pinned batch ([test-health](test-health.md)); push the verified tree.
- Accept evidence, not close notes: re-run the key check.

## Sending

`--steer`: after the tool. `--interrupt`: now, kills the tool. `--fresh`: unrelated work.

## Delegate waves

One `wave` label per fan-out ([tasks-or-calls](tasks-or-calls.md)); `mu wait -w <ws> --wave <label>` returns its tally. A bare `mu wait` ends on each answer too.

## Stopping

`mu agent abort <w>`, then close it as in step 5.
