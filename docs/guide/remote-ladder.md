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
| 2 | local loop, remote workspace and shell | split | planned, not shipped |
| 3 | a session pane (`--transport session`) | all on the host | shipped |
| 4 | a lease (`--transport lease`) | all on the host | shipped, pi only |
| 5 | a provider host | all on the host | core shipped |

Rung 2 is approved but not built; nothing below depends on it.

## Capability matrix

| Rung | tmux | Rex | herdr | One session per connection |
| --- | --- | --- | --- | --- |
| 0 | pi `ctl`, hook harnesses (claude, codex, cursor-agent, muse) `hooks`, others `mux` | pi `ctl`, others `mux` | pi `ctl`, others `mux` | n/a |
| 1 | runs (no pane) | runs | runs | fine over a link that serialises itself |
| 3 | pi `ctl` forwarded, hook harnesses remote `hooks` | pi `ctl`, others `mux` | refused | fine: each pane opens its own connection |
| 4 | pi `ctl` via the carrier | same | refused | fine: one master |
| 5 | the plugin's own channel if it declares one, else the built-in `ctl`/`hooks`/`mux` its inputs support (an `at-start` kind must declare one) | same | refused | the provider's |
| command gate | `mux` | `mux` | refused | as rung 3; lease profiles run no gates |

- Remote `hooks` needs a backend that anchors and pastes: tmux only.
  Elsewhere a non-pi worker is on `mux`; tmux has no `mux` send and refuses.
- A lease carrier forwards no stdin, so a non-pi worker has no input path on
  a lease: use pi.
- The Rex cells for rungs 3 and 4 are read from source, not smoke-tested.

## Reach for what

| Situation | Reach for |
| --- | --- |
| One build or test on a host, no agent | rung 1, [`mu host exec`](#rung-1-mu-host-exec) |
| The host runs the loop and takes a new connection per pane | rung 3 |
| Only one connection is practical (a prompted master) | rung 4 for a crew; rung 1 for single commands |
| The host cannot run the loop (no credentials, no model API) | rung 2, once it ships |
| You need a machine on demand | rung 5, a [provider host](remote.md#provider-hosts) |
| herdr is your multiplexer and you need a remote worker | `MU_MUX=tmux` or Rex for that workstream |

A provider host or a standing one: weigh capacity (on demand or fixed),
lifetime (a deadline, or none), whose credentials, which harnesses are
installed and how long setup takes. Do not assume a provisioned host has mu
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

## One backend per workstream

A workstream's panes live on one multiplexer. A spawn refuses before any
effect while a row names another backend, and says which. `mu state` reports
such a row as `unknown` with its backend, never as a gone pane, and
reconcile keeps it. The guard is advisory: two first spawns on two backends
can race. A Rex terminal may drive a tmux workstream (`MU_MUX=tmux`).

## Refusals

Each refusal is typed, comes before any effect and names the fix.

- **herdr on rungs 3-5:** it runs no per-agent command or view. Use tmux or
  Rex. Rungs 0 and 1 run.
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

<!-- TODO(guide_lease_section): profile migration, after `migrate_profiles`. -->

## TODO: profile migration

Not written yet. Keep a profile's current behaviour until it lands.

## TODO: the mule lease plugin

<!-- TODO: fill in once `plugin_mule_link` and `plugin_mule_lease` merge:
the mule link (exec, `host check` steps for the master and host tmux, size
caps), the lease job kind and its file handle, `mule init` registration.
Until then a mule host is a lease template: `host init --mule`. -->

Until the plugin merges, use the lease template in
[Session-capped hosts](remote.md#session-capped-hosts).

See also: [Run a worker on another machine](remote.md), [Use a
plugin](plugins.md), [the placement spec](../specs/2026-11-20-ladder-placement.md).
