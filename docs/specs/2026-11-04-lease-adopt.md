# Reattaching a reaped lease agent, leftovers, and visible stop failures

Status: proposed
Date: 2026-11-04
Builds on: [2026-10-28-lease-transport.md](2026-10-28-lease-transport.md) (mu) and
mule `docs/specs/2026-10-28-mu-lease.md`
Evidence: the 2026-11-04 aiv-blog incident (cite it in every commit)

## Problem

A restart of the local tmux server sent SIGHUP to six lease panes (`mule run
--lease`). Each carrier's signal path spawned a detached `mule rm <id>`
(mule `src/lease.rs` `on_signal`, `src/cleanup.rs` `spawn_rm`).

- On dev0 the master was up, so `rm` worked and the jobs were removed.
- On dev1 the master was down. `rm` failed in `require_master`
  (`src/jobs.rs` `remove`), and nobody saw it because the child's stdio is
  `/dev/null`. The jobs kept running.

mu's reconcile then reaped all six rows: their tasks went back to OPEN, a
`remote_recovery` record was written for each, and the `carrier_jobs`
reservations were kept. After that:

- the dev1 agents were alive with no agent row, and mu had no way to reattach
  to them;
- `mu agent list` printed `"orphans": []`, so none of these leftovers were
  visible.

This spec covers G2 (mule: a failed signal-path stop is retried, then
recorded), G3 (`mu agent reattach` plus mule's attach mode) and G4 (leftovers
in `mu agent list`). G1 (release a stopped reservation that has no agent row
before closing the tree) ships separately. It interacts only as § G1 notes.

## Name: `agent reattach`, not `agent adopt`

`agent.adopt` in `src/logs.ts` / `src/log-render.ts` is left over from the
removed `mu agent adopt <pane-id>` (pre-3 and 4.0-dev changelogs; it was cut
in 4.0 as `src/agents/adopt.ts` with 0 real uses). That verb **registered an
arbitrary existing pane** as a managed agent. The new verb is narrower: it
opens a **new** carrier pane for a job mu already holds a reservation for. If
we reused "adopt", an old `agent adopt` line in `mu log` would claim a meaning
the new verb lacks. So the verb is **`mu agent reattach`** and its intent is
`agent.reattach`. `agent.adopt` stays in the renderer only so that old ops
rows still render. Nothing emits it.

## Units

| Unit | Repo | Owns | Depends on |
| --- | --- | --- | --- |
| `mule_stop` | mule | G2: retrying `rm`, and the stop-failure record | — |
| `mule_attach` | mule | `run --lease --attach <id>` | — |
| `mu_list` | mu | G4: leftovers in `agent list`; the `--attach` profile template (schema, validation, starter, show); the `.stop-failed` file read and its cleanup | contract below |
| `mu_adopt` | mu | G3: `mu agent reattach` | `mu_list` (column + template) |

The `--attach` template goes to **`mu_list`, not `mu_adopt`**. `mu_list`
already needs it to decide whether `next` says reattach or close, and
`mu_adopt` would exceed 300 LOC with it. Every mu unit stays under 300 LOC
of src.

## The cross-repo contract (both sides implement exactly this)

1. **Attach command shape.** It is written in the user's host template; mu
   never names mule.
   `mule run --host H --lease --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}`.
   - It exits non-zero within seconds, with nothing touched, when the job is
     not running (exit 1) or there is no master (exit 3).
   - Otherwise it holds exactly like a lease, and SIGHUP stops the job.
2. **Stop-failure record.** When a lease's signal-path stop gives up, the
   carrier writes `<job_file>.stop-failed`. The file sits beside the job file,
   in the directory mu owns. It holds one line of UTF-8 text, at most 512
   bytes, and is written atomically with mode 0600. mu treats the line as
   opaque: it shows the first line, cut to 200 chars, and parses nothing.
   A carrier that never writes the file is still a valid carrier.
3. The job file stays as it was: one line holding the handle. Attach writes
   it if it is missing, keeps it if it already names the same id, and refuses
   (exit 1) if it names another id.

## G2 — mule_stop: a signal-path stop that fails is retried, then recorded

**Decision.** The detached child runs
`mule --quiet [--config C] rm --host H <id> --retry-for 600 --failed-file <F>.stop-failed`.
The lease's `RealSignalSteps::spawn_stop` passes both flags. `exec`'s
signal path (`src/exec.rs`) passes only `--retry-for 600`, because exec has
no job file.

New `rm` flags (`src/cli.rs` `Commands::Rm`). Both conflict with `--all`:

- `--retry-for <SECS>`: retry until this much wall time has passed. Without
  it there is one attempt, as today.
- `--failed-file <PATH>`: on giving up, write the record there. On success,
  remove a stale record at that path (best effort).

The retry loop goes in a new `jobs::remove_with_retry(t, host, id, policy,
clock)`. It is pure over `Transport`, plus an injected sleep/clock so layer 1
can drive it.

- **Master down** (`!t.master_alive(host)`): do not attempt the `rm`. Check
  again every **5 s**. `-O check` is lock-free and opens no session, which is
  the same cadence as `hold()`. This is not "retrying a hand-back": the child
  never opens a master and never prompts. It waits for the human that the
  carrier's pane already asked, and that pane is now dead.
- **Master up:** run `remove(Target::One)`. Exit 0 or "nothing to remove":
  done (exit 0; remove a stale `--failed-file`). Any other error: keep its
  first line as `last_reason` and back off 5 s → 10 → 20 → 30 s, capped at
  30 s.
- **Bound:** 600 s. The child never blocks forever. The deadline is checked
  between attempts. An attempt that is already running can overrun it by the
  transport's own bounds: `REFUSAL_RECOVERY` 12 s, plus the ticket queue,
  whose holders are sub-second and whose dead waiters are skipped by pid.
  UNSURE: the ticket wait has no bound of its own. We accept that, as SPEC §
  Use a retrying mutex already does.
- **Giving up:** write the record with the same atomic writer as the job file
  (`lease.rs` `write_job_file`, generalised to `write_line_file(path, line)`:
  O_EXCL|O_NOFOLLOW temp file, fchmod 0600, fsync, rename, fsync the
  directory). The line is
  `job <id> on <host> not stopped: <last_reason> (gave up after <n> attempts, <secs>s; at unix <t>)`.
  If the master was never seen, `last_reason` is `no control master`. The
  child exits with the last attempt's code (3 when no master, else 1).
  Nobody reads that code: stdio is `/dev/null` and the parent has exited.

Exit codes and the meaning of exit 0 for `rm` are unchanged, as is the
`rm --all` behaviour.

**Files:** `src/jobs.rs` (`remove_with_retry`), `src/cli.rs` (flags),
`src/cleanup.rs` (`rm_command` takes an optional retry and failed-file and
passes them), `src/lease.rs` (`spawn_stop` passes `<F>.stop-failed`; the
writer is generalised), `src/exec.rs` (retry only), `docs/usage.md` (§
Listing and cleanup, the § run --lease signal bullet), `SPEC.md` (§ Detached
cleanup: bounded retry, record), `CHANGELOG.md`.

**Acceptance tests:**
- L1 (`Fake`, injected clock):
  - no master ×3, then master → one `rm` script, exit 0, no record;
  - no master throughout → zero `rm` scripts, record says `no control
    master`, exit 3, and the elapsed virtual time is ≤ bound + one interval;
  - `rm` fails ×2 then succeeds → backoff 5 and 10 s, exit 0;
  - `rm` always fails → record holds the first stderr line, exit 1;
  - success removes a pre-existing record;
  - `rm_command` argv carries `--retry-for 600 --failed-file F.stop-failed`
    for the lease, and only `--retry-for` for exec.
- L3 (local sshd): stop the master, TERM a lease, run `rm --retry-for 2
  --failed-file …` directly → the record appears and the job is still in
  `mule ls`. Restart the master within the bound → the job is gone and there
  is no record.

## G3 — mule_attach: `mule run --lease --attach <ID>`

**CLI.** Add `--attach <ID>` to `Commands::Run`.
- It requires `lease` and `job_file`, and conflicts with `cwd`, `max_secs`
  and `human`.
- `cmd` becomes `required_unless_present = "attach"` and conflicts with
  `attach`.
- The id parses as `JobId`, so it is validated at the boundary.

This is a flag rather than a separate verb because it is the same process
(`hold()`, the signals, the forwards) minus `start()`.

**Behaviour** (`src/lease.rs`: a new `attach_cli`, sharing the signal wiring
that `run_cli` has today):
1. `require_master`, or exit 3. Nothing is written.
2. One locked probe (`probe(…, From::StateOnly)`):
   - `Running` → go on;
   - `Done(n)`, `Orphan` or `Missing` → print `mule: job <id> is not running
     (<state>)` and exit 1. The job file is not written.
   - A probe error → exit 1, with its message.
3. Job file:
   - missing → `write_job_file`;
   - holds the same id → keep it;
   - holds another id, or cannot be read → exit 1 and never overwrite it.
     The file is the only pointer to some job.
4. Set `named = Some(id)` only now. A signal before this point stops nothing:
   the job was not this process's to stop. A signal after it goes through
   `on_signal`, as for a lease, including G2's retry and record.
5. `hold()` unchanged. The first forward replaces a stale listener left by
   the dead carrier, and the status line and mirror are the same.

There is no dispatch and no `on_dispatch` bracket (`dispatching` stays
false). Exit codes are the lease's: the job's code, 1 missing, 5 orphan, 129,
130 or 143 after a signal. Exit 3 happens only at step 1.

**Files:** `src/cli.rs`, `src/lease.rs`, `docs/usage.md` (a new § Reattaching
to a running job), `SPEC.md` (§ Leases: attach, which is not a re-dispatch),
`CHANGELOG.md`.

**Acceptance tests:**
- L1:
  - Running → hold entered and the job file written;
  - Done, Missing and Orphan → exit 1, zero `rm`, no job file;
  - a job file naming another id → exit 1 and the file unchanged;
  - the same id → kept;
  - a signal after hold → `spawn_stop` with the id;
  - clap: `--attach` without `--lease` or `--job-file` refused; with a
    command refused; without a command accepted.
- L3: start a lease, `kill -9` it (the job keeps running), attach → the
  forward is rebound (`connect` works), TERM → the job is stopped.

## G3 — mu side: the `--attach` template (unit `mu_list`)

- `host add --attach <template>`. It is lease only (refused for `session`)
  and optional. Stored in `host_profiles.attach TEXT` through `ADDED_COLUMNS`
  and mirrored in `CURRENT_SCHEMA` (`src/db.ts`). This is v13, with no
  version bump: the column is plain nullable.
- `src/hosts.ts`:
  - a new scope `attach` in `TEMPLATE_SCOPES` takes `job`, `job_file`,
    `local_sock`, `remote_sock` and `cwd`, where `cwd` is always `.`;
  - `{env}` and `{cmd}` are refused there, because nothing is dispatched;
  - `profileTemplateProblem` requires `{job}` and `{job_file}` exactly once,
    and `{local_sock}` and `{remote_sock}` at least once;
  - `HostProfile.attach: string | null`, plus the `addHost` checks.
- `hostMuleStarter` gains
  `attach: 'mule run --host <h> --lease --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}'`.
  `host init --mule` prints it, and `host show` / `list` print it.
  `host check` expands it with a dummy handle and does not run it, like stop.
- There is no `host update`. To add the template, run `host rm` then
  `host add`: a lease pane holds no channel, so `rm` is allowed. A byte-equal
  `--stop` keeps every reservation stoppable.
- Tests: `test/host-lease-profile.test.ts` (scope refusals, required
  placeholders, session refuses `--attach`), `test/db.test.ts` (the column is
  added to a populated v13 fixture), `test/host-check-lease.test.ts` (attach
  expanded).

## G3 — mu_adopt: `mu agent reattach <name> -w <ws> [--task <id>…] [--recovery <id>] [--cwd <remote path>]`

**Preconditions.** They are checked before any effect, then again under the
agent lock. Each one refuses with exit 4 and names the way out.
1. No agent row of the name (else `AgentExistsError`).
2. Exactly one reservation of (ws, name) with `job` not null, `launch =
   'intent'` and `reason` null. If it holds no handle, or was kept by a failed
   spawn (`reason` / `tree_path` set): refuse with `mu agent close <name>`.
3. The reservation's host profile exists, is `lease`, has an `attach`, and
   its `stop` is byte-identical to `host_stop`. That last check is the
   identity proof `runStop` already uses: same machine, same tool.
4. The tree, from `recoveriesFor(ws, name)` on that host:
   - **One record:** the new row takes its `cwd`, `base`, `collected_head`
     and `repo`. `assertRecoveryUsable` must pass (no live agent on that path
     and no newer record), and so must `assertRecoveryProfile`.
   - **Several:** `--recovery <id>` picks one; without it, refuse
     (ambiguous).
   - **None** (a `--cwd` lease agent writes no record, since the trigger
     needs `base`): the row's `cwd` is `--cwd` if it was given, else NULL;
     `base` and `repo` are NULL. A close of such a row runs no tree rule,
     which is correct, because there is no tree.
5. The local job file: missing, or naming `job`. Anything else refuses with
   `describeRead`.
6. `(await activeMux()).runsShellCommand`, as in `requireHostSpawn`.

**Steps.** Agent lock (strict), then the session's spawn lock, as spawn does:
1. Re-check 1–5. `rmSync` the stale ctl socket.
2. Fill the attach template: `{job}` = handle,
   `{job_file}` = `leaseJobFile`, `{local_sock}` = `ctlSocketPath`,
   `{remote_sock}` = `remoteCtlSocketPath`. Wrap it the way
   `remoteShellCommand` does (`exec env -u … /bin/sh -c`). Factor out a
   shared `wrapLocal(filled)` in `src/remote-agent.ts`.
3. `mux.spawnAgent` (window = name), up to `onPaneCreated`.
4. **One transaction:**
   - `insertAgent`, passing the reservation token so it gets through the
     name fence, with `host` and `host_transport='lease'`, the tree fields
     from step 4, the reservation's `cli` (`pi`; there is no other lease
     CLI) and the pane id.
   - `rebindCarrierJobAgent(token, job, oldAgentId, oldPaneId, newId,
     newPane)` (new, `src/carrier-jobs.ts`): an UPDATE that compares and sets
     on the values read (`agent_id IS ? AND pane_id IS ? AND job = ?`).
     `bindCarrierJobAgent` refuses a stale `agent_id` on purpose, so this is
     a separate statement that names the old values.
   - `deleteRemoteRecovery(rec)` (compare and set). The tree is owned by a
     row again, and a later reap writes a fresh record under the new
     incarnation through the trigger.
   The locks exclude every other writer of these rows (close, collect and
   spawn all take the agent lock), so a failure here is a bug. Kill the pane
   and say the job may have been stopped.
5. Release the locks, then wait for readiness as spawn does:
   - pi with ctl: `awaitCtlHandshake(sock, assertPaneAlive)`;
   - otherwise: `awaitSpawnLiveness`.

**Rollback** happens only when **the pane died during readiness**: the job is
not running, the master is gone, or the job file did not match. The carrier
already exited, so there is no SIGHUP and nothing is stopped. Under the agent
lock, in one transaction:
- delete the new row with `{preserve: false}` (no record for the new
  incarnation);
- re-insert the original recovery record verbatim (new
  `restoreRemoteRecovery(rec)` in `src/remote-recovery.ts`: the same
  `agent_id` and every column);
- rebind the reservation back to its old `agent_id` and `pane_id` (compare
  and set on the new values).

Reservation and recovery end exactly as before. The error carries the pane's
scrollback, which shows mule's `not running` / `no master` line, plus `next:
mu agent close <name>`. **A ctl timeout with a live pane is not a rollback**,
as for spawn: the job is held, and only control is missing. mu never kills
the pane on rollback, because a live attach pane that is killed would stop
the job.

**Tasks.** `--task <id>` is repeatable. After readiness, each one is claimed
with `claimTask({agentName: name, workstream})`. mu never guesses which
tasks. A claim that is refused (the task is owned now, or not OPEN) is a
warning in the result (`claims: [{task, ok, error?}]`), and exit stays 0:
the reattach itself succeeded. UNSURE: exit 0 versus 4 on a refused claim.
Without `--task`, the output lists the OPEN tasks of the workstream whose
latest `[reaper]` note names this agent, as a hint (`pass --task <id>`).
They are never claimed.

**Not included:**
- **No preview and no `--if`.** Reattach destroys nothing. Every input is
  re-checked under the lock, and a rollback restores the exact rows.
- **No send.**
- **No aside check.** A parked aside exists only if a close crashed after it
  stopped the job, so attach then finds the job not running and rolls back.

On success, emit an `agent.reattach` event (new in `LogIntent`, `VERBS` and
the prose case in `src/log-render.ts`) naming the host, job and pane. Remove
`<job_file>.stop-failed` once the agent is ready.

**Files:**
- `src/agents/reattach.ts` (new, about 200 LOC);
- `src/cli/agent-reattach.ts` (new; `src/cli/agents.ts` is over the
  1500-LOC cap already), wired from `src/cli/agents.ts`;
- `src/carrier-jobs.ts` (rebind), `src/remote-recovery.ts` (restore),
  `src/remote-agent.ts` (`wrapLocal`);
- `src/logs.ts`, `src/log-render.ts`, `src/messages.ts`;
- the `src/cli/handle.ts` mapping for the new refusal class (exit 4).

**Acceptance tests** (`test/lease-reattach.test.ts`; fast tier,
`installMux`, a fake carrier script that holds, or exits 1 on a "not running"
flag, per `test/lease-spawn.test.ts`):
- reap a `--worktree` lease agent, then reattach:
  - the new row carries the recovery's `cwd`, `base` and `collected_head`;
  - the record is gone;
  - the reservation's `agent_id` and `pane_id` are the new ones;
  - the ctl handshake is ok;
  - the event is logged.
- `--cwd` lease agent (no record): the row's `cwd` is NULL, or `--cwd`.
- The carrier exits at once: the row is gone, the original record is
  restored byte for byte, the reservation is rebound to the old values, and
  no stop ran.
- A ctl timeout with a live pane: the row is kept and ctl is `missing`.
- Refusals, each with nothing changed:
  - a live row;
  - a reservation with no handle;
  - a reservation with a `reason`;
  - a changed `stop`;
  - a profile with no `attach`;
  - two records without `--recovery`;
  - a job file naming another handle;
  - a session profile.
- `--task`: a reopened task is claimed by the new incarnation; a task now
  owned by someone else gives a warning and exit 0.
- After a reattach, a reap writes a NEW record under the new incarnation,
  and `agent close` stops the job and closes the tree.

## G3 — reconcile: no reap guard

**Decision: no change to `src/reconcile.ts`.** It runs on every `mu agent
list` and `mu state`, which may not run host commands, and only a host
command can tell whether a job is still alive. The pane is mu's truth ("pane
death is agent death"). The reap stays, its record and reservation keep
everything needed to recover, and `agent reattach` is the recovery. The
reaper reopening tasks is still correct: an agent with no pane is not
working, and `--task` hands the work back on purpose.

## G4 — mu_list: leftovers in `mu agent list`

`listLeftovers(db, ws)` lives in a new root file, `src/leftovers.ts`. It
reads the DB and local files only, and runs no host command.

```ts
interface Leftover {
  kind: "lease-job" | "recovery";
  name: string;
  host: string;
  job: string | null;          // the handle (lease-job), else null
  recoveryId: number | null;   // the record of the same name + host, if exactly one
  stopFailed: string | null;   // first line of <job_file>.stop-failed, ≤200 chars
  next: string;                // one command
}
```

- **`lease-job`:** each reservation in ws whose agent is gone, with the same
  filter as `leaseJobHints` in `src/doctor-summary.ts`. Move that filter into
  `leftovers.ts` and have doctor import it. A single matching recovery
  record (same name and host) is folded in as `recoveryId`.
- **`recovery`:** every record in ws that was not folded into a `lease-job`.
- **`next`:**
  - lease-job: `mu agent reattach <name> -w <ws>` when there is a handle,
    `launch='intent'`, `reason` is null, and the profile is lease with an
    `attach` and a byte-equal `stop`. Otherwise `mu agent close <name> -w
    <ws>`.
  - recovery: `mu agent collect <name> -w <ws> --recovery <id>` when
    `collected_head` is null, else `mu agent close <name> -w <ws> --recovery
    <id>`. That close refuses an uncollected HEAD and names collect, so the
    heuristic is safe.
  - The list cannot know that a job already ended (the dev0 case). There, a
    reattach rolls back with `not running`, and its error names close.
- **JSON:** `agent list --json` adds `leftovers: Leftover[]`, always present
  and `[]` when there are none. The change is additive.
- **Table:** after Orphan panes, `Leftovers (n)` with the dim note "work of
  agents whose rows are gone", then one line each:
  `  <name>  <kind> on <host>[ job=<h>][ recovery=<id>][ stop failed: <line>]  → <next>`.
- **`mu state`:** not mirrored. Keep it minimal; doctor already has the
  `lease-job` hint, and its line now prints `next`.
- **`.stop-failed` lifecycle:**
  - `cleanLeaseJobFile` removes it after a successful stop;
  - `claimLeaseJobFile` moves it aside with the job file;
  - reattach removes it on success (mu_adopt);
  - `abandonCarrierJob` leaves it in place.

**Files:** `src/leftovers.ts` (new), `src/cli/agents.ts` (`cmdList`, a few
lines), `src/doctor-summary.ts`, `src/agents/lease-carrier.ts` (cleanup),
and the template work above.

**Acceptance tests** (`test/leftovers.test.ts`, mocked mux):
- a reaped lease `--worktree` agent → one `lease-job` with its `recoveryId`;
  `next` is reattach when the profile has `attach`, close when not;
- a `.stop-failed` file → `stopFailed` holds its first line, cut to 200;
- a bare recovery → `collect`, and `close` once `collected_head` is set;
- a live agent's reservation is not listed;
- another workstream's leftovers are not listed;
- `cmdList --json` always carries `leftovers`;
- the listing runs no host command (an exec stub that throws);
- cleanup: close removes the record, and spawn moves it aside.

## G1 interaction

G1 makes `agent close <name>` with no row release a stopped reservation
before the tree close. A close that stopped the job therefore leaves no
reservation, and reattach (precondition 2) correctly refuses: the job is
gone. G1 changes `src/agents/close.ts`, and these units change neither it nor
its order.

## Docs

- `docs/VOCABULARY.md`: add **reattach** ("open a new carrier pane for a
  reaped lease agent's still-running job; not the removed `agent adopt`,
  which registered any pane"), **leftover** ("a reservation with no agent
  row, or a remote recovery record; not an **orphan**, which is a pane"),
  and **stop-failure record**. Amend **host template** (`attach`) and
  **reservation** (reattach rebinds it).
- `docs/guide/remote.md` § Session-capped hosts: the `--attach` line in the
  starter, and a bullet for "a reaped lease agent whose job still runs:
  `agent list` shows a leftover; `agent reattach`".
- `docs/guide/recovery.md` § An agent's pane died: one bullet on leftovers
  and their `next`.
- `skills/mu/recipes/remote-workers.md`: one line. "A reaped lease worker
  is a leftover in `agent list`: run its `next` (reattach if its job still
  runs, `--task` to hand its work back)."
- `docs/ARCHITECTURE.md`: rows for `src/leftovers.ts` and
  `src/agents/reattach.ts`.
- `CHANGELOG.md` [Unreleased] `### Added`: `agent reattach`, `host add
  --attach`, and leftovers in `agent list`.
- mule `CHANGELOG.md` `### Added`: `rm --retry-for/--failed-file`, `run
  --lease --attach`. `### Changed`: the lease and exec signal-path stop
  retries for up to 10 min.

## Out of scope

- A reap guard in reconcile (see above).
- Reattaching a `session` agent: its remote pi died with the ssh.
- Reattaching across machines: `carrier_jobs` is machine-local.
- A `host update` verb.
- Showing leftovers in `mu state` or the dashboard.
