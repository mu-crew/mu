# Worker

You are the worker: a task was claimed for you, or you were told to claim one. `$MU_AGENT_NAME` and `$MU_WORKSTREAM` identify you; your cwd is your worktree.

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

- **Not pi:** the brief may arrive as a one-line pointer to `.mu/brief-<you>-<attempt>.md`: read and follow it. Nothing steers you mid-turn; an interrupt ends it. Close or `mu task park <id> --why "..."` before you stop (claude, codex, cursor-agent nudge once; muse never).
- **Remote host (no mu DB):** no `mu task close`. Commit, then end your final message exactly so, unfenced (`REPORT:` alone, no blank line):

```text
CLOSE: task=<id> evidence="<command + result>"
REPORT:
<what you did>
```

- Follow the brief's VERIFY and [test-health](test-health.md): fast while iterating, slow for your area before close; put the gate records in your note.
- Keep each tool call to minutes: a pi steer waits for it; elsewhere a long call looks hung.
- A review or audit records each problem as a finding ([findings](findings.md)).
- Won't do it: `mu task close <id> --as wontfix --why "..."`.
