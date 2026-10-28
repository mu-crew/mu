# Environment variables

Every env var mu reads or sets, except standard ones it reads as any
tool does (`HOME`, `PATH`, `SHELL`, `USER`, `TERM`, `DISPLAY`,
`WAYLAND_DISPLAY`). mu has no config file. Durations are
milliseconds; `0` disables a wait unless noted.

## State and workstream

| Name | Effect | Default |
| --- | --- | --- |
| `MU_DB_PATH` | SQLite file path. Wins over the state dir. | `<state-dir>/mu.db` |
| `MU_STATE_DIR` | State directory. Also holds `compile-cache/` (V8 code cache for the CLI; `NODE_DISABLE_COMPILE_CACHE=1` turns it off). | `$XDG_STATE_HOME/mu-next` |
| `XDG_STATE_HOME` | XDG state base; mu appends `mu-next/` (3.x owns `mu/`, so the two builds never share a DB). An empty or relative value is ignored. | `~/.local/state` |
| `XDG_CACHE_HOME` | XDG cache base; mu appends `mu/`. Holds only disposable copies. An empty or relative value is ignored. | `~/.cache` |
| `MU_SYNC_DIR` | Folder holding one segment per machine. This is the whole sync setup; there is no peer list. 4.0 refuses (exit 4, nothing read or written) a folder holding a segment that opens with a v1 line, i.e. a 3.x peer: give it its own folder. | unset: sync off |

## Multiplexer

| Name | Effect | Default |
| --- | --- | --- |
| `MU_MUX` | Force `tmux` or `herdr`, skipping mux detection. An unknown value fails the invocation. | detected |
| `HERDR_ENV` | Read only. `1` (set by herdr in its panes) selects herdr; outranks `$TMUX`. | |
| `TMUX`, `TMUX_PANE` | Read only. Either one (set by tmux in its panes) selects tmux. `$TMUX` gates reading the current session name, used only as the suggestion in the missing-`-w` error: it never routes a verb. `mu me` / `mu state --me` never read `$TMUX_PANE` (identity is the injected `MU_AGENT_NAME` or `PI_SESSION_ID`); only `mu task list --mine` and a few older self-readers still fall back to it when no `MU_AGENT_NAME` is injected. | |
| `HERDR_WORKSPACE_ID` | Read only. Set by herdr in its panes; pane listing with no target reads this workspace first. | |
| `HERDR_PANE_ID` | Read only. Set by herdr in its panes. | |
| `MU_TMUX_SOCKET` | Run every tmux call on a private server (`-L <name>`) with `-f /dev/null`, so `~/.tmux.conf` is not loaded. The test suite uses it, and so can you to keep a crew off your own tmux server (a demo, a smoke test). Attach lines mu prints then carry `-L <name>`, and the dashboard's `a` nests a client on purpose when you are inside another tmux. tmux only. | unset: tmux's default server |
| `MU_HERDR_SESSION` | Named herdr server (`--session <name>`). herdr only. Tests must set it to a non-default name. | herdr default session |

## Spawn

| Name | Effect | Default |
| --- | --- | --- |
| `MU_<CLI>_COMMAND` | Executable for `--cli <cli>`; hyphens become underscores (`--cli pi-meta` reads `MU_PI_META_COMMAND`). May hold arguments. `--command` wins; the spawn line names the env var when it supplied the command. On herdr, spawn refuses both with exit 2. | the cli value |
| `MU_SPAWN_CTL_MS` | Budget for the control-socket handshake with a new pi agent, polled every 250ms. On timeout spawn still exits 0, reports `ctl: missing` or `ctl: refused`, and warns. `--no-ctl` skips it per spawn. | `30000` |
| `MU_SPAWN_JOB_MS` | Lease profiles only. How long `agent spawn --host` waits for the carrier to write its job handle to `{job_file}`. Runs even with `--no-ctl` or `MU_SPAWN_CTL_MS=0`. A pane that dies first throws `AgentDiedOnSpawnError` with its scrollback. A live pane with no handle by the deadline is rolled back (`LeaseJobTimeoutError`). `0` or an invalid value means the default: a lease spawn always waits. | `30000` |
| `MU_SPAWN_LIVENESS_MS` | tmux only. Wait this long, then check the pane is alive and its scrollback has no startup error (auth failure, `command not found`). Failure rolls back the row and throws `AgentDiedOnSpawnError` or `AgentSpawnStartupError`. A pi agent skips the wait: the pane is checked on each ctl handshake tick and scanned when it ends. | `1500` |
| `MU_SPAWN_LOCK_TIMEOUT_MS` | How long a spawn waits for the per-workstream spawn lock. | `15000` |
| `MU_AGENT_LOCK_TIMEOUT_MS` | How long `agent close` and `--worktree` staging wait for the per-agent lock before exit 4 (`AgentLockBusyError`, nothing done). | `15000` |

## Agents and timing

| Name | Effect | Default |
| --- | --- | --- |
| `MU_IDLE_THRESHOLD_MS` | Time without progress before an owning agent, or a scratch agent, counts as idle. | `300000` |
| `MU_LOG_TAIL_INTERVAL_MS` | `mu log --tail` poll interval; clamped to ≥ 50. | `1000` |

## Set by mu in agent panes

| Name | Value |
| --- | --- |
| `MU_AGENT_NAME` | The agent's name; first rung of actor identity. |
| `MU_WORKSTREAM` | The agent's workstream. With `MU_MANAGED_AGENT=1` it is the scope of every verb that has no `-w` (no tmux lookup); without it, ignored. `MU_SESSION` is not read: a verb with no `-w` and no injected scope fails with `no workstream: pass -w <name>`. |
| `MU_CTL_SOCK` | The agent's control socket path, derived from state dir, workstream, and agent. The mu pi extension serves it. |
| `MU_MANAGED_AGENT` | `1`. Hides `mu_delegate` inside agents, so a helper cannot spawn helpers. |
| `MU_DB_PATH`, `MU_STATE_DIR` | The absolute DB path and state dir the spawn used, so the worker's `mu` reads the same DB from any cwd. Local agents only. |
| `PI_CODING_AGENT_SESSION_DIR` | `<DB dir>/delegate-sessions/<workstream>/<task>`, set when `mu agent spawn --task <id> --send` (what `mu_delegate` and `mu next --refute` run) starts a pi agent for a `delegate`-kind task, so delegate sessions stay out of the caller's pi `/resume` list. Not set by a plain `mu agent spawn`. Local agents only. |
| `SSH_AUTH_SOCK` | The caller's, when it is a socket (a detached tmux session would otherwise hand the pane a stale one). Local agents only. |
| `MU_REMOTE` | `1`, only for an agent spawned with `--host`. Tells its pi extension there is no mu DB on that host: it skips the close nudge (you close the task) and the settle wait. |

A `--host` agent gets exactly `MU_MANAGED_AGENT`, `MU_AGENT_NAME`,
`MU_WORKSTREAM`, `MU_CTL_SOCK` (the host-side path) and `MU_REMOTE`, written
into its profile's shell template (`{env}`). It never gets `MU_DB_PATH`,
`MU_STATE_DIR` or `MU_SYNC_DIR`; its local pane gets none of the vars above.

## pi package and `mu pi migrate`

| Name | Effect | Default |
| --- | --- | --- |
| `MU_DELEGATE` | `0` hides the `mu_delegate` tool. `mu doctor` reports it. | unset: shown |
| `MU_DELEGATE_TRACE` | `1` appends one JSON line per delegate wake send and pi lifecycle event to `<cache dir>/delegate-trace.log`. For debugging a lost wake. | unset: off |
| `MU_DELEGATE_MAX` | Most delegates one pi session runs at once. Further calls queue, up to four times this; past that a call is recorded as `refused` and reissued with `mu_delegate_reissue` in its session. A positive integer. | `16` |
| `MU_NUDGE` | `0` turns off the two nudges: the keep-driving settle wait (every completed settle of an orchestrator runs `mu wait` for the work it owns and continues the turn on an event) and the close nudge (one reminder when a mu-spawned pi worker ends a turn still owning an IN_PROGRESS task). A pi nested in an agent's pane (it found `MU_CTL_SOCK` served by another pi) gets neither; a pi without UI (`pi -p`, json mode) gets no close nudge. `mu doctor` reports it. | unset: on |
| `MU_PI_HOME` | Root under which `mu pi migrate` looks for the old `.pi/` shim and `.agents/` skill link. | `$HOME` |
| `PI_SESSION_ID` | Read only. The pi session's id: the caller identity `pi:<id>` of `mu_delegate` calls, a bare `mu wait`, `mu me` and `mu next --refute` when no managed agent is injected. | |
| `PI_CODING_AGENT_DIR` | Read only. pi's agent dir, checked for a linked murmur extension. | `~/.pi/agent` |

## Output

| Name | Effect | Default |
| --- | --- | --- |
| `NO_COLOR` | Any value turns colour off; wins over everything. | unset |
| `MU_FORCE_COLOR` | Truthy forces colour on. `""`, `0`, and `false` opt out. Checked before `FORCE_COLOR`. | unset |

## Tests

`VITEST` or `NODE_ENV=test` makes `openDb()` refuse the real default DB. The dashboard sets `NODE_ENV=production` for itself when it is unset, to get React's production build.
`test/_setup.ts` clears inherited `MU_*` vars except `MU_TMUX_SOCKET`.
