# scripts/

Retained migration sidecars. Nothing here is wired into the `mu` binary or imported by production code. Run these scripts manually against a preserved source DB.

## `migrate.ts` — v7 to v11, and v11 to v11

`openDb` does not migrate existing databases in place. `scripts/migrate.ts` detects a v7, v8, v9, v10, or v11 source and writes a fresh v11 target:

```bash
npx tsx scripts/migrate.ts <source.db> --out <fresh-v11.db>
```

The source is opened read-only. The script refuses source and target paths that identify the same file, refuses an existing target unless `--force` is explicit, and prints the source SHA-256 before and after.

### Exact upgrade recipe

Stop every `mu` process before copying or swapping the DB.

```bash
DB=${MU_DB_PATH:-$HOME/.local/state/mu/mu.db}
BACKUP="$HOME/mu-old-backup-$(date +%Y%m%d-%H%M%S).db"
TARGET="${DB}.v11"

# 1. Preserve the source, including any committed WAL pages.
# Keep this backup indefinitely.
sqlite3 "$DB" ".backup '$BACKUP'"
shasum -a 256 "$BACKUP"

# 2. Migrate the backup, never the live path.
npx tsx scripts/migrate.ts "$BACKUP" --out "$TARGET"

# 3. Verify the fresh target. Deep doctor must report zero drift.
MU_DB_PATH="$TARGET" mu doctor --deep
MU_DB_PATH="$TARGET" mu workstream list
MU_DB_PATH="$TARGET" mu task list -w <workstream>

# 4. Swap only after verification. Retain the old DB beside it.
mv "$DB" "${DB}.old-kept"
mv "$TARGET" "$DB"

# 5. Reconcile carried machine-local rows against current reality.
mu doctor
```

If verification fails, do not swap. The original DB and backup remain unchanged.

### Flags

| Flag | Effect |
| --- | --- |
| `--out <path>` | Target path. Default: source path with a `.v11.db` suffix. |
| `--force` | Remove an existing target before writing. Off by default. |
| `--drop-logs` | v7/v8 only: omit legacy `agent_logs`. |
| `--drop-archives` | v7/v8 only: skip restoring pre-1.0 `archived_*` rows. |
| `--recover <db>` | Recover legacy substates **in place** on an existing v11 DB. Takes only `-w`. |
| `-w <workstream>` | `--recover` only: limit recovery to one workstream. |

### Legacy statuses become substates

v9 had `REJECTED` and `DEFERRED` statuses. v10 folded both to `OPEN` and wrote a `MIGRATION: previous status was …` note. v11 maps them onto (status, substate) pairs:

- `REJECTED` becomes `CLOSED/rejected`. (mu 3.0.0 mapped it to `CLOSED/wontfix`; see *v11 → v11* below.)
- `DEFERRED` becomes `OPEN/parked`.

The mapping is in the shared apply path, so old peer segments, `mu sync --from`, and `mu rebuild` produce the same pairs. The original payload stays in `ops`. The script no longer writes `MIGRATION:` notes; the substate carries the fact.

### v10 → v11 behavior

The complete v10 ops log is replayed through the v11 apply path, which maps every task whose newest status op is a legacy status. Agents, workspaces and ownership are carried as for v9.

The replay alone misses a task whose legacy status is hidden behind a later write that is not a decision. The script then runs legacy substate recovery over every `OPEN/todo` task:

1. Find the last status writer: the newest task `put` with a `status`, ignoring intents `undo` and `migrate.substate`. An undo restore replays an older value; it is not a new decision.
2. If that status is `REJECTED` or `DEFERRED`, recover the mapped pair (source `ops`).
3. Otherwise, if the task has a `MIGRATION: previous status was …` note, and the last status writer is a `migrate.*` `OPEN` put or is older than the note, recover the pair the note names (source `note`).
4. Otherwise skip the task. A later real decision wins.

Each recovery is one captured `UPDATE` of `status`, `substate` and `updated_at` under intent `migrate.substate`, in one group. The op syncs, survives `mu rebuild`, and `mu doctor --deep` reports no drift. A task that already has a `migrate.substate` op is skipped, so recovery is idempotent.

The report lists every changed task as `workstream  task  from -> to  (source)`, where source `replay` means the apply path derived the pair. A final list names the dependents that became ready because a blocker recovered to a closed pair.

### `--recover`: after `mu undo` restores a workstream

`mu undo` on a pre-v11 `workstream teardown` restores tasks from history, and an undo restore is not a decision, so those tasks come back `OPEN/todo`. Run recovery on the live DB after the undo:

```bash
npx tsx scripts/migrate.ts --recover "${MU_DB_PATH:-$HOME/.local/state/mu/mu.db}" [-w <workstream>]
```

This is the only mode that edits a DB in place. It refuses anything but a v11 DB.

### v11 → v11: `wontfix` becomes `rejected`

mu 3.0.0 mapped legacy `REJECTED` to `CLOSED/wontfix`; 3.1.0 maps it to `CLOSED/rejected`. A rebuild or a migration re-derives the new pair from the ops log, so migrating a v11 source (`npx tsx scripts/migrate.ts <v11.db> --out <new.db>`) fixes every such task. The same pass is part of recovery, so `--recover` fixes a live DB in place.

A `CLOSED/wontfix` task is re-mapped to `CLOSED/rejected` only when both hold:

1. The newest op that wrote `wontfix` was an `undo` or `migrate.*` op, not a decision. A deliberate `mu task close --as wontfix` stays.
2. The task's history has a legacy `REJECTED` status op.

A `CLOSED` to `CLOSED` re-map unblocks nothing, so the report lists no dependents for it.

### v9 → v11 behavior

The complete v9 ops log is copied byte-for-byte at the op-field level, then one `migrate.v9-projection` group re-asserts the v9 live rows so a stale tombstone cannot erase current work. Legacy statuses in that projection map onto pairs as above.

Carried from v9 (and v10):

- workstreams, tasks, edges, notes, and the complete ops history;
- `machine_identity`, including the persisted HLC clock;
- `sync_peers` watermarks;
- agents whose workstream survives;
- workspaces whose referenced agent and workstream survive;
- task ownership whose referenced agent survives.

Machine-local rows are structurally valid but cannot be proven operational during migration. A pane id may no longer name a live pane, and an absolute workspace path may no longer exist or belong to the recorded VCS backend. Run `mu doctor` after the swap; reconciliation decides pane reality. Keep the source DB as the audit copy.

### v7 / v8 → v11 behavior

Live rows are imported the same way on both versions: synthesize ops for workstreams, tasks, edges, and notes, then use the normal apply path. Optional `agent_logs` become log-only `event` ops. v7 may lack `machine_identity` / `workstream_sync`; those absences are fine.

**Archives restore by default.** Pre-1.0 `archived_tasks` / `archived_edges` / `archived_notes` / `archived_events` become ordinary live workstreams named after each row's `source_workstream` (not the archive label), under intent `migrate.archive`. That is the common v7 case: live tables emptied by `workstream destroy`, real history sitting only in archives. `--drop-archives` skips that restore. If an archived task key collides with a live task key, the importer refuses rather than merging two histories onto one natural key.

Not carried from v7/v8 live tables:

| Source data | Reason |
| --- | --- |
| agents and task owners | Pane ids predate the current registry and cannot be validated safely. |
| VCS workspaces | Absolute paths cannot be asserted valid across the substrate break. |
| snapshots | The table no longer exists; retain the files separately. |
| workstream sync state | Replaced by per-machine `sync_peers`. |

The v7/v8 path may merge byte-identical notes because v11 note identity is `(task, author, content)`. The report names the count.

### Why this script is retained

It crosses released schema boundaries that users may encounter months later. Keeping one auto-detecting sidecar avoids a chain of version-specific migration scripts while preserving the rule that production startup never performs an in-place migration.
