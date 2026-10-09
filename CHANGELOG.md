# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases: [docs/history/CHANGELOG-pre-3.md](docs/history/CHANGELOG-pre-3.md).

---

## [Unreleased]

### Changed

- **Skill: model tiers.** New `skills/mu/recipes/models.md` ranks models
  by position in a lab's lineup (frontier, strong, mid, cheap, local),
  says which roles need which tier, and keeps local models as a last
  resort. Checkers run at the tier of whoever wrote what they check, or
  higher, from another family. SKILL.md and ten recipes point at it in
  place of the `pi_mini`/`pi_big` keys. Skill-only: `/reload` in running
  pi sessions to pick it up.

### Fixed

- **`model` examples with `:<level>` failed through a gateway provider.** pi
  reads the first segment as the provider, so `anthropic/…:high` died with
  "No API key". The models recipe, delegate guide and `mu_delegate` help now
  say to copy `<provider>/<model>` from `pi --list-models`; a test pins that
  `mu_delegate` accepts `provider/family/id:level`.
- **`mu agent send` to a dead pane no longer says "ctl: refused".** When
  the control socket is silent and the pane is gone (the CLI exited, e.g.
  no API key), ctl verbs now raise `AgentPaneDeadError` with next steps to
  read the log, close the row and respawn, not link/kick/ssh advice. A
  live pane whose socket refuses still raises `AgentCtlUnreachableError`.

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
