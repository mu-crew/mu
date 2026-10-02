# How to query and script mu

Use typed verbs with `--json` first. Use `mu sql` for ad-hoc joins,
reports, and repairs that no verb covers.

## Script with `--json`

Every verb takes `--json`.

- Collection reads print `{"items": [...], "count": N}`.
- Single objects, such as `mu task show`, print an object with named
  fields.
- `mu sql --json` prints a bare array of rows.
- `mu log --tail --json` prints one JSON object per line.
- Errors go to stderr as `{error, message, nextSteps, exitCode}`.

```bash
mu state -w auth --json
mu task list -w auth --json | jq '.count'
```

Exit codes: `2` usage error, `3` not found, `4` conflict, `5`
timeout or a multiplexer, VCS, or drift failure, `6` reaped pane,
`7` stall.

## Read the schema

The schema has 11 tables and 3 views (`ready`, `blocked`, `goals`).
Four tables travel between machines: `workstreams`, `tasks`,
`task_edges`, and `task_notes`. List them all:

```bash
mu sql "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name"
```

Task ids (`local_id`) are unique per workstream only. Join
`workstreams` in every query, or you hit a same-named task elsewhere.
Edges and notes reference `tasks.id`, not `local_id`.

## Run common queries

Blocked tasks and the goals view, which replaced removed verbs:

```bash
mu sql "SELECT b.local_id, b.title FROM blocked b JOIN workstreams w ON w.id = b.workstream_id WHERE w.name = 'auth'"
mu sql "SELECT g.local_id, g.title FROM goals g JOIN workstreams w ON w.id = g.workstream_id WHERE w.name = 'auth'"
```

Search task titles:

```bash
mu sql "SELECT t.local_id, t.status, t.title FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = 'auth' AND LOWER(t.title) LIKE '%token%'"
```

Every task that blocks `launch`, directly or not:

```bash
mu sql "WITH RECURSIVE prereqs(id) AS (
          SELECT t.id FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
           WHERE t.local_id = 'launch' AND w.name = 'auth'
          UNION
          SELECT e.from_task_id FROM task_edges e JOIN prereqs ON e.to_task_id = prereqs.id
        )
        SELECT t.local_id, t.title, t.status FROM prereqs JOIN tasks t ON t.id = prereqs.id"
```

`mu sql` runs writes too and prints the number of rows changed. Writes
are captured as ops, so `mu undo` can revert them.

## Pass list flags

A flag with `<value...>` in its help takes repeats, commas, or both:
`--blocked-by a,b` equals `--blocked-by a --blocked-by b`. An empty
fragment from a stray comma is dropped. A blank fragment such as
`" "` is a usage error.
