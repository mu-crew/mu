# Remote workers

For an agent on another machine. One command: `mu host exec dev -- <cmd>` (exit 5: a hand-back, no answer, or the command's own 5; `--json` tells). `--host` spawns need tmux or Rex.

pi's socket is forwarded: `send`, `wait`, `abort` work as locally. On tmux a hook harness (claude, codex, cursor-agent, muse) uses `hooks` (`murmur init` there): a send is `ack: sent` until a wait reads the host. Elsewhere read the channel from `mu agent list`; a provider host uses its plugin's channel, else a built-in one. Never wait for a hook receipt on another channel. The host has no mu DB: the brief carries everything; close from its `CLOSE:` block.

```bash
mu host init dev --ssh --template   # prints only: edit, run the printed `host add`
mu host check dev
mu agent spawn worker-1 -w <ws> --host dev --worktree --root <remote repo> --task <id> --send - <<'EOF'
<brief>
EOF
mu wait agent:<ws>/worker-1@<runs>
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

- A capped host (`--max-sessions 1`): a lease (`host init --mule --template`, edit and run it).
- `close` refuses an uncollected or dirty tree.
- A template's exit 3 is a hand-back (mu exits 5, `human needed`): ask; never retry or ssh.
- A dead lease pane's job runs on, tasks parked: run its leftover's `next`; reattach `--task <id>` claims them back, else close then `task unpark <id>`; only `--abandon-job` passes unreachable hosts.
- A lease shell is non-login: set PATH in the brief or `--command`.
