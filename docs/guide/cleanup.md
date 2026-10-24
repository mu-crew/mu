# How to clean up

## Close one agent

```bash
mu agent close worker-1 -w auth
```

Close removes the agent's worktree with it. A worktree with uncommitted
edits makes close refuse with exit 4 before anything is killed: commit
them, or pass `--discard` to lose them. Clean commits that are not merged
are kept on a branch `mu/<workstream>/<agent>-<sha>`, named in the output.
See [Stop a worker](stop-a-worker.md).

## Tear down a workstream

```bash
mu workstream teardown auth             # preview: counts and rev=<n>; writes nothing
mu workstream teardown auth --if <n>    # apply that preview
```

Teardown is soft. It kills the tmux session first, then deletes the
agent rows and marks the workstream torn down. It refuses (exit 4) while
a registered pane is still alive outside the session. A pane that comes
alive after the kill (moved while it ran) keeps its agent row, and the
output says `KEPT`; `mu agent close <agent> -w auth` removes the row once
the pane is gone, and refuses (exit 4) while it lives. `mu doctor` lists
such rows as `orphaned-agents`. Its tasks, edges,
and notes stay but every view and `-w auth` verb hides them (exit 3,
"workstream auth is torn down"). Teardown never removes a worktree: each
stays on disk and registered, and the output names
`mu agent close <agent> -w auth` for it (dirty refuses; `--discard` is
lossy). Running it again is a no-op.

`--if <n>` refuses (exit 4) when the workstream changed since the
preview: a new op, agent, or worktree. Preview again and read it.

To reuse the name, run `mu workstream init auth`. It previews what it
will permanently delete (`will permanently delete torn-down auth: N tasks,
M notes; rev=<n>`); `mu workstream init auth --if <n>` deletes the old
rows and creates the new workstream. It refuses (exit 4) while the old
tmux session is alive, and when the mux cannot be asked.

To sweep every workstream that has no tasks, agents, or worktrees:

```bash
mu workstream teardown --empty            # preview: the list and one rev=<n>
mu workstream teardown --empty --if <n>
```

The sweep skips `scratch`, whose idle session is kept open on purpose.
It never takes a `mu-*` session that has no workstream row in this DB:
it may be a live workstream from another DB. The output names
such sessions; tear one down by name once you know it is unused.

## Find a past teardown

```bash
mu workstream list --torn-down
mu log --group 7a40e6cc
```

The list shows every torn-down workstream (`rows: kept`), newest first,
and the older teardowns an earlier mu wrote as deletes (`rows: deleted`;
`← recreated since` means the name is in use again). A `--empty` sweep
writes one op group per workstream.

## Keep mu.db small

Teardown keeps its rows and history, and that is most of
`mu.db`. `mu doctor` names the largest workstreams that earlier teardowns
deleted once they are worth reclaiming. A soft-torn-down workstream is
reclaimed by reusing its name (`init --if`), then tearing down again.

```bash
mu db compact                        # dry run: redundant note tombstones
mu db compact --yes
mu db forget hail-smoke reltest      # dry run: per workstream, ops and size
mu db forget hail-smoke reltest --yes
```

`compact` changes nothing you can see. `forget` deletes those
workstreams' history for good.
Both write a backup next to the DB first (`mu.db.pre-forget-<time>`),
which is the only way back, and run the drift check after. Only this
machine's DB shrinks; sync segments are untouched.

## Find workstreams you can remove

The `housekeeping` section of `mu doctor` lists two kinds:

| Kind | Rule | Advice |
| ---- | ---- | ------ |
| finished | every task `CLOSED`, idle 14 days or more | safe to tear down |
| abandoned | unclosed tasks, idle 60 days or more | read the open tasks first |

It skips your current workstream, `scratch`, and any workstream with a
live agent or a worktree. Teardown hides the plan, not the code: no
commit or checkout is touched.

## Free disk space

```bash
mu doctor --disk                           # bytes per worktree
mu doctor                                  # the disk section lists directories with no DB row
mu agent close worker-1 -w auth --discard  # delete one worktree
```

## Keep a copy of the graph

```bash
mu db backup /tmp/mu-backup.db      # VACUUM INTO; never overwrites
mu task list -w auth --json
mu task notes design -w auth --json
```
