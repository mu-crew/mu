# How to choose a multiplexer backend

mu drives one multiplexer per command: tmux or
[Rex](https://www.superlogical.com/rex). Spawn, send, read, and agent
state work on both; on Rex, a non-pi agent's state needs it to
report OSC 7501 (see below). herdr was retired in mu 6: see
[Retired: herdr](#retired-herdr).

## tmux: vtmux or vanilla

mu on tmux wants **vtmux >= 3.8-rc3** with `set -s vtmux-program-status on`
(and `set -s vtmux-program-resume on` for session resume). vtmux keeps the
OSC 7501 (program status) records that pi, Claude Code and Codex emit natively,
and mu reads them directly through `paneStatus()`, as it does on Rex. No murmur
hooks are needed.

On **vanilla tmux 3.8**, which drops both sequences, pi workers still work
fully via the `ctl` socket (only the `mu/delegates` window-tab glyph is
absent). Other harnesses report `state: unknown` unless you use murmur 2.x
(`release/2.x`) hooks, or switch to vtmux or Rex. `mule` and `muzzle` are
unaffected apart from missing 7501 glyphs on TUI jobs.

On any tmux, a pi with `mu_delegate` calls still owed to it (running, queued,
or answered but not yet shown in its transcript, across an interrupt and a
reload) also sets the user pane option `@mu_pending` to that count on its own pane, beside the
`@mu_agent`/`@mu_workstream`/`@mu_role` crew tags. It unsets it at 0, when pi
exits, and when pi starts (a pi killed in the pane may have left it set).
Only the pane's own pi writes it: the one serving `$MU_CTL_SOCK`, or a pi
started outside mu. A nested `pi -p` in a mu pi pane finds the socket served
and leaves the option alone. pi writes nothing unless `$TMUX` and `$TMUX_PANE`
are well formed and the server answers with the pid `$TMUX` names, and
nothing on Rex. A stale value can still outlive a killed pi in a pane nothing
restarts, so murmur trusts `#{@mu_pending}` only while the pane reports OSC
7501 working.

Rex has no per-block options, so `@mu_role` has no Rex equivalent there. In
a Rex terminal (`$REX_SESSION` and `TERM_PROGRAM=rex`) the pane's own pi
instead reports an OSC 7501 `idle` record under id `mu/role` whose base64
`title` is `delegate` (`MU_DELEGATE=1`, checked first), `orchestrator`
(`MU_ORCHESTRATOR=1`) or `worker`, for an agent mu
placed (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`). It clears the record on every
shutdown and reports it again at the next session start. murmur records the
role while the pi lives, so it still knows it when the pi crashes. Same owner rule as
`@mu_pending`; a nested or headless pi never writes it.

## See which backend is active

```bash
mu doctor           # the environment block names it
mu doctor --json    # .environment.mux.name
```

mu picks the backend from the first rule that matches:

1. `MU_MUX=tmux` or `rex`. An unknown value (and `herdr`) fails with exit 1.
2. `$TMUX` or `$TMUX_PANE` is set: tmux.
3. `$REX_SESSION` with `TERM_PROGRAM=rex` (a Rex terminal): rex. Last,
   because tmux started in a Rex tab inherits `$REX_SESSION`.
4. The first binary that runs: tmux, then rex.
5. None: `NoMultiplexerError`, exit 5.

## Worktrees are git worktrees

`mu agent spawn --worktree` makes a git worktree. Outside a git repo it
fails with `WorktreeVcsRequiredError` (exit 4). mu has no jj, sl or
copy backend.

## Know what differs

| | tmux | Rex |
| --- | --- | --- |
| Workstream | session `mu-<ws>` | session labelled `mu-<ws>` |
| Window | window | window (a tab in Rex.app) |
| Pane id | `%15` | `block:<uuid>` |
| Attach | `tmux attach -t mu-<ws>` (a spawn prints `attach-session -t mu-<ws>:<agent>`, `-L <socket>` on a private socket, `switch-client` inside tmux) | `rex do session.select session_id=… window_id=…`: Rex.app switches to it |
| pi agent state | control socket | control socket |
| Other agents' state | the program's own OSC 7501 reports on vtmux (murmur 2.x hooks on vanilla tmux) | the program's own OSC 7501 reports |
| Send to non-pi agents | claude, codex, cursor-agent, muse: a paste confirmed by run count (`hooks`); others refused (exit 4) | a paste event, then Enter |
| Spawn | one command | one API call |
| `--mule` (remote workspace) | yes | yes |
| `--host` (remote loop) | yes | session templates only; lease and plugin job views refused |
| Pane borders, layout | set by mu | left to Rex |
| Test isolation | `MU_TMUX_SOCKET` | `MU_REX_SERVER` |

Where each agent's state comes from, per backend:
[architecture/mux.md § Agent state](../architecture/mux.md#agent-state).

## Know Rex's limits

- Attach switches Rex.app, so the app needs **Remote Control** on
  (Settings > Server > Client Info). With several apps connected, set
  `REX_CLIENT` to the one to switch.
- A pane runs its command through `$SHELL -ic`, preserving the PATH and
  credentials from your shell rc, including `SSH_AUTH_SOCK`. After rc, mu
  pins local worker identity, DB, state, sync directory, Rex server, and
  control socket. A session template instead starts with those local mu
  settings removed; it receives the remote worker's identity and socket
  through `{env}`. Rex spawns refuse csh and tcsh before launching the worker.
  Set `SHELL=/bin/sh` or another supported shell path (such as `/bin/zsh`)
  for the spawn; mu will load that shell's startup files instead.
  An rc file that execs another program
  (`[ -z "$TMUX" ] && exec tmux`) replaces the agent: guard it with
  `[[ -o interactive && -z $ZSH_EXECUTION_STRING ]]` or similar.
- A non-pi agent has a state only if it reports one with OSC 7501
  (claude and codex do). Only reports from the agent's own process count,
  not from tools it runs. With none, mu shows `unknown`.
- A multi-line send to a non-pi agent needs it to have bracketed paste
  on (claude and codex do); otherwise mu refuses rather than submit line
  by line. pi agents are sent to over their control socket, as on tmux.
- mu runs `$REX_BIN_DIR/rex` (Rex sets it in its terminals), else `rex` on
  `PATH`. The attach line it prints says `rex`, so put Rex's CLI on `PATH`
  to paste it from a shell outside Rex.
- An agent's window is created with `focus: false`; Rex.app shows it
  only when you attach.
- Lease and plugin job views are tmux-only; session templates run. See
  [placement](placement.md#refusals).

## Expect loud failures, not silent ones

If the multiplexer is down, `mu doctor` still prints a full report.
Verbs that need the multiplexer, such as spawn, send, close, and
reconcile, exit 5 with remediation steps. Verbs that only use it for
decoration, such as identity lookup and `mu workstream list`, carry on.

## Retired: herdr

mu 6 no longer drives herdr. `MU_MUX=herdr` fails with exit 1, and
`$HERDR_ENV` selects nothing. Agent rows a herdr pane left (pane id
`w1:p1`) stay in the DB as a retired foreign backend: no backend lists
their panes, so reconcile never reaps them as ghosts and never reopens
their tasks. `mu state` reports them `unknown` (`foreign backend: herdr`),
and a spawn in their workstream refuses: start a new workstream on tmux
or Rex. `agent read`, `send` and `answer` on such a row refuse, and
`mu workstream teardown` keeps it. Close the herdr pane yourself, then
drop the row with `mu agent close <name> --force`.
