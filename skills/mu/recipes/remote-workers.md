# Remote workers

Use when an agent runs on another machine; a host profile holds your templates.

A pi worker's control socket is forwarded: `send`, `wait`, `abort` work as locally. Other harnesses are on `hooks` (`murmur init` there): a send is `ack: sent` until a wait reads the host; `--fresh` is refused. The host has no mu DB: the brief carries everything (no `Read:` line); you close the task from its `CLOSE:` block.

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

End the brief with: commit, then `CLOSE: task=<id> evidence="<command + result>"`, `REPORT:`, the report. Cherry-pick the collected commits and re-run the evidence before you close.

- A capped host (`--max-sessions 1`): use a lease (`host init --mule`).
- `close` refuses a dirty or uncollected tree: collect again.
- Exit 3 from a host command is a hand-back: stop and ask; never retry or ssh.
- A dead lease pane leaves its job running: `close` stops it; only `--abandon-job` passes an unreachable host.
- A lease shell is non-login: the brief or `--command` sets PATH.
