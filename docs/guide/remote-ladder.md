# Where a worker runs: the ladder

An agent has four **places**: the **loop** (the harness process, with its
model calls, credentials and control socket), the **workspace** (the
worktree), the **shell** (where bash, git and make run) and the **DB** (the
`mu.db` holding its row, tasks and recovery). **Local** means the DB's
machine. Placement is per agent: one workstream can mix placements, as long
as every pane lives on one multiplexer.

A **rung** names one combination of the four places. The numbers are names,
not a ranking.

| Rung | What it is | Loop, workspace, shell | Status |
| --- | --- | --- | --- |
| 0 | a local worker | all local | shipped |
| 1 | `mu host exec`: one command, no agent | shell on the host | shipped |
| 2 | local pi loop, remote workspace and shell | split | shipped; needs mule >= 0.7.0 and its pi extension |
| 3 | a session pane (`--transport session`) | all on the host | shipped |
| 4 | a lease (`--transport lease`) | all on the host | shipped, pi only |
| 5 | a provider host | all on the host | core shipped |

## Capability matrix

| Rung | tmux | Rex | herdr | One session per connection |
| --- | --- | --- | --- | --- |
| 0 | pi `ctl`, hook harnesses (claude, codex, cursor-agent, muse) `hooks`, others `mux` | pi `ctl`, others `mux` | pi `ctl`, others `mux` | n/a |
| 1 | runs (no pane) | runs | runs | fine over a link that serialises itself |
| 2 | pi `ctl` local | pi `ctl` local | refused | mule controls admission |
| 3 | pi `ctl` forwarded, hook harnesses remote `hooks` | session template: pi `ctl`, others `mux`; ssh plugin pane: refused | refused | fine: each pane opens its own connection |
| 4 | pi `ctl` via the carrier | refused | refused | fine: one master |
| 5 | the plugin's own channel if it declares one, else the built-in `ctl`/`hooks`/`mux` its inputs support (an `at-start` kind must declare one) | refused | refused | the provider's |
| command gate | `mux` | `mux` | refused | as rung 3; lease profiles run no gates |

- Remote `hooks` needs a backend that anchors and pastes: tmux only.
  Elsewhere a non-pi worker is on `mux`; tmux has no `mux` send and refuses.
- A lease carrier forwards no stdin, so a non-pi worker has no input path on
  a lease: use pi.
- Rex supports rung 3 session templates only: an ssh-plugin pane is a
  plugin job view, so Rex refuses it like rungs 4 and 5.

## Reach for what

| Situation | Reach for |
| --- | --- |
| One build or test on a host, no agent | rung 1, [`mu host exec`](#rung-1-mu-host-exec) |
| The host runs the loop and takes a new connection per pane | rung 3 |
| Only one connection is practical (a prompted master) | rung 4 for a crew; rung 1 for single commands |
| The host cannot run the loop (no credentials, no model API) | [rung 2](#rung-2-local-pi-with-a-remote-worktree) |
| You need a machine on demand | rung 5, a [provider host](remote.md#provider-hosts) |
| herdr is your multiplexer and you need a remote worker | `MU_MUX=tmux` for that workstream (Rex also supports rung 2 and rung 3 session templates) |

A provider host or a standing one: weigh capacity (on demand or fixed),
lifetime ([deadline or idle reclaim](remote.md#provider-hosts)), credentials,
installed harnesses and setup time. Do not assume a provisioned host has mu
or a git identity.

## Rung 1: `mu host exec`

```bash
mu host exec dev --cwd /path/to/repo -- make test
mu host exec dev --cwd /path/to/repo --json --timeout 60 -- git rev-parse HEAD
```

One synchronous command through the host's link: no agent row, task, pane or
job. It runs on every backend, herdr included.

- `--cwd` sets the working directory on the host, including with a template
  that has no `{cwd}` placeholder. Without it, the link uses `.`.
- Deadline 600 s unless `--timeout`; mu keeps 1 MiB of output and reports
  `clipped` when it cut.
- The exit is the link's. A hand-back (a template's own exit 3, a hardware
  key) exits 5 with `human needed`; a timeout or no answer also exits 5, and
  the command may still run; so does a command's own 5. Only `--json` tells
  them apart.
  Nothing is retried.
- The log keeps metadata only (host, outcome, duration, command length),
  never the command text or output.
- It is for workspace commands, not bulk transfer: use `agent collect`.

## Rung 2: local pi with a remote worktree

Install the mule workspace extension in local pi. Use a static
[`--plugin mule` profile](#use-the-mule-plugin-rungs-2-and-4) whose name and
mule configuration match the extension's. Then, from your checkout:

```bash
mu agent spawn worker-1 -w crew --mule box --root '~/repo'
mu agent collect worker-1 -w crew
```

`--mule` implies a managed worktree and takes the profile name, not a
path. mu resolves `--from` (default `HEAD`) in your checkout and prepares
that commit through the host's link. The pane runs `pi --mule <host>:<tree>`;
the workspace extension handles tools, while pi, ctl and the task DB stay
local. The loop has the same DB access as a local worker. Like any worker, it has no `mu_delegate`. Collect uses the
profile's fetch route; it needs no remote pi or forwarded socket. Collect
brings home commits, not uncommitted files. Close checks for uncommitted or
uncollected work before killing the pane, then stops the worker's detached
mule jobs before removing the tree. Use a mule workspace extension that
honors `MULE_PI_JOB_PREFIX` so close can find those jobs across pi sessions.
The local pane can run on tmux or Rex. `--host` and `--cwd` conflict with
`--mule`. On Linux, `MU=<mu> MULE=<mule> bash scripts/smoke-rung2.sh` runs
this path end to end against a loopback `sshd MaxSessions 1`.

A `mu` called from a remote command (a script, `bash -c`) would open the
host's default DB, someone else's. The mule extension sets
`MU_REMOTE_WORKSPACE=1` in those commands, and mu then refuses (exit 4)
unless `MU_DB_PATH` names a DB. Use the local loop's `mu` route instead.

## One backend per workstream

A workstream's panes live on one multiplexer. A spawn refuses before any
effect while a row names another backend, and says which. `mu state` reports
such a row as `unknown` with its backend, never as a gone pane, and
reconcile keeps it. The guard is advisory: two first spawns on two backends
can race. A Rex terminal may drive a tmux workstream (`MU_MUX=tmux`).

## Refusals

Backend refusals happen before spawn effects.

- **herdr on rungs 2-5:** it cannot run the required per-agent command or
  view. Use tmux (or Rex for rung 2 or a session template). Rungs 0 and 1 run.
- **Rex on lease and plugin job views** (rungs 4-5, and a rung 3 ssh plugin
  pane): tmux-only: a Rex reply does not name the server instance that
  answered it, so mu cannot prove which server holds a view ([roadmap](../ROADMAP.md)).
  Use `MU_MUX=tmux` for those views.
- **A base commit the host lacks** (static host): mu neither fetches nor
  pushes. A published commit: `mu host exec <host> -- git -C <repo> fetch
  <remote> <rev>`. A local-only one: push it somewhere the host can fetch,
  then fetch there, or spawn from a published commit.
- **A path another DB owns:** see [remote.md](remote.md#spawn-the-agent).

## A dropped master is not host loss

A hand-back (exit 3, a dropped ssh master) asks for a human. It records no
lost host, job or tree. A lease keeps its carrier and row; sends fail as
unreachable and are not resent; the forward returns with the master. A close
during the loss kills the pane and hands back, keeping row and handle. With
the master back, take a fresh preview with `mu agent close <name> -w <ws>`
and repeat with `--if <rev>` (the revision may have changed after
the interrupted close or a reap); that stops the job by its handle.

For rung 2, send refuses new delivery and wait hands back without consuming
an unfinished run. Reopen the master and retry; the local pane and its task
remain. An explicit close can still close the local pane during a hand-back:
it preserves a recovery record for the tree and any outstanding jobs. Take a
fresh close preview once the master is back. If local dispatch processes
are still exiting after the pane closes, close instead exits 4. Retry from
the recovery preview it names; mu checks those processes again before
listing remote jobs.

## Use the mule plugin (rungs 2 and 4)

`mu-plugin-mule` ships with mule. It gives a host mule's link (`exec` through
mule's private SSH master) and the `lease` job kind, a persistent worker
whose pane is a bound tmux view with a file handle. The plugin has no
`fetch`: the profile keeps your `--fetch` template.

```bash
mule init                  # seeds mule's config, prints each master command,
                           # registers the plugin if mu is on PATH
mu plugin list             # mule is listed
mu host add box --plugin mule --fetch '<your fetch command>' --repo '~/repo'
mu host check box
```

- Open the master `mule init` prints for the host first; it opens none. The
  mu host name is the mule host name. `mule init` creates no mu profile.
- A plugin profile takes no `--shell`, `--exec`, `--stop`, `--attach` or
  `--transport`; mule serves them. Quote `--repo '~/repo'` (or give the
  remote absolute path): an unquoted `~` expands to your local home before mu
  stores it. `--repo` is as in [remote.md](remote.md). The mule link declares
  its own admission (`slots: self`): its exec, prepare and lease view take no
  mu slot, so `--max-sessions` does not cap them; only the `--fetch` template
  fallback (collect) can take one.
- mu requires a plugin you own and others cannot write. If the install is
  root-owned, follow the copy commands `mule init` prints. Rerun `mule init`
  after upgrading mule.

## Migrate a mule lease template to the plugin

Only a profile whose stop template calls `mule rm` directly (a plain path to
the binary is fine; a shell wrapper is not recognised) counts as a mule lease
template. **SSH session templates stay as they are**: nothing here applies to
them, and the `ssh` example plugin is not a migration target.

There is no live conversion. A job keeps the stop template it was reserved
under, and a reaped worktree's link is pinned to the profile that made it, so
the old profile stays until the last job and worktree is closed.

`mu doctor` finds these profiles. For each it prints the host and either `no
agent, job or recovery records block switching` or `switch blocked by:` with
one line per record, then the steps below. Records are what block, not link
health: this check probes no link (the rest of doctor may). `mu doctor
--json` carries the same at `data.housekeeping.muleProfileMigrations`.

```text
dev: mule lease template; switch blocked by:
    agent <ws>/<name>
    reaped job record <ws>/<name> (id 3)
```

A blocker line is one of:

- `agent <ws>/<name>`: an existing agent row on the host (live, or reaped but
  not yet removed).
- `active job record <ws>/<name> (id N)`: a job whose agent still exists.
- `reaped job record <ws>/<name> (id N)`: a job whose agent was reaped; its job may
  still run.
- `unbound job record ...`: a reservation no agent took (a spawn that failed
  after the carrier may have launched).
- `recovery record <ws>/<name> (agent id N)`: a remote worktree left by a
  removed agent.

Procedure:

1. Pause new spawns on the host in every workstream. Save the original `mu
   host add` line (`mu host show <h>`).
2. Run `mule init`, and open the master. Check that mule has that host under
   the same name.
3. Let active work finish. For each worktree, `mu agent collect <name> -w
   <ws>`, then `mu agent close <name> -w <ws>` (preview) and again with `--if
   <rev>`. Close reaped agents and job records the same way: close stops the
   job through its original stop template. For a recovery record add
   `--recovery <agent id>` when several share a name. Collect never stops a
   job. A host gone for good needs `--abandon-job`
   ([remote.md](remote.md#session-capped-hosts)).
4. Run `mu doctor` until the host reports no blockers.
5. `mu host add <h> --plugin mule --replace --fetch '<old fetch>'` with the
   original `--repo` and `--max-sessions`. It checks first and removes the old
   profile only if the add can go through: it refuses while any agent row, job
   record or recovery record names the host, listing them, and a refusal keeps
   the old profile. (`mu host rm <h>` then `host add` has the same refusal
   but runs it after the profile is gone.)
6. `mu host check <h>`, then resume spawns.

What blocks, and why:

- **Active jobs** and **reaped reservations** keep their original `stop`;
  `host rm` would only check held channels, not these, so do not remove the
  profile early.
- **Recovery-only rows** (no agent, no job) still pin the old link. They block
  the switch until closed.
- A lease spawn that races the switch re-reads the transport when it reserves:
  either the plugin add sees its reservation and refuses, or the spawn sees the
  switch and reserves nothing ("its transport changed while the spawn was
  admitted"); no job is launched.

Rollback: if you drained, the plugin check fails and no new work has started,
`mu host rm <h>` the plugin profile and re-add the saved line byte-for-byte. If
`host rm` was premature, re-add it at once: that restores the stop for jobs and
recovery records already pinned. It cannot rebuild the pin of a worktree reaped
while the profile was absent; that record still blocks the switch. If draining
fails, keep the original profile.

See also: [Run a worker on another machine](remote.md), [Use a
plugin](plugins.md), [the placement spec](../specs/2026-11-20-ladder-placement.md).
