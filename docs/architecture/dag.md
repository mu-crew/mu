# The task DAG

mu coordinates work through a directed acyclic graph of tasks. Without
it mu is only an agent runner. Overview:
[ARCHITECTURE.md](../ARCHITECTURE.md). Terms:
[VOCABULARY.md](../VOCABULARY.md).

## Model

- **Tasks** are nodes with mandatory `impact` (1-100) and
  `effort_days`. `ROI = impact / effort` drives prioritization.
- **One edge type: `blocks`.** `A → B` means A must close before B can
  start. More edge types would make "can this start?" ambiguous.
- **No hidden edges.** Every edge comes from a verb the caller ran (`block`,
  `add --blocked-by`, `reparent --blocked-by`); no write adds edges
  on its own or wires a task to a top goal. A hidden edge makes phantom
  blockers and false cycles, and `unblock` appears to do nothing.
- **Status lifecycle:** `OPEN → IN_PROGRESS → CLOSED`. Status alone
  decides edge satisfaction: any `CLOSED` task satisfies its blockers.
- **Substate** qualifies status and never touches edges:
  `OPEN/todo|parked|triage`, `IN_PROGRESS/active`,
  `CLOSED/done|rejected|wontfix|duplicate|superseded`. The rule is
  "store intent, derive graph facts": ready and blocked stay derived
  from edges. `OPEN/parked` and `OPEN/triage` are excluded from `ready`
  but stay in `goals`; `claim` refuses both without `--force`.
- **Notes** are append-only per task. They survive LLM context loss
  and agent restarts, which fixes context loss at the task level
  rather than the agent level.

## Substate integrity

The legal pairs live in the `task_substates` lookup table, seeded from
code on every open (machine-local, never synced). `tasks` has a
composite FK `(status, substate) → task_substates`,
`DEFERRABLE INITIALLY DEFERRED`. That FK is the only guard on the pair.

SQLite checks it at COMMIT, so apply's one-field-at-a-time UPDATEs
pass as long as the pair is legal when the transaction ends. That is
why `applyOp` wraps each task put in `db.transaction`. In autocommit
the first per-field UPDATE would fail the FK.

Every lifecycle write sets `status` and `substate` in one UPDATE, so
one op carries both under one HLC. A pair can still split across ops:
a status-only op from an older peer, an unknown substate from a newer
peer, or a concurrent close and park on two machines. `foldTask`
(`src/fold.ts`) takes the substate from the newest live op in the log
that writes one and resolves it against the folded status. If that
pair is illegal, it falls back to the status default.

Substate is therefore not per-field LWW. Folding the log instead of
patching the row makes the result a pure function of the op set, so
every peer converges whatever the arrival order, and the apply records
no op: each peer computes the identical row from the identical log.

## Built-in views

| View | Returns |
| --- | --- |
| `ready` | `OPEN/todo` tasks with no unresolved blockers: work that can start now |
| `blocked` | OPEN tasks waiting on something |
| `goals` | tasks with no dependents: graph endpoints |

Agents and humans query these views directly through `mu sql`. There
is no separate query layer.

## Parallel tracks

The Tracks section of `mu state` and bare `mu` runs union-find
(`src/tracks.ts`) to find independent subtrees that different agents
can work in parallel.

Diamonds merge. If two roots share a prerequisite, they collapse into
one track, so two agents never collide on the shared dependency:

```
  Independent (2 tracks):       Diamond (1 merged track):

    goal_a    goal_b              goal_a   goal_b     ← Spawn 2 agents
       |         |                   \      /
    task_a    task_b                  shared          ← Spawn 1 (would
       |         |                      |               collide otherwise)
    leaf_a    leaf_b                  leaf
```

The graph algorithm decides, not the LLM.

## Claim protocol

`mu task claim <task>` resolves the claimer, then atomically sets
`tasks.owner`, flips `status` to `IN_PROGRESS`, and records a
`task.claim` op carrying the resolved `actor`. The claim is a CAS in
SQLite, so two agents cannot claim the same task.

Identity resolution (`resolveWorkerIdentity`, `src/tasks/claim.ts`) reads
**`$MU_AGENT_NAME`**, injected into the pane's environment at spawn. It
is backend-independent and needs no mux call; pane titles are not
identity. The agent does not need to know its own name.

## Local-write guards

Three triggers in the DB file (`src/capture.ts`, `localGuards`) refuse
states a **local** write must not create. Each is gated on
`applying = 0`, so ingest, import and rebuild accept what the log says: peers
merge into states no local write allows (a close and its evidence are
separate ops), and a RAISE during ingest would roll back the segment and
stall sync forever. `mu doctor` lists such tasks instead (warn).

| Trigger | Refuses | Error (exit 4) |
|---|---|---|
| `_cap_tasks_claim_cas` | `owner_id` moving from one agent to another | `TaskAlreadyOwnedError` |
| `_cap_tasks_close_evidence` | a close with no `kind = 'close'` note in the same op group | `CloseNeedsEvidenceError` |
| `_cap_tasks_close_blockers` | a close to `done` while a blocker is not CLOSED | `TaskHasOpenBlockersError` |

- A close is OPEN/IN_PROGRESS → CLOSED, or a CLOSED task changing
  substate. Reclassifying to `done` therefore needs fresh evidence and
  closed blockers.
- `wontfix`, `duplicate`, `rejected` and `superseded` closes skip the
  blocker check: they do not claim the work happened. Their `--why`
  note is the evidence.
- The note must exist before the status UPDATE, in the same op group
  (`closeTask` writes it first). Identity is the exact note key, never a
  `LIKE` (task ids allow `_`).
- `owner_id` never syncs, so a peer's owner op cannot change ownership.

## Scoped subtree views

`mu task tree <id>` and the task queries show the part of the graph
reachable from a task. Scoping is a `WHERE` clause, which makes
recursive delegation work: a sub-orchestrator inspects its slice
without an LLM inferring the scope. `src/dag.ts` (`loadFullDag`,
`renderForest`, `renderTaskTree`) serves `mu task tree`.
