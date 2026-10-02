# The ops log

mu keeps one append-only table, `ops`. History, undo, sync, rebuild and
drift detection are all queries or replays over it. Overview:
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Capture is a trigger

Every INSERT, UPDATE and DELETE on a portable table (`workstreams`,
`tasks`, `task_edges`, `task_notes`) is recorded as an **op** by a
SQLite trigger, in the same transaction as the mutation. No SDK
function decides to record history, so no call site can forget to, and
the log cannot drift from the data, even on power loss.

The tables are the materialized view; the log is the record. Reads hit
the tables as ordinary indexed SQL. Nothing replays the log to answer
a query. The log is what the tables are derived from and can be
rebuilt from.

```
  mu task close t3
     │
     ▼
  UPDATE tasks SET status=... ──┬──► tables   (what reads see)
                                └──► ops     (what everything else reads)
                          one transaction
```

| Feature | Over the log |
| --- | --- |
| history | `mu log` is a typed reader over `ops` (`src/logs.ts`) |
| undo | `mu undo <group>` emits the inverse ops for one group |
| sync | each machine appends its own ops to a JSONL segment and applies each peer's from a watermark ([sync.md](sync.md)) |
| rebuild | `mu rebuild <file>` replays the whole log into a new DB |
| drift | `mu doctor --deep` rebuilds into a temp DB and diffs it against the live tables |

**Ops are semantic partial updates.** An UPDATE op carries only the
columns that changed. That makes per-field merge free: two machines
editing different fields of one task both keep their edit. A full-row
payload would silently regress this to row-level last-writer-wins.

**The cost:** one capture bug breaks history, undo and sync at once,
silently. Hence the two drift tiers below.

**Ordering** across machines comes from the **HLC** (`src/hlc.ts`) on
every op: a hybrid logical clock serialized as sortable TEXT
`<wall_ms:15>.<counter:6>.<machine_id>`, so bytewise `ORDER BY hlc` is
causal order. Clock state lives in `machine_identity`.

**Machine-local tables** (`agents`, `vcs_workspaces`) have no capture
triggers. Their contents are pane ids and absolute paths, which mean
nothing on another machine. Their changes are recorded as log-only
events through `emitEvent`. `appendLog` writes operator prose
(`mu log "text"`).

## Trigger mechanics

- **Capture triggers are TEMP triggers**, reinstalled per connection
  by `src/capture.ts`. SQLite refuses a main-schema trigger that
  references the temp `_op_ctx` table. Two consequences follow:
  - DELETE keys are captured inline, with the parent stashing its
    natural key in `_op_dying` first. FK CASCADE fires child triggers
    after the parent is gone.
  - The HLC is minted in SQL, because a trigger cannot call into JS.
- **Op context** (`src/op-context.ts`): `withOpContext(db, {intent,
  actor, group}, fn)` labels every op in a scope and restores in a
  `finally`. Nested scopes inherit the group, which puts a cascade
  under one `mu undo`. `withCaptureSuppressed` is the echo guard used
  by the apply path.
- An importer must synthesize **ops, not rows**. A direct INSERT is
  invisible to sync and reported as drift.

## Apply and merge

`src/apply.ts` is capture's counterpart: given one op, local or from a
peer, it makes the tables reflect it.

- **Merge is per entity.** Notes are grow-only sets. Tasks and
  workstreams merge per field by HLC. Edges are an LWW-element-set.
- A **tombstone** is an ordinary op with an HLC, so out-of-order
  arrival is a comparison and resurrection falls out.
- Never use `json_patch`: RFC 7396 reads a null member as
  delete-the-key.
- Task `status` and `substate` are repaired as a pair, not merged per
  field. See [dag.md](dag.md#substate-integrity).

## Undo

`src/undo.ts` derives the inverse ops for one `group_id` from log
provenance. It refuses a superseded group (exit 4; `--force`
overrides). Bare `mu undo` lists undoable groups (`-n` widens), a group
prefix previews, and `--yes` applies.

- **Undo and restore write through the tables**, so capture records
  them like any other write.
- `restore` records and applies under the **same** HLC. `applyOp`
  excludes an op's own HLC from provenance. A fresher HLC would make
  the row outrank the op and lose every field to an insert default.
- **Note tombstones are self-describing.** Every other `del` carries
  `'{}'`, because its key plus earlier puts describe the row. A note's
  key embeds its rowid (`<ws>/<task>#<id>`), and a rebuild or
  reprojection reassigns rowids. The `task_notes` delete trigger
  therefore records `OLD.*`, and `planUndo` falls back to the
  tombstone payload when folding the puts finds nothing. For the same
  reason `src/drift.ts` matches notes on the task-key prefix.

## Rebuild

`src/rebuild.ts` (`rebuildInto`) replays the whole log into a new DB
file through `applyOp`. The verb prints counts, supports `--json`,
suggests an `mv` swap, and warns that `agents` and `vcs_workspaces`
cannot be reconstructed.

Rebuild is not ingest:

- Ingest filters to `SYNCED_ENTITIES`. Rebuild replays everything, so
  log-only entities are copied verbatim, or `mu log` comes back empty.
- `src/legacy-ops.ts` classifies historical log-only intents whose
  entity looks projectable. Rebuild copies them without projection;
  flush never emits them.
- `machine_identity` carries across whole: id, hostname and HLC clock.
  Otherwise the rebuilt DB is a different peer minting HLCs below
  every replayed op.

## Drift

`src/drift.ts` has two tiers:

| Tier | Runs | Checks |
| --- | --- | --- |
| cheap (`checkCheapDriftInvariant`) | default `mu doctor` | every live row has at least one op naming its key |
| deep (`checkDrift`) | `mu doctor --deep` | rebuilds into a temp DB and diffs field by field |

The deep diff matches rows by natural key and excludes `owner_id`,
because a rebuild always has NULL owners. `driftRemediation` prints the
fix.

For disaster recovery, `mu db backup <file>` writes one scp-able file
through `VACUUM INTO`. It never overwrites; it is the copy
`SchemaTooOldError` tells you to take.
