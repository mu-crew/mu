# Move a 3.x workstream

Use when the human asks to move ONE 3.x workstream into 4.0, from the machine holding it. Open tasks move; the rest stays in the 3.x DB. `mu` is 4.0; `<mu3>` is 3.x, e.g. `npx -y @mu-crew/mu@3.13.3`.

1. **Read the old DB**: `sqlite3 -readonly -json <old.db> "<query>"`, never `MU_DB_PATH`. 4.0 runs on its own state dir and `MU_SYNC_DIR` (or blank).
2. **IN_PROGRESS first**: finish, or `<mu3> task release <id> -w <ws>` (park refuses it).
3. **Select** the open tasks (local_id, title, impact, effort_days, substate), each one's first and last note (brief; park reason or status), and the `task_edges` with both ends open (`from_task_id` blocks `to_task_id`). A last note that is the brief or `CLAIM: dispatch` is no status: write one.
4. **Write a script** (python argv lists: briefs hold quotes) that runs, per task, dependents first (`--blocks` needs the umbrella):

   `mu task add <id> -t <title> -i <impact> -e <effort> --blocks <its dependents> --note - -w <ws>`

   with the brief on stdin, then `mu task note <id> -w <ws> -` with `moved from 3.x <ws>/<id>; last note: <it, capped 2 KB>`; for a parked task, pass that text to `mu task park <id> -w <ws> --why` instead. Keep the ids.
5. **Verify**: open-task and edge counts (`mu db query ... --all`) match; `mu task tree <a root> -w <ws>` matches. Mismatch: fix, never mark.
6. **Mark the old one**: `MU_DB_PATH=<old.db> <mu3> task park <id> -w <ws> --why "moved to 4.0"` per moved task.
