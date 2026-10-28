# Remote workers

Use when an agent runs on another machine. A host profile holds your command templates; mu never connects.

The pane is the transport and forwards the remote pi's control socket: `send`, `wait`, `abort` work as locally; a dead pane is a dead agent. The host has no mu DB: you close the task from the worker's `CLOSE:` block.

```bash
mu host init dev --ssh   # a starter to edit into `mu host add`
mu host check dev
mu agent spawn worker-1 -w <ws> --host dev --worktree --root <remote repo> --task <id> --send - <<'EOF'
<brief>
EOF
mu agent wait worker-1 -w <ws> --after-runs <n> --json   # n = the spawn's printed "runs" (0 fresh); lastText: its CLOSE block
mu agent collect worker-1 -w <ws>   # run in the local repo
mu task close <id> -w <ws> --evidence "<the block's evidence>"
mu agent close worker-1 -w <ws> --if <rev>
```

End the brief with: commit, then `CLOSE: task=<id> evidence="<command + result>"`. Cherry-pick the collected commits and re-run the evidence before you close.

- At `--max-sessions 1` the live pane holds the only channel: `collect` refuses; raise the cap.
- Long remote gates are panes (`--command`).
- `close` refuses a dirty or uncollected tree: collect again.
- Exit 3 from a host command is a hand-back (hardware key): stop and ask; never retry or ssh yourself.
- A `shell` template must not ride a shared ssh master (it outlives the pane). A capped host wants a lease (forthcoming).
