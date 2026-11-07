# Move a workstream to another machine

Use when the human asks to move a 4.x workstream from one machine (source) to another (target). Tasks, edges and notes travel as ops; agents, worktrees and task owners never do. (3.x into 4.x: [upgrade guide](../../../docs/guide/upgrade.md#move-a-3x-workstream).)

1. **Same version**: `mu --version` on both. Never query the source DB over ssh, nor point `MU_DB_PATH` at it: an older file is refused (`Detected v<n> schema`), and the target keeps its own DB and `machine_id`.
2. **Free the work on the source**: merge or push each worker's branch, then `mu agent close <name> -w <ws>` and apply its `--if <rev>` (this removes the worktree). `mu task release <id> -w <ws>` each IN_PROGRESS task so it is ready on the target.
3. **Ship the ops**, one of:
   - Shared `MU_SYNC_DIR`: run any `mu` verb on the source, let the folder sync, then `mu sync` on the target until the source's `behind` is 0.
   - No sync: `mu db backup <file>` on the source, copy the file over, `mu sync --from <file>` on the target. This brings every workstream in that DB.
4. **Verify**: `mu task list -w <ws>` on the target matches the source.
5. **Tell the human** to watch the dash on the target (`mu -w <ws>` there). The source's dash reads the source DB: frozen at the copy without sync, lagging with it. Never tear the workstream down on the source when synced: the teardown travels too.
