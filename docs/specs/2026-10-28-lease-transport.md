# Lease transport: a remote worker whose pane holds no ssh session

Status: proposed, revised after review (see [Review](#review-2026-10-28))
Date: 2026-10-28
Pairs with: [mule/docs/specs/2026-10-28-mu-lease.md](../../../mule/docs/specs/2026-10-28-mu-lease.md)

## Problem

A remote worker's local pane runs the profile's `shell` template: a held
`ssh -t … -L {local_sock}:{remote_sock}`. The pane is mu's single source of
truth, because pane death is agent death, so reconcile, close and the
dashboard need no remote case. On a session-capped host (`MaxSessions 1`,
the Meta devvm) that design breaks in three ways, all measured on 2026-10-28:

1. **The worker takes the host's only session channel for its whole life.**
   While `devtest` ran, every other `ssh dev` (murmur's collector, `git
   fetch`, an operator) failed with `Session open refused by peer`, which
   then showed as the misleading `Permission denied (keyboard-interactive)`.
   mule exists to remove exactly this hold.
2. **The workaround, riding an existing master, leaks forwards.** A `-L`
   requested through a control master is bound by the master, not by the
   client, and it outlives the pane. mu's `unlinkCtlSocket` deletes the
   file while the master keeps the listener. The next spawn of that name
   requests the same forward, ssh exits 0, and no file appears: `ctl:
   missing`, permanent for that name. The comment in `hostStarter` ("a
   multiplexed ssh never binds the local end") is wrong: it binds it in the
   wrong process.
3. **A template-only mule workaround is unsafe.** If the pane runs `mule run
   --tui` and a forward, it becomes a viewer: killing it does not stop pi,
   `agent close` runs the worktree rule while pi still writes in the tree,
   and a reaped row leaves a pi running with nothing pointing at it.

## Approach

Keep the invariant that **pane death is agent death**, and change what the pane is:

| | `session` (today) | `lease` (new) |
| --- | --- | --- |
| The pane runs | `ssh -t host pi` | a local **carrier** (e.g. `mule run --lease`) owning a detached remote job |
| ssh session held for the agent's life | yes | no: the carrier does sub-second polls on its own connection |
| The ctl forward is bound by | the pane's ssh | the carrier, on its master, verified |
| Pane dies | remote pi gets SIGHUP | carrier stops the job, best effort |
| Carrier dies without stopping it (SIGKILL) | n/a | the **job handle** mu recorded stops it |

mu stays ssh-free and mule-agnostic. It learns two things from the
profile: a **job file** the carrier writes the handle to, and a **stop
template** that ends a job given its handle. Every remote effect is still
the user's template run with `/bin/sh -c`.

Pane death still tracks agent death, because the carrier exits when the job
ends. What pane death no longer proves is *job* death, so every path that
touches the worktree after a lease pane dies runs `stop` first. The handle
lives in its own machine-local table and is deleted only by a successful
`stop`, so no deletion path can lose it.

## Behaviour

### Host profile

- `--transport session|lease`, default `session`. Existing profiles are
  unchanged.
- `--stop <template>`: required for `lease` and refused for `session`.
  Placeholders: `{job}` (required) and `{cwd}` (always `.`); `{env}` is
  refused. The template must be **idempotent**: it exits 0 for a job that
  already ended or never existed.
- New placeholder `{job_file}`: a lease `shell` template must contain it
  exactly once, and a session template may not contain it. mu derives the
  path as `<state dir>/carrier/<ws>/<agent>.job`, hashed past a length bound
  by the same rule as ctl sockets.
- A lease `shell` template must also contain `{local_sock}` and
  `{remote_sock}`, as today. **Invariant mu guarantees and a carrier may
  rely on:** `local_sock` determines `remote_sock`, because both derive from
  (workstream, agent). mule's forward table wedges if one LOCAL is ever
  forwarded to two REMOTEs (see the mule spec), so this invariant is
  documented and tested, not incidental.
- No `--max-agents`. A lease pane holds **no** `host_channels` row: it
  holds no session. `--max-sessions` keeps meaning ssh channels mu holds
  open (`exec`, `fetch`, `stop`, `check`), so `collect` works while a lease
  worker runs. A cap on live leases can come later, if a host needs one.
- `host show` / `list` print the transport and, for `lease`, the stop
  template.
- Host templates run with `graceMs` 5000 instead of 500 (`execGroupCapture`),
  so a carrier interrupted by a timeout has time to stop the job it
  dispatched. This applies to both transports and is harmless for plain ssh.

`host init <name> --mule` prints a lease starter beside `--ssh`:

```sh
mu host add dev --transport lease \
  --shell 'mule run --host dev --lease --human --cwd {cwd} --job-file {job_file} --forward-unix {local_sock}:{remote_sock} -- env {env} sh -c {cmd}' \
  --exec  'mule exec --host dev -- sh -c {cmd}' \
  --stop  'mule rm --host dev {job}' \
  --fetch 'git fetch ssh://dev{cwd} HEAD'
```

- The `shell` and `exec` templates use `env {env} sh -c {cmd}`, not `{env}
  {cmd}`. mule quotes each argv word separately, so a bare `K='v'` word
  would run as a program name (measured: `sh -c "'A=1' 'echo hi'"` gives
  `A=1: command not found`, rc 127). `env` applies the assignments, and `sh
  -c` runs the multi-word command.
- mule jobs run in a non-login shell. A host that finds `pi` only through
  login files edits `sh -c` to `zsh -ilc`, or fixes PATH in `.bashrc`
  (mule's documented answer).
- `--human`: mu's `{env}` carries the identity murmur keys on, and mule's
  `mule-<id>` metadata would mislabel the row.
- `--stop` is `mule rm`, which in one round trip kills a live job and
  tolerates a missing one.
- `--fetch` stays plain ssh on purpose: a fetch is a bulk transfer, and
  mule's own invariant forbids lending its channel to one.

### `carrier_jobs` (new, machine-local)

```text
carrier_jobs(agent_id INTEGER PRIMARY KEY, workstream TEXT, name TEXT, host TEXT,
             job TEXT NOT NULL, host_stop TEXT NOT NULL, recorded_at TEXT)
```

- One row per lease agent incarnation, inserted when mu reads the handle.
  No foreign key, no trigger, no op, no sync.
- **Deleted only after a successful `stop`.** Agent deletion never touches
  it, so reconcile ghost prune, teardown, workstream delete, the reaper and
  raw `mu sql` all leave it. This covers `--cwd` lease agents, which have no
  `remote_recovery` record (that table requires a worktree).
- `host_stop` is the stop template as it was when the handle was recorded.
  A later stop runs from the current profile only if its `stop` is
  byte-identical. Otherwise it refuses and names the handle, so the
  operator can stop the job by hand. This mirrors `host_exec` on recovery
  records.
- `remote_recovery` is unchanged: it records worktrees, and its triggers do
  not move.

### `agent spawn --host` on a lease profile

1. Admission reserves a **transient** channel for prepare, as today.
2. Prepare (worktree or cwd) runs through `exec`. The transient channel is
   **released** once prepare ends. Nothing is bound to the pane, because a
   lease pane holds no channel.
3. Inside the spawn lock, with the name owned, mu removes the ctl socket
   file as today, and removes the job file **only if** no `carrier_jobs`
   row names this (workstream, name) with a gone agent. If such a row
   exists, the spawn refuses: `<name> has an unstopped job <handle> on
   <host>: mu agent close <name>`. This way an old job can never lose its
   last pointer.
4. The pane runs the filled `shell` template.
5. **Job handshake.** It is mandatory for `lease` and independent of ctl,
   `--no-ctl` and `MU_SPAWN_CTL_MS`, with its own budget `MU_SPAWN_JOB_MS`
   (default 30 s, never 0). mu waits for the job file. Its content is one
   line, an opaque handle `^[A-Za-z0-9._:@-]{1,128}$`, and mu parses nothing
   further. mu inserts the `carrier_jobs` row in one statement guarded by
   the row's id + pane. A pane that dies first is `AgentDiedOnSpawnError`
   with its scrollback; the carrier prints the remote screen on early exit,
   so the startup scan still reads provider and auth errors. A live pane
   with no file by the deadline is rolled back.
6. ctl handshake through the carrier's forward, unchanged.

**A lease profile refuses command gates** (`--host dev --command 'npm
test'`). Mapping a carrier's exit to a gate result is out of scope. Use a
session profile, or `mule run --wait` directly.

**Rollback** (any phase after the pane exists):

1. Kill the pane.
2. Read the job file again. The carrier writes it before dispatch, so a
   job that might exist always has a file.
3. If there is a handle, run `stop`, then the existing
   `removeRemoteWorktree`. A failed `stop` keeps the worktree and the
   `carrier_jobs` row, and says so.
4. If there is no file, nothing was dispatched: run the worktree removal as
   today.

### `agent close`

The fenced check-then-kill block stays exactly as it is (close.ts: nothing
awaited between `replaced()`/`fence()` and `killPane`). The stop goes
**after** the liveness proof and **before** the worktree rule:

1. The existing pre-checks, fence and kill.
2. The existing liveness proof (`alive === false`, or forced as gone).
3. `replaced()`.
4. **`stop`** for the incarnation's handle: the `carrier_jobs` row, or, if
   the spawn had not inserted it yet, the job file at the derived path. With
   neither, the close refuses and keeps everything (`spawn in progress`).
   - Exit 0 deletes the `carrier_jobs` row.
   - Exit 3 is a hand-back (below): refuse and keep the row.
   - Any other failure refuses, keeps the row, and names the template's
     first stderr line.
5. `replaced()` again, then free channels, unlink the ctl socket and job
   file, and run the remote worktree rule, unchanged. Nothing of the agent
   runs in the tree now, so the quiescence scan passes for the reason it
   exists.

The carrier's own SIGHUP stop and mu's stop race safely: both are
idempotent and serialised by mule's ticket lock.

`--force` never skips `stop`. To give up on a job whose host is gone for
good, the operator runs `mu agent close <name> --abandon-job`. That drops
the handle without stopping the job, emits an event naming the host and
handle, and is the only way a `carrier_jobs` row is deleted without a
successful stop.

`carrier_job` (the handle, or its absence) joins `agentRevision`, so a
preview taken before the handle landed fails `--if`.

A **session** agent's close is unchanged.

### No agent row left

`agent close <name>` with no live agent:

1. If a `carrier_jobs` row names (workstream, name), stop it under the rule
   above, then delete the row.
2. Then the existing `remote_recovery` worktree close, if there is a record.

`agent collect <name>` never stops a job; it only fetches.

### `next`, `doctor`

- `next-recover` already reports a remote worker with no pane as
  `attention`. For a lease worker, only the reason text changes, to name the
  handle and `mu agent close <name>`.
- `doctor` gains a `lease-job` **hint** (not FAIL, which is exit 5): a
  `carrier_jobs` row whose agent is gone, with its close command. A job that
  ended normally leaves such a row until the next close, and that is
  ordinary.

### Hand-back: exit 3 from a template

The skill already claims this, but no code implements it.

- **Throw site:** `runLeasedTemplate`, for `exec`, `fetch` and `stop`
  (never `shell`, which is a pane). Exit 3 throws `HostHandbackError`
  (label `human needed`, exit 5, `data.handback = true`, and the first line
  of either stream as `detail`). It is never retried, and never recorded as
  `human-needed` automatically, because VISION says that record is always a
  decision.
- **Callers:**
  - `checkHost` catches it, records a `handback` step, and skips the rest,
    the way an unreachable host does. The report still prints.
  - Prepare, close and collect rethrow it unchanged.
  - Rollback and gate-clean swallow it, as they swallow everything today.
- mu's own remote scripts never exit 3 (they use 4 to 10). A unit test scans
  the script builders in `remote-agent.ts`, `agents/gate.ts` and `hosts.ts`
  for a literal `exit 3`. A forwarded exit (`exit "$rc"`, `exit $?`) passes
  a user's 3 through, and that is accepted: the cost is one refused step
  with a misleading line, for a case nobody has hit.

### `host check`

- **Lease profiles:**
  - check that the `shell` template contains `{job_file}`, `{local_sock}`
    and `{remote_sock}`;
  - expand `stop` with a dummy handle, without running it;
  - run the `pi` and `extension` steps **without** `login()`, as the
    starter's `sh -c` will run them. A login-shell success says nothing
    about a non-login job.
- **Session profiles:** warn (never fail) when the `shell` template lacks
  `ControlMaster=no` or `ControlPath=none`. This is a heuristic, stated as
  one.
- `check --agent` on a lease agent also reports its `carrier_jobs` handle.

### Fix: session-transport forwards (ships alone)

- Correct the `hostStarter` comment. A multiplexed ssh binds the forward in
  the master, where it outlives the pane and is never re-bound.
  `ControlMaster=no ControlPath=none` stays, and the comment now says why.
- One line each in `docs/guide/remote.md` and `remote-workers.md`: a
  session template must not ride a shared master; on a session-capped host,
  use `lease`.

## Schema

No version bump, in line with the per-machine spec's no-migration stance.

- `host_profiles`: `transport TEXT NOT NULL DEFAULT 'session'` and `stop
  TEXT`, through `ADDED_COLUMNS`. The transport is validated in `addHost`,
  not with a CHECK: `ADDED_COLUMNS` cannot add one in place.
- `carrier_jobs`: a new table in `CURRENT_SCHEMA` and `MACHINE_LOCAL_TABLES`.
- `host_channels`, `agents`, `remote_recovery` and its triggers are
  **unchanged**: there is no new channel kind, no `carrier_job` column, and
  no `_v3`.

## Surface summary

| Verb | Change |
| --- | --- |
| `host add` | `--transport`, `--stop`; `{job_file}` placeholder; `{job}` in `--stop` |
| `host init` | `--mule` starter |
| `host show` / `list` | transport, stop |
| `host check` | lease template checks, non-login pi step; session-on-master warning; handback step |
| `agent spawn --host` | job handshake (`MU_SPAWN_JOB_MS`); `carrier_jobs` row; stop-first rollback; lease refuses gates |
| `agent close` | stop after the liveness proof; `--abandon-job` |
| every `exec`/`fetch`/`stop` run | exit 3 becomes `HostHandbackError`; `graceMs` 5000 |
| `doctor` | `lease-job` hint |

## Docs

- VOCABULARY: add **transport** (`session`, `lease`), **carrier**, **job
  handle** (`carrier_jobs`), **stop template** and **hand-back**. Amend
  **remote worker** ("the pane is the transport, or the lease on it") and
  **host channel** (a lease pane holds none).
- `docs/guide/remote.md`: a "Session-capped hosts" section with the mule
  starter, why `--fetch` stays plain ssh, and the master-bound forward trap.
- `skills/mu/recipes/remote-workers.md`: on a capped host use a lease; exit
  3 means stop and ask; `--abandon-job` is the only way past an
  unreachable host.
- VISION principle 6 table: "pi (… remote over `ssh -L`, or a carrier's
  forward)".
- ROADMAP: an entry for (b) under the promotion criteria (below).
- CHANGELOG: `### Added` (lease transport, hand-back) and `### Fixed`
  (starter comment, `graceMs`).

## Delivery and promotion

- **(a) Polish, ships now:** the starter comment and docs fix, the
  session-on-master warning in `host check`, the hand-back (the skill
  already documents it), and `graceMs`. About 80 LOC plus tests.
- **(b) Lease transport:** a ROADMAP entry first. The friction evidence is
  2026-10-28's session plus the history in the dotfiles repo's
  `docs/DECISIONS.md`: the murmur collect starves (2026-09-28), and
  `t3-dev` exists to dodge the same hold. That is more than twice. After the
  review's simplifications (no channel kind, no recovery columns, no
  `--max-agents`) it is about 250 LOC of source.
- (b) lands only after mule's `--lease`, `forward` and `exec` are released.

## Testing

All unit tests use a fake carrier: a shell script that writes the job file
first, binds a local unix socket served by a stub ctl, records SIGHUP, and
logs every stop call with its handle.

- Spawn records a `carrier_jobs` row and holds **no** `host_channels` row
  once the pane is up. At `--max-sessions 1`, `collect` succeeds while the
  worker lives.
- The job handshake runs under `--no-ctl` and `MU_SPAWN_CTL_MS=0`. A pane
  that never writes the file rolls back at `MU_SPAWN_JOB_MS`. A pane that
  dies first reports its scrollback.
- Close, by log order: kill, then liveness proof, then stop, then worktree
  rule. A stop that exits 1 keeps the row (agent and `carrier_jobs`). Exit 3
  raises `HostHandbackError` and keeps both. `--force` does not skip stop.
  `--abandon-job` drops the handle and emits the event.
- Close while the handle is not yet inserted reads the job file; with no
  file, it refuses with `spawn in progress`.
- Rollback after the pane exists re-reads the job file and stops before
  `removeRemoteWorktree`. A failed stop keeps the worktree.
- **Every deletion path keeps the handle** (reconcile prune, teardown,
  workstream delete, a raw `mu sql --write` DELETE), for a `--cwd` lease
  agent and a `--worktree` one. `agent close <name>` with no row then stops
  it.
- A respawn of a name with an unstopped handle refuses. A changed `stop`
  template refuses the recovery stop.
- `local_sock` → `remote_sock` is a function of (workstream, agent),
  including past the hash-shortening bound.
- `host check` on a lease profile runs `pi` without `login()`; the handback
  step skips the rest.
- Script scan: no builder emits a literal `exit 3`.
- Smoke (operator-driven, not in suites): real mule against the local `sshd
  MaxSessions 1` recipe from mule's SPEC.
  - Spawn. While the worker runs, `ssh -S <default master> host true`
    succeeds.
  - Send and wait. Close. Job, forward, socket, job file, worktree and
    `carrier_jobs` row are all gone.
  - Then `kill -9` the carrier, let reconcile reap, and close by name.

## Out of scope

- mu calling mule directly, or knowing mule exists. Every mule word lives in
  the user's templates.
- Forwarding keystrokes from the lease pane to the remote TUI. Interaction
  goes through `mu agent send`, or by attaching with murmur's jump command,
  which the carrier prints.
- Lease command gates, herdr `--host`, and lease for local agents.
- Making `lease` the default, or migrating profiles.
- A cap on concurrent leases (`--max-agents`), until a host needs one.

## Measurements (2026-10-28)

macOS 27 / OpenSSH_10.3p1 / tmux 3.7c; the devvm, and a loopback `sshd
MaxSessions 1` built from mule's SPEC recipe.

| Claim | Result |
| --- | --- |
| A held ssh pane blocks the host | During `devtest`, `ssh dev …` gave `Session open refused by peer`, then `Permission denied (keyboard-interactive)` |
| A forward through mule's master takes no session | devvm: a forward carried `hello-from-dev` while a concurrent `ssh dev` on the default master succeeded. Loopback: with the only session held by `sleep 10`, a second session was refused, while traffic on an existing forward, a new `-O forward`, a `-O cancel` and three concurrent forwarded connections all succeeded |
| A mux client's `-L` is bound in the master | After `ssh -S m -L L:R host true` exited, `lsof` showed `L` held by the master pid; connect and echo worked |
| An unlinked forward is never rebound | `rm L`, then `-O forward -L L:R`: exit 0, no file |
| Cancel, then forward, rebinds | `-O cancel`, then `-O forward` on a master started with `StreamLocalBindUnlink=yes`: the file is back and traffic flows |
| A master exit leaves a dead file | After `-O exit`, SIGTERM or SIGKILL of the master, `L` remained and `connect` gave `ECONNREFUSED` |
| A non-mux `ssh -L` leaves its file on exit | After a normal exit, SIGHUP or SIGTERM, `P.sock` remained (stale); this matches the `ctl/path.ts` comment |
| A pane-kill SIGHUP leaves the carrier time to stop | A shell `trap … HUP` ran `sleep 2` and logged completion after both `tmux kill-pane` and `kill-server`. That was shell; see the mule spec for Rust's tty caveat |

## Review (2026-10-28)

Two adversarial reviewers (one on this spec against the code, one on the
mule spec) and a measurement refuter checked the first draft. Accepted and
folded in:

- Handles moved from `remote_recovery` (which skips `--cwd` agents) to
  `carrier_jobs`, deleted only by a successful stop.
- No `host_channels.kind='lease'`: the CHECK cannot change in place, and
  every helper hardcodes `'attached'`. A lease pane holds no channel, and
  `--max-agents` was dropped.
- Stop moved after the liveness proof. The first draft's stop-before-kill
  broke the fence, and the stopped carrier's own exit let reconcile write a
  stale record.
- Rollback re-reads the job file. Pane death is not job death.
- `--force` versus stop: no skip, plus an explicit `--abandon-job`.
- The job handshake is independent of ctl. Lease refuses command gates.
- The window before the handle lands: close reads the job file, and the
  handle joins `agentRevision`.
- `host check`'s pi step runs non-login for lease. The first draft's claim
  that check already catches it was false.
- The recovery stop pins `host_stop`.
- The hand-back throw site is specified, with each caller's handling.
- The starter ran env words as program names; now `env {env} sh -c {cmd}`.
- The stop template is `mule rm`; the proposed `kill --missing-ok` was
  redundant.
- `graceMs` raised so an interrupted carrier can stop its job.
