# Remote workers

Pick a [rung](../../../docs/guide/remote-ladder.md). The SSH session starter
(`mu host init dev --ssh --template`) prints `--max-sessions 2` (one live pane plus
one slot for collect or hook exec); run it as printed. Size larger crews
per the guide. If only one connection is practical, use a lease.

The host has no mu DB: put the whole brief in `spawn --send`. End it with
instructions to commit and finish with this unfenced block (no blank line):

```text
CLOSE: task=<id> evidence="<command + result>"
REPORT:
<what you did>
```

Use `mu agent list` for the channel. For session templates, pi uses forwarded
`ctl`; tmux `hooks` sends return `ack: sent` until a host read confirms.
Rex session panes on `mux` give no hook receipt or hook-based close.

Run `mu agent collect <name> -w <ws>` from the local repo. Cherry-pick and
re-run the evidence before you close the task if wait hasn't closed it.

Preview with `mu agent close <name> -w <ws>`; repeat with `--if <rev>`.
Close refuses dirty or uncollected trees. A template's exit 3 is a
hand-back (mu exits 5): ask a human; never retry.

Killing a lease pane stops its job. A carrier lost to `kill -9`, a crash
or a stop that cannot reach the host leaves it running, tasks parked: run
its leftover's `next`; reattach `--task <id>` claims them back,
else close then `task unpark <id>`;
only `--abandon-job` passes unreachable hosts. Lease shells are non-login;
set PATH explicitly.
