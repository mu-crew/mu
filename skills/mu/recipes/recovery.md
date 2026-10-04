# Recovery: undo, rebuild, sync

Use before you undo a change, rebuild the DB, tear down a workstream,
set up sync, or act on `mu doctor` output. Each of these can lose work
when done in the wrong order.

- **`workstream teardown`** is dry-run without `--yes`. It writes
  TOMBSTONE ops, so `mu undo <group> --yes` reverses it; the log is the
  backup. `workstream list --torn-down` lists group ids to undo.
- **`mu undo`** bare lists groups; `<group>` previews; `<group> --yes`
  emits inverse ops for that group only (redo = undo the undo). Exit 4
  if a later action changed the same fields (`--force` discards it).
  Rows only: killed panes and freed workspace dirs do not come back.
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

Done when `mu doctor` reports no DRIFT and every cleanup command you ran was read first.
