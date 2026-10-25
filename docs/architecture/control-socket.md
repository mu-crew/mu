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
| `hello` | identity plus `ops` (served ops), `features` (`incarnation`, `msgId`) and `extVersion` (the mu version the extension was built from) |
| `status` | `state` (`busy` / `idle`), `since`, `runs`, `pending`, and pi's `sessionFile` when it has one. With `msgId`, also `msg: { id, accepted, runs?, at? }`: whether that `send`/`fresh`/`interrupt` was accepted (`runs` is the baseline its reply carried) |
| `send` | `pi.sendUserMessage`; when busy, `mode` is `steer` or `followUp` (default). Replies with the `status` fields measured before the dispatch, so `runs` is the baseline for a later `wait` |
| `wait` | resolves on pi's `agent_settled` after `afterRuns`, with the run's `lastText` and pi's `sessionFile`. With `incarnation` that differs from the current one, replies `incarnation mismatch` (plus the current `incarnation`) at once, without waiting |
| `abort` | `ctx.abort()` (pi's Esc) |
| `interrupt` | busy: `ctx.abort()`, wait for `agent_settled` (up to `timeoutMs`), then `pi.sendUserMessage(text)` as a new run; idle: just the send. Replies `wasBusy`, `pending` (measured before the abort) and the `status` fields measured after the settle and before the send, so `runs` is the `wait` baseline for the new run. `timeout`: nothing sent |
| `fresh` | new session plus prompt as one operation, through the internal `/mu-fresh` command; replies once the new run starts; refused with `busy` unless `force` |
| `command` | `name` `new`, `reload` or `compact` (with optional `instructions`), through the internal `/mu-new`, `/mu-reload`, `/mu-compact` commands, which call `ctx.newSession()`, `ctx.reload()`, `ctx.compact()`. `new` replies once the session is replaced, `reload` after the `session_start` it causes, `compact` when compaction starts or with pi's error (`Nothing to compact ...`). Refused with `busy` unless `force` |

`pi.sendUserMessage` dispatches only extension commands, not pi's
built-in `/new`, `/reload`, `/compact`. Each internal command is an
extension command, triggered with `expandPromptTemplates: true`, and
its handler gets the command context that can replace or reload the
session.

Two additive fields make an ambiguous delivery checkable instead of
resendable (protocol stays v1; an old client sees only extra reply
fields):

- `incarnation`: a string in every ok reply to `hello`, `status`,
  `send`, `fresh`, `interrupt` and `wait`. It is minted once per pi
  process per socket (in the process-global map), so `/new` and `/reload`
  keep it and a pi restart changes it.
- `msgId`: an optional string of 1-64 characters on `send`, `fresh`,
  `interrupt` and `status`. The extension remembers the last 64 it
  accepted, recorded only after the message was dispatched (`send`,
  `interrupt`) or the fresh prompt landed. A longer, empty or non-string
  `msgId` is refused before any side effect.

The CLI side: every ctl `send`, `fresh` and `interrupt` carries a fresh
`msgId` (`newMsgId`) and returns `msgId`, `incarnation` and `runs`
(`SendResult`). A request that was written and got no reply gets ONE
`status {msgId}` probe (5 s): accepted is a success with
`receipt: "confirmed-after-timeout"`; anything else is
`AgentSendIndeterminateError` (exit 1) carrying the `msgId`, whose Next
is `mu agent check <a> <msgId>`. It never resends. A send/fresh right after a spawn
carries `expectIncarnation` (the spawn handshake's): the extension refuses
another incarnation before dispatching (`incarnation mismatch`, nothing
delivered), so a replacement bound at the same socket path gets no prompt.
`mu agent wait --inc`
sends `incarnation` with its `wait`; an `incarnation mismatch` reply, or a
reconnect after a dropped wait that finds another incarnation, raises
`AgentRestartedError` (exit 4) out of `waitForAgents` (a rejected watch
is fatal, never "unknown, poll it"). `abortAgent`'s own wait carries the
status's incarnation too.

These back `mu agent send` (`--fresh`, `--steer`, `--interrupt`, session commands), `mu agent wait`,
`mu agent abort`, the agent state reading, and `mu_delegate`.

## Version skew

A new CLI asks `hello` before it relies on a feature: `send`, `--fresh`
and `--interrupt` need `msgId`, `wait --inc` needs `incarnation`
(`requireFeature`, one hello per verb, never cached on disk). A pi that
loaded an older mu lacks them and the verb refuses before writing, with
`AgentExtensionOutdatedError` (exit 4). Slash commands (`/new`, `/reload`,
`/compact`) are exempt: they carry no receipt. An op the extension does
not serve returns `unknown op: <op>` with its `ops` list and raises the
same error. Its next steps, in order: `mu agent send <a> /reload` when
the extension serves `command`; else the mux's own reload line when the
backend can type one (`MuxBackend.reloadCommands`, herdr's `agent
prompt <pane> /reload`; tmux has none, so the step is omitted); else
`mu agent close <a>` then the spawn line rebuilt from the agent row
(`agents.command` and `command_source`, machine-local: an explicit
`--command` is replayed verbatim, an env or cli-key command as `--cli`;
a row older than the columns has no spawn line and omits it). `mu doctor`
probes every pi agent's socket (the `ctl` row) and flags an
`extVersion` older than the installed mu or a missing op. Its extension
row reads the live `hello` (`extVersion`, ops, features) from those probes;
with no pi agent to ask it is `unknown`, never inferred from a file.

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
   the `link()` race, is nested and gets no keep-driving or close
   nudge, though it inherited the agent's `MU_AGENT_NAME`.
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

Only non-pi CLIs reach `MuxBackend.sendToPane`, which herdr alone
implements (its atomic `agent prompt`). On tmux, a send to a non-pi
agent raises `AgentSendUnsupportedError` (exit 4): a bracketed paste
cannot be confirmed, so mu has none.

A pi agent's `/new`, `/reload` and `/compact [instructions]` go
through the `command` op. Any other slash command to a pi agent raises
`AgentSlashCommandUnsupportedError` (exit 2). Text such as
`/tmp/x.log ...` is a plain prompt, not a slash command. A pi agent
therefore never reaches `capture` or the mux send.

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
`outcome` into a follow-up message. A call runs one
`mu agent spawn --next-free --send <task> --json` (mu picks the free
name under its spawn lock and returns the send's `runs`), then one
`mu agent wait --after-runs <runs>` in the background; with `record`,
a `mu task show` comes first. `delegateOutcome`
(`src/agents/delegate.ts`) maps one wait result to `done`, `empty`,
`error`, `died`, `timeout` or `pending`. The extension imports nothing from pi;
it types pi's API structurally.
