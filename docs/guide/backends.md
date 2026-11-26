# How to choose a multiplexer backend

mu drives one multiplexer per command: tmux,
[herdr](https://github.com/herdrdev/herdr) or
[Rex](https://www.superlogical.com/rex). Spawn, send, read, and agent
state work on all three; on Rex, a non-pi agent's state needs it to
report OSC 7501 (see below).

## tmux: vtmux or vanilla

mu on tmux wants **vtmux >= 3.8-rc3** with `set -s vtmux-program-status on` and
`set -s vtmux-program-resume on`. vtmux keeps the OSC 7501 (program status) and
OSC 7577 (program resume) records that pi, Claude Code and Codex emit, and mu
reads them natively through `paneStatus()`, as it does on Rex. No murmur hooks
are needed.

On **vanilla tmux 3.8**, which drops both sequences, pi workers still work
fully via the `ctl` socket (only the `mu/delegates` window-tab glyph is
absent). Other harnesses report `state: unknown` unless you use murmur 2.x
(`release/2.x`) hooks, or switch to vtmux or Rex. `mule` and `muzzle` are
unaffected apart from missing 7501 glyphs on TUI jobs.

## See which backend is active

```bash
mu doctor           # the environment block names it
mu doctor --json    # .environment.mux.name
```

mu picks the backend from the first rule that matches:

1. `MU_MUX=tmux`, `herdr` or `rex`. An unknown value fails with exit 1.
2. `HERDR_ENV=1`: herdr. This wins over tmux variables, because a herdr
   pane can host a tmux server.
3. `$TMUX` or `$TMUX_PANE` is set: tmux.
4. `$REX_SESSION` with `TERM_PROGRAM=rex` (a Rex terminal): rex. Last,
   because tmux or herdr started in a Rex tab inherit `$REX_SESSION`.
5. The first binary that runs: tmux, then herdr, then rex.
6. None: `NoMultiplexerError`, exit 5.

## Worktrees are git worktrees

`mu agent spawn --worktree` makes a git worktree. Outside a git repo it
fails with `WorktreeVcsRequiredError` (exit 4). mu has no jj, sl or
copy backend.

## Know what differs

| | tmux | herdr | Rex |
| --- | --- | --- | --- |
| Workstream | session `mu-<ws>` | workspace labelled `mu-<ws>` | session labelled `mu-<ws>` |
| Window | window | tab | window (a tab in Rex.app) |
| Pane id | `%15` | `w1:p1` | `block:<uuid>` |
| Attach | `tmux attach -t mu-<ws>` (a spawn prints `attach-session -t mu-<ws>:<agent>`, `-L <socket>` on a private socket, `switch-client` inside tmux) | `herdr workspace focus <id>`, then `herdr` outside a herdr pane | `rex do session.select session_id=… window_id=…`: Rex.app switches to it |
| pi agent state | control socket | control socket | control socket |
| Other agents' state | the program's own OSC 7501 reports on vtmux (murmur 2.x hooks on vanilla tmux) | herdr | the program's own OSC 7501 reports |
| Send to non-pi agents | claude, codex, cursor-agent, muse: a paste confirmed by run count (`hooks`); others refused (exit 4) | one atomic `agent prompt` | a paste event, then Enter |
| Spawn | one command | bare pane, then `agent start` | one API call |
| `--mule` (remote workspace) | yes | refused | yes |
| `--host` (remote loop) | yes | refused | session templates only; lease and plugin job views refused |
| Pane borders, layout | set by mu | left to herdr | left to Rex |
| Test isolation | `MU_TMUX_SOCKET` | `MU_HERDR_SESSION` | `MU_REX_SERVER` |

Where each agent's state comes from, per backend:
[architecture/mux.md § Agent state](../architecture/mux.md#agent-state).

## Know herdr's limits

- `mu agent read --lines` cannot recover rows that scrolled off a pane
  on the alternate screen.
- herdr starts the agent binary itself (`herdr agent start --kind
  <cli>`), so spawn refuses `--command` and `MU_<CLI>_COMMAND` with
  exit 2 instead of running a different binary. Unset the variable, or
  spawn with `MU_MUX=tmux`.
- For remote spawns and reattaches, use tmux (Rex also supports local
  loops and session templates): herdr cannot run the managed argv, carrier
  command, or job view in a pane. `mu host exec`
  still works because it calls the host's link without opening a pane.
- herdr creates every workspace detached. Run `herdr workspace focus`
  yourself.

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

A herdr argument error raises `HerdrSyntaxError`, not a multiplexer
error. It means herdr's CLI changed and mu needs a fix. The herdr
server is fine.
