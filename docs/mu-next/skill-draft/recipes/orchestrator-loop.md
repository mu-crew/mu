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
4. `mu task wait <ids> -w <ws> --first --on-stall exit --json`. Exit 5: timeout. 6: pane died, task reopened. 7: `mu agent read <w>`, answer. TODO(v_wait_surface): the one wait verb.
5. Merge, then step 1 in the same turn.

## Merging

- Cherry-pick new commits as workers close; gate one pinned batch ([test-health](test-health.md)); push the verified tree.
- Accept evidence, not close notes: re-run the key check.

## Sending

`--steer`: after the tool. `--interrupt`: now, kills the tool. `--fresh`: unrelated work.

## Delegate waves

One `wave` label per fan-out ([tasks-or-calls](tasks-or-calls.md)); then `mu delegates tally -w <ws> --wave <label>`.

Until v_settle, answers arrive as follow-ups only when your turn ends, so a blocked `task wait` starves them. Add the wave's delegate task ids (`mu delegates list -w <ws> --wave <label> --json`: `data.items[].task`) to that `task wait --first`.

## Stopping

`mu agent abort <w>`, then `mu agent close <w>` and its printed `--if <rev>`.
