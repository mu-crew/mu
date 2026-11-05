# Remote workers

Use when an agent runs on another machine; mu itself never connects.

`send`, `wait`, `abort` work as locally over the forwarded control socket. The host has no mu DB: the brief carries everything (no `Read:` line); close the task from its `CLOSE:` block.

```bash
mu host init dev --ssh   # a starter for `mu host add`
mu host check dev
mu agent spawn worker-1 -w <ws> --host dev --worktree --root <remote repo> --task <id> --send - <<'EOF'
<brief>
EOF
mu agent wait worker-1 -w <ws> --after-runs <n> --json   # n: the spawn's "runs"
mu agent collect worker-1 -w <ws>   # in the local repo
mu task close <id> -w <ws> --evidence "<the block's evidence>"
mu agent close worker-1 -w <ws> --if <rev>
```

End the brief with: commit, then `CLOSE: task=<id> evidence="<command + result>"`, `REPORT:`, the report. Cherry-pick the collected commits and re-run the evidence before you close.

- A capped host (`--max-sessions 1`): use a lease (`host init --mule`).
- Long remote gates are panes (`--command`).
- `close` refuses a dirty or uncollected tree: collect again.
- Host-command exit 3 is a hand-back: stop and ask; never retry or ssh.
- A `shell` template never rides a shared ssh master.
- A dead lease pane's job runs on, tasks parked: run its leftover's `next` (`agent list`), reattach `--task <id>` claims them back, else close then `task unpark <id>`; only `--abandon-job` passes unreachable hosts.
- A lease shell is non-login: the brief or `--command` sets PATH (`~/.elan/bin`).
