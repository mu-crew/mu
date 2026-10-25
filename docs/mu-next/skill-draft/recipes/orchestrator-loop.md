# Orchestrator loop

Use when you dispatch tasks and merge commits.

## Each turn

1. `mu state -w <ws> --json`.
2. Note a ceiling on the umbrella (`CONCURRENCY: workers 4`); one worker per ready task.
3. Dispatch with a [brief](brief.md) on stdin. A new worker, claimed and briefed in one call:

   ```bash
   mu agent spawn worker-1 -w <ws> --worktree --task <id> --send - <<'EOF'
   <brief>
   EOF
   ```

   An idle worker: `mu task claim <id> -w <ws> --for <w> --evidence "..."`; `git -C <cwd> fetch && git -C <cwd> rebase <base>` (conflict: `rebase --abort`, tell the human); `mu agent send <w> -w <ws> --fresh -`.
4. `mu task wait <ids> -w <ws> --first --on-stall exit --json`. Exit 6: pane died, task reopened. Exit 7: `mu agent read <w>`, answer. TODO(v_wait_surface): the one wait verb.
5. Merge, then step 1 in the same turn.

## Merging

- Cherry-pick closed workers' new commits as they close; gate one pinned batch ([test-health](test-health.md)); push only the verified tree.
- Accept evidence, not close notes: re-run the key check.

## Sending

A running worker sees sends, never notes. `--steer`: after the tool. `--interrupt`: now, kills the tool. `--fresh`: unrelated work.

## Delegate waves

Issue every check in one turn under one `wave` label; `mu delegates tally -w <ws> --wave <label>` groups verdicts. A refused call is pending: `mu_delegate_reissue` it. TODO(v_settle): answers wake an idle turn.

## Stopping

`mu agent abort <w>`, then `mu agent close <w>` (a preview) and its printed `--if <rev>`.
