# Mux topology, backends and reconciliation

mu runs agents in multiplexer panes, tmux or herdr, behind one
`MuxBackend` interface. Overview: [ARCHITECTURE.md](../ARCHITECTURE.md).

## One mux session per workstream

One workstream is one mux session and one `workstream_id` partition in
`~/.local/state/mu/mu.db`. Workstreams on one machine are independent
mux sessions.

| mu term | tmux | herdr |
| --- | --- | --- |
| **mux session** | session | workspace |
| **window** | window | tab |
| **pane** | pane (`%15`) | pane (`w1:p1`) |

herdr's own "session" is server-level (one socket), which is the wrong
granularity, so a herdr workspace plays the mux-session role.

```
  tmux session: mu-auth-refactor              (one mu workstream)
  ┌───────────────────────────────────────────────────────────┐
  │  Window: Backend             Window: Review               │
  │  ┌──────────┐ ┌──────────┐   ┌────────────────────────┐   │
  │  │ worker-1 │ │ worker-2 │   │ reviewer-1             │   │
  │  │ (pi)     │ │ (pi)     │   │ (pi, role=read-only)   │   │
  │  └──────────┘ └──────────┘   └────────────────────────┘   │
  │  Window: mu-orchestrator                                  │
  │  ┌────────────────────────────────────────────────────┐   │
  │  │  pi (you, with mu extension loaded)                │   │
  │  └────────────────────────────────────────────────────┘   │
  └───────────────────────────────────────────────────────────┘
```

- The first `mu agent spawn` creates the session if needed. Name it
  with `mu workstream init <name>` or `MU_SESSION=<name>`.
- `tmux attach -t mu-<workstream>` shows the whole crew (herdr:
  `herdr workspace focus <id>`). Killing the session kills the
  workstream, with no leaked panes, and the crew survives a closed
  laptop.
- `mu agent list` is scoped to one workstream; `-w` picks another.
- `mu doctor` warns about orphan panes, ghost rows, and agents whose
  mux session is gone.

**Window vs pane.** Each agent gets its own window, named by `--tab`
(default: the agent name). Agents sharing a `--tab` value share a
window. Identity never depends on the window or the pane title: each
pane gets `$MU_AGENT_NAME`, and nothing reads or writes pane titles or
borders. The canonical tmux protocol is the comment block at the top of
`src/mux/tmux.ts`.

## The `activeMux()` seam

Every call site reaches its multiplexer through
`(await activeMux()).<method>()`. Nothing outside `src/mux/` names a
backend. `src/mux/detect.ts` picks one: `MU_MUX` → `HERDR_ENV` →
`$TMUX` → `PATH`. An unknown `MU_MUX` value fails the invocation
instead of falling back to tmux.

Each call site has decided what "no reachable multiplexer" means:

| | On `NoMultiplexerError` | Examples |
| --- | --- | --- |
| **Load-bearing** | propagate; `handle()` maps it to exit 5 | spawn, send, read, kill, reconcile, session create and destroy |
| **Best-effort** | `try`/`catch`, degrade | workstream liveness (`listPanes` → not alive), liveness polls, attach hints |

`reconcile()` is load-bearing on purpose: `listPanes(session)` returns
`[]` only for a session or server that is gone and throws on any other
failure, and reconcile lets it propagate. Treating an unreachable mux
as "zero panes" would prune every agent as a ghost and reap its
in-progress tasks. Identity needs no mux: `$MU_AGENT_NAME` only.

The `MuxBackend` surface is `available`, `ensureSession`,
`killSession`, `spawnAgent`, `listPanes`, `paneAlive`, `killPane`,
`capture`, `attachCommands`, `healthCheck` and
`paneNotFoundNextSteps`, plus optional `paneStatus` and `sendToPane`
(herdr only) and `currentSessionName` (deprecated scope fallback).
The mux holds no workstream list: the DB owns it, and `mu-*` sessions
with no row are not discovered.

Three concerns belong to the backend, because each would otherwise
hardcode a tmux string a herdr user sees:

- `attachCommands()`: ordered argv steps for the TUI, some `optional`
  with a `reason`. It throws when the target cannot be resolved (herdr:
  no such workspace). `attachShellLine()` joins the steps into the
  printed line (`&&`, or `;` after an optional step); callers omit the
  line when the call throws.
- `healthCheck()`: version and env facts as data; `mu doctor` renders.
- `paneNotFoundNextSteps()`: borrowed by `PaneNotFoundError` from the
  backend that raised it.

`src/tmux.ts` survives as a re-export for tmux-only concerns: the
`MU_TMUX_SOCKET` test-isolation seam and the shared `sleep` /
`setSleepForTests` poll seam.

## Spawn: one backend operation

`mux.spawnAgent` creates the agent's pane (session, window or split as
needed) and runs the agent in it. tmux does that in one call. herdr has
no create-and-run form: it makes a bare shell pane, then runs
`agent start <name> --kind <cli> --pane <id>` with a busy retry, and
closes the bare pane when the start fails. spawn.ts never sees the two
halves; it branches on the capability flag `spawnAgentWaitsReady`, not
on a name:

| | tmux | herdr |
| --- | --- | --- |
| `spawnAgentWaitsReady` | false | true |
| after `spawnAgent` | mu checks pane life and startup errors | the mux returned once the agent is ready |

- **tmux.** After `MU_SPAWN_LIVENESS_MS` (default 1500, `0` skips) mu
  verifies the pane survived and scans its tail for provider or auth
  startup errors. mu does not wait for murmur to claim the pane: state
  reads before the first claim report `unknown`. A pi agent skips the
  fixed wait: mu checks the pane on every handshake tick (a dead pane
  rolls back at once) and scans for startup errors when the handshake
  ends. After an ok handshake the scan skips shell exec-failure lines
  (`command not found`, `No such file or directory`): pi demonstrably
  started, and a resumed session can show such lines as old tool output.
- **herdr.** `spawnAgent` returns once herdr detects the agent, which
  subsumes both checks. A command override (`MU_<CLI>_COMMAND`,
  `--command`) is refused with `HerdrCommandOverrideError` before herdr
  is touched.
- **pi, either backend.** After the agent starts, mu polls its control
  socket until the extension answers (`MU_SPAWN_CTL_MS`, default 30s;
  `--no-ctl` or `0` skips). A timeout is reported but not rolled back:
  the pane and pi are fine, only control is missing. See
  [control-socket.md](control-socket.md).

A backend refuses a command it cannot honour: a dropped command would
leave an empty shell that mu believes hosts an agent. The refusal and
every failure before the handshake route through `rollbackSpawn`, so no
agent row survives for an empty pane.

Spawns serialize per mux session (`src/agents/spawn-lock.ts`, over
`src/file-lock.ts`) only around the topology check-then-act and the
row insert. `spawnAgent` reports the pane through `onPaneCreated` the
moment it exists; spawn.ts finalizes the row and releases the lock
while herdr's start (up to 30s, beyond the lock's 15s acquire and 30s
stale budget) and tmux's readiness waits are still running, so a
parallel fan-out still runs in parallel.

## Reconciliation

`mu agent list` reconciles the registry against the mux before
returning. `src/reconcile.ts` is the only implementation, and
`mu doctor` calls the same routine.

1. **Prune ghosts.** Delete each `agents` row whose `pane_id` no longer
   exists.
2. **Surface orphans.** List panes in the workstream's session that
   have no row but whose foreground command is a known agent CLI. mu never
   registers them; the user closes the pane or ignores it.

The mux is the source of truth for which panes exist.

## Agent state

Runtime state is read on demand and never persisted.
`src/agent-state.ts` picks one source per agent:

| Agent | Source |
| --- | --- |
| pi (`expectsCtl`) | its control socket, probed in parallel for all pi agents |
| other CLI on herdr | herdr's native `paneStatus()` |
| other CLI on tmux | murmur: one `list-panes -a` reads `@murmur_pane_state` / `@murmur_pane_since`; agents without a local option fall back to `murmur status --json`, cached 10s |

- ctl `idle` maps to `needs_input`. murmur maps `working` → `busy`,
  `blocked` → `needs_permission`, and `idle` / `done` / `crashed` →
  `needs_input`. herdr supplies mu's states directly. See murmur's
  [stable contract](https://github.com/mu-crew/murmur/blob/main/ARCHITECTURE.md#contract).
- An absent reading is `unknown` with a reason: `ctl missing`,
  `ctl refused`, `murmur not installed`, `murmur pi extension not
  linked`, `murmur has no row`, `remote snapshot stale`, `herdr reports
  no state`, or `pane gone`.
- `agents.status` is deprecated. Inserts write `spawning` to satisfy the
  schema; nothing reads it as runtime state.
