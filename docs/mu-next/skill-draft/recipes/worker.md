# Worker

Use when you are the worker: a task was claimed for you, or you were told to claim one. `$MU_AGENT_NAME` and `$MU_WORKSTREAM` identify you; your cwd is your worktree, so never `cd` to it.

```bash
mu task show <id>; mu task notes <id>      # the brief, report and verdicts come first
mu task claim <id> --evidence "starting"    # skip when already yours
# work; commit before you close: the orchestrator cherry-picks commits, not your tree
mu task note <id> - <<'EOF'
FILES: ...
COMMANDS: ... (exit codes)
VERIFIED: ...
EOF
mu task close <id> --evidence "tests pass: <command> exit 0"   # LAST action
```

Skipping `close` hangs the orchestrator's wait.

- Follow the brief's VERIFY and [test-health](test-health.md): fast while iterating, slow for your area before close; put the gate records in your note.
- TODO(v_wait_core): a pi worker may close by ending its final message with `CLOSE: task=<id> evidence="<command + result>"`, then `REPORT:` and the report. Until then only `mu task close` closes.
- Keep each tool call to minutes; a steer reaches you only between calls.
- A review or audit records each problem as a finding ([findings](findings.md)).
- Won't do it: `mu task close <id> --as wontfix --why "..."`.
