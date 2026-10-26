# Move a 3.x workstream

Use when the human asks to move ONE 3.x workstream into mu-next, from the machine that holds it. Only open tasks move. Owners, agents and history stay in the 3.x DB, an archive.

1. **Read the old DB read-only**, by explicit path: `sqlite3 -readonly -json <old.db> "<query>"`. Never set `MU_DB_PATH` to it. Run mu-next on its own state dir; blank `MU_SYNC_DIR` unless it is mu-next's own folder.
2. **Select** the workstream's open tasks (`status != 'CLOSED'`: `local_id`, title, impact, effort_days, substate), each one's first note by id (the brief), and the `task_edges` whose two ends are both open (`from_task_id` blocks `to_task_id`). An edge to a closed task is dropped.
3. **Write a script** (python, argv lists, no shell strings: briefs hold quotes) that runs, per task, dependents first (`--blocks` needs the umbrella to exist):

   `mu task add <id> -t <title> -i <impact> -e <effort> --blocks <its dependents> --note - -w <ws>`

   with the brief on stdin (no brief: no `--note`), then `mu task note <id> -w <ws> -m "moved from 3.x <ws>/<id>"`. Re-`park --why` what was parked. Keep the ids.
4. **Verify**: open-task and edge counts in mu-next (`mu sql`) equal the selection's; `mu task tree <a root> -w <ws>` matches the old graph. A mismatch: fix it, never mark.
5. **Mark the old one**: with 3.x's own binary and `MU_DB_PATH=<old.db>`, `mu task park <id> -w <ws> --why "moved to mu-next"` for every moved task, so nobody works it twice.
