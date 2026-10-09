# Recovery: undo, rebuild, sync

Use before you undo a change, rebuild the DB, tear down a workstream,
set up sync, or act on `mu doctor` output. Each of these can lose work
when done in the wrong order.

- **`workstream teardown`** is reversible: `workstream list --torn-down`
  lists the group ids to `mu undo`; the log is the backup.
- **`mu undo`** restores rows only: killed panes and freed workspace
  dirs do not come back. Redo = undo the undo.
- **`mu rebuild <file>`** writes a new DB from the ops log, without
  agents or workspaces; re-spawn after the swap. Recovery is
  `mu rebuild`, not `mu db backup`.
- **Sync:** set `MU_SYNC_DIR` on each machine to a shared folder
  (Syncthing). Every command flushes and ingests ops, merged per field.
  mu never runs ssh or rsync; `mu sync` prints the line.
  `--repair <peer>` is always safe. Agents, workspaces, and task
  ownership never travel.
- **`mu db forget <ws...>`** deletes torn-down workstreams' ops for
  good (no undo); `mu db compact` only blanks redundant tombstones. Both
  back up beside the DB first. Forget only what the human named.
- **`mu doctor --deep` DRIFT** (exit 5) is a capture bug: back up and
  report it. Do not rebuild; the live rows may hold work the log missed.
- The `doctor` `disk` section is report-only: an orphan dir may hold the
  only copy of uncommitted work, so mu prints cleanup commands and runs
  none. Read before you run them.

Done when, per operation: undo or teardown was previewed, then applied
with `--yes`; rebuild was swapped in and agents re-spawned; `mu sync`
lists the peer; forget touched only the named workstreams. Any
`doctor --deep` DRIFT is backed up and reported to the human, and you
read every cleanup command before you ran it.
