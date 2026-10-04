# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases: [docs/history/CHANGELOG-pre-3.md](docs/history/CHANGELOG-pre-3.md).

---

## [Unreleased]

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
- **`recipes/tasks-or-calls.md`**: a refuter, claim checker, judge,
  skeptic, scout or synthesizer is a delegate call whose verdict lands
  on the task it judged, not a task of its own. `refute`,
  `review-panel`, `deep-research`, `tournament`, `rules-audit`,
  `hypothesis-panel`, `fan-out` and `ultrathink` follow it, so one PR
  review no longer adds a task per check. `orchestrator-loop` gains a
  Concurrency section (10 to 20 delegates, about one worker per core,
  ceiling written on the umbrella).
- **`recipes/findings.md`**: the rule every reviewing recipe follows.
  Findings are triage tasks in a workstream (more than 5 from one
  reviewer: note lines first, then a triage pass creates the tasks), or
  answer lines from delegates when nobody will track them (reviewing a
  PR or doc). `refute`, `review-panel`, `deep-research`, `rules-audit`,
  `hypothesis-panel` and `adversarial-review` now record findings,
  claims, violations, hypotheses and gaps as tasks; `review-panel` and
  `deep-research` default to delegates.

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
