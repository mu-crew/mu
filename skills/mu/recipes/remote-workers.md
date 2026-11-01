# Remote workers

Use when an agent runs on another machine. A host profile holds your command templates; mu never connects.

The pane forwards the remote pi's control socket: `send`, `wait`, `abort` work as locally. The host has no mu DB: the brief carries everything (no `Read:` line), and the worker's `CLOSE:` block closes the task.

```bash
mu host init dev --ssh   # a starter to edit into `mu host add`
mu host check dev
mu agent spawn worker-1 -w <ws> --host dev --worktree --root <remote repo> --task <id> --send - <<'EOF'
<brief>
EOF
mu agent wait worker-1 -w <ws> --after-runs <n> --json   # n: the spawn's "runs"
mu agent collect worker-1 -w <ws>   # run in the local repo
mu task close <id> -w <ws> --evidence "<the block's evidence>"
mu agent close worker-1 -w <ws> --if <rev>
```

End the brief with: commit, then `CLOSE: task=<id> evidence="<command + result>"`. Cherry-pick the collected commits and re-run the evidence before you close.

- A capped host (`--max-sessions 1`): use a lease (`host init --mule`).
- Long remote gates are panes (`--command`).
- `close` refuses a dirty or uncollected tree: collect again.
- Exit 3 from a host command is a hand-back: stop and ask; never retry or ssh yourself.
- A `shell` template must not ride a shared ssh master.
- A dead lease pane leaves its job running: `close` stops it; only `--abandon-job` passes an unreachable host.
- A lease shell is non-login: the brief or `--command` sets PATH (`~/.elan/bin`).
