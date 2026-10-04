# Environment variables

Every env var mu reads or sets. mu has no config file. Durations are
milliseconds; `0` disables a wait unless noted.

## State and workstream

| Name | Effect | Default |
| --- | --- | --- |
| `MU_DB_PATH` | SQLite file path. Wins over the state dir. | `<state-dir>/mu.db` |
| `MU_STATE_DIR` | State directory. | `$XDG_STATE_HOME/mu` |
| `XDG_STATE_HOME` | XDG state base; mu appends `mu/`. | `~/.local/state` |
| `MU_SESSION` | Active workstream when `-w` is absent. | current `mu-<name>` mux session |
| `MU_SYNC_DIR` | Folder holding one segment per machine. This is the whole sync setup; there is no peer list. | unset: sync off |

## Multiplexer

| Name | Effect | Default |
| --- | --- | --- |
| `MU_MUX` | Force `tmux` or `herdr`, skipping mux detection. An unknown value fails the invocation. | detected |
| `HERDR_ENV` | Read only. `1` (set by herdr in its panes) selects herdr; outranks `$TMUX`. | |
| `MU_TMUX_SOCKET` | tmux socket name (`-L <name>`). tmux only. | `$TMUX` |
| `MU_HERDR_SESSION` | Named herdr server (`--session <name>`). herdr only. Tests must set it to a non-default name. | herdr default session |
| `MU_BANNER_QUIET` | `1` disables mu's pane border and banner decorations. tmux only. | unset |

## Spawn

| Name | Effect | Default |
| --- | --- | --- |
| `MU_<CLI>_COMMAND` | Executable for `--cli <cli>`; hyphens become underscores (`--cli pi-meta` reads `MU_PI_META_COMMAND`). May hold arguments. `--command` wins; the spawn line names the env var when it supplied the command. | the cli value |
| `MU_SPAWN_CTL_MS` | Budget for the control-socket handshake with a new pi agent, polled every 250ms. On timeout spawn still exits 0, reports `ctl: missing` or `ctl: refused`, and warns. `--no-ctl` skips it per spawn. | `30000` |
| `MU_SPAWN_LIVENESS_MS` | tmux only. Wait this long, then check the pane is alive and its scrollback has no startup error (auth failure, `command not found`). Failure rolls back the row and throws `AgentDiedOnSpawnError` or `AgentSpawnStartupError`. | `1500` |
| `MU_SPAWN_LOCK_TIMEOUT_MS` | How long a spawn waits for the per-workstream spawn lock. | `15000` |

## Send and state (tmux path)

These apply to the tmux paste path only. For when that path runs, see
[No silent fallback](../architecture/control-socket.md#no-silent-fallback).

| Name | Effect | Default |
| --- | --- | --- |
| `MU_SEND_READINESS_MS` | Before pasting, wait out a pane's modal or re-init; after Enter, confirm it landed. `0` sends fire-and-forget. A busy pane is not waited on. | `15000` |
| `MU_SEND_DELAY_MS` | Delay between the bracketed paste and Enter. | `500` |

## Agents and timing

| Name | Effect | Default |
| --- | --- | --- |
| `MU_IDLE_THRESHOLD_MS` | Time without progress before an owning agent, or a scratch agent, counts as idle. | `300000` |
| `MU_LOG_TAIL_INTERVAL_MS` | `mu log --tail` poll interval; clamped to ≥ 50. | `1000` |

## Set by mu in agent panes

| Name | Value |
| --- | --- |
| `MU_AGENT_NAME` | The agent's name; first rung of actor identity. |
| `MU_WORKSTREAM` | The agent's workstream. |
| `MU_CTL_SOCK` | The agent's control socket path, derived from state dir, workstream, and agent. The mu pi extension serves it. |
| `MU_MANAGED_AGENT` | `1`. Hides `mu_delegate` inside agents, so a helper cannot spawn helpers. |

`mu agent remote-env <agent> --shell` prints `MU_SSH_ARGS` (the ssh
socket forward) and `MU_REMOTE_ENV` (the four vars above) for a remote
pi agent's `--command`. mu never reads them back.

## pi extension and `mu link pi`

| Name | Effect | Default |
| --- | --- | --- |
| `MU_DELEGATE` | `0` hides the `mu_delegate` tool. `mu doctor` reports it. | unset: shown |
| `MU_DELEGATE_MAX` | Most delegates one pi session runs at once; `mu_delegate` refuses past it. A positive integer. | `16` |
| `MU_NUDGE` | `0` turns off the keep-driving nudge: one reminder when an orchestrator ends a turn with dispatched work still IN_PROGRESS. `mu doctor` reports it. | unset: on |
| `MU_PI_HOME` | Root under which `mu link pi` writes `.pi/` and `.agents/`. | `$HOME` |
| `PI_CODING_AGENT_DIR` | Read only. pi's agent dir, checked for a linked murmur extension. | `~/.pi/agent` |
| `MU_EXTENSION_ENTRY` | Test only. Built extension the `mu link pi` shim imports. | `dist/extension/mu-pi.js` |

## Output and TUI

| Name | Effect | Default |
| --- | --- | --- |
| `NO_COLOR` | Any value turns colour off; wins over everything. | unset |
| `MU_FORCE_COLOR` | Truthy forces colour on. `""`, `0`, and `false` opt out. Checked before `FORCE_COLOR`. | unset |
| `MU_NO_TUI` | `1` makes bare `mu` print help instead of opening the TUI. | unset |
| `MU_TUI_DEBUG_MOUSE` | `1` logs mouse hit-tests to stderr. | unset |

## Tests

`VITEST` or `NODE_ENV=test` makes `openDb()` refuse the real default DB.
`test/_setup.ts` clears inherited `MU_*` vars except `MU_TMUX_SOCKET`.
