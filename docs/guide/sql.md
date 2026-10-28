# How to query and script mu

Use typed verbs with `--json` first. Use `mu db query` (alias `mu sql`) for
ad-hoc joins and reports that no verb covers; a repair needs `--write`.

## Script with `--json`

Every verb takes `--json`.

- Every verb prints ONE document on stdout: `{"ok": true, "data": ..., "next": null}`.
- Collection reads put `{"items": [...], "count": N}` in `data`. The task
  reads (`task list/next/owned-by/show/tree`, `me tasks`) cap the result at 4 KB:
  `more` counts what is left and `retrieve` is the same command with `--all`
  (`--full` on `owned-by`, whose `--all` means every workstream), which prints
  everything whole. Task items use the SQL column names (`id` is the `local_id`,
  `effort_days`, `workstream_id`, `owner_id`; `owner` only while
  IN_PROGRESS), never `name`/`effortDays`/`roi`. `task add --json` returns its
  `task` (and `tasks`) in the same shape.
- Single objects, such as `mu task show`, put an object with named
  fields in `data`.
- `mu db query` and `mu sql` print this document by default (`--table` gives
  the human table). A read puts `{items, count, more}` in `data`, the same
  shape as task lists, with your row keys untouched. It stops at 4 KB of final
  output, cells never cut: `more` counts the rows left out and `retrieve` is the
  same query with `--all`, which prints every row whole. One row bigger than the
  cap gives zero `items`, `more: 1` and `retrieve`. A write prints
  `{changes, lastInsertRowid}` (a script `{statements, multiStatement}`); an
  `UPDATE ... RETURNING` prints its rows whole, with no `retrieve`, since running
  it again would write again. Errors are the failure document on stdout, with or
  without `--json`.
- `mu state` and bare `mu me` print the document by default too (no `--json` needed); a read over 4 KB is cut and names `mu state ... --full`.
- `mu next` and `mu wait` print their one result by default, failures included.
- `mu log --tail` (no `--json` needed) is the exception: one raw JSON object per line, keyed by the `ops` column names.
- A failure is `{"ok": false, "error", "message", "next", "exit"}` on
  **stdout** (plus, for usage errors, `usage`, at most 3 lines), with
  the same non-zero exit code. `2>/dev/null` loses nothing.

```bash
mu state -w auth
mu task list -w auth --json | jq '.data.count'
mu task show t1 -w auth --json | jq 'if .ok then .data.task else .message end'
```

Exit codes: `1` any other failure (a spawn that failed, an unreachable
control socket, a send whose delivery is unknown), `2` usage error, `3` not found, `4` conflict, `5`
an abort or interrupt that timed out (pi still busy), a locked DB, or a multiplexer, VCS, drift, or `mu doctor`
FAIL-row failure, `6` a watched owner died, `7` stall, `130`/`143`
SIGINT/SIGTERM during a wait. A wait that hits its cap
(`mu wait`, `mu task wait`, `mu agent wait`) is `0` with `timedOut: true`, not `5`.

## Read the schema

The schema (version 13) has 26 tables and 4 views (`ready`, `blocked`,
`blockers`, `goals`). Views skip torn-down workstreams. `blockers` has one
row per open edge: `task_local_id` is held up by `blocker_local_id`.
Four tables travel between machines: `workstreams`, `tasks`,
`task_edges`, and `task_notes`. List them all:

```bash
mu db query "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name"
```

Task ids (`local_id`) are unique per workstream only. Join
`workstreams` in every query, or you hit a same-named task elsewhere.
Edges and notes reference `tasks.id`, not `local_id`.

## Run common queries

Blocked tasks and the goals view, which replaced removed verbs:

```bash
mu db query "SELECT b.local_id, b.title FROM blocked b JOIN workstreams w ON w.id = b.workstream_id WHERE w.name = 'auth'"
mu db query "SELECT g.local_id, g.title FROM goals g JOIN workstreams w ON w.id = g.workstream_id WHERE w.name = 'auth'"
```

Search task titles:

```bash
mu db query "SELECT t.local_id, t.status, t.title FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = 'auth' AND LOWER(t.title) LIKE '%token%'"
```

Every task that blocks `launch`, directly or not:

```bash
mu db query "WITH RECURSIVE prereqs(id) AS (
          SELECT t.id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
           WHERE t.local_id = 'launch' AND w.name = 'auth'
          UNION
          SELECT e.from_task_id FROM task_edges e JOIN prereqs ON e.to_task_id = prereqs.id
        )
        SELECT t.local_id, t.title, t.status FROM prereqs JOIN tasks t ON t.id = prereqs.id"
```

`mu db query` syncs like every other verb (when `MU_SYNC_DIR` is set): it
ingests peer ops before the query and flushes its own writes after, even
when the statement fails. It reads by default: a statement SQLite reports as
not read-only (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `WITH ... INSERT`,
anything with `RETURNING`) is refused in one line, exit 2, until you add
`--write`. A write prints the number of rows changed. Writes
are captured as ops under one `sql.write` group per call, so `mu log --group`
shows the whole call. `--confirm-rows N` counts rows removed by
`ON DELETE CASCADE` too: deleting a task with one edge counts 2.

With `-w <ws>` (a spawned worker defaults to its own), the views `ready`,
`blocked` and `blockers` cover that workstream only, with the same columns;
`main.ready` is still the global one. The scope is the connection's own
(`TEMP` views), so nothing is left in the file.

`no such column: x` answers in one line with the closest columns and the real
columns of every table the query names; the SQL is never rewritten.

The whole call runs in one transaction that mu opens, so `BEGIN`,
`COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused, each
statement checked by SQLite itself (a table or column named `begin` or
`end` is fine, a leading `;` hides nothing); a failed statement rolls the call
back. An `INSERT` that names an `id` of 0 or below is refused too (omit it), and
so is an `UPDATE` of `id` (or `rowid`) on `workstreams`, `tasks`, `task_notes`
and `task_edges`: ids are set once. Notes are append-only: an `UPDATE` of a
note's `author`, `content`, `created_at` or `kind` is refused (add a new
note), and so is an `UPDATE` of an edge's `created_at`. A rebuild or peer
would replay either as a different row than the one you edited.

What it will not touch: mu's capture bookkeeping, the schema and the
connection. The rule is a policy, so nothing has to be detected:

- No `CREATE`, `DROP` or `ALTER` of any kind, `TEMP` tables, views and
  triggers included, and no `ANALYZE` or `REINDEX`. A trigger that outlives
  one statement can fire inside mu's own bookkeeping.
- No `ATTACH` or `DETACH`: the verb works on this one DB. Another mu DB
  (a backup, a peer) is not for it to write.
- `PRAGMA` only as a read: `table_info`, `table_xinfo`, `table_list`,
  `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`,
  `foreign_key_check`, `integrity_check`, `quick_check`, and a bare
  `user_version`, `foreign_keys`, `busy_timeout` or `database_list`.
  Anything else is refused before it runs.
- No write to `op_ctx`, `op_dying`, `ops`, `schema_version`, `machine_identity`,
  `sqlite_sequence` (the AUTOINCREMENT counters; inserts still advance them) or
  `sync_peers` (sync watermarks: `mu sync --repair <peer>` re-reads a peer).

SQLite itself decides what a statement does (its `EXPLAIN` listing, trigger
bodies included), never the text, so a table named `begin` is fine and a
leading `;` hides nothing.

Need DDL? `mu db backup`, edit the copy with `sqlite3` yourself, and leave the
live DB to mu's verbs. `mu db forget` shrinks it.

`mu db --shell [-w <ws>]` opens the `sqlite3` CLI on the same file,
read-only and in safe mode, with the same scoped views. Plain `sqlite3`
starts with `foreign_keys=0` and no capture context: use it to look, never to write.

The whole-file commands stay under `mu db`: `backup`, `compact`, `forget`.

`mu db query` refuses to change a natural-key column (`workstreams.name`,
`tasks.workstream_id`, `tasks.local_id`, a note's task, or an edge's
endpoints). The ops log files every change under that key, so changing
it would desync sync and `mu doctor`. Add a new row instead.

## Pass list flags

A flag with `<value...>` in its help takes repeats, commas, or both:
`--blocked-by a,b` equals `--blocked-by a --blocked-by b`. An empty
fragment from a stray comma is dropped. A blank fragment such as
`" "` is a usage error.
