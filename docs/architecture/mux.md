# Mux topology, backends and reconciliation

mu runs agents in multiplexer panes, tmux or herdr, behind one
`MuxBackend` interface. Overview: [ARCHITECTURE.md](../ARCHITECTURE.md).

## One mux session per workstream

One workstream is one mux session and one `session_id` partition in
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
window. Identity never depends on the window: each pane gets
`$MU_AGENT_NAME` plus a **pane title** fallback. The title carries
durable context only (agent name and owned tasks), re-pushed by
`composeAgentTitle` after each relevant change. mu enables the top
border and leaves `pane-border-format` to the user's tmux config. The
canonical tmux protocol is the comment block at the top of
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
| **Load-bearing** | propagate; `handle()` maps it to exit 5 | spawn, send, read, kill, adopt, kick, reconcile, session create and destroy |
| **Best-effort** | `try`/`catch`, degrade | actor identity, pane titles, pane borders, workstream listings, liveness polls, TUI attach |

`resolveWorkerIdentity()` in `src/tasks/claim.ts` is the canonical
best-effort shape. `reconcile()` is load-bearing on purpose: treating
an unreachable mux as "zero panes" would prune every agent as a ghost
and reap its in-progress tasks.

Three concerns belong to the backend, because each would otherwise
hardcode a tmux string a herdr user sees:

- `attachHint()` and `attachCommands()`: the printed recipe and the
  TUI's executed argv.
- `healthCheck()`: version and env facts as data; `mu doctor` renders.
- `paneNotFoundNextSteps()`: borrowed by `PaneNotFoundError` from the
  backend that raised it.

`src/tmux.ts` survives as a re-export for tmux-only concerns: the
`MU_TMUX_SOCKET` test-isolation seam and the shared `sleep` /
`setSleepForTests` poll seam.

## Spawn: create-and-run vs create-then-start

tmux creates a pane and runs a command in one call. herdr has no
create-and-run form: its creation verbs start a plain shell, and
`agent start` needs an existing pane at its prompt. mu expresses this
as a capability, not a name check:

| | tmux | herdr |
| --- | --- | --- |
| `NewWindowOptions.command` | carries the command | refused if non-empty |
| `startAgentInPane()` | absent | implemented |
| after start | mu checks pane life and startup errors, then murmur readiness for non-pi CLIs | the mux returns once the agent is ready |

`spawnAgent` branches on `mux.startAgentInPane !== undefined`.

- **tmux.** After `MU_SPAWN_LIVENESS_MS` (default 1500, `0` skips) mu
  verifies the pane survived and scans its tail for provider or auth
  startup errors. If murmur is installed, it then polls until murmur
  claims the pane (`MU_SPAWN_READINESS_MS`, default 10s). Without
  murmur that poll is skipped.
- **herdr.** mu creates a bare pane and calls `startAgentInPane`, which
  subsumes both checks.
- **pi, either backend.** After the agent starts, mu polls its control
  socket until the extension answers (`MU_SPAWN_CTL_MS`, default 30s;
  `--no-ctl` or `0` skips). A timeout is reported but not rolled back:
  the pane and pi are fine, only control is missing. See
  [control-socket.md](control-socket.md).

A creation verb refuses a command it cannot honour. A dropped command
would leave an empty shell that mu believes hosts an agent. The
refusal and every failure before the handshake route through
`rollbackSpawn`, so no agent row survives for an empty pane.

Spawns serialize per mux session (`src/agents/spawn-lock.ts`, over
`src/file-lock.ts`) only around the topology check-then-act and the
row insert. Agent start and the readiness waits sit outside the lock,
so a parallel fan-out still runs in parallel.

## Reconciliation

`mu agent list` reconciles the registry against the mux before
returning. `src/reconcile.ts` is the only implementation, and
`mu doctor` calls the same routine.

1. **Prune ghosts.** Delete each `agents` row whose `pane_id` no longer
   exists.
2. **Surface orphans.** List panes in the workstream's session that
   have no row but whose title looks like an agent name. mu never
   adopts them; the user runs `mu agent adopt <pane> [--name X]`.

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
- `src/mux/input-timing.ts` reads pane text only to decide when tmux
  input can be submitted on the paste path. It does not report state.
- `agents.status` is deprecated. Inserts write `spawning` to satisfy the
  schema; nothing reads it as runtime state.
