# How to clean up

## Close one agent

```bash
mu agent close worker-1 -w auth
```

A clean workspace is freed with the agent. If the workspace has edits
or commits, close refuses with exit 4. Run
`mu workspace free worker-1 -w auth --commit` first, or pass
`--discard-workspace` to lose the changes. See
[Stop a worker](stop-a-worker.md).

## Tear down a workstream

```bash
mu workstream teardown auth          # dry run: prints what goes
mu workstream teardown auth --yes    # kills the session, deletes the rows
```

Teardown kills the tmux session first, then deletes the agents, tasks,
edges, notes, and workspaces. Running it again is a no-op.

To sweep every workstream that has no tasks, agents, or workspaces:

```bash
mu workstream teardown --empty
mu workstream teardown --empty --yes
```

The sweep never takes a `mu-*` session that has no workstream row in
this DB: it may be a live workstream from another DB. The output names
such sessions; tear one down by name once you know it is unused.

## Undo a teardown

Teardown writes tombstone ops, so the ops log keeps everything. You do
not need a backup first.

```bash
mu workstream list --torn-down
mu undo 7a40e6cc --yes
```

The list shows one row per teardown, newest first. A `--empty` sweep
writes one row per workstream, so undo each one. `← recreated since`
means the name is in use again, so the undo would change nothing.
Killed panes and freed workspace directories do not come back.

## Keep mu.db small

Teardown keeps history so `mu undo` works, and that history is most of
`mu.db`. `mu doctor` names the largest torn-down workstreams once they
are worth reclaiming.

```bash
mu db compact                        # dry run: redundant note tombstones
mu db compact --yes
mu db forget hail-smoke reltest      # dry run: per workstream, ops and size
mu db forget hail-smoke reltest --yes
```

`compact` changes nothing you can see. `forget` deletes those
workstreams' history for good: `mu undo` can no longer restore them.
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
live agent or a workspace. Teardown removes the plan, not the code: no
commit or checkout is touched.

## Free disk space

```bash
mu doctor --disk                    # bytes per workspace checkout
mu workspace orphans -w auth        # directories with no DB row
mu workspace free worker-1 -w auth  # delete one workspace
```

## Keep a copy of the graph

```bash
mu db backup /tmp/mu-backup.db      # VACUUM INTO; never overwrites
mu task list -w auth --json
mu task notes design -w auth --json
```
