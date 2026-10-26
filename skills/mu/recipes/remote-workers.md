# Remote workers

Use when an agent runs on another machine. A **host profile** holds your command templates; mu never connects.

The pane is the transport and forwards the remote pi's control socket: `send`, `wait`, `abort` work as locally; a dead pane is a dead agent. The host has no mu DB: you close the task, from the worker's `CLOSE:` block.

```bash
mu host init dev --ssh   # prints a starter to edit into `mu host add`
mu host check dev
mu agent spawn worker-1 -w <ws> --host dev --worktree --task <id> --send - <<'EOF'
<brief>
EOF
mu agent wait worker-1 -w <ws> --after-runs <runs> --json   # lastText: its CLOSE block
mu agent collect worker-1 -w <ws>   # run in the local repo
mu task close <id> -w <ws> --evidence "<the block's evidence>"
mu agent close worker-1 -w <ws> --if <rev>
```

End the brief with: commit, then `CLOSE: task=<id> evidence="<command + result>"`. Cherry-pick the collected commits and re-run the evidence before you close.

- **`--max-sessions 1`**: the live pane holds the only channel; `collect` and your own `ssh dev` refuse until it is gone. Raise the cap to collect mid-run.
- **Long remote gates are panes** (`spawn gate-1 --host dev --command 'npm test'`), not a held ssh.
- `close` refuses a dirty worktree or one ahead of the collected commit: collect again.
- A mule exit 3 is a hand-back (hardware key): never retry or open ssh yourself.
