# Task substates: classification without stranded dependents

Status: shipped in 3.0.0 (schema v11); `CLOSED/rejected` added in 3.1.0. Implemented 2026-09-29 (approved 2026-09-29; see [Deviations during implementation](#deviations-during-implementation))
Date: 2026-09-29
Supersedes the notes-only convention from `9e3c47b` ("tasks: reduce lifecycle to three states").

## Problem

`9e3c47b` removed `REJECTED` and `DEFERRED`. That fixed a real problem and created a new one.

The real problem: each old status mixed two independent facts into one value.

| old status | lifecycle phase | why | effect on dependents |
|---|---|---|---|
| `REJECTED` | ended | won't do | still blocked |
| `DEFERRED` | not active | parked | still blocked |

Neither satisfied a `blocks` edge, so rejecting or deferring a task silently stranded its dependents. The guard against that refused the transition unless `--cascade` was given. `--cascade` then stamped the whole subtree, which was too aggressive (`bug_cascade_reject_too_aggressive`).

The new problem: with only `OPEN | IN_PROGRESS | CLOSED`, mu cannot tell "done" from "abandoned", and cannot keep a task out of the scheduler without closing it. The "why" lives only in free-text notes, which no view can filter on.

## Approach

Split the two facts into two columns.

- **`status`** is the lifecycle phase. It alone decides edge satisfaction: `CLOSED` satisfies a `blocks` edge, anything else does not. Unchanged.
- **`substate`** qualifies the status. It never touches edge semantics.
- **Blocked / ready** stay derived from edges in views. They are never stored.

Rule: **store intent, derive graph facts.** Only what a person or agent decides is stored.

| status | substates | default |
|---|---|---|
| `OPEN` | `todo`, `parked` | `todo` |
| `IN_PROGRESS` | `active` | `active` |
| `CLOSED` | `done`, `wontfix`, `duplicate`, `superseded` | `done` |

`substate` is never null. Every status has one named default, so an absent value never carries meaning.

Consequences:

- `CLOSED/wontfix` (and any other close) unblocks dependents. The close reports which dependents it unblocked. Nothing gets stranded, so no cascade is needed.
- `OPEN/parked` leaves the scheduler: it is excluded from `ready` and `next`, and `claim` refuses it without `--force`. It stays in `goals`, because tracks are built from goals and a parked goal must not make its subtree vanish; a track whose non-closed tasks are all parked is marked parked instead. Its dependents stay ordinarily blocked, and surfaces say "blocked by parked X".
- A closed blocker now means "stop waiting", not "the prerequisite work exists". `mu task wait` and `close --if-ready` fire on any `CLOSED/*` blocker. This is intended, and it is why every non-`done` close prints the dependents it unblocked.

## Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | Two columns (`status` + `substate`), not more statuses. | Keeps a single rule for edge semantics; classification can grow without touching the DAG. |
| D2 | Parked is an `OPEN` substate, not a status. | The dependency is still real: B still waits on A. Only scheduling changes. |
| D3 | Non-`done` closes unblock dependents. | Blocking caused the stranding problem last time. The report keeps the effect visible. |
| D4 | `substate` is never null; each status has a named default. | An absent value must not carry meaning. |
| D5 | Valid pairs are enforced by a lookup table plus a composite foreign key `DEFERRABLE INITIALLY DEFERRED`. | Enforces the rule across both columns; tolerates sync's one-field-at-a-time writes, because the check runs at commit; adding a value is an `INSERT`, not a table rebuild. Verified in SQLite (see Appendix A). |
| D6 | Drop the `status` CHECK. The lookup table is the single list. | Two lists would drift. |
| D7 | Every lifecycle op writes `status` and `substate` together. | Both fields carry the same HLC, so per-field last-write-wins cannot split a pair from our own ops. |
| D8 | Apply resolves the pair before writing: a status-only op, or an unknown substate from a newer peer, falls back to the status default. The original payload stays in `ops`. | The foreign key fails the whole commit. Version skew must not break sync; the foreign key is there to catch our own bugs. |
| D9 | Non-`done` close and `park` require `--why`, stored as an ordinary note in the same transaction. | Keeps the rationale, the one good part of the notes-only convention. |
| D10 | Start with `parked` as the only non-default `OPEN` substate. No `--until`. | YAGNI. mu has no daemon to run the automatic un-park. Adding `triage` later is one seeded row. |
| D11 | One shared legacy mapping: `REJECTED → CLOSED/rejected` (3.1.0; 3.0.0 used `wontfix`), `DEFERRED → OPEN/parked`. | Replaces `normalizeTaskStatus` (currently folds both onto `OPEN`). Apply, rebuild, undo and migration all use it, so recovery happens on every path. |
| D12 | Migrate v10 → v11 through `scripts/migrate.ts`, not in `openDb`. | Keeps the "production never migrates in place" rule. SQLite cannot add a foreign key to an existing table, so a new target is required anyway. |

## Schema (v11)

```sql
CREATE TABLE IF NOT EXISTS task_substates (
  status     TEXT NOT NULL,
  substate   TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  PRIMARY KEY (status, substate)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_substates_one_default
  ON task_substates (status) WHERE is_default = 1;

-- tasks gains:
  substate TEXT NOT NULL,
  FOREIGN KEY (status, substate) REFERENCES task_substates (status, substate)
    DEFERRABLE INITIALLY DEFERRED
-- and loses: CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED'))
```

- `applySchema` seeds the pairs with `INSERT OR IGNORE`, before any task write.
- `CURRENT_SCHEMA_VERSION = MIN_ACCEPTED_SCHEMA_VERSION = 11`.
- `EXPECTED_TABLES` gains `task_substates` (11 entries).
- Views:
  - `ready`: add `AND t.substate <> 'parked'`.
  - `blocked`: unchanged.
  - `goals`: unchanged (see Consequences: tracks mark parked instead).
- `SchemaTooOldError.errorNextSteps` names `scripts/migrate.ts`.
- New `SchemaTooNewError` (exit 4): `openDb` refuses a DB newer than `CURRENT_SCHEMA_VERSION`. v10 has no such guard, so a v10 binary opening a v11 DB fails only when it writes (NOT NULL / FK). The guard protects v12 and later; for v11 the operator must switch every binary before the swap (see Restoring destroyed workstreams).
- `substate` has no column DEFAULT, so a writer that doesn't know about it fails loudly instead of guessing.

`src/tasks/status.ts` mirrors the table:

```ts
export const TASK_SUBSTATES = {
  OPEN: ["todo", "parked"],
  IN_PROGRESS: ["active"],
  CLOSED: ["done", "wontfix", "duplicate", "superseded"],
} as const satisfies Record<TaskStatus, readonly string[]>;
export const DEFAULT_SUBSTATE = { OPEN: "todo", IN_PROGRESS: "active", CLOSED: "done" } as const;
export function resolvePair(status: string, substate: unknown): { status: TaskStatus; substate: TaskSubstate };
export function mapLegacyStatus(value: string): { status: TaskStatus; substate: TaskSubstate } | null;
```

The seed rows are generated from `TASK_SUBSTATES`. A test asserts that the seeded table and the map are identical.

## Sync and ops

- `capture.ts` `CAPTURED_COLUMNS.tasks` and `apply.ts` `APPLIABLE_COLUMNS.tasks` gain `substate`.
- Every lifecycle verb writes `{status, substate}` in one op payload.
- `applyTaskPut` projects the payload in this order:
  1. Map legacy status values through `mapLegacyStatus`. This can set both fields.
  2. Apply per-field LWW as today.
  3. Read the resulting row pair. If it is invalid, write the default substate for the status. The repair is deterministic, so every peer converges on the same row without an extra op.
- `undo.ts` `restoreRow` uses the same mapping and repair.
- v10 peers drop `substate` as an unknown field and keep working. Status-only ops from v10 peers are repaired by step 3.

## CLI and SDK surface

| Command | Effect |
|---|---|
| `mu task close <id> [--as done\|wontfix\|duplicate\|superseded] [--why "..."]` | `CLOSED/<as>`; default `done`. `--why` required unless `done`. Prints unblocked dependents when `--as` is not `done`. |
| `mu task park <id> --why "..."` | `OPEN/todo → OPEN/parked`. Refuses `IN_PROGRESS` (next step: `release` first) and `CLOSED` (next step: `open` first). Idempotent on `OPEN/parked`. |
| `mu task unpark <id>` | `OPEN/parked → OPEN/todo`. No-op on other pairs. |
| `mu task open <id>` | `→ OPEN/todo` from any pair. |
| `mu task claim <id>` | `→ IN_PROGRESS/active`. Refuses `OPEN/parked` without `--force`. |
| `mu task release <id>` | `IN_PROGRESS/active → OPEN/todo`. `--reopen` from `CLOSED/*` also gives `OPEN/todo`. |
| `mu task list --substate <name>` | Filter. Composes with `--status`. |
| `mu task show`, `list`, `tree`, `next`, `mu state` | Render `STATUS/substate` when the substate is not the default, for example `OPEN/parked` or `CLOSED/wontfix`. Show the bare status for defaults. JSON always carries both fields. |

- `mu task show` blocked output names the blocker's substate: "blocked by X (OPEN/parked)".
- SDK exports: `TaskSubstate`, `TASK_SUBSTATES`, `DEFAULT_SUBSTATE`, `parkTask`, `unparkTask`, and `closeTask(…, { as, why })`. `TaskRow` gains `substate`.
- Tracks: a track whose non-closed tasks are all parked is marked parked and is not counted as available parallel work.

## TUI

The TUI only reads data; it has no commands that change tasks. Only `recent.tsx` references `closeTask`, and only to describe it. So the TUI work is display, filtering and yank strings.

| Surface | File | Change |
|---|---|---|
| Colours | `src/cli/format.ts` `colorStatus`, `inkColorForStatus` | Take the pair. `OPEN/parked` gray; `CLOSED/done` green; other `CLOSED/*` red/dim. `InkColor` gains `gray` and `red` again. |
| Status label | `list-row.tsx`, `all-tasks.tsx:243`, `task-detail.tsx`, DAG `renderForest` | Render `STATUS/substate` for non-defaults, sharing one formatting helper with the CLI. |
| Filter strip | `use-status-filter.tsx`, `keymap-spec.ts` | Keep `o/i/c`. Add `p`, which toggles parked tasks within `OPEN`, and `w`, which toggles non-`done` closes within `CLOSED`. Default: all visible. Update the `DAG_HINTS` / `ALL_TASKS_HINTS` clusters and the help pane; `tui-help-overlay.test.ts` enforces that they match. |
| Ready card | `cards/ready.tsx:72` | Parked tasks drop out via the view. Empty-state text: mention parked when some exist, e.g. "(no ready tasks) 3 parked". |
| Blocked card / popup | `cards/blocked.tsx`, `popups/blocked.tsx` | `stillGating` unchanged (not `CLOSED`). Annotate gating blockers that are parked: "← X (parked)". |
| Tracks popup | `popups/tracks.tsx` `statusRank` | Order: `IN_PROGRESS`, `OPEN/todo`, `OPEN/parked`, `CLOSED/*`. Mark all-parked tracks. |
| Recent card | `cards/recent.tsx` | Show the close substate: "closed (wontfix)". |
| Yank | `popups/ready.tsx` `yankCommandForTask` | `OPEN/parked` → `mu task unpark …`. `CLOSED/*` → `mu task open …` (unchanged). |
| Glyphs | `src/glyphs.ts` | Add a `parked` glyph for dense rows. The status text stays the source of truth. |

## Migration (`scripts/migrate.ts`)

Extend the existing sidecar to target v11. It already accepts v7–v9; add v10. The default output suffix becomes `.v11.db`.

**v10 → v11.** Use `rebuildInto` as the v9 path does: copy the full ops log, then replay it through the v11 apply path. Recovery mostly comes for free, because the legacy payloads are still in the log:

1. Ops carrying `REJECTED` / `DEFERRED` project through `mapLegacyStatus` to `CLOSED/wontfix` / `OPEN/parked`.
2. Normal LWW decides the result. If a later op wrote the status, that later write wins and nothing is recovered, which is the "later change wins" rule.
   When looking for the last status writer, ignore ops with intent `undo` or `migrate.substate`. An undo restore replays an older value; it is not a new decision.
3. **Fallback from `MIGRATION:` notes.** If a task has a `MIGRATION: previous status was X` note, currently projects as `OPEN/todo`, and no status-writing op is newer than the note's `created_at`, append one `migrate.substate` op setting the mapped pair.
4. Carry machine-local rows (agents, workspaces, owners) exactly as the v9 path does.

**v7–v9 → v11.** Unchanged, except that the target is v11. The shared mapping now yields substates directly. Stop appending `MIGRATION:` notes: the substate carries the information.

**Report.** In addition to the current output, list every recovered task with its old and new pair, and for each `CLOSED/wontfix` recovery, the dependents it unblocked.

`scripts/README.md`: rename the section to "v7–v10 to v11", update the recipe paths, and document the recovery rules above.

## Restoring destroyed workstreams

Run this after the v11 swap, using ordinary `mu undo`, so the undo ops sync and appear in `mu log`. `restoreRow` uses the shared mapping, so restored tasks come back as `OPEN/parked` or `CLOSED/wontfix`, not as `OPEN`.

A tombstone written after the v10 migration may hold the already-folded `OPEN`, not the legacy value, so mapping alone recovers nothing. The migration's recovery pass (steps 1–3 above) is therefore a shared function, `recoverLegacySubstates(db, workstream)`. After restoring, run it on each restored workstream with `npx tsx scripts/migrate.ts --recover <db> -w <ws>`. It uses the same last-status-writer rule and writes `migrate.substate` ops.

Current live DB (read-only check, 2026-09-29):

- 69 tasks with legacy statuses in history, all in 11 destroyed workstreams: `feedback`, `gchatui`, `gchatui-node` (2 destroy groups), `infer-rs`, `modelbridge` (teardown), `mufeedback`, `mufeedback-v03`, `multimachine`, `roadmap-v0-2`, `surface-audit`, `tui-impl`.
- 42 workstreams in total are tombstoned; only 3 are live.
- Dry runs of `mu undo 6f3d12e7` and `mu undo f34e2141` on v10 both plan full restores.

Scope: all 42 tombstoned workstreams, not only the 11 with legacy tasks.

Recipe:

1. For each destroy/teardown group, oldest first, run `mu undo <group>` (dry run). Record conflicts. A workstream destroyed more than once (e.g. `gchatui-node`) needs its groups undone newest first.
2. Apply with `--yes`. Do not use `--force`; resolve any superseded groups by hand.
3. Run `mu doctor --deep`, then `mu task list --substate parked` and `--substate wontfix` per workstream, and compare against the migration report.

## Testing

- **Schema:** fresh DB seeds pairs; invalid pair, unknown value, and deleting a pair that is in use all fail; per-field writes inside one transaction commit; one default per status.
- **Map parity:** `TASK_SUBSTATES` equals the seeded rows.
- **Lifecycle:** each verb's resulting pair; `park` refuses `IN_PROGRESS` and `CLOSED` with next steps; `claim` on parked refuses without `--force`; `--why` is required; the unblocked-dependents report is correct.
- **Views:** parked tasks are excluded from `ready` and stay in `goals`; a dependent of a parked task is in `blocked`; a dependent of `CLOSED/wontfix` is `ready`.
- **Apply:** status-only op (v10 peer) repairs to the default; unknown substate falls back; legacy payloads map; the same op sequence converges on two DBs.
- **Undo:** restoring a tombstoned legacy task yields the mapped pair; undoing a park restores the prior pair.
- **Migration:** v10 fixtures with (a) a legacy op and no later status op → recovered; (b) a later `task.open` → not recovered; (c) a note but truncated ops → fallback fires; (d) v9 source → v11 directly. `mu doctor --deep` reports zero drift on the target.
- **TUI:** filter-key parity test; `yankCommandForTask` for parked; colour and label helper cases; ready empty-state text.

## Out of scope

- Task kinds (bug / feature / chore) and free-form labels.
- `--until` automatic un-parking.
- `triage` / `needs-info` substates (one seeded row each, later).
- Substates for `IN_PROGRESS` beyond `active`.
- Blocking semantics for any closed substate.

## Resolved questions

1. **Restore scope:** restore all 42 tombstoned workstreams, then run legacy recovery on each.
2. **Park on `IN_PROGRESS`:** refuse. The owner must `release` first. One verb, one transition.
3. **TUI keys:** `p` and `w` accepted.

## Implementation checklist

1. `status.ts`: `TASK_SUBSTATES`, `DEFAULT_SUBSTATE`, `resolvePair`, `mapLegacyStatus`; delete `normalizeTaskStatus`.
2. `db.ts`: v11 schema, seed, view changes, `EXPECTED_TABLES`, `SchemaTooOldError` next steps.
3. `capture.ts` / `apply.ts` / `undo.ts`: carry `substate`, apply-time mapping and repair.
4. Lifecycle verbs and SDK: `close --as/--why`, `park`, `unpark`, claim guard, unblocked-dependents report.
5. CLI rendering, `--substate` filter, JSON fields, tracks marking.
6. TUI changes per the table above.
7. `scripts/migrate.ts`: v10 → v11 path, `recoverLegacySubstates`, `--recover` mode, report; `scripts/README.md`.
8. Docs: `VOCABULARY.md` (substate, park, resolution values), `skills/mu/SKILL.md`, `CHANGELOG.md` (Breaking: v11; Added: substates).
9. Operator step: migrate the live DB, then restore workstreams per the recipe.

## Deviations during implementation

Recorded after tasks 1–7 landed. Where this section and the text above disagree, this section describes the code.

1. **Substate is resolved from the log, not by per-field LWW** (task 3). [Sync and ops](#sync-and-ops) step 2–3 described per-field LWW plus a row-only repair. That diverges by arrival order: a repair that reads only the row bakes the fallback into it, and a later status change keeps the fallback on one peer and the real substate on another. `repairTaskPair(db, rowId, pending?)` in `src/apply.ts` instead takes the substate from the newest op in the log that writes one (an explicit substate, a legacy status implying its mapped pair, or a status-only op implying the status default), then resolves it against the row's current status. The result is a pure function of the op set, so every peer converges and the repair records no op. `applyOp` wraps each task put in `db.transaction` so the deferred FK sees a complete pair. `normalizeTaskStatus` and `RETIRED_STATUSES` are deleted.
2. **A second `updated_at`-only task op may share the group** (tasks 4, 5). `close --why` and `park` insert a note, and the note's parent touch writes a separate task op carrying only `updated_at` when the millisecond clock ticks between the two writes. It sits in the same group, so undo and log rendering are unaffected. Tests count ops that carry `status` or `substate`, not all task ops.
3. **Ready empty-state text is shorter** (task 6): `(no ready tasks) N parked · the rest are blocked or closed`, truncated at the card edge. The longer text in [TUI](#tui) wrapped over the card's border. The Recent card shows the pair (`CLOSED/wontfix`) rather than "closed (wontfix)". `inkColorForStatus` is removed in favour of `inkColorForPair`; `loadFullDag` gained an `include` predicate so the root module does not import the TUI filter.
4. **Migration and drift** (task 7). `src/drift.ts` compares `substate`, so `mu doctor --deep` sees substate drift. The v7/v8/v9 paths no longer write `MIGRATION:` notes. The migration report lists a third source, `replay`, for pairs the apply path derived during replay, alongside `ops` and `note` for captured `migrate.substate` recoveries. Recovery candidates are `OPEN/todo` tasks only, and a task that already has a `migrate.substate` op is skipped, which makes `--recover` idempotent. The v10 path turned out to need captured recovery only for the undo-hidden and note-only cases; replay already maps the rest.
5. **`SchemaTooNewError`** (task 2). `openDb` refuses a DB whose `schema_version` is newer than `CURRENT_SCHEMA_VERSION` (exit 4), before `applySchema`. Without it, a v10 binary would open a v11 DB and fail at commit on its first write. `tasks.substate` has no `DEFAULT`, so an old INSERT fails loudly rather than silently choosing a substate.

## Appendix A: foreign key verification

Tested in SQLite with `PRAGMA foreign_keys=ON` and the deferred composite foreign key:

| test | result |
|---|---|
| Change `status`, then `substate`, in two `UPDATE`s inside one transaction | committed |
| `CLOSED` + `parked` | rejected |
| unknown substate `bogus` | rejected |
| delete an allowed pair that a task uses | rejected |
| `ALTER TABLE … ADD CONSTRAINT FOREIGN KEY` on an existing table | syntax error (hence D12) |
