# Architecture

mu is one SQLite file, a crew of agents in multiplexer panes, a task
DAG, and one append-only op log that everything else derives from.
Callers sit on top, a shared TypeScript core in the middle, and SQLite,
the multiplexer and the VCS at the base. The CLI verbs and the SDK are
thin facades over the same core.

Terms: [VOCABULARY.md](VOCABULARY.md) (source of truth). Principles:
[VISION.md](VISION.md). Rationale, rejected alternatives and pledges:
[ROADMAP.md](ROADMAP.md).

```
┌─────────────────────────────────────────────────────────────────┐
│  Callers: pi shell · bash + jq · pi sub-agent · mu log --tail   │
└───────────────┬─────────────────────────────────┬───────────────┘
                │ subprocess (CLI)                 │ in-proc (SDK)
                ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  mu core (shared TS modules)                                    │
│  agents/ mux/ ctl/ · tasks/ tracks · vcs/ workspace/ · ops log  │
│  (capture, apply, undo, sync, drift)                            │
└───────────────┬──────────────────┬──────────────────┬───────────┘
                ▼                  ▼                  ▼
   SQLite (~/.local/state/mu/mu.db) · tmux/herdr panes · jj/sl/git
                   pi agents: control socket per agent
```

## Subsystems

**The ops log.** Every write to a portable table (`workstreams`,
`tasks`, `task_edges`, `task_notes`) is recorded as an op by a SQLite
trigger in the same transaction. The tables are the materialized view
reads hit; the log is the record. History (`mu log`), undo, sync,
rebuild and drift checks are all queries or replays over it. Ops carry
only changed columns and an HLC, which makes per-field merge across
machines free. Read this first:
[architecture/ops-log.md](architecture/ops-log.md).

**The task DAG.** Tasks are nodes with impact and effort; the one edge
type is `blocks`. Status decides edge satisfaction, and substate
qualifies status without touching edges. The `ready`, `blocked` and
`goals` views, union-find tracks with diamond merge, and an atomic
claim keyed on `$MU_AGENT_NAME` coordinate the crew:
[architecture/dag.md](architecture/dag.md).

**Multiplexer and reconciliation.** One workstream is one mux session
(a tmux session or a herdr workspace). Call sites reach the backend
only through `activeMux()` and branch on capabilities, never on the
backend name. `mu agent list` prunes ghost rows and surfaces orphan
panes against mux reality. Runtime agent state is read on demand, never
stored: the control socket for pi agents, herdr's native status on
herdr, and murmur for other CLIs on tmux:
[architecture/mux.md](architecture/mux.md).

**The control socket.** mu's pi extension serves a unix socket inside
each spawned pi. Send, `--fresh`, wait, abort and state for pi agents
go through it, exactly, with no screen reading and no fallback to
pasting. Remote agents use an ssh socket forward printed by
`mu agent remote-env`. The tmux bracketed-paste path serves the
[cases listed there](architecture/control-socket.md#no-silent-fallback).

**Sync.** With `MU_SYNC_DIR` set, every `mu` invocation ingests peer
JSONL segments before the verb and flushes its own ops after it,
through `handle()`. There is no daemon and no network code:
[architecture/sync.md](architecture/sync.md).

**The TUI.** Bare `mu` on a TTY opens a read-only ink dashboard of 10
cards with drill-down popups. It polls SQL every second and
subprocesses every 10 seconds, yanks `mu` commands instead of running
them, and is the only code that imports ink:
[architecture/tui.md](architecture/tui.md).

**CLI and SDK surface.** Each operation is a typed SDK function plus a
thin Commander wrapper. Public functions take operator-facing names and
resolve them to surrogate ids exactly once. Typed errors map to exit
codes 0-7. The same page covers testing layers and packaging:
[architecture/sdk.md](architecture/sdk.md).

## Module map

`src/` is flat at the root, with one level of cohesive clusters.
Cluster files import from neighbours and root modules, never from the
hub that re-exports them. `src/tasks.ts`, `src/agents.ts`, `src/mux.ts`,
`src/vcs.ts` and `src/workspace.ts` are re-export hubs.

### Storage and the ops log

| Module | Responsibility |
| --- | --- |
| `src/db.ts` | better-sqlite3 connection (WAL); schema v11 (12 tables, 3 views) in `applySchema`; installs capture; owns `SYNCED_ENTITIES`, `PORTABLE_TABLES`, `MACHINE_LOCAL_TABLES`; refuses older (`SchemaTooOldError`) or newer (`SchemaTooNewError`) DBs, exit 4 |
| `src/hlc.ts` | hybrid logical clock, serialized as sortable TEXT |
| `src/capture.ts` | TEMP triggers recording each portable write as an op, and refusing natural-key changes |
| `src/op-context.ts` | `withOpContext` (intent, actor, group); `withCaptureSuppressed` echo guard |
| `src/apply.ts` | apply one op: per-field LWW, tombstones, substate pair repair, `reprojectDeferredOps` |
| `src/undo.ts` | inverse ops for one group; refuses a superseded group |
| `src/rebuild.ts` | replay the whole log into a new DB file |
| `src/compact.ts` | `mu db compact` (blank redundant note-tombstone payloads) and `mu db forget` (drop a torn-down workstream's ops); this machine only |
| `src/legacy-ops.ts` | classifier for historical log-only intents; rebuild copies them unprojected |
| `src/drift.ts` | cheap invariant (every row has an op) and `--deep` rebuild-diff |
| `src/logs.ts` | typed reader over `ops`; `appendLog` and `emitEvent`, the writes triggers cannot cover |
| `src/log-render.ts` | the one op-to-prose formatter (`renderOp`), shared by CLI and TUI |

### Sync and doctor checks

| Module | Responsibility |
| --- | --- |
| `src/segments.ts` | JSONL segments: flush own ops, ingest peers from a watermark |
| `src/segment-manifest.ts` | segment `.manifest` sidecar: read, write, seal, and the self-consistency check the owner's flush runs before trusting it |
| `src/sha256-resumable.ts` | SHA-256 with a serialisable running state, so the segment manifest hashes only appended bytes |
| `src/sync.ts` | peer status, the ambient hook, `--from`, `--repair` |
| `src/file-lock.ts` | cross-process advisory lock through atomic `fs.mkdir` |
| `src/fleet-hazards.ts` | mixed-fleet checks: DB inside `MU_SYNC_DIR`, network mount, case collisions |
| `src/dormant.ts` | doctor housekeeping: `finished` (all closed, idle 14 days) vs `abandoned` (idle 60 days, open tasks) workstreams; idle derived from `MAX(tasks.updated_at)` |
| `src/disk-recon.ts` | report-only state-dir vs DB reconciliation (rows without dirs, dirs without rows, residue); `--disk` measures bytes |
| `src/doctor-summary.ts` | cheap doctor slice for the TUI; ctl, extension and skill checks; remediation text |

### Agents, multiplexer and control socket

| Module | Responsibility |
| --- | --- |
| `src/agents.ts` | CRUD, send, read, list, close, liveness, reaper; `composeAgentTitle` |
| `src/agents/spawn.ts` | spawn: CLI resolution, pane create or reuse, liveness, readiness, ctl handshake, rollback |
| `src/agents/spawn-lock.ts` | per-session lock around topology and row insert |
| `src/agents/transport.ts` | send routing: ctl for pi agents, mux paste otherwise, no fallback; `expectsCtl` |
| `src/agents/abort.ts` | stop a pi turn through the control socket; abort + send (`--interrupt`) |
| `src/agents/delegate.ts` | `delegateOutcome`: one wait result to `done` / `empty` / `error` / `died` / `timeout` / `pending` |
| `src/agents/wait.ts` | block until task-less agents leave `busy` |
| `src/agents/adopt.ts` | register an existing pane as an agent |
| `src/agents/kick.ts` | `mu agent kick`: signal a wedged pane's foreground process group |
| `src/agents/errors.ts` | typed agent errors |
| `src/agent-state.ts` | runtime state from ctl, herdr or murmur; `unknown` with a reason |
| `src/reconcile.ts` | ghost prune and orphan surfacing |
| `src/mux/index.ts` | cluster barrel that `src/mux.ts` re-exports |
| `src/mux/types.ts` | `MuxBackend` interface; `MuxError`, `PaneNotFoundError`, `NoMultiplexerError` |
| `src/mux/detect.ts` | `MU_MUX` → `HERDR_ENV` → `$TMUX` → `PATH` ladder; `activeMux()` |
| `src/mux/tmux.ts` | tmux backend: the `tmux()` wrapper, bracketed-paste send, pane validation |
| `src/mux/herdr.ts` | herdr backend: JSON socket API, atomic send, native pane status, `startAgentInPane` |
| `src/mux/input-timing.ts` | when tmux paste input can be submitted; not a state source |
| `src/tmux.ts` | tmux-only re-exports: `MU_TMUX_SOCKET` seam, `sleep` / `setSleepForTests` |
| `src/ctl/path.ts` | `ctlSocketPath`, `remoteCtlSocketPath`, `MU_CTL_SOCK` |
| `src/ctl/protocol.ts` | protocol v1 types, `CTL_OPS`, line framing; imports nothing from mu |
| `src/ctl/client.ts` | `ctlRequest`, `ctlProbe`, version and unknown-op errors |
| `extension/mu-pi.ts` | pi extension, child side: serves `$MU_CTL_SOCK`; built to `dist/extension/mu-pi.js` |
| `extension/delegate.ts` | pi extension, parent side: `mu_delegate` / `mu_delegate_cancel`, which shell out to `mu` |
| `extension/nudge.ts` | pi extension: the keep-driving nudge. Arms on a `mu` dispatch, checks `mu state --json` at `agent_before_settle`, injects the SKILL.md rule once per prompt, logs `--kind nudge`. Also the close nudge (worker settles owning a task) and the refute nudge (`task claim --for` on a task with no refute decision in `mu task notes --json`; one notice, no continuation). `parallelSettle` runs the three settle checks in parallel behind one `agent_before_settle` handler and merges their entries; `mu log` breadcrumbs are not awaited |
| `src/link.ts` | `mu link pi`: extension shim, skill symlink, `inspectLinks` for doctor |

### Tasks, workspaces and workstreams

| Module | Responsibility |
| --- | --- |
| `src/tasks/core.ts`, `id.ts` | row shapes, id resolution, qualified ids |
| `src/tasks/queries.ts`, `sort.ts` | list, next, owned-by; ROI, recency, age and id sorts |
| `src/tasks/edit.ts`, `edges.ts` | add and edit; block, unblock, reparent, delete with cycle check |
| `src/tasks/claim.ts` | atomic claim and release; `resolveWorkerIdentity` |
| `src/tasks/lifecycle.ts`, `status.ts` | close, open and cascade; `TaskStatus` |
| `src/tasks/wait.ts`, `errors.ts` | `waitForTasks`; typed task errors |
| `src/tracks.ts` | union-find tracks with diamond merge |
| `src/dag.ts` | `loadFullDag`, `renderForest`, `renderTaskTree` for `mu task tree` and the DAG popup |
| `src/workstream.ts` | ensure, list, summarize, destroy |
| `src/vcs/*.ts` | `VcsBackend` with git, jj, sl and none; detection `jj` → `sl` → `git` → none |
| `src/workspace/*.ts` | per-agent workspace registry: CRUD, staleness and dirty decoration, orphans |
| `src/staleness.ts` | `WORKSPACE_STALE_THRESHOLD` and `isWorkspaceStale` |
| `src/project-root.ts` | `detectProjectRoot` for the TUI launch ladder |
| `src/state.ts` | `mu state` seam: fast SQL tier, slow subprocess tier, merge; parses `REMOTE:` notes |

### CLI, output and packaging

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | the `mu` bin (`dist/cli.js`): enables the compile cache, then `import()`s `src/cli.ts` |
| `src/compile-cache.ts`, `src/state-dir.ts` | best-effort V8 compile cache under `<state>/compile-cache`; builtins-only state-dir resolution |
| `src/cli.ts` | Commander wiring (`buildProgram`, `runCli`) |
| `src/cli/*.ts` | one file per verb namespace, thin wrappers over the SDK; `format.ts` renders tables, `handle.ts` maps errors to exit codes and runs ambient sync |
| `src/cli/tasks/*.ts` | the `mu task` namespace, including `mu me tasks` / `mu me next` |
| `src/cli/dispatch-hints.ts` | dispatch-time `Next:` hints for pi agents (`--fresh`, `--interrupt`, abort) |
| `src/cli/stdin.ts` | `-` as a text argument: reads note / send text from stdin (heredoc prose) |
| `src/cli/agents-remote.ts` | `mu agent remote-env`: prints the ssh forward and env, runs nothing |
| `src/cli/tui-launch-focus.ts` | initial-tab focus ladder for bare `mu` and `mu state --tui` |
| `src/cli/tui-load.ts` | lazy `import()` of the TUI with `NODE_ENV` defaulted to `production` (React prod build) |
| `src/cli/tui/` | the ink TUI; the only place ink and react are imported |
| `src/cli/tui/sync-worker.ts` | worker_thread (`dist/tui-sync-worker.js`) running the TUI's slow-tick sync pass off ink's thread |
| `src/output.ts`, `src/shell-quote.ts` | `printNextSteps` / `errorNextSteps`; POSIX quoting for hints |
| `src/glyphs.ts` | the one glyph vocabulary (single-cell Nerd Font codepoints) |
| `src/index.ts` | SDK entry point |
| `skills/mu/` | the skill loaded into an agent's context; `mu --help` owns the verb reference |
| `scripts/migrate.ts` | retained migration sidecar ([scripts/README.md](../scripts/README.md)) |
| `scripts/check-doc-links.mjs` | relative-link and anchor checker for every markdown file, run by `test/doc-links.test.ts` |
| `test/` | vitest suites; `*.integration.test.ts` touch real tmux, herdr or VCS ([sdk.md § Testing layers](architecture/sdk.md#testing-layers)) |

## Key seams

A new implementation of each is small.

| Seam | Add one by |
| --- | --- |
| `MuxBackend` | implementing the interface in `src/mux/`; a backend without an equivalent no-ops, and a backend-only feature is an optional method callers test for |
| `VcsBackend` | implementing `detect`, `createWorkspace`, `freeWorkspace`, `isClean`, `commitsBehind`, `rebaseTo`, `commitsSinceBase`, `recentCommits`, `showCommit` (about 80-150 LOC) |
| typed verb | an SDK function; a `cmd<Verb>` in `src/cli/<namespace>.ts`; one Commander block in `buildProgram()` wrapped in `handle()` and routed through `printNextSteps` |
| schema change | bump `CURRENT_SCHEMA_VERSION` in `src/db.ts` and mirror `CURRENT_SCHEMA`; startup stays migration-free ([scripts/README.md](../scripts/README.md)) |
| syncable field | add the column to a portable table, extend the UPDATE trigger's changed-column comparison, confirm apply writes it; a full-row payload regresses merge to row-level LWW |
| cross-machine sync | nothing: every invocation already flushes and ingests |
