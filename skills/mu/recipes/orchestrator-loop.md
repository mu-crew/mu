# Orchestrator loop

For dispatch and merge.

## Each turn

1. `mu state -w <ws> --json`.
2. Note the ceiling on the umbrella (`CONCURRENCY: workers 4`); one worker per ready task.
3. Dispatch with a [brief](brief.md) on stdin. New worker:

   ```bash
   mu agent spawn worker-1 -w <ws> --worktree --task <id> --send - <<'EOF'
   <brief>
   EOF
   ```

   Idle worker: `mu task claim <id> -w <ws> --for <w> --evidence "..."`; `git -C <cwd> fetch && git -C <cwd> rebase <base>` (conflict: `rebase --abort`, tell the human); `mu agent send <w> -w <ws> --fresh -`.
4. `mu wait -w <ws>` waits on what you started (workers, tasks, calls); outside pi or a mu pane, name them (`mu wait task:<ws>/<id> ...`). `data.exit` 0: an event in `data.firing`, or `timedOut` (run `data.resume`); 6: worker died before closing, re-dispatch it; 7: `mu agent read <w>`, answer.
5. Merge. Close a finished worker: `mu agent close <w> -w <ws>` only previews; run its printed `--if <rev>`. Then step 1. If `mu state` says a course check is due, finish merging, then follow [course-correct](course-correct.md) first.

## Merging

- Cherry-pick new commits as workers close; gate one pinned batch ([test-health](test-health.md)); push the verified tree.
- Accept evidence, not close notes: rerun the check.

## Sending

`--steer`: after the tool. `--interrupt`: now, kills the tool. `--fresh`: unrelated work.

## Delegate waves

One `wave` label per fan-out ([tasks-or-calls](tasks-or-calls.md)); `mu wait -w <ws> --wave <label>` returns its tally. An answer read via `task notes` still arrives once from `mu wait`; act once.

## Stopping

`mu agent abort <w>`; close as step 5.
