# Environment variables

Every env var mu reads or sets, except standard ones it reads as any
tool does (`HOME`, `PATH`, `SHELL`, `USER`, `TERM`, `DISPLAY`,
`WAYLAND_DISPLAY`). mu has no config file. Durations are
milliseconds; `0` disables a wait unless noted.

## State and workstream

| Name | Effect | Default |
| --- | --- | --- |
| `MU_DB_PATH` | SQLite file path. Wins over the state dir. | `<state-dir>/mu.db` |
| `MU_STATE_DIR` | State directory. Also holds `compile-cache/` (V8 code cache for the CLI; `NODE_DISABLE_COMPILE_CACHE=1` turns it off). Set, it turns off the state import from mu 4's `mu-next`. | `$XDG_STATE_HOME/mu5` |
| `XDG_STATE_HOME` | XDG state base; mu appends `mu5/` (mu 4 owns `mu-next/`, 3.x `mu/`, so no two majors share a DB). An empty or relative value is ignored. | `~/.local/state` |
| `XDG_CACHE_HOME` | XDG cache base; mu appends `mu/`. Holds only disposable copies. An empty or relative value is ignored. | `~/.cache` |
| `MU_SYNC_DIR` | Folder holding one segment per machine. This is the whole sync setup; there is no peer list. 4.0 refuses (exit 4, nothing read or written) a folder holding a segment that opens with a v1 line, i.e. a 3.x peer: give it its own folder. | unset: sync off |

## Multiplexer

| Name | Effect | Default |
| --- | --- | --- |
| `MU_MUX` | Force `tmux`, `herdr` or `rex`, skipping mux detection. An unknown value fails the invocation. | detected |
| `HERDR_ENV` | Read only. `1` (set by herdr in its panes) selects herdr; outranks `$TMUX`. | |
| `TMUX`, `TMUX_PANE` | Read only. Either one (set by tmux in its panes) selects tmux. `$TMUX` gates reading the current session name, used only as the suggestion in the missing-`-w` error: it never routes a verb. `mu me` / `mu state --me` never read `$TMUX_PANE` (identity is the injected `MU_AGENT_NAME` or `PI_SESSION_ID`); only `mu task list --mine` and a few older self-readers still fall back to it when no `MU_AGENT_NAME` is injected. | |
| `HERDR_WORKSPACE_ID` | Read only. Set by herdr in its panes; pane listing with no target reads this workspace first. | |
| `HERDR_PANE_ID` | Read only. Set by herdr in its panes. | |
| `MU_TMUX_SOCKET` | Run every tmux call on a private server (`-L <name>`) with `-f /dev/null`, so `~/.tmux.conf` is not loaded. The test suite uses it, and so can you to keep a crew off your own tmux server (a demo, a smoke test). Attach lines mu prints then carry `-L <name>`, and the dashboard's `a` nests a client on purpose when you are inside another tmux. tmux only. | unset: tmux's default server |
| `REX_SESSION`, `REX_BLOCK` | Read only. Set by Rex in its terminals; `$REX_SESSION` with `TERM_PROGRAM=rex` selects rex, below tmux and herdr. | |
| `REX_BIN_DIR` | Read only. Set by Rex in its terminals; mu runs `$REX_BIN_DIR/rex`, else `rex` on `PATH`. | |
| `REX_CLIENT` | The Rex app an attach switches when several are connected (read by `rex` itself). | the only app |
| `MU_REX_SERVER` | Run every rex call against this server (`rex -S <server>`), e.g. a private `rex server run --listen unix://…` for tests. rex only. | the local Rex server |
| `MU_HERDR_SESSION` | Named herdr server (`--session <name>`). herdr only. Tests must set it to a non-default name. | herdr default session |

## Spawn

| Name | Effect | Default |
| --- | --- | --- |
| `MU_<CLI>_COMMAND` | Executable for `--cli <cli>`; hyphens become underscores (`--cli pi-meta` reads `MU_PI_META_COMMAND`). May hold arguments. `--command` wins; the spawn line names the env var when it supplied the command. On herdr, spawn refuses both with exit 2. | the cli value |
| `MU_PI_CHANNEL` | `hooks` spawns a local pi on tmux on the `hooks` channel, the pi fallback (spec D15), for a pi build that breaks murmur's store or a native module. The row records `hooks` and every verb follows the row, so unsetting it later moves no agent. The pane gets the variable too, which tells murmur's pi extension to write inbox events instead of opening its store; mu's pi extension still serves ctl for the spawn handshake, delegates and doctor. Only `hooks` selects it, as murmur reads it. A remote pi and a pi on herdr or Rex stay on ctl. A task-bound spawn (`--task`) hands it the brief as every `hooks` worker gets one: a brief file and a pasted pointer. | unset: pi on ctl |
| `MU_SEND_ACK_MS` | `hooks` channel: how long a paste (or `mu agent answer`) waits for its hook event, polling `murmur pane --json` every 250ms. A send whose `run_count` did not rise reports `ack: unknown` (`delivered: false`, reason `unconfirmed`) and is never resent. | `10000` |
| `MU_FIRST_SEND_ACK_MS` | `hooks` channel: the `MU_SEND_ACK_MS` of mu's first prompt to a local codex or muse worker (`spawn --send`, a fresh task spawn's pointer, the first `mu agent send` without `--force`), when murmur reports the pane with no agent row and the harness has murmur's hooks. A launcher can spend well over 10 s installing plugins before the harness reads the paste. It also bounds mu's wait for codex's ready screen before that first paste (the harness row's `readyMarks`); the ack gets what is left of it, at least `MU_SEND_ACK_MS`. Every other send, a forced one to a pane that still has no row included, uses `MU_SEND_ACK_MS`. | `60000` |
| `MU_STALE_MS` | `hooks` channel: a pane murmur reads running with no event for this long reads unknown, and a send to it needs `--force`. | `600000` |
| `MU_SPAWN_ACK_MS` | `hooks` task spawns (`spawn --task`): how long mu waits for a new claude, cursor-agent or fallback pi worker's `session_start` in murmur's inbox before it writes the brief file and pastes the pointer, polled every 250ms. codex and muse start their session only with their first prompt, so they are read once and never waited for. A worker that never reports one is pasted to anyway; the paste's own ack (`MU_SEND_ACK_MS`; `MU_FIRST_SEND_ACK_MS` for a codex or muse pane's first prompt) decides `sent` or `unknown`. Parsed like `MU_SPAWN_CTL_MS`; `0` skips the wait. | `30000` |
| `MU_SPAWN_CTL_MS` | Budget for the control-socket handshake with a new pi agent, polled every 250ms. On timeout spawn still exits 0, reports `ctl: missing` or `ctl: refused`, and warns. `--no-ctl` skips it per spawn. | `30000` |
| `MU_SPAWN_JOB_MS` | Lease profiles and plugin job kinds. For a plugin kind: how long a spawn waits for the agent's channel to answer `baseline` (its readiness; an `at-start` kind's start reply is its baseline), else the job is stopped and the spawn rolled back (`PluginJobNotReadyError`). For a lease profile: how long `agent spawn --host` waits for the carrier to write its job handle to `{job_file}`. Runs even with `--no-ctl` or `MU_SPAWN_CTL_MS=0`. A pane that dies first throws `AgentDiedOnSpawnError` with its scrollback. A live pane with no handle by the deadline is rolled back (`LeaseJobTimeoutError`). `0` or an invalid value means the default: a lease spawn always waits. | `30000` |
| `MU_HOST_DEADLINE_MARGIN_MS` | Provider hosts only. Inside this margin of a host's deadline, spawns on it refuse (`HostDeadlineError`, exit 4) and the host drains. `0` refuses only past the deadline. | `600000` |
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
| `MU_PI_CHANNEL` | `hooks`, only in a local pi pane spawned on the pi fallback (spec D15). murmur's pi extension reads it and writes inbox events instead of opening its store. Every other local pi pane pins it empty, so it never inherits `hooks` from the tmux server. |
| `MU_MANAGED_AGENT` | `1`. Hides `mu_delegate` inside agents, so a helper cannot spawn helpers (unless `MU_ORCHESTRATOR=1`). |
| `MU_AGENT_CLI` | The harness the pane runs (`claude`, `codex`, `cursor-agent`, `muse`, `pi`), mapped from the cli key and command; the cli key itself for any other CLI. murmur's hooks read it when they find no anchor. Local agents, and a remote claude, codex, cursor-agent or muse worker (in `{env}`). |
| `MU_ORCHESTRATOR` | `1`, only in a pane `mu orchestrate` started. Keeps `mu_delegate` visible to a pi there; turns off what only a worker gets (the close nudge, and `MU_WORKSTREAM` as the implicit `-w`). Never set in a worker or a delegate, and unset in a remote pane. |
| `MU_DB_PATH`, `MU_STATE_DIR` | The absolute DB path and state dir the spawn used, so the worker's `mu` reads the same DB from any cwd. Local agents only. |
| `PI_CODING_AGENT_SESSION_DIR` | `<DB dir>/delegate-sessions/<workstream>/<task>`, set when `mu agent spawn --task <id> --send` (what `mu_delegate` and `mu next --refute` run) starts a pi agent for a `delegate`-kind task, so delegate sessions stay out of the caller's pi `/resume` list. Not set by a plain `mu agent spawn`. Local agents only. |
| `SSH_AUTH_SOCK` | The caller's, when it is a socket (a detached tmux session would otherwise hand the pane a stale one). Local agents only. |
| `MU_REMOTE` | `1`, only for an agent spawned with `--host`. Tells its pi extension there is no mu DB on that host: it skips the close nudge (you close the task) and the settle wait. |
| `MU_REMOTE_KEY` | `<origin host>/<ws>.<agent>.<nonce>`, only for a claude, codex, cursor-agent or muse worker spawned with `--host` (spec D11): the key its hooks on that host report under, in murmur's remote area rather than its inbox. Its anchor holds the same key, for a hook whose env is cleared. Unset in the local pane. |

A local `claude`, `codex`, `cursor-agent` or `muse` pane on tmux starts
through a small `sh` wrapper that writes
`~/.local/state/mu-next/anchors/<pid>.json` (agent name, workstream, role,
harness, orchestrator flag, remote key and the process start time) and then
`exec`s the command in `$SHELL` (tmux's default-shell, as before), so the pid
stays the same. A hook whose harness clears its env (Muse Code) finds the
agent there. The directory ignores `MU_STATE_DIR`, and `XDG_STATE_HOME` too,
since a hook may have neither: the wrapper writes only
`~/.local/state/mu-next/anchors`, which murmur reads first. A murmur older
than that order, run from a hook whose `XDG_STATE_HOME` is set elsewhere,
finds no anchor and falls back to the env. pi panes, and herdr and Rex panes,
start unwrapped.

A `--host` agent gets exactly `MU_MANAGED_AGENT`, `MU_AGENT_NAME`,
`MU_WORKSTREAM`, `MU_CTL_SOCK` (the host-side path) and `MU_REMOTE`, written
into its profile's shell template (`{env}`); a claude, codex, cursor-agent or
muse worker also gets `MU_AGENT_CLI` and `MU_REMOTE_KEY`, and its remote
command starts through the same anchor wrapper, writing under the remote
`$HOME`. It never gets `MU_DB_PATH`, `MU_STATE_DIR` or `MU_SYNC_DIR`; its
local pane gets none of the vars above.

## pi package and `mu pi migrate`

| Name | Effect | Default |
| --- | --- | --- |
| `MU_DELEGATE` | `0` hides the `mu_delegate` tool. `mu doctor` reports it. | unset: shown |
| `MU_DELEGATE_TRACE` | `1` appends one JSON line per delegate wake send and pi lifecycle event to `<cache dir>/delegate-trace.log`. For debugging a lost wake. | unset: off |
| `MU_DELEGATE_MAX` | Most delegates one pi session runs at once. Further calls queue, up to four times this; past that a call is recorded as `refused` and reissued with `mu_delegate_reissue` in its session. A positive integer. | `16` |
| `MU_NUDGE` | `0` turns off the two nudges: the keep-driving settle wait (every completed settle of an orchestrator runs `mu wait` for the work it owns and continues the turn on an event) and the close nudge (one reminder when a mu-spawned pi worker ends a turn still owning an IN_PROGRESS task). A pi nested in an agent's pane (it found `MU_CTL_SOCK` served by another pi) gets neither; a pi without UI (`pi -p`, json mode) gets no close nudge. `mu doctor` reports it. It also turns off `mu hook stop`, the same two for claude, codex and cursor-agent, and with it the Stop hook's application of a claude or codex worker's CLOSE block: the orchestrator's next wait applies it. | unset: on |
| `MU_KEEP_DRIVING_MAX` | How many times in a row `mu hook stop` blocks an orchestrator's stop while workers still run and no event came (each block tells it to run `mu wait` in the background). A block with events, and a turn the user starts, reset the count; past it the turn ends. Counted per harness session in the machine-local `keep_driving` table. | `20` |
| `MU_PI_HOME` | Root under which `mu pi migrate` looks for the old `.pi/` shim and `.agents/` skill link. | `$HOME` |
| `MU_INIT_HOME` | Root under which `mu init` writes its hook entries (`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`), skill copies (`.claude/skills/mu`, `.codex/skills/mu`, `.cursor/skills/mu`) and prompt skills beside claude's and cursor-agent's (`.claude/skills/mu-review`, …), and `mu doctor` reads the hook entries. | `$HOME` |
| `CLAUDE_CONFIG_DIR` | Read only. Claude Code's config directory, as Claude Code reads it: `mu init` writes its `settings.json` and `skills/`; `mu doctor`, murmur's availability check and `mu host check` read its `settings.json`. Empty is unset. murmur, museum and muzzle honour it too. | `~/.claude` |
| `CODEX_HOME` | Read only. Codex's config directory, as codex reads it: `mu init` writes its `hooks.json` and `skills/`; `mu doctor`, murmur's availability check and `mu host check` read its `hooks.json`. Empty is unset. murmur, museum and muzzle honour it too. | `~/.codex` |
| `CURSOR_HOME` | Read only. Cursor's home directory: museum stages `projects/*/agent-transcripts/` from here. Empty is unset. | `~/.cursor` |
| `PI_SESSION_ID` | Read only. The pi session's id: the caller identity `pi:<id>` of `mu_delegate` calls, a bare `mu wait`, `mu me` and `mu next --refute` when no managed agent is injected. | |
| `PI_CODING_AGENT_DIR` | Read only. pi's agent dir, checked for a linked murmur extension. | `~/.pi/agent` |

## Output

| Name | Effect | Default |
| --- | --- | --- |
| `NO_COLOR` | Any value turns colour off; wins over everything. | unset |
| `MU_FORCE_COLOR` | Truthy forces colour on. `""`, `0`, and `false` opt out. Checked before `FORCE_COLOR`. | unset |

Colour is on only when stdout is a TTY (and `TERM` is not `dumb`); a pipe gets plain text, inside tmux too. To keep colour through a pipe, force it: `MU_FORCE_COLOR=1 watch --color mu task list -w X`, or `tmux display-popup -E 'MU_FORCE_COLOR=1 mu task list -w X | less -R'`.

## Tests

`VITEST` or `NODE_ENV=test` makes `openDb()` refuse the real default DB. The dashboard sets `NODE_ENV=production` for itself when it is unset, to get React's production build.
`test/_setup.ts` clears inherited `MU_*` vars except `MU_TMUX_SOCKET`.
