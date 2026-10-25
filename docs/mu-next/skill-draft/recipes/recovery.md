# Recovery

Use before you tear down a workstream, rebuild the DB, set up sync, or act on `mu doctor` output. Each can lose work in the wrong order.

- **Teardown** is soft: `mu workstream teardown <ws>` previews with `rev=<n>`; apply with `--if <n>`. Rows stay hidden, worktrees stay (`mu agent close` removes them). Reusing a name later permanently deletes the old rows, after its own preview.
- **`mu rebuild <file>`** writes a new DB from the ops log, without agents or worktrees; swap it in with the printed command, then re-spawn. Recovery is `rebuild`, not `mu db backup`.
- **Sync:** set `MU_SYNC_DIR` on each machine to a shared folder; every verb ingests and flushes. mu runs no ssh or rsync. `mu sync --repair <peer>` is safe. Agents, worktrees and ownership never travel.
- **`mu db forget <ws...>`** deletes torn-down workstreams' ops for good. Forget only what the human named; it backs up first.
- **`mu doctor --deep` DRIFT** is a capture bug: back up and report it. Do not rebuild; live rows may hold work the log missed.
- **Doctor's `disk` section** prints cleanup commands and runs none. An orphan dir may hold the only copy of uncommitted work; read each command before you run it.

