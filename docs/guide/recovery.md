# How to recover from a broken state

Start with `mu doctor`. Each row that is not `ok` prints the command
that fixes it. mu reports and never cleans up for you, because an
orphan directory can hold the only copy of uncommitted work. Agents
read the same rules in
[recipes/recovery.md](../../skills/mu/recipes/recovery.md).

```bash
mu doctor           # exit 0 healthy, 5 on drift
mu doctor --deep    # rebuild the ops log and diff every field
mu doctor --disk    # add per-workspace byte usage
```

## An agent's pane died

Run `mu agent list` or `mu state`. Each run reconciles the registry
with the multiplexer:

- An agent row whose pane is gone is a ghost. mu deletes the row, and
  its `IN_PROGRESS` task returns to `OPEN`. A `mu task wait` on that
  task exits 6.
- A pane in the session that runs an agent CLI but has no row is an
  orphan. mu lists it with an adopt hint and does not adopt it.

To register an orphan pane, or a pi you started by hand:

```bash
mu agent adopt %15 -w auth
mu agent adopt %15 -w auth --name investigator
```

The pane title becomes the agent name. The pane must be in the
`mu-<workstream>` session. An adopted pi has no control socket until
you restart it with the `MU_CTL_SOCK` path that `adopt` prints.

## A pi agent shows `ctl missing` or `ctl refused`

mu reaches pi agents only through the control socket, and never falls
back to pasting.

| State | Means | Fix |
| ----- | ----- | --- |
| `ctl missing` | no socket: the extension is not loaded, or a new pi waits at its trust prompt | answer the [trust prompt](#a-new-pi-agent-shows-ctl-missing), or run `mu link pi`, then respawn the agent |
| `ctl refused` | the socket exists but does not answer | respawn the agent; for a remote agent, check the ssh forward |
| `extension X older than installed Y` or `extension lacks ops` | pi loaded an older mu build | send `/reload`, or respawn |

To send `/reload` without attaching:

```bash
mu agent send worker-1 -w auth '/reload'             # extension serves op command
mu agent send worker-1 -w auth '/reload' --via mux   # older: type it into the pane
```

The error names the right form. `/reload` keeps the pi session. A `send --fresh` or `abort` against an
outdated extension fails with exit 4 and prints the same two fixes.

## A new pi agent shows `ctl missing`

pi asks whether to trust a project folder on first start. It asks
before it loads extensions, so the agent has no control socket yet:
mu shows `unknown (ctl missing)` and spawn warns after 30 s. A pi
launched through a wrapper whose name is not `pi` or `pi-meta` shows
`needs_input` instead. Run
`/trust` in the pane once, or spawn with
`--command 'pi --approve'`. `--approve` trusts every directory,
including workspace forks, so use it only on your own code.

## You closed your terminal

The tmux session keeps running. Reattach with `tmux attach -t mu-auth`.
Every `mu` command is a short process that reads the DB, so nothing
needs restarting.

## You ran the wrong command

Every action is one group of ops. Find it, preview the inverse, then
apply:

```bash
mu undo                   # list recent groups
mu undo 6380dd3d          # preview
mu undo 6380dd3d --yes    # apply
```

- Any unique prefix of a group id works.
- The undo is its own group, so undoing it again is redo.
- If later work changed the same fields, undo exits 4 and names the
  conflict. `--force --yes` overrides and discards the newer work.
- Undo restores rows only. Killed panes and freed workspace
  directories do not come back.

## `mu doctor` reports drift

Drift means the ops log and the live tables disagree. `--deep` names
the table, key, and field. Do not rebuild by reflex: if capture missed
a write, the live table holds real work that a rebuild would discard.

```bash
mu db backup /tmp/mu-drift-evidence.db     # 1. keep the evidence
mu rebuild /tmp/mu-rebuilt.db              # 2. replay the log into a new file
MU_DB_PATH=/tmp/mu-rebuilt.db mu sql "SELECT local_id, title FROM tasks"   # 3. compare
```

Decide which side is right, then report the drift as a bug with the
named field. `mu rebuild` never writes in place. It prints the swap
command.

## The `disk` section of `mu doctor` warns

| Row | Means |
| --- | ----- |
| `ws-rows` | a workspace row whose directory is gone; the next send fails in the VCS |
| `ws-dirs` | a workspace directory with no row; it blocks the next `--workspace` spawn with that name |
| `ws-empty` | a workstream directory with no checkouts |
| `db-copies` | stray `mu.db*` files that nothing reads |
| `exports` | output left by the removed export verb |
| `locks` | lock directories older than one hour, from a spawn or flush that died |

To list workspace orphans with cleanup commands, run
`mu workspace orphans -w auth`. Remove a git-backed orphan with
`git worktree remove --force <path>` from the project root.

## Rename a workstream

There is no rename verb. Every child table cascades on the name:

```bash
mu sql "UPDATE workstreams SET name='auth-refactor' WHERE name='auth-refator'"
tmux rename-session -t mu-auth-refator mu-auth-refactor
```

Names start with a lowercase letter, use letters, digits, `_`, or
`-`, are at most 32 characters, and do not start with `mu-`.

## Report a bug

Include the exact command, its full output, the `environment` block of
`mu doctor`, and your platform. To reproduce without your real data,
set `MU_DB_PATH=/tmp/mu-debug.db` and `MU_SYNC_DIR=` (empty).
