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
   SQLite (~/.local/state/mu-next/mu.db) · tmux/herdr panes · git worktrees
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

**Dashboard.** The 3.x card TUI is removed. Bare `mu` on a TTY (not `--json`) opens the fresh read-only ink dashboard, a lazy chunk (`src/cli/tui/`) the SDK index never reaches; anywhere else it prints help. Projections run on a `readonly` connection; ambient sync runs on the launcher's separate writable connection, outside render. Five tabs (Overview, Tasks, DAG, Agents, Log) over a workstream row; Enter drills a row (notes, scrollback, one log op); `a` on an agent runs the mux's attach steps with Ink's terminal suspended, else opens the scrollback with the reason.

**CLI and SDK surface.** Each operation is a typed SDK function plus a
thin Commander wrapper. Public functions take operator-facing names and
resolve them to surrogate ids exactly once. Typed errors map to exit
codes 0-7; a wait or a stream adds 130/143 on a signal. The same page covers testing layers and packaging:
[architecture/sdk.md](architecture/sdk.md).

## Module map

`src/` is flat at the root, with one level of cohesive clusters.
Cluster files import from neighbours and root modules, never from the
hub that re-exports them. `src/tasks.ts`, `src/agents.ts` and `src/mux.ts`
are re-export hubs.

### Storage and the ops log

| Module | Responsibility |
| --- | --- |
| `src/db.ts` | better-sqlite3 connection (WAL); schema 13: `upgradeSchema` brings a new or incomplete v13 file current in ONE transaction (DDL, `ADDED_COLUMNS`, schema stamp, capture triggers and capture stamp together; both stamps re-read under the lock); 27 tables (`schema_version`, `machine_identity`, `op_ctx`, `op_dying`, `ops`, `workstreams`, `agents`, `worktrees`, `tasks`, `task_edges`, `task_notes`, `task_substates`, `task_auto`, `sync_peers`, `sync_fingerprints`, and the machine-local `delegate_calls`, `wait_cursors`, `agent_settles`, `host_profiles`, `host_channels`, `spawn_receipts`, `human_needs`, `wait_registrations`, `wait_action_receipts`, `wait_resumes`, `remote_recovery`, `carrier_jobs`) and 4 views (`ready`, `blocked`, `blockers`, `goals`); owns `TASK_KINDS`; `SqliteTooOldError` below 3.42; owns `SYNCED_ENTITIES`, `PORTABLE_TABLES`, `MACHINE_LOCAL_TABLES`; refuses older (`SchemaTooOldError`) or newer (`SchemaTooNewError`) DBs, exit 4 |
| `src/compare.ts` | code-unit string compare; replaces `localeCompare` so ICU is never initialised |
| `src/hlc.ts` | hybrid logical clock, serialized as sortable TEXT |
| `src/capture.ts` | Triggers stored in the DB file (versioned by `capture_version`) recording each portable write as an op, refusing natural-key changes and explicit ids <= 0 or above 2^53-1; `installCapture` (own transaction) and `installCaptureLocked` (inside the caller's, used by `upgradeSchema`); `captureDoctorCheck` |
| `src/op-context.ts` | `withOpContext` (intent, actor, group) and the `withCaptureSuppressed` echo guard; both own the transaction around the `op_ctx` row |
| `src/fold.ts` | the one definition of a portable row: pure per-key folds of the ops log (horizon, per-field LWW including `kind` and `wave`, substate, notes, edges) |
| `src/apply.ts` | apply one op: re-fold the keys it touches and make their rows equal the fold; `projectLog` folds every key |
| `src/human-needed.ts`, `src/cli/human-needed.ts` | `recordHumanNeeded` / `openHumanNeeds`: a `human` task (OPEN/parked, brief = reason) plus the machine-local `human_needs(task_id, caller)` row in one transaction; `mu human-needed <reason>`. `HumanTaskError` (tasks/errors.ts) refuses unpark, claim and the CLOSE block on such a task |
| `src/wait-actions.ts`, `src/wait-action-receipts.ts` | stall actions of a wait (`handleStall` implementations). `releaseStall` / `releaseStallHandler`: the guarded release, every guard rechecked in the SAME immediate transaction as `releaseTask(expectedOwnerId, ifRevision)` (no await inside; a refusal writes nothing). `wait_action_receipts` storage: `reserveActionReceipt` (INSERT OR IGNORE on task, owner, incarnation, action), `transitionActionReceipt` (compare-and-set along legal edges only). Pure SQL. `steerStall` / `steerStallHandler`: the crash-safe steer: plan and reserve in one immediate transaction (the msgId is saved with the row), then ctl hello and incarnation bind, then the transport's `beforeWrite` fence re-runs every guard and CASes `reserved -> sending` in one synchronous immediate transaction: only the CAS winner writes. A row past `reserved` is only probed (`status {msgId}`, same registry id, pane and incarnation), never resent, never turned into a release. `waitWithActions`: `waitForEvents` plus the handler `onStall` names (a composition, not a loop) |
| `src/wait-registration.ts` | `wait_registrations`: `registerOwnedWait` (typed refs that exist now, checked in its transaction; merged and deduped), `beginWait`/`endWait` (one active wait per caller: generation compare-and-set, delivered refs and their baselines only removed), per-agent-ref unconsumed baselines (`baselines_json`); `dropOwnedRefs`/`callersOwing` for the done-agent drop; every write one short transaction, never across an await; writes `wait_cursors` only to clear a DONE mark (new work armed, ref dropped), never a consumed token |
| `src/wait.ts` | `waitForEvents`: the ONE wait loop (tasks, agents, delegates, the caller's registration; with no ref it also discovers what the caller spawned, by `agents.spawner`, and registers it with a zero run baseline; `scope` narrows what is owned to one workstream; `onStall: warn` flags and goes on). Each iteration: `beforePoll`, bounded `ambientIngest`, DB reads, one batched agent read, CLOSE application, pick; then races an agent ctl watch, the poll sleep, abort and the deadline (every await raced, no transaction across one). first/all, urgent events, engine-owned stall detection with a raced `handleStall`, the callers SET (union of owned refs, delegates, human needs), typed cursor delivery in one transaction guarded by each caller's registration generation, flush on return. There is no other wait code: `mu task wait`, `mu agent wait` and `mu wait` all call it (`setWaitSleepForTests` is its sleep seam) |
| `src/wait-types.ts` | the types and errors of `waitForEvents`: `WaitRef`, `WaitEvent`, `WaitSnapshot`, `WaitResult`, `WaitOptions`, `AgentReading`, `AgentWatchHandle`, `WaitStallContext`, `StallActionResult`, `AgentBaseline`, `WaitNothingError`, `WaitRefError`, `WAIT_HEARTBEAT_CAP_MS` |
| `src/wait-callers.ts` | `currentCallers`: the managed `<ws>/<agent>` and `pi:<session>` of this process, from env, never a guess |
| `src/wait-cursor.ts` | `wait_cursors` access: typed keys (`<kind>:<ws>/<id>`, and `input|`, `dead|`, `stall|`, `open|` + key for urgent observations and blockers seen open), completion tokens, monotonic `recordCursors`, `isConsumed`, `logStallOnce` (one `agent.stall` op per task and owner (row, incarnation, runs): a `stall-log|` mark under a reserved caller) |
| `src/wait-item.ts` | the wait loop's `Item` (what one watched ref can deliver now) and the pure helpers that need none of the loop's state: `refKey`, `urgency`, `exitFor`, `inputToken`, `agentSnapshot`, `delegateItem`, `sameDeath` (a dead task and its dead owner are one event), `failedGate`, `snapshotsOf` |
| `src/wait-latch.ts` | the settled latch of a waited agent: `AgentTrack`, `supersededBy` (THE rule: a latch is valid only for the exact agentId + incarnation + runs it captured; another identity rewatches from run 0, a later run from the latched run), `rearmLatch` (the one way a latch is dropped) |
| `src/wait-db.ts` | the engine's loop-free DB helpers: `closeSettledRun` (applies a settled run's CLOSE, never throws), `agentExists`, `openBlockers` (uncapped transitive open blockers) |
| `src/wait-owed.ts` | when an owned agent ref is still owed a wait and when it is done: `agentOwed` (a reading + open/closed task counts + the run fence -> owed / done / unsure), the DONE mark (`setAgentDone`, `hasDoneMark`: a `done\|agent:<ws>/<name>` row in `wait_cursors`) that the engine keeps true each tick and `agent close` sets, `runInFlight`. A registered agent whose row is gone and which is marked done is dropped, never `dead` |
| `src/wait-ctl.ts` | `ctlAgentHooks`: the default `readAgents` (one `readAgentStates` pass) and `watchAgent` (`watchAgentRun`; counts a registered ref, explicit or owned, from max(fence, same-process cursor), else from the probed run count (`unknownBaseline`)) |
| `src/cli/wait.ts` | `mu wait` (`wireWaitCommand`, `cmdWait`) and the core `mu task wait` shares (`runWait`, `parseWaitRef`, `installWaitSignals`). SIGINT/SIGTERM listeners are installed before the DB opens and aborted into the engine's final snapshot; the result is emitted once, then the exit follows (`CliExitError`, drained by `handle`). Typed refs only (a bare word is refused); `--first` default, `--all`, `--until-text`, `--status`, `--stuck-after`, `--on-stall exit\|warn\|steer\|release` (`runWait` calls `waitWithActions`; the handler is wrapped to print one stderr line naming what was done), `--wave`, `--blockers-of`, `--timeout` (default and cap 1500 s). One stderr heartbeat a minute; stdout is exactly one envelope. `beforePoll` runs the one `reconcile` per workstream that has agents; a DB-only wait never opens a mux |
| `src/cli/wait-arm.ts` | producer arming: `armWait` (registers under `currentCallers()[0]`, never throws: a refusal is a warning), `armSend` (a delivered prompt: the agent ref fenced by the measured runs + incarnation + registry id; mux sends unfenced; a ctl send with no runs arms only the extra refs), `agentRef`, `taskRef`. Called by `cmdSpawn`, `cmdSpawnTask`, `cmdSend`, `cmdSendInterrupt`, `cmdClaim`; `send --wait` and `claim --and-wait` then call `runWait` with the receipt as `extraData` |
| `src/cli/wait-output.ts` | the wait's one JSON `data`: `firing` (= `event`), `exit`, `timedOut`, `interrupted`, `open`, `snapshots`, `tally` (+ `summary`), `cursor`, `resume` (the stored handle `mu wait --resume <id>`, or null with `resumeWhy`; `owedRefs` is what the handle must keep), bounded to 4096 FINAL bytes with `humanNeeds`/`warning` inside the bound: texts shrink first (tail kept, `lastTextCut`), then the needs, the tally's findings, and the snapshots (`pageRecords`, `snapshotsCut`, `retrieve`); firing, exit, resume and `open` never |
| `src/wait-resume.ts` | `wait_resumes` (machine-local): `saveResume` (one short transaction; rows older than 14 days go with the next save), `loadResume`, `WaitResumeNotFoundError`; the stored refs (run baseline and pi incarnation as last seen), mode, filters, deadline and callers behind `mu wait --resume <id>` |
| `src/wait-regex.ts` | the bounded `--until-text` regex: a grammar that refuses exponential shapes, an 8 KiB tail and a 50 ms `node:vm` budget; `WaitRegexError` |
| `src/rebuild.ts` | copy the whole log into a new DB file, then `projectLog` it |
| `src/compact.ts` | `mu db compact` (blank redundant note-tombstone payloads) and `mu db forget` (drop a torn-down workstream's ops); this machine only |
| `src/drift.ts` | cheap invariant (every row has an op) and `--deep` rebuild-diff |
| `src/logs.ts` | typed reader over `ops`; `appendLog` and `emitEvent`, the writes triggers cannot cover |
| `src/log-render.ts` | the one op-to-prose formatter (`renderOp`), shared by the CLI renderers; never clips free text; an unknown historical intent renders generically (`op put|del`, intent, kind, changed field names) |

### Sync and doctor checks

| Module | Responsibility |
| --- | --- |
| `src/segments.ts` | JSONL segments: flush own ops, ingest peers from a watermark |
| `src/sync-dir-guard.ts` | `assertSyncDirV2`: refuses a `MU_SYNC_DIR` holding a segment that opens with a v1 line or a manifest with `v` < 2 (a 3.x peer); called inside `flushSegment`/`discoverPeers`/`ingestSegment` and in `handle()`; `SyncDirForeignError`, exit 4 |
| `src/segment-line.ts` | the segment line: per-line version rules (`SEGMENT_FORMAT_VERSION`, `SEGMENT_READ_VERSIONS`), crc framing, encode and decode |
| `src/segment-manifest.ts` | segment `.manifest` sidecar: read, write, seal, and the self-consistency check the owner's flush runs before trusting it |
| `src/segment-resume.ts` | byte offset + running sha256 saved with a peer's caught-up fingerprint, so ingest reads only appended bytes |
| `src/sha256-resumable.ts` | SHA-256 with a serialisable running state, so the segment manifest hashes only appended bytes |
| `src/sync.ts` | peer status, the ambient hook, `--from`, `--repair` |
| `src/file-lock.ts` | cross-process advisory lock through atomic `fs.mkdir`; `strict` publishes whole by rename, reclaims a dead holder's lock under an O_EXCL claim, fails closed; release by token |
| `src/fleet-hazards.ts` | mixed-fleet checks: DB inside `MU_SYNC_DIR` (plus `DbInsideSyncDirError`, which `handle()` throws before `openDb`), network mount, case collisions, own segment written by a newer mu |
| `src/dormant.ts` | doctor housekeeping: `finished` (all closed, idle 14 days) vs `abandoned` (idle 60 days, open tasks) workstreams; idle derived from `MAX(tasks.updated_at)` |
| `src/disk-recon.ts` | report-only state-dir vs DB reconciliation (rows without dirs, dirs without rows, residue); `--disk` measures bytes |
| `src/cli/doctor.ts` | `mu doctor` (human and `--json`): environment, DB integrity, injected scope, per-workstream counts and report-only reconcile drift, disk reconciliation |
| `src/doctor-summary.ts` | `DoctorCheck` row shape; murmur, pi-extension and ctl-socket checks used by `mu doctor` |

### Agents, multiplexer and control socket

| Module | Responsibility |
| --- | --- |
| `src/agents.ts` | CRUD (incarnation CAS), send, read, list, liveness, reaper; hub re-exporting close |
| `src/agents/spawn.ts` | spawn: CLI resolution, `mux.spawnAgent`, row finalize, rollback; re-exports the readiness names so `agents/spawn.js` imports keep working |
| `src/agents/spawn-ready.ts` | spawn readiness: the ctl handshake (`awaitCtlHandshake`, its clock seam), the liveness window, the startup-error and Claude trust-dialog scan (`checkSpawnHealth`) |
| `src/agents/spawn-remote.ts` | the remote half of `spawn --host`: `requireHostSpawn`, channel admission + remote prepare (`admitRemoteSpawn`, `prestageRemote`), remote-worktree rollback; imports only types from `spawn.ts` |
| `src/agents/staging.ts` | dead `--worktree` stagings (a SIGKILLed spawn's placeholder row + unused worktree): `deadStagings` for doctor, `reclaimDeadStagings` at spawn |
| `src/agents/lease-carrier.ts` | the lease half of `spawn --host`: the name fence every spawn passes (`refuseReserved`), the `carrier_jobs` reservation taken under the agent lock before any effect (`reserveLeaseJob`), the job file claimed in the spawn lock (an earlier one moved aside), the job handshake (`awaitLeaseJob`, `MU_SPAWN_JOB_MS`, fills the reservation; reads fail closed), the stop-first rollback on the spawn's own reservation only (`rollbackLeaseJob`, `releaseLeaseReservation`), and the conservative empty-reservation resolution (`resolveEmptyReservation`: released only if never launched and its creator is gone, else `--abandon-job`); the close half: `stopLeaseReservation` (stop, fill from the job file, or refuse), `cleanLeaseJobFile`, `releaseLeaseClose` |
| `src/agents/spawn-lock.ts` | per-session lock around topology and row insert |
| `src/agents/lock.ts` | per-agent lock (`withAgentLock`): fail-closed and strict; taken by close, `--worktree` staging/rollback, a lease reservation, and every spawn from its name fence to its finalized row; `withSpawnAttemptLock`: the same strict lock per (task, attempt key) |
| `src/agents/reap.ts` | `reapAgentRow`: the one row-level reaper step, inside the caller's transaction and op group: record the remote worktree, DELETE the row, free its host channel, reopen what it owned with a `[reaper]` note. Used by `deleteAgent` and by teardown |
| `src/db-recovery.ts` | DDL only, spliced into `CURRENT_SCHEMA`: the `remote_recovery` table and its triggers (AFTER DELETE on `agents`, BEFORE DELETE on `workstreams` for the cascade): the database records a remote worktree whenever its row dies, however it is deleted |
| `src/db-carrier.ts` | DDL spliced into `CURRENT_SCHEMA`: the `carrier_jobs` reservation table and its `(workstream, name, ordinal)` unique index; plus the shape check and lossless `INSERT … SELECT` that `upgradeSchema` runs (in its one transaction) to rebuild the pre-reservation shape |
| `src/remote-recovery.ts` | `remote_recovery` reader and guards: `listRemoteRecoveries`, `selectRemoteRecovery` (sole record, or `--recovery`; several refuse), `assertRecoveryUsable` / `assertRecoveryProfile` / `assertRecoveryUnchanged`, CAS `deleteRemoteRecovery` / `setRecoveryCollectedHead`, `RemoteRecoveryRefusedError`. One row per original registry incarnation, no FK, no op; `mu rebuild` reports it lost |
| `src/agents/gate.ts` | remote command gates: `gateWrapper` (the `{cmd}` that runs the command and writes `MU_GATE <token> <rc>` atomically on the host), `readGate` (pane proven exited via `mux.paneResult`, channel freed by id + pane, then one bounded `exec` read; running / exited / dead / unknown), `cleanGateResult` (close removes only its token's files) |
| `src/agents/receipts.ts` | `spawn_receipts` storage: reserve, patch, reset, read (pure SQL) |
| `src/agents/task-spawn.ts` | `spawnForTask`: `agent spawn --task` as one journaled attempt (plus `spawnAutoAttempt`, the executor's guarded `auto:<n>` replay: reservation required, a failed key is never reset, permission re-checked before the pane and before the send): reserve, spawn (identity journaled in the spawn lock), claim for that registry id, send with the reserved msgId, pin the brief; unsent failures roll back only their own resources, unknown delivery keeps pane and claim; replay never resends |
| `src/agents/close.ts` | `previewClose`, `closeAgent`: preview, `--if` fence, replacement check, incarnation CAS on the delete; a lease agent's stop after the liveness proof (and before the tree), `--abandon-job`, and close-by-name of a reservation whose agent row is gone (a reservation kept for a tree is released only by that tree's close; the local ctl socket is unlinked); a lease row (`agents.host_transport`) with no reservation refuses |
| `src/agents/close-recovery.ts` | close of a removed agent's remote worktree: `recoveryPreview` (read only), `closeRecovery` (original aside, CAS before the removal, delete only that record) |
| `src/agent-output.ts` | the agent `--json` boundary (pure): `agentToOutput`, `liveAgentToOutput`, `closePreviewToOutput`. SQL column names, `id` = the registry incarnation, real `workstream_id`; live facts snake_cased and only when read. The CLI maps; `AgentRow` stays camelCase |
| `src/agents/transport.ts` | send routing: ctl for pi agents; herdr `sendToPane` for others; tmux refuses (`AgentSendUnsupportedError`); no fallback; `expectsCtl`; the opt-in `ctlGuard` (signal, timeout, `beforeWrite`) a stall steer uses, refused on a route that cannot honour it |
| `src/agents/abort.ts` | stop a pi turn through the control socket; abort + send (`--interrupt`) |
| `src/agents/delegate.ts` | `delegateOutcome`: one wait result to `done` / `empty` / `error` / `died` / `timeout` / `pending` |
| `src/agents/observe.ts` | `AgentObservation`: the one typed read of an agent (registry id + pane, ctl incarnation, settled run count, `settled`, text + `lastTextTruncated`, pending, source/since, session file); `observeAgentStates` (one `readAgentStates` pass), `watchAgentRun` (the ctl probe + `wait` + drop fallback `mu agent wait` uses), `settledCloseInput` (the `applySettledClose` input, undefined unless ctl-settled). A seam, not a second poll loop |
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
| `src/ctl/path.ts` | `ctlSocketPath`, `remoteCtlSocketPath`, `carrierJobFilePath` (`<state dir>/carrier/<ws>/<agent>.job`, hashed by the same bound), `MU_CTL_SOCK` |
| `src/ctl/protocol.ts` | protocol v1 types, `CTL_OPS`, line framing; imports nothing from mu |
| `src/ctl/client.ts` | `ctlRequest` (opt-in synchronous `beforeWrite` fence: `CtlWriteVetoedError`, nothing written; an abort after the write of a side-effecting op is `CtlDeliveryUnknownError`), `ctlProbe`, version and unknown-op errors |
| `extension/mu-pi.ts` | pi extension, child side: serves `$MU_CTL_SOCK`; built to `dist/extension/mu-pi.js` |
| `src/delegates.ts` | delegate calls as durable tasks: `registerDelegateCall` (kind=delegate task + brief + `delegate_calls` row, one transaction, idempotent per `call_id`), `markDelegate` (admission CAS, including the refused to queued reissue the live runtime makes), `finishDelegate` (the one recorder: verdict note, report, close, state in one op group; a failed record is `failed`, never `done`), `listDelegates`, `verdictTally`; typed `DelegateCallConflictError`, `DelegateStateError`, `DelegateNotFoundError`; `delegateSessionDir` / `delegateProcessDir` (each call's pi session paths beside the DB) |
| `src/delegate-prune.ts` | `mu delegates prune`: `planDelegatePrune` (closed delegate tasks past the age with this machine's call row, keeping ones with edges and refute checks of auto tasks), `pruneDelegates` (task rows deleted in one `delegate.prune` op group so tombstones sync, then their task/note puts deleted from `ops`, one transaction; after the commit, the pruned calls' pi session files and loose first-layout ones past the age), `checkOldDelegates` (doctor's `delegates-old` housekeeping row) |
| `src/delegate-verdict.ts` | `parseVerdict`, `recordNote`, `formatElapsed`: a delegate answer as a verdict. Pure and dependency-free, shared with the standalone extension |
| `src/delegate-process.ts` | the mux-free delegate runner: `runDelegateProcess` runs one `queued`/`starting` call in a child `pi --mode rpc` (ctl socket, log, session and an attempt receipt derived from the call id; send once with a stable msgId and expected incarnation; `unknown` is never resent; `workspace` through `src/worktree.ts`) and finishes it with `finishDelegate`. No pane, no agents row |
| `src/cli/delegates.ts` | `mu delegates` (list, show, tally, register, mark, finish, run; `reissue` refuses and names the tool) |
| `extension/delegate.ts` | pi extension, parent side: `mu_delegate` / `mu_delegate_reissue` / `mu_delegate_cancel`: admission (running, queued, refused), spawn through `agent spawn --task` (on `NoMultiplexerError` only: `mu delegates run <call-id>`, a child pi with no pane), the wait, the record (`mu delegates finish` before the pane closes) and the **wake**: answers no settle showed (`DelegateHandle.delivered`) get one pointer message when pi is idle, resent once if pi's queue loses it, dropped with a note on Escape; all state changes go through `mu delegates` |
| `extension/delegate-calls.ts` | the extension's wrappers over `mu delegates register / mark / finish / show` |
| `extension/delegate-format.ts`, `delegate-process-format.ts`, `delegate-args.ts`, `delegate-trace.ts`, `mu-run.ts` | pure wording of a gap's report, the wake and the dropped-wake note; the mux-free delegate's tool result and failure wording; label and model arguments; the `MU_DELEGATE_TRACE` log; the `mu` runner seam (per-call env, opt-in SIGTERM drain on abort) and envelope readers |
| `extension/nudge.ts` | pi extension: the keep-driving **settle wait** and the close nudge. Every completed `agent_before_settle` reads the caller identities' open human needs (`mu state --me`, one per identity) and runs `mu wait --first --on-stall exit --json` as this session (managed identity + `PI_SESSION_ID` through the runner's per-call env); an event continues the turn with the wait's result under the SKILL.md rule; a `delegate` event adds that call's report (`mu task notes`, capped, with a pointer), and one of a wave keeps waiting while siblings run, then shows ONE **wave summary** in place of the first wait's result (stale by then), keeping the waits' `notices`; a wait carrying a human need keeps its result. Esc, input, a dialog or shutdown aborts only that wait, which drains through SIGTERM. Holds (`input`, `wake`, `blocked`) skip a wait's start, never a consumed result's entries. Close nudge: a worker settles owning a task. `parallelSettle` runs the settle checks in parallel behind one handler and merges their entries (a consumed wait result survives a late hold); `mu log` breadcrumbs are not awaited |
| `src/pi-migrate.ts`, `src/pi-known-skills.ts`, `src/cli/pi.ts` | `mu pi migrate`: move the old link-pi shim and skill link aside, only when ownership is proven (byte-exact generated shim template, link into this install, released-skill digest). pi loads mu as a package: `package.json` `pi` manifest |

### Tasks, worktrees and workstreams

| Module | Responsibility |
| --- | --- |
| `src/tasks/core.ts`, `id.ts` | row shapes, id resolution, qualified ids |
| `src/tasks/queries.ts`, `sort.ts` | list, next, owned-by; `selectTaskNotes` (default notes view), `listNotes` (full history); ROI, recency, age and id sorts |
| `src/tasks/edit.ts`, `edges.ts` | add and edit; block, unblock, reparent, delete with cycle check |
| `src/task-auto.ts` | `mu task auto`: `authorizeTasks` (one op-context transaction: local `task_auto` row + synced `dispatch_host`), `autoPermitted`, `authorisedReady`, `openBlockersClosure`; never DELETEs a `task_auto` row |
| `src/auto-attempt.ts` | the executor's attempt accounting: `planAttempt` (read-only, also the dry run), `reserveAttempt` (charge one run + `task_auto.last_spawn` + `reserved` receipt `auto:<n>` in one immediate transaction that re-plans first), `reserveRetry` (charge a run and reserve an IN-PLACE retry of a live worker), `endAttempt` (terminal `abandoned` / `needs_human`), `pendingAttempts` (un-ended stored attempts to resume before anything new); `last_spawn` stores the exact prompt |
| `src/task-brief.ts` | `buildTaskBrief`: first brief verbatim + latest report + one task/CLOSE footer, the executor stores its text so a replay never rebuilds; `TaskBriefMissingError` |
| `src/edit-distance.ts` | `editDistance`: Levenshtein, for the did-you-mean hints (unknown verb, wrong column, unknown workstream). Leaf module. |
| `src/messages.ts` | the keyed message table: `MESSAGES["<domain>.<what>"]` (a function of the facts it names) and `say(key, ...facts)`. Every error/hint line an agent reads lives here; classes, exit codes and structured fields stay at the throw site and never read the prose. Leaf module (imports nothing). Migrated: task, agent, db, mux, sync, host, remote, workstream, worktree, log, delegate. |
| `src/next-hints.ts` | `computeNext(db, {callers, workstream?, outcome?})`: the ONE rule set behind every `next` (`NextPlan`), read-only (never waits, registers, ingests or runs a move). Outcome moves: the exact wait a send owes, the receipt check of an unknown delivery (only while the same registry row stands; never a resend), a gate's wait, the brief a `claim --for` owes, a preview's apply with `--if <rev>`, the stored `mu wait --resume`. State moves (skipped while a caller has an open human need): `mu next -w <ws>` over authorised work, the bare wait over owned refs (only after a verb that armed one: `ctx.armed`). `renderArgv` (POSIX words), `renderPlan` (safe before destructive, unguarded destructive refused), `capPlan` (a seq is dropped whole). `courseCheckHint` / `computeNotices`: the one-line "course check due" notice (10 closed or 24 h since the last `COURSE CHECK` note). Wired by `src/cli/handle.ts` (`finalNext`) <!-- doc-cli-drift:skip --> |
| `src/next.ts` | `executeNext`: recover (slice B), resume stored attempts, then spawn authorised ready tasks through `spawnAutoAttempt`; finite effect cap (counts every effect: reaps, retries, a spawn rolled back by the guard); ends unreconcilable attempts once; dry run; this caller's human need is checked before each effect; `hold` waits (`waitWithActions`, bounded) and recovers deaths and API errors; `signal` stops between effects |
| `src/next-recover.ts` | the recovery scan: `observeWorkers` (a status read plus the ctl `wait` that carries `lastError`, bounded), `inFlightWorkers`, `scanRecovery` (dead local → reap, live API error → retry in place, else nothing or `attention`; remote never), `exhaustedAfterDeath`, `liveWorkers` (the worker-ceiling count) |
| `src/next-refute.ts` | `executeNext --refute` (slice C): `nextCheck` (CLOSED/done permitted attempts with no call, or this caller's unfinished call), `runCheck` (register `starting` → `spawnForTask` → `running`; or read once and `finishDelegate`), `checkerRefs`; the call id `refute:<ws>:<task>:<attempt>` is the once-key |
| `src/cli/next.ts` | `mu next`: signals before the DB, one bounded envelope (`nextData`), exit mapping (`nextExit`) |
| `src/close-block.ts` | the CLOSE block of a settled pi run: `parseCloseBlock` (one grammar: last column-0 `CLOSE:` line outside a fence, exact marker lines, escaped evidence) and `applySettledClose` (report note, close note and status flip in ONE op group, once per (agent, incarnation, runs) through `agent_settles`; refuses delegate and human tasks; malformed reads "no close (malformed)") |
| `src/tasks/claim.ts` | atomic claim and release; `resolveWorkerIdentity` |
| `src/tasks/lifecycle.ts`, `status.ts` | close, open and cascade; `TaskStatus` |
| `src/tasks/errors.ts` | typed task errors |
| `src/tracks.ts` | union-find tracks with diamond merge |
| `src/dag.ts` | `loadOpenTaskFrontier` (the bounded open DAG: open tasks expand, CLOSED are leaves, depth and node caps, one SQL read per level; `task tree` and the dashboard read the same query), `renderFrontierLines` |
| `src/workstream-scope.ts` | the one never-trimming validator for a workstream name typed as scope (`-w`, a ref prefix, a record's `workstream`); shared by the CLI and the pi extension |
| `src/revision.ts` | task revision (`taskRevision`: derived on read from the task row, owner, both edge directions and note count; no counter, no LIKE), `agentRevision` (derived from the agent incarnation, row, owned tasks and worktree rows), `RevisionMismatchError`, `withTaskFence` (one `--if` check around a whole invocation) |
| `src/workstream.ts` | ensure, list, summarize, revision, soft teardown, reuse of a torn-down name |
| `src/vcs/git.ts` | git primitives (plain functions, git only): toplevel, `worktree add --detach` / remove, dirty files, the upstream ref set, `isAncestor`, `createBranch` |
| `src/worktree.ts` | per-agent worktrees: `createWorktree`, `removeWorktree`, `worktreeState`, the machine-local `worktrees` registry (outlives the agent; the reaper never touches it), the one close rule (`releaseWorktree`: park at `<path>.mu-removing`, scan holders with `worktreeHolders` (/proc, else lsof): a writer or an unprovable scan refuses unless `--force`, a cwd or reader is a warning; re-judge, then pin a create-only branch and remove), name reuse (`reclaimWorktreePath`); `WorktreeDirtyError`, `WorktreeHeldError`, `WorktreeBranchExistsError`, `WorktreePathNotEmptyError`, `WorktreeVcsRequiredError` |
| `src/state.ts` | `stateSnapshot`: the canonical READ-ONLY state read (SQL column names; no reconcile, no reap, no write; async only for ctl probes) of tasks (ordered by raw `MAX(ops.seq)` activity), registry agents (host/cwd/base/collected_head), the caller's own delegate queue and waves (`verdictTally(..., caller)`), and its open human needs; `mu state`, `mu me` and the dashboard share it |
| `src/dashboard-data.ts` | `loadDashboard`: the dashboard's ONE read-only projection (live workstreams incl. scratch; every task by status with qualified keys and raw `MAX(ops.seq)` activity; open frontier; registry agents with owned task; canonical log items; the caller's own human needs and delegates, empty for a null caller). No reconcile, reap, ingest or write. `next` is `computeNext` over the caller set (`computed`; `unavailable` only when it throws), and an agent's `tool` is the ctl status's running tool with `elapsed_ms` at read (null = none, absent = old extension or no ctl). every `kind=delegate` task carries its `call` (state, verdict, judged task, wave; any caller), and `waves` tallies each read workstream's five newest waves over every caller (`tallyCalls`); each delegate read is bounded in SQL (shown task statuses, newest waves, refused calls only), so a tick does not grow with `scratch`'s history. `attention` (dead/permission/input/stalled agents, refused delegate calls, OPEN human tasks of any recorder, next unavailable, sync warnings) reads every live workstream and ignores every filter; an item that a `mu` command clears carries it as `fix` (dead: `agent close`, refused: `delegates finish --outcome cancelled`, human: `task close`), which `y` copies on the Overview. `scopeWorkstream` reads tasks, edges and frontier of the shown workstream only (agents, log, caller panels and attention stay machine-wide; human tasks and task owners come from one SQL pass each), so a tick costs the shown workstream, not the whole database |

### CLI, output and packaging

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | the `mu` bin (`dist/cli.js`): enables the compile cache, then `import()`s `src/cli.ts` |
| `src/compile-cache.ts`, `src/state-dir.ts` | best-effort V8 compile cache under `<state>/compile-cache`; builtins-only state-dir resolution (default `<state home>/mu-next`) |
| `src/cli.ts` | Commander wiring (`buildProgram`, `runCli`) |
| `src/cli/dashboard-launch.ts`, `src/cli/tui/*` | bare `mu`: `openDashboardOrHelp` (TTY and not `--json` -> `handle()` guards + writable open + lazy `import("./tui/index.js")`, else help). `tui/runtime.ts`: the RO projection connection (fast reads take agent states from the slow tier's cache: no socket or subprocess) plus single-flight, throttled, quiet `ambientIngest` on the writable one (its latest warnings are kept and passed to every read as `syncWarnings`, so a `sync` attention item lasts until an ingest comes back clean) and `close()` drains and closes it; `use-snapshot.ts`: the ONE poll loop (3.x tiers: fast SQL-only tick, 1 s, `+`/`-` live; slow tick, 10 s, re-probes agent states into the runtime's cache; flicker guard: a byte-equal snapshot key publishes nothing, `nonce` moves only on change and drills re-read on it, `slowNonce` re-captures scrollback), sequential and cancellable; `app.tsx`: the view, whose query is the shown workstream plus the Log tail (the Tasks status and text filters are client-side; CLOSED rows are read only while that filter asks for them) (workstream row, five tabs, attention strip, filters, framed full-height list, footer pinned to the last row, keys); `overview.tsx`: the Overview tab's card grid (`overviewCards` from the other tabs' rows plus a Waves card when the workstream has waves, laid out by `grid.ts` in `frame.tsx` frames); `rows.ts`: the pure model (initial workstream, per-tab rows and their drill targets, filters, cursor by key, Next line); `text.ts`: clean/cut/pad by visual width (`fitLine` for styled lines); `theme.ts`: the one palette (3.x colours as named roles -> ink props; `statusRole`, `agentStateRole`, `noteKindRole`; NO_COLOR drops colour, keeps bold/dim/inverse), so no view names a colour; `columns.ts`: protect/clip column widths over the caller's rows (the snapshot, never the filtered window); `frame.tsx`: rounded frames, title/count in the top border and `+N more` in the bottom, exactly width x height; `grid.ts`: Overview card geometry (1/2/3 columns at <120/120/180 cols, fixed placement table, min/max row budgets with spare rows to cards hiding data, `fitColumn`); `drill.tsx`: the read-only full-screen drills (notes as styled lines: a header rule per note, the first `VERDICT:` line in its label's colour), exactly `rows` lines with the hint last (visual-width wrap, clamped scroll, guarded loads, OSC 52 yank), live on the loop's nonces (previous body kept during a reload, scroll kept for the same entity, follows at the end); `nav.ts`: the one list/body key map (j/k, Ctrl-d/u, PgUp/PgDn, g/gg, G) shared by the tabs and the drills; `commands.ts`: the only things the UI runs or copies (`planAttach` over `mux.attachCommands`, `runAttach` ordered required/optional steps, `yankSequence`); `index.ts`: `runDashboard`; `dashboard-shutdown.ts`: the one idempotent teardown (SIGINT/SIGTERM/SIGHUP, uncaught error, Ink exit, boot error) ending in the quiet final `ambientFlush`. Imports only from root files, never `cli.ts` |
| `src/cli/*.ts` | one file per verb namespace, thin wrappers over the SDK; `format.ts` renders tables, `handle.ts` maps errors to exit codes and runs ambient sync |
| `src/cli/tasks/*.ts` | the `mu task` namespace, including `mu me tasks` / `mu me next`. `records.ts` is the task read boundary: `taskToOutput` (SQL column names, `id` = `local_id`, real `workstream_id`/`owner_id`), `taskRecordCut`/`taskItemCut` (one escaped line <= 400 characters, `cut=N` for what it clipped), `taskPage`/`pageRecords`/`footerLine` (a result serialized and grown to <= 4 KB; the `more=N cut=N next=<same command> --all` footer is reserved first and never sliced); `list`, `next`, `owned-by`, `show` and `tree` all go through it. `mu state` and `mu me` keep the table formatter. `wire.ts` holds every `task.command(...)` definition |
| `src/cli/log.ts`, `src/cli/log-records.ts`, `src/cli/page-records.ts` | `mu log`: `log-records.ts` is the read boundary (one escaped record <= 400 characters, or a `LogItem` keyed by `ops` columns, bounded to 2 KB; `shrinkItem` bounds every item field; `logPage` pages the final bytes with min 0, `more`/`cut` name `mu log --seq A..B` / `--after S` reads, digits only; `--seq`/`--after` take no scope or filter, each record whole); `--tail` is always NDJSON (`cmdLogTail`: row written, then cursor moves; a failed write throws `TailStopped` carrying the cursor; SIGINT 130, SIGTERM 143). `page-records.ts` is the generic pager `mu workstream list [--torn-down]` shares (`--all` uncapped) |
| `src/cli/db-query.ts` | `mu db query` (alias `mu sql`) and `mu db --shell`. Reads by default: without `--write` a statement `stmt.readonly` calls a write (EXPLAIN excepted) is refused, and the connection runs `query_only`; one op-context scope per write; `guardPragma` allows only read-only PRAGMAs before any compile; one `EXPLAIN` per statement (`checkStatement`) refuses transaction control (`AutoCommit`/`Savepoint`), ATTACH/DETACH, all DDL (a write to any `sqlite_master` root page, TEMP included) and any write to `op_ctx`/`op_dying`/`ops`/`schema_version`/`machine_identity`/`sync_peers` outside a main `_cap_*` trigger, a statement's own write to `sqlite_sequence`, and an UPDATE of `id`/`rowid` on the four guarded tables (a rowid-changing `Delete` with no table name); `installScopedViews` (TEMP `ready`/`blocked`/`blockers`); `teachColumnError`; output is JSON by default (`--table` for prose; `isSqlVerbArgv` in `src/output.ts` makes parse-time errors JSON too) and a read is `{items,count,more,retrieve?}` paged by `pageRecords` (min 0) over the final document bytes (`sqlRowsPayload`), `--all` whole. `src/cli/db.ts` keeps `backup`, `compact`, `forget` |
| `src/cli/state.ts`, `src/cli/me-identity.ts` | `mu state` / `mu me` (one JSON document, no card): scope (variadic/comma/repeated `-w`, `--all`, `--me`), explicit reconcile for `-w` reads, bounding to 4096 final bytes (lists shrink, then workstreams page, min 0; a cut names `mu state ... --full`). `me-identity.ts` is the one identity path: the injected `<ws>/<name>` row, else `pi:<session>`, never `$TMUX_PANE` (`mu me tasks` / `next` use its managed-agent form) |
| `src/cli/sync.ts` | `mu sync`: peer status, `--from`, `--repair` over `src/sync.ts` |
| `src/cli/stdin.ts` | `-` as a text argument: reads note / send text from stdin (heredoc prose) |
| `src/hosts.ts` | host profiles: the template grammar (`expandHostTemplate`, one pass, per-context quoting, whitelisted `{env}`, `{name:sh}` second layer), profile CRUD (`transport`, `stop`; per-field placeholder scopes enforced by the lexer), `host_channels` admission (`reserveHostChannel` / `bindHostChannel` / `releaseHostChannel` by token, `withHostChannel`, transient vs attached), `admitHostChannel` (spawn reserves before its pane opens), `checkHost`. ssh-free: runs only the user's stored templates with `/bin/sh -c`, each as its own process group (`execGroupCapture`, reaped before its channel is released; the group id is recorded on the `host_channels` row so a dead caller cannot free a slot under a live transport) |
| `src/cli/host.ts` | the host verbs (add, list, show, rm, init, check); `init --ssh` / `--mule` print a starter, `add --transport lease --stop` stores a lease profile |
| `src/carrier-jobs.ts` | `carrier_jobs` (machine-local, no FK/trigger/op): a lease spawn's name-exclusive **reservation** of its remote job, with a spawn token, the launch state, pane, incarnation, handle and admitted `stop` template. Reserve, token-guarded updates (launch, pane, bind, fill, note), get by token, incarnation or `(workstream, name)`, compare-and-set release, abandon. Agent deletion never touches it |
| `src/carrier-stop.ts` | `runStop`: run a lease profile's `stop` template with a handle under a transient channel, only if the profile's `stop` still equals the recorded `host_stop`; exit 3 is a hand-back, other failures throw and keep the handle. Never deletes the row |
| `src/remote-agent.ts` | the remote half of `spawn --host`: `prepareRemote` (one `exec` makes a detached remote worktree or resolves the cwd, answer is a tagged line), `removeRemoteWorktree` (the spawn-rollback helper: clean and at its base only, `--force`), `closeRemoteWorktree` (the close rule: observe, apply, rename the tree aside, prove no process holds it via `/proc` or `lsof`, re-check HEAD and cleanliness, `worktree remove` without `--force`; `--keep-branch`), `remoteShellCommand` (the filled `shell` template as the local pane's command; five whitelisted identity vars), `localPaneAlive` (a retained exited pane is not alive: it holds no channel) |
| `src/remote-collect.ts` | `collectRemoteAgent`: the `fetch` template run in the LOCAL repo under one channel, the fetched commit resolved from FETCH_HEAD (cleared first) and pinned under `refs/mu/collect/<ws>/<agent>`, `agents.collected_head` set by compare-and-set on id, pane, host, cwd and base |
| `src/cli/agent-close.ts` | `mu agent close`, recovery-aware scope (`closeScope`: live agent or recovery record) |
| `src/cli/agent-collect.ts` | `mu agent collect` |
| `src/output-contract.ts` | the `--json` wire: `Envelope<T>` (`{ok,data,next}` / `{ok:false,error,message,next,exit}`), `NextPlan`, `encodeEnvelope`, `isEnvelope`. Pure. `cli.ts` `emitJson` wraps every payload once; `handle.ts` `emitError` prints the one failure document on stdout; both take `next` from `finalNext()` (the ONE finalisation: `computeNext` over the DB `handle()` holds, the verb's `setNextOutcome` and the scope `resolveWorkstream` records, fitted to the 4 KB result by `fitNext`; human text gets one dim `next:` line); `emitJsonRow` is the raw NDJSON row (`mu log --tail`, inert like an envelope). `extension/delegate.ts` `parseEnvelope` reads it |
| `src/output.ts`, `src/shell-quote.ts` | colour, `muTable`/`renderBoxTable`, JSON-mode and verb-argv probes (`isJsonMode`, `isSqlVerbArgv`, `isWaitVerbArgv`), `usageLines`; POSIX quoting for `next` commands |
| `src/glyphs.ts` | the one glyph vocabulary (single-cell Nerd Font codepoints) |
| `src/index.ts` | SDK entry point |
| `skills/mu/` | the skill loaded into an agent's context (`SKILL.md` ≤ 600 words, 12 recipes ≤ 250 each and ≤ 4,000 together, pinned by `test/prose-budget.test.ts`, with failure-backed markers); `mu --help` owns the verb reference; every dropped 3.x rule has a destination in [rule-destinations](history/mu-next-design/rule-destinations.md) |
| `scripts/check-doc-links.mjs` | relative-link and anchor checker for every markdown file, run by `test/doc-links.test.ts` |
| `tools/screenshot/` | `dashboard.sh` seeds the dogfood `payments` scene on a private tmux socket, captures it at 200x40 and `ansi-to-png.py` renders the capture to `docs/img/tui-dashboard.png` (README); not shipped |
| `tools/eval/` | the eval harness: scripted scenarios and judges run against a built surface, the release matrix and the cold-guess probe; reports in [docs/eval/](eval/README.md); not shipped |
| `docs/history/` | records only: old changelogs and the [4.0 design history](history/mu-next-design/README.md) (design of record, rule destinations, release reviews, the TUI dogfood kit `dashboard.sh` runs); not shipped |
| `test/` | vitest suites; `*.integration.test.ts` touch real tmux, herdr or VCS ([sdk.md § Testing layers](architecture/sdk.md#testing-layers)) |

The shipped contract is
[reference/surface-contract.md](reference/surface-contract.md).

## Key seams

A new implementation of each is small.

| Seam | Add one by |
| --- | --- |
| `MuxBackend` | implementing the interface in `src/mux/`; a backend without an equivalent no-ops, and a backend-only feature is an optional method callers test for |
| typed verb | an SDK function; a `cmd<Verb>` in `src/cli/<namespace>.ts`; one Commander block in `buildProgram()` wrapped in `handle()`; the verb declares what it did (`setNextOutcome`) and `next` is computed for it |
| schema change | bump `CURRENT_SCHEMA_VERSION` in `src/db.ts` and mirror `CURRENT_SCHEMA`; startup stays migration-free |
| syncable field | add the column to a portable table, extend the UPDATE trigger's changed-column comparison, confirm apply writes it; a full-row payload regresses merge to row-level LWW |
| cross-machine sync | nothing: every invocation already flushes and ingests |
