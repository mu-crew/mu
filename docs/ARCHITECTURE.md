# Architecture

mu is one SQLite file, a crew of agents in multiplexer panes, a task
DAG, and one append-only op log that everything else derives from.
Callers sit on top, a shared TypeScript core in the middle, and SQLite,
the multiplexer and git at the base. The CLI verbs and the SDK are
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
│  agents/ mux/ ctl/ · tasks/ tracks · worktree · ops log         │
│  (capture, apply, sync, drift)                                  │
└───────────────┬──────────────────┬──────────────────┬───────────┘
                ▼                  ▼                  ▼
   SQLite (~/.local/state/mu/mu.db) · tmux/herdr panes · git worktrees
                   pi agents: control socket per agent
```

## Subsystems

**The ops log.** Every write to a portable table (`workstreams`,
`tasks`, `task_edges`, `task_notes`) is recorded as an op by a SQLite
trigger in the same transaction. The tables are the materialized view
reads hit; the log is the record. History (`mu log`), sync,
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
pasting. Remote agents (`spawn --host`) use a socket forward their
host profile's shell template carries. Non-pi agents are sent to only on herdr
([architecture/control-socket.md](architecture/control-socket.md#no-silent-fallback)).

**Sync.** With `MU_SYNC_DIR` set, every `mu` invocation ingests peer
JSONL segments before the verb and flushes its own ops after it,
through `handle()`. There is no daemon and no network code:
[architecture/sync.md](architecture/sync.md).

**Dashboard.** The 3.x card TUI is removed and bare `mu` prints help. The planned four-tab, read-only dashboard is a fresh write (`v_dashboard_*`); see [Planned](#planned-owned-by-v_).

**CLI and SDK surface.** Each operation is a typed SDK function plus a
thin Commander wrapper. Public functions take operator-facing names and
resolve them to surrogate ids exactly once. Typed errors map to exit
codes 0-7. The same page covers testing layers and packaging:
[architecture/sdk.md](architecture/sdk.md).

## Module map

`src/` is flat at the root, with one level of cohesive clusters.
Cluster files import from neighbours and root modules, never from the
hub that re-exports them. `src/tasks.ts`, `src/agents.ts` and `src/mux.ts`
are re-export hubs.

### Storage and the ops log

| Module | Responsibility |
| --- | --- |
| `src/db.ts` | better-sqlite3 connection (WAL); schema 13: `upgradeSchema` brings a new or v12 file current in ONE transaction (DDL, `ADDED_COLUMNS`, schema stamp, capture triggers and capture stamp together; both stamps re-read under the lock); 23 tables (`schema_version`, `machine_identity`, `op_ctx`, `op_dying`, `ops`, `workstreams`, `agents`, `worktrees`, `tasks`, `task_edges`, `task_notes`, `task_substates`, `task_auto`, `sync_peers`, `sync_fingerprints`, and the machine-local `delegate_calls`, `wait_cursors`, `agent_settles`, `host_profiles`, `host_channels`, `spawn_receipts`, `human_needs`, `wait_registrations`) and 4 views (`ready`, `blocked`, `blockers`, `goals`); owns `TASK_KINDS`; `SqliteTooOldError` below 3.42; owns `SYNCED_ENTITIES`, `PORTABLE_TABLES`, `MACHINE_LOCAL_TABLES`; `migrateLegacyWorkspaces` carries rows of the dropped `vcs_workspaces` table into `worktrees`; refuses older (`SchemaTooOldError`) or newer (`SchemaTooNewError`) DBs, exit 4 |
| `src/compare.ts` | code-unit string compare; replaces `localeCompare` so ICU is never initialised |
| `src/hlc.ts` | hybrid logical clock, serialized as sortable TEXT |
| `src/capture.ts` | Triggers stored in the DB file (versioned by `capture_version`) recording each portable write as an op, refusing natural-key changes and explicit ids <= 0 or above 2^53-1; `installCapture` (own transaction) and `installCaptureLocked` (inside the caller's, used by `upgradeSchema`); `captureDoctorCheck` |
| `src/op-context.ts` | `withOpContext` (intent, actor, group) and the `withCaptureSuppressed` echo guard; both own the transaction around the `op_ctx` row |
| `src/fold.ts` | the one definition of a portable row: pure per-key folds of the ops log (horizon, per-field LWW including `kind` and `wave`, substate, notes, edges) |
| `src/apply.ts` | apply one op: re-fold the keys it touches and make their rows equal the fold; `projectLog` folds every key |
| `src/human-needed.ts`, `src/cli/human-needed.ts` | `recordHumanNeeded` / `openHumanNeeds`: a `human` task (OPEN/parked, brief = reason) plus the machine-local `human_needs(task_id, caller)` row in one transaction; `mu human-needed <reason>`. `HumanTaskError` (tasks/errors.ts) refuses unpark, claim and the CLOSE block on such a task |
| `src/wait-registration.ts` | `wait_registrations`: `registerOwnedWait` (typed refs that exist now, checked in its transaction; merged and deduped), `beginWait`/`endWait` (one active wait per caller: generation compare-and-set, delivered refs only removed); every write one short transaction, never across an await; never touches `wait_cursors` |
| `src/rebuild.ts` | copy the whole log into a new DB file, then `projectLog` it |
| `src/compact.ts` | `mu db compact` (blank redundant note-tombstone payloads) and `mu db forget` (drop a torn-down workstream's ops); this machine only |
| `src/drift.ts` | cheap invariant (every row has an op) and `--deep` rebuild-diff |
| `src/logs.ts` | typed reader over `ops`; `appendLog` and `emitEvent`, the writes triggers cannot cover |
| `src/log-render.ts` | the one op-to-prose formatter (`renderOp`), shared by the CLI renderers |

### Sync and doctor checks

| Module | Responsibility |
| --- | --- |
| `src/segments.ts` | JSONL segments: flush own ops, ingest peers from a watermark |
| `src/segment-line.ts` | the segment line: per-line version rules (`SEGMENT_FORMAT_VERSION`, `SEGMENT_READ_VERSIONS`), crc framing, encode and decode |
| `src/segment-manifest.ts` | segment `.manifest` sidecar: read, write, seal, and the self-consistency check the owner's flush runs before trusting it |
| `src/segment-resume.ts` | byte offset + running sha256 saved with a peer's caught-up fingerprint, so ingest reads only appended bytes |
| `src/sha256-resumable.ts` | SHA-256 with a serialisable running state, so the segment manifest hashes only appended bytes |
| `src/sync.ts` | peer status, the ambient hook, `--from`, `--repair` |
| `src/file-lock.ts` | cross-process advisory lock through atomic `fs.mkdir`; `strict` publishes whole by rename, reclaims a dead holder's lock under an O_EXCL claim, fails closed; release by token |
| `src/fleet-hazards.ts` | mixed-fleet checks: DB inside `MU_SYNC_DIR` (plus `DbInsideSyncDirError`, which `handle()` throws before `openDb`), network mount, case collisions, own segment written by a newer mu |
| `src/dormant.ts` | doctor housekeeping: `finished` (all closed, idle 14 days) vs `abandoned` (idle 60 days, open tasks) workstreams; idle derived from `MAX(tasks.updated_at)` |
| `src/disk-recon.ts` | report-only state-dir vs DB reconciliation (rows without dirs, dirs without rows, residue); `--disk` measures bytes |
| `src/doctor-summary.ts` | cheap doctor slice for `mu state`; ctl, extension and skill checks; remediation text |

### Agents, multiplexer and control socket

| Module | Responsibility |
| --- | --- |
| `src/agents.ts` | CRUD (incarnation CAS), send, read, list, liveness, reaper; hub re-exporting close |
| `src/agents/spawn.ts` | spawn: CLI resolution, `mux.spawnAgent`, liveness, readiness, ctl handshake, rollback |
| `src/agents/spawn-lock.ts` | per-session lock around topology and row insert |
| `src/agents/lock.ts` | per-agent lock (`withAgentLock`): fail-closed and strict; taken by close and `--worktree` staging/rollback; `withSpawnAttemptLock`: the same strict lock per (task, attempt key) |
| `src/agents/receipts.ts` | `spawn_receipts` storage: reserve, patch, reset, read (pure SQL) |
| `src/agents/task-spawn.ts` | `spawnForTask`: `agent spawn --task` as one journaled attempt: reserve, spawn (identity journaled in the spawn lock), claim for that registry id, send with the reserved msgId, pin the brief; unsent failures roll back only their own resources, unknown delivery keeps pane and claim; replay never resends |
| `src/agents/close.ts` | `previewClose`, `closeAgent`: preview, `--if` fence, replacement check, incarnation CAS on the delete |
| `src/agent-output.ts` | the agent `--json` boundary (pure): `agentToOutput`, `liveAgentToOutput`, `closePreviewToOutput`. SQL column names, `id` = the registry incarnation, real `workstream_id`; live facts snake_cased and only when read. The CLI maps; `AgentRow` stays camelCase |
| `src/agents/transport.ts` | send routing: ctl for pi agents; herdr `sendToPane` for others; tmux refuses (`AgentSendUnsupportedError`); no fallback; `expectsCtl` |
| `src/agents/abort.ts` | stop a pi turn through the control socket; abort + send (`--interrupt`) |
| `src/agents/delegate.ts` | `delegateOutcome`: one wait result to `done` / `empty` / `error` / `died` / `timeout` / `pending` |
| `src/agents/wait.ts` | block until task-less agents leave `busy` |
| `src/agents/observe.ts` | `AgentObservation`: the one typed read of an agent (registry id + pane, ctl incarnation, settled run count, `settled`, text + `lastTextTruncated`, pending, source/since, session file); `observeAgentStates` (one `readAgentStates` pass), `watchAgentRun` (the ctl probe + `wait` + drop fallback `mu agent wait` uses), `settledCloseInput` (the `applySettledClose` input, undefined unless ctl-settled), `toStatusSnapshot`. A seam, not a second poll loop |
| `src/agents/errors.ts` | typed agent errors |
| `src/exec-file.ts` | `execFileCapture` (+ `execGroupCapture`: own process group, reaped before it settles): child_process runner shared by the tmux, herdr and murmur executors (no execa) |
| `src/agent-state.ts` | runtime state from ctl, herdr or murmur; `unknown` with a reason |
| `src/reconcile.ts` | ghost prune and orphan surfacing |
| `src/mux/index.ts` | cluster barrel that `src/mux.ts` re-exports |
| `src/mux/types.ts` | `MuxBackend` interface (`ensureSession`, `spawnAgent`, `listPanes`, `paneAlive`, `capture`, `attachCommands`), `attachShellLine`; `MuxError`, `PaneNotFoundError`, `NoMultiplexerError` |
| `src/mux/detect.ts` | `MU_MUX` → `HERDR_ENV` → `$TMUX` → `PATH` ladder; `activeMux()` |
| `src/mux/tmux.ts` | tmux backend: the `tmux()` wrapper, one-step `spawnAgent`, pane validation; no send |
| `src/mux/herdr.ts` | herdr backend: JSON socket API, atomic send, native pane status, `spawnAgent` (bare pane, `agent start`) |
| `src/tmux.ts` | tmux-only re-exports: `MU_TMUX_SOCKET` seam, `sleep` / `setSleepForTests` |
| `src/ctl/path.ts` | `ctlSocketPath`, `remoteCtlSocketPath`, `MU_CTL_SOCK` |
| `src/ctl/protocol.ts` | protocol v1 types, `CTL_OPS`, line framing; imports nothing from mu |
| `src/ctl/client.ts` | `ctlRequest`, `ctlProbe`, version and unknown-op errors |
| `extension/mu-pi.ts` | pi extension, child side: serves `$MU_CTL_SOCK`; built to `dist/extension/mu-pi.js` |
| `extension/delegate.ts` | pi extension, parent side: `mu_delegate` / `mu_delegate_cancel`, which shell out to `mu` |
| `extension/nudge.ts` | pi extension: the keep-driving nudge. Arms on a `mu` dispatch, checks `mu task list --status IN_PROGRESS --json` at `agent_before_settle`, injects the SKILL.md rule once per prompt, logs `--kind nudge`. Also the close nudge (worker settles owning a task). `parallelSettle` runs the two settle checks in parallel behind one `agent_before_settle` handler and merges their entries; `mu log` breadcrumbs are not awaited |
| `src/pi-migrate.ts`, `src/pi-known-skills.ts`, `src/cli/pi.ts` | `mu pi migrate`: move the old link-pi shim and skill link aside, only when ownership is proven (byte-exact generated shim template, link into this install, released-skill digest). pi loads mu as a package: `package.json` `pi` manifest |

### Tasks, worktrees and workstreams

| Module | Responsibility |
| --- | --- |
| `src/tasks/core.ts`, `id.ts` | row shapes, id resolution, qualified ids |
| `src/tasks/queries.ts`, `sort.ts` | list, next, owned-by; `selectTaskNotes` (default notes view), `listNotes` (full history); ROI, recency, age and id sorts |
| `src/tasks/edit.ts`, `edges.ts` | add and edit; block, unblock, reparent, delete with cycle check |
| `src/task-auto.ts` | `mu task auto`: `authorizeTasks` (one op-context transaction: local `task_auto` row + synced `dispatch_host`), `autoPermitted`, `authorisedReady`, `openBlockersClosure`; never DELETEs a `task_auto` row |
| `src/tasks/claim.ts` | atomic claim and release; `resolveWorkerIdentity` |
| `src/tasks/lifecycle.ts`, `status.ts` | close, open and cascade; `TaskStatus` |
| `src/tasks/wait.ts`, `errors.ts` | `waitForTasks`; typed task errors |
| `src/tracks.ts` | union-find tracks with diamond merge |
| `src/dag.ts` | `loadFullDag` (the whole workstream, SDK), `loadOpenTaskFrontier` (the bounded open DAG: open tasks expand, CLOSED are leaves, depth and node caps, one SQL read per level; the future dashboard reads the same query), `renderForest`, `renderTaskTree`, `renderFrontierLines` |
| `src/workstream-scope.ts` | the one never-trimming validator for a workstream name typed as scope (`-w`, a ref prefix, a record's `workstream`); shared by the CLI and the pi extension |
| `src/revision.ts` | task revision (`taskRevision`: derived on read from the task row, owner, both edge directions and note count; no counter, no LIKE), `agentRevision` (derived from the agent incarnation, row, owned tasks and worktree rows), `RevisionMismatchError`, `withTaskFence` (one `--if` check around a whole invocation) |
| `src/workstream.ts` | ensure, list, summarize, revision, soft teardown, reuse of a torn-down name |
| `src/vcs/git.ts` | git primitives (plain functions, git only): toplevel, `worktree add --detach` / remove, dirty files, the upstream ref set, `isAncestor`, `createBranch` |
| `src/worktree.ts` | per-agent worktrees: `createWorktree`, `removeWorktree`, `worktreeState`, the machine-local `worktrees` registry (outlives the agent; the reaper never touches it), the one close rule (`releaseWorktree`), name reuse (`reclaimWorktreePath`); `WorktreeDirtyError`, `WorktreePathNotEmptyError`, `WorktreeVcsRequiredError` |
| `src/state.ts` | `mu state` seam: fast SQL tier, slow mux tier, merge; parses `REMOTE:` notes |

### CLI, output and packaging

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | the `mu` bin (`dist/cli.js`): enables the compile cache, then `import()`s `src/cli.ts` |
| `src/compile-cache.ts`, `src/state-dir.ts` | best-effort V8 compile cache under `<state>/compile-cache`; builtins-only state-dir resolution |
| `src/cli.ts` | Commander wiring (`buildProgram`, `runCli`) |
| `src/cli/*.ts` | one file per verb namespace, thin wrappers over the SDK; `format.ts` renders tables, `handle.ts` maps errors to exit codes and runs ambient sync |
| `src/cli/tasks/*.ts` | the `mu task` namespace, including `mu me tasks` / `mu me next`. `records.ts` is the task read boundary: `taskToOutput` (SQL column names, `id` = `local_id`, real `workstream_id`/`owner_id`), `taskRecordCut`/`taskItemCut` (one escaped line <= 400 characters, `cut=N` for what it clipped), `taskPage`/`pageRecords`/`footerLine` (a result serialized and grown to <= 4 KB; the `more=N cut=N next=<same command> --all` footer is reserved first and never sliced); `list`, `next`, `owned-by`, `show` and `tree` all go through it. `mu state` and `mu me` keep the table formatter |
| `src/cli/db-query.ts` | `mu db query` (alias `mu sql`) and `mu db --shell`. One op-context scope per write; `guardPragma` allows only read-only PRAGMAs before any compile; one `EXPLAIN` per statement (`checkStatement`) refuses transaction control (`AutoCommit`/`Savepoint`), ATTACH/DETACH, all DDL (a write to any `sqlite_master` root page, TEMP included) and any write to `op_ctx`/`op_dying`/`ops`/`schema_version`/`machine_identity`/`sync_peers` outside a main `_cap_*` trigger, a statement's own write to `sqlite_sequence`, and an UPDATE of `id`/`rowid` on the four guarded tables (a rowid-changing `Delete` with no table name); `installScopedViews` (TEMP `ready`/`blocked`/`blockers`); `teachColumnError`; output is JSON by default (`--table` for prose; `isSqlVerbArgv` in `src/output.ts` makes parse-time errors JSON too) and a read is `{items,count,more,retrieve?}` paged by `pageRecords` (min 0) over the final document bytes (`sqlRowsPayload`), `--all` whole. `src/cli/db.ts` keeps `backup`, `compact`, `forget` |
| `src/cli/dispatch-hints.ts` | dispatch-time `Next:` hints for pi agents (`--fresh`, `--interrupt`, abort) |
| `src/cli/stdin.ts` | `-` as a text argument: reads note / send text from stdin (heredoc prose) |
| `src/hosts.ts` | host profiles: the template grammar (`expandHostTemplate`, one pass, per-context quoting, whitelisted `{env}`, `{name:sh}` second layer), profile CRUD, `host_channels` admission (`reserveHostChannel` / `bindHostChannel` / `releaseHostChannel` by token, `withHostChannel`, transient vs attached), `admitHostChannel` (spawn reserves before its pane opens), `checkHost`. ssh-free: runs only the user's stored templates with `/bin/sh -c`, each as its own process group (`execGroupCapture`, reaped before its channel is released; the group id is recorded on the `host_channels` row so a dead caller cannot free a slot under a live transport) |
| `src/cli/host.ts` | the host verbs (add, list, show, rm, init, check) |
| `src/remote-agent.ts` | the remote half of `spawn --host`: `prepareRemote` (one `exec` makes a detached remote worktree or resolves the cwd, answer is a tagged line), `removeRemoteWorktree` (the spawn-rollback helper: clean and at its base only, `--force`), `closeRemoteWorktree` (the close rule: observe, apply, rename the tree aside, prove no process holds it via `/proc` or `lsof`, re-check HEAD and cleanliness, `worktree remove` without `--force`; `--keep-branch`), `remoteShellCommand` (the filled `shell` template as the local pane's command; five whitelisted identity vars) |
| `src/remote-collect.ts` | `collectRemoteAgent`: the `fetch` template run in the LOCAL repo under one channel, the fetched commit resolved from FETCH_HEAD (cleared first) and pinned under `refs/mu/collect/<ws>/<agent>`, `agents.collected_head` set by compare-and-set on id, pane, host, cwd and base |
| `src/cli/agent-collect.ts` | `mu agent collect` |
| `src/output-contract.ts` | the `--json` wire: `Envelope<T>` (`{ok,data,next}` / `{ok:false,error,message,next,exit}`), `NextPlan`, `encodeEnvelope`, `isEnvelope`, `capRecords`. Pure. `cli.ts` `emitJson` wraps every payload once; `handle.ts` `emitError` prints the one failure document on stdout; `emitJsonRow` is the raw NDJSON row (`mu log --tail`). `extension/delegate.ts` `parseEnvelope` reads it |
| `src/output.ts`, `src/shell-quote.ts` | `printNextSteps` / `errorNextSteps`; POSIX quoting for hints |
| `src/glyphs.ts` | the one glyph vocabulary (single-cell Nerd Font codepoints) |
| `src/index.ts` | SDK entry point |
| `skills/mu/` | the skill loaded into an agent's context; `mu --help` owns the verb reference |
| `scripts/check-doc-links.mjs` | relative-link and anchor checker for every markdown file, run by `test/doc-links.test.ts` |
| `test/` | vitest suites; `*.integration.test.ts` touch real tmux, herdr or VCS ([sdk.md § Testing layers](architecture/sdk.md#testing-layers)) |

## Planned (owned by `v_*`)

The rows above describe what ships. The mu-next surface (one unified wait verb,
delegates as tasks, `{ok,data,next}` output, task-bound spawn, executor,
hosts, dashboard, schema 13 additions) is not in this module map: a row
is added in the commit that adds the module. The planned module and
signature names, the unit that delivers each, and the current-versus-
planned boundary live in
[mu-next/surface-contract.md](mu-next/surface-contract.md).

## Key seams

A new implementation of each is small.

| Seam | Add one by |
| --- | --- |
| `MuxBackend` | implementing the interface in `src/mux/`; a backend without an equivalent no-ops, and a backend-only feature is an optional method callers test for |
| typed verb | an SDK function; a `cmd<Verb>` in `src/cli/<namespace>.ts`; one Commander block in `buildProgram()` wrapped in `handle()` and routed through `printNextSteps` |
| schema change | bump `CURRENT_SCHEMA_VERSION` in `src/db.ts` and mirror `CURRENT_SCHEMA`; startup stays migration-free |
| syncable field | add the column to a portable table, extend the UPDATE trigger's changed-column comparison, confirm apply writes it; a full-row payload regresses merge to row-level LWW |
| cross-machine sync | nothing: every invocation already flushes and ingests |
