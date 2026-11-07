# Remote workers

For an agent on another machine.

pi's control socket is forwarded: `send`, `wait`, `abort` work as locally. Other harnesses use `hooks` (`murmur init` there): a send is `ack: sent` until a wait reads the host; `--fresh` is refused. The host has no mu DB: the brief carries everything (no `Read:`); close from its `CLOSE:` block.

```bash
mu host init dev --ssh   # prints a `host add`
mu host check dev
mu agent spawn worker-1 -w <ws> --host dev --worktree --root <remote repo> --task <id> --send - <<'EOF'
<brief>
EOF
mu wait agent:<ws>/worker-1@<runs>   # spawn's next, or task:<ws>/<id>
mu agent collect worker-1 -w <ws>   # in the local repo
mu task close <id> -w <ws> --evidence "<the block's evidence>"
mu agent close worker-1 -w <ws> --if <rev>
```

The brief ends: commit, then end the final message, unfenced, exactly so (`REPORT:` alone, no blank line):

```text
CLOSE: task=<id> evidence="<command + result>"
REPORT:
<what you did>
```

Cherry-pick the collected commits; re-run the evidence before you close.

- A capped host (`--max-sessions 1`): use a lease (`host init --mule`).
- `close` refuses an uncollected or dirty tree: collect.
- Host-command exit 3 is a hand-back: stop and ask; never retry or ssh.
- A dead lease pane's job runs on, tasks parked: run its leftover's `next` (`agent list`), reattach `--task <id>` claims them back, else close then `task unpark <id>`; only `--abandon-job` passes unreachable hosts.
- A lease shell is non-login: brief or `--command` sets PATH.
