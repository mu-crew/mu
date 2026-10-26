# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases: [docs/history/CHANGELOG-pre-3.md](docs/history/CHANGELOG-pre-3.md).

---

## [Unreleased]

### Removed

- **Dead-code sweep on the merged tree (`k_cut_leftovers`).** knip over `src/` and `extension/`
  found no unused file and no orphan beyond `terminalWidth`, `evidenceSuffix` and
  `isExecFailureLine`; all three are deleted. Doctor's human and `--json` collectors stay
  separate: a shared collector measured +7 code lines.

- **Legacy `nextSteps` hints are deleted, not wrapped; every result's `next` is computed once**
  (`v_hint_wire`, slice B of `v_hints`; README "Next contract"). `handle()` finalises `next` for
  success JSON (`emitJson`), failure JSON (`emitError`, `CliExitError` partial failures) and human
  text (one dim `next:` line, stderr on failure) from `computeNext` over the open DB after the verb's
  writes. A verb only declares what it did (`setNextOutcome`: a delivered send's exact wait, an
  unknown delivery's receipt check, a gate's wait, a `claim --for` brief, a preview's `--if <rev>`
  apply, a wait's stored resume); `resolveWorkstream` records the scope. Outside `handle()` (parse
  errors) `next` is null. The plan is cut to what the 4 KB result leaves (a `seq` dropped whole).
  Gone: `NextStep`, `HasNextSteps`, `hasNextSteps`, `printNextSteps(To)`, `formatNextSteps`, every
  `errorNextSteps()` and `inlineNext`, `paneNotFoundNextSteps`, `transportNextSteps`,
  `src/cli/dispatch-hints.ts`, the wait's `nextSteps`/`nextStepsCut`, the spawn orphan-cleanup hint
  and the triage `next=` trailer on `task list`. Reads, placeholders (`<id>`, `'...'`) and `a|b`
  are no longer printed as hints. Facts some hints carried survive as data or one-line prose:
  `agent spawn --json` and `workstream init --json` carry `attach` (the delegate tool reads it
  there), the dirty-worktree commit line on `task close` and the unseen-note send on `task note` are
  `warnings`, `mu rebuild` prints the swap command, a wrong task id prints `similar:` (human) beside
  `candidate_ids` (JSON), an ambiguous name adds `candidates`, and the prose-quoting and missing-CLI
  advice moved into the error message.
- **An unknown verb is one line, not the root help** (`df1_unknown_verb_dumps_help`, dogfood-1 F5).
  `mu next` used to print "too many arguments" plus 7.6 KB of help; it now prints
  `unknown command 'next' (closest: mu me next); see mu --help` (70 bytes for a word with no near
  verb). The closest verb is matched one level deep (`mu claim` → `mu task claim`); a namespace says
  `see mu task --help`. `--json` keeps `usage`.

- **The pre-engine wait code is deleted, not wrapped** (`v_wait_delete_old`). `src/tasks/wait.ts`
  (`waitForTasks`) and `src/agents/wait.ts` (`waitForAgents`) were adapters over `waitForEvents`;
  `mu agent wait` now calls `waitForEvents` directly (`src/cli/agents.ts`, with `ctlAgentHooks`) and
  `mu task wait` / `mu wait` already did. Gone from the SDK: `waitForTasks`, `waitForAgents`,
  `setWaitStuckWarnForTests`, `setAgentWaitSleepForTests`, `getWaitPollCount`, `resetWaitPollCount`,
  the `TaskWait*` / `AgentWait*` / `AgentStatusSnapshot` / `AgentWatch` types, `toStatusSnapshot`, the
  `inspect` wait option, and the never-thrown `ReaperDetectedDuringWaitError` and
  `StallDetectedDuringWaitError` (exit 6 and 7 are `WaitResult.exit`, never an error class).
  `setWaitSleepForTests` now lives in `src/wait.ts`. `mu agent wait` output and exit codes are unchanged.
  The tests that guarded the old adapters now guard the engine (`test/wait-events.test.ts`).

### Fixed

- **A remote command gate no longer lists as `unknown: murmur has no row`.** `mu agent list`,
  `mu agent show` and `mu state` read a gate from its pane (running reads `busy`, an ended one
  `unknown` with `exited <n>`), never through a host exec. `readGate` drops its pre-read channel
  release: the result read's admission already reclaims a dead pane's channel.

- **A worker that dies between two waits is `dead` (exit 6), not a heartbeat**
  (`df2_wait_dead_after_reap`, dogfood-2 F1). A wait used to see a reaper flip only if one of its own
  ticks had seen the owner first (in memory), so a wait started after the death, or a `mu wait
  --resume` run after it, got a heartbeat with the task OPEN. The flip is now read from the ops log:
  a watched task whose latest status change is the reaper's (`task.reap`) is dead when the flip came
  after the wait's anchor. The anchor is the ops head when the wait starts; `--resume` replays the
  stored one (`wait_resumes.spec.since`); a ref a caller registered owes every flip until its cursor
  consumes it. A later claim, release, park or close is a decision and is not reported dead.
- **A dead agent ref no longer hints `mu task show <agent name>`** (`df2_dead_hint_agent_ref`,
  dogfood-2 F2). The hint now names the reaper's log lines, `mu log -w <ws> --source reaper -n 10`,
  which list the tasks it reopened.

- **`mu_delegate` with `workspace: true` honours `cwd` as the repo** (`bug_delegate_workspace_root`).
  It spawns `--worktree --root <cwd>`, so a pi session in a parent of several repos can name the one
  to branch; without `cwd` the caller's directory stays the repo. A queued or reissued call replays
  the root from the stored request. A spawn refusal that cannot change on retry
  (`WorktreeVcsRequiredError`, `UsageError`) is recorded as failed with the CLI's message and the fix
  (`Pass cwd: <a git repo>`), no longer as a refused call to reissue.

- **Tests no longer write to the real `~/.cache/mu` or `~/.local/state/mu(-next)`.**
  `test/_setup.ts` points `XDG_CACHE_HOME`, `XDG_STATE_HOME` and `XDG_CONFIG_HOME` at a per-fork temp dir
  (removed on exit), and `test/_real-dir-guard.ts` throws on any `fs` write under the real dirs, like the
  real-DB guard in `openDb`. Fixture delegate answers had been landing in `~/.cache/mu/delegate-answers`.
- **A finished worker is not `dead`: an agent ref is owed only while it owns open work or an
  unsettled run** (`df1_wait_stale_dead`, dogfood-1 F1; round 2 of `v_wait_arming`). With arming, the
  orchestrator's `claim --for` + `send` left the worker's agent ref registered after its task closed;
  a deliberate `mu agent close` then made the next wait (bare, explicit task, or `send --wait`) exit 6
  `dead`, "the work is not done". One rule now lives in `src/wait-owed.ts`: an agent ref is DONE when
  every task the agent owned is CLOSED (or released), nothing it was sent is unsettled and it is idle.
  Every wait tick keeps a DONE mark per owned agent (a `wait_cursors` row `done|agent:<ws>/<name>`,
  machine-local) true to what it read, and `agent close` sets it when the agent holds no open task
  and no run in flight. A registered agent whose row is gone and which carries the mark is dropped
  from the registration with no event. `dead` is left for a pane lost while work or a run is owed
  (a task still open, a run busy or unsettled, or never read at all). New work armed for the agent
  clears the mark. The `dead` reason for an agent ref no longer says "the work is not done" ("gone
  (its pane died or it was closed)"); a task whose owner died keeps it.

### Added

- **`mu next --refute`: an opt-in durable checker per closed attempt** (`v_exec_refute`, slice C of
  `v_executor`; `src/next-refute.ts`). For each authorised task a worker closed as `done`, one
  delegate call (`refute:<ws>:<task>:<attempt key>`, workstream `scratch`, wave `refute-<ws>`) is
  registered `starting` BEFORE any pane, then launched through the journaled `spawnForTask` (the
  checker's pinned brief + the worker's report, note numbers named) and marked `running`. A later
  `mu next --refute` reads its settled run once (bounded) and `finishDelegate` records: the verdict
  note lands on the judged task, then the call's report and close. A dead checker, a hung one (30 min)
  or one that could not start is recorded `failed` (UNVERIFIED), never retried; a first send that may
  have landed is probed once and never resent. Never accepts, reopens or closes the judged work and
  never grants auto permission; a wontfix/rejected close gets no checker; only this caller's calls are
  touched. Needs a caller identity (exit 2 without) and a ctl cli (`--refute-cli`, default the task's
  own). `--hold` also waits on running checkers. Every launch, read and record counts against `--cap`;
  `--dry` lists the owed checks. `pinnedNotes` is the shared brief/report lookup of `buildTaskBrief`.

- **`computeNext`: one read-only rule set for `next`** (`v_hint_rules`, slice A of `v_hints`; SDK
  only, results still print `next: null` until `v_hint_wire`). `src/next-hints.ts` computes a
  `NextPlan` from current state plus what the verb did: the exact `mu wait 'agent:<ws>/<n>@<runs>#<inc>'`
  a delivered send owes (the send's own baseline), `mu agent check <a> <msgId>` for an unknown delivery
  (only while the registry row it went to stands: the check has no `--inc`; never a resend), a gate's
  wait, the `--fresh` brief a `claim --for` owes, a preview's apply with `--if <rev>`, the stored
  `mu wait --resume <id>`; then `mu next -w <ws>` when work is authorised here and the bare `mu wait`
  over owned refs, both withheld while a caller has an open human need. Reads are never suggested; a
  refused delegate call (reissued by the pi tool) never is. Every command is rendered from argv with
  POSIX quoting (a test runs each through `sh`); an unguarded destructive move throws; `capPlan` drops
  an oversized `seq` whole. `agentRefOf`, the claim prompt and `resumeCommand` now come from this one
  builder. Exported: `computeNext`, `renderArgv`, `renderPlan`, `capPlan`, `NextPlan`.
- **Course check due** (`v_course_hint`; SDK, rule only). `courseCheckHint(db, ws)` in
  `src/next-hints.ts` returns `course check due: <n> closed since <date> (recipes/course-correct.md)`
  once a workstream has 10 CLOSED/done work tasks (counted by close-note time), or 24 h with at least
  one, since its newest `COURSE CHECK` note, or since it was created if there is none. A newer note
  clears it. The thresholds are constants (`COURSE_CHECK_CLOSED`, `COURSE_CHECK_AGE_MS`), not flags or
  env. `computeNotices(db, ctx)` returns it as the one-line notices beside `next`; printing them in
  `mu state` / `mu wait` is the output finalisation (`v_hint_wire`). Read-only, one query, no schema change.
- **Switch note** (`v_cutover_runbook`, docs only). `docs/guide/upgrade.md` "Switch to mu-next" covers
  the per-machine switch with no flag day: install beside 3.x, move workstreams with the Move recipe,
  keep 3.x as a read-only archive, and roll back by going back to 3.x (`task unpark` for a moved
  workstream). It also gives the one-line new-model bench (`tools/eval/main.ts matrix ... --out
  docs/mu-next/eval/models.jsonl`) and points to `v_eval_next` for the release gate.
- **Dogfood 2** (`dogfood_after_v_wait_cli`): `docs/mu-next/eval/dogfood-2.md`, an isolated loop on
  `mu wait`.

- **Remote command gates** (`v_remote_gates`, core; SDK only). `spawnAgent` with `host` and an
  explicit `--command` that is not pi (argv0 not `pi`/`pi-meta`, `cli` not explicitly `pi`) is a
  *gate*: a foreground remote command whose exact numeric exit `mu wait agent:<ws>/<name>` returns
  as `data.exit` and the process exit (`23` stays `23`; `exited` is a new wait event, the
  snapshot carries `exit`). Decided before any effect and stored as `agents.gate_token` (nullable,
  machine-local, same schema version; an existing file gains it on open; it joins `agentRevision`
  and the agent JSON as `gate_token`). A gate speaks no ctl (`expectsCtl` is false whatever `cli`
  says), is not startup-scanned, is never auto-closed, and refuses `--worktree` before any effect.
  tmux arms `remain-on-exit` on its own pane BEFORE the command runs (new optional
  `SpawnAgentPaneOptions.retainOnExit`: a placeholder pane, `set-option -p`, then `respawn-pane`)
  and reads it with the new optional `MuxBackend.paneResult` (`running | exited{code,signal} |
  absent`; a failed probe throws = unknown); herdr keeps refusing `--host`. The LOCAL pane's
  status is not the answer (a shell template may swallow it): the remote wrapper writes
  `MU_GATE <token> <rc>` atomically under `~/.local/state/mu-next/remote-gates/`, read with the
  profile's `exec` only after the pane is proven exited, and its channel freed by registry id +
  pane (so at `--max-sessions 1` the read admits, and so does the next spawn: `localPaneAlive`
  treats a retained dead pane as transport-dead). A missing, malformed, over-255 or foreign
  record, a signal or a lost transport reads `dead` (exit 6), never success; an unreadable probe
  or exec reads `unknown` and keeps the lease. Repeated waits reproduce the result; an owned
  cursor consumes it once; `agent close` removes only its own token's record. `WaitResult.exit` is
  widened from `0|6|7|130` to a number; under `--all` it is the first nonzero gate code. The
  legacy `waitForAgents` adapter reads a nonzero gate as `dead`. The CLI (`f_gates_cli_flags`): `--cli`
  has no commander default, so `spawn --host H --command 'npm test'` is a gate verbatim; `--task`,
  `--send`, `--attempt` and `--worktree` with a gate are refused before any effect (usage, exit 2);
  the Next: hint is `mu wait agent:<ws>/<name>`, which exits with the command's code.

- **`--on-stall steer|release`** on `mu wait` and `mu task wait` (`f_steer_cli_wiring`). `runWait` now
  calls `waitWithActions` with the merged `steerStallHandler` / `releaseStallHandler`. The stall
  result names what was done (`sent`, `released`, `refused`, `unknown`, `budget-exhausted`): one
  stderr line per handled stall, `data.action`, and the `reason` text. `steer` continues the wait;
  `release` and every non-sent outcome end it with exit 7. Both act only on workers the caller
  spawned and on tasks permitted with `mu task auto`. `--resume` replays the action. The usage
  error for an unknown value names all four.
- **Producer arming and the one wait hint** (`v_wait_arming`, slice B of `v_wait_cli`). A producer
  that did something registers what it owes the next `mu wait` (`wait_registrations`), so a bare
  `mu wait` or the settle hook owns it without parsing a shell line. Armed: `agent spawn --send`
  (plain and `--next-free`, for the ACTUAL returned agent, once the prompt is delivered),
  `spawn --task` (the task and the agent, from the saved receipt; a replay re-registers the same
  refs; a stale identity arms nothing), `agent send` and `send --interrupt` (a delivered prompt),
  and `task claim --for` (the task in its OWN workstream plus the owner agent read from
  `owner_id`, so cross-workstream works). Not armed: `claim --self` and a worker's own claim
  (the caller would wait on its own work), a slash command, an undelivered or failed or UNKNOWN
  send, a plain shell with no identity. The caller is the managed `<ws>/<agent>`, else
  `pi:<session>`. An agent ref carries the UNCONSUMED fence the producer measured BEFORE its
  effect (ctl runs, pi incarnation, registry id; the earliest run of one process wins on a repeat
  send; a replacement agent gets its own), so a run that settles before any wait starts is still
  delivered. A registration that cannot be stored (the 256-ref cap, a vanished entity) never
  rolls the committed effect back: it is `warnings` in the producer's document. Direct SDK calls
  (`spawnAgent`, `sendToAgent`, `claimTask`, `spawnForTask`) do not arm: the verbs do, and the
  engine's provenance discovery covers the rest.
- `mu agent send --wait` and `mu task claim --for <w> --and-wait` enter the wait after the
  producer: one JSON document, the wait's (`firing`, `exit`, `snapshots`, `resume`; SIGINT/SIGTERM
  print a snapshot), with the producer's receipt as `data.sent` / `data.claimed`. Errors are JSON
  too. `--and-wait` needs `--for`; `--wait` refuses a slash command; an undelivered send waits for
  nothing.

- **Guarded stall release and action receipts** (`v_wait_release`, slice C1 of the wait core; SDK
  only, no CLI flags yet). New machine-local table `wait_action_receipts` (25 tables; additive,
  same schema version, an existing file gains it on open; never captured or synced; no foreign
  keys; a rebuild reports its rows as lost). One row per task id + owner registry id + ctl
  incarnation + action, shared by every caller, restart and generation. `releaseStall(db, ctx)`
  / `releaseStallHandler` implement `handleStall` for `onStall: 'release'`: in one immediate
  transaction it rechecks the callers set, wait generation, task PK/kind/status/revision, owner
  id, name and pane, that a caller spawned the owner, `autoPermitted` and `openHumanNeeds` of
  every caller, then calls `releaseTask(expectedOwnerId, ifRevision)` (no reopen) and writes the
  receipt. A failed guard writes nothing and returns the stall; a second release for the same
  incarnation is `budget-exhausted`. The engine keeps reporting a handled `return` stall even
  though the release removed its condition.

- **Crash-safe stall steer** (`v_wait_steer`, slice C2 of the wait core). `steerStall(db, ctx)` /
  `steerStallHandler` implement `handleStall` for `onStall: 'steer'`; `waitWithActions(db, refs,
  opts)` is `waitForEvents` plus the handler `onStall` names (steer or release). One fixed plain-text
  reminder per task + owner + ctl incarnation, shared by callers, restarts and generations: the
  receipt is reserved with its msgId, then a synchronous final fence (`beforeWrite`, on connect,
  right before the write) re-runs every guard and compare-and-sets `reserved -> sending`; only the
  winner writes. The extension remembers msgIds but does not dedupe sends, so SQLite, not the msgId,
  is the exclusion. A crash at `sending` is `unknown`: probed (same registry id, pane and
  incarnation), never resent, never turned into a release. An accepted nudge continues the same
  wait from the receipt's run baseline; refused, unknown, aborted or exhausted returns the stall
  with the action. `ctlRequest` gains an opt-in `beforeWrite` fence (`CtlWriteVetoedError`) and an
  abort after a side-effecting write is now `CtlDeliveryUnknownError`; `sendViaTransport` gains
  `ctlGuard` (signal, timeout, fence). Defaults unchanged. Receipts allow `sending -> refused`.
  A probe-confirmed earlier steer whose run already settled (receipt runs below the owner's) returns
  the stall ("nudged earlier, owner idle again") instead of a silent continue; a fence on a
  session-command text (`/new`, …) is refused, not skipped.

### Changed

- **One wait hint.** The `Next:` line after a send, `spawn --send`, `spawn --task` and
  `send --interrupt` is now `mu wait 'agent:<ws>/<name>@<runs>#<incarnation>'` (one POSIX-quoted
  typed ref, no `--json`: `mu wait` always prints JSON, the answer is `snapshots[].lastText`),
  replacing `mu agent wait <a> -w <ws> --after-runs <n> --inc <i> --json`.

- **Dashboard drills** (`v_dashboard_drill`): Enter opens a read-only full-screen body: Tasks the
  task's notes (the CLI's default selection, pinned notes marked `*`; `A` shows all, whole), Agents
  the pane scrollback (last 2000 lines, `r` reloads), Log one op with every field. `j/k`, PgUp/PgDn,
  `g/G` scroll (clamped, wrapped by visual width, no ANSI in the text); Esc or `q` returns to the
  tab with its filters and cursor. `y` copies the row's command with OSC 52 (no clipboard
  dependency) and prints it; control characters and over 1 KB are refused. `a` on an agent is the
  one key that runs anything: the backend's `attachCommands` steps, in order, with Ink's terminal
  suspended and restored (`$TMUX` picks `switch-client` or `attach-session`; `-L` routing kept). A
  failed required step stops, an optional one is a warning; no mux, no workspace or no client opens
  the scrollback with the reason and the attach line for a shell outside the mux (yankable).
  Typeahead typed during an attach is dropped. A drill's failure reason, outside-client line and
  yank confirmation are pinned under the title (at most half the screen), not part of the scrolled
  body, so a long scrollback that opens at its end still shows them. `AttachTarget.outside` asks a
  backend for the line to run from a shell outside any client: herdr then always appends the
  client step (inside herdr the executed steps stay focus-only). Adds `DashboardRuntime.notes` (read-only
  connection). Read-only otherwise: no task or agent mutation.
- **Dashboard tabs** (`v_dashboard_shell`, slice S2): the dashboard shows a workstream row and
  four tabs: Tasks (newest activity first, CLOSED hidden, owner on IN_PROGRESS), DAG (the open
  frontier; root, repeat and per-entry cap cuts always listed, even when a text filter hides the
  entry), Agents and Log (every workstream, scratch
  marked `*`). Starts on `-w`, else the mux session's workstream, else the most recently active one
  (never the alphabetical first). Status (`s`) and text (`/`) filters persist per tab and
  workstream; the cursor follows its row key, not its index, so activity reordering never moves
  it, including the default row on first view and after a filter reset. A short or narrow
  terminal keeps the workstream row and tabs (then one data row, filter, hint, Next); tabs
  collapse to the active one when four labels do not fit. Next reads `unavailable` until the Next slice computes it (never "no authorised work");
  an agent whose tool is not reported shows `tool ?`. The runtime now runs one refresh at a time
  across queries: a changed query waits for the in-flight one. Read-only.
- **Dashboard shell boot** (`v_dashboard_boot`): bare `mu` on a TTY (stdin and stdout, no `--json`)
  opens the dashboard; a pipe, script, `--json` or `--help` prints the same help as before. Adds
  `ink` 8 and `react` 19 (no devtools), `jsx: react-jsx`, and a lazy UI chunk that neither the SDK
  index nor any other verb loads. The UI reads on a `readonly` connection; ambient sync (ingest at
  most every 10 s, quiet, one refresh in flight, no reconcile or reap) runs on a separate bounded
  writable connection outside render, with the DB-inside-`MU_SYNC_DIR` and sync/v1 refusals kept
  and one idempotent shutdown (installed before the lazy import) that restores the terminal, closes
  the connections and flushes once on `q`/Esc, SIGINT (exit 130), SIGTERM, SIGHUP, uncaught and boot errors. A read-only connection cannot ingest, so one
  connection was not an option. The shell shows counts only; tabs and rows are `v_dashboard_shell`.
- **Dashboard read model** (`v_dashboard_core`): `loadDashboard(db, opts)` (`src/dashboard-data.ts`,
  exported from the SDK) is the one read-only projection the dashboard tabs share: every live
  workstream (scratch included), all tasks by status (CLOSED hidden by default, uncapped when
  asked) under `<workstream>/<id>` keys ordered by raw `MAX(ops.seq)` activity, the open
  frontier, registry agents with their owned task, the canonical op log, and the caller's own
  human needs and delegate calls (a null caller sees none: `caller_scope: "none"`). It never
  reconciles, reaps, ingests or writes, and runs on a `readonly` connection. `next` (type
  `NextPlan`) is null with `next_source: "unavailable"` and an agent's `tool` is unset until
  `v_dashboard_next`. Owners are identified by agent registry id (`owner_id`, with
  `owner_workstream`; a task claimed by another workstream's same-named agent lands on that
  agent, also on a filtered read), and the open frontier's root/recurrence cuts pass through as
  `frontier[]` per workstream.
- **`mu wait`: the one orchestrator wait** (`v_wait_surface`, slice A of `v_wait_cli`; over the
  `waitForEvents` engine). `mu wait [<ref>...]` returns on the first event its caller owns and
  prints ONE JSON document with no `--json` flag, errors and parse-time errors included. Refs are
  typed: `task:[<ws>/]<id>`, `agent:[<ws>/]<name>[@<runs>][#<incarnation>]`, `delegate:<call id>`
  (a bare word is refused with the spelling that works). No refs: the wait owns what the caller
  started (the agents it spawned, by `agents.spawner`, and their tasks; its delegate calls).
  `data` is `firing` (= `event`: `kind`, `ref`, `incarnation`, `runs`; `closed settled input dead
  stall delegate pane-text heartbeat interrupted`), `exit` (0, 6 dead, 7 input or stall, 130/143 signal),
  `timedOut`, `interrupted`, `open`, `snapshots`, `tally` (with a `6/12 CONFIRMED` summary),
  `cursor`, `resume`. A timeout is `ok:true`, `timedOut`, exit 0. SIGINT/SIGTERM print the final
  snapshot (the state read at that moment) and `resume`, then exit 130/143; SIGKILL cannot print.
  The result is bounded to 4096 bytes on its FINAL bytes, `nextSteps`, `humanNeeds` and `warning`
  included: texts shrink first (tail kept, `lastTextCut`), then the hints (`nextStepsCut`) and
  human needs (`humanNeedsCut`), the tally's findings, and the snapshots (`snapshotsCut`,
  `retrieve`; the shared `pageRecords`); firing, exit, open and resume are never cut. `resume` is a
  stored handle, `mu wait --resume <id>` (+ `-w`): the new machine-local `wait_resumes` table holds
  the refs still owed (each agent with the run baseline and pi incarnation it was last SEEN at, so a
  restarted pi is refused, not miscounted), mode, every filter, the deadline as given and the
  callers the wait ran for, so a resume is lossless whatever its size (30 refs, 24 was the old
  silent cut) and runs for the same caller from any shell. `--resume` takes nothing else (a flag or
  ref beside it is a usage error); an unknown or older-than-14-days handle is exit 3. With nothing
  left to wait for and no caller (a plain shell whose named refs all fired) `resume` is `null` with
  `resumeWhy`, never a command that fails. Flags: `--first`/`--first-of`
  (default), `--all`/`--all-of`, `--until-idle`, `--until-text <re>` (the bounded regex; a pi
  agent's ctl `lastText`, never its pane. A non-pi pane (no answering socket) has no run to settle:
  its tail is matched and the wait ends as the distinct `pane-text` event, `textSource: pane`, never
  `settled` and never a CLOSE source), `--status`, `--stuck-after`, `--on-stall exit|warn`
  (`steer`/`release` arrive with the stall-action units and are refused by name), `--wave`,
  `--blockers-of`, `--timeout` (default and cap 1500 s; 0 = the cap; one warning when below 300 s),
  `--after-runs`, `--inc`. One stderr heartbeat line a minute; never ANSI. The engine gains
  provenance discovery of a caller's spawned workers, a `scope` that narrows what a caller owns to
  one workstream, owner-death detection for a plain-shell wait, and `onStall: warn`.

### Changed

- **BREAKING: `mu task wait` is now an alias of `mu wait` over task refs.** It prints the one JSON
  result (no `--json` needed) instead of the table and the old `{firing, all, timedOut[]}` shape;
  the default is the FIRST event, not all-of (`--all` keeps the all-of loop); `--any`, `--first` and
  the default are one contract and always name the firing ref; the default timeout is 1500 s (the
  cap; `0` means the cap, no longer forever; it was 600 s); a timeout is `ok:true` with `timedOut`
  and exit 0, no longer exit 5; the reaper flip and the stall are events (`dead`, `stall`) in the
  document, no longer stderr text and a thrown error. `--on-stall warn` still keeps waiting and now
  prints one stderr line per stalled task. The help example `jq -r .firing.qualifiedId` is now
  `.data.firing.ref`.
- **`mu agent wait --any` fills `firing`** like `--first` (one contract). Its output is otherwise
  unchanged: the delegate recorder (`extension/delegate.ts`) reads `data.agents[0]` as before, over
  the same engine with `eventScope: refs`.
- `mu wait` and `mu task wait` default to JSON (`isWaitVerbArgv`, verb-aware like `state`), so a
  parse-time error is one stdout document too. `handle()` drains stdout before `process.exit`, so a
  piped result is never truncated.
- The poll-sleep test seam is shared by every wait entry point (`setWaitSleepForTests`).
- **mu-next is isolated from 3.x on disk** (`v_isolation`; after the 18:04 incident, where an
  inherited `MU_SYNC_DIR` let a mu-next run write a v2 segment into the real 3.x sync folder
  and 3.x warned `unknown-version` on every command). The default state dir is now
  `$XDG_STATE_HOME/mu-next` (`~/.local/state/mu-next`), holding the DB, control sockets, locks,
  worktrees and compile cache; `MU_STATE_DIR` and `MU_DB_PATH` are unchanged. Sync stays opt-in,
  but mu-next refuses a `MU_SYNC_DIR` where any file is 3.x evidence: a `*.jsonl` segment opening
  with a v1 line, or a `*.manifest` with `"v"` below 2 (a 3.x peer with no ops yet leaves an empty
  segment and a v1 manifest). Read and write: exit 4, `MU_SYNC_DIR holds 3.x segments; give
  mu-next its own dir`, nothing read or written (`SyncDirForeignError`; checked in `handle()`
  before the DB opens and again inside `flushSegment`, `discoverPeers` and `ingestSegment`
  themselves, so SDK callers are covered). The vitest real-DB guard and the global teardown
  now cover both the mu-next and the 3.x default DB paths. Remote worktrees move to
  `~/.local/state/mu-next/remote-worktrees`.
- **mu-next design: a model-run move recipe replaces the import and the flag day.**
  mu-next runs beside 3.x with its own DB, state, sync dir and machine id; the 3.x DB
  stays a read-only archive and workstreams move one at a time
  (docs/mu-next/README.md, Move). Docs only.

- **Root `-w` reaches every verb as its own shape** (`bug_delegates_global_w_not_a_string`):
  `mu -w auth delegates tally --wave w1` (and `delegates register`) died `value.trim is not a
  function`, because `optsWithGlobals()` let the root's raw array overwrite the verb's `-w`. The
  forwarding hook now settles the root to what the verb holds. A test walks every verb with a `-w`.

- **`mu log --tail 20` no longer writes** (`bug_log_tail_n_writes`): `--tail` is a boolean, so the
  guessed `20` was logged as text. A positional with a read flag (`--tail`, `--all`, `--since`,
  `--after`, `--seq`, `-n`, `--source`, `--intent`, `--group`) now exits 2 and writes nothing; an
  integer gets "did you mean -n 20?".

### Removed

- **Leftovers (`k_cut_now`).** Segment lines are v2 only: the v1 reader, the encoder's
  v1 field guard and the keep-other-versions repair (`entriesOf`, `repairKeepingLines`,
  `opsBetween`) are gone, and a v1 line is refused like any unknown version. `openDb`
  accepts only schema 13 (v12 is `SchemaTooOldError`); the `vcs_workspaces` migration
  (`migrateLegacyWorkspaces`) and the missing-`capture_version` repair are gone. SDK/test-only
  exports removed: `capRecords`, `formatReadyTable`, `formatTaskListTable`, `boundedCommand`,
  `COMMAND_MAX_BYTES`, `showAllCommand`, `taskItem`, `taskRecord`, `tryResolveTaskId`,
  `tryResolveAgentId`, `ReaperDetectedDuringWaitError` (never thrown), `isUnscheduled`, `UNSCHEDULED_SUBSTATES`, `cmdMe`,
  `getActiveCommandForTest`, `clearActiveCommandForTest`.
  **SDK removal (no product caller):** the old doctor summary (`loadDoctorSummary`,
  `loadDoctorChecks`, `countProblems`, `yankCommandForCheck`, `remediationParagraph`,
  `DoctorSummary`), the old `WorkstreamSnapshot` loaders and helpers
  (`loadWorkstreamSnapshot[Fast|Slow]`, `mergeSnapshotFastSlow`, `roiBucket`,
  `agentStateHistogram`, `summarizeOwnedTasks`, and their types) and the old DAG
  renderers (`loadFullDag`, `renderForest`, `renderTaskTree`). `mu state` reads
  `stateSnapshot`, `mu doctor` runs its own checks, `mu task tree` reads
  `loadOpenTaskFrontier`.

- **`mu agent remote-env` and the `REMOTE:` / `REMOTE_BASE:` note convention.**
  A host profile's shell template carries the forward and the env now
  (`mu host init <host> --ssh` prints a starter). `mu state` reads remote
  workers from the registry, and `mu task claim --for` no longer prints the
  mule poll-and-close step (the task's close is yours, once the work is collected).

- **`mu link pi` and its shims.** pi now loads mu as a package: `package.json`
  declares `pi.extensions` (`./dist/extension/mu-pi.js`), `pi.skills`
  (`./skills`) and `pi.prompts` (`./prompts/*.md`), and lists
  `@earendil-works/pi-coding-agent` as an optional `*` peer (never bundled).
  Install with `pi install npm:@mu-crew/mu`. The extension no longer
  registers prompts through `resources_discover` (the manifest ships them),
  and `MU_EXTENSION_ENTRY` is gone.

### Changed

- **`mu state` and `mu me` are one canonical JSON document** (`v_state_log`, slice A). `mu state` no longer prints a card:
  by default (no `--json` needed; errors included, parse-time and handler) it prints one envelope
  `{ caller, me, workstreams: [...] }`, one entry per workstream (`-w a,b` / `-w a -w b` / `-w a b` / `--all`, one name is
  still an array of one) with `counts`, `ready` (ROI order), `in_progress` / `blocked` / `triage` / `recent_closed` (newest
  activity first: raw `MAX(ops.seq)` over the task's own, its notes' and its edges' ops, so a `mu sql` write counts),
  `agents` (the registry record, `host`, `cwd`, `base`, `collected_head` included, with its runtime state; unknown stays
  unknown), `orphans`, and **the caller's own** `delegates` (unfinished calls), `waves` (tally of its own calls only) and
  `human_needs`. Keys are SQL column names (`workstream`, `effort_days`, `recent_closed`; the camelCase `workstreamName`,
  `inProgress`, `tracks`, `recent` ops and `remoteWorkers` keys and the `--events` flag are gone: `mu log` owns the ops).
  The read is capped at 4096 final bytes: every string is one escaped line of at most 160 characters, lists shrink, then
  whole workstreams page; a cut says `more=N` / `cut=N` and `retrieve` names `mu state ... --full`, the uncapped read. `mu state -w`
  reconciles first (reaps gone panes, lists orphans); `--me` and the SDK read never touch the mux. The last fallback is
  checked too: when nothing fits, a zero-workstream envelope whose `retrieve` is the short `mu state [--me] --all --full`
  (when the scope names are too long) and whose strings shrink below 160 characters until the final document fits.
  **`mu me` is exactly `mu state --me`** (bare `mu me` now runs instead of printing help; `me --include-closed` is gone;
  `me tasks` and `me next` stay, `--json` explicit). Identity is the injected `<MU_WORKSTREAM>/<MU_AGENT_NAME>` row looked
  up in that workstream, else `pi:<PI_SESSION_ID>` (a session has no agent row; its scope is where it has delegate calls or
  human needs); `$TMUX_PANE` identifies nobody on this path, and no identity is a one-line `UsageError`. `isJsonMode` also
  defaults `state` and bare `me` to JSON. SDK: `stateSnapshot`, `callerWorkstreams`, `readLiveAgents` (the read-only half of
  `listLiveAgents`) and the `State*` types are exported; `verdictTally` takes an optional caller; `listRemoteWorkers`, the
  track/ready/log card renderers and `scratchIdleNudge` are removed (the `WorkstreamSnapshot` loaders stay for doctor).
  A workstream past 300 tasks and under 10% open carries a `hint`.

### Added

- **Delegates are durable tasks: `mu delegates`, `mu_delegate_reissue`, wave tally** (`v_delegate`, part A: the mux path;
  delegates with no tmux or herdr are `v_delegate_nomux`). Every `mu_delegate` call is a `kind=delegate` task
  (in `scratch` or the new `workstream` option) with the prompt as its brief and a session-qualified `call_id`
  (`pi:<session>:<n>`), created with its `delegate_calls` row in one transaction (SDK `registerDelegateCall`; the same id
  with the same request is a no-op, a changed request is refused, exit 4; the `record` target must exist or nothing is
  written). The tool result is `{ task, state, call_id }`; new optional `wave` groups a fan-out. States: `queued starting
  running recording done failed refused cancelled`. A queued or refused task is parked, so it never reaches `mu task
  next` or an executor. The delegate is spawned through the task-bound `agent spawn --task <task> --attempt <task>`
  (the journaled path: a replay never sends twice, and a replay or stale receipt, which carries no top-level `ctl`, is
  handled). The one recorder, `finishDelegate` / `mu delegates finish`, commits `recording`, then writes in ONE op group
  the verdict note on the judged task, the delegate's report and its close; the delegate task is closed before the
  pane. A failed record leaves the call `failed` (task closed `rejected`, the answer kept as its report, the pane kept),
  never `done`; a repeated callback writes nothing twice. **Refused, not thrown:** past `MU_DELEGATE_MAX` plus four
  caps' worth of queue a call is recorded as `refused` with its brief and record target, outside murmur's
  `murmur:pending` count (payload unchanged); `mu_delegate_reissue { call_id }` moves it
  back once, same call, same task (`mu delegates reissue` refuses and names the tool: only the live runtime that holds
  the queue can start or drain a call, so a shell reissue would strand it as `queued`; `mu delegates mark <id> queued`
  is that runtime's step). A `/reload` or quit parks queued calls as `refused` instead of dropping them.
  **Full evidence:** the verdict is the FIRST line that is `VERDICT:` or `<WORD>: VERDICT:` (nothing else before it; later `VERDICT:` lines are
  evidence text, kept verbatim), the verdict note keeps everything from it on, and a
  note without one keeps the whole answer; the 4000 and 1500 character caps are gone, and the same answer is the
  delegate task's report. New verbs: `mu delegates list [--caller|--all|--wave|-w]`, `show`, `tally -w <ws> --wave
  <label>` (CONFIRMED/REFUTED/UNVERIFIED per judged task, one result per call, queued/running/refused counts),
  `register`, `mark`, `finish`, `reissue` (refuses). SDK: `registerDelegateCall`, `markDelegate`, `finishDelegate`,
  `listDelegates`, `getDelegateCall`, `verdictTally`, `parseVerdict` (package entry).
  `addTask` takes `kind` and `wave`. `delegate_calls` gains `request`, `verdict` and `agent` (nullable; v13 is
  unreleased, so no version bump). Unchanged: `MU_DELEGATE=0`, the managed-agent no-recursion guard, `answerPending`,
  the arriving/stub/single-resend/Escape machinery. `extension/delegate.ts` is split (`delegate-calls`,
  `delegate-format`, `delegate-args`, `delegate-trace`, `mu-run`).

- **Wait registrations and one typed agent observation (storage and seams for
  the unified wait; no new verb).** The machine-local `wait_registrations`
  table (`caller`, `refs_json`, `state` armed|waiting, `generation`,
  `updated_at`; no foreign keys, never synced, not rebuildable and reported as
  lost) records the typed refs (task, agent, delegate) a caller still owes a
  wait. `registerOwnedWait(db, caller, refs)` validates, merges and dedupes
  (at most 256 owed; one bad ref stores nothing). Every ref must exist when
  registered, checked inside the registering transaction: the task or agent in
  its workstream, the delegate call exactly as `delegate_calls.call_id` stores
  it (no id grammar of its own), the workstream; a missing one refuses the
  whole call with one line naming it. A ref whose entity is deleted later stays
  owed. `beginWait` bumps the
  generation and marks `waiting`; `endWait(db, caller, generation, delivered)`
  is a compare-and-set that removes only the delivered refs, so an older wait
  finishing late cannot overwrite a newer one and an undelivered sibling stays
  owed. Each write is one short transaction, never held across an await, and
  nothing here touches `wait_cursors`. `AgentObservation` (`observeAgentStates`,
  `watchAgentRun`, `settledCloseInput`, `toStatusSnapshot`) carries the registry
  id and pane, pi's incarnation, the settled run count, `settled`, the final
  text with `lastTextTruncated`, `pending`, source/since and the session file;
  `mu agent wait` now builds its watch and reads on it, output unchanged.
  `readAgentStates` also returns ctl's `incarnation`. Producers do not arm yet
  (that is `v_wait_cli`). No schema bump: an existing v13 file gains the table
  on open (same-version additive repair).

- **Close or collect the remote worktree a removed agent left (`v_remote_recovery_close`).**
  `mu agent close <name>` with no agent row and no local orphan now selects the ONE
  `remote_recovery` record of `<ws>/<name>` and closes THAT worktree under the unchanged remote
  rule (`closeRemoteWorktree`: quiescence, common-git-dir check, clean + base/collected HEAD or
  create-only `--keep-branch`, no `--force`, dirty refuses under every flag), through the
  ORIGINAL incarnation's aside, so a close that crashed after the move and was then reaped
  resumes from the aside it left. No agent returns and no pane or task is touched. Several records
  of one name refuse (`RemoteRecoveryRefusedError`, exit 4) and list their ids; `--recovery <id>`
  (SDK `recoveryId`) picks one. The preview reads only (no remote command), reports
  `kind: "recovery"` with `recovery_id` (`id` stays the registry incarnation, null here) and a
  `rev` derived from the record (`agentRevision(db, ws, name, recoveryId?)`), plus the refusal an
  apply would hit now. An explicit `--recovery <id>` that is gone never falls through to a live
  agent: close is a no-op, the preview is `kind: "none"` (rev 0, no apply hint), collect refuses. Apply holds the agent lock, checks the revision, and compare-and-sets
  the record and the registry before the removal; the record is deleted only when the tree is
  removed, kept on a branch or gone, and only that record. A current agent of the name or on the same
  host and path, a NEWER record of the same host and path (a reused name lands on the same
  deterministic path: only the newest record acts, the older refuses naming it), a missing or replaced host profile, and a record written without a profile
  identity refuse before any exec. `mu agent collect <name>` (also `--recovery`) works on a
  record the same way (same fetch, repo lock and exact-SHA pin; the record's `collected_head` is
  compare-and-set) and refuses to move the one `refs/mu/collect/<ws>/<name>` pin while another
  record of that name relies on the commit it holds. A removed agent's `-w <ws>` or `<ws>/<name>`
  works after a reinit or when the workstream has no live agent. `cmdClose` moved to
  `src/cli/agent-close.ts`. SDK: `selectRemoteRecovery`, `recoveriesFor`, `getRemoteRecovery`,
  `RemoteRecoveryRefusedError`, `CloseAgentOptions.recoveryId`, `ClosePreview.recovery`.

- **One owned-event wait engine** (`v_wait_engine`, slice B of `v_wait_core`).
  `waitForEvents(db, refs, opts)` (`src/wait.ts`, also exported from the package)
  is the only wait loop; `waitForTasks` and `waitForAgents` are adapters over it
  (`callers: []`, `eventScope: "refs"`) and keep their outputs; the
  `mu task wait` / `mu agent wait` / extension consumers are unchanged until
  `mu wait` (`v_wait_cli`). One iteration reads the DB, makes ONE batched agent
  read, applies settled CLOSE blocks and picks; then it races an agent ctl
  watch settling, the poll sleep, abort and the deadline. A blocking watch is
  never awaited serially and every read is raced with abort and deadline, so
  twelve delegate reports surface one per wait while four workers stay busy.
  `WaitOptions`: `callers` (a SET: the managed `<ws>/<agent>` that owns spawned
  workers and human stops, and `pi:<session>` that owns delegate calls;
  `currentCallers()` reads them from the env; owned refs, delegates, human
  needs and the wave tally are the union, `[]` owns nothing and a wave with no
  callers is refused, never an all-caller fallback), `mode` `first|all`,
  `eventScope` `owned|refs` (`refs`: only the listed refs end the wait and
  nothing owned is seen or consumed; the delegate recorder uses it), `wave`,
  `blockersOf`, `status`, `until` (`idle` or a bounded `{text}` regex),
  `timeoutMs` (default and cap 1500 s, 0 means the cap), `stuckAfterMs`,
  `onStall` `exit|steer|release` with `handleStall`, `signal`, `pollMs`,
  `beforePoll`. `WaitResult`: `event` (`closed settled input dead stall delegate
  heartbeat interrupted`), `refs` snapshots (they keep the observation facts:
  `agentId`, `paneId`, `incarnation`, `settled`, `runs`, `lastText` +
  `lastTextTruncated`, `lastError`, `sessionFile`), `timedOut`, `interrupted`,
  embedded `exit` (0, 6, 7, 130), `cursor`, `humanNeeds`, `tally`, `action`.
  **Stalls**: the engine detects them (an IN_PROGRESS `kind=work` task whose
  owner sits needs_input, or behind a dead control socket, for `stuckAfterMs`;
  default 120 s, 5 s over a working ctl socket) and returns a `stall` event
  (exit 7). With `onStall: steer|release` and a `handleStall` it hands the
  stall over once per `stallToken`: the hook is raced with the loop, so a slow
  steer never starves an owned delegate report or a death; `continue` keeps
  waiting without consuming the ref, `return` ends the wait with the action on
  the result; a throwing hook is an honest `unknown`. The policy and effects
  (release, steer, receipts, budget) are `v_wait_actions`'; the engine has none.
  **first** returns the best event (dead, input, stall, delegate, then
  closed/settled; listed refs before owned); **all** returns when every target
  is done, and an urgent owned event ends it early without counting toward
  "all". Only DELIVERED refs are consumed: their typed cursor tokens
  (`wait_cursors`: an agent's ctl incarnation + settled run, a closed task's
  newest note id, a delegate's terminal state) and their removal from the
  registration are one transaction guarded by each owning caller's generation,
  so a sibling `first` did not return stays owed, history is not replayed, a
  stale high run count never hides a new pi process, and an older wait
  finishing late consumes nothing (`superseded`). **Producer fence**:
  `wait_registrations.baselines_json` (additive column, same-version repair)
  stores per agent ref the UNCONSUMED baseline a producer registered
  (`registerOwnedWait(..., {..., baseline: {afterRuns, incarnation, agentId}})`),
  distinct from consumed cursors: the ctl watch counts an owed ref from
  `max(baseline, same-incarnation cursor)` when the baseline's registry id and
  incarnation still match, so a send that settles before any wait starts is
  caught; a baseline of another process or a replaced registry row is ignored;
  it is dropped when its ref is delivered. **Round 2 (durable, exactly-once,
  fair)**: no per-wait memory decides what was seen. An event is consumed only
  when it is the one returned; every kind has a cursor key (a `blockersOf`
  blocker seen open is recorded under `open|`, so a sibling close that a `first`
  did not return stays owed; an unchanged dialog, dead owner or stall is
  recorded under `input|`/`dead|`/`stall|` with a token naming its state, so it
  is news once per state change and never outranks a never-returned event, a
  delegate report included). The fence applies to every registered agent ref,
  explicit or owned, and an owed ref with no fence and no cursor counts from
  the run count probed now (stored as its fence, `unknownBaseline` on the
  snapshot): a historical run is never completion. A settled pi run's CLOSE block is
  applied once before the snapshot returns; `applySettledClose` refuses
  delegate tasks like human ones, so a delegate answer ending in a CLOSE block
  cannot close its task ahead of `finishDelegate`'s recorder. `verdictTally`
  takes `callers?: readonly string[]` as its 4th parameter (one form; `mu state` passes `[caller]`; and `listDelegatesOf` the union) so waves with one name
  stay apart. `--until-text` takes a bounded regex (`src/wait-regex.ts`): at
  most 200 characters, no backreferences or lookaround, no repeated group
  containing a repeat or an alternation, counts up to 1000, matched on the last
  8 KiB inside a 50 ms `node:vm` budget; a refused or runaway pattern is a typed
  error, never a hang. Not here: stall policy and effects (`v_wait_actions`),
  the `mu wait` CLI and signal wiring, and arming from spawn/send/claim
  (`v_wait_cli`).

- **A deleted remote worker row no longer takes its worktree's location with it.** A new
  machine-local table `remote_recovery` (no foreign key, no op, never synced) keeps, per
  ORIGINAL registry incarnation, the host, worktree path, base, last collected HEAD, the exact
  `.mu-removing-<id>` aside path and the profile's exec/repo of a finalized remote row, written
  by the DATABASE: an AFTER DELETE trigger on `agents` (and a BEFORE DELETE one on `workstreams`
  for the cascade), so every path that deletes the row is covered: the reaper (`deleteAgent`,
  so `reconcile` too), `workstream teardown`, reinit, a peer's workstream tombstone, and plain
  `mu sql "DELETE FROM agents"` / `"DELETE FROM workstreams"`. A failed identity check or a
  rollback records nothing and deletes nothing; local, cwd-only and base-less rows record
  nothing; an `agent close` that removed the tree itself records nothing. The DDL lives in
  `src/db-recovery.ts` (db.ts stays under its file cap). Teardown now
  deletes its dead rows through the same reaper step, which also fixes a task left
  `IN_PROGRESS` with no owner: it reopens with a `[reaper]` note, as after any reap. Storage
  only here; the readers follow below. Records are lost by
  `mu rebuild` (reported with the other machine-local tables): back up the source DB. SDK:
  `listRemoteRecoveries`.

- **`mu db query` / `mu sql` print JSON by default, paged like task lists.** A read's
  `data` is `{items, count, more}` (was a bare array): rows are kept whole while the final
  document fits 4 KB, `more` counts the rest and `retrieve` is the same query with the new
  `--all` (every row, whole). One row over the cap gives zero items and `retrieve`; cells are
  never cut. `--table` prints the old human table and prose. Parse-time, scope and DB-open
  errors are the JSON failure document too (for these two verbs only; every other verb still
  needs `--json`). Writes keep `{changes, lastInsertRowid}` / `{statements, multiStatement}`;
  `UPDATE ... RETURNING` prints its rows whole with no `retrieve`. Callers of the bare array
  (`.data[0]`) read `.data.items[0]`.

- **`mu next --workers <n>`: the worker ceiling is enforced, not prose (`df1_ceiling_not_enforced`).**
  No new pane while `n` workers are WORKING: an agent that owns an IN_PROGRESS task, or holds an
  executor attempt in flight (`pane`/`claimed`/`sending`/`unknown`) for a task that is not CLOSED.
  An idle worker whose task is CLOSED (its close applied, its pane not yet closed) is free, so a
  third worker may start the moment the second's task closes. Checked at the loop and again in the
  spawn guard (a slot taken by a peer after the check rolls the reservation back unsent, charge
  kept, resumable); a reserved attempt that has no pane waits for a slot, one that has its pane is
  replayed regardless, and an in-place API-error retry needs no pane so the ceiling never holds it.
  A refusal is free (an `attention` move, `stopped: "workers"`, nothing reserved or charged);
  `--hold` waits at the ceiling and dispatches when a task closes. No ceiling by default.
- **Executor slice B: `mu next`, dead versus live-error recovery, bounded `--hold`, signals
  (`v_exec_recover`).** `mu next [--dry] [--hold] [--cap N] [--timeout s] [--on-stall
  exit|warn|steer|release] [-w ws]` prints ONE JSON envelope (`data.moves`, `used`, `stopped`,
  `held`, `exit`; 4 KB on final bytes, moves cut from the end with `movesCut`). Exit 0 done or
  capped, 1 an unsent spawn failed, 6 a worker died with nothing more to do, 7 a stall, a dialog or
  this caller's human need, 130/143 a signal. Recovery splits on what the pane says. A worker whose
  PANE IS GONE (`status null`) is reaped through `deleteAgent`'s registry-id + pane compare-and-swap
  (no new reaper) and its task, reopened with the reaper's note, is allocated again as a new attempt
  whose brief says the previous one died; a task a human reopened (no reaper note) is never
  re-dispatched. A LIVE worker whose last settled run ended in an API error is never reaped or
  duplicated: it is retried IN PLACE (`reserveRetry`, auto-attempt.ts: one run charged, a new
  `auto:<n>` receipt starting at `claimed` on the saved identity) over the same journaled
  `spawnAutoAttempt` send, with a reserved msgId and `expectIncarnation` bound to the pi that
  errored; an unsent failure (`keepAgent`) fails the receipt and keeps the worker, its claim and its
  worktree; a send that may have landed is probed once and never resent. The error is read over a
  ctl `wait` past `runs-1` (a status read does not carry it), bounded by 3 s and the signal. A busy,
  dialog-blocked, pending, unreadable or merely idle worker is left to the wait. A remote worker's
  tree is never reaped, retried or collected from here; an error or death at the run ceiling is an
  `attention` move that says what to raise. `--hold` dispatches once, then waits
  (`waitWithActions`, `eventScope: refs`, bounded by `--timeout`, default and cap 1500 s) for the
  first event on the in-flight workers, each worker's agent ref bound to its delivered run count and
  pi incarnation; a death or an API-errored settle is recovered and the wait goes on, anything else
  (closed, a clean settle, a stall, a dialog, a heartbeat) is returned. `--dry` reads no pane or
  socket and writes nothing. SIGINT/SIGTERM are installed before the DB opens and stop between
  effects; the one result says `interrupted`. The cap counts reaps and retries. `buildTaskBrief`
  takes `retry: true | "error"`. `casReceipt` (receipts.ts) is the compare-and-set a send fence
  needs. Eval: tier 1 and tier 2 on `fanout_gates` and `api_outage_resume`
  (`docs/mu-next/eval/units/v_exec_recover.jsonl`).
- **Executor slice A: attempt reservation, `buildTaskBrief`, guarded replay, dry run and cap
  (`v_exec_dispatch`; SDK only, the `mu next` verb, recovery and `--hold` are slice B).**
  `executeNext(db, {workstream, caller, dry?, cap?})` resumes stored attempts, then spawns, claims
  and briefs `authorisedReady` tasks; it never calls `authorizeTasks`. An attempt is
  `auto:<n>` in `spawn_receipts` with its record (name, cli, worktree, pinned brief/report note
  numbers) in `task_auto.last_spawn`. `reserveAttempt` charges the run, writes the record and the
  `reserved` receipt in ONE immediate transaction that re-plans first (revision CAS), so two `mu next`
  mint one attempt. A run is charged once per new attempt, never for a replay, receipt check or
  UNKNOWN probe; an unsent failure keeps its charge and its failed key is never reset (the next
  attempt is a new key and a new charge), so real spawns never exceed `max_runs`. Stored attempts
  (even a final one, which `authorisedReady` no longer lists) are resumed under their own key
  before anything new is allocated. `spawnAutoAttempt` (task-spawn.ts) is the guarded replay:
  permission is re-read before the pane and inside the pre-send transaction (a revoke is an unsent
  rollback). `buildTaskBrief` is the first `brief` note verbatim + the latest `report` note + one
  task/CLOSE footer, pinned by note number so a replay rebuilds the same text; no brief, no
  attempt. `cap` is an integer 1..100 (default 5) counting every effect (replays, spawns,
  failures); `dry` is the same selection over the read-only planner (no ingest, lock, mux call,
  receipt probe or write; tested on a readonly DB handle). This caller's open human need stops
  dispatch. New errors: `SpawnAttemptFailedError`, `SpawnAttemptGuardError` (exit 4),
  `TaskBriefMissingError` (4), `NextArgError` (2).
  Round 2: `last_spawn` stores the EXACT prompt and a replay sends those bytes (no rebuild, no
  pins, no drift). Every stored attempt reaches a terminal state on the first `mu next` that
  sees it unreconcilable (task closed, agent gone, receipt that disagrees with its stored
  request, UNKNOWN the one probe cannot confirm): `abandoned` (nothing was sent) or `needs_human`
  (the prompt may have landed: never resent; a one-line human need is recorded for the caller).
  An ended attempt is never replayed and never counted again. The cap counts every external
  effect, including a spawn the send guard rolled back (`rolled_back`). This caller's human
  need is checked right before each spawn and send, not only at the top of the loop.
- **`mu task auto <ids…> | --blockers-of <u> --cli <key> [--worktree] [--max N] | --off`:
  explicit, host-fenced permission for `mu next`.** Ready is never permission.
  `auto` stores the cli key, worktree mode and run ceiling in the machine-local
  `task_auto` row and, in the same transaction, writes the synced
  `dispatch_host` = this machine; the whole batch is checked first, so a
  refusal (another host's designation, a human/delegate task, parked, triage,
  CLOSED, the `scratch` queue) writes nothing (exit 4). `--blockers-of u` adds
  every open transitive blocker of `u` (uncapped, same workstream, not `u`).
  `--off` revokes this machine's permission and clears `dispatch_host` only if
  this machine holds it; it keeps `runs` and the spawn-replay receipt, and
  re-authorising never resets them. SDK: `authorizeTasks`, `autoPermitted`
  (enabled + `kind=work` + `dispatch_host` is this machine; ignores status, for
  steer/release) and `authorisedReady` (ready + permitted + `runs < max_runs`).

- **`mu human-needed <reason>`: a durable, caller-scoped stop for a human decision.**
  It records a `human` task (OPEN/parked, brief = the reason) and a new
  machine-local `human_needs(task_id, caller)` row in one transaction, the
  caller being the managed `<ws>/<agent>` or `pi:<session>` (no identity: exit 2;
  no shared `$USER` fallback). The same caller and reason is a no-op; a new
  reason appends a brief. `openHumanNeeds(db, caller)` lists only that caller's
  open needs. No error or queue refusal records one. A `human` task resolves only
  by an explicit `mu task close`: `task unpark`, `task claim` (even `--force`) and
  a settled CLOSE block are refused (exit 4, one line naming `task close`);
  every path back to OPEN (`task open`, `release --reopen`, the reaper) lands it
  in parked, never todo; `task show` no longer hints `unpark` for it.
  `human_needs` is machine-local and joins `UNREBUILDABLE_TABLES`: `mu rebuild`
  keeps the task and brief but cannot restore who recorded it, and reports the
  loss. No schema or capture version bump (an additive table; same-version
  repair creates it).

- **`mu host add | list | show | rm | init --ssh | check`: ssh-free host profiles.**
  A profile is your `--shell` / `--exec` / `--fetch` templates, a `--repo` and
  an optional `--max-sessions`, stored machine-local in the existing
  `host_profiles`. mu fills `{env}`, `{cmd}`, `{local_sock}`, `{remote_sock}`
  and `{cwd}` in one pass (each value one shell-quoted word, exactly the text
  you passed even inside your own quotes; `{cmd:sh}` etc. add a second-shell
  layer for ssh-style remote command text; `{env}` only the five whitelisted
  identity variables, every value shell-quoted, never the local DB, state or
  sync dir; `{{` `}}` literal braces; anything
  else refused) and runs the result with `/bin/sh -c` as its own process group, reaped on
  timeout or caller exit before its channel is freed. The group id is recorded on
  its `host_channels` row before the command starts, and the slot stays held while
  that group lives, even after the caller died by SIGKILL (the next admission no
  longer reclaims it under a live transport); the exit hook stays installed until
  the reap finishes, not just until the shell closes. It knows no ssh flags:
  `host init <n> --ssh` only prints a starter, and `host check` runs only the
  stored `--exec` (host answers, repo, `pi --version`, `pi list` names mu;
  `--agent <n>` also probes that agent's forwarded socket). A failing step is
  reported, never retried (exit 5). `host_channels` (new, machine-local) counts
  every channel against `--max-sessions`: reserved under `BEGIN IMMEDIATE`
  (the profile's cap is read in that transaction) before the connection opens, released by token, and a refusal names the
  holder (exit 4). A transient channel is reclaimed only when its pid is
  proven gone; an attached one rides the agent's registry id and pane and is
  reclaimed only when the pane is proven dead. `rebuild` reports its rows as
  not rebuilt. `spawn --host` reserves and binds them (below).

- **`mu agent spawn --host <profile> [--worktree] [--cwd <remote dir>] [--task t --send ...]`: remote spawn, the pane is the transport.**
  The local pane runs the profile's `--shell` template (`exec env -u <local MU_* vars> /bin/sh -c`), filled with the remote
  identity, your `--command` (default `pi`), the derived local socket, the
  remote socket (`/tmp/mu-<uid>/<ws>/<name>.sock`) and the remote cwd; the
  template starts the remote pi and forwards its ctl socket to the local path,
  so every ctl verb, receipt and handshake works unchanged and **the pane
  dying is the agent dying** (close, reconcile, teardown need no remote case).
  `--worktree` makes a detached `git worktree add` of HEAD (or `--from`) in the
  profile's `--repo` through its `--exec` (one short command, reaped before the
  shell opens, so cap 1 works), at `~/.local/state/mu/remote-worktrees/<ws>/<name>`
  on the host; `--cwd` resolves an existing remote directory the same way. Host,
  remote cwd and base are `agents.host/cwd/base`. The channel is reserved
  before the first remote command and bound to the agent's registry id and
  pane (`admitHostChannel`, `bindHostChannel`); `deleteAgent` and teardown
  free it. `--task` goes through `spawnForTask` (the same receipts, claim and
  incarnation-bound send as a local spawn; the receipt's request hash includes
  the host only when there is one). A failed spawn kills its pane, frees its
  channel and removes only the remote worktree it made, and only while that is
  still clean and at its base. The remote gets five variables
  (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_CTL_SOCK`, and new
  `MU_REMOTE=1`), never the local DB, state or sync dir, and its extension
  skips the close nudge (no mu DB there; you close). `--root` is refused with
  `--host`; herdr (`runsShellCommand: false`) refuses it in one line (exit 2).
  A failing remote step is exit 5 (`RemotePrepareError`). `mu state` lists
  remote workers from `agents.host/cwd/base` (`remoteWorkers[]` is now
  `{agent, host, path, base}`). Not yet: gate panes with a real exit status,
  detach and reattach.

- **`mu agent collect <agent>` and the remote close rule** (`v_remote_collect`).
  `collect` runs the host's `--fetch` template locally in the current
  directory's git repo, under one channel (at `--max-sessions 1` beside a live
  pane it is refused, naming the holder: the pane is the transport; no detach).
  FETCH_HEAD is cleared first and the commit it holds afterwards is pinned as
  `refs/mu/collect/<ws>/<agent>` and recorded as `agents.collected_head`
  (compare-and-set on id, pane, host, cwd and base); a failed or no-op fetch
  records nothing. It prints `git merge <sha>`, never runs it. `agent close`
  of a `--host --worktree` agent now kills the pane, then removes the remote
  worktree without `--force` only when it is clean and HEAD is the base or the
  collected HEAD. The removal proves quiescence instead of taking a lock (reftable
  ignores `HEAD.lock`): the tree is renamed to `<path>.mu-removing-<id>`
  (every writer addressing the old path fails), `/proc` (else `lsof`, else a
  refusal) must show no process with its cwd or an open file under it, and only
  then are HEAD and cleanliness re-checked with plain git, `--keep-branch`'s
  branch made create-only, and the tree removed. A holder (named by pid), a
  mismatch or a doubt puts the tree back and refuses. A close killed after the
  move is resumed by the retry (the aside name is derived from the row, so no
  record can be lost); it never reports `gone` while the aside exists. Otherwise it
  refuses (exit 4, `RemoteCloseRefusedError`); `--keep-branch` first makes
  `mu/<ws>/<agent>-<sha12>` at the observed HEAD in the remote repo; dirty
  refuses with or without `--keep-branch` and `--discard`. A `--cwd` agent's
  host is never touched. The close preview names the remote worktree (no
  remote command runs). A reaped or torn-down remote row still keeps no
  record: `v_remote_recovery`. A failed collect restores the ref's earlier pin; an
  unchanged collect is fenced by the same compare as a changed one.

- **Agent records are SQL-keyed.** `agent spawn`, `list`, `show`, `me` and
  `state` print each agent with the `agents` column names: `id` (the registry
  **agent incarnation**, what `agent close --if` compares), `workstream_id`
  (the real FK) beside `workstream` (its name), `pane_id`, `command_source`,
  `collected_head`, `created_at`, … The live facts follow, snake_cased and only
  when read: `state`, `source`, `ctl`, `ctl_socket`, `since`, `reason`, `idle`,
  `trust_dialog`. The deprecated `status` column is never printed. An `agent
  close` preview names its identity `id` and `pane_id` (was `incarnation`,
  `paneId`); verb-level keys (`send`, `nextSteps`, `workstreamName` on `list`,
  `revision`, `kind`) are unchanged. The SDK `AgentRow` stays camelCase: only
  the CLI maps (`src/agent-output.ts`). `mu_delegate` reads the new keys in the
  same commit (`agent.id`, `agent.pane_id`, preview `id`/`pane_id`), so a
  delegate still binds its cleanup to the one agent it spawned.
- **`mu agent spawn --task <id> --send <text>` is one journaled attempt**
  (`v_spawn_receipts`): spawn, **claim the task for the new agent**, send the
  text, pin it as the task's `brief` note (kept when one exists: no recursive
  copies, even across concurrent spawns). Each step is written to the new
  machine-local `spawn_receipts` table first (`reserved`, `pane`, `claimed`,
  `sending`, then `sent` or `unknown`; `failed` = definitely unsent), with the
  registry id and pane of the agent it created, no foreign key to `agents`.
  The same command again **replays**: the saved delivery (same `msgId`, `task:
  {replay: true}`), never a second prompt. `--attempt <key>` names the attempt
  (key `manual:<key>`, default the task id); a changed text or name under one
  key exits 4, reopened work takes a new key. A strict per-attempt lock
  excludes a second process (exit 4, `SpawnAttemptBusyError`).
  - Fails before the prompt could be written (ctl missing/refused, Claude's
    trust dialog, a failed claim, an extension that refuses): only the attempt's
    own pane, worktree and claim are rolled back (the existing identity-bound
    guards, unchanged; the claim is released only while the task is still
    owned by that agent and not closed) and the key can run again.
  - Delivery **unknown** (written, no reply; a pane that died after the write;
    a pane paste with no receipt): exit 1, pane and claim are kept (deleting
    the agent would reopen the task for another dispatch), the receipt is
    `unknown`, and a replay asks the extension once (`status {msgId}`) and
    never resends. An id the extension no longer remembers is still unknown.
  - A replay after the agent was deleted or its name reused reports the
    historical delivery with `task.stale` (`deleted` | `replaced`): the
    replacement is never claimed or sent to.
  - Every send after a spawn goes to the **created registry id + pane**, task
    or not: `agent spawn --send` (no `--task`) refuses with one line
    (`AgentReplacedError`, exit 4) when the name holds another agent by the
    time it writes (`sendToAgent`'s `expect`). With `--task`, one immediate
    transaction right before the write re-checks agent id + pane AND that the
    task is still owned by that agent and not closed (also on a resume from
    `claimed`): otherwise `SpawnTaskStateError` (closed/unowned, exit 4) or
    `TaskAlreadyOwnedError`, nothing is sent and only the attempt's own
    resources are rolled back. A fresh attempt on a closed task is refused
    before any pane exists.
  - Those sends are also bound to the **ctl incarnation** the spawn's own
    handshake saw (`SpawnedAgent.ctlIncarnation`, journaled in the receipt):
    the ctl `send`/`fresh` ops take an optional `expectIncarnation` (protocol
    additive, like `wait --inc`) and the extension refuses a mismatch with
    `incarnation mismatch` BEFORE dispatching, so a replacement pi that binds
    the same socket path after the registry check gets nothing (the same
    one-line `AgentReplacedError`; with `--task` it is definitely unsent). An
    extension that reports no incarnation is sent to unbound.
  - Seams: `TransportSendOptions.msgId` (a reserved id for ctl send/fresh;
    the default and `--interrupt` still mint their own), `claimTask`'s
    `expectedAgentId` (checked inside the immediate claim: a name deleted and
    recreated no longer hands the task to the replacement), `releaseTask`'s
    `expectedOwnerId`. `AgentPaneDeadError` carries the `msgId` when a send was
    written before the pane died. `--task` refuses slash/session-command text
    (no ctl receipt) and an already-owned task before any effect.
  - `mu agent check`: `not-accepted` no longer reads "resending is safe": an
    evicted or in-flight send also reads that way.
  - Not in this change (own units): `buildTaskBrief`, `wait_registrations`,
    the executor's `task_auto.last_spawn` attempts, batch spawn.

- **Task reads are bounded records.** `task list`, `next`, `owned-by`,
  `me tasks`/`me next`, `show` and `tree` print one escaped TAB-separated
  record per task or entry (`task id STATE impact=… effort_days=… [owner=…]
  title`, <= 400 characters, never sliced: a long title ends in `…`), and the
  whole result stays within 4 KB, serialized (text lines or the JSON document
  as emitted, escapes, edges, envelope and footer included) and shrunk by
  whole records. A cut ends `more=N cut=N next=<command>`, reserved before
  shrinking so it is never cut. **One way back, everywhere: the same command
  with `--all`** (`--json` kept; `--full` on `owned-by`, whose `--all` means
  every workstream), which prints everything uncapped and whole (every
  record, title, wave, host, neighbour and note; `tree` walks every level and
  CLOSED tasks too). `more` counts records left out, `cut` the characters a
  record clipped. No per-field, per-subtree or `--from` retrieval commands:
  `--from` and `show --edges-from` are gone (`task notes --from` stays).
  `list` takes `--owner <agent|ws/agent>` and `--mine` (the agent's real id,
  so same-named agents of two workstreams never mix). The owner shows only
  while IN_PROGRESS (`owner_id` stays the real FK). `--sort recency|age` adds
  the sorted timestamp. `--json`: items use the SQL column names (`id` =
  `local_id`, `workstream_id`, `owner_id`, `effort_days`, `scored`,
  `dispatch_host`, `kind`, `wave`, `created_at`, `updated_at`, plus `revision`
  on `list`/`show`, `workstream` on `show`/`owned-by --all`), never
  `name`/`workstreamName`/`effortDays`/computed `roi`; `data` is
  `{items,count,more[,cut][,retrieve]}`, and every `--json` document goes
  through the one inert envelope encoder (`encodeEnvelope`: C1, bidi and
  U+2028/9 escaped). `mu state` and `mu me` keep their tables.
  `extension/delegate.ts` and `extension/nudge.ts` read `id`/`workstream`; the
  nudges read uncapped (`--all`/`--full`) and treat a result that still says
  `more` as unknown, not "owns nothing".
- **`task show` is one 4 KB result.** The task is a record (`task id STATE
  … ws= created= updated= rev=`), then one `blocker|dependent id STATE`
  record per neighbour (still-gating first, CLOSED after), then the notes
  records, then one footer. The task record, edges and ordinary notes share
  the cap (the pinned brief, report and verdicts stay exempt); neighbours
  beyond their share, then ordinary notes, then the title are dropped until
  the emitted bytes fit. `--json`: `{task,blockers,dependents,edges_more,notes,
  notes_more,[cut,][retrieve,]lastClaimActor}`; `retrieve` is `show … --all`.
- **`task tree` is the open DAG, in records.** `loadOpenTaskFrontier(db, ws, root?,
  direction?, {uncapped?})` (exported from `src/index.ts`): open tasks expand,
  CLOSED ones are leaves (a CLOSED root still expands), at most 3 CLOSED
  neighbours per node are listed and the rest counted, depth <= 12 and <= 2000
  tasks, diamonds and cycles list once then `again=1`, one SQL read per level;
  `uncapped` lifts every cap and walks CLOSED too (`task tree --all`). Text is
  the task-record grammar: a `tree<TAB>root<TAB>direction<TAB>entries=…` header,
  one `task` record per entry (`depth=N parent=<id>` plus `kids=`/`closed=`/
  `capped=` for what hangs below and is not listed), no branch drawing, no
  colour; the page is a preorder prefix. `--json` is a flat preorder of the same
  items. `loadFullDag` keeps its whole-workstream SDK semantics.
- **Notes default view.** `mu task notes <id>` and the notes of `mu task show`
  print one escaped TAB-separated record per line (`kind n by= at= text`):
  the first `brief`, the last `report` (else the closer's last note, found
  from the `close` note's author at read time), every `verdict`, then the
  last 3 ordinary notes newer than the report. Those three kinds are never
  cut; the other notes are capped so the emitted bytes (text lines, or the
  JSON document with keys and `more`/`retrieve`) stay within 4 KB, pinned
  notes exempt (the output is serialized and the oldest ordinary notes are
  dropped until it fits, never predicted); one bigger than that is a stub (author and text clipped) with
  `cut=` and `next=mu task show <id> --note <n>`. `--all` on a task with no
  notes is an empty result (an explicit `--from 1` still exits 3). A
  trimmed view ends `more=N next=…` (`--all`, or `--from <n>`, pages the
  whole history whole). `n` is the note's 1-based number in its task, local
  to this DB. `--note <n>` on `show` prints one note whole; `n` outside
  `1..total` exits 3. `--tail/--since/--since-claim` keep their meaning.
  `--json`: notes records use SQL names (`n kind author created_at content`),
  plus `more`/`retrieve` (`notes_more`/`notes_retrieve` in `show`). SDK:
  `selectTaskNotes`; `listNotes` stays the full history.
- **Agent guards: `agent close` previews, `--if <rev>` applies.** Bare
  `mu agent close <name>` now writes and kills nothing: it prints the revision,
  the pane, the tasks the agent owns (an `IN_PROGRESS` one goes back to `OPEN`),
  the worktree state and the `--if` command (`--json`: one `{ok,data,next}`
  with `kind` `agent`/`orphan-worktree`/`none`, `revision`, `incarnation`,
  `paneId`, `ownedTasks`, `worktree`, `refusesDirty`). `--if <rev>` closes,
  and a stale one exits 4 with nothing killed (`expected_rev`/`current_rev`).
  An unknown name stays a no-op. A dirty worktree previews with no apply
  command (`--discard` previews the lossy close). The revision
  (`agentRevision`, src/revision.ts) is derived, with no column: a hash of the
  registry **incarnation** (the row's AUTOINCREMENT id, new for every row, so a
  name deleted and created again, even on the same pane id, never matches an old
  preview), the row's fields, every task it owns in any workstream, and its
  registered worktree rows; an orphan worktree has a revision of its own.
  Every agent-row writer now compares identity: `close` re-checks before the
  kill and before the worktree release and deletes by incarnation + pane
  (`AgentReplacedError`, exit 4, leaves a replacement's row, task, socket and
  worktree alone: closing used to delete a replacement registered during the
  kill), and `--worktree` spawn finalize, spawn rollback, reconcile and teardown
  act on the incarnation they saw. Close and `--worktree` staging/rollback take a
  per-agent lock that fails closed (`AgentLockBusyError`, exit 4, nothing done;
  `MU_AGENT_LOCK_TIMEOUT_MS`, default 15000): `withFileLock` gains `strict`,
  which reclaims an aged lock only from a dead holder, under an exclusive
  claim file with a re-probe (two removers never both proceed; an unreadable
  record or a crashed claim blocks), publishes the lock whole by `rename` (a
  failed metadata write is unavailable, never an unlocked run), and releases
  by ownership token. The spawn lock keeps its best-effort behaviour. Round
  two of the review: the close preview reads identity and revision in one
  synchronous snapshot after its git check (a replaced name is retried, then
  refused), the close kill and the spawn-rollback kill re-check the incarnation
  in the step that kills (a replacement on a reused pane id is left alone), and
  a staged `--worktree` spawn unlinks the ctl socket only while its own
  placeholder (own incarnation, still pending) holds the name. Round three:
  the preview reads in one SQLite read transaction (another process's
  replacement cannot land between identity and revision), a spawn rollback
  leaves a pane id any other agent holds, and frees a staged worktree only
  while the registry row at its path is the one that spawn wrote. `mu_delegate`
  keeps the pane and incarnation its spawn reported and closes through
  preview, identity check, `--if` apply; a missing identity, failed preview or
  replacement keeps the pane. Printed `mu agent close` hints now say "preview".
- **Task guards: `--if <rev>` and `candidate_ids`.** `mu task delete`, `block`,
  `unblock`, `reparent`, `claim` and `release` accept `--if <rev>`, the task's
  revision (derived from current state, never a counter: a hash of the task
  row, its owner, every incoming and outgoing edge (hashed in canonical order) and its note count, so a
  peer's synced edge, blocker delete or note moves it too; exact lookups, never
  LIKE, so `a_b` and `axb` do not collide; read after sync ingest, inside the
  verb's transaction). A stale one exits 4 with one line naming the fresh preview and
  writes nothing; `--json` carries top-level `expected_rev` / `current_rev`.
  `task show --json` has `task.revision`, `task list --json` a `revision` per
  item. A `task delete` preview prints `rev` and hints `--if <rev>`; `--yes`
  still applies. A multi-blocker `block`/`unblock` under `--if` is one fence and
  one transaction (a failing batch rolls back); without `--if` it keeps its
  sequential partial success. A wrong task id adds read-only `candidate_ids`
  from the given workstream only (case/`-`/`_`-folded, substring or a typo
  away), also on the unknown-id `delete` and `unblock` no-ops and on `note`,
  `notes`, `update`, `tree`, `close` and `wait` misses and on `task add
  --blocks`/`--blocked-by` misses; nothing writes through a
  candidate. Unknown `unblock`/`delete` ids stay no-ops. SDK: `taskRevision`,
  `RevisionMismatchError`, `ifRevision` on `deleteTask`/`claimTask`/`releaseTask`.
  Agent-side guards are a separate unit.

- **Eval `outside_mux` and `no_mux`.** `outside_mux`: the caller has `TMUX`, `TMUX_PANE` and `HERDR_ENV` unset (setup asserts it); the AUT runs one worker task and a two-claim delegate wave to completion, judged from effects (a worker commit on main, closes after the worker's block, a delegate-recorded verdict before each close, no turn end while work runs, no prod). It has a golden and bads on both families (3.13.3 can do it). `no_mux`: tmux and herdr are off mu's PATH; the AUT does DAG work and the judge runs a scripted check on a scratch copy of the DB: `doctor` and the agent verbs (plus `workstream init`, `state`) refuse with exit 5 and one stderr line naming the install, and task, `sql`, `db query` and `sync` work. 3.13.3 has no `db query`, its `doctor` exits 0 with no refusal, and its other refusals run over several lines: those ten entries are N/A baseline (`lifecycle.native`), listed by `check --verbose`, never a pass. `outside_mux` blanks the sandbox's `MU_MUX=tmux` so mu runs a plain shell's mux detection; `no_mux` syncs into a real scratch dir and requires a segment there. The worker driver treats a `delegate-*` agent as a delegate even though mu-next binds it to its own delegate task.

- **Eval `next` family: ten stable-surface scenarios.** `guessed_flag`, `guessed_sql_column`, `long_notes`, `wrong_id`, `worktree_reuse`, `teardown`, `remote_spawn`, `remote_close_block`, `single_channel_host` and `fanout_gates` have a `.golden.next.json` and the same bad set as 3.x, written against the built checkout (workers close with a CLOSE block and the AUT closes after `agent wait`; remote scenarios store a host profile with `fixtures.hostProfile`, spawn with `--host --worktree --task`, then `agent collect`). The judges accept a worker's `block` as well as `close` in `runs.log`, but only when the task's last close op (`task.close` or a block's `close.apply`) follows it (`closeEarnedWrong` in `fanout_gates` and `worktree_reuse`; three `bad-rv-*close-before-block` negatives); byte-identical `bad-rv7i-*` copies are deleted in both families; the 3.x scripts are unchanged and still pass on 3.13.3. `sshShim` hands `EVAL_DB_PATH` to the remote worker driver because mu-next strips `MU_DB_PATH` from the pane.

- **Eval `next` family: the loop scenarios.** `refute_verdicts`, `delegate_saturation`, `api_outage_resume`, `wait_helper_summary` and `wait_remote_gate` have live `.golden.next.json` and distinct `.bad-*.next.json` scripts against the built checkout (task-bound spawn, `agent wait`, workers' CLOSE blocks, `mu_delegate_reissue` for the calls the queue refused, a host profile for the remote gate). `wait_interrupted`, `wait_mixed_refs`, `wait_wave_six` and `wait_wave_starvation` need the unified `mu wait`: their scripts are `*.next.pending.json` (planned README surface), listed in `PENDING_NEXT`, which `check --family next` skips; the unit that ships the verb flips them (`tools/eval/README.md`, "Pending `next` scenarios"). Harness: a mu-next refusal is a durable non-error `REFUSED` result, so the judges count it as a refusal and a successful `mu_delegate_reissue` as the issue (`refusedNext`, `issuedDelegateArgs`); a faux call can take an arg from an earlier tool result (`argsFromResults`, for the refused call id); the worker driver treats `delegate-*` agents as answerers even though mu-next gives them a task; `api_outage_resume` accepts a CLOSE block as the worker's finish, and `wait_remote_gate` stores the host profile on `next`. Round 2: `wait_helper_summary` and `api_outage_resume` order a worker's CLOSE block against the close (`closeEarnedWrong`; new `bad-close-before-block` and `bad-close-a3-early` scripts, the duplicate `bad-self-wait-after-error` is gone); `test/eval/judges-effects.test.ts` runs every judge against closes that precede and follow a block record and fails if one accepts the early close; `refusedNext` and the reissue match read the tool result's recorded `details` (`state: refused`, `call_id`), the prose only as a fallback. The 3.x scripts are unchanged. Holdouts (`worker_dies`, `wait_receipt_race`) are not touched.
- **Eval: cold-guess probe** (`e_cold_guess`; `node tools/eval/main.ts cold-guess run|check|report`). Not a scenario: 17 one-sentence intents an orchestrator really has (owner of a task, a brief, open tasks blocked by one, close with evidence, spawn and collect on a host, log tail, what awaits a person, add tasks with an edge, reopen, delegates of a wave, a SQL read, stop a worker with unmerged work, what a worker is doing, list workstreams), asked of a model that has only that build's help (no skill, no tools). Its one command runs in a seeded sandbox and a judge reads the state (never the spelling; a stray write is a miss, a lost commit is destructive). `check` proves each judge with a golden, a bad and a no-op on both families. Round 2 (after a review found round 1's `collect` wording leaked next's verb and supplied the whole gap): requests are neutral and linted against every command, subcommand and flag name of both surfaces (`run` refuses a leak); both surfaces get `mu --help` plus every group's `--help`; the 14 pre-registered shared intents are the headline, two controls (`spawn_remote_named`, `add_three_titled`) are reported apart, with per-intent wins/losses/ties. 3 reps x haiku-5-5 + sonnet-5-5: next 92% (77/84) vs 3.13.3 71% (60/84), 3 wins (`agent collect`, `task add` without a score, `--host`), 0 losses, 11 ties; no destructive guess. `mu log --tail 20` writes a record `20` on both surfaces (`--tail` is boolean), though no round-2 guess typed it. Details in `docs/mu-next/eval/cold-guess.md` (rows in `cold-guess.jsonl`); feeds `t_surface` and `v_hints`. No `src/` change.

- **Eval judges assert effects, not command spellings.** The sandbox `mu` shim records
  every invocation (`mu-calls.log`) and tees the AUT's own output; the faux workers log the
  prompts they receive and the delegate answers they serve. Every judge now reads what mu
  and the workers observably did (a call that blocked, a timeout reported in its own
  output, a task observed CLOSED, the ops log's note/close/claim/SQL/teardown ops, a reset
  session, a worker commit that no longer exists anywhere) instead of matching `task note`,
  `mu wait`, `--until-*`, exit 5, `agent send`, `--discard`, delegate refusal prose or the
  tally's format. Prompts that dictated 3.x spellings (`wait_mixed_refs`) name the effect.
  `check` also runs `<id>.golden-<name>` scripts (the same job in another spelling), and
  `verdictFx` adds effect-based destructive entries to every judge: ALL 21 return through
  it (`test/eval/judges-effects.test.ts` runs every judge against a sandbox holding a raw
  write and fails one whose verdict lacks it), and a raw `mu sql` write to a machine-local table (agents, worktrees, ...,
  which writes no op) is caught by the shim's before/after fingerprint of those tables, not
  by the command's words (a write statement in argv counts, so `UPDATE ... RETURNING` is
  caught). `_smoke`'s golden falls back `--workspace` to `--worktree` like the others. The remote goldens apply the `agent close` preview (mu-next's
  close is preview then `--if`), which was the checkout's `single_channel_host` /
  `wait_remote_gate` red. Both 3.13.3 and the checkout keep every verdict (`check` exit 0).
- **Task mutations: batch add, `--blocks`, note aliases, insert-only note
  kinds.** `mu task add [ids...] -t <title> [-t …]` creates several tasks in
  one op group and transaction (one `-t` per id, or ids derived from the
  titles); `--note`, scoring, `--blocked-by` and the new `--blocks <umbrella>`
  (the new tasks block an existing umbrella) apply to all, and a duplicate id,
  missing or cross-workstream umbrella or a cycle rolls the whole batch back.
  Every initial note is kind `brief`. `mu task note` takes `-m/--message/--note/--text`
  (exactly one source), `--report` (kind `report`) and a hidden validated
  `--kind` the pi extension uses to write delegate verdicts (`mu_delegate`
  `record` now files `verdict`, not `note`). `mu task close --note` is an alias
  of `--evidence` (both is a usage error); `--report <text>` stores the report
  first, then the close note, then the status put, in one op group. A report
  is not evidence: a `done` close still needs `--evidence`. SDK: `addTasks` (exported from the package entry; omitted ids derive the next free `_N` suffix inside the transaction);
  `addNote`/`closeTask` accept `group: "inherit"` (join the caller's op group,
  actor and intent) and `addNote` returns `kind`. The `task add` id/title count
  mismatch replaces commander's "too many arguments" error, with the same
  heredoc hint. Note kinds stay set once at INSERT; the reader view is `v_notes`.

- **Schema 13: storage for task-backed delegation and loop provenance.**
  Portable (synced, segment format stays v2; a v1 line carrying `wave` or
  `kind` is refused): `tasks.kind` (`work` default, `delegate`, `human`;
  an unknown value from a newer peer is dropped by the fold, never a CHECK
  failure in ingest) and `tasks.wave` (nullable label); both per-field
  last-writer-wins, captured, drift-checked and rebuilt. Machine-local:
  `agents.spawner`, `host`, `collected_head`, and the tables
  `delegate_calls`, `wait_cursors`, `agent_settles` (no foreign keys, so
  replay evidence outlives the agent and task) and `host_profiles`.
  `spawn` records `agents.spawner` as `<MU_WORKSTREAM>/<MU_AGENT_NAME>` for a
  managed caller, else `pi:<PI_SESSION_ID>`, read from the caller's env;
  never guessed from task ownership. A schema 12 DB upgrades in place on
  its first open (columns, tables, capture triggers (revision 3) and both
  stamps in one transaction; a failure leaves the old file as it was).
  Rebuild reports the four tables' rows as lost like `task_auto`.

- **`mu pi migrate [--apply]`.** A leftover `mu link pi` shim would load a
  second extension next to the package, so this moves only files it can
  prove mu generated, into a `disabled/` folder pi does not read: a file at
  `~/.pi/agent/extensions/mu.ts` that is byte for byte the shim template every
  released `link pi` (3.2 to 3.13) wrote, with only its generated
  `file://…/dist/extension/mu-pi.js` import URL free to differ (no marker or
  import match: a commented import is not a shim), and a symlink at `~/.agents/skills/mu` into this install's `skills/mu` (or a
  copy identical to a released skill, by digest). Never a match on a marker
  or a `name: mu` anywhere else: a user's own `mu.ts` or `mu` skill is
  reported with its path and left alone. Report-only without `--apply`;
  prints restart guidance. The upgrade guide installs the package first
  (`pi install npm:@mu-crew/mu`), then migrates, then reloads.

- Eval harness (`tools/eval/`) and 3.x baseline (`docs/mu-next/eval/baseline-3.13.3-v2.md`; v1 superseded: delegate token, discard parse, send-before-claim, origin and PATH artifacts fixed; v2.1: discard scoring in fanout_gates/worktree_reuse, keyed delegate answers, TMPDIR and an in-sandbox skill copy, `--force` scoring). The scripted scenarios run on both surfaces: spawn falls back from `--workspace` to `--worktree`, so `check` is green on the checkout and on 3.13.3.

- **`mu agent send` returns a receipt; `wait --inc` refuses a restart; `mu agent check`.**
  A ctl `send`, `--fresh` and `--interrupt` carry a fresh `msgId` and return
  `msgId`, `incarnation`, `delivery` (`delivered`; `unknown` in the error JSON
  of a send with no reply, as structured fields beside `error`) and `runs`
  (`--json`); a successful send prints exactly ONE hint (the plain-send
  busy/`--fresh` nudges and the log hint are gone); the `Next:` line is
  `mu agent wait <a> -w <ws> --after-runs <n> --inc <i> --json`. A request
  written with no reply gets one `status {msgId}` probe: accepted is a
  success with `receipt: "confirmed-after-timeout"`, otherwise
  `AgentSendIndeterminateError` (exit 1, carries `msgId`, Next
  `mu agent check`); it never resends. New verb `mu agent check <agent>
  <msgId>` (`accepted runs=<n> at=<iso>` 0, `not-accepted` 3,
  `unreachable` 1; `--json`). `mu agent wait --inc <i>` raises
  `AgentRestartedError` (exit 4) on a mismatch reply or a reconnect that
  finds another incarnation (`waitForAgents` now propagates a rejected
  watch); `abort`'s wait carries the incarnation too. Before it relies on
  `msgId` or `incarnation`, the CLI asks `hello` (once per verb): a pi that
  loaded an older mu is refused with `AgentExtensionOutdatedError`, whose
  steps are ctl `/reload` (slash commands themselves are exempt), the mux
  reload line (`MuxBackend.reloadCommands`, herdr), then close + the spawn
  line rebuilt from the agent row. Machine-local `agents.command` and
  `agents.command_source` (in v12) record how a pane was started. The
  extension-less interrupt fallback (abort, wait, send composed by the CLI)
  is removed. `spawn --send` reports `msgId` and `incarnation`. `hello` lists `features`
  (additive; protocol v1).

- **mu-next surface contract (docs only).** `docs/mu-next/surface-contract.md`
  holds the planned contract and the unit that delivers each part;
  VOCABULARY gains a "Planned terms" section; the mu-next README says
  which sections are planned, and records that the `dec_*` spelling
  tournaments were dropped (the README defaults stand). Nothing in the
  CLI changed.

### Changed

- **`mu log` and `mu workstream list` are capped records.** Text is one escaped
  line per visible op (`log<TAB>seq<TAB>time<TAB>source<TAB>scope<TAB>what`, at
  most 400 characters; the parent-row touch an add-note writes stays hidden, as
  before) and one line per workstream. A result is at most 4 KB on its final bytes;
  `more=N next=<same read, continued>` and `cut=N next=<lossless read>` name the
  way back **by seq, never by filter**: `mu log --seq 5..9,12` (exactly those ops, each
  whole; no `-w`, no filter, nothing inherited from `MU_WORKSTREAM`) when the omitted ops
  are a few runs with no other visible op between, else `mu log --after <seq>` (the whole
  log, paged, from there). No filter, group or workstream name is ever echoed into a hint,
  so a hint is digits only and always fits, and a malicious historical group id cannot
  reach a shell. `mu workstream list [--torn-down] --all` reads a workstream page whole.
  Every JSON item, fixed fields included, is
  bounded to 2 KB, a page keeps no record when one would bust 4 KB, and the torn-down
  list's `Next:` block counts in the 4 KB. `--json` items use the
  `ops` column names (`key`, `actor`, `entity`, `group_id`, `created_at`, plus
  `rendered`), not `workstreamName`/`source`/`kind`/`group`/`createdAt`; clipped
  fields count into the item's `cut`. A log write answers with one such item; its text
  receipt is the same escaped, clipped record the log shows (plus `cut=N next=mu log --seq <n>`).
  `workstream list` gains `--all` (every row whole, no field clipped). The old tables are gone.
- **`mu log --tail` is always NDJSON** (no header line, `--json` not needed): one
  item per line, each bounded like a `--json` item with a `retrieve` command when
  it clipped something (`mu log --seq <n> --json`). Rows are written before the cursor moves (a failed write ends the tail with the seq it reached); SIGINT exits 130
  and SIGTERM 143 with every polled row already on stdout.
- **An op of an intent this build does not know prints as what the row says**:
  `op put|del <key> intent=<i> kind=<entity> patch=<fields>` (a prose payload
  follows). It no longer turns `workstream.delete` + `put` into a "workstream
  delete". `close.apply` is a known intent. `renderOp` no longer clips free text
  (note bodies at 60, prose at 120): the output boundary clips and counts.

- **`mu db query` replaces `mu sql`; `mu sql` stays as the same verb.**
  In-process SQL on the capture path, as before (one `sql.write` group,
  `--confirm-rows`, sync ingest before and flush after, even on error), now
  with `-w` scoping `ready`/`blocked`/`blockers` to one workstream (per-connection
  `TEMP` views carrying the resolved workstream id as a literal; same columns;
  torn-down filtering kept; `main.ready` is still the global view; a spawned
  worker defaults to its own). `no such column` is one line (exit 2) naming the
  closest columns and the real columns of the tables the query names. A
  non-positive explicit id is a one-line usage error. `mu db --shell [-w ws]`
  runs `sqlite3 -readonly -safe` on the DB with the same views. `db backup`,
  `compact` and `forget` stay. Hints in errors, `doctor` and `drift` now teach
  `mu db query`. Not changed here: rows still print as a table without
  `--json` and are not capped.
- **SQL cannot disable or forge capture (rv6_sql_ctx_tamper).** `mu db query`
  refuses by policy, not by detection: no `CREATE`/`DROP`/`ALTER` of any kind
  (`TEMP` triggers, views and tables included: a `TEMP` trigger on `op_ctx` ran
  inside the scope's own reset and could forge `ops` or leave `applying=1` at
  rest), no `ATTACH`/`DETACH` (a peer or backup mu DB was writable through
  `peer.ops`), no write to `op_ctx`, `op_dying`, `ops` or `schema_version`.
  SQLite's `EXPLAIN` listing, trigger bodies included, decides, never a regex;
  better-sqlite3 has no authorizer callback. Need DDL: `mu db backup` and
  `sqlite3` on the copy.
- **Only read-only PRAGMAs run.** SQLite applies a PRAGMA when it compiles it,
  even in a statement that then fails, so the allowlist (`table_info`,
  `index_list`, `foreign_key_list`, bare `user_version`, `foreign_keys`,
  `busy_timeout` and a few more) is checked on the statement's first tokens
  before the compile. Anything else is a one-line refusal.
- **`mu db -w a query` honours the `-w`** (it was bound to the `db` namespace and
  dropped, so the query ran on the global views). A second, different `-w`
  after the verb is a usage error; other `db` subcommands refuse it.
- **`; BEGIN` is refused (rv6p2_sql_leading_semicolon).** Leading `;`,
  whitespace and comments are skipped before the transaction check, and a
  statement SQLite cannot list now fails the call instead of passing it.

- **Capture UPDATE triggers are a flat `json_group_object` over the
  changed columns.** The nested-CASE form doubled the trigger text per
  column (two columns took `_cap_tasks_upd` from 274 KB to 1.09 MB, +12 ms
  on every `mu` start); payloads are unchanged.

- **`mu doctor`'s `mu ext` row is live.** It reads `hello` (`extVersion`,
  ops, features) from the pi agents' control sockets; with no pi agent it is
  `unknown` (ok), never inferred from a file on disk. The `mu skill` row is
  gone (hello cannot prove a skill loaded). Advice that said `mu link pi`
  now says `pi install npm:@mu-crew/mu`. `CtlProbe` keeps `hello.features`.

- **`--json` prints ONE envelope document on stdout, errors included.**
  Success is `{"ok":true,"data":<old payload>,"next":null}`; failure is
  `{"ok":false,"error","message","next":null,"exit":<n>}` on **stdout** with the
  same non-zero exit (stderr stays empty, no ANSI), so `2>/dev/null` loses
  nothing. The old `exitCode` is `exit`; the legacy `nextSteps` list stays
  (inside `data`, and beside the error fields) until per-verb `next` plans
  land. A usage error's `usage` is at most 3 short lines (synopsis, options,
  subcommands), not a JSON help tree. A verb that fails after producing
  evidence prints one failure document with that evidence in `data`:
  `doctor` (drift, hazard FAIL, no multiplexer: the report is `data`, no
  second document), `agent spawn --send` (the spawn and the nested
  `send.ok:false`; the `msgId`/`incarnation`/`delivery` receipt of an
  indeterminate send stays structured beside `error`), `agent check` (the
  verdict is `data`). `mu log --tail --json` stays raw NDJSON, one op per
  line. Wait exit codes and `timedOut` payloads are unchanged (owned by the
  unified wait). The `mu_delegate` and nudge extensions read the envelope.
  New pure `src/output-contract.ts` (`encodeEnvelope`, `capRecords`: UTF-8
  byte budget, cut on a record boundary, first and pinned records never cut);
  test helpers `runCliJson` (unwraps `data`) and `runCliWire` (raw).
  Part B (tests only): every test that parsed `--json` stdout/stderr moved
  onto `runCliJson`/`asJson` (or the raw `runCliWire` for wire assertions);
  `runCli` is now the raw capture (human output), the transitional legacy
  view is gone. Test counts unchanged.
  Round 2: root-position `mu --json <verb>` now prints the envelope on
  success too (it only worked on errors); `mu log <text> --json` prints the
  written row (with `rendered`) as one envelope; under `--json` the warnings
  that went to stderr (`agent spawn` ctl-missing / trust dialog, whitespace
  or bare `-` notes, `agent wait` state unknown, `mu sync` lock busy, ambient
  sync asides, `task wait` stall line, herdr unconfirmed send, `db` drift
  line) are in the document's `warnings` (spawn, `task note`,
  `task add`, `task close`/`accept`) or dropped where the document already
  carries the fact (`unknownReason`, `stuck`, `delivered`); `agent remote-env
  --shell --json` is a usage error (exit 2), never shell text. One
  table-driven test (`test/cli-json-wire-matrix.test.ts`) walks every
  registered verb in leaf and root position.
- **Scope is explicit: `-w`, a qualified ref, or a worker's injected identity.**
  `$MU_SESSION` is no longer read and the mux session name never routes a
  verb. A verb with no scope fails with one line, no help dump, exit 2:
  `no workstream: pass -w <name>` (inside tmux it adds the session as a
  suggestion, `(tmux session mu-auth: -w auth)`; `state` and `log` add
  `or --all`). A managed worker (`MU_MANAGED_AGENT=1`) keeps its injected
  `MU_WORKSTREAM`. A bare ref that exists in one workstream is no longer
  guessed (the error names `<ws>/<name>`); in several it stays
  `NameAmbiguousError`. `mu state` and `mu log` (read and write) need a
  scope or `--all`; `state --json` no longer prints an empty success.
  `-w ''`, `-w ' auth'` and `-w 'a, b'` are usage errors everywhere (root
  `-w`, `state`, `optsWithGlobals` verbs, every `resolveWorkstream`) instead
  of being trimmed into another workstream; only a structural comma
  artifact (`-w 'a,'`) is dropped. One validator (`src/workstream-scope.ts`,
  never trims) serves every path: CLI `-w`, the `<ws>` of a qualified ref
  (` own/t` and `/t` are errors), `task wait` (an explicit `-w` is checked
  even when every ref is qualified), `mu_delegate`'s `record`, and the
  nudge parser. A scope value holding whitespace, a comma or a slash is
  one name pasted wrong, so it is refused (`-w 'own, decoy'` included);
  `--for <ws>/<agent>` and `$MU_WORKSTREAM` go through it too. Scope errors
  (conflicts included) are one line with no help dump, from the root
  `-w` hook too; one table test feeds the same bad values to every entry
  point. Identity: `mu me`, `me tasks`, `me next`
  and `mu log` source/partition read `MU_AGENT_NAME`/`MU_WORKSTREAM` first
  (no `$TMUX_PANE` needed; a managed identity with no agent row is an
  error, never a pane guess); `$TMUX_PANE` is the fallback only without an
  injected identity. Claim and note authorship were already
  `MU_AGENT_NAME`-only: the stale pane-title help text is gone. `mu doctor`
  drops `$MU_SESSION` and reads no workstream from the session (per-workstream
  stats only for an injected scope), and with no working multiplexer prints
  its report, then exits 5 (`--json`: the report on stdout, the error
  envelope on stderr). `NoMultiplexerError` is one line naming the install
  (`--json` keeps its `nextSteps`). EVERY `mu agent` verb needs a multiplexer
  (a `preAction` gate on the namespace): `agent show` and `agent remote-env`
  used to print with none. Task, DAG, wait and `sql` verbs work with no
  multiplexer. pi extension: `mu_delegate` `record.task` must be `<ws>/<task>`
  or come with `record.workstream` (refused before anything spawns; a blank
  or padded `record` scope is refused, never trimmed); the keep-driving
  nudge reads the scope as the CLI does (root `-w`, verb `-w`, a qualified
  `<ws>/<agent>` or `<ws>/<task>` ref, explicit over injected; an invalid
  explicit scope dispatches nothing) and no longer reads or logs without
  one (no scope counts only for a managed pi, as its injected workstream).
  Docs: README quick start and `docs/reference/env.md` drop `MU_SESSION`.

- Test health, kernel milestone: slow tests sped up without dropping assertions (fast 19.6 s -> 13.5 s, slow 3m14s -> 2m32s; counts unchanged); `docs/ARCHITECTURE.md` module map and `docs/test-health/2026-10-24-kernel.md`.

- **`workstream teardown` is soft and needs a preview revision.** Without
  a flag it prints counts and `rev=<n>` and writes nothing. `--if <n>` kills
  the session first, deletes the machine-local agent rows and sets
  `torn_down_at`, in one op group (`workstream.teardown`). Tasks, edges and
  notes stay and are hidden: every view, `list`, `state` and `-w` verb says
  `workstream <ws> is torn down (at <iso>)` (exit 3,
  `WorkstreamTornDownError`). `--if` refuses with exit 4 (`workstream <ws>
  changed since preview (rev <old> → <new>); preview again`) when an op,
  agent or worktree changed since; the revision hashes the newest op plus
  agent names/panes and worktree paths. `--yes` is removed (replaced by
  `--if`); `--empty` previews with one sweep revision and `--empty --if <n>`
  applies. `init` of a torn-down name previews (`will permanently delete
  torn-down <ws>: N tasks, M notes; rev=<n>`); `init --if <n>` deletes the
  old rows and creates the new workstream in one op group, and refuses while
  this machine still has agent rows in it. `list --torn-down` shows soft rows
  plus older teardowns found in the ops log (those stay final). A peer's
  `torn_down_at` applies by LWW and its later task puts still apply.
  `teardownWorkstream` now requires `ifRevision`; its result reports kept
  `tasks`/`notes`/`edges`/`keptWorktrees`. Teardown **never removes a
  worktree** (rows and directories stay; `mu agent close <agent>` applies the
  close rule). It asks the mux about every registered pane id, not only the
  session, and refuses (`WorkstreamPanesLiveError`, exit 4) while one outside
  `mu-<ws>` lives; `init --if` over a torn-down name probes the session first
  and refuses (`WorkstreamSessionLiveError`, exit 4) when it is alive or the
  probe fails. The commit re-reads the whole revision inside its transaction,
  and `--empty --if` applies each member's previewed revision (a member that
  changed mid-sweep is reported in `failed`). **One row rule:** an agent row
  is deleted only when its recorded pane is known dead, asked by pane id
  after the session kill and per row; a pane that is alive (moved during the
  kill) or cannot be asked keeps its row and socket (`orphanedAgents` in the
  result, a `KEPT` block in the output, an `orphaned-agents` row in
  `mu doctor`). `mu agent close` now sees agents of a torn-down workstream
  (a peer's teardown reaches machines whose panes live), kills the pane and
  deletes the row only once the pane is gone, else refuses with
  `AgentPaneStillAliveError` (exit 4, one line) and releases no worktree. The revision, torn-down, has-agents
  and live-pane refusals are one stderr line that names the command
  (`--json` keeps `nextSteps`).

- **Local-write guards in the DB** (`CAPTURE_VERSION` 2). Three persistent
  triggers, each `WHEN applying = 0`: claim CAS (`owner_id` cannot move from
  one agent to another), close needs evidence (a `kind = 'close'` note in the
  same op group, matched by exact note key), and close to `done` refuses open
  blockers. `mu task close` now **requires `--evidence`** for `done` (exit 2, one stderr line naming the command, also under
  `--if-ready` when it would close; before any write; a retry of an already-done close needs none); other
  substates need `--why`, which is their evidence, and may close over open
  blockers. `closeTask` writes its close notes (kind `close`) before the
  status update in one op group, so a close is one more op (the note).
  `CloseNeedsEvidenceError` and `TaskHasOpenBlockersError` (lists the open
  blockers; Next: `mu task tree`) exit 4. `--if-ready`'s skip no longer
  suggests "close anyway". Ingest, import and rebuild are never blocked;
  `mu doctor` warns (`closed-blockers`, `closed-evidence`, up to 10 ids each,
  in `--json` as `closeGuards`) about CLOSED tasks the guards would have
  refused; its repair is `mu task open` then `mu task close --evidence`
  (`mu task note` cannot write a close note). `mu sql` maps a guard's refusal
  to the same typed conflict (exit 4, `<id> -w <ws>` placeholders in Next).

- **Sync contract.** `mu sql` now ingests peer ops before the query and
  flushes its writes after, including when the statement throws (it was the
  one verb that opted out, so its writes sat unflushed until the next verb).
  Only `mu sync` keeps `ambientSync: false`. Every verb now refuses to run when
  the DB path is inside `MU_SYNC_DIR`: `DbInsideSyncDirError`, exit 4, thrown by
  `handle()` before `openDb` so nothing is created or written (the doctor
  `db-vs-sync` row stays).

- **Sync convergence and contract, round 2.** Apply is now a fold: live
  state for a key is defined as rebuild-of-that-key. `src/fold.ts` holds the
  only merge rules as pure per-key functions of the ops log (tombstone
  horizon, per-field LWW, substate, note sets, edges), `applyOp` re-folds
  the keys an op touches and `mu rebuild` folds every key, so live equals an
  HLC-order `rebuild` for every arrival order of one op set. This replaces
  the per-path comparisons (`applyPut`, `applyDel`, `applyEdgePut`,
  `repairTaskPair`, `applyContainerDel`) and the deferred-op repair
  (`reprojectDeferredOps`, the `user_version` marker, the pass-wide repair):
  an edge or note that arrives before its task lands when the task's put
  folds. Defaults that were "now" are log-derived: a task or workstream
  created by a partial put gets the wall clock of the HLC that began its
  life, so the same log folds to the same row on every machine (a restored
  workstream's `created_at` no longer depends on when it was applied). An
  edge re-added after a delete takes the re-add's `created_at`; a dead
  put's substate no longer survives a restore. `ApplyResult.skipped` is
  gone (callers only used `changed`); `RebuildReport.opsChangedRows` now
  counts table rows written. A 500-case randomized property test (fixed
  seed) asserts live == rebuild. An ambient flush that loses the segment
  lock prints `mu: sync: segment locked by another mu; this op publishes on
  the next flush` (exit stays 0) and `mu doctor` gains an `unpublished-ops`
  row. The DB-inside-`MU_SYNC_DIR` refusal resolves symlinks on both sides
  (a symlinked DB directory or sync dir no longer bypasses it) and `mu link`
  honours it.

- **Schema v12** (additive over v11; a v11 DB is refused with
  `SchemaTooOldError`, exit 4). New columns: `workstreams.torn_down_at`
  (synced), `agents.cwd` and `agents.base` (machine-local), `tasks.scored`
  (`NOT NULL DEFAULT 0`, `CHECK IN (0,1)`, synced), `tasks.dispatch_host`
  (synced), `task_notes.kind` (`NOT NULL DEFAULT 'note'`, `CHECK` one of
  `NOTE_KINDS`, synced). `tasks.impact` / `effort_days` stay `NOT NULL` and
  gain SQL defaults 50 / 1. New machine-local table `task_auto`
  (13 tables; 15 once persistent capture adds `op_ctx` and `op_dying`). New view `blockers(task_id, blocker_id, blocker_local_id,
  blocker_status)`; `ready`, `blocked`, `goals` and `blockers` skip torn-down
  workstreams, as do `resolveWorkstreamId`, `tryResolveWorkstreamId`,
  `listWorkstreams`, `TASK_FROM_JOIN` and the dormant sweep. Apply and ingest
  still see torn-down rows (`UNIQUE(name)`). The version stamp now commits
  inside the DDL transaction.

- **Persistent capture.** The capture triggers are stored in the DB file
  (were per-connection TEMP triggers), generated by the same
  `src/capture.ts` builders, so a plain write from any connection is captured
  (a safety net, not a supported path; plain `sqlite3` also defaults to
  `foreign_keys=0`). The op context moved from the TEMP tables `_op_ctx` /
  `_op_clock` / `_op_dying` to the main tables `op_ctx` (one row, seeded;
  also holds the HLC `now_ms` scratch) and `op_dying` (the delete-key stash,
  emptied by an AFTER DELETE trigger), both machine-local (15 tables).
  `withOpContext` and `withCaptureSuppressed` **own the transaction** when none
  is open (`BEGIN IMMEDIATE`, set ctx, run, reset ctx, `COMMIT`; a throw is
  `ROLLBACK`), so the context is never committed: a concurrent writer waits
  for the lock instead of being stamped with another scope's intent or
  `applying = 1`, and a crash cannot leave capture off. Nested calls inherit
  as before; `db.transaction()` inside becomes a savepoint. A second
  connection writing inside a scope now gets `SQLITE_BUSY`. Triggers carry a
  revision, `schema_version.capture_version` (`CAPTURE_VERSION`), separate
  from the schema number: newer is refused (`SchemaTooNewError`), older or
  missing is replaced in one `BEGIN IMMEDIATE` together with the stamp, equal
  runs no DDL and takes no lock. Emitting triggers abort below SQLite 3.42
  (`unixepoch('subsec')`); `openDb` throws `SqliteTooOldError` (exit 4).
  `mu doctor` gains a `capture` row (sqlite version, capture revision,
  sha256 of the stored triggers vs the generated DDL).

- **`mu sql` runs inside the scope's transaction.** `BEGIN`, `COMMIT`, `END`,
  `ROLLBACK`, `SAVEPOINT` and `RELEASE` are refused (`UsageError`: "mu sql
  runs inside mu's transaction; remove BEGIN/COMMIT"). `--confirm-rows` no
  longer opens its own transaction: a mismatch throws and the scope rolls
  back. A read-only statement skips the scope (no write lock). Transaction
  control is recognised by SQLite (the statement compiles to an `AutoCommit`
  or `Savepoint` opcode), one statement at a time, not by scanning for
  keywords, so identifiers named `begin`, `trigger` or `end` neither bypass
  nor trip the refusal. A nested scope restores the outer context only
  while the transaction is still open: an implicit rollback inside it
  (`INSERT OR ROLLBACK`, `RAISE(ROLLBACK)`) no longer autocommits it.

- **Explicit non-positive ids are refused.** An `INSERT` naming `id <= 0`
  (`rowid` on `task_edges`), including `-1`, raises `mu: explicit non-positive
  ids are refused` (local writes only; ingest is never refused). `-1` stays
  free to mean "omitted" in the BEFORE INSERT collision guard, so one raw
  `id = -1` row can no longer exist to confuse it.

- **New fields travel on v2 segment lines only.** `encodeSegmentLine` at v1
  refuses a payload carrying `scored`, `dispatch_host`, `kind` or
  `torn_down_at`. Apply drops a `scored` outside {0,1} and stores an unknown
  note `kind` (or none: a 3.x op) as `'note'`. A local `UPDATE` of
  `task_notes.kind` raises (`WHEN applying = 0`; ingest never raises).
  `mu doctor --deep` compares the new fields.

- **`ready` order and `mu task next`.** Scored tasks by impact/effort desc,
  then unscored tasks oldest first. `byRoiDesc` (the `roi` sort key, `next`,
  `my next`, `mu state`) and `listReady` share it. `mu task add -i/-e` are
  optional (defaults 50 / 1, unscored); giving either scores the task, and so
  does `mu task update --impact/--effort-days`, even at the current value.
  `TaskRow` gains `scored` and `dispatchHost`.

- **`MuxBackend` shrinks to the mux-seam contract.** The interface is
  `available`, `ensureSession`, `killSession`, `spawnAgent`, `listPanes`,
  `paneAlive`, `killPane`, `capture`, `attachCommands`, `healthCheck`,
  `paneNotFoundNextSteps` and the id validators, plus optional `paneStatus`
  and `sendToPane` (herdr) and the deprecated `currentSessionName` (scope
  fallback, goes with the `-w` unit). `spawnAgent(opts)` is one backend
  operation (tmux: create and run in one step; herdr: bare shell pane, then
  `agent start --kind` with the busy retry, refusing a command override
  before touching herdr and closing the bare pane when the start fails).
  `src/agents/spawn.ts` calls only `ensureSession` (scratch) and
  `spawnAgent`, and branches on the capability flag `spawnAgentWaitsReady`
  (herdr true, tmux false), not on a name. `spawnAgent` reports the pane
  through `onPaneCreated` as soon as it exists, so herdr's readiness wait
  (up to 30s) runs outside the per-session spawn lock.
  `listPanes(session)` replaces `listPanes` / `listPanesInSession`,
  `paneAlive` replaces `paneExists`, `capture` replaces `capturePane`;
  `MuxPane` has no `title`. `ensureSession` returns `{ created, repaired }`
  (`repaired`: the `_mu` window was re-added). `attachCommands` steps carry
  an optional `reason`; `attachShellLine(steps)` joins them with `&&`, an
  optional step as `{ step || true; }` (its failure never fails the line), and replaces `attachHint`. `mu workstream init` and the
  attach next step of `mu agent spawn` omit the line when `attachCommands`
  throws (herdr: no such workspace). Mux reads keep their failure modes:
  reconcile still propagates an unreachable mux instead of pruning every
  agent, and `workstream teardown` aborts on a failed liveness probe
  instead of deleting DB state while panes may live.

- **Worktrees replace workspaces.** `mu agent spawn <name> --worktree [--from
  <ref>] [--root <repo>]` runs `git -C <root> worktree add --detach
  <state dir>/worktrees/<workstream>/<name> [<ref>]`; the pane starts there
  and the worker's cwd *is* its worktree (briefs never `cd`). `--root`
  defaults to the git toplevel of the caller's cwd; `--cwd` conflicts with
  `--worktree`, `--from` / `--root` need it. `agents.cwd` records the pane's
  directory for every spawn (`--cwd`, default the caller's cwd) and
  `agents.base` the commit of a worktree; `mu agent list` shows a `cwd`
  column and `--json` carries `cwd` / `base`. **`mu agent close`** applies one
  rule to the worktree: dirty refuses before the pane is killed
  (`WorktreeDirtyError`, exit 4, up to 10 files listed; `--discard`
  overrides, lossy, no branch), clean and merged (nothing the base, the
  root's HEAD, `origin/HEAD` or `@{upstream}` lacks) is removed, clean with
  unmerged commits keeps `mu/<workstream>/<agent>-<sha12>` in the root repo,
  prints its name, and is removed. `workstream teardown` never removes a worktree
  (see above). New machine-local table **`worktrees`** (path,
  agent, workstream, root, base, last_collected_head), **not** keyed to
  `agents`: it outlives the agent, so a reaped agent's worktree is still
  closed by `mu agent close <name>` and a reused name can tell its own clean
  leftover (HEAD is the base or the last collected head, no branch made)
  from work it must not overwrite (`WorktreePathNotEmptyError`, one line).
  The reaper (`reconcile`) only deletes the agent row; it never touches a
  worktree or the registry. A failed spawn removes the worktree it made.
  `vcs_workspaces` is migrated and dropped: `openDb` treats a DB that still
  has it as not current, and `applySchema` copies every git row into
  `worktrees` (path, agent, workstream, base = `parent_ref`, `created_at`;
  `root` unknown, found from the worktree's own git pointer) and fills the
  agent's `cwd`/`base`, then drops it, all in its one transaction, so a dirty
  legacy workspace is still refused on close. `migrateLegacyWorkspaces(db,
  schema)` takes an ATTACHed source for the import.
  `spawn --worktree` bases on the caller's checkout: HEAD (or `--from`) is
  resolved in the git toplevel of `--root`/the caller's cwd, a linked checkout
  included; only the registry records the owning main checkout. The schema
  stays v12 (additive and idempotent, no bump). `EXPECTED_TABLES` is still 15
  (`worktrees` for `vcs_workspaces`).

- **Spawn injects exactly six identity variables**: `MU_MANAGED_AGENT`,
  `MU_AGENT_NAME`, `MU_WORKSTREAM`, `MU_CTL_SOCK`, `MU_DB_PATH` and
  `MU_STATE_DIR`, the last two absolute and **always** set (the default DB
  and state dir included), plus `SSH_AUTH_SOCK` forwarding as before. An
  in-memory DB pins the default DB path.

- The git layer is plain functions in `src/vcs/git.ts` (the one-implementation
  `VcsBackend` interface, `detectBackend` and `WorkspaceVcsRequiredError` are
  gone); `src/worktree.ts` holds creation, the registry and the close rule.
  `TeardownResult` reports `keptWorktrees` and `WorkstreamSummary`
  `worktreeCount`; `mu state` no longer prints a
  Workspaces section (`workspaces` is gone from its JSON); `mu doctor`'s
  `ws-rows` / `ws-empty` rows and `--disk` read the registry and
  `<state>/worktrees/`. The `mu task close` commit hint is `git -C <path> add
  -A && git -C <path> commit -m ...`; `mu task wait`'s inspect hint names the
  worktree and the same upstream-ref set.

- **Identity is `$MU_AGENT_NAME` only.** `resolveWorkerIdentity` no longer
  falls back to the pane title; nothing reads or writes pane titles, so a
  pane adopted without the env var resolves to `$USER` / `orchestrator`.

- **Segment lines are versioned per line; mu writes v2.**
  `SEGMENT_FORMAT_VERSION` is 2 and `SEGMENT_READ_VERSIONS` is `[1, 2]`: a
  segment may hold v1 history with v2 lines appended (same shape; the crc
  covers `v`), and the manifest stays valid over the mixed file. A line of
  any other version is an `unknown-version` defect that now carries the
  version found. Peer ingest stops there as before. An own segment holding
  any line of an unknown version is read-only to this build: flush
  appends nothing, repairs nothing, deletes its manifest, and reports
  `foreignVersionAt` / `foreignVersion` (also in `mu sync --json`); every
  flush, `mu sync` and `mu doctor` print "segment <path> has a v<N> line
  written by a newer mu; upgrade mu on this machine", and pending ops stay
  in SQLite until the upgrade. Repair of known-version damage keeps valid
  v1 lines byte for byte. `mu sync --from <db>` refuses a source DB whose
  `schema_version` is newer than this build (`SyncSourceTooNewError`, exit
  4). A 3.x reader stops at the first v2 line of each segment; rolling
  back means moving v2-holding segments out of `MU_SYNC_DIR` on every
  machine ([sync](docs/architecture/sync.md#segment-versions)).

### Fixed

- **Explicit ids above 2^53-1 are refused (`CAPTURE_VERSION` 4).** An `INSERT`
  naming `id = 9223372036854775807` moved the AUTOINCREMENT counter to the max and
  bricked every later insert ("database or disk is full") with no `mu` repair, now
  that `sqlite_sequence` is protected. Local writes refuse it
  (`mu: explicit ids above 2^53-1 are refused`, one usage line from `mu db query`);
  ingest is unaffected. A `mu db query` whose retrieval command would exceed 1 KB
  now says "re-run the same query with --all" instead of echoing the query.

- **`mu db query` no longer writes `sqlite_sequence`, `sync_peers` or row ids.**
  One `UPDATE sqlite_sequence` could brick every later captured write ("database or
  disk is full"); a forged `sync_peers` watermark skipped peer ops until a repair; an
  `UPDATE tasks SET id=-1` slipped past the INSERT-only id guard. All three are
  refused (the `sync_peers` refusal names `mu sync --repair <peer>`);
  AUTOINCREMENT inserts still work.

- **`mu db query` no longer writes `machine_identity`.** Its HLC clock and machine id
  feed every captured op, so a forged id or clock silently unpublished later ops.
  Only a main `_cap_*` trigger writes it now.

- **Remote spawn follow-ups.** A rollback whose pane survives the kill keeps a
  host agent's row (and so its channel) and says so in the log, instead of
  freeing the slot under a live pane. The transport pane runs with the local
  `MU_DB_PATH`, `MU_STATE_DIR`, `MU_SYNC_DIR`, `MU_CTL_SOCK`, `MU_AGENT_NAME`,
  `MU_WORKSTREAM` and `MU_MANAGED_AGENT` unset (a tmux pane inherits the
  server's, possibly another agent's). `agent close` suggests the re-spawn with
  `--host`, `agent show` prints the host, and stale `remote-env` mentions are gone.

- **The attach hint works from outside tmux.** Outside a client it is ONE
  `tmux attach-session -t mu-<ws>:<agent>` (the old line ran `select-window`
  only after the blocking attach detached), and every tmux attach/switch line
  carries `-L <socket>` when `MU_TMUX_SOCKET` routes mu to a private server.
  herdr is unchanged.
- **A delegate answer lost to the dequeue key is sent again, once.** pi's dequeue
  key (alt+up) calls `session.clearQueue()`, which silently drops custom
  follow-ups; the run then ends with `aborted: false`, so the Escape path saw
  nothing and the answer never arrived. Each answer has a delivery id from
  `sendMessage` to its `message_start`. After a normal settle, one tick later,
  and only if pi is idle and no answer was accepted since, the extension resends
  ONE unstarted answer (the next settle finds the next). Escape never resends:
  it drops what is pending with copies and one note, and defuses those answers'
  sends that pi deferred while settling (no turn; a stub if they start). A
  second start of an id (pi can still do that) is rewritten in place to a
  one-line "already handled" stub, so a repeat costs the model no answer text.
  `MU_DELEGATE_TRACE=1` logs every follow-up send and pi lifecycle event to
  `<cache dir>/delegate-trace.log`. Tested against pi's real `AgentSession`
  (`test/extension-delegate-pi.integration.test.ts`).

- **`mu_delegate` `record` kept an empty `EVIDENCE:` header.** `recordNote` kept
  only lines that start with `EVIDENCE:`, so a refuter's multi-line evidence
  body was dropped. It now keeps everything from the last `VERDICT:` line on
  (still capped at 4000 chars).

- **Test runs no longer leak `/tmp/<id>/ssr`.** vitest 5 never removes the root
  Vitest instance's tmp dir (`<tmpdir>/<nanoid>`, 6-17 MB of transformed
  modules per run), which filled a tmpfs `/tmp`. `test/_global-teardown.ts`
  (shared by both vitest configs) now removes it in teardown.
  `test/dag.integration.test.ts` also removes its `mu-dag-*` temp dirs.

- **ultrathink closes on no *unfixed* high finding.** A final refuter pass
  that finds highs which are then fixed now satisfies the stop rule.

- **`touchTask` is monotonic.** A note or edge write whose clock read earlier
  than the stored `updated_at` no longer moves it backwards.

- **`mu sql` `INSERT OR REPLACE` can no longer re-key a row without a
  tombstone.** A BEFORE INSERT guard on `workstreams`, `tasks`,
  `task_notes` and `task_edges` refuses an insert whose id or natural key
  already exists. `ensureWorkstream` and `addBlockEdge` now insert with
  `WHERE NOT EXISTS`, since the guard also aborts `INSERT OR IGNORE`. The
  `task_edges` guard also refuses a colliding hidden rowid. The id check
  ignores SQLite's `-1` placeholder for an omitted id, so a raw `id = -1`
  row no longer blocks every later insert.

### Removed

- **`mu workspace` and the workspace flags.** The `mu workspace` namespace
  (`list`, `path`, `free`) is gone: `list` is `mu agent list` (cwd column),
  `path` is `mu agent list --json` `.cwd`, `free` is `mu agent close
  --discard`. `mu agent spawn --workspace`, `--workspace-from` and
  `--workspace-project-root` are replaced by `--worktree`, `--from`,
  `--root`; `mu agent close --discard-workspace` is `--discard`. Removed from
  the SDK and `src/index.ts`: `createWorkspace`, `freeWorkspace`,
  `getWorkspaceForAgent`, `listWorkspaces`, `workspacePath`,
  `Workspace{Exists,NotFound,PathNotEmpty,Preserved,OwnerBusy,VcsRequired}Error`,
  `HomeDirAsProjectRootError`, `VcsBackend`, `detectBackend`, `gitBackend`;
  the `workspace.create|free|refresh` log intents; `src/workspace.ts`,
  `src/workspace/`, `src/cli/workspace.ts`, `src/vcs.ts`,
  `src/vcs/{types,index,helpers}.ts`. `free --commit` (auto-commit before
  free) has no replacement: commit in the worktree, or close and keep the
  branch.

- **Pane titles, pane borders and mux session discovery.** Gone from the
  backends and the SDK: `setPaneTitle`, `lockPaneTitle`, `getPaneTitle`,
  `currentAgentName`, `currentPaneTitle`, `parseAgentNameFromTitle`,
  `composeAgentTitle`, `refreshAgentTitle` (and reconcile's title refresh),
  `enableMuPaneBorders*` and the `MU_BANNER_QUIET` env var, `listSessions`,
  `sessionExists`, `newSession`, `newSessionWithPane`, `listWindows`,
  `newWindow`, `selectLayout`, `splitWindow`, `startAgentInPane`,
  `ensureWorkstreamSession` (now `mux.ensureSession`) and the
  `title=` column of orphan panes in `mu agent list` / `mu state`.
  `mu workstream list` shows registered workstreams only: a `mu-*` session
  with no workstream row is no longer discovered, so `mu workstream teardown
  --empty` no longer prints its "Skipped N mu-* sessions" note
  (`listUnregisteredMuxWorkstreams` is gone). Teardown (soft, `--if <rev>`) acts on registered
  workstreams only.

- **The jj, sl and `cp -a` workspace backends, staleness, `workspace commits`
  and orphan listing.** `src/vcs/jj.ts`, `sl.ts`, `none.ts`, `src/staleness.ts`,
  `src/cli/staleness.ts`, `src/workspace/decorate.ts` and `orphans.ts` are gone
  (mu-next README Cut table: 582 git workspaces, 0 jj/sl). `mu workspace
  refresh|commits|orphans`, `mu agent spawn --workspace-backend`, and
  `--strict-staleness` on `mu task claim` and `mu agent send` are unknown.
  Refresh is a skill sentence: `git -C <cwd> fetch && git
  -C <cwd> rebase <base>`. Also gone: the `behind` column, the stale-workspace
  and orphan sections of `mu state` (and `workspaceOrphans`, `recentCommits`,
  `commitsBackend` from its `--json`), the `workspaces` doctor-summary row,
  the `ws-dirs` doctor row, `TaskClaimStaleWorkspaceError`,
  `WorkspaceDirtyError`, `WorkspaceConflictError`, `staleness` in `mu task
  claim` and `mu agent send --json`, and the SDK's `refreshWorkspace`,
  `listCommitsForWorkspace`, `decorateWith*`, `*Orphan*` and `jjBackend`,
  `slBackend`, `noneBackend`. `mu task wait`'s hint after a worker closes
  is now `git -C <path> log --oneline HEAD --not <refs>`. `<refs>` is
  everything already upstream: `parent_ref`, the project root's HEAD,
  `origin/HEAD` when it resolves, and the root's `@{upstream}` when set. `mu
  agent close` uses the same set for its own-commits check, so a manual `git
  rebase` onto advanced local main, or `git fetch && git rebase origin/HEAD`,
  neither blocks closing an empty clean worker nor lists the base's commits.

- **`mu undo`.** Teardown is soft (see Changed). `mu log --group
  <prefix>` still resolves a group prefix; an unknown one now raises
  `GroupNotFoundError` (exit 3). The SDK drops `undoGroup`, `planUndo`,
  `listRecentGroups`, `mostRecentGroup`, `resolveGroupId` and
  `priorFieldValue`.

- The card TUI (bare `mu`, `mu state --tui`). Bare `mu` prints help until
  the mu-next dashboard lands. Also gone: the `MU_NO_TUI` and
  `MU_TUI_DEBUG_MOUSE` env vars, the `ink`, `react` and `react-devtools-core`
  dependencies, the `dist/tui-sync-worker.js` bundle and
  `src/project-root.ts` (its only caller was the TUI launch ladder).

- **The refute nudge.** `registerRefuteNudge`, `refuteNudgeText`,
  `dispatchedTasks` and the `mu-refute-brief` message are gone; unrefuted
  dispatches no longer get a notice. The keep-driving and close nudges stay,
  and `MU_NUDGE=0` now turns off those two. `parallelSettle` merges two
  handlers, not three.

- **Legacy op handling.** `src/legacy-ops.ts` is gone. Old `workstream.export`
  prose ops are no longer skipped by apply, rebuild, flush, ingest and
  `--from`; they are treated like any other op (none exist in the live DB or
  sync dir). The `workstream.destroy` spelling is no longer a synonym of
  `workstream.teardown`: `mu log --intent workstream.teardown`, `mu workstream
  list --torn-down` and `mu workstream forget` match only the new name, and a
  `workstream.destroy` op renders as an unknown intent (6 such lines in peer
  segments, accepted).

- **The v7-v10 migration sidecar.** `scripts/migrate.ts`,
  `scripts/migrate-recovery.ts`, `scripts/README.md` and
  `test/migrate.integration.test.ts` are gone (mu-next README Cut table;
  the cut-over import replaces them). A too-old DB is refused with
  `SchemaTooOldError`; its next steps are now a `sqlite3 .backup` copy
  (mu cannot open the DB, so `mu db backup` was unreachable) and moving
  the file aside. `docs/guide/upgrade.md` drops the migration recipe.

- **`mu agent kick`, `mu agent adopt` and the tmux paste send.** `mu agent
  send --via`, `src/agents/kick.ts`, `src/agents/adopt.ts`,
  `src/mux/input-timing.ts`, `MU_SEND_DELAY_MS`, `MU_SEND_READINESS_MS`,
  `MuxBackend.paneTTY` and `PaneNotInSessionError` are gone (mu-next README
  Cut table: 0, 2, 2 real uses). `MuxBackend.sendToPane` is now optional and
  herdr-only (its atomic `agent prompt`). A send to a non-pi agent on tmux
  throws the new `AgentSendUnsupportedError` (exit 4) instead of pasting.
  `mu agent abort` and `send --interrupt` hints now point at `mu agent
  close`; an outdated extension that lacks op `command` is reloaded or respawned as described under `mu agent send`; `ClaimerNotRegisteredError` drops its adopt step; the
  doctor `ctl` row's `reloadVia` is `"ctl"` or `"respawn"`. Old
  `agent.adopt` / `agent.kick` log rows still render.

- **The decorative delegate footer and failed-delegate pruning.** pi's footer
  status (`delegates running/queued`, `N results pending`, failed count),
  its key and formatter, and the `PRUNE_FAILED_MS` failed-pruning are gone
  (`delegateStatus`, `DELEGATE_STATUS_KEY`, `PRUNE_FAILED_MS`). Unchanged:
  admission control (`MU_DELEGATE_MAX` running plus a bounded queue, refusal
  past it), arriving-answer delivery safety (Escape copies, the one resend,
  the "already handled" stub), and `murmur:pending` `{source,count}`.
  `docs/guide/delegate.md` still describes the footer; its pruning is
  tracked for the docs consolidation.

## [3.13.3] — 2026-10-22

**Test upkeep leaves a record.** An upkeep pass now ends by committing a
dated report to the repo, so its findings outlive the workstream.

Upgrade with `npm i -g @mu-crew/mu@3.13.3`. New agent sessions load the updated
skill. No CLI, API, schema or extension change.

### Changed

- **Skill: test upkeep ends with a committed report.** The
  [test-health](skills/mu/recipes/test-health.md#upkeep-loop) loop gains a
  sixth step: a dated `docs/test-health/` report in the repo, holding the
  findings and every refuted or rejected verdict, so the next pass starts
  from them instead of from scratch when the workstream's notes are gone.

## [3.13.2] — 2026-10-21

**Keep verification useful as projects grow.** The mu skill now defines
fast/slow gate responsibilities, scoped evidence reuse and routine test upkeep.

Upgrade with `npm i -g @mu-crew/mu@3.13.2`. New agent sessions load the updated
skill. Existing workers need updated briefs; no schema or extension change.

### Changed

- **Skill: fast/slow gates and routine test upkeep.** Canonical
  [test-health](skills/mu/recipes/test-health.md) guidance assigns targeted
  worker/reviewer checks, equivalent gate records and one full merged-tree
  gate per batch. Milestones and budget crossings prioritise upkeep without
  a crew-wide barrier; auth/build isolation and required pre-push checks stay.
  mu's own gate commands remain unchanged pending review.
  Pilot baseline supplied for swaywardlock `90c3f1c`: cold full 557.885 s,
  fast 216.140 s, slow 341.696 s (e2e 255.561 s, release 82.414 s);
  223 unit tests ~1 s, 64 e2e cases / 422 assertions, no skips. Converters
  initially cost ~28 s in fast: fast is not universally seconds. This is
  pilot timing, not an equivalent gate record for mu. A separate targeted
  vibrancy-wait follow-up preserved all seven assertions and reduced that
  case's mean from 3.350 s to 2.140 s; it does not establish a full-gate
  speedup or a solved budget.

## [3.13.1] — 2026-10-20

**jj 0.46: recreating a deleted workspace works again.** A spawn that reuses
the name of a jj workspace whose directory was deleted failed on jj 0.46.

Upgrade with `npm i -g @mu-crew/mu@3.13.1`. No schema or extension change.

### Fixed

- **A jj workspace whose directory was deleted can be recreated (jj 0.46).**
  `mu agent spawn --workspace` forgets a stale jj workspace of the same
  name first. jj 0.46 keeps printing the deleted path as the workspace
  root, so mu missed it, and in a colocated repo the workspace is also a
  Git worktree that `jj workspace forget` leaves registered. mu now checks
  the root on disk and runs `git worktree prune` after the forget, so the
  re-add no longer fails with "Workspace named … already exists" or
  "missing but already registered worktree".

## [3.13.0] — 2026-10-20

**Faster everyday verbs.** tmux-touching verbs no longer load execa (about
50-60 ms each), pure-JS dependencies are bundled, and a bare verb in a
mu-spawned pane skips the tmux workstream lookup. `mu doctor` counts ops by
key range (~250 ms less), peer sync resumes from where it stopped, and the
TUI launches faster and stops re-detecting the VCS every 10 s.

Upgrade with `npm i -g @mu-crew/mu@3.13.0`, then `/reload` in running pi
sessions to pick up the extension. No schema change. Task, track and peer
lists now sort names by code unit (`a-b, a0, a_b`; uppercase first).

### Changed

- **Spawn warns on Claude's folder-trust dialog.** The dialog defaults to
  "No, exit", so the Enter that ends `--send` quit claude. The tmux
  startup scan now spots it (non-fatal): the pane and agent stay, the
  initial `--send` is skipped (`send.error` `TrustDialogPending` in
  `--json`), and a warning plus next step says to answer it in the pane
  and then `mu agent send`. It does not guard a later `agent send` or the
  herdr spawn path, and mu never presses a key for you.
- **TUI dashboard fills its space.** A card's `maxRows` now caps only
  the first pass of the row allocator: leftover rows go to cards whose
  data still overflows, in proportion to the rows each hides, so a
  40-item Ready list at 80 rows shows all 40 instead of 15 above 60
  blank rows. Cards also move between columns: `arrangeColumns`
  (replacing `balanceColumns`, which only ran after a cull) searches
  single moves and swaps for the fewest hidden rows, even with all ten
  cards visible, and keeps the previous layout unless the new one hides
  max(3, 10%) fewer rows. The search also descends from the previous
  layout, so a retained layout never has a single move or swap that
  beats it by more than that margin. Among layouts that hide the same rows, the search
  prefers fewer cards away from their default column, then slot order. Footers and mouse hit regions read the same
  budgets (`columnRowBudgets`).


- **Skill: recipe wording from a prior runtime.** An `unknown` owner
  is not a dead one: orchestrator-loop says to read the pane or run
  `mu doctor` before releasing its task. Reviews with only
  UNVERIFIED items go to the human, not into a REJECT round. findings § Record
  grades severity strictly (critical needs a concrete scenario).
  ultrathink and loop-until-done refute the umbrella's criteria on the
  merged tree before `close --if-ready`.
  watcher caps attempts per item and parks it with every attempt listed.
  long-run records `DEAD-END:` notes on the umbrella.
  backlog-triage re-verifies an item against the code before starting.
  dag.md states that every edge comes from a verb the caller ran (`block`, `add`/`reparent --blocked-by`) and no write adds edges on its own.
  VISION cites a prior runtime's transport and sentinel-marker lessons.
- **A changed peer segment is ingested from where the last read stopped.**
  Every append used to make each other machine hash the whole segment,
  read it a second time as text and split it (~120 ms for this fleet's
  64 MB segment, ~9 ms of it needed). A clean read now saves the byte
  offset and running sha256 state next to the caught-up fingerprint; the
  next ambient ingest reads only the appended bytes, and accepts them
  only when their hash is the manifest's sha256 (~20 ms). A shrunk
  file, a stale manifest, a defect (which saves no offset) and `mu sync`
  take the full read and whole-file verify as before. The resumed hash
  trusts the prefix it already read: a local edit to those earlier bytes
  that keeps the file growing is caught only by `mu sync`, not by the
  ambient ingest. No
  schema change: the offset is extra fields in the existing
  `sync_fingerprints` value, which an older mu never matches and
  ignores.
- **`mu workstream list` reads mux liveness from one `list-sessions`.**
  It also ran `has-session` once per workstream (6 spawns for 6
  workstreams). The listing now reuses the session names it already
  fetched, and falls back to per-workstream `has-session` when
  `list-sessions` fails, so a transient failure still never marks live
  sessions dead. ~22 ms CLI CPU saved; output is identical.
- **`mu_delegate` lists agents at most every 30 s while a failed delegate
  lingers.** Each spawn ran `mu agent list` (~150 ms of CPU) only to prune
  the footer's failed count; the refresh is now throttled to once per
  30 s. Spawning and safety checks are unchanged; the footer may show a
  closed failure for up to 30 s longer.
- **`mu agent spawn` sets the tmux pane border in one tmux call.** The four
  `set-option -w` calls are `;`-chained into one invocation and target the
  pane directly, which drops the `display-message #{window_id}` lookup
  (the border helper's 5 tmux processes become 1, ~33-80 ms per spawn). Options, `-w` scope,
  `MU_BANNER_QUIET`, and the swallow-all-errors behaviour are unchanged.
- **The TUI detects the VCS backend once, not every 10 s.** The slow tick
  ran `jj root`, `sl root` (twice) and `git rev-parse` before every
  `git log` just to learn the same backend again. It now caches the
  backend per project root for the TUI's lifetime (~4 of 5 processes per
  tick; ticks after the first dropped from ~690 to ~175 ms best case on
  a loaded machine). A `none` result is not cached, nor is a detection
  during which a root probe failed (spawn error, signal) rather than
  cleanly answering "not this VCS": a transient `jj root` failure in a
  colocated jj/git repo no longer pins git. `mu state` is unchanged (it
  never probes the VCS).
- **The TUI bundles ink and react into its lazy chunk.** Importing the TUI
  resolved and compiled ~560 ESM files from `node_modules` per launch. tsup
  now inlines ink, react and their pure-JS deps into `dist/tui-*.js` (loaded
  only by bare `mu` and `mu state --tui`; other verbs are unchanged), using
  the createRequire banner from the commander/cli-table3 bundling. NODE_ENV
  is not defined at build time, so `src/cli/tui-load.ts` still picks react's
  production build at runtime and an explicit `NODE_ENV` still wins. TUI
  import ~470 -> ~67 ms, first Agents card ~890 -> ~440 ms (PTY, 20
  alternating launches on a copied DB). `react-devtools-core` stays external
  (ink loads it only under `DEV=true`).
- **Task, track and sync-peer sorts use code-unit order, not
  `localeCompare`.** The first `localeCompare` call initialised ICU
  (~4 ms on nearly every list verb). Ties by name now sort by code unit,
  so `a-b, a0, a_b` replaces the locale order `a_b, a-b, a0`; uppercase
  sorts before lowercase. Sort keys, ROI order and everything else are
  unchanged.
- **`mu doctor` and `mu db forget` count a workstream's ops by key range.**
  The per-workstream `substr(key, …)` test scanned all of `ops` once per
  torn-down workstream (27 scans of 61k rows, ~320 ms of SQL in
  `mu doctor`'s size hint). It now seeks `idx_ops_entity_key` with a key
  range per entity (~28 ms); counts and deleted rows are identical.
- **A bare verb in a mu-spawned pane skips the tmux lookup.** With no
  `-w` and no `$MU_SESSION`, `resolveWorkstream` ran `tmux
  display-message -p '#S'` (and loaded execa) even though spawn already
  put the workstream in `$MU_WORKSTREAM`. It now uses `$MU_WORKSTREAM`
  when `$MU_MANAGED_AGENT=1` is also set: bare `mu task list` ~133 -> ~67
  ms from an agent pane. `-w` and `$MU_SESSION` still win, and a
  `$MU_WORKSTREAM` without `$MU_MANAGED_AGENT` (a stale export in a user
  shell) is ignored. User-started orchestrator panes are unchanged.
- **Spawn sees a pi agent's control socket within ~50 ms.** The spawn
  handshake polled every 250 ms, so a socket pi bound just after a poll
  waited up to 250 ms to be noticed. It now stats the socket path every
  50 ms (no fork) and probes as soon as it exists: readiness overshoot
  132 -> 24 ms, ~100 ms less per pi spawn. The pane-alive check and
  scrollback capture keep their 250 ms cadence, plus one final check at
  the budget's deadline, so a pane dying in the last 250 ms keeps its
  crash scrollback.
- **`mu_delegate` closes the pane and writes the record note in
  parallel.** A finished delegate with `record` waited for
  `mu agent close` before starting `mu task note`, though neither needs
  the other. They now overlap: ~70 ms less before the answer arrives
  (median of 25 pairs), on clean finishes that close and record. Failure
  reporting is unchanged: a refused close and a failed note are each
  named in the follow-up.
- **The keep-driving nudge reads `mu task list`, not `mu state`.** At
  each armed settle the pi extension ran `mu state --json` only to read
  IN_PROGRESS task names, paying for the tmux pane listing and the
  orphan and workspace views it never used. It now runs
  `mu task list --status IN_PROGRESS --json` per dispatched workstream
  (`--sort recency`, newest first as `state` listed them), in parallel,
  deduplicated by task: ~56-69 ms less per armed settle (one
  workstream). A task still owned by a dead agent shows in the nudge until the next
  `mu state` or `mu task wait` reaps it.
- **Faster tmux-touching verbs.** The tmux, herdr, kick and murmur-status
  executors run through `node:child_process` instead of lazily importing
  execa (~110 modules, 25-40 ms). `mu state`, `mu agent list`, and bare
  verbs that resolve the workstream via tmux drop by ~50-60 ms per call
  (state ~140 -> ~85 ms). Output and exit codes are unchanged; capture
  keeps execa's 100 MiB buffer cap.
  In-flight children are killed when mu exits or gets SIGTERM, SIGINT or
  SIGHUP, as execa's `cleanup` did, so no tmux or murmur process outlives mu.
- **Faster startup: pure-JS dependencies are bundled.** Every verb
  resolved, read and compiled about 35 `node_modules` files (commander,
  cli-table3, string-width and their dependencies). `tsup` now bundles
  commander, cli-table3, string-width and picocolors into `dist/`
  (native `better-sqlite3`, `execa`, `ink` and `react` stay external; the TUI
  chunk is still lazy). Measured on interleaved warm runs: 5-15 ms per
  invocation (`--version`, `task list`, `state`).
- **Skill: orchestrators clean up scratch files.** Review panels and
  other delegate jobs left briefs, diffs and outputs in `/tmp` or ad
  hoc dirs under `$HOME`. SKILL.md's orchestrator rules now say to keep
  briefs and answers in task notes and `mu log` (stdin for pure
  delegate calls), keep any files in one `mktemp -d` dir per job,
  and remove it before the turn ends.
- **Skill: worker checkouts come from mu.** Orchestrators made their
  own `git worktree`s for workers, which mu could not refresh, diff or
  free, so they leaked. SKILL.md now says to use `--workspace` /
  `workspace: true` for every local agent; remote agents keep the
  manual recipe.

### Fixed

- **`mu log` names who sent, spawned or aborted.** `agent.send`,
  `agent.spawn` and a new `agent.abort` op (written only when a busy agent
  was actually aborted) carry the caller (`$MU_AGENT_NAME`, pane title,
  `$USER`) as their actor instead of `system`. The extension's `abort` reply
  now carries `wasBusy`, so a run that settles between the status probe and
  the abort is not logged.
- **A rolled-back spawn leaves an `agent.spawn_failed` log entry** with the
  phase reached and the error class; `agent.spawn` now carries `ctl=`.
- **Spawned panes get the caller's `SSH_AUTH_SOCK`.** mu sessions are
  created detached and can stay so, so tmux never refreshed the env and a
  pane could inherit a stale socket. Spawn now forwards it when it is set
  and a socket (file-type check only, no liveness probe).
- **Detached tmux sessions start at 200x50, not 80x24.** `mu agent read`
  captured wrapped lines at 80 columns on unattached sessions.
  `new-session -d` now passes `-x 200 -y 50` (attached sessions are
  unchanged; no `resize-window`). herdr is unaffected.

- **Nudges yield to a delegate answer on its way.** The keep-driving and
  close nudges continued a settling run even when a `mu_delegate` answer
  sat in pi's follow-up queue (pi's `hasPendingMessages()` does not count
  custom follow-ups), so the agent took an extra turn without the
  answer. All three nudges now skip while an answer is being delivered or
  queued, re-checking after their `mu` read and again once the slowest
  nudge's read finishes (the nudges run in parallel); keep-driving and close also
  skip while an extension dialog is open. A skipped settle does not use
  up the prompt's one nudge.
- **Spawned agents use the spawner's database.** Panes inherit the tmux
  server's env, so under `MU_DB_PATH=/tmp/x.db` a worker's `mu` hit the
  real DB. Local spawns now pin `MU_DB_PATH` (absolute, skipping
  `:memory:`) and `MU_STATE_DIR` in the pane env.
- **`mu doctor` reports dependency cycles made by sync.** Two machines can
  each add a locally valid edge that merge into a cycle, silently hiding its
  tasks from ready/next. A `dag` section (and `dagCycles` in `--json`) lists
  each cycle with a `mu task unblock … --by … -w …` command that breaks it.
  Report-only; the `task tree` header no longer claims the schema forbids cycles.

- **`mu agent send <agent> ""` no longer fails with tmux "no buffer".**
  On the mux path an empty message now presses a bare Enter (dismisses a
  "Press Enter" prompt). Over the pi control socket it is refused with
  `AgentEmptySendError`, whose next step is `--via mux`. herdr refuses an
  empty send (no verified bare-Enter primitive).

- **`paneExists` no longer reads a failed tmux probe as a dead pane.**
  Any nonzero `display-message` exit returned false, so a permission or
  socket error looked like "gone" to liveness gates such as
  `workspace free`. Only "can't find pane" / no-server answers mean
  false now; other failures throw, and callers fail closed.
- **Cycle errors name the full path.** `CycleError` now reads
  `adding edge c -> a would create a cycle: c -> a -> b -> c` and its
  next steps give a concrete `mu task unblock <b> --by <a> -w <ws>` for
  an edge on the path. `findCyclePath` (shortest path, safe on existing
  cycles) is exported from `src/tasks/edges.ts`.

- **Reconcile no longer deletes a respawned agent.** The ghost prune
  deleted by name, so an agent closed and respawned under the same name
  during a pass lost its new row and had its tasks reopened. The delete
  now checks the snapshotted pane id inside the reaper transaction and
  skips the row (and the ctl socket unlink) on a mismatch.
- **`mu agent send` no longer calls an ambiguous failure "refused".**
  When a send, fresh, interrupt or command request was already written
  to the control socket and the reply then timed out or the connection
  closed, pi may have queued the prompt. mu now raises
  `AgentSendIndeterminateError` (exit 1, "delivery unknown") whose next
  step is `mu agent read <agent> -w <ws> -n 20` before resending.
  Failures before the write, dead panes and status/wait/hello keep their
  old errors.
- **Send waits for Codex's "model: loading" screen.** The boot screen
  has no spinner, so `awaitPaneQuiescence` saw it as calm and pasted
  into a booting Codex, concatenating text. "model: loading" is now a
  busy marker (visible tail only).
- **`mu workspace free` refuses under a working agent.** It ran
  `worktree remove --force` beneath a running worker and lost its
  pending changes. It now exits 4 when the owner is busy, needs
  permission, or is unreadable with a live pane. Idle (`needs_input`),
  a dead pane and a pane-less row are allowed. `--force` skips only
  this check. `agent close` and spawn rollback are unchanged.
- **A pi agent stuck on an extension dialog reads `needs_permission`.**
  The control socket only knew busy / idle, so a pi waiting on a
  confirm or question mid-run read `busy`, and `mu agent wait` and
  `mu_delegate` held until their timeout (600 s / 3600 s). The mu pi
  extension now tracks pi's `ui_prompt_start` / `ui_prompt_end` and adds
  an optional `blocked: {kind, title, since}` to the status reply; `mu
  agent list`, `mu state` and `mu agent show` show `needs_permission:
  dialog <kind>: <title>`. A held `mu agent wait` on a pi agent ends
  early with outcome `blocked` (not fired, run counter unchanged) and
  exit 7. The `mu_delegate` follow-up says the delegate is blocked and
  has not finished, keeps the pane, and copies no partial answer. Older
  extensions send no field and ignore the new `returnOnBlocked` wait
  flag, so they behave as before. A held wait whose connection drops
  falls back to polling, and a dialog seen by that poll also ends the
  wait `blocked` (exit 7) rather than counting busy → needs_permission
  as a finished run. The blocked JSON row carries `afterRuns`, the run
  baseline the wait counted from, and the re-wait hint (CLI next steps
  and the `mu_delegate` follow-up, blocked or timed out) passes it as
  `--after-runs`, so a run that finishes after the dialog is answered
  but before the re-wait starts is returned rather than missed.
- **tmux panes keep their mu title.** pi sets an OSC title
  `π - <cwd>`, which overwrote the pane title mu uses as its identity
  fallback. Spawn and adopt (including idempotent re-adopt) now set
  `allow-set-title off` on the pane. herdr is unchanged.

## [3.12.0] — 2026-10-11

**A delegate that ends without an answer leaves its evidence.** Timeout,
API error, empty finish, dead pane or cancel: the follow-up names the
delegate's pi session file and copies its last message so far to
`~/.cache/mu/delegate-answers/`.

Upgrade with `npm i -g @mu-crew/mu@3.12.0`, then `/reload` in running
pi sessions to pick up the extension. No schema change. The session
file is reported by the delegate's own extension, so delegates need
3.12.0 too; an older one still gets the `mu agent read` pointer.

### Added

- **Delegates that end without an answer leave evidence.** A
  `mu_delegate` follow-up for an API error, an empty finish, a
  timeout or a dead pane, and the `mu_delegate_cancel` result, now
  name the delegate's pi session file and copy its last message so far
  to `~/.cache/mu/delegate-answers/<ts>_<name>.partial.md`. Before, the
  only pointer was `mu agent read`, which stops working once the pane
  is gone. Quitting pi or `/reload` lists each running delegate's
  session file too.
- **The control socket's `status` reports `sessionFile`**, so the reply
  to `mu agent spawn --send` / `mu agent send` carries it before any
  run settles.

## [3.11.3] — 2026-10-11

**Escape no longer loses delegate answers; spawn and DB-open fixes.**
An Escape that drops queued delegate answers leaves a pointer to each
one. A fresh DB survives a parallel fan-out, and `--next-free` skips
names whose workspace dir is left on disk.

Upgrade with `npm i -g @mu-crew/mu@3.11.3`, then `/reload` in running
pi sessions to pick up the extension. No schema change. Both sides of a
delegate need 3.11.3 for the session-file pointer: an older delegate
falls back to the copy and `mu agent read`.

### Added

- **Escape no longer loses queued delegate answers.** Escape clears
  pi's follow-up queue, so an answer waiting there was gone. The
  extension now copies each dropped answer to
  `~/.cache/mu/delegate-answers/` (`$XDG_CACHE_HOME/mu`) and writes
  one line per answer into the conversation, without starting a turn,
  naming the copy and the delegate's pi session file. The copy is
  cache: the session file keeps the original.
- **`mu agent wait --json` reports a pi agent's `sessionFile`**, the
  transcript of the run it waited for. The control socket's `wait`
  reply carries it.

### Fixed

- **`spawn --next-free` skips a name whose workspace dir is left on
  disk.** A dead agent's checkout outlives its row, kept as evidence.
  `--next-free` checked only agent rows, so it picked that name again,
  and `--workspace` then failed with `WorkspacePathNotEmptyError`
  instead of moving on. `mu_delegate` with `workspace: true` hit this
  when a label repeated. The leftover dir is untouched; the spawn takes
  the next name.
- **Parallel `mu` calls on a fresh DB no longer drop one.** The first
  fan-out into a new DB (a new machine or `MU_DB_PATH`) could lose a
  process two ways. Switching the file to WAL returns SQLITE_BUSY
  without honouring `busy_timeout`, so a loser exited `db locked`; it is
  now retried for up to 5 s. A process reading the schema version while
  another created the tables could see a half-built DB and refuse it as
  v1 (`SchemaTooOldError`); the version is now read in one transaction.

## [3.11.2] — 2026-10-10

**`mu_delegate` accepts model ids it used to refuse.**
Upgrade with `npm i -g @mu-crew/mu@3.11.2`, then `/reload` in running
pi sessions to pick up the extension. No schema change.

### Changed

- **`mu_delegate` is forgiving about `model`.** It used to refuse any
  value outside `[A-Za-z0-9._:/@+-]`, so real ids such as
  `modelbridge/meta-openai/gpt-6.1-sol[1m]:high` were rejected, and
  that happened in 12 past sessions. It now trims whitespace, drops
  surrounding quotes or backticks and a pasted `--model ` / `--model=`
  prefix, and shell-quotes any other value inside `--command`, so pi
  decides whether the id exists. An empty `model` counts as unset. The
  only value still refused is one with whitespace inside it.

## [3.11.1] — 2026-10-10

**pi's footer shows delegate results that have not arrived yet.**
Upgrade with `npm i -g @mu-crew/mu@3.11.1`, then `/reload` in running
pi sessions to pick up the extension. No schema change.

### Added

- **`mu_delegate` footer counts results pending.** A delegate that
  finished while pi was mid-turn has its answer queued as a follow-up,
  and the footer used to drop it from the count, so it looked as if
  nothing was outstanding. The footer now reads `1 result pending` until
  the answer enters the conversation. Escape, which clears pi's
  follow-up queue, also clears the count.

## [3.11.0] — 2026-10-09

**The skill learns model tiers, and a review panel's fixes land.** A new
`recipes/models.md` says which model tier each role needs; a five-angle
review of the skill found 41 problems, and the confirmed ones are fixed.
`mu agent close` no longer deletes edits in a `cp -a` workspace, and
`mu agent send` to a dead pane says so.

Upgrade with `npm i -g @mu-crew/mu@3.11.0`, then `/reload` in running pi
sessions to pick up the skill. No schema change.

### Changed

- **Skill: one agent per ready task, not per track.** An umbrella puts
  every unit on one track, so "one agent per ready track" read literally
  ran a fan-out with one worker. The skill now says to spawn per ready
  task, and to chain tasks that share files with `block` so only one is
  ready at a time.
- **Skill: wording fixes.** `REFUTED` is the verdict that sends a brief
  back for rewrite (there was no `AMEND`); SKILL.md drops text that
  restates `--help` and the outside-pi spawn steps, uses VOCABULARY
  terms, and models, worker and brief recipes get checkable Done whens.
- **Skill: model tiers.** New `skills/mu/recipes/models.md` ranks models
  by position in a lab's lineup (frontier, strong, mid, cheap, local),
  says which roles need which tier, and keeps local models as a last
  resort. Checkers run at the tier of whoever wrote what they check, or
  higher, from another family. SKILL.md and ten recipes point at it in
  place of the `pi_mini`/`pi_big` keys. Skill-only: `/reload` in running
  pi sessions to pick it up.

### Fixed

- **Skill: review recipes keep blockers honest.** `UNVERIFIED` findings
  no longer contradict `--if-ready` (umbrella stays open);
  adversarial-review re-blocks downstream work on `review_x_2` after a
  rejection; findings Group blocks the umbrella on the fix before
  superseding; adversarial-review uses *finding* and scopes itself to
  commit-producing units; rules-audit splits delegate/workstream mode;
  tasks-or-calls defines delegate call for scratch and a satisfiable
  Done when.
- **Skill: drift-audit and recovery.** The drift-audit late-note query
  no longer hides an unrelated `CLOSE:` note that follows a close;
  recovery's Done when is per operation and reachable on the DRIFT path;
  its teardown/undo bullets keep only what `--help` lacks.
- **Skill: codemode driver.** The scratch script writes each note to a
  file and pipes it to `mu task note`, so answer text (e.g. a `MU_EOF`
  line) never runs as shell; the stale cap-refusal warning points to
  orchestrator-loop § Concurrency.
- **Skill: remote-workers recipe safety.** Poll only after the worker
  reports done (the poll closes the task); gate on a scratch checkout
  via a temporary ref, never `main`; `--after-runs` takes the send's
  `runs` unchanged; no blanket `pkill -f x2ssh`.
- **`mu agent close` no longer deletes `cp -a` workspaces silently.** A
  `none`-backend workspace can't prove it is clean, so close refuses
  (`WorkspacePreservedError`) unless `--discard-workspace`. SKILL.md and
  waves.md now give the safe `workspace free` path and the `refresh
  --from` fix for unpushed merges.
- **`model` examples with `:<level>` failed through a gateway
  provider.** pi reads the first segment as the provider, so
  `anthropic/…:high` died with "No API key". The models recipe, delegate
  guide and `mu_delegate` help now say to copy `<provider>/<model>` from
  `pi --list-models`; a test pins that `mu_delegate` accepts
  `provider/family/id:level`.
- **`mu agent send` to a dead pane no longer says "ctl: refused".** When
  the control socket is silent and the pane is gone (the CLI exited,
  e.g. no API key), ctl verbs now raise `AgentPaneDeadError` with next
  steps to read the log, close the row and respawn, not link/kick/ssh
  advice. A live pane whose socket refuses still raises
  `AgentCtlUnreachableError`.

## [3.10.2] — 2026-10-09

**The TUI exits on `q` again with sync on.** Upgrade with
`npm i -g @mu-crew/mu@3.10.2`. No schema or pi extension change.

### Fixed

- **`mu` hung after `q` when `MU_SYNC_DIR` was set.** The TUI stopped
  rendering but the process never exited: the 3.10.0 sync worker was
  unref'd before its `message` listener was attached, and attaching it
  re-refs the worker. It is now unref'd after its listeners.
- **The TUI's exit flush no longer waits for the segment lock.** After
  `q`, the flush could wait up to 2 s on a lock held by another mu
  process. The TUI (bare `mu`, `mu state --tui`) now tries the lock
  once; if it is busy, nothing is written and the ops stay in the DB
  for the next flush. The TUI's worker has already flushed every 10 s.
  Other verbs keep the 2 s wait. Exit is ~150-450 ms when the segment
  manifest is sealed. A mu older than 3.10.0 still running on this
  machine rewrites it unsealed, which makes every flush rescan the
  segment, so restart those processes.

## [3.10.1] — 2026-10-08

**`mu_delegate` can pick a model per call**, so a review panel can mix
models from pi without configuring `cli` keys first.

Upgrade with `npm i -g @mu-crew/mu@3.10.1`, then `/reload` in running pi
sessions: the pi extension changed (the new `model` parameter). No schema
change.


### Added

- **`mu_delegate` takes `model`.** The value is appended as
  `--model <value>` to the cli's resolved command (`$MU_<KEY>_COMMAND`,
  else the key) and spawned with `--command`, so a review panel can vary
  models from pi without configured `cli` keys. Values with shell
  characters are refused before anything spawns. herdr refuses a command
  override, so `model` works on tmux only. The `cli` description no
  longer names a `pi_fast` key that may not exist. Reported in
  docs/bugs/2026-10-08-review-panel-friction.md (#1).

### Changed

- Docs: SKILL.md names `mu agent list --json` as the exception to
  `{items, count}`; codemode-driver warns against template-literal
  briefs; `mu agent wait --after-runs` help says one N applies to every
  named agent.

## [3.10.0] — 2026-10-07

**A performance pass: common verbs are 5-14x faster on a large DB with
sync on, and the TUI no longer freezes every 10 s.** On a 69 MB DB with a
56 MB sync dir, `mu --version` drops from ~310 ms to ~60 ms,
`mu task list` from ~1.1 s to ~85 ms, and `mu state` / `mu agent list`
from ~1.2 s to ~0.2 s. The TUI chunk loads only for the TUI, sync flush
and ingest touch only new data, read verbs no longer take the DB write
lock, and the TUI sync pass runs in a worker thread.

Upgrade with `npm i -g @mu-crew/mu@3.10.0`, then `/reload` in running pi
sessions: the pi extension changed (`mu_delegate` starts in one mu call,
nudges run in parallel). No schema version change; the first open adds a
local `sync_fingerprints` table and an index on `ops`, and 3.9.0 still
opens the DB.


### Changed

- `mu state`, `mu agent list` and the `mu state --tui` refresh no longer
  rewrite every agent's pane title on each pass. mu now retitles a pane
  only when its title changed, which cuts tmux server load on hosts with
  many agent panes.
- `mu task list` (and the other task tables) render large workstreams
  much faster: 1901 tasks render in ~10 ms instead of ~1.5 s. Output is
  byte-identical to before, including titles with unclosed ANSI colour
  or zero-width characters.
- **Faster CLI startup.** `dist/cli.js` no longer loads ink, react and
  yoga for every verb: the TUI is a lazy chunk (748 -> 203 modules for
  `mu --version` and `mu task list`). The CLI enables Node's compile
  cache under `<state>/compile-cache`, and skips it when the directory
  is unavailable or unwritable (`NODE_DISABLE_COMPILE_CACHE=1` turns it
  off). The TUI runs React's production build unless `NODE_ENV` is set.
  execa now loads only at its call sites. On a 69 MB DB with a 56 MB
  sync dir, `mu --version` drops from ~310 ms to ~60 ms.
- **Sync flush is O(appended).** A verb with nothing new to sync no
  longer reads and re-hashes the whole own segment, skips the segment
  lock, and leaves the `.manifest` untouched; appends hash only the new
  bytes. A pending flush that cannot take the lock leaves its ops for the
  next invocation instead of appending unlocked after 15 s. On a 41 MB
  segment a no-op flush drops from ~850 ms to ~1 ms, and 16 parallel
  synced verbs from ~10 s to ~1.5 s. `mu task list -w <ws>` on that data
  drops from ~1.1 s to ~85 ms. Explicit `mu sync` still verifies every
  line.
- **Sync ingest is cheaper.** Apply compiles each SQL statement once per
  connection, so a 19k-op catch-up drops from ~17 s to ~1.2 s, and a
  long-lived synced `mu task wait` peaks at ~118 MB instead of ~390 MB.
- Ambient sync ingest skips peers it is caught up on: a peer is skipped
  only when its segment's size, exact mtime and manifest hash match what
  the last clean full read recorded, so any rewrite (even one with a
  backdated mtime) is still read and reported. It also still repairs
  deferred edges and notes after a process died between ingest and
  repair, or when an SDK caller applied them through `applyIncomingOp`:
  a marker in SQLite's `user_version`, set in the applying transaction,
  makes the next invocation run the repair. The skip's fingerprint is kept in a new
  machine-local `sync_fingerprints` table (created on first open, no
  schema bump), so `sync_peers.last_seen_at` stays an ISO timestamp.

### Fixed

- `mu state --tui` no longer freezes for up to ~0.8 s every 10 s while
  it syncs: the slow-tick sync pass runs in a worker thread
  (`dist/tui-sync-worker.js`) with its own DB connection.
- TUI drill popups (DAG, notes) no longer re-wrap their whole body on
  every refresh tick (swayward DAG tick 130-250 ms -> ~6 ms). The TUI
  shares one terminal resize listener, which removes the
  MaxListenersExceededWarning.
- Read verbs no longer take the DB write lock: `openDb` skips its schema
  DDL when the DB is current, so reads stop bumping
  `PRAGMA schema_version` and stop failing with "database is locked"
  behind a long writer. Ops lookups for task claims, `mu undo`,
  `mu log --group` and quiet workstreams use index seeks.
- `mu agent list` and `mu state` probe each pi control socket with one
  `status` connection under one 1 s deadline, so a hung pi adds at most
  ~1 s instead of 2 s. `mu state -w <ws>` with 11 live agents drops from
  ~1.2 s to ~0.22 s on the data above.
- Workspace staleness in `mu state` and the TUI no longer snapshots jj
  working copies, and git resolves the main ref once per repo.
- `mu_delegate` starts a delegate in one mu call: new
  `mu agent spawn --next-free` (take the next free name) and
  `--send <text>` (send the first prompt in the same call; `--json`
  reports `send.runs`). The keep-driving, close and refute nudges check
  in parallel behind one settle handler, and every nudge that fires is
  delivered (before, only the last one survived).

## [3.9.0] — 2026-10-05

**A repo-wide review: about 130 bugs and doc/code mismatches fixed.**
tmux calls now target exact session names, so a workstream never acts on
another workstream's session, and `mu workstream teardown --empty` no
longer kills live or unregistered sessions. The test suite's tmux sweep
no longer kills your sessions. Undo, sync ingest, `mu sql` capture and
`--confirm-rows`, and `mu rebuild --force` keep data intact; workspace
refresh records the new fork point, `mu workspace free --commit` keeps
git commits, and jj workspaces work across workstreams. The `mu-scratch`
session stays open after its last agent, and concurrent writers no
longer fail with `database is locked`.

Upgrade with `npm i -g @mu-crew/mu@3.9.0`, then `/reload` in running pi
sessions. The pi extension changed (`mu_delegate` queue drain, nudge
parsing). No schema change.

### Changed

- `mu workstream teardown --empty` no longer kills `mu-*` sessions
  that have no workstream row. With no row there is no evidence the
  session is idle (a pane running a `bash -c` loop reports `bash`), and
  a run against a throwaway `MU_DB_PATH` had killed a live crew's panes.
  The sweep now takes registered empty workstreams only, and names the
  skipped sessions so you can tear one down by name.
- The `scratch` tmux session now outlives its last agent, so the next
  delegate does not pay for creating it again. The first spawn into
  `scratch` creates `mu-scratch` with the placeholder `_mu` window that
  `mu workstream init` creates (and adds it when an existing
  `mu-scratch` lacks it). `mu workstream teardown --empty` no longer
  sweeps the idle `scratch` session; `mu workstream teardown scratch
  --yes` still removes it. On herdr, the `_mu` tab is now labelled, so
  re-running `mu workstream init` no longer adds a second one.
- `mu -w <ws> <verb> …` works. The root `-w` was variadic and swallowed
  the verb, so `mu -w ws task list` printed help and exited 0. It now
  takes one value per flag and hands it to the verb's own `-w`; a verb
  without `-w`, or `-w` on both sides, is a usage error (exit 2). This
  also stops `mu --workstream=other workstream teardown --yes` from
  tearing down the `$MU_SESSION` workstream: teardown and `mu state`
  ignored a root `-w` and fell back to the ambient one.
- `mu sql` refuses to change a natural-key column (`workstreams.name`,
  `tasks.workstream_id`, `tasks.local_id`, a note's task, an edge's
  endpoints). Such an UPDATE wrote no op, so the ops log, sync, undo,
  and `mu doctor` disagreed with the table. The cross-workstream-edge
  hint no longer prints a "move the blocker" UPDATE, and the recovery
  guide no longer renames a workstream with `mu sql`.
- `mu log --kind` refuses `workstream`, `task`, `edge`, and `note` (exit
  2). A log line under one of those kinds was synced and replayed as a
  real change, so `mu rebuild` and every peer's `mu sync` failed with
  "malformed task key".
- Numeric flags reject trailing text and non-finite values instead of
  keeping a numeric prefix: `-i 5.9abc`, `-e 1e999` (stored as Infinity,
  serialised as null), `mu log -n 2x`, `--since 1.9` and
  `mu undo -n 2x` are now usage errors (exit 2).
- **`mu undo -n` rejects a value that is not a positive integer** (exit 2). Before, `-n abc` failed with `datatype mismatch`, `-n 0` claimed the log was empty, `-n -1` listed every group, and `-n 1.5`, `-n 2x` and `-n 1e3` silently used 1, 2 and 1.
- **Typed `mu task add` input errors exit 2.** An invalid task id now exits 2 (usage, with `--help`), like an invalid workstream name. It used to exit 4. A title with no ASCII letter or digit (for example `日本語`) raises `TaskTitleSlugEmptyError` (exit 2) and says to pass the `<id>` positional. It used to be a generic exit 1.
- `mu task wait --timeout`, `--stuck-after` and `mu agent wait
  --timeout` take fractional seconds and reject suffixes. Before,
  `--timeout 0.5` parsed as 0 (wait forever, or stall detection off)
  and `--timeout 10m` as 10 seconds.
- **A bare `mu task close` on a closed task is a no-op.** Without `--as` it keeps the current substate. Before, re-closing a `wontfix`, `rejected` or `duplicate` task silently changed it to `done`. Pass `--as` to reclassify.
- `mu rebuild <file> --force` deletes an existing `<file>` (and its
  `-wal`/`-shm`) before replaying. It used to replay into it, keeping
  that DB's foreign workstreams and ops.
- `mu workspace refresh` on sl now fails when `sl rebase` fails for a
  reason other than a conflict (bad `--from` ref, unresolvable
  `trunk()`). Before, it reported success.
- A DB lock held past the 5 s busy timeout (`database is locked`) exits
  5, as the exit-code table says, instead of 1. The table in
  `docs/architecture/sdk.md` now lists exits 6 and 7.
- `mu doctor` exits 5 when a row FAILs (today: the DB inside
  `MU_SYNC_DIR`), after printing the report or the `--json` payload.
  It printed FAIL and exited 0. WARN rows still exit 0.
- `mu task wait` exits 6 only when the owner's agent row is gone (the
  reaper). A manual `mu task release` or `mu task delete` of a watched
  task no longer reports a dead pane, including when the owner lives in
  another workstream (`mu task claim --for <ws>/<agent>`).
- `mu agent wait` reports a dead pane and exits 6 even when another
  watched agent finished. Before, it printed "All N agent(s) finished"
  and exited 0. `--any` names the agent that finished.
- Two parallel `mu agent spawn` calls with the same name no longer let
  the loser delete the winner's agent row and orphan its pane. The name
  check is repeated inside the spawn lock, and the loser exits 4 with
  `AgentExistsError` instead of a raw `SqliteError`.
- `mu agent adopt` of a pane in another session now throws
  `PaneNotInSessionError` (exit 4). The old error read "agent pane %15
  is in workstream a different tmux session" and suggested a command
  that could not run.
- `mu link pi` no longer writes the shim through a symlinked
  `~/.pi/agent/extensions/mu.ts` into its target, such as a dev
  checkout. A live symlink there is refused (exit 4) unless you pass
  `--force`, which replaces the link and not its target.
- `mu agent remote-env --remote-sock` rejects `:` and `%`. ssh `-L`
  splits on `:` and expands `%` tokens, so the forward broke or pointed
  at a different socket.
- `mu task wait --json` no longer adds a `reachedAt` field to `all`. It
  held the emit time, not when each task reached the target.
- **`mu undo --yes` on an already-undone group says nothing changed.** It used to print `Undid …` with a redo hint naming a group that recorded no ops; `--json` now reports `undoGroupId: null`. The preview no longer lists deleting a row that is already gone.
- `mu workspace refresh` on a workspace already on its base now prints
  "already at <ref> — nothing to replay" and `--json` returns an empty
  `replayed`. Before, it listed every commit above the fork point as
  replayed although the rebase moved nothing.
- `mu agent send` reports bytes as UTF-8 bytes (`sent N bytes`,
  `--json` `sentBytes`, and the `agent.send` op). It used to report
  UTF-16 code units, which undercounts non-ASCII text.
- `scrollbackLines` in `mu agent read --json` and `mu agent show --json`
  is now the number of lines returned, counted the same way in both.
  `read` counted a final newline as an extra line, and `show` echoed the
  requested `-n`.
- `mu workstream teardown --empty --yes` and `mu task delete` no longer
  promise a snapshot or offer `mu undo --yes`, which only lists groups.
  `task delete --yes` prints `mu undo <group> --yes` for its own group
  (and `--json` carries `group`); the sweep points at
  `mu workstream list --torn-down`, one group per workstream.
- `mu db compact --yes` and `mu db forget --yes` now report the shrunk
  DB size. Before and after are measured as pages × page size, so the
  shrink shows even when another connection's open read keeps the WAL
  checkpoint from rewriting the file; mu then says the file shrinks on
  the next checkpoint, and `--json` carries `checkpointed: false`.
  Before, the printed size was the same before and after.
- **SDK: `MuxBackend.attachHint` / `attachCommands` may return a Promise.** herdr needs an async workspace lookup, so the interface allows `string | Promise<string>` (and the same for the command list). Await the result when you call them through `MuxBackend` or `activeMux()`. `tmuxBackend` still returns plain values, and a third-party backend with synchronous methods still satisfies the interface.
- **A Syncthing conflict copy keeps its own watermark.** It shared the
  original's line count, so ops that existed only in the copy were
  skipped silently. The SDK's new `PeerSegment.watermarkKey` and
  `PeerStatus.watermarkKey` fields are optional; without them, the
  watermark is keyed by `machineId`.
- The SDK (`src/index.ts`) now exports every typed error the CLI maps
  to an exit code, including `SchemaTooNewError`,
  `WorkstreamNotFoundError` and `TaskIdInvalidError`.

### Fixed

- **tmux: a workstream never acts on another workstream's session.** Session-level calls (`has-session`, `kill-session`, `list-windows`, `new-window`, `list-panes -s`) target `=mu-<name>:`, so they no longer fall back to tmux's prefix match. Before, `mu workstream teardown auth` with no `mu-auth` session killed `mu-auth-refactor`, and reconcile listed its panes. `mu agent spawn --tab <window>` splits the window it listed by id (`=mu-<name>:@N`), so a session that vanishes mid-spawn fails the spawn instead of adding the pane to `mu-<name>-…`'s window of the same name.
- The test suite's default-socket tmux sweep no longer kills your live
  `mu-*` workstream sessions when your DB lives under `MU_STATE_DIR` or
  `MU_DB_PATH`, or is missing, locked, corrupt or on a newer schema. It
  reads every DB path mu resolves and skips the sweep when it cannot
  read one.
- Concurrent `mu` processes no longer fail with `database is locked`
  when one closes an agent or task while others write. Every write
  transaction now takes the write lock at `BEGIN IMMEDIATE`, so
  `busy_timeout` waits for it. A deferred transaction that read and
  then wrote failed at once if another process committed in between.
- **`mu undo` no longer refuses after a `mu task note`.** A note touches its task's `updated_at`, and undo counted that as newer work, so undoing an earlier edit exited 4 unless you passed `--force`. A later write to `updated_at` alone is no longer a conflict.
- **`mu undo` restores a field the action wrote twice.** `mu task park` and `mu task close` write `updated_at` twice, and undo restored the intermediate value instead of the value from before the action.
- **Undoing a claim or release restores the owner too.** Before, undoing a claim left the task OPEN but still owned, so other workers could not claim it. Undoing a release left the task IN_PROGRESS with no owner. Undo now restores the owner from this machine's ops if that agent still exists. A task that arrived from a peer, or that a peer re-created after a delete, goes back to unowned.
- **`mu undo` no longer lists or plans a legacy `workstream.export` group.** Its prose payload made the preview crash with a JSON error, or, with no earlier op for the workstream, plan deleting it.
- **Sync ingest no longer wedges on a segment written by mu < 1.1.** A
  historical `workstream.export` line (prose payload) threw a JSON
  error that rolled back the whole segment on every invocation. Ingest
  now skips it, as flush and `mu sync --from` already did.
- **`mu sync --repair <short>` works when the peer has a conflict
  copy.** The short id matched both files and exited 4. A ref now names
  a machine, and repair resets every file of that machine.
- **A blank line in your own segment is now self-repaired.** The owner
  skipped it while peers halted on it, so peers stopped there forever.
- **A segment shorter than its manifest no longer suggests
  `--repair`,** which cannot clear it. The warning says to copy the
  file again.
- **A peer now deletes a note whose tombstone key shifted.** When a reprojection gave a note a new rowid, its tombstone carries the full row, but apply only looked for a put under the tombstone's key and skipped it, so rebuilds and peers kept a note the origin had deleted. Apply now reads the tombstone's own payload.
- `mu sql` writes share one undo group with the intent `sql.write`, so
  `mu undo` reverts a whole `mu sql` call and `mu log` prints prose
  instead of raw JSON. Before, each changed row was its own
  "(no intent)" group.
- `mu sql --confirm-rows` counts the same rows for one statement as for
  a script: rows removed by `ON DELETE CASCADE` are now counted on both
  paths. `UPDATE ... RETURNING` is accepted as a write. The SQL runs
  once: the count comes from the same execution that commits, so a
  nondeterministic `WHERE` can no longer commit a count other than N.
- `mu workspace refresh` now records the new fork point as the
  workspace's `parent_ref`. Before, the `behind` count never cleared,
  `mu workspace commits` listed main's commits as the worker's, and
  `mu agent close` refused to free a refreshed workspace that held
  nothing. A refresh onto an older base (origin/main behind a workspace
  forked from local main) keeps the old fork point instead of moving it
  back. A conflicted refresh leaves it unchanged; refresh again after
  resolving, as the conflict hint now says.
- `mu workspace free --commit` on a git workspace no longer loses the
  commits. The worktree's HEAD is detached, so removing it left the
  auto-commit, and any commit the agent made, on no branch for `git gc`
  to delete. mu now creates the branch `mu/<workstream>/<agent>-<sha>`
  when no branch, remote or tag already holds HEAD, and prints it.
- **jj workspaces: same-named agents, missing dirs, project root, empty `@`.** A jj workspace is now named `<workstream>/<agent>`, so `worker-1` in two workstreams on one repo no longer fails with "Workspace named 'worker-1' already exists". Creating a workspace forgets a same-named registration whose directory is gone, so a workspace freed after `rm -rf` can be recreated. The TUI's project-root launch focus now maps a jj workspace to the repo it came from (via `.jj/repo`) instead of mu's state dir. `mu workspace commits` and the clean-workspace auto-free on `mu agent close` no longer count jj's empty, undescribed working-copy commit as a commit.
- `mu workspace refresh --help` and the conflict hint no longer say a
  git or sl workspace is left mid-rebase to resolve. Those backends
  abort the rebase, so the hint now says to rebase by hand. jj keeps the
  rebase and its conflicts, and the hint says so.
- **`mu_delegate`: a failed start no longer strands the queue.** When a direct call failed to start (spawn error, control socket not ok) while another call sat queued behind it, the freed slot went unused and the queued call never started. Now any start, queued or direct, starts the next queued call once its slot is free.
- **Keep-driving and refute nudges parse claims the same way.** The keep-driving nudge now arms on `mu task claim <id> -f <w>` and `--for=<w>`, and reads the workstream from `<ws>/<id>` after a leading `--for`. Both nudges count `mu` only as a segment's command (after any `NAME=value` env assignments), so `grep mu agent send` and heredoc bodies do not count as dispatch. A `<<<` here-string or a `<<` shift inside `$(( ))` does not start a heredoc, so a later claim still counts; a `((` that closes as nested subshells (`((cd x && cat) <<EOF … )`) still does, and a `#` comment is skipped, so neither exposes a heredoc body as dispatch. A backslash-newline continuation no longer becomes a word, which made the task id `\n`.
- `mu task wait` follows a watched task's owner into its own workstream
  (`mu task claim --for <ws>/<agent>`). It reconciles that workstream,
  so the owner's dead pane exits 6, and it reads the owner's state there,
  so `--stuck-after` and `--on-stall exit` (exit 7) fire. The stall hints
  name the owner's workstream. Before, such a wait ran on to the exit 5
  timeout.
- `mu task wait --status OPEN` no longer reports a task deleted
  mid-wait as reached.
- **tmux: `mu agent send` to a dead pane fails at once** (non-pi agents and `--via mux`). It polled the full readiness budget (`MU_SEND_READINESS_MS`, 15s) before failing with "can't find pane" (or "no current target" when the server has zero sessions). A transient capture failure still waits.
- **tmux: a missing socket file means "no server".** On a fresh boot, a cleared `/tmp` or a new `TMUX_TMPDIR`, tmux reports "error connecting to … (No such file or directory)". `mu state`, `mu agent list` and teardown now treat it like "no server running" instead of exiting 5.
- **tmux: `mu agent read -n N` and `mu agent show -n N` print the last N lines.** They printed the visible screen plus N rows above it. Trailing blank rows below the cursor are dropped first, so the result matches herdr's `--lines N`.
- `mu agent spawn` of a pi agent whose control socket answered no longer
  rolls back on a `No such file or directory` or `command not found`
  line in the pane tail. A resumed `--session` shows such lines as old
  tool output. The scan still catches provider and auth errors, and
  `AgentSpawnStartupError` no longer suggests API-key fixes for an
  exec failure.
- **herdr: attach hints land on the workstream.** The `Next:` attach line (`mu workstream init`, `mu agent spawn`) and the TUI's `a` key ran `herdr session attach mu-<ws>`, which starts a new, empty herdr server named after the workspace label. They now focus the agent's tab or the workspace by id (`herdr tab focus w1:t2`), then open a client with `herdr` when run outside a herdr pane, and carry `--session <name>` when `MU_HERDR_SESSION` is set.
- **herdr: the first agent's tab carries its name.** herdr labels a new workspace's first tab "1", so attach to the first agent spawned in a workstream fell back to focusing the workspace and showed whichever tab was active. mu now renames that tab to the agent's window name (or `_mu` for `mu workstream init`), as it already does for every later tab. If that rename fails, mu closes the new workspace before reporting the error, so a failed spawn leaves no bare-shell `mu-<ws>` workspace behind.
- **herdr: `mu agent adopt w1:p2` adopts by pane id.** Only `%`-prefixed arguments were treated as pane ids, so a herdr id was looked up as a pane title and failed. The orphan hint in `mu agent list` now shows a real orphan's id instead of a hardcoded `%15`.
- **herdr: orphan panes are surfaced.** herdr panes reported an empty command, so `mu agent list` and `mu doctor` never listed a herdr pane running an agent without a registry row. The pane's command is now the agent kind herdr detected.
- **herdr: clearer errors.** A herdr failure with empty stderr shows stdout instead of "no output". A vanished pane in `mu agent kick` reads "herdr pane not found" with herdr remediation. A creation verb given a command no longer claims to be "not implemented yet (owned by task mux-herdr-spawn)".
- A DB refused with `SchemaTooOldError` or `SchemaTooNewError` is now
  really left untouched. mu used to switch it to WAL mode (rewriting
  the header and creating `-wal`/`-shm`) before checking the version.
- An empty or relative `XDG_STATE_HOME` is ignored, as the XDG spec
  says. It used to put the state dir at `./mu` relative to the cwd.
- `mu log --source system` now lists the ops `mu log` shows as
  `system` (captured with no actor). It used to print "(no log
  entries)". `-n/--lines` help now says that with `--since` it keeps
  the first N entries after the cursor, not the latest N.
- `mu sync` suggested `mu log --limit 20`, which exits 2. It now
  suggests `mu log -n 20`.
- `mu log` renders `task accept` as `→ OPEN` instead of the raw field
  name `substate`.
- `mu task list` sizes the status column by the rendered pair (e.g.
  `CLOSED/wontfix`), so rows no longer run past the terminal width.
- `mu task notes --since` compares timestamps as instants. A cutoff
  without milliseconds or with a UTC offset no longer hides notes.
- `mu task wait --help` no longer names an `--all` flag that does not
  exist. Waiting for every task is the default.
- **Auto-derived ids keep a word that ends exactly at the 40-character cap.** That word used to be dropped.
- **`mu task block` and `mu task reparent` find the blocker in the dependent's workstream.** When another workstream that sorts earlier had a task with the same id, both verbs bound to that one and failed with a cross-workstream error. They now look in the dependent's workstream first, as `mu task add -b` already did.
- A commander parse error after a leading root option
  (`mu --json task list --bogus`, `mu -w x task note …`) now shows the
  verb's usage and hints instead of the root `mu` help.
- `mu doctor`'s case-collision fix now ends with
  `mu workstream teardown <old-name> --yes`; without `--yes` it was a
  dry run.
- `mu doctor`'s `ops rows` counts the workstream's task, note and edge
  ops. It counted only the workstream's own row.
- Orphan workspace dir advice no longer says `mu workspace free`, which
  does nothing without a row. The doctor `ws-dirs` row, the TUI doctor
  drill and `WorkspacePathNotEmptyError` give the `mu workspace orphans`
  recipe: `git worktree remove --force` from the project root, else
  `rm -rf`.
- The doctor `db-copies` row names the `mu.db.pre-compact-*` /
  `pre-forget-*` backups mu writes, instead of calling them hand-made
  copies. The `schema` and `schema_version` advice no longer claims
  `openDb` migrates older DBs (it refuses them). The `exports` row says
  the export verb went in 1.1.0, not 1.0.
- The TUI doctor popup's murmur row matches the card on herdr (`agent
  state from herdr`) instead of warning that murmur is missing.
- The commit view (TUI `show`) clips a commit whose `show` output is
  over 200,000 bytes at the 100,000-character cap and marks it
  truncated. Before, it showed an error and no text. A command that
  floods stderr shows an error instead of an empty commit.
- TUI: an active `/` filter no longer pushes a popup past the pane, and
  long drill bodies no longer do either. Both used to overwrite the
  popup's title border and clip its bottom border and hint.
- TUI: a double-click on a popup row drills the row you clicked. It
  ignored the scroll position, so a scrolled list opened a row near the
  top, and All tasks was off by its three strip rows.
- TUI: Tracks, Commits and Activity log drills stay on the row you
  opened. A filtered Tracks drill opened the unfiltered list's track,
  and a new commit or log event switched an open drill to another row.
- TUI: the Tracks task-detail leaf stays on the task you opened. A task
  that changed status re-sorted the track's task list, and the open
  leaf switched to the task now at that position.
- TUI: `?` over a popup keeps its cursor, filter and drill. Closing help
  used to reopen the popup's first row.
- TUI: popup hints and the `?` overlay no longer advertise
  `Shift 0-9 switch`. Only one popup is open at a time.
- TUI: the Doctor card and the Agents card's control-socket glyph update
  on the slow tick. Doctor and agent `ctl` changes were dropped until an
  unrelated field changed.
- TUI: the Workspaces card and popup show commits behind main again.
  They always showed `—`.
- TUI: the `/` filter accepts pasted text and non-ASCII characters. Both
  were dropped.
- TUI: launch focus counts task, note and edge activity when it breaks a
  project-root tie. It counted only agent and workspace rows.
- **Correct hints.** `mu task tree --down` says "omit --down" (there is no `--no-down`). The "commit" hint on `mu task close` matches the workspace's VCS and includes untracked files (`git add -A && git commit -m`, `jj commit -m`, `sl commit --addremove -m`). Before, it was always `git commit -am`, which refuses when only untracked files are dirty. The dormant-workstream hint lists `OPEN,IN_PROGRESS` tasks to match its unclosed count. The invalid-workstream-name hint no longer suggests a name that fails the same check. The invalid-task-id hint no longer names a nonexistent `--id` flag, and the not-found hint no longer prints the same recipe twice.
- **README quick start runs as written.** `mu workstream init` does not
  attach you to `mu-<name>`, so the next verb failed with "workstream
  required". The quick start now exports `MU_SESSION`.
- **The migration recipe says it needs a git checkout.** The npm package
  ships neither `scripts/` nor `src/`; `docs/guide/upgrade.md`,
  `scripts/README.md`, and the `SchemaTooOldError` next step now say so.
- **The `drift-audit` recipe's check 3 no longer flags every closed
  task.** Its query counted the `CLOSE:` / `<SUBSTATE>:` note that
  `mu task close` writes right after the close op; it now skips them.
- **Docs match the code.** `mu_` is no reserved task-id prefix (skill
  guardrail removed). Task ids allow 64 chars and are unique per
  workstream; `--tab` names are not validated; no
  `<state-dir>/workstreams/` dir exists (`docs/reference/naming.md`).
  `docs/reference/env.md` lists `TMUX`, `TMUX_PANE`, `HERDR_PANE_ID` and
  `HERDR_WORKSPACE_ID`, and says `MU_TMUX_SOCKET` skips `~/.tmux.conf`.
  The DB partitions by `workstream_id` (no `session_id` column).
  `workstream destroy` is `workstream teardown`. The delegate outcome
  list includes `error`. VISION no longer claims the TUI runs no
  subprocesses.
- **The doc/CLI drift test checks more commands.** `mu` inside a path
  or a quoted brief no longer exempts a command, and `drift-audit.md`
  is checked (a test now fails if a recipe is left out).
- **Docs: herdr refuses command overrides.** `docs/guide/backends.md` and `docs/reference/env.md` said `MU_<CLI>_COMMAND` is ignored on herdr; spawn refuses it and `--command` with exit 2.

## [3.8.1] — 2026-10-05

**The mu skill loads again.** 3.8.0's skill description contained ": ",
which YAML reads as a nested mapping, so pi rejected the frontmatter
("Nested mappings are not allowed in compact mappings") and dropped the
mu skill. The description is now a folded block scalar with the same
text, and a test checks SKILL.md frontmatter the way it already checked
prompt templates.

Upgrade with `npm i -g @mu-crew/mu@3.8.1`, then restart pi or `/reload`.
No schema change.

## [3.8.0] — 2026-10-05

**Checks before you commit, and decisions that keep their evidence.**
The mu skill now leads with refuting a claim, plan or brief through a
fresh `mu_delegate` call before acting on it. `mu_delegate record`
writes the refuter's verdict onto the task it judged, and bare decisions
warn. `mu agent send --interrupt` redirects a busy pi now, `mu agent
wait --after-runs` waits from an exact baseline, and a new `drift-audit`
recipe finds what an orchestrator has let slip.

Upgrade with `npm i -g @mu-crew/mu@3.8.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents spawned before 3.3.0). The pi
extension gains the ctl op `interrupt`; older extensions fall back to
abort plus send. No schema change.

### Changed

- **`mu_delegate` `record`: a check's verdict lands on the task it judged.** `record: { task, workstream? }` checks the task exists before spawning, then writes the answer's last `VERDICT:` line and its `EVIDENCE:` lines onto that task as one note headed `REFUTER <label> (...)` (a no-verdict note on timeout, death, error or cancel). The follow-up says where it was recorded.
- **Warnings on bare finding decisions; decision notes stand alone.** `mu task accept` and `mu task close --as rejected|wontfix|duplicate` on a triage finding warn (stderr, `warnings` in `--json`; exit code unchanged) when the reason is under 40 characters and no `VERDICT:` or `REFUTER` note is recorded. REJECTED and SUPERSEDED notes add the title of each task id they name (file names like `fix.ts` are left alone). Evidence notes from accept, open, unpark, release and claim are attributed to the actor instead of `<orchestrator>`.
- **Prose-safe text input.** `mu task note <id> -`, `--text -`, `mu task add --note -` and `mu agent send <a> -` read the text from stdin verbatim, so prose goes in through a quoted heredoc (`- <<'EOF'`). A note that is only `-`, empty or whitespace warns instead of being stored silently. A "too many arguments" error on those verbs hints that an apostrophe ended a single-quoted string. The skill documents the variable form (`v=$(cat <<'EOF' … EOF)`) for `--why` and `--evidence`.
- **Skills: decisions keep their evidence.** Refuters record their VERDICT/EVIDENCE on the finding (`record`, or a hand-written `REFUTER` note) before anyone decides; `--evidence` and `--why` name the deciding check, not a tally; review rejections give a reason per gap; an orchestrator that closes a review itself writes the same FILES/COMMANDS/VERIFIED note and names the commit. Tournament judges keep `WINNER:` on the umbrella.
- **Skills: adversarial model choice.** Reviewers, refuters, judges and auditors use a model at least as capable as the worker, from another family where one exists, never a smaller or local one; the same model in a fresh context is the fallback. SKILL.md lists recognisable small-model signs and a probe to run before spawning a reviewer.
- **`mu agent send --interrupt` acts now.** For a busy pi it aborts the running tool, waits for pi to settle, then sends the text as a new run (new ctl op `interrupt`; older extensions fall back to abort plus send, never paste; exit 5 and nothing sent if pi doesn't settle). `--steer` no longer claims to interrupt: it lands after the current tool call. A send queued on a busy pi prints how long it has been busy and names `--interrupt`.
- **Refute briefs before dispatch.** The skill (SKILL.md, plan.md step 7, brief.md) says a brief that asserts a cause, fix approach, threshold or claim about existing code is refuted by a delegate before a worker gets it. The pi extension adds a refute nudge: `mu task claim <id> --for` on a task with no `REFUTER`, `VERDICT:` or `REFUTE-EXEMPT:` line gets one visible notice per prompt (`review_*` tasks exempt; `MU_NUDGE=0` turns it off). The nudge parsers now ignore shell separators inside quotes.
- **A broader mu skill description.** It now leads with check-before-commit: before acting on a claim, root cause, plan, fix or brief, have a `mu_delegate` call refute it. It also covers second looks at your own work, parallel read-only work, background helpers and crews, in 501 characters (was 714). The `mu_delegate` tool description gains the same check-a-claim clause.
- **A nested pi is not the agent.** A pi run inside a mu agent's pane (`pi -p`, a model probe) finds the agent's control socket already served and no longer gets the agent's close, refute or keep-driving nudges; its stderr line says "nested pi: mu agent features off". Before, the close nudge took over the `-p` run and printed a reply about the agent's task instead of the requested work. Close and refute nudges also skip a pi without UI (print and json modes). A pi without `MU_CTL_SOCK` (an orchestrator) keeps every nudge.
- **When to pass `record`.** SKILL.md Quick checks and the `mu_delegate` tool description say it outright: a check that judges a mu task lands its verdict on that task (`record` on `mu_delegate`, or a hand-written `REFUTER` note on the `scratch` spawn path); with no task, skip both.
- **The TUI no longer shows closed tasks as running.** The owner column shows the live state glyph only on IN_PROGRESS rows; closed and reopened tasks show the owner's name alone (ownership on closed tasks is kept for history).
- **Drift audit.** A new `drift-audit` recipe: a read-only delegate the orchestrator runs periodically to find drift: notes a running worker never saw, stale pinned inputs, notes on closed tasks, decisions with no evidence, silent tasks, promised work never filed, and unrefuted briefs. `mu agent send` now records a local `agent.send` event (mode, transport, how long the target was busy), and `mu task note` on another agent's running task says that agent won't see it and suggests `--steer` or `--interrupt`.

## [3.7.0] — 2026-10-04

**pi agents drop more pre-ctl workarounds.** `mu agent wait --after-runs`
gives an exact send→wait baseline, so a fast run no longer hangs the
wait. pi spawns skip a fixed 1.5 s sleep and roll back when pi dies
during the handshake. Teardown removes control sockets, the scratch idle
nudge reads live state, and `Next:` hints and error advice use the
control socket where it answers exactly.

Upgrade with `npm i -g @mu-crew/mu@3.7.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents spawned before 3.3.0). No schema
change. `mu agent wait --lines` is removed (it had no effect).

### Changed

- **`mu state -w scratch` nudges only helpers that are actually idle.** The "idle scratch agent(s)" nudge used `agents.updated_at`, which is written only at spawn, so every helper older than 5 min was flagged even while busy. It now uses the live `idle` flag (`needs_input` past `MU_IDLE_THRESHOLD_MS`); a helper whose state is `unknown` is no longer nudged.
- **Docs: remote pi workers.** The remote-workers auth-prompt trap now applies only to non-pi CLIs and `--via mux` (a pi agent behind a prompt reports `ctl: missing`, and send never pastes). getting-started's exit-7 row states the 5 s pi / 120 s threshold.
- **`mu workstream teardown` removes its agents' control socket files.** Teardown deletes agent rows by cascade and never unlinked their sockets, so ssh `-L` forward sockets and `sock/<ws>/` were left behind. Each agent's socket (including hashed `sock/h/` paths) is now unlinked before the rows go, and `sock/<ws>/` is removed only when empty.
- **A tmux pi spawn no longer waits a fixed 1.5 s.** The pane is checked on each ctl handshake tick, so a pi that dies during startup rolls back at once with `AgentDiedOnSpawnError` (with its scrollback) instead of leaving a dead agent row after a 30 s ctl timeout. Non-pi CLIs, herdr, and `MU_SPAWN_CTL_MS=0` keep the old liveness check.
- **`mu agent wait --after-runs <n>`: an exact send→wait baseline for pi.** `mu agent send --json` now reports pi's run count before the send (`runs`), and `mu agent wait --after-runs <n>` waits for the first run past it. A run that finishes before the wait starts no longer hangs to `--timeout`, and `--after-runs <runs-1>` on an idle pi returns the last run's `lastText` at once. `mu_delegate` and the scratch recipes use it. A plain ctl send no longer makes an extra status probe. Removed the dead `mu agent wait --lines` option.
- **Exact `Next:` hints for pi agents.** `mu agent send` suggests `mu agent wait --after-runs <runs> --json`; `mu agent wait` drops the redundant pane read when it returned `lastText`; a stall (warning or exit 7) leads with `mu agent wait <owner> --after-runs <runs-1> --json` before the pane read; an abort that reported idle drops "Read the pane". Hints for non-pi agents are unchanged.
- **ctl error advice.** A pi agent at its project trust prompt has no socket yet, so it shows `ctl missing`, not `needs_input`. The ctl-missing error and `mu doctor` now suggest answering `/trust` or respawning with `pi --approve`. An outdated-extension error suggests plain `mu agent send <a> '/reload'` when the extension serves op `command`, and `--via mux` only for older ones; `mu doctor --json` reports `reloadVia` per outdated agent. With the mu extension linked, the old-murmur doctor warning says it affects only non-pi CLIs.

## [3.6.2] — 2026-10-04

**A settled pi worker stalls a wait in seconds, not two minutes.** For a
pi owner read over its control socket, `mu task wait` now reports a
stall after 5 s instead of 120 s.

Upgrade with `npm i -g @mu-crew/mu@3.6.2`. No schema change.

### Changed

- **`mu task wait` flags a settled pi worker after 5 s, not 120 s.**
  For an owner read over its control socket, `--stuck-after` now
  defaults to 5 s. ctl's idle is exact, and it arrives only after the
  close nudge has run, so a pi worker that is idle and still owns the
  task has already declined to close it. Waiting two more minutes adds
  nothing. An idle owner with queued messages (`pending`) is not
  flagged. murmur, herdr, and broken-socket owners keep the 120 s
  default. An explicit `--stuck-after N` applies to every owner. The
  SDK gains `ctlStuckAfterMs` and `DEFAULT_CTL_STUCK_AFTER_MS`.

## [3.6.1] — 2026-10-04

**murmur's `error` state is read as waiting, not unknown.** murmur 1.2.0
marks a pi run whose last turn failed as `error`. mu read that token as an
unrecognised murmur state; it now maps to `needs_input`, like `done` and
`crashed`, so an errored worker shows as stopped and waiting on someone.

Upgrade with `npm i -g @mu-crew/mu@3.6.1`. No schema change.

## [3.6.0] — 2026-10-04

**Stalled workers surface by default; workers are told to close.**
A bare `mu task wait` now exits 7 when a worker has sat in `needs_input`
for two minutes (`--on-stall exit` and `--stuck-after 120` are the new
defaults), so an orchestrator that forgets the flag no longer polls
until `--timeout`. A mu-spawned pi worker that ends its turn still
owning an `IN_PROGRESS` task gets one reminder to close it or say why
not.

Upgrade with `npm i -g @mu-crew/mu@3.6.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents mu spawned before the
upgrade). No schema change. Scripts that run a bare `mu task wait` and
relied on it polling past a stall need `--on-stall warn`.

### Changed

- **`mu task wait` now exits 7 on a stalled worker by default.**
  `--on-stall exit` is the default; pass `--on-stall warn` for the old
  keep-polling behaviour. Orchestrators kept forgetting the flag and
  polled past a worker that needed them until `--timeout`. A script that
  runs a bare `mu task wait` now gets exit 7 where it used to keep
  waiting. The
  `--status OPEN|IN_PROGRESS` carve-out is unchanged, and the SDK's
  `waitForTasks` still defaults to `warn`.
- **`--stuck-after` defaults to 120 s, down from 300.** Workers are now
  reminded to close (below), so one still idle after two minutes needs
  the orchestrator. `MU_IDLE_THRESHOLD_MS` (the `idle` flag in
  `mu state` and the TUI) stays at 5 minutes.

### Added

- **Close nudge: a pi worker that stops while owning a task is told to
  close it.** In a mu-spawned pi (`$MU_AGENT_NAME` + `$MU_WORKSTREAM`,
  not `scratch`), the extension checks `mu task owned-by` when a turn
  completes. If the worker still owns an `IN_PROGRESS` task, it injects
  one `mu-close-task` message naming the task and its `mu task close`
  command, or asks for a one-line reason if blocked, and continues once.
  Fires at most once per prompt and logs `mu log --kind nudge`.
  `MU_NUDGE=0` turns it off, along with the keep-driving nudge.

## [3.5.0] — 2026-10-04

**Delegates that queue, report, and fail visibly; a slimmer mu.db.**
`mu_delegate` no longer refuses past its cap: 16 run and up to 64 wait
in a queue, pi's footer shows each call from the moment it is made
(`running, starting, queued, failed`), and an API error after pi's own
retries comes back named, with the pane kept, for the model to decide.
murmur now holds `done` while a parent's delegates are still out.
Teardowns stop writing every note twice, and `mu db compact` and
`mu db forget <workstream...>` reclaim existing history; `mu doctor`
names the largest workstreams worth forgetting. On one real DB this
took mu.db from 86 MB to 53 MB.

Upgrade with `npm i -g @mu-crew/mu@3.5.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents mu spawned before the
upgrade). No schema change. `mu db forget` cannot be undone: it backs
up beside the DB first, and that backup is the only way back.

### Added

- **`mu_delegate` reports outstanding delegates to murmur.** Each change
  to the running, starting and queued count is emitted on pi's event bus
  as `murmur:pending`. murmur shows the count on the parent's card,
  renders a parent that stopped to wait as `waiting`, and holds `done`
  until the last answer is delivered. With no murmur loaded, nothing is
  listening and nothing changes.

- **`mu db compact`** applies that to existing history: blanks redundant
  note tombstones, then VACUUMs. **`mu db forget <workstream...>`**
  deletes every op of named torn-down workstreams, **not undoable**; it
  refuses live or never-torn-down names. Both dry-run without `--yes`,
  back up beside the DB first (`mu.db.pre-<verb>-<time>`), and run the
  drift check after. On the same DB, forgetting three old workstreams
  and compacting took it from 83 MB to 42 MB. `mu doctor` shows a size
  hint naming the largest forgettable workstreams.

### Changed

- **Note tombstones are slim.** Deleting a note (a workstream
  teardown deletes all of them) writes `{}` when the log already holds
  the note's put, instead of a second copy of the note. Undo and sync
  read the put. On one real DB this was 8 MB of 86.
- **`mu_delegate` queues past the cap** instead of refusing. At
  `MU_DELEGATE_MAX` running, further calls return `Queued as queued-N`
  at once and start as slots free, up to four caps' worth (64 by
  default); past
  that the tool refuses. A queued call's answer names its handle
  (`delegate-q3 (queued as queued-1) finished`), `mu_delegate_cancel
  queued-N` drops it, and quitting or `/reload` names the calls that
  never started.
- **Delegate API errors are named.** A delegate whose run stops on an
  API error after pi's own retries (overloaded, connection, auth) now
  reports outcome `error` with `lastError` in `mu agent wait --json`,
  instead of `empty`. `mu_delegate` keeps its pane, quotes the error, and
  tells the model to re-issue or record the check as UNVERIFIED; the
  footer counts it as `N failed` until the pane is closed. The control
  socket's `wait` reply carries `lastError` (a running pi needs
  `/reload` to serve it).
- **pi footer** shows each call the moment it is made:
  `2 delegates running, 1 starting, 4 queued, 1 failed`, instead of
  nothing until the pane was up.
- `orchestrator-loop § Concurrency` and the delegate guide note that
  answers arrive only when the agent stops, and that pi's
  `followUpMode: "all"` batches them into one turn.

## [3.4.0] — 2026-10-03

**Findings live in the graph.** A review's findings are now tasks in a
new `OPEN/triage` substate: in the DAG, blocking the review, but out of
`next` and `claim` until someone runs `mu task accept` or closes them
rejected or duplicate. Checks around them (refuters, claim checkers,
judges) are delegate calls whose verdicts land on the finding, so one PR
review no longer adds a task per check. Reviews nobody will track run as
`scratch` delegates. `mu_delegate` is capped at 16 in flight
(`MU_DELEGATE_MAX`), and `mu workstream init` and `mu state` hint at
`<project>-<purpose>` workstream names, one per effort.

Upgrade with `npm i -g @mu-crew/mu@3.4.0`, then `/reload` in running pi
sessions. No schema change: existing DBs gain the substate on open.

### Added

- **`OPEN/triage` substate** for proposed tasks, usually review
  findings. `mu task add --triage` creates one; it stays out of `ready`
  and `next`, `claim` refuses it without `--force`
  (`TaskInTriageError`, exit 4), and it still blocks its dependents, so
  a review cannot close with findings undecided. **`mu task accept <id>`**
  moves it to `OPEN/todo`; declining is `close --as rejected |
  duplicate --why`. `mu state` shows a Triage section (and `triage` in
  `--json`); `task next`, `task list`, `task show`, `claim` and
  `close --if-ready` point at accept and the triage inbox. No schema
  bump: one seeded substate row, per the substates spec (D10).
- **`MU_DELEGATE_MAX`** (default 16): `mu_delegate` refuses a new
  delegate when that many are already running from the session,
  counting parallel calls in one turn. The tool description states the
  cap.
- **Naming hints.** `mu workstream init <name>` prints a hint for a name
  without a `-`: workstreams are `<project>-<purpose>`, one per effort
  (`hint` in `--json`). `mu state` hints once a workstream passes 300
  tasks with fewer than 10% open. `docs/reference/naming.md` documents
  the convention.
- **`recipes/tasks-or-calls.md`** defines a **delegate call** (one
  `mu_delegate` call, or scratch spawn + `send --fresh` + `wait --json`
  without the tool; starts empty; fan out in one turn) and every recipe
  links to it. A refuter, claim checker, judge,
  skeptic, scout or synthesizer is a delegate call whose verdict lands
  on the task it judged, not a task of its own. `refute`,
  `review-panel`, `deep-research`, `tournament`, `rules-audit`,
  `hypothesis-panel`, `fan-out` and `ultrathink` follow it, so one PR
  review no longer adds a task per check. `orchestrator-loop` gains a
  Concurrency section (10 to 20 delegates, about one worker per core,
  ceiling written on the umbrella).
- **Commands** `/mu-debug <symptom>` (hypothesis-panel), `/mu-sweep
  <change>` (fan-out), and `/mu-until <stop rule>` (loop-until-done).
- **`recipes/findings.md`**: the rule every reviewing recipe follows.
  Findings are triage tasks in a workstream (more than 5 from one
  reviewer: note lines first, then a triage pass creates the tasks), or
  answer lines from delegates when nobody will track them (reviewing a
  PR or doc). `refute`, `review-panel`, `deep-research`, `rules-audit`,
  `hypothesis-panel` and `adversarial-review` now record findings,
  claims, violations, hypotheses and gaps as tasks; `review-panel` and
  `deep-research` default to delegates.

### Changed

- **Skill and recipe audit.** `recipes/triage.md` is now
  `recipes/backlog-triage.md`, so "triage" means only the substate.
  SKILL.md defines the recipe words (umbrella, unit, gate, wave,
  finding, verdict, stop rule). A rejected review now closes
  `--as rejected` instead of `done`, so it no longer unblocks downstream
  work; follow-up reviews wait on the gap tasks. Finding and verdict
  lines have one format, owned by `findings.md`. Every recipe has
  "Use when" and "Done when" lines and links the recipes it hands off
  to. `codemode-driver` covers delegate calls as well as workers. The
  README's "Ultrathink, the mu way" and the delegate guide describe
  when a review is delegates only and when it is tasks.

## [3.3.0] — 2026-10-03

**Ultrathink, the mu way.** The mu skill gains a recipe library for
long, multi-agent runs: fan-out, adversarial review, find-refute-
synthesize, hypothesis panels, tournaments, loop-until-done, triage,
deep research, review panels and rules audits, composed by
`recipes/ultrathink.md`. Every unit, review and round is a task in the
DAG, so the run stays visible in `mu state` and survives compaction.
In pi, `/ultrathink <job>` and the `/mu-*` commands start them, and a
one-shot keep-driving nudge stops orchestrators from ending a turn
while their workers are still running.

Upgrade with `npm i -g @mu-crew/mu@3.3.0`, then `/reload` in running pi
sessions (`/reload --via mux` for agents mu spawned before the upgrade).

**Not semver:** one change below breaks a CLI contract in a minor
release. `mu agent send <pi-agent> '/<cmd>'` for any slash command other
than `/new`, `/reload` and `/compact` now exits 2 instead of pasting it
into the pane. Add `--via mux` to keep the old behaviour. It is in 3.3.0
rather than 4.0.0 because only a script typing arbitrary slash commands
into a pi agent can notice, and the old paste could silently drop them.

### Added

- **Keep-driving nudge** in the pi extension. After a session dispatches
  mu work (`agent send`, `agent spawn`, `task claim --for`), if it ends
  its turn while that work is still IN_PROGRESS, the extension adds one
  visible `[mu-keep-driving]` message quoting SKILL.md's rule, with a
  `mu task wait` line for the running tasks, and continues once. A
  second stop stands. Each nudge is logged as `mu log --kind nudge`.
  `MU_NUDGE=0` turns it off; `mu doctor`'s `mu ext` row reports it.
  Spec: `docs/specs/2026-10-03-keep-driving-nudge.md`.

- **Recipe commands in pi.** The mu extension serves prompt templates
  from the package's `prompts/` through pi's `resources_discover`:
  `/ultrathink <job>`, `/mu-research`, `/mu-review`, `/mu-refute`,
  `/mu-tournament`, `/mu-rules-audit`. Each loads the matching recipe; they upgrade with
  mu. Running pi sessions need `/reload` once.
- **`recipes/deep-research.md`** (searchers by angle, one checker per
  sourced claim, cited report) and **`recipes/review-panel.md`** (one
  fresh reviewer per angle on a diff, findings refuted, then fixed or
  reported), and **`recipes/rules-audit.md`** (check mode: one checker
  per written rule plus a skeptic; mine mode: cluster repeated review
  corrections into proposed rules, refuted before a human decides).

- **`recipes/adversarial-review.md`**: a review is a task blocked by the
  work, run by a fresh agent (a different model recommended) against
  criteria written up front. REJECT grows the DAG with `fix_` and
  `review_..._2` tasks instead of rewriting history.
- **Workflow recipes** in `skills/mu/recipes/`: `fan-out`, `refute`
  (find → refute → synthesize), `hypothesis-panel`, `tournament`,
  `loop-until-done`, `triage`, and `codemode-driver` (a codemode script
  that dispatches through mu verbs and holds no state). **`ultrathink`**
  composes them: fix done, scout, pick a shape, plan every unit as a
  task, review every shipped unit, close against the stop rule. Every
  unit, check and round is a DAG task, so the run stays visible in
  `mu state`.
- **`recipes/brief.md`** (how to write a task note or prompt a worker
  with no context will read) and **`recipes/plan.md`** (spec to DAG:
  file map, sizing, `task_0`, INTERFACES, no placeholders, edges only
  for dependencies).

### Changed

- **Skill recipes.** Branch-only material in the mu skill moves to
  `skills/mu/recipes/`, loaded on demand through a recipe index in
  `SKILL.md`. `REMOTE_WORKERS.md` becomes `recipes/remote-workers.md`.
  New recipes `orchestrator-loop`, `worker`, `recovery`, `waves`,
  `long-run` and `watcher` take that material out of the core skill,
  which keeps one-line hard rules and shrinks from 295 to 210 lines.
  No CLI change.
- **Orchestrators keep driving.** SKILL.md states that an orchestrator
  ends its turn only when every task is closed or a human-only decision
  blocks progress; a status summary is a `mu log` line, not a stop.

- **pi agents never touch pane scraping.** `mu agent send <pi> '/new'`,
  `'/reload'` and `'/compact [instructions]'` run inside pi through a
  new control-socket op, `command`, instead of pasting into the pane.
  The reply carries pi's own answer, so `/compact` on a short session
  fails with `Nothing to compact (session too small)` instead of
  looking delivered. They refuse with exit 4 while pi is busy;
  `--force` overrides. `--json` adds `command`. A running pi needs
  `/reload --via mux` once to load the new op.
- **Breaking:** any other slash command sent to a pi agent exits 2
  (`AgentSlashCommandUnsupportedError`) instead of being pasted. Add
  `--via mux` to type it into the pane on purpose.

### Removed

- `MU_SPAWN_READINESS_MS` and the tmux spawn's wait for murmur to claim
  the new pane. pi agents have the control-socket handshake; nothing
  after a non-pi spawn needs murmur's first claim (state reads report
  `unknown` until then).
- The tmux paste path's `/new` screen-transition wait and its
  `transition-unconfirmed` send warning. Only pi's `/new` needed it,
  and pi's `/new` no longer pastes.

## [3.2.1] — 2026-10-02

**`mu_delegate` fixes.** Delegates start in the caller's working
directory, pi's footer shows how many are running, and cancel and
delivery no longer lose answers. Upgrade with `npm i -g
@mu-crew/mu@3.2.1`, then `/reload` in running pi sessions.

The docs are reorganised: `docs/USAGE_GUIDE.md` is split into a
tutorial and how-tos under `docs/guide/`, the pre-3.0 changelog moved
to `docs/history/`, and a link checker covers every markdown file.

### Fixed

- `mu_delegate` refuses a `cwd` that is not a directory. tmux and herdr
  silently start such a pane in `$HOME`.
- `mu_delegate_cancel` whose abort fails no longer drops the answer and
  leaves the footer count stuck: the delegate stays tracked, and an
  answer that landed meanwhile is delivered.
- `mu_delegate` refuses a `timeout` that is not a positive number
  instead of silently waiting an hour.
- A failure while delivering a delegate's answer is posted as a
  follow-up instead of an unhandled rejection.
- A failed send closes the delegate's idle pane and says so. Cancelling
  the tool call during spawn closes the new pane.

### Changed

- `mu_delegate` starts the delegate in the caller's working directory
  (new `cwd` parameter to override). Before, a scratch pane inherited
  the start dir of whichever spawn first created the `mu-scratch`
  session.
- `mu_delegate` shows the number of running delegates in pi's footer
  ("2 delegates running"), the same way `/goal` and `/loop` show their
  state. The entry clears when the last answer arrives or is cancelled.
- `mu_delegate` takes a `timeout` (seconds, default 3600) for how long
  to wait for the answer.
- With `workspace: true`, the tool result and the follow-up name the
  checkout path, so the caller knows where the edits are.
- `mu_delegate` takes a `label` that names the delegate
  (`label: "review"` → `delegate-review`), and the follow-up says how
  long it ran ("finished after 3m 05s").
- The `timeout` doc and the "still running" follow-up say the answer
  will not arrive later; the description says to end the turn when the
  next step needs the answer.
- The follow-up's `details` carry the answer, run time and workspace
  path, so automation can read them without parsing the text. The
  `workspace` doc says it isolates repository edits only: the delegate
  runs as you, with your files, environment and network.
- The tool description leads with "Subagent", so models reach for
  `mu_delegate` when a task calls for a subagent. Parameter docs say
  what `workspace`, `cli` and `brief` do, and that `brief` rules are
  not enforced.

## [3.2.0] — 2026-10-02

**pi agents are driven through a control socket.** `mu link pi`
installs mu's pi extension. The extension serves a per-agent unix socket
(`MU_CTL_SOCK`) inside the agent's normal interactive pi, so send,
state, wait, and abort are exact. Remote agents work the same way over
an ssh `-L` forward (`mu agent remote-env`). murmur is now needed only
for non-pi CLIs. Install is `npm i -g @mu-crew/mu && mu link pi && mu doctor`.

### Upgrade

```sh
npm i -g @mu-crew/mu@3.2.0
mu link pi        # installs the extension and the skill
mu doctor         # mu ext / mu skill / ctl rows should be ok
```

Then restart running pi agents, or type `/reload` in their panes, so
they load the extension. Until then, sends to them fail with
`ctl missing` instead of pasting into the pane. `--via mux` forces the
old paste path.

### Added

- **`mu link pi`** installs the extension as a re-export shim at
  `~/.pi/agent/extensions/mu.ts` (upgrading mu upgrades it; `--copy`
  pins a copy) and the skill as a symlink at `~/.agents/skills/mu`. A
  conflicting link needs `--force` (exit 4). `MU_PI_HOME` overrides the root.
- **Spawn sets `MU_CTL_SOCK` and handshakes** with a pi agent for up to
  `MU_SPAWN_CTL_MS` (default 30s). `--json` reports
  `ctl: ok|missing|refused|skipped`. No answer warns but exits 0.
  `--no-ctl` skips the handshake.
- **`mu agent send` to a pi agent goes through the socket**: `followUp`
  when busy, `--steer` to interrupt. An unreachable socket exits 1
  (`AgentCtlUnreachableError`) and pastes nothing. Text starting with
  `/`, non-pi CLIs, and `--via mux` use the paste path. `--json` gains
  `transport`. `mu agent adopt` probes the socket and prints the
  `MU_CTL_SOCK` to restart pi with.
- **`mu agent send --fresh '<prompt>'`** starts a new session and sends
  the prompt as one operation, for pi agents only. Use it instead of
  `/new` followed by a prompt, which could lose the prompt. A busy pi
  refuses (exit 4); `--force` abandons the running turn.
- **`mu agent abort <name>`** stops a pi agent's turn and returns once
  pi settles (`--timeout`, default 30s; exit 5 if still busy). A queued
  follow-up goes back into the editor unsent. Non-pi agents get exit 2;
  use `mu agent kick`.
- **The socket is the state source for pi agents** in `mu agent list`,
  `show`, `mu state`, `mu me`, and the TUI. A pi agent whose socket does
  not answer reads `unknown` (`ctl missing` or `ctl refused`), never a
  murmur fallback. For `mu task wait --stuck-after` / `--on-stall` it
  counts as needing attention (exit 7 under `--on-stall exit`).
- **`mu agent wait` is event-driven for pi agents** and returns the
  moment pi settles. Exit codes are unchanged (0 met, 5 timeout, 6
  socket lost). `--json` adds `outcome` (`done`, `empty`, `died`,
  `timeout`, `pending`) and `lastText`, the final assistant text
  (cut at 64 KiB).
- **`mu agent remote-env <name>`** prints the ssh args, identity env,
  and an example `--command` for a remote pi agent. It runs nothing.
  `ControlMaster=no` is required: with a shared ssh master the `-L`
  forward never binds. `--shell` prints eval-safe lines; `--remote-sock`
  overrides the remote path.
- **`mu_delegate { task, brief?, workspace?, cli?, keep? }`**: a pi tool
  for async one-shot work in pi sessions mu did not spawn. It spawns a
  `delegate-N` agent in `scratch` and returns at once. The answer arrives
  later as a follow-up message. Clean finishes close the pane unless
  `keep: true`. `mu_delegate_cancel` aborts and closes. `MU_DELEGATE=0`
  hides the tool.
- **`mu doctor` checks the extension, the skill, and every pi agent's
  socket** (`mu ext`, `mu skill`, and `ctl` rows). With the extension
  linked, a missing murmur is `ok`.
- **Extension version skew is reported.** A running pi keeps the
  extension it loaded at start. `--fresh` or `abort` against an older
  extension exits 4 (`AgentExtensionOutdatedError`) and suggests
  `mu agent send <name> '/reload' --via mux` or a respawn. The doctor
  `ctl` row flags old extensions and missing ops.
- **Next: hints show `--fresh` for a new task to a pi agent**, and
  `--steer` / `mu agent abort` when it is busy. Non-pi agents keep the
  old hints. Spawn hints include the attach command.
- Closing or reaping an agent deletes its local socket file.
- A `scratch` agent idle past `MU_IDLE_THRESHOLD_MS` gets the idle
  marker, so leftover delegate panes stay visible.

### Changed

- **murmur is optional for pi agents.** `mu link pi` replaces
  `npx skills add` for pi; other coding agents keep `npx skills add`.
- **One-shot work goes to a delegate** (`mu_delegate`, or
  `mu agent spawn -w scratch` + `send` + `wait --json`), a visible pane
  you can attach to, steer, or abort. The docs no longer point at
  pi-subagents.

### Fixed

- A pi agent spawned under a custom `--cli` key now stays a ctl agent
  for send, `--fresh`, abort, and state.
- A nested pi started inside an agent's pane no longer steals or
  deletes the agent's socket. `/reload` recovers an orphaned socket.
- Notes with repeated text now sync. Note identity now includes
  `created_at`. The first `mu` run after upgrading restores the missing
  notes from the ops log.

## [3.1.0] — 2026-09-30

### Added

- **`CLOSED/rejected`**: the proposal was declined
  (`mu task close --as rejected --why "..."`). `wontfix` now means only
  "valid, but not worth doing". The TUI `w` filter, now labelled
  "won't do", includes it.
- `scripts/migrate.ts` accepts a v11 source and re-derives a fresh v11
  DB from the ops log.

### Changed

- Legacy `REJECTED` history maps to `CLOSED/rejected`, not
  `CLOSED/wontfix`. Upgrading from 3.0.0: run
  `npx tsx scripts/migrate.ts --recover <db>` once, or migrate a copy.
  Recovery keeps a deliberate `close --as wontfix`.
- A 3.0.0 peer applies an incoming `rejected` as `CLOSED/done` until it
  upgrades.

## [3.0.0] — 2026-09-29

**Upgrading from 2.x:** stop every `mu` process, back up the DB, migrate
the backup with `scripts/migrate.ts`, verify, then swap. mu 3.0 refuses
a v10 DB until you do. The recipe is in `scripts/README.md` (removed).

### Breaking

- **Schema v11** adds `task_substates` and a non-null `tasks.substate`.
  A composite FK `(status, substate)` replaces the `tasks.status` CHECK.
  mu refuses a v10 DB (`SchemaTooOldError`, exit 4). Migrate a backup
  with `npx tsx scripts/migrate.ts <backup> --out <db>.v11`, then run
  `mu doctor --deep`.
- mu refuses a DB newer than it understands (`SchemaTooNewError`, exit 4).
- Task JSON gains `substate`. Edges in `mu task show --json` are
  `{ name, status, substate }`.

### Added

- **Task substates**: `OPEN/todo|parked`, `IN_PROGRESS/active`,
  `CLOSED/done|wontfix|duplicate|superseded`. Status alone decides edge
  satisfaction.
- `mu task close --as <substate> --why <text>`. `--why` is required
  unless `--as done` and is stored as a note. Any closed substate
  unblocks dependents.
- `mu task park <id> --why <text>` / `mu task unpark <id>`. A parked
  task leaves `ready` and `mu task next` but stays in `goals`. Park
  refuses `IN_PROGRESS` and `CLOSED` tasks. `mu task claim` needs
  `--force` for a parked task.
- `--substate` filter on `mu task list` and `mu task next`.
- TUI shows status/substate pairs. `p` / `w` toggle parked and
  closed-not-done rows.
- `scripts/migrate.ts` migrates v10 to v11. `--recover <db>` reruns
  legacy substate recovery in place, for example after `mu undo`
  restores a pre-v11 workstream.
- `mu task wait`, `mu task show`, `mu task next`, and `mu log` name the
  substate where it changes your next step.

### Changed

- Legacy `REJECTED` / `DEFERRED` history projects as `CLOSED/wontfix`
  and `OPEN/parked`. Ops payloads are unchanged.
- SDK: `normalizeTaskStatus` is removed. Use `mapLegacyStatus` /
  `resolvePair`.
