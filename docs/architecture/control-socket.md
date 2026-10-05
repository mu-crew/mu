# Control socket

mu drives a pi agent through a unix socket served by mu's own pi
extension inside the agent's interactive pi. The pane stays pi's TUI,
so a human attached to it shares the same session. There is no
`pi --mode rpc`, no screen scraping and no daemon: the server lives and
dies with the pi process. Overview: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Path derivation

`ctlSocketPath(ws, agent)` (`src/ctl/path.ts`) is
`<state dir>/sock/<ws>/<agent>.sock`. The state dir is
`dirname($MU_DB_PATH)` or the default. If the path exceeds 103 bytes
(the macOS `sun_path` limit), it becomes
`<state dir>/sock/h/<sha1(ws/agent)[:16]>.sock`.

Nothing is stored. Spawn creates the directory (mode 0700), removes any
stale socket file at the path, and injects the path as `MU_CTL_SOCK`
into every pane. Every later verb derives the path again.

## Protocol v1

`src/ctl/protocol.ts` imports nothing from mu, so the extension loads
it standalone. Framing is JSON lines, one request per connection. Every
reply carries `v: 1`; the client (`src/ctl/client.ts`) throws
`CtlVersionError` on anything else.

| op | does |
| --- | --- |
| `hello` | identity plus `ops` (served ops) and `extVersion` (the mu version the extension was built from) |
| `status` | `state` (`busy` / `idle`), `since`, `runs`, `pending` |
| `send` | `pi.sendUserMessage`; when busy, `mode` is `steer` or `followUp` (default). Replies with the `status` fields measured before the dispatch, so `runs` is the baseline for a later `wait` |
| `wait` | resolves on pi's `agent_settled` after `afterRuns`, with the run's `lastText` |
| `abort` | `ctx.abort()` (pi's Esc) |
| `interrupt` | busy: `ctx.abort()`, wait for `agent_settled` (up to `timeoutMs`), then `pi.sendUserMessage(text)` as a new run; idle: just the send. Replies `wasBusy`, `pending` (measured before the abort) and the `status` fields measured after the settle and before the send, so `runs` is the `wait` baseline for the new run. `timeout`: nothing sent |
| `fresh` | new session plus prompt as one operation, through the internal `/mu-fresh` command; replies once the new run starts; refused with `busy` unless `force` |
| `command` | `name` `new`, `reload` or `compact` (with optional `instructions`), through the internal `/mu-new`, `/mu-reload`, `/mu-compact` commands, which call `ctx.newSession()`, `ctx.reload()`, `ctx.compact()`. `new` replies once the session is replaced, `reload` after the `session_start` it causes, `compact` when compaction starts or with pi's error (`Nothing to compact ...`). Refused with `busy` unless `force` |

`pi.sendUserMessage` dispatches only extension commands, not pi's
built-in `/new`, `/reload`, `/compact`. Each internal command is an
extension command, triggered with `expandPromptTemplates: true`, and
its handler gets the command context that can replace or reload the
session.

These back `mu agent send` (`--fresh`, `--steer`, `--interrupt`, session commands), `mu agent wait`,
`mu agent abort`, the agent state reading, and `mu_delegate`.

## Version skew

An op the extension does not serve returns `unknown op: <op>` with its
`ops` list. `mu agent send --interrupt` then composes `abort`, `wait`
and `send` itself. Any other op raises `AgentExtensionOutdatedError` (exit 4), whose
next steps are `/reload` through the mux (an extension that lacks the
`command` op cannot run it over ctl) or a respawn. `mu doctor`
probes every pi agent's socket (the `ctl` row) and flags an
`extVersion` older than the installed mu or a missing op. Its extension
row reports whether `mu link pi` installed the extension.

## Extension lifecycle

`extension/mu-pi.ts` is inert unless `MU_CTL_SOCK` is set.

- pi re-creates extension runtimes per session. The server, the run
  counters and an in-flight `fresh` therefore live in a process-global
  map (`Symbol.for("mu.pi.ctl")`).
- Session replacement (`new`, `resume`, `fork`, `reload`) keeps the
  socket and its connections. Quit closes it.

**Binding never steals a live socket.**

1. If the path already answers, another pi serves it (a nested `pi -p`
   inherited `MU_CTL_SOCK`). The extension leaves it alone and says so
   on stderr. Identity follows the bind: that pi, and one that loses
   the `link()` race, is nested and gets no keep-driving, close or
   refute nudge, though it inherited the agent's `MU_AGENT_NAME`.
   The decision lives in the process-global map, so `/reload` keeps it.
2. Otherwise it listens on a private name in the same directory, sets
   mode 0600, and hard-links that name onto the public path. libuv
   unlinks the listened-on name at close, so the public path must never
   be that name. `link()` fails on an existing path, so a racing pi
   keeps its socket.
3. It records the inode of the public path.

On quit it unlinks the public path only if the inode is still its own,
because another pi may own the path by then. On `session_start`, a
server whose file was deleted or replaced closes and rebinds. That is
how `/reload` recovers a lost socket file.

## No silent fallback

`src/agents/transport.ts` routes sends. `expectsCtl` is true when the
cli key resolves to pi (`pi` or `pi-meta` as argv0), or when a socket
file exists at the agent's derived path. The file case covers
`--cli helper --command "pi-meta ..."`, whose command is not stored.

A pi agent whose socket does not answer raises
`AgentCtlUnreachableError` for send and abort, and reads as `unknown`
with reason `ctl missing` or `ctl refused` for state. mu never pastes
into it or asks murmur instead.

The mux paste path (bracketed paste, `MU_SEND_DELAY_MS`,
`MU_SEND_READINESS_MS`) serves only:

- non-pi CLIs;
- adopted panes without ctl;
- an explicit `--via mux`.

A pi agent's `/new`, `/reload` and `/compact [instructions]` go
through the `command` op. Any other slash command to a pi agent raises
`AgentSlashCommandUnsupportedError` (exit 2), whose next step is the
same text with `--via mux`. Text such as `/tmp/x.log ...` is a plain
prompt, not a slash command. A pi agent therefore never reaches
`capturePane` or the paste timing in `src/mux/input-timing.ts`.

## Remote agents

The user's `ssh` command carries `-L <local derived path>:<remote path>`
and puts `MU_CTL_SOCK=<remote path>` in the remote env.
`mu agent remote-env` prints both and runs nothing
(`src/cli/agents-remote.ts`). mu always connects to the local path, so
local and remote agents share one transport, and state, send, wait and
abort are exact without murmur.

ssh does not create the local directory, which is why spawn makes it
first. When ssh dies it leaves the local socket file behind. That file
probes `refused`, and `mu agent close` or the reaper deletes it.

## Parent side: `mu_delegate`

`extension/delegate.ts` registers the `mu_delegate` and
`mu_delegate_cancel` tools in the operator's own pi. They are hidden
when `MU_MANAGED_AGENT` is set (inside a mu-spawned pane) or
`MU_DELEGATE=0`. The tools shell out to the `mu` CLI (spawn, send,
`wait --json`, read, abort, close) and only format the CLI's
`outcome` into a follow-up message. `delegateOutcome`
(`src/agents/delegate.ts`) maps one wait result to `done`, `empty`,
`died`, `timeout` or `pending`. The extension imports nothing from pi;
it types pi's API structurally.
