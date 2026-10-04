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
a status-only op from a v10 peer, an unknown substate from a newer
peer, or a concurrent close and park on two machines. Before commit,
`repairTaskPair` (`src/apply.ts`) sets the substate to the one implied
by the newest op in the log that writes a substate, resolved against
the row's current status. If that pair is illegal, it falls back to
the status default.

Substate is therefore not per-field LWW. Reading the log instead of
the row makes the result a pure function of the op set plus the row's
status, so every peer converges whatever the arrival order. For the
same reason the repair records no op: each peer computes the identical
repair from the identical log.

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

Identity resolution (`resolveWorkerIdentity`, `src/tasks/claim.ts`) is
a two-rung ladder:

1. **`$MU_AGENT_NAME`**, injected into the pane's environment at spawn.
   It is backend-independent.
2. **`backend.currentAgentName()`**, the mux fallback. On tmux it reads
   the pane title (`display-message -p '#{pane_title}'`), never the
   window name, because one window can hold several agents. On herdr
   the name is registered with the mux and looked up by pane id.

The fallback exists for **adopted** panes (`mu agent adopt`), which
predate the env injection and carry only a title. The agent does not
need to know its own name.

## Scoped subtree views

`mu task tree <id>` and the task queries show the part of the graph
reachable from a task. Scoping is a `WHERE` clause, which makes
recursive delegation work: a sub-orchestrator inspects its slice
without an LLM inferring the scope. `src/dag.ts` (`loadFullDag`,
`renderForest`, `renderTaskTree`) serves both `mu task tree` and the
TUI DAG popup.
