# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases: [docs/history/CHANGELOG-pre-3.md](docs/history/CHANGELOG-pre-3.md).

---

## [Unreleased]

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
a v10 DB until you do. The recipe is in [scripts/README.md](scripts/README.md).

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
