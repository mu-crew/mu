# How to choose a multiplexer backend

mu drives one multiplexer per command: tmux or
[herdr](https://github.com/herdrdev/herdr). Spawn, send, read, and
agent state work on both.

## See which backend is active

```bash
mu doctor           # the environment block names it
mu doctor --json    # .environment.mux.name
```

mu picks the backend from the first rule that matches:

1. `MU_MUX=tmux` or `MU_MUX=herdr`. An unknown value fails with exit 1.
2. `HERDR_ENV=1`: herdr. This wins over tmux variables, because a herdr
   pane can host a tmux server.
3. `$TMUX` or `$TMUX_PANE` is set: tmux.
4. The first binary that runs, tmux before herdr.
5. Neither: `NoMultiplexerError`, exit 5.

## Know what differs

| | tmux | herdr |
| --- | --- | --- |
| Workstream | session `mu-<ws>` | workspace labelled `mu-<ws>` |
| Window | window | tab |
| Pane id | `%15` | `w1:p1` |
| Attach | `tmux attach -t mu-<ws>` | `herdr workspace focus <id>`, then `herdr` outside a herdr pane |
| pi agent state | control socket | control socket |
| Other agents' state | murmur | herdr |
| Send to non-pi agents | bracketed paste, then Enter | one atomic `agent prompt` |
| Spawn | one command | bare pane, then `agent start` |
| Pane borders, layout | set by mu | left to herdr |
| Test isolation | `MU_TMUX_SOCKET` | `MU_HERDR_SESSION` |

Where each agent's state comes from, per backend:
[architecture/mux.md § Agent state](../architecture/mux.md#agent-state).

## Know herdr's limits

- `mu agent kick` works on Linux only. It reads the TTY from
  `/proc/<pid>/fd/0`, which macOS does not have.
- `mu agent read --lines` cannot recover rows that scrolled off a pane
  on the alternate screen.
- herdr starts the agent binary itself (`herdr agent start --kind
  <cli>`), so spawn refuses `--command` and `MU_<CLI>_COMMAND` with
  exit 2 instead of running a different binary. Unset the variable, or
  spawn with `MU_MUX=tmux`.
- herdr creates every workspace detached. Run `herdr workspace focus`
  yourself.

## Expect loud failures, not silent ones

If the multiplexer is down, `mu doctor` still prints a full report.
Verbs that need the multiplexer, such as spawn, send, close, and
reconcile, exit 5 with remediation steps. Verbs that only use it for
decoration, such as identity lookup and `mu workstream list`, carry on.

A herdr argument error raises `HerdrSyntaxError`, not a multiplexer
error. It means herdr's CLI changed and mu needs a fix. The herdr
server is fine.
