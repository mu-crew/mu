# Reattaching a reaped lease agent, leftovers, and visible stop failures

Status: proposed (v2 after three refutations; § Review) · Date: 2026-11-04
Builds on: [2026-10-28-lease-transport.md](2026-10-28-lease-transport.md) (mu) and
mule `docs/specs/2026-10-28-mu-lease.md`
Evidence: the 2026-11-04 aiv-blog incident (cite it in every commit)

## Problem

A restart of the local tmux server sent SIGHUP to six lease panes (`mule run
--lease`). Each carrier's signal path spawned a detached `mule rm <id>`
(mule `src/lease.rs` `on_signal`, `src/cleanup.rs` `spawn_rm`).

On dev0 the master was up and the jobs were removed. On dev1 it was down:
`rm` failed in `require_master` (`src/jobs.rs`), unseen (stdio `/dev/null`),
and the jobs kept running.

Reconcile then reaped all six rows. Their tasks went back to OPEN, so any
worker could claim them while the dev1 jobs still ran. A `remote_recovery`
record was written for each, and the `carrier_jobs` reservations were kept.
mu could not reattach, and `mu agent list` printed `"orphans": []`.

This spec covers G2 (mule retries, then records, a failed signal-path stop),
G3 (`mu agent reattach`, mule's attach mode, parking the reaped agent's
tasks) and G4 (leftovers in `mu agent list`). G1 ships separately.

## Name: `agent reattach`, not `agent adopt`

The removed `mu agent adopt <pane-id>` (cut in 4.0) **registered an
arbitrary pane**; its `agent.adopt` intent still renders old ops rows. The new
verb opens a **new** carrier pane for a job mu already holds a reservation
for, so reusing the name would make old `mu log` lines lie. Verb: **`mu agent
reattach`**, intent `agent.reattach`.

## Units

| Unit | Repo | Owns | Depends on | src LOC (est.) |
| --- | --- | --- | --- | --- |
| `mule_stop` | mule | G2: `rm --retry-for/--failed-file/--fence-gen`, the stop fence, the record | — | ~200 |
| `mule_attach` | mule | `run --lease --attach <id>` | `mule_stop` (fence) | ~140 |
| `mu_profile` | mu | `host add --attach`: column, scope, checks, starter, show, `host check`; `attachCommand()` | contract § 1 | ~95 |
| `mu_adopt` | mu | G3: `mu agent reattach` (preflight, preview, apply, readiness, rollback) | `mu_profile` | ~270 |
| `mu_reap` | mu | G3: the reaper parks a lease agent's tasks; `reattach --task` | `mu_adopt` | ~60 |
| `mu_list` | mu | G4: leftovers in `agent list`; record read and cleanup | `mu_adopt`, `mu_reap` | ~130 |

`mu_list` comes last: its `next` prints `mu agent reattach`, which must exist
("executable as printed", surface contract § Next). Per-file estimates are in
each **Files**; a mu unit over 300 LOC at review splits at its named seam.

## The cross-repo contract (both sides implement exactly this)

1. **Attach command.** Written in the user's host template; mu never names
   mule. Starter shape:
   `mule run --host H --lease --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}`.
   It exits 3 (no master) or 1 (job not running, conflicting job file) before
   holding or changing anything. It may wait on mule's ticket queue and on an
   in-flight stop attempt, so no time bound is promised. Otherwise it holds
   exactly like a lease, and SIGHUP stops the job.
2. **Stop-failure record.** A lease's signal-path stop that gives up writes
   `<job_file>.<id>.stop-failed` beside the job file; the path names the job,
   so two jobs of one name never share one. One UTF-8 line, ≤ 512 bytes,
   starting `<id> `, atomic, mode 0600; mu treats the rest as opaque. A
   carrier that never writes one is still valid.
3. **Job file.** Unchanged: one line holding the handle. Attach publishes it
   without replacing anything (§ mule_attach step 4).
4. **Stop fence.** In mule's local (laptop) state, keyed by job id; mu needs
   nothing for it (§ mule_stop).

## G2 — mule_stop: a signal-path stop that fails is retried, then recorded

**Command.** `RealSignalSteps::spawn_stop` detaches
`mule --quiet [--config C] rm --host H <id> --retry-for 600 --fence-gen <G> --failed-file <job_file>.<id>.stop-failed`,
`<G>` being the generation the carrier owns (mule `src/lease.rs`, `Owned`):
fixed before the carrier can own the job (a lease reads it before its
dispatch; an attach owns the number it bumped to) and never re-read at
signal time. A signal thread descheduled after its pane went could otherwise
read an attach's new generation and kill the reattached job, and a read
error there would leave the stop unfenced. A lease whose fence cannot be read
dispatches nothing. `exec`'s signal path omits `--failed-file` (no job file).

New `rm` flags (`Commands::Rm`), all conflicting with `--all`:
`--retry-for <SECS>` (retry until this much monotonic time has passed;
without it, one attempt as today), and, both requiring it, `--fence-gen <N>`
(this stop's generation) and `--failed-file <PATH>` (write the record there
on giving up; on success remove that path, best effort, which names this
child's own id).

**Stop fence** (new `src/stopfence.rs`): `lock::state_dir()/stopping/<id>`
holds one decimal generation (missing = 0).
- The child holds a blocking `flock` on that file for each whole `rm`
  attempt. Under it, a generation other than `--fence-gen` means the job was
  reattached since this stop began: exit 0 at once, with no `rm` and no
  record written or deleted.
- `run --lease --attach` takes the same lock (waiting out an attempt in
  flight) and bumps the generation only after proving the job Running. A
  child that is sleeping or polling for the master wakes, locks, sees the new
  generation and exits. A later stop by the attached carrier's own signal
  carries the bumped generation it owns, so the fence never disarms a future
  stop.
  Direction A's cancel marker fails one of two ways: removed by attach, it
  re-arms a sleeping old child; left in place, it cancels the next carrier's
  stop of the same id.
- After a successful `rm` (job proven gone) the child unlinks the fence file;
  a waiter on the old inode then probes Missing, which is harmless. The file
  is never unlinked while the job may run: unlinking a live flock file lets
  two holders in (the trap `forward.rs` notes).

**Retry loop** (`jobs::remove_with_retry(t, host, id, policy, clock, fence)`,
pure over `Transport` plus an injected clock, sleep and fence for layer 1):
- **Master down** (`!t.master_alive(host)`): no `rm`; check again every
  **5 s** (`-O check` is lock-free, opens no session, killed after 2 s). The
  child never opens a master or prompts; it waits on the human the dead pane
  already asked.
- **Master up:** lock the fence, check the generation, run
  `remove(Target::One)` through the normal ticketed `Transport::run`, then
  unlock. Exit 0, or "nothing to remove": done (exit 0, remove the record,
  unlink the fence). Any other error: keep its first line as `last_reason`
  and back off 5 → 10 → 20 → 30 s, capped at 30 s. The backoff happens after
  the ticket is released, so it holds no queue slot.
- **Deadline (soft).** `--retry-for` is checked between attempts, and each
  sleep is clamped to the time left. An attempt in flight has **no wall-clock
  bound**: the ticket wait is unbounded by design (SPEC § Contention), a live
  suspended holder is not skipped, and session ssh is a plain `output()`. So
  the record may be late, or may never appear if the child blocks forever.
  We add no cancellation for in-flight ssh.
- **Giving up:** write the record with the job file's atomic writer,
  generalised to `write_line_file(path, line)`. The line is
  `<id> on <host> not stopped: <last_reason> (gave up after <n> attempts, <secs>s; at unix <t>)`,
  where `last_reason` is `no control master` if the master was never seen.
  The line is cut to 512 bytes on a UTF-8 char boundary by shortening
  `last_reason` first, so the id, host and counts survive. Exit 3 when there
  was no master, else 1. Nobody reads that code.

`rm` exit codes, exit 0's meaning, and `rm --all` are unchanged.
**SPEC/usage amendments.** § Exit 3: the detached stop child is the one
caller that waits for a master (no terminal, opens nothing, polls lock-free,
soft deadline). § Add a local scheduler or supervisor: a second carve-out, a
dead lease's own stop retried for at most `--retry-for`, fenced against
reattach, never re-dispatching. § rm: "not killed again silently" becomes
"one `rm` never kills twice; a retrying stop repeats whole attempts and
records its failure".

**Files** (est.): `src/stopfence.rs` (new, ~60), `src/jobs.rs`
(`remove_with_retry`, ~80), `src/cli.rs` (~20), `src/cleanup.rs`
(`rm_command` takes the options, ~10), `src/lease.rs` (generalised writer,
fence gen, record path, ~25), `src/exec.rs` (~5); `SPEC.md`, `docs/usage.md`,
`CHANGELOG.md`.

**Acceptance tests:**
- L1 (`Fake`, injected clock and fence): no master ×3 then master → one
  `rm`, exit 0, no record, fence unlinked · no master throughout → zero `rm`,
  record `no control master`, exit 3, virtual time ≤ bound + one interval ·
  `rm` fails ×2 then succeeds → backoff 5, 10 s · always fails → record starts
  `<id> ` with the first stderr line · a blocked attempt past the deadline →
  one attempt, overrun, record · a 2000-byte multibyte reason → ≤ 512 bytes,
  valid UTF-8, id kept · generation bumped while sleeping → no further `rm`,
  no record, exit 0 · bumped while an attempt holds the lock → the bumper
  waits, no further attempt · success removes its own record and leaves
  `<job_file>.<other>.stop-failed` · `rm_command` argv for lease (three flags)
  and exec (no `--failed-file`).
- L3 (local sshd): stop the master, TERM a lease → record appears; restart
  the master → `mule ls` shows the job (it cannot while the master is down).
  A restart within the bound → job gone, no record.

## G3 — mule_attach: `mule run --lease --attach <ID>`

**CLI.** `--attach <ID>` (a `JobId`) on `Commands::Run` requires `lease` and
`job_file`, conflicts with `cwd`, `max_secs`, `human` and `cmd`; `cmd` becomes
`required_unless_present = "attach"`. A flag, not a verb: it is the same
process (`hold()`, signals, forwards) minus `start()`.

**Behaviour** (`src/lease.rs` `attach_cli`, sharing `run_cli`'s signal
wiring):
1. `require_master`, or exit 3 with nothing written.
2. Take the stop fence lock for `<id>`, waiting out an in-flight stop.
3. Probe once (`probe(…, From::StateOnly)`). `Running` → go on. `Done(n)`,
   `Orphan`, `Missing` → `mule: job <id> is not running (<state>)`, exit 1; a
   probe error → exit 1. On exit 1 the fence and job file are untouched.
4. Job file, never replaced. Missing: write a temp file, then
   `link(temp, path)`, re-reading the file on EEXIST. Same id: keep it.
   Another id, empty, invalid or unreadable: exit 1, untouched.
5. Bump the fence generation, set `named = Some(id)` under the signal mutex
   that `on_signal` reads, then release the fence lock. A signal before
   `named` stops nothing (if it lands after the bump, the job runs on and mu
   keeps the reservation). A signal after `named` goes through `on_signal`,
   G2 included, with the bumped generation.
6. `hold()` unchanged. It initialises its own state and needs no `start()`.
   There is no dispatch, and `dispatching` stays false. Exit codes are the
   lease's.

**Forward repair (documented, not new code).** `hold()`'s first forward runs
the existing cancel → unlink → forward → verify sequence. It repairs a dead
carrier's stale listener for an identical spec, or for a changed REMOTE whose
record still names the same master. It cannot repair a wedged forwarding
table, or lost metadata describing a different surviving REMOTE: `hold()`
reports that and keeps holding, and mu's ctl handshake fails.
`docs/usage.md` says so.

**Files** (est.): `src/cli.rs` (~15), `src/lease.rs` (`attach_cli` ~90, the
non-replacing publish ~25, fence use ~10); `docs/usage.md` (§ Reattaching to
a running job), `SPEC.md` (§ Leases: attach is not a re-dispatch),
`CHANGELOG.md`.

**Acceptance tests:**
- L1: Running → hold, job file written, generation bumped · Done, Missing,
  Orphan → exit 1, zero `rm`, no file, generation unchanged · a file naming
  another id, empty, or unreadable → exit 1, unchanged · a racing writer
  between read and publish → the publish loses, the re-read decides · same id
  → kept · a signal after `named` → `spawn_stop` with the new generation ·
  attach waits while a fake stop attempt holds the fence · clap refusals (no
  `--lease`, no `--job-file`, a command given).
- L3: attach after (a) a SIGKILLed lease with listener and record intact,
  (b) LOCAL unlinked with the master's forward entry present, (c) a replaced
  master; each verifies traffic reaches the remote echo socket, not merely
  `connect` · TERM → job stopped · an old stop child sleeping on a downed
  master, then attach, then the master returns → the child exits without
  `rm` and the job runs.

## G3 — mu_profile: the `--attach` host template

- `host add --attach <template>`: optional, lease only. Stored as
  `host_profiles.attach TEXT` in `ADDED_COLUMNS`, mirrored in
  `CURRENT_SCHEMA`, v13 with **no bump**: `upgradeSchema` completes a v13
  file missing a later addition, as it did for `agents.host_transport`,
  `host_profiles.stop` and `carrier_jobs.tree_path`. AGENTS.md § Update the
  schema says to bump; this unit adds "a plain nullable or defaulted column
  goes in `ADDED_COLUMNS` with no bump".
- `src/hosts.ts`: an `attach` scope in `TEMPLATE_SCOPES` takes `job`,
  `job_file`, `local_sock`, `remote_sock` and `cwd` (always `.`); `{env}`
  and `{cmd}` are refused (nothing is dispatched). `profileTemplateProblem`
  requires `{job}` and `{job_file}` exactly once and the two socks at least
  once. Add `HostProfile.attach: string | null`, `NewHostProfile.attach?`,
  the `addHost` checks, and a `hostMuleStarter` `attach` line (contract § 1).
- `host init --mule`, `host show` and `host list` print it. `host check`
  adds an `attach` step that expands with a dummy handle and never runs, like
  `stop`.
- `attachCommand(profile, {job, jobFile, localSock, remoteSock})` in
  `src/remote-agent.ts` fills it and wraps it as `remoteShellCommand` does
  (`exec env -u … /bin/sh -c`), through a shared `wrapLocal`.
- There is no `host update`: `host rm` then `host add` (a lease pane holds no
  channel). A byte-equal `--stop` keeps every reservation stoppable.

**Files** (est.): `src/hosts.ts` (~50), `src/db.ts` (2), `src/cli/` host
wiring (~15), `src/remote-agent.ts` (~25), `AGENTS.md` (1 clause).

**Acceptance tests:** `test/host-lease-profile.test.ts` (refuses `{cmd}` and
`{env}`; placeholder counts; session refuses `--attach`) · `test/db.test.ts`
(fresh file has the column; added to `v13-populated.db.gz` with rows kept; a
second open runs no DDL) · `test/host-check-lease.test.ts` (attach expands,
never runs) · `attachCommand` quotes a hashed long `job_file`.

## G3 — mu_adopt: `mu agent reattach <name> -w <ws> [--if <rev>]`

Reattach is **pi-only by definition**: the reaped row's `cli` survives
nowhere (`carrier_jobs` and `remote_recovery` store none), and lease spawn
refuses only command gates, so a `--cli claude` lease agent can exist. The
new row gets `cli='pi'`, `command='pi'`, `command_source='cli-key'`, the
default role, `tab = name`, and `spawner` from the env. A non-pi job attaches
with ctl `missing` (row kept). `docs/guide/remote.md` says to close such an
agent instead.

**Bare = preview, `--if <rev>` = apply**, like `agent close`.
- **Preview:** read-only. Runs the preflight and prints host, job, tree,
  previous pane and `rev = agentRevision(ws, name)`, which with no row
  already hashes the reservation and records. `next` is the apply with
  `--if <rev>`. The preflight awaits a mux probe, so the facts and the
  revision come from ONE read transaction taken after it, like
  `previewClose`: the row's absence, the workstream, the reservation and the
  record are re-read there, and a plan they no longer match is retried. After
  3 attempts it refuses (`AgentReplacedError`, exit 4, next = the preview).
- **Apply:** a different revision refuses (exit 4) before any effect. The
  apply takes its plan and revision the same way.

**Preflight** (`reattachBlockers(db, ws, name): Promise<Blocker[]>`,
exported for `mu_list`). It is local only: DB, local files, and a local mux
probe. Each blocker is a refusal (exit 4, typed `ReattachRefusedError`) with
`next: mu agent close <name> -w <ws>`, the close preview, plus
`--recovery <id>` when the name has more than one record.
1. **No agent row of the name** (else `AgentExistsError`).
2. **Workstream** exists and is not torn down (`tornDownAtOf`, as spawn
   checks), and the reservation's `carrier_jobs.workstream_id` is the live
   workstream's id, so a re-created workstream refuses. The bind
   (`bindCarrierJobAgent`, at finalize, after `insertAgent` ensured the
   workstream) stamps it with the bound row's `workstream_id`; a rebind keeps
   it. NULL (a reservation bound before the column, added in place to a v13
   file) refuses as unknown. Neither `created_at` (a reservation can predate
   an auto-created workstream) nor `recorded_at` (when the handle was learned,
   possibly by a close after a teardown and reinit) is a generation.
3. **Exactly one reservation of (ws, name)**: legacy ordinals can leave
   several.
4. **The reservation** has `job`, `launch='intent'`, `agent_id` and
   `pane_id` set (it was bound to a spawned incarnation), and `reason` and
   `tree_path` null.
5. **The previous carrier is proven gone:**
   - `localPaneAlive(pane_id)` is false; an exited retained pane counts as
     gone, and a probe that throws refuses as unknown. A raw row deletion can
     leave a live carrier, and two carriers must never share a forward.
   - `pidProvenGone(creator_pid, creator_start)`; a null pid refuses as
     unknown.
   - No **pending-carrier marker** (Apply 2) whose pane may run. A marker is
     a file, `<db dir>/locks/agent-<ws>.<name>.reattach-pending`, beside the
     agent lock but not in it: a pid-owned lock is stolen once its process
     dies, and the DB write is what can fail. One naming a pane that
     `localPaneAlive` proves gone is stale (the apply replaces it). One with
     a live or unknown pane, no pane, or unreadable or malformed contents
     refuses, naming the file and its cleanup: close that pane, or `rm` it
     once no carrier of its job runs.
6. **Profile** exists, is `lease`, has an `attach`, and its `stop` is
   byte-identical to `host_stop` (the identity proof `runStop` uses).
7. **Tree** = `getRemoteRecovery(db, reservation.agentId)`, unique because
   `agent_id` is the record's key, so there is no `--recovery` flag. Records
   of the name with other agent ids are other trees and are ignored.
   - **Present:** `workstream`, `name` and `host` match, `workstream_id` is
     the current workstream's, and `assertRecoveryUsable` passes. The row
     takes `cwd`, `base`, `collected_head` and `repo = host_repo`.
   - **Absent:** the agent was a `--cwd` lease agent (the trigger needs
     `base`), or its tree was already closed with `--recovery`. The tree
     fields are NULL, and a later close runs no tree rule.
8. **Job file** is missing, or names `job`; else refuse with `describeRead`.
9. **Mux:** `(await activeMux()).runsShellCommand`.

Whether the job runs or the master is up is the attach's answer, handled by
the readiness matrix.

**Apply.** Take the agent lock (strict), then the session's spawn lock, as
spawn does.
1. Re-run the preflight and the `--if` check. `rmSync` the stale ctl socket.
2. Publish the pending-carrier marker (`{job, pid}`, exclusive create,
   after removing a stale one) BEFORE the pane is requested: a failed write
   refuses (`ReattachRefusedError`) with no pane opened. Then
   `mux.spawnAgent` (window = name) with `attachCommand(...)`, up to
   `onPaneCreated`, which adds the pane id to the marker (a failed write
   keeps the marker without it: still a refusal). The marker is removed only
   after install commits, after the fallback pointer names the pane, or once
   the pane is proven gone; a process that dies in between leaves it.
3. **Install, one immediate transaction:**
   - preflight 7's predicate again (`recoveryBlocker`, shared with the
     preflight), before `insertAgent` (its same-name check would see the new
     row). The name and spawn locks do not cover another workstream's spawn,
     which can take the record's path during step 2's pane I/O or the
     preflight's last await, so a check of the snapshot alone is not enough;
   - `insertAgent` with the reservation token (passes the name fence),
     `host`, `host_transport='lease'`, the tree fields and the new pane;
   - `rebindCarrierJobAgent(token, job, oldAgent, oldPane, newId, newPane)`
     (new, `src/carrier-jobs.ts`): a compare-and-set UPDATE. It is separate
     from `bindCarrierJobAgent`, which refuses a stale `agent_id` on purpose;
   - `deleteRemoteRecovery(rec)` (compare-and-set) when there is a record.

   Install can still fail (teardown and reconcile take no agent lock). Then
   mu first points the reservation at the new pane (`rebindCarrierJobAgent`
   from the old pair to the old agent id and the new pane; the old pane is
   proven dead already), then **kills the new pane**: a carrier must not hold
   a job with no row ("pane death is agent death"). Only a `localPaneAlive`
   false after the kill reports `rollback:"pane-killed"` (its signal path is
   stopping the job). Otherwise `rollback:"pane-unknown"`, naming the pane:
   the next preflight probes that pane and refuses while it may run, so two
   carriers never share the job's forward. The pointer write can fail on the
   writer lock that failed install, or lose its compare-and-set: it never
   skips the kill. An unproven kill retries it once; still unwritten, the
   error says the reservation does not name the pane, and the marker it
   keeps makes the next preflight refuse while that pane may run.
   When it was preflight 7's predicate that failed and the kill is proven, the
   result is that blocker's refusal (`ReattachRefusedError`, naming the killed
   pane): the reservation only moved from one dead pane to another.
4. Release the locks.

**Readiness:** `awaitCtlHandshake(sock, assertAlive)` with `localPaneAlive`;
no spawn startup-health rollback (it can throw on a live pane's auth text).

| Outcome | Action | Result |
| --- | --- | --- |
| ctl ok, final `localPaneAlive` true | success; record removal (§ mu_list) | exit 0 |
| pane proven not running (absent, or exited and retained) | readiness rollback | `ReattachFailedError` exit 4, scrollback (mule's `not running` / `no master`), `next` = close preview |
| ctl `missing` (ENOENT) or `refused` (timeout) with the pane running | keep the row: the pane holds the job, only control is missing | exit 0, `ready:false`, `ctl` given |
| mux probe throws | keep the row; reconcile decides later | exit 0, `ready:false`, `ctl:"unknown"` |
| SIGINT/SIGTERM | keep the row | exit 130/143 |

**Readiness rollback** (the pane is proven not running, so it kills
nothing). Under the agent lock, in one immediate transaction:
1. `deleteAgent(name, ws, {incarnation: new, paneId: newPane}, {preserve:
   false})`. **False** means someone else already reaped or closed the new
   row: **restore nothing**, report `rollback:"already-handled"`. That state
   is consistent: a reap left the record and the reservation matching by the
   new agent id, and a close dealt with both.
2. `restoreRemoteRecovery(rec)` (new, `src/remote-recovery.ts`): an INSERT of
   every column. It throws if that `agent_id` exists.
3. Rebind the reservation back, compare-and-set on the new values. Zero
   changes throws.

A throw rolls the transaction back and leaves the new row for reconcile,
whose reap records the tree under the new incarnation, consistent by agent id
(`rollback:"left-for-reap"`). Restoring the old record verbatim keeps its
`aside` (`<cwd>.mu-removing-<old id>`) pointing where a crashed close parked
the tree.

On success, emit `agent.reattach` (new in `LogIntent`, `VERBS`,
`log-render.ts`) naming host, job and pane.

**Files** (est.): `src/agents/reattach.ts` (new, ~200: preflight ~70,
preview ~20, apply ~55, readiness and rollback ~55); `src/cli/agent-reattach.ts`
(new, ~30; 2 lines in `src/cli/agents.ts`, already over the 1500-LOC cap);
`src/carrier-jobs.ts` (~12); `src/remote-recovery.ts` (~12); `src/logs.ts`,
`src/log-render.ts`, `src/messages.ts` (~12); `src/cli/handle.ts` (two
classes → exit 4, ~3).

**Split seam if over 300:** preflight and preview move to
`src/agents/reattach-check.ts`, its own commit within the unit.

**Acceptance tests** (`test/lease-reattach.test.ts`, fast tier, `installMux`,
a fake carrier script that holds or exits 1). Real holding carriers go in
`test/lease-reattach.integration.test.ts`.
- **Happy path** (reaped `--worktree` lease agent): preview prints a rev;
  apply gives a row with the record's `cwd`, `base`, `collected_head`,
  `repo`; record gone; reservation rebound; ctl ok; event logged. A `--cwd`
  agent: tree fields NULL.
- **Preflight refusals**, each with nothing changed and the close preview in
  `next`: live row · torn-down ws · re-created ws (an old binding whose
  handle lands after a real teardown and reinit refuses; a reservation bound
  in the re-created ws is allowed) · NULL `workstream_id` · two reservations · no
  handle · a `reason` · unbound reservation · previous pane alive · pane
  probe throws · creator alive · a marker that is malformed or names a
  live or unrecorded pane (a stale one is cleared and the apply runs) · no `attach` · changed `stop` · session
  profile · record with another `workstream_id` · newer record on the path ·
  job file naming another handle · stale `--if`.
- **Readiness:** carrier exits at once → record restored byte for byte,
  reservation rebound to the old values, no stop ran · retained exited pane
  = dead · ctl `refused` and `missing` with a live pane → row kept,
  `ready:false` · handshake ok but pane gone at the final check → rollback.
- **Races:** new row reaped during readiness → `already-handled`, exactly one
  record (the new one) · install transaction fails → pane killed, the
  reservation names it, nothing else changed · the kill fails with the pane
  alive → `pane-unknown`, the next preflight refuses on the new pane · the
  fallback pointer also failing (writer lock, lost compare-and-set) or the
  process dying after the pane opens → the next reattach refuses on the
  marker, one carrier · the marker's exclusive create failing → no pane · the
  record's path taken (another workstream's agent on it, or a newer record of
  it) in the preflight's final await or during the pane creation → refused at
  install, the new pane killed, the record kept · the reservation replaced
  during the preview's probe → the preview describes the job its rev applies;
  replaced on every attempt → refused.
- **After a reattach:** a reap writes a NEW record under the new incarnation;
  `agent close` stops the job and closes the tree.

## G3 — mu_reap: reconcile stays host-command free; the reaper parks

Reconcile runs on every `agent list` and `mu state`, so it may not run host
commands and cannot know whether a lease job still runs. The reap stays,
because the pane is mu's truth. But v1's "an agent with no pane is not
working" is false for a lease: pane loss proves the carrier is gone, not the
job. Reopening to `OPEN/todo` puts the task in `ready` while the original pi
may still be writing.

**Decision: option (ii).** When the reaped row has a reservation bound to it
(`carrier_jobs.agent_id = row id`) that holds a `job`, `reapAgentRow` reopens
its IN_PROGRESS tasks as **`OPEN/parked`**. Per VOCABULARY, parked tasks leave
`ready`: the `ready` view excludes `parked`, and `claimTask` refuses one
without `--force`. So neither `mu next` nor a plain claim hands the task to
another worker.

The `[reaper]` note is the park reason:
`[reaper] previous owner <name> gone (pane died); its lease job <job> on <host> may still run, so the task is parked: resume with mu agent reattach <name> -w <ws> --task <id>, or mu agent close <name> -w <ws> then mu task unpark <id>`.

Option (i), a note only, still lets `mu next` dispatch a duplicate worker
over a running job: incident (b).

**Close is excluded.** `agent close` of a live lease row deletes the row
after it has stopped (or abandoned) the job, and before releasing the
reservation. It passes `ReapOptions.leaseSettled: true`, so its tasks reopen
as `todo`, as today. With `--abandon-job` the job may still run, but that
risk is the operator's explicit choice. Other deleters need no flag:
teardown hides its workstream, spawn rollback has claimed no tasks, and
`next`'s reap never reaps remote workers.

**`reattach --task <id>`** (repeatable) claims after readiness, only when
`ready` is true. Otherwise every claim is reported `skipped: ctl not ready`.
Each claim calls `claimTask({agentName, workstream, expectedAgentId:
newIncarnation, force: true, onlyOpen: true})`. `force` is there because the
reaper parked the task. `onlyOpen` is a new `ClaimTaskOptions` field, checked
inside the immediate transaction: `claimTask` alone accepts unowned CLOSED
tasks. `expectedAgentId` keeps a replacement that appears during readiness
from getting the task.

A refused claim is a warning (`claims: [{task, ok, error?}]`), exit 0: the
reattach succeeded. mu never guesses tasks; the reaper note names them.

**Files** (est.): `src/agents/reap.ts` (~20), `src/agents.ts` (pass the
option, ~3), `src/agents/close.ts` (1 argument), `src/tasks/claim.ts` (~6),
`src/agents/reattach.ts` + CLI (`--task`, ~30).

**Acceptance tests** (`test/reap-lease-park.test.ts`, `test/lease-reattach.test.ts`):
reconcile reaps a lease row with a handle → `OPEN/parked`, note names the
job, `mu next` and plain claims skip it · lease row without a handle, or a
session row → `OPEN/todo` · `agent close` of a live lease row → `todo` ·
`reattach --task` claims a parked task as the new incarnation · CLOSED task →
refused, exit 0 · task owned by another → warning · ctl not ready → skipped.

## G4 — mu_list: leftovers in `mu agent list`

`listLeftovers(db, ws)` in a new root file `src/leftovers.ts`. It reads the
DB and local files and runs one local mux probe per reservation through
`reattachBlockers`. It runs no host command.

```ts
interface Leftover {          // output keys follow SQL names (surface contract)
  kind: "lease-job" | "recovery";
  name: string;
  host: string;
  job: string | null;         // reservation handle (lease-job)
  agent_id: number | null;    // the reaped incarnation
  recovery_id: number | null; // the record folded in, or the record itself
  stop_failed: string | null; // the record line, escaped, ≤160 chars + " cut=<n>"
  next: string;               // one command, executable as printed
}
```

- **`lease-job`:** each reservation in ws whose agent is gone. This is the
  `leaseJobHints` filter, moved here; doctor imports it. One leftover per
  reservation, legacy ordinals included. A record is **folded in by agent
  id**: `record.agent_id == reservation.agent_id`. That is one-to-one,
  because `agent_id` is the record's key. Name and host never fold.
- **`recovery`:** every record in ws not folded into a lease-job.
- **`next`** is always a read-only **preview**; it prints the rev its apply
  needs:
  - **Lease-job, preflight clear:** `mu agent reattach <name> -w <ws>`.
  - **Lease-job, any blocker** (a missing handle, a live previous pane, an
    ambiguous reservation, a job file conflict, and the rest):
    `mu agent close <name> -w <ws>`. When the name has more than one record,
    add `--recovery <id>` naming the folded record; with none folded, the
    bare preview lists the candidates.
  - **Recovery:** `mu agent close <name> -w <ws> --recovery <id>`, always
    with `--recovery`, because a bare close would address a live agent of
    the same name. mu never guesses `collect`. Whether close refuses depends
    on remote state: a clean tree at base, a HEAD already in a root ref, or a
    gone tree all close without collection. The close apply enforces the rule
    and names collect when it is needed.
  - A job that already ended (dev0) is unknowable here: the reattach apply
    rolls back with `not running` and names the close preview.
- **`stop_failed`:** read from `<job_file>.<job>.stop-failed`, only for a
  lease-job with a handle, and shown only when the line starts with
  `<job> `. A record whose name or content belongs to another id is never
  shown. The cut keeps a record under 400 chars: ` cut=<n> full: mu doctor`,
  `cut=<n>` alone with no room, or null when even that passes 400. The cap
  bounds stop_failed; identity and next are never cut. At mu's limits (32-char
  name, host and workstream, a 128-char handle, `close --recovery <id>`)
  identity and next alone pass 400 from id 100. The full line is in that
  file, whose path doctor's `lease-job` hint prints.
- **Output:** the envelope is unchanged: `{ok,data,next}` with
  `data.{workstreamName,agents,orphans}` (legacy camelCase, pinned). The list
  adds `data.leftovers`, always present (`[]` when empty), for bare `list`
  and `--json`. A per-item `next` is data, like doctor's `close` field. The
  envelope `next` (`computeNext`) is unchanged, because reads are never
  hinted. `--table` prints `Leftovers (n)` after Orphan panes (dim note: "work
  of agents whose rows are gone"), then one escaped line each:
  `  <name>  <kind> on <host>[ job=<h>][ recovery=<id>][ stop failed: <text>]  → <next>`.
  The renderer lives in `src/leftovers.ts`, and `cmdList` gains ~6 lines.
  `docs/reference/surface-contract.md` gets one Output line: a list record
  may carry a per-item `next` string, which is data, not a `NextPlan`.
- **`mu state`:** not mirrored; doctor's `lease-job` line prints record path
  and `next`.
- **Record lifecycle (mu side).** mu removes `<job_file>.<job>.stop-failed`
  only for a handle it has just proven stopped or reattached. The path names
  the handle, so mu never touches another job's record, and the removal does
  not depend on the job file existing. The three removal points are: a
  stopped `stopLeaseReservation` result, before `cleanLeaseJobFile`'s early
  return; `rollbackLeaseJob`'s stop-success path; and a successful reattach
  (`ready` true). `abandonCarrierJob` leaves the record, which stays true. A
  stale child's late write lands under its own id's path, shown only for a
  reservation that holds that handle; a late delete removes only that path.
  `claimLeaseJobFile` moves only the job file.

**Files** (est.): `src/leftovers.ts` (new, ~120: listing ~55, fold ~10,
next ~20, record read ~15, table ~20), `src/cli/agents.ts` (~6),
`src/doctor-summary.ts` (−20 +8), `src/agents/lease-carrier.ts` (~12),
`docs/reference/surface-contract.md`.

**Acceptance tests** (`test/leftovers.test.ts`, `test/agent-output.test.ts` pins):
reaped lease `--worktree` agent → one lease-job, `recovery_id` = its
`agent_id`, `next` = reattach preview · close preview when a blocker holds
(no `attach`, live previous pane, two reservations, conflicting job file) ·
legacy two-reservation name with one record folds it into the matching
`agent_id` only · another incarnation's record stays separate, with
`--recovery` · bare recovery, also with a live agent of the name → `close …
--recovery <id>` · record → `stop_failed` escaped and cut with `cut=` · a
record of another id (by path, or by content) → not shown, file kept · late
write by an old child after name reuse → not shown for the new reservation;
late delete → own path only · stop removes the record with no job file;
rollback's stop removes it; abandon keeps it · live agent's reservation and
other workstreams not listed · bare `list` and `--json` carry
`data.leftovers` · no host command (an exec stub that throws).

## G1 interaction

G1 makes a row-less `agent close` release a stopped reservation before the
tree close, so reattach's preflight 3 then refuses (the job is gone), and
parked tasks stay parked with the note saying to unpark. G1 owns
`src/agents/close.ts`; `mu_reap` adds one argument there (`leaseSettled`),
and nobody changes its order.

## Docs

- `docs/VOCABULARY.md`: add **reattach** ("open a new carrier pane for a
  reaped lease agent's still-running job; not the removed `agent adopt`,
  which registered any pane"), **leftover** ("a reservation with no agent
  row, or a remote recovery record; not an **orphan**, which is a pane"),
  **stop-failure record** (`<job_file>.<job>.stop-failed`). Amend **host
  template** (`attach`), **reservation** (reattach rebinds it), **park** (the
  reaper parks a lease agent's tasks).
- `docs/guide/remote.md` § Session-capped hosts: the `--attach` starter line;
  "a reaped lease agent whose job still runs: `agent list` shows a leftover;
  `agent reattach`, then `--if`"; reattach is pi-only.
- `docs/guide/recovery.md` § An agent's pane died: leftovers, `next`, parked
  tasks.
- `skills/mu/recipes/remote-workers.md`, one line: "A reaped lease worker is
  a leftover in `agent list`, and its tasks are parked: run its `next`
  (reattach, `--task` to hand the work back; else close, then unpark)."
- `docs/ARCHITECTURE.md`: rows for `src/leftovers.ts`, `src/agents/reattach.ts`.
- `CHANGELOG.md` [Unreleased]: `### Added` `agent reattach`, `host add
  --attach`, leftovers in `agent list`; `### Changed` the reaper parks a
  still-reserved lease agent's tasks.
- mule `CHANGELOG.md`: `### Added` `rm --retry-for/--fence-gen/--failed-file`,
  `run --lease --attach`; `### Changed` signal-path stops retry for up to
  10 min, fenced against attach.

## Out of scope

- A host probe in reconcile or `agent list`; cancelling an in-flight ssh, or
  a hard wall-clock bound on the stop child.
- Reattaching a `session` agent (its pi died with the ssh), across machines
  (`carrier_jobs` is machine-local), or a non-pi agent with ctl.
- A `host update` verb, and leftovers in `mu state` or the dashboard.
- Auto-unparking tasks when a close stops the job.

## Review (2026-11-04)

Refutations: `delegate_refute-spec-{mule,reattach,list}` (workstream `scratch`,
all REFUTED). **24 accepted, 0 rejected.** Three accepted items replace the
orchestrator's direction (A, B, F in part), each for a flaw stated inline.

| Item | Decision | Where |
| --- | --- | --- |
| mule 1 | Accepted; replaces B. The record path carries the id and the line starts with it. Under B (one path per name) an old child could overwrite a newer job's record and hide it. Late write and late delete tests. | Contract 2, mule_stop, mu_list |
| mule 2 | Accepted; replaces A. A generation fence under flock. A cancel marker either re-arms a sleeping child once removed, or disarms the next stop when left. | mule_stop, mule_attach 2–5 |
| mule 3 | Accepted (C). Soft monotonic deadline, sleeps clamped, the record may be late or absent; "never blocks" and "within seconds" removed; blocked-attempt test. | mule_stop, Contract 1 |
| mule 4 | Accepted. Publish with link() and no replacement; refuse empty, invalid or unreadable; `named` set under the signal mutex. | mule_attach 4–5 |
| mule 5 | Accepted. Repair prerequisites documented; three L3 cases verify traffic. | mule_attach |
| mule 6 | Accepted. UTF-8-safe 512-byte cut keeps the id; L3 corrected; SPEC § Exit 3, § supervisor and § rm amended. | mule_stop |
| reattach 1 | Accepted. Recovery = `getRemoteRecovery(reservation.agentId)`, `--recovery` dropped, `repo` from `host_repo`, ws, name, host and `workstream_id` must match. | mu_adopt preflight 7 |
| reattach 2 | Accepted (E). Pi-only by definition; no cli stored; row defaults listed. | mu_adopt |
| reattach 3 | Accepted. Previous pane proven not running (a throw counts as unknown); creator pid proven gone. | preflight 5 |
| reattach 4 | Accepted. Torn-down and re-created workstreams refused before effects; install rechecks atomically. | preflight 2, apply 3 |
| reattach 5 | Accepted. Rollback compares and sets on the new incarnation; `already-handled` restores nothing; a failed transaction is left for reap (consistent by agent id). | Readiness rollback |
| reattach 6 | Accepted. Readiness matrix (missing, refused, probe throw, signal, final check, retained exited pane); no startup-health rollback; an install failure kills the pane on purpose. | mu_adopt |
| reattach 7 | Accepted. Bare = preview with `agentRevision`; `--if` before pane effects. | mu_adopt |
| reattach 8 | Accepted. `expectedAgentId` plus `onlyOpen` inside the claim transaction; claims only when ready; exit 0 with warnings. | mu_reap |
| reattach 9 | Accepted. The mule fence (mule 2); mu needs nothing. | Contract 4 |
| reattach 10 | Accepted. Per-file budget, split seam, race tests, integration tier for real carriers. | Units, mu_adopt |
| list 1 | Accepted. Same fence as mule 2, with an L3 ordering test. | mule_attach |
| list 2 | Accepted (D ii). Reconcile stays host-free; the reaper parks a reserved lease row's tasks; close is excluded. | mu_reap |
| list 3 | Accepted (F). Shared `reattachBlockers`; any blocker gives the close preview, with `--recovery` when ambiguous. | mu_list |
| list 4 | Accepted. Fold by `agent_id`, one to one; legacy-ordinal fixtures. | mu_list |
| list 5 | Accepted; refines F. A recovery's `next` always carries `--recovery`, because a bare close would address a live agent of the same name. Collect heuristic removed. | mu_list |
| list 6 | Accepted. Removal does not depend on the job file; rollback path covered; the id path makes late writes and deletes harmless; no move needed. | mu_list lifecycle |
| list 7 | Accepted (G). Envelope pinned; `data.leftovers` in bare and `--json`; SQL-name keys; escaped and cut under 400 chars; surface-contract line; `agent-output` pins. | mu_list |
| list 8 | Accepted (H). `ADDED_COLUMNS` with no bump (v13 precedents); one AGENTS.md clause; fresh, populated and second-open tests; host-check step; `mu_profile` split out. | mu_profile |
