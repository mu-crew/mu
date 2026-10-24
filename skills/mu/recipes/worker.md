# Worker loop

Use when you are the worker: a task was claimed for you, or you were
told to claim one.

`$MU_AGENT_NAME` (injected at spawn) resolves identity. In a worker pane, bare
`mu task claim <id>` works. In the unregistered orchestrator pane it
errors; use `--self` or `--for <worker>`.

```bash
mu me
mu me next
mu task show <id>; mu task notes <id>
mu task claim <id> --evidence "starting; read notes"
mu task note <id> "FILES: ...\nCOMMANDS: ... (exit codes)\nDECISION: ...\nVERIFIED: ..."
mu task close <id> --evidence "tests pass: ..."  # LAST action
```

Follow [test-health](test-health.md) for fast iteration checks, targeted slow
checks before close, gate records, and cheap bug red-green. Include the gate
records in your final note; adding tests uses its test-level and timing rules.

The note follows the task note contract in SKILL.md. Keep each tool
call to minutes (short batches, waits with a timeout): steering reaches
you only between tool calls. Commit before you close: the orchestrator cherry-picks your commits, not your tree. A
review or audit task records each problem per
[findings § Record](findings.md#record).

Done when your changes are committed (your cwd is your worktree: never `cd` to it), the task note holds FILES, COMMANDS (with exit codes), VERIFIED and applicable gate records, and `mu task close` succeeded as your last action. Skipping close makes the orchestrator's
wait hang. Won't do it: `close --as wontfix --why "..."`.
