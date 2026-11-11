# Orchestrator loop

For dispatch and merge. Not pi: `mu orchestrate -w <ws> --cli <harness>` (wait identity + keep-driving Stop; not muse). `--cli` from installs (`mu doctor`); default `pi` needs PATH.

## Each turn

1. `mu state -w <ws> --json`.
2. Ceiling: umbrella's `CONCURRENCY: workers 4`; one worker per ready task.
3. Dispatch: a [brief](brief.md) on stdin, a [model](models.md). New worker:

   ```bash
   mu agent spawn worker-1 -w <ws> --worktree --task <id> --model <m> --send - <<'EOF'
   <brief>
   EOF
   ```

   Idle worker: `mu task claim <id> -w <ws> --for <w> --evidence "..."`; `git -C <cwd> fetch && git -C <cwd> rebase <base>` (conflict: `rebase --abort`, tell the human); `mu agent send <w> -w <ws> --fresh -`.
4. Wait: managed/`pi:` bare `mu wait --ready -w <ws>`; else spawn/`send` `next` or `mu wait task:<ws>/<id>` / `--as <ws>/<name>`. Exit 0: `data.firing` or `timedOut` (`data.resume`); 6: died, re-dispatch; 7: `mu agent read <w> --text`, answer.
5. Merge. Close a finished worker: `mu agent close <w> -w <ws>` only previews; run its printed `--if <rev>`. Then step 1.

## Merging

Follow [merge](merge.md): inline, or past ~4 workers through a merge task.

## Sending

`--steer`: after the tool. `--interrupt`: now, kills the tool. `--fresh`: unrelated work.

`hooks`: `--interrupt` is Escape (claude then reads `idle?`); `ack: unknown`: never resend.

## Delegate waves

One `wave` per fan-out ([tasks-or-calls](tasks-or-calls.md)); `mu wait -w <ws> --wave <label>` tallies. Act once.

## Stopping

`mu agent abort <w>`; close as step 5. Done (umbrella CLOSED, no agents): `mu workstream teardown <ws>` then `--if <rev>`.
