# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases: [docs/history/CHANGELOG-pre-3.md](docs/history/CHANGELOG-pre-3.md).

---

## [Unreleased]

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
