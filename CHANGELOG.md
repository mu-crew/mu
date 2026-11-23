# Changelog

All notable changes to mu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/). mu follows
[Semantic Versioning](https://semver.org/) from 1.0.0 onward.

Older releases, one file per major: [4](docs/history/CHANGELOG-4.md),
[3](docs/history/CHANGELOG-3.md), [2](docs/history/CHANGELOG-2.md),
[1 and 0.x](docs/history/CHANGELOG-1.md).

---

## [Unreleased]

### Added

- [Remote worker ladder guide](docs/guide/remote-ladder.md): choose where to
  run a command or worker, size session capacity, and collect and close.

- **`examples/plugins/mu-plugin-ssh` gains an example `pane` job kind** over
  plain ssh. Session/lease templates remain the supported rung-3 path.
  The example uses mu's built-in `ctl` (with a per-view `-L` forward),
  remote `hooks` or `mux` channels. The view disables SSH multiplexing so
  its forward does not outlive the pane; it needs its own connection.
  Stop requires a receipt for the handle and checks only the recorded
  leader and its process group, not descendants that leave it. A missing
  recorded state root makes stop return an error, but replacing it at the
  same path can make stop report a live job gone and let mu proceed with
  cleanup. Don't move, replace or recreate that root while jobs or delayed
  views may still exist. Use a short canonical path with handle-safe
  components: a trailing newline is silently stripped and can make the
  handle point to a different directory. See the example's file header
  for the full limits.

- **`mu host exec <host> [--cwd <dir>] [--timeout <s>] [--json] -- <cmd>`**
  runs one command through the host's link (no row, task, pane or job).
  Exits with the link's code; exit 5 for a hand-back or when no exit code
  came back (deadline, no answer). Default deadline 600 s; stdout plus
  stderr are clipped at 1 MiB (`clipped`). A legacy template link reads
  its own exit 3 as a hand-back (the documented exception). One `host exec`
  log op records host, link, outcome, duration and the command's byte
  length, never the command or its output. The record is written for every
  dispatched outcome, an error included (by category), but never for a
  refusal before dispatch. The host profile or provider record, plugin
  registration and link instance must still match at dispatch; the plugin
  fit counts script plus cwd; the capture
  is bounded while the command runs; words after `--` are never mu's flags
  (`--json` included); a nonzero exit keeps all piped stderr; no answer says
  the remote command "may still run"; nothing is retried.

- **A plugin job kind without a channel of its own uses mu's built-in
  channels** (ladder placement spec §A). pi is on `ctl`: the `JobSpec`
  carries `sockets` `{local, remote}` and `MU_CTL_SOCK`, the kind's view
  forwards the socket, and spawn runs the ctl handshake. A hook harness is on
  remote `hooks` on tmux (its key in the env and the anchored launch, its
  node read through the plugin's `link.exec`), any other CLI on `mux`.
  The view is interactive on a built-in channel, and stays so on
  `mu agent reattach`. `ctl` follows the same rule as a template spawn
  (`--cli pi --command claude` is on ctl), so a kind that does not honour
  sockets refuses it before any effect. `--no-ctl` and `MU_SPAWN_CTL_MS=0`
  skip only the handshake: the view still passes the liveness window. The
  handshake ends at once on a known fatal startup error in the view (an auth
  failure) and rolls back, and an ok handshake still gets the startup-health
  check; a live, clean view without a socket is only `ctl: missing`. Reattaching
  a detached ctl view removes the gone view's stale socket first and reports
  `ready` only once the new forward answers the handshake (`ctl: missing`,
  `ready: false` otherwise; a view that exits meanwhile is
  `ReattachFailedError`, rollback `view-gone`). A link
  with `slots: "self"` takes no mu host channel, not even during the
  prepare. An `at-start` kind still
  needs its own channel. A `--plugin` profile whose plugin declares a job
  seam now takes the remote spawn's refusals (harness probe, repo, recovered
  tree); a link-only plugin still refuses. No protocol schema change.

- **The D15 job file for a `handle: "file"` plugin kind** (ladder placement
  spec §10). An additive protocol change: `JobSpec.jobFile` (the local path
  mu claims before `job.start`, where the view writes the handle before
  dispatch), and `job.attach` params `jobFile` and `sockets` (the pair
  rebuilt for the new view on `ctl`), sent only to a file kind. Schema digest
  `sha256:54d56d9a865c4e9302f2b63158cb595010ecbb0b59037550609a54d79392ac36`;
  the previous digest stays approved. Spawn reads the handle from the local
  file before it returns (no master needed). A launched record with no
  handle (spawn rollback, a close after a restart, a no-row close) reads the
  file first, then the unresolved `job.start` or `job.lookup` by key; an
  absent file and a lookup's `none` never count as "no job", so the record
  is kept with the reason. The reaper parks the tasks of a plugin job
  record launched with no handle yet, as it does for a lease with one.
  `jobFile` and `sockets.local` are absolute even under a relative
  `MU_DB_PATH`; a ctl socket is shortened on its absolute path, so it never
  overflows the socket limit once resolved, and a template lease's job file
  keeps the name it was published under. A file kind's view is its job's
  dispatcher: its record and job file are kept until that view is proven
  gone, on every path (close, a spawn's rollback, `agent reattach`, a
  close after the reaper, a recovery's view). The record tracks the view
  (`carrier_jobs.view_state`: `none`, `opening` before the mux is asked,
  `open` once its pane is recorded); a view asked for with no pane id, a
  pane not proven gone, and a record older than the column (an upgrade)
  are unknown, and `mu agent close` and `agent reattach` refuse until
  `--abandon-job`. A close racing a spawn takes the record first: the
  spawn then opens no view for it. A
  lookup that hands back (`human`) during recovery stays a hand-back: the
  close exits 5, human needed, the record kept.

### Changed

- Every spawn, including a task-bound or plugin spawn, refuses before any
  effects (`MuxBackendMismatchError`, exit 4) if its workstream has an agent
  registered on another managed backend (tmux, herdr, Rex). The error names
  that backend and suggests switching to it or using a new workstream.
  Reconcile keeps foreign rows; `mu state` shows them as `unknown` and names
  their backend. The guard is advisory: two first spawns can race, and a Rex
  terminal can still drive tmux workers (ladder placement spec §8.2).

- mu resolves local helpers such as tmux, git and ps to absolute paths before
  spawning, so a long PATH no longer costs a spawn attempt per entry on macOS.
  The lookup is cached until PATH changes. Configured executable paths and host
  shell templates are unchanged.
- mu can accept older plugin schema digests explicitly approved for the
  current schema. Incompatible digests name the schema and digest to rebuild
  against. The published schema is unchanged.
- The host-profile race test verifies that neither a template nor a plugin
  profile lets a provider claim the name between the conflict check and insert.
- **herdr refuses remote spawns and reattaches before changing anything.**
  The refusal names what the pane cannot run (managed argv, command gate,
  job view, or lease attach command) and says to use tmux or Rex. Local
  agents that herdr starts natively and pane-free `mu host exec` still work.
- The fast test tier honours `MUZZLE_SLOTS`. On macOS test processes use
  the toolchain Git directly, and plugin and eval fixtures launch fewer
  processes.
- Both test tiers reuse forks for an allowlist of pure unit files. Plugin
  fixtures use in-process pipes for setup-only handshakes, and the typed
  error matrix shares one real child. Integration Git fixtures copy a
  seed repo; eval judgements avoid shells for single Git commands.
- `host check` and close take no `host_channels` row for a `slots: "self"`
  link (the link arbitrates its own connection).
- **A `--worktree` spawn on a static host resolves `--from` locally** (ladder
  placement spec §3.3). `--from` (default `HEAD`) becomes a sha in the
  caller's checkout before any remote call; a ref that names no commit there
  refuses (exit 2, `RemoteBaseRefError`, nothing run). A host repo without
  the sha refuses (exit 5, `RemoteBaseMissingError`) naming host, repo and
  sha, and both fixes: a published commit is fetched on the host
  (`mu host exec <h> -- git -C <repo> fetch <remote> <sha>`), a local-only
  one is pushed to a remote the host can fetch, or the spawn uses a
  published commit. The retry is `--from <sha>`. mu never fetches or pushes
  for a static host. Provider hosts keep their push and its message.
- **A remote spawn's prepared tree has an owner before the view opens.**
  The placeholder row records the tree (host, path, base, repo) as soon as
  the prepare answers, so a mu that dies before the finalize leaves a row
  whose `mu agent close` removes exactly that tree; a deleted placeholder
  writes its `remote_recovery` record. A static plugin job record names its
  tree too. Before, the placeholder named no path and the tree had no record.

### Fixed

- Failed or interrupted test runs clean up their own tmux and Rex servers.
  Test teardown never sweeps the user's tmux sessions or earlier runs' servers.
- **`mu agent spawn --host … --task` with no brief note and no `--send` refuses** (exit 2) instead of
  delivering `Read: mu task notes …`, which a remote worker cannot run (it has no mu DB; spec A, rungs 3/4).
  A task with a brief note still sends it in full. Local spawns are unchanged. The one-line fallback a local spawn pins is marked by its author (`mu (generated brief)`), so a later `--host` retry refuses it too. A fallback pinned before the marker (the exact line built from the task's own id, workstream and title, under the ordinary actor) is refused the same; an authored brief that merely starts alike is still sent.
- **`mu wait` with named refs no longer fires on unrelated owned events.**
  Waiting on a named `--command` gate returns the command's exit status,
  even if an unrelated task has closed. A wait without refs still sees
  owned events.
- `mu host init --ssh --template` now prints `--max-sessions 2`, so a collect
  or a remote task brief write fits beside one live pane. Existing profiles
  and the mule lease starter are unchanged.
- Exec templates start without inherited `CDPATH`, including templates that
  use `{cwd}`. For templates without `{cwd}` (including the SSH and mule
  starters), `mu host exec --cwd` treats the directory as a literal path,
  follows symlinks before resolving `..`, and exits with the `cd` failure
  before running any of the script. Relative repo path handling in
  `mu host check` and remote worktree preparation is unchanged.
- A tmux server restart no longer hands a worker's row to an unrelated pane that
  recycled its pane id (`%1` restarts per server). Spawn records the server
  (`agents.pane_identity`, `<pid>|<start time>`; the pane id is unique within a
  server, so the pane's own pid adds nothing); liveness, `mu wait`, reconcile,
  sends, capture and close treat another server as a dead pane for that row and
  never touch the foreign pane. Rows from before the column (agents spawned
  before the upgrade) stay on the unverified check: mu still captures, sends
  to, attaches, closes and tears them down by pane id. Spawn reports uncertain
  creation when tmux does not return the birth identity: rollback never kills
  or probes the candidate id. Dashboard, spawn and orchestrator attach commands
  target the exact pane, even after its window is renamed or split. Workstream
  teardown leaves a tmux session alone unless an agent pane still belongs to it
  (a legacy row's by id); a session name alone is not enough, including after
  reconcile prunes the last row.
- Guarded tmux pastes and literal keys preserve multiline text, including
  indentation, tabs, and `#` lines. Long literal input stays within tmux's
  command-length limit, and a server change stops delivery before the next
  chunk. Retained panes also keep multiline commands and environment values
  intact.
- tmux 3.8 no longer makes mu mistake live panes for missing ones. Pane,
  window, and Murmur state queries use a separator tmux preserves.
- Remote worktree prepare claims the path with an atomic `mkdir` and records
  its DB in `mu-prepared`. A competing spawn cannot remove the winner’s
  tree. Reclaim refuses with exit 4 if a different DB or an unknown owner
  holds the path, and names the remedy. All DBs sharing the host must run
  the new rule; older versions ignore the marker’s contents. If Git fails
  to add the worktree, prepare releases only its own empty claim so a retry
  can use the same path; a replacement or non-empty directory stays put.
- A late plugin handshake cannot overwrite a newer registration.
- The loopback SSH smoke resolves tools before switching to its private home,
  so mise shims no longer cause false prerequisite failures. Failed mu calls
  print the named step, both output streams, and worker pane logs before cleanup.
  The pane path registers the example plugin under its declared name, `ssh`.
- The loopback lease smoke spawns from a local clone of the fixture repo so
  both sides share the same base commit. It exposes Git and tmux to the remote
  fixture without exposing other harnesses installed beside them.

## [5.2.2] — 2026-11-19

### Changed

- **Dashboard: q and Esc go back one level everywhere; only the Overview
  quits.** A drill closes to its tab (as before), the Attention tab returns
  to the tab `!` opened it from (`!` again does the same), and Tasks, DAG,
  Agents and Log return to the Overview, which quits. Before, `q` quit from
  every tab, so leaving the Attention tab meant quitting. Ctrl-C still quits
  from anywhere. The hint says `q quit` on the Overview and `q back`
  everywhere else, drills included (was `Esc back`).

## [5.2.1] — 2026-11-19

### Changed

- **Dashboard: an Attention tab, a count for the strip, a per-workstream
  card.** The strip listed every attention item on one line, so past two or
  three it was always cut. It now reads `⚠ 5 need you (2 here)  ! list` (or
  `✓ all quiet`; "here" counts what the Overview card lists), and `!` opens a
  new Attention tab: every workstream's items with their workstream, the
  cursor row's fix (what `y` copies) on the filter line, Enter and `/` as on
  the other tabs; there the strip only counts. The Overview's Attention card
  lists the shown workstream's items and the machine-wide ones (`sync`,
  `next unavailable`), like the cards beside it; with trouble only elsewhere
  it says `✓ quiet here (! lists N elsewhere)`.

### Fixed

- **Dashboard: the Next line is the shown workstream's.** The dashboard
  computed Next with no workstream, so it never offered that workstream's
  executor move (`mu next -w <ws>`) and its waits came from every workstream.
  It now uses the shown workstream, the same scope as the tasks and DAG.

## [5.2.0] — 2026-11-16

### Changed

- **A remote worker's local pane names its host.** On tmux, a spawn on a
  host (`--host`, a lease reattach, a plugin host's view) sets the pane
  option `@mu_host` to the host's name. The pane holds only the ssh client,
  so murmur, which owns the pane's row, showed the worker as `here`; a
  murmur that reads the option shows the host instead. Best effort: a
  failed set leaves the pane unlabelled and the spawn unchanged.

- **`mu host list` fits a terminal.** The profile table drops the STOP and
  ATTACH template columns (`mu host show` prints every template) and
  front-truncates the default repo, so a lease profile's row is no longer
  ~250 columns wide. With both kinds present, the provider-host and profile
  tables print under `Provider hosts` / `Profiles` headings. `--json` items
  carry `kind: "profile" | "provider"`; the collection shape is unchanged.
- **`mu host show` prints the harness probe's age** (`probed 3h ago`), not
  its raw timestamp. `--json` keeps `capabilities.probedAt`.

### Fixed

- **`mu host list` reports a provider status it could not read.** An
  `unknown` or `needs-human` status answer was dropped, so the host read as
  its last recorded state (`ready`) with no hint; a throw (an unregistered
  plugin) failed the whole listing. Each now leaves the recorded state, prints
  a `warn <host>: …` line under the table, and sets `status_note` on that
  host's `--json` item.

## [5.1.0] — 2026-11-14

### Added

- **Dashboard: the harness per agent.** With murmur 2.1.0 or later (which
  publishes each agent's harness in `murmur status --json`), the Agents tab's
  model cell starts with the harness (`claude opus-5-5·medium 9%`) and the
  scrollback drill's runtime line names it (`harness: claude`). An older
  murmur reports none, and both read as before.

### Fixed

- **Dashboard: the model column shows whatever murmur reports.** It asked
  murmur only when a live agent's harness looked wired to it, and the pi check
  looked for the `extensions/murmur.ts` shim murmur 2 no longer writes (it
  installs as a pi package). So every pi agent showed `?`. The dashboard now
  asks murmur whenever a live agent exists and shows every row it gets.
- **The `murmur link pi` shim check is gone.** pi counts as wired to murmur
  whenever murmur is on PATH. A pi agent murmur has no row for reads `murmur
  has no row`, not `murmur pi extension not linked`, and `mu doctor` no longer
  warns "run murmur link pi" (a command murmur 2 does not have).

## [5.0.1] — 2026-11-13

### Added

- **Dashboard: model, effort and context per agent.** The Agents tab ends in
  a model column, `opus-5-5·high 9%` (`?` when murmur has no row for the
  agent, `-` when it reports none; the Overview's Agents card leaves it out),
  and the text filter matches it. The scrollback drill pins the full runtime
  line under its notices: provider and model, requested effort (and the
  applied one when the provider says otherwise), context tokens/window and
  percent, session cost. Read from `murmur status --json` on the slow tick
  only, through the cache the state read already shares (one call per 10 s at
  most, none while no live agent's harness is wired to murmur); a failed read
  keeps the last one. A local agent matches its own pane, a remote one its
  peer's row; stale rows are ignored. The murmur cache is now stamped when the
  answer comes, so a timed-out call is not repeated at once by the next reader.

### Changed

- Docs: a how-to for plugins, `docs/guide/plugins.md` (register, link host,
  provider host, unknown outcomes, where to start writing one), linked from
  the guide index and `remote.md`. `mu plugin --help` names every seam and
  everything `mu plugin rm` refuses over.
- An example plugin, `examples/plugins/mu-plugin-ssh` (shipped in the
  package): a host link over plain ssh, in about 200 lines. The link contract
  suites run against it with a stand-in `ssh`.
- The U0 spike kit (`spike/u0/`) is removed; its results stay in the
  every-harness spec.
- Docs: the changelog is split, one file per major. This file holds mu 5;
  mu 1 to 4 live in `docs/history/CHANGELOG-<major>.md` (0.x with 1).
  Pure history is removed: the 4.0 development changelog, the mu-next design
  records (design of record, rule destinations, release reviews, spike), the
  4.0 eval and dogfood reports, the kernel test-health report and the
  roadmap's "Shipped in 4.0" section. All stay in git history. The TUI
  dogfood kit, still used by `tools/screenshot/dashboard.sh`, moves to
  `tools/tui-dogfood/`.

## [5.0.0] — 2026-11-11

mu gets plugins: a registered executable (`mu plugin add`) can supply a
remote or elastic backend's hosts, links, jobs and channels over a versioned
JSON-RPC protocol on stdio (`docs/reference/plugin-protocol.md`), with mu
owning every state machine, a write-ahead effects journal and
reconcile-by-asking (spec `docs/specs/2026-11-09-mu-plugins.md`). Provider
hosts are acquired, drained and released (`mu host acquire|drain|release`).
**Breaking:** schema 14 and a new state directory, `~/.local/state/mu5`.
The first mu 5 verb imports mu 4's DB once (it refuses while agents, lease
reservations or delegate calls are live, and never writes `mu-next`); mu 4
builds refuse the new DB. With no plugin registered, everyday verbs behave as
in 4.6.0.

### Added

- **Plugins: an at-start first turn under `--task`, and its recovery**
  (plugins spec P6e2: D8 G1, G1a, G1b). `mu agent spawn --task` on a host
  whose plugin job kind declares `firstTurn: "at-start"` folds the brief into
  `job.start`: the placeholder row comes first (stamped with the row's cwd,
  command and channel), claims the task and journals `sending`; the start is
  the write, carrying the receipt's msgId, and its reply's baseline (`runs:
  0`) sends the receipt. A start that provably did nothing is unsent (claim
  released, everything rolled back); one whose outcome is unknown keeps the
  placeholder, the claim and the job record, never resends, and says so
  (`EffectOutcomeUnknownError`, exit 1, naming the msgId and the effect key;
  a taskless `--send` spawn the same). A replay of the attempt, or `mu agent
  check <agent> <msgId>` on the job record's `first_msg_id`, resolves the
  start by its rule-table row: a found start records its handle and
  `first_inc`, opens the view from the start's reply (else `job.attach`) and
  answers `accepted runs=0`; an unresolved one answers `unreachable` naming
  the key; a proven `none` fails the attempt and rolls it back (the check
  then asks the channel's receipt, as for any msgId). Review fixes: the
  receipt is monotone per attempt (`pane` → `sending` → `sent`, never back:
  a view finalized later only repoints its pane); the start's answer sends it
  at once, so a later view failure records the attempt sent-then-stopped (its
  job stopped by handle), never failed, and a replay of that attempt starts
  nothing (`SpawnAttemptEndedError` names the next key); a lookup recovery,
  `mu agent check`'s included, repoints the receipt to the view it opened, and
  a receipt naming its placeholder's pane still knows its incarnation, so a
  replay after a SIGKILL anywhere in it reports `sent` with no second delivery.
  Second review: one module owns the receipt state machine
  (`src/agents/receipts.ts`: `RECEIPT_EVENTS`, an explicit table of events,
  from-states, to-states and actors, and `transitionReceipt`, which checks it
  and compares-and-sets from the state it read; `ReceiptTransitionError`, exit
  4); spawn, replay, `mu agent check` and lookup recovery all go through it.
  Owner-only resolution: while the process that created an at-start job
  (`carrier_jobs.creator_pid`/`creator_start`) lives, a check or replay in
  another process only reads, never resolving the start or moving the
  receipt; a start with no answer stays kept even if resolved meanwhile.
  `delivered` applies only to an at-start start that carried the prompt (an
  on-send kind's start baseline is readiness, never a delivery). A lookup
  recovery repoints the receipt only once its view opened; a failed view puts
  the row back to its placeholder, so the next replay or check opens it.
- **Plugins: provider-host facts in mu's reads** (plugins spec P6e2: D10,
  D16). `mu wait` caps its sleep at the earliest `deadline_at −
  MU_HOST_DEADLINE_MARGIN_MS` of the provider hosts its watched agents run on
  (a timer inside the one invocation, like `--timeout`) and fires a new
  urgent wait event, `deadline` (exit 7, nothing consumed), naming the agent;
  a ready completion is still returned first. After a `mu wait` fires an
  agent's settle, or its `deadline`, mu runs one in-life collect of that
  agent's provider-host tree into its `collect_repo` (`collectAtSettles`):
  a failure is a stderr warning and backs off (`collect_next_at`), and it
  never clears `final_owed`. `mu state` and `mu wait` notices name each job
  record owing its final collect once its job is stopped or its agent gone
  (`mu agent collect …`), and each agent on a host inside its deadline margin
  (`mu agent collect …; mu agent close …`). `test/plugin-e2e.integration.test.ts`
  runs the spec's walkthrough against the fake plugin: register, acquire,
  `--worktree --task` with push and the brief in `job.start`, wait for the
  first turn, its in-life collect, send, wait, the deadline event and
  notices, close with the final collect, release. `docs/reference/plugin-protocol.md`
  covers the at-start `--task` spawn, its recovery and the host facts.
  Review fixes: an in-life collect takes its own path
  (`collectInLifeLocked`), which never touches `final_owed`, and reads and
  writes its backoff under the agent lock with the fetch, so concurrent waits
  lose no update; the `deadline` event fires once per host per deadline (the
  claiming wait records it, `hosts.deadline_fired`; a new deadline fires
  again); inside the margin a successful in-life collect backs off too; `mu
  wait` prints its result and saves its resume before it collects.
- **Plugins: the channel adapter, the plugin spawn path and detached views**
  (plugins spec P6e1: D3, D8, D9, D13). A plugin's `channel` seam is a
  registered channel (`src/plugins/channel.ts`), loaded from the plugins table
  under its name; its readings' source is `plugin:<plugin>`. Reads
  (`channel.readStates`, `baseline`, `receipt`, `lastRun`) go through the one
  call path; `channel.watch` streams: its reply, then one `watch/settled` or
  `watch/restarted` notification, `$/cancel {watchId}` on abort. Every
  delivery (`send`, `fresh`, `command`, `interrupt`, `abort`, `answer`) is an
  effect, written ahead with the agent's next `delivery_seq`; a capability
  that is `none` refuses with the built-ins' typed error before anything is
  written, and a job on a `lost` host takes no delivery. A plugin channel
  never decides liveness: every reading, watch and last run is composed with
  the job's `job.status`, unconditionally (an ended or lost job reads dead
  whatever turn state the plugin reports; `unknown` is never a death), and an
  open watch asks it while it waits. Spawn on a provider host or a `--plugin`
  profile whose plugin declares a job seam (`src/agents/spawn-plugin.ts`):
  honour or refuse, then the job record (a provider host's atomic admission),
  the site (a `--worktree` pushed and made from the caller's commit), the
  `job.start` effect with the whole `JobSpec`, then a read-only view (stdin
  `/dev/null`) and the row on the kind's channel; readiness is the channel's
  `baseline` within `MU_SPAWN_JOB_MS`, and a failure after the start stops the
  job by its handle. An `at-start` kind's `--send` text goes only with
  `job.start` (its msgId as `first_msg_id`, the opening incarnation as
  `first_inc`), never as a send; such a spawn without a prompt refuses
  (`JobSpecUnsupportedError`, exit 2). Detached views: reconcile keeps a row
  whose view is gone while its job runs, `agent close` stops the job before it
  kills the view, and `agent reattach` opens a new view by `job.attach` and
  compares-and-sets the row's pane, keeping its incarnation. A live agent's
  close on a provider host runs its final collect from the row before the
  tree. A row whose channel no built-in or registered plugin provides is
  `ChannelUnknownError` (exit 4) for a verb and reads `unknown`. The protocol
  schema gains the channel replies (one digest change). Review fixes: a
  plugin channel is resolved per DB handle and registration, never by a
  process-wide name; a view whose backend fails after it reported its pane
  fails the spawn (its job stopped) or the reattach (the row keeps its pane);
  reattach refuses on a backend that cannot run a view, and a view is never
  labelled the harness's own command; composition is by the requested target
  (a missing reading, a foreign observation or a stale gone verdict never
  decides liveness); an at-start start's reply must open at `runs: 0`, and
  later sends carry `firstPrompt: false`; a plugin's send ack is kept
  (`SendResult.channelAck`). A plugin channel's identity is (plugin, name):
  the agent row records both (`agents.channel_plugin`, an added column),
  `mu plugin add` refuses a channel name another plugin holds in the DB
  (`PluginRefusedError`, exit 4), and every plugin-channel lookup, a
  capability lookup by name included, is scoped by its DB; every such read
  loads the DB's registrations first, replacing its set (a removed plugin's
  channel goes). Not yet driven (P6e2): `--task` on an `at-start` kind, `mu agent check` on a first
  prompt, spawn replay by lookup, in-life collects at observed settles, the
  wait's deadline timer and `mu state`'s notices.
- **Plugins: provider hosts** (plugins spec P6d, D1, D5, D6, D7 G3, D10).
  `mu host acquire <name> --provider <plugin> [--param k=v]… [--repo
  <path>]` writes a `hosts` record and its `host.acquire` effect in one
  immediate transaction; a re-run on a name still `acquiring` resolves the
  same effect (lookup or deduped resend), never acquiring a second host. A
  name is a profile's or a provider host's, never both. `mu host drain`
  stops spawns; `mu host release` proves no agent, job record or recovery
  record names the host (listing every owed final collect;
  `HostReferencedError`, exit 4) and reissues a crashed release; `--abandon`
  drops the host with its job records, recovery records and dead effects in
  one transaction, logging each (refused while an agent row names it or an
  effect has a live owner). `mu host list` asks each provider host its
  status once: `gone` moves it to `lost`. The provider adapter
  (`src/plugins/provider.ts`) is the plugin's host seam as a `HostProvider`;
  `resolveHost` builds a provider host's view from its provider's link and
  job kind, and a provider host's link calls carry its handle and instance.
  Atomic admission (`reserveProviderJob`, for P6e's spawn path) refuses
  unless `ready`, inside `MU_HOST_DEADLINE_MARGIN_MS` (default 10 min; the
  host drains, `HostDeadlineError`) or at `max_jobs` (`HostJobsFullError`).
  The link adapter calls `link.push` when declared, and a provider host's
  `--worktree` base resolves in the caller's checkout: pushed, or refused
  with `RemoteBaseMissingError` (exit 5) naming the commit and the repo.
  The host policies (`src/host-policy.ts`): the final-collect flag is set
  for a `--worktree` job on a provider host and cleared only by a collect
  that read the stop generation before its fetch (`stop_gen`
  compare-and-clear); in-life collects back off from the poll interval to
  5 minutes; `deadlineNotice`. A close with no agent row of a plugin job
  record goes through its kind: on a `lost` host the tree is recorded gone
  and the job stopped without a call, unless the kind `outlivesHost` (then
  `job.stop` with proof); an owed final collect there is kept as
  "uncollected work" until `--abandon-job`. On a live host the close runs
  the final collect from the record's `collect_repo` before the tree.
  New log intents `host.acquire` and `host.release` (machine-local entity
  `host`). Not yet driven: spawn on a provider host, its live-agent close,
  in-life collects at observed settles and the wait's deadline timer (P6e).
  Review fixes: every link call goes through the one call path, so a
  provider host's link refuses a replacement plugin instance before sending;
  job and link calls on a provider host carry its handle and instance;
  `--abandon`'s loss event commits with the deletions; a lost host's job
  drops its unresolved effects as lost in the same transaction (`mu plugin
  rm` then succeeds) and never reissues its start; recovery records name a
  provider host by identity, and acquire refuses a name one still names
  (`HostNameRecoveryError`, exit 4); a profile's name check and insert are
  one transaction; a collect whose fetch fails on a reclaimed host reports
  it lost.
  Follow-ups from the first live provider run (task `p6d_gaps`): an acquire
  that a re-run resolves by lookup logs its `host acquire` entry with the
  handle. A `host.status` that answers `up` keeps a fact it omits and
  clears one it sends as `null`, so a provider need not repeat every fact.
  A provider plugin may declare `host` with `link` alone: its hosts run no
  jobs (no job kind in their view), and a spawn on one is refused up front
  instead of failing at a placeholder `job.start`.
  `mu host check <provider host>` runs: it resolves the host through
  `resolveHost` and checks it through its provider's link (its record's
  repo is the default `--root`), where it refused with "no host profile".
- **Plugins: effects, the reconciler and the job adapter** (plugins spec
  P6c, D4, D8). Every plugin effect is written ahead in a new `effects`
  row (key, the exact params and their sha256, the plugin instance, the
  creator and the plugin's process group), in one immediate transaction
  with its subject's change, and deleted with the definite result. A live
  creator owns its row: another verb's claim refuses, naming its pid
  (`EffectHeldError`, exit 4). Resolution follows the D4 rule table, fenced
  on the instance (a changed one refuses, `EffectFencedError`, exit 4):
  `job.stop` and `host.release` reissued; `job.start` and `host.acquire` by
  `lookup` (a file-handle kind's `found` may be the handle alone; a reply
  kind's must carry its view; `none` counts only once the creator and the plugin group
  are proven gone and the lookup was fenced or `inFlightMs` passed) or a
  byte-identical deduped resend inside its window (every send and retry
  carries the committed params, never the caller's object); deliveries by an exact
  receipt or a deduped resend, never once a newer delivery to the agent was
  written (`agents.delivery_seq`; a new delivery refuses while another is
  being resolved). The job adapter (`src/plugins/job.ts`) makes a plugin's
  job seam a bound `JobKind`: journaled `job.start` and `job.stop`, and
  `job.lookup`, `job.status`, `job.attach`, `job.checkSteps` reads that
  answer `unknown` for cannot-tell. One call path serves the adapter and
  the reconciler: each method's reply is checked against its request (a
  reply kind's handle and view, a receipt's echoed msgId, the asked
  agent's reading), failing replies are unknown, and every call naming a
  recorded job, host or effect is fenced on its instance. On the wire: the job caps `firstTurn`,
  `outlivesHost` and `honours`, the link cap `push` with `link.push`'s
  params (a plugin that declares it now loads; the adapter calls it from
  P6d), the job methods' params and results (one schema digest change,
  `link-contract` checks `push`), and two load rules
  (`at-start` needs `handle: "reply"`; `honours.env: false` needs a
  `channel`). Honour or refuse: a `--host` spawn requesting a role, a
  `--command` or ctl sockets its kind does not honour refuses before any
  effect (`JobSpecUnsupportedError`, exit 2); built-ins honour all. `mu
  plugin rm` also refuses while a job record or an effect names the
  plugin. Spawning on a plugin kind still waits for P6e. Tests:
  `job-contract` (pane, lease, gate and the fake plugin's kind),
  `plugin-faults` (F1-F10, F12), `effects`, `plugin-job-wire`.
- **Plugins: the protocol core and the link adapter** (plugins spec P6b,
  D13, D14). `mu plugin add <name> -- <absolute path> [args…]` registers an
  executable named `mu-plugin-<name>` (owned by you, writable by no one
  else; never discovered), runs its handshake once and stores a `plugins`
  row (machine-local); `mu plugin list` and `mu plugin rm` (refused while a
  host profile names it). mu speaks versioned JSON-RPC 2.0 over the
  plugin's stdio: one line per message up to 1 MiB, a handshake with the
  protocol range, `instance`, schema digest and seams, the load rules
  (exit 4, `PluginRefusedError`), typed errors (`retryable` retried three
  times with the same params, `permanent` and `human` exit 5,
  `unknown-outcome` exit 1 as `EffectOutcomeUnknownError`), deadlines and
  `$/cancel` (then the grace, then the group killed), and one plugin
  process per invocation, in its own group, shut down at exit. The plugin
  gets mu's environment without its local-only variables. `mu host add
  <h> --plugin <name> --fetch <t>` makes a plugin the host's link (no
  `--shell` or `--exec`; identity `plugin:<name>:<instance>`); spawning
  there waits for the plugin job kind. The schema ships as
  `schemas/plugin-protocol-v1.json`, the prose as
  `docs/reference/plugin-protocol.md`. With no plugin registered nothing
  changes. Tests: `link-contract` (the template link and the fake plugin's,
  one suite), `plugin-schema`, `plugin-skew`, `plugin-load`,
  `plugin-process`, `plugin-cli`; the fake plugin is `test/_fake-plugin.mjs`.
  After review (task `p6b_fix`): a SIGINT, SIGTERM or SIGHUP stops each
  plugin with `$/cancel` and `shutdown` and one grace before the group kill,
  then re-raises the signal when no verb handles it; the group, not the
  leader, is tracked until empty; every call is bounded by its deadline plus
  one grace (the link no longer adds its own); the trust rules are
  re-checked each time a plugin starts; a line that is not UTF-8 is an
  invalid message; a check's `human` answer is the `handback` step `host
  check` skips on; the fake plugin keeps its runs in its group, and the
  contract test reports a plugin whose runs leave it
  (`plugin-containment`, `plugin-signal.integration`).
  After the second review (task `p6b_fix2`): each plugin process has one
  lifecycle (`starting`, tracked from spawn's return; `ready`; `stopping`;
  `gone`) and one stop sequence that owns every request's timer and abort;
  the first terminating signal sets a latch after which no plugin starts or
  restarts and no request is sent; a reply during the stop never cuts the
  grace short (`plugin-lifecycle`: every phase by every plugin behaviour).
  After the third review (task `p6b_fix3`): a call aborted before it is
  written is a not-sent `PluginCallError` (exit 5), never an unknown
  outcome, and leaves the plugin running; the lifecycle table's bound is
  measured and tight (a stop that holds the grace ends within 1.5 graces,
  any other within one), so one grace too many fails every cell.
  Follow-ups from the first live plugin run (task `p6b_gaps`): mu's timer on
  a `link.exec` or `link.fetch` is the plugin's `timeoutMs` plus one grace,
  so a plugin that answers a timeout at its deadline is not killed for it.
  A link may declare `remoteOnTimeout: "stopping"` (its remote run stops
  within one grace after a timed-out reply): mu waits that grace out before
  it returns the run, and counts the link as `stopped`.
  `mu host add <h> --plugin <p>` takes no `--fetch` when the plugin's link
  declares `fetch: true` (it is required otherwise, as for a template host).
  A plugin check step may answer `ok: "warn"`: it passes, and `mu host
  check` prints it as a `warn` line (`--json`: `ok: true, warn: true`).

### Changed

- **The models recipe covers more labs, effort and speed.** Tier rows are
  per lab (anthropic, openai, google, meta), plus grok, composer, kimi,
  deepseek, glm, mistral and qwen as one family each. Effort is picked per
  role, medium by default: high and above can multiply run time. When
  someone waits, the fastest good-enough model wins. herdr takes no model:
  `mu_delegate` is refused and spawn ignores it. The recipe index,
  orchestrator loop, tasks-or-calls, findings and the delegate and
  other-CLI guides link it where a model is picked.
- **The `mu_delegate` `model` description no longer shows `:high`**, which
  callers copied into every call. It builds the id from a
  `pi --list-models` row plus an optional `:<effort>`, defaults to medium,
  and gives checks the author's tier or higher, another family, high effort.
- **Schema (v14, no bump): `hosts.deadline_fired`** (plugins spec D10,
  review of P6e2): the `deadline_at` a wait's `deadline` event fired for, an
  added nullable column.
- **Schema (v14, no bump): `spawn_receipts.transport` has no CHECK**
  (plugins spec D5, P6e2). A receipt's transport may name a plugin channel;
  a file whose table still has the CHECK (before `hooks`, or before plugin
  channels) is rebuilt by its column list in the upgrade's one transaction.
- **Schema (v14, no bump): `hosts` and `remote_recovery.host_identity`**
  (plugins spec D5, P6d). A new machine-local, unrebuildable `hosts` table
  (32 tables). `remote_recovery` gains `host_identity` (a profile's exec
  bytes, `plugin:<name>:<instance>`, or `provider:<id>:<instance>`), written
  by the recovery triggers; an older file's triggers are replaced (same
  names) and its records backfilled from `host_exec`. A recovery's use
  compares the host's identity now with it, so a provider host acquired
  again under the name refuses. `carrier_jobs` gains `collect_delay_ms`
  (the in-life collect's backoff).
- **Schema: `effects`, `agents.delivery_seq` and the job record columns**
  (plugins spec D5, P6c). A new machine-local, unrebuildable `effects`
  table; `agents` gains `delivery_seq`; `carrier_jobs` gains `kind`,
  `plugin`, `instance`, `host_id`, `tree_base`, `collect_repo`,
  `final_owed`, `stop_gen`, `collect_next_at`, `first_msg_id` and
  `first_inc`, and its `host_stop` becomes nullable (a plugin job's fence is
  its instance). An existing file is completed in place, its carrier_jobs
  rebuilt with rows and name index kept. `CAPTURE_VERSION` is unchanged.
- **Schema: `plugins` and `host_profiles.plugin`** (plugins spec D5, P6b).
  A new machine-local, unrebuildable `plugins` table. `host_profiles` gains
  `plugin`, and its `shell` and `exec` become nullable (still required
  without `plugin`, checked in `addHost`); an existing file's table is
  rebuilt in place with its rows and recovery triggers. A template profile
  reads and prints as before (no `plugin` key).
- **mu 5: schema 14 and a new state directory, `mu5`, with a one-shot
  import of mu 4's DB** (spec `docs/specs/2026-11-09-mu-plugins.md` D5, unit
  P6a; AGENTS.md "State directories"). Breaking: the version is 5.0.0,
  `CURRENT_SCHEMA_VERSION` is 14, and every released mu 4 build refuses a v14
  DB (`SchemaTooNewError`, exit 4; pinned against the real v4.5.0 source by
  `test/state-import-released.integration.test.ts`). mu 5 never opens a v13
  file in place (`SchemaTooOldError`, exit 4, the file untouched). The state
  dir default is `$XDG_STATE_HOME/mu5` (`~/.local/state/mu5`); `MU_STATE_DIR`
  still wins. The first mu verb (or Stop hook) with neither `MU_STATE_DIR`
  nor `MU_DB_PATH` set, when `mu5/mu.db` is missing and
  `~/.local/state/mu-next/mu.db` exists, runs the **state import**
  (`src/state-import.ts`): under the strict lock `mu5/locks/import` it
  copies mu 4's DB with SQLite's backup API to `mu5/mu.db.importing`, gives
  the copy a new `machine_id` (mu 4 and mu 5 are then two sync peers), runs
  the v13 completion, then in one transaction checks the snapshot and takes
  the 13 → 14 step, and commits by a no-replace `link(2)`. It refuses, and
  deletes the copy, while ops of mu 4's machine are not yet in its segment
  in `MU_SYNC_DIR` (run `mu sync` with mu 4 first) or while the snapshot
  holds an agent row, a lease reservation or an unfinished delegate call
  (close them with mu 4 first). `mu-next` is never written: the source is
  opened read-only. A crash leaves only `mu5/mu.db.importing`, which the
  next run deletes and redoes. While the import is due, `openDb` refuses
  mu 5's default DB (`StateImportPendingError`, exit 4) so the SDK never
  creates an empty one. The 13 → 14 step is the stamp today; the later
  plugin units add their table rebuilds to it. Not moved: the anchor dir
  murmur reads (`~/.local/state/mu-next/anchors`) and the remote hosts'
  `$HOME/.local/state/mu-next/remote-worktrees` and `remote-gates`.
  `countUnpublishedOps` takes an optional machine id. Green gate: fast, plus
  `db`, `entities`, `loop-storage`, `rebuild`, `state-import` and the
  released integration test.
- **Job liveness behind `src/jobs/`** (plugins spec P1, D1 and D8). Every
  "is this agent alive" probe outside `src/mux/` now goes through the new
  `src/jobs/` cluster: `viewPresent` (does the pane exist: the close row
  rule, teardown, the spawn and rollback proofs), `viewState` (did its
  command run, exit or go: gates), `viewRunning` (does it still run:
  host-channel admission, ctl's and hooks' `paneUp`, the lease carrier), and
  `jobLiveness(db, job)`, answered by the job kind (`pane`, `lease`, `gate`).
  Batched presence goes there too: `sessionViews` (teardown, workstream
  liveness) and `readTmuxViews` (the mux channel's one `list-panes -a`, where
  an unlisted pane reads gone); only reconcile keeps its own `listPanes`.
  herdr's and Rex's own pane state (`viewStatus`: a reported state is a
  present pane) and the pane's first pid (`viewPid`) are job reads too.
  The lease job kind owns the job handshake (`awaitLeaseJob`, moved from
  `src/agents/lease-carrier.ts`, which still exports it), the stop (`runStop`
  on the recorded `host_stop`) and the reattach's attach command.
  `localPaneAlive` is gone (`viewRunning`). Each site keeps the exact probe it
  made before, so no answer changes; `test/jobs-imports.test.ts` fails on a
  new pane probe outside the cluster in any form (a `MuxBackend` pane read, a
  raw tmux, herdr or Rex call, a tmux pane query or `#{pane_*}` format). No
  behaviour change.
- **Remote templates run through the link** (plugins spec P2, D2 and D7).
  The new `src/host-link.ts` holds the `HostLink` seam (`exec`, optional
  `fetch`, `fits`, `fingerprint`, phased `checkSteps` types), a minimal
  `HostView` (name, profile, link) and the built-in `templateLink`: today's
  `exec` and `fetch` templates through `runLeasedTemplate`, with `admitted`
  run on the admitted profile before any command (the recovery profile pin,
  the brief's size guard). collect, the remote brief file, the gate result
  read and clean, and the hooks node read call the link; the worktree
  scripts moved from `src/remote-agent.ts` to `src/remote-worktree.ts` with
  their exec counts and channels kept (prepare one exec under the spawn's
  channel, rollback one, close two under one channel, its profile guard
  first). Only the link, the lease kind's `runStop` and `checkHost` run the
  template runner (`test/link-imports.test.ts`, import-aware). The SDK type
  `Transport` is renamed `SendChannel`; `src/remote-agent.ts` still exports
  the worktree names. No behaviour change.
- **Host lookups go through `resolveHost`** (plugins spec P3, D6). The new
  `src/host-provider.ts` holds the `HostProvider` seam (`acquire`, `lookup`,
  `status`, `release`, each keyed, with `Call`, `KeyCaps`, `HostFacts` and
  `HostStatus`), the complete `HostView` (name, link, provider, job kind,
  profile or host record; it moved from `src/host-link.ts`, whose `hostView`
  is gone) and the built-in `staticProvider`: `status` answers `up` with no
  round trip, and `acquire`, `lookup` and `release` refuse
  (`StaticHostError`, exit 2), since static hosts are added and removed with
  `mu host add`/`rm`. `resolveHost` views a profile: the template link,
  `static`, and the lease job kind for a lease profile, else the pane kind.
  Spawn's host check, close's lease test, the stop fence, the lease reattach
  check, collect, the gate reads, the remote brief and the hooks node read
  resolve through it; `findHost` answers undefined for an unknown name, and
  `hostIdentity` reads the identity a recovery pins (the exec bytes, the
  link's fingerprint) with today's one-column query. Outside the profile verbs, a `getHost` or `listHosts`
  import or a `host_profiles` read fails `test/host-imports.test.ts`
  (import-aware; the recovery capture triggers keep their SQL read). The SDK
  exports the new names. No behaviour change.
- **`host check` is composed from phased check steps** (plugins spec P5,
  D11). `checkHost` calls each phase on the admitted view: `template` (the
  lease kind: `shell`, `stop`, `attach`), `reach` (the template link:
  `reachable`, `repo`; its first step is reachability), mu's own
  `harnesses`, `hooks`, `pi` and `extension` through the link's `exec`,
  `agent` (the lease kind: `job`), then mu's `ctl`. A seam contributes to a
  phase it names in `caps.checks` (`LinkCaps`, `JobCaps`) through
  `checkSteps`; `checkRunner` (src/hosts.ts) is the shared one-command step
  with the hand-back skip. `HostCheckStep.step` is a string (a plugin's are
  `<plugin>:<step>`). The output is byte-identical, skips included: 29
  golden fixtures captured before the change
  (`test/host-check-golden.integration.test.ts`). No behaviour change.
- **The channel registry and channel capabilities** (plugins spec P4, D9 and
  D12). Each built-in channel (`ctl`, `hooks`, `mux`) declares `caps`
  (`ChannelCaps`: fence, receipt, dedupe, steer, interrupt, fresh, answer,
  command, watch, settleText), held to the D9 matrix; `fence` stays as its
  alias. `agentChannel` resolves the row's channel in the new registry
  (`src/channels/registry.ts`: `registerChannel`, `channelNamed`), and
  `ChannelName` is open (a registry name; the stored values and
  `spawn_receipts`' CHECK stay the three built-ins, and an unknown stored name
  still reads null). Callers that held only a name now branch on the
  channel's capabilities: a spawn replay and `mu next`'s unreconcilable check
  on `receipt` (`exact` asks by msgId, `acknowledged` reads a turn past the
  baseline, `none` stays unknown), `mu agent spawn --task`'s `agent check`
  hint on `exact`, the note hint on `steer`, and the wait's stall timing and
  rewatch on the reading's channel streaming. The run a delivery started is the channel's word (`sendRun`):
  `armSend`, `send --wait`, `mu next`'s sent outcome and the task spawn's
  receipt read it instead of recomputing it by name, and each channel writes
  its own `sent … (via …)` line. A delivery's reply has a normalized form,
  `ChannelSendReply` (`channel`, `ack`: `exact`, `acknowledged` or `none`,
  `baseline`), the contract a plugin channel answers in: each built-in's
  `sendRun` reads its result as one, `sentRun` takes either form, and
  `toSendResult` turns a reply into today's `SendResult`, so `--json` is
  unchanged. The run-baseline rename: `hooksFence` is
  `hooksRunBaseline`, `sentFence` is `sentRunBaseline`. `ChannelTarget.job`
  carries the row's job (`agentJobRef`: pane, lease or gate). Liveness is the
  job's by construction, at the seam: a channel implements `ChannelImpl`,
  whose own read (`readTurns`) returns `ChannelReading`s, turn state and link
  with `alive` typed `never`, and whose watch reports a dead agent only as the
  job's verdict (`JobGone`, minted by `jobUp`). The registry serves it
  composed (`composeChannel`, `src/channels/compose.ts`, frozen), and
  `composedStates`, behind both `readAgentStates` and each channel's
  `readStates`, sets `alive` only through `withJobLiveness`. An answer stands
  in for it only where the job's kind says an answer from its process proves
  it runs (`answerProvesRunning`: pane and lease), else the job's view
  decides; a socket that does not answer still takes the batched view read's.
  Agents are grouped by their channel's own read (hooks and mux share the one
  base read, as before). `test/channel-names.test.ts` parses `src/` and fails on a channel
  name comparison outside `src/channels/` that is neither a capability check
  nor on its pinned list of single-channel features (also through an alias or
  a constant holding a name), and on any `alive` set in a channel or ctl
  module; `test/jobs-imports.test.ts` is now import-aware too (a destructured
  probe method, by computed key too, or a probe imported named, aliased or as
  a namespace from a backend module). `test/channel-ctl-differential.test.ts`
  pins 72 ctl readings with their probes, and CLOSE eligibility, to their
  output before P4. No behaviour change; `--json` result shapes are
  unchanged.

### Fixed

- **Plugins: no unresolved effect is left without a way out** (final
  refutation of the plugins run). A plugin-channel delivery whose outcome
  is unknown is resolved by the rule table when `mu agent check <agent>
  <msgId>` or a task spawn's replay asks about it (an exact receipt
  settles it; a receipt that does not accept leaves it unknown), and goes
  with its agent's row (a close, the reaper), an event naming each lost
  key in the same transaction. Before, its row stayed for good and
  `mu plugin rm` refused forever. Reattaching a detached view moves the
  spawn receipts with the row's pane (refused while the spawn that made
  it still runs), so a replay no longer calls the same agent "replaced"
  and `mu next` keeps watching it. An at-start `job.start` carrying the
  first prompt takes the agent's delivery seq 1: a newer delivery bars its
  deduped resend, and a new delivery refuses while it is being resolved
  (spec D4, K8).
- **Eval: the rig's deny lists cover mu 5's state dir** (task `eval_rig_mu5`).
  The private stores shared by the AUT path rules and the designer deny list
  (`tools/eval/rig-private.ts`), the designer audit's strict terms and a live
  run's real-state watch (`tools/eval/isolation.ts`) named only
  `~/.local/state/mu-next`, so an AUT or designer could read mu 5's real DB,
  worktrees and eval rows under `~/.local/state/mu5` unflagged. Both names are
  listed now (`MU_STATE_DIR_NAMES`, mirroring `src/state-dir.ts`: the rig
  imports nothing from `src/`), and a live run's default DB is mu 5's.
  The judges' hash changes: a frozen tournament group refuses until
  `tournament refreeze`.
