# How to run mu with other agent CLIs

mu is built around pi, but codex, cursor-agent and claude can be its workers
or its orchestrator. They get less: they have no control socket, so on tmux
mu reaches them by paste and reads them from their hook events (the `hooks`
channel), with no steer and no exact acknowledgement, and nothing replaces
`mu_delegate`. Tested with codex 0.164 and cursor-agent
2026.10.22 on tmux ([report](../eval/harnesses.md)).

## Pin the mu the harness runs

Check this first. codex and cursor-agent pass mu's env (`MU_*`, `PATH`) on
to their shell tool, but they run each command through your interactive
shell rc, and the rc wins. If `~/.zshrc` puts another `mu` first on `PATH`,
or exports `MU_SYNC_DIR` / `MU_DB_PATH`, the harness uses that `mu` and
that DB. codex's `shell_environment_policy.set` does not help: it is applied
before the rc runs. Pin it for each harness:

- codex: `codex --disable shell_snapshot` (as `MU_CODEX_COMMAND`, or in a
  wrapper).
- cursor-agent: `ZDOTDIR=<a dir with an empty .zshrc> cursor-agent`.
- Or keep the rc file from adding `mu` and `MU_*` at all.

A wrapper that sets the env itself (`MU_SYNC_DIR=`, `MU_DB_PATH`,
`MU_STATE_DIR`, then `exec mu "$@"`) holds its env under any rc. Name it
something the rc does not shadow (`mun`). The skill and briefs still say
`mu`, so pin `mu` as well.

Then check from inside the harness:
`command -v mu; mu --version; echo "<$MU_SYNC_DIR>"`.

## Run one as a worker

On tmux, a local claude, codex, cursor-agent or muse worker is on the
`hooks` channel: `agent send` clears its input line, pastes, and is
confirmed when the harness's `run_count` rises (murmur's hook entries,
`murmur init`). It is refused while the agent waits on a permission dialog
(answer it: `mu agent answer worker-1 1 -w auth`) and, without `--force`,
while a turn runs or its state is unknown; an unconfirmed send reports
`ack: unknown` and is never resent. `--steer` is refused. `--interrupt` and
`mu agent abort` press Escape: codex, muse and cursor-agent confirm it, and
claude, which reports nothing, reads `idle?` until its next event. `--fresh`
sends the harness's fresh command (`/clear`, `/new`, `/new-chat`) and then the
text. A wait on the agent settles when its turn's `Stop` hook fires, with that
turn's final text, and a `CLOSE:` block in it closes the task. The text is
known only to a wait that was watching before the turn ended (start it with
`send --wait`): murmur does not say which turn wrote it. `spawn --task`
cannot hand it a brief yet, and any other CLI on tmux still exits 4. Put
the brief in a task note, start the agent with the prompt as its argument,
then claim:

```bash
mu task note build -w auth - <<'EOF'
<brief, ending with: mu task close build -w auth --evidence "...">
EOF
export MU_CODEX_COMMAND="codex --disable shell_snapshot --dangerously-bypass-approvals-and-sandbox"
mu agent spawn worker-1 -w auth --cli codex --worktree \
  --command "$MU_CODEX_COMMAND 'Do task build. Run: mu task notes build -w auth'"
mu task claim build -w auth --for worker-1
mu wait task:auth/build
```

On herdr, `--send` and `agent send` work (herdr's `agent prompt`, see
[dispatch](dispatch.md#non-pi-agents)), but herdr refuses `--command`.
On Rex, `--send`, `agent send` and `--command` all work.

- **Dialogs.** A new folder makes codex ask "Trust this folder?", and
  unreviewed hooks ask again. mu cannot answer them (`mu agent answer` is for
  permission dialogs, and the hooks do not fire before trust). Pre-trust the
  repo (`-c 'projects."<repo>".trust_level="trusted"'`; worktrees inherit the
  root's trust), or attach and press the key.
- **State** comes from murmur on tmux, from herdr on herdr, and on Rex
  from the agent's own OSC 7501 report (claude and codex send one; no
  hook needed). On tmux, wire murmur to
  the harness's stop hook (cursor: `.cursor/hooks.json` `stop`, see murmur's
  `docs/setup.md`). Without it the agent is `unknown` throughout. With it,
  you see `needs_input` when a turn ends, but never `busy`.
- **codex: use its `Stop` hook, not `notify`.** codex runs a hidden turn to
  title each new thread, and `notify` reports that turn as finished about 2 s
  into the worker's first turn. murmur then reads `done`, and `--stuck-after`
  reports the running worker as stalled (3.x does the same). `Stop` fires only
  for real turns. Drop `notify` from `~/.codex/config.toml` and put this in
  `~/.codex/hooks.json`:

  ```json
  {"hooks": {"Stop": [{"hooks": [{"type": "command",
    "command": "murmur notify --source codex --event-type agent-turn-complete"}]}]}}
  ```

  Keep `--event-type`: without it murmur reads a `Stop` payload as `blocked`.
  codex asks you to trust a new hook once (`/hooks`), and `--disable hooks`
  turns it off.
- **Wait on the task, not the agent.** `mu wait task:<ws>/<id>` fires when the
  worker closes it. `mu wait agent:<w>` fires only on busy → not busy, as in
  3.x: an agent already idle, or one that goes from `unknown` to
  `needs_input`, does not count. murmur's notify path never reports `busy`,
  so on tmux that wait runs to its timeout. `--until-text <re>` matches the
  pane's tail instead.
- **Stalls** mean the owner has read `needs_input` for `--stuck-after` while
  its task is still open. Read the pane (`mu agent read`) before you act.
- **Abort and CLOSE on `hooks` only.** On tmux, `mu agent abort` stops a turn
  and a `CLOSE:` block in its final message closes the task. Elsewhere, and
  for a turn that will not stop, use `mu agent close` (preview, then `--if`),
  and end the brief with the worker's own `mu task close`.

## Run one as the orchestrator

Install the skill (`npx skills add mu-crew/mu`) and point the harness at it.
It dispatches pi workers as usual (`spawn --worktree --task --send -`).

Start it with `mu orchestrate -w <ws> --cli <key>` so it has an identity:
its caller is `<ws>/<name>` (printed), and a bare `mu wait` owns what it
spawns. Run tmux from a terminal first: mu will not start a tmux server from
inside an agent, because every pane would inherit that agent's sandbox.

- **Keep driving with `mu hook stop`.** pi's settle wait has a twin for
  claude, codex and cursor-agent: a Stop hook entry that keeps an orchestrator
  `mu orchestrate` started from ending its turn while its workers run. It
  waits as the orchestrator (`mu wait --as <ws>/<name>`) and hands the model
  the event, or tells it to run `mu wait` in the background, at most
  `MU_KEEP_DRIVING_MAX` (20) times in a row; a background `mu wait` already
  holding the caller lets the turn end. A worker that stops still owning its
  task is told once per session to close it. Until `mu init` writes it, add the
  entry by hand: `mu hook stop claude --timeout 600 || true` under `Stop` in
  `~/.claude/settings.json` with `"timeout": 600`, the same in
  `~/.codex/hooks.json` (`codex`), and a `stop` hook in `~/.cursor/hooks.json`
  (`cursor-agent`). Keep the `|| true`: claude and codex read a Stop hook's
  exit 2 as "block and hand stderr to the model", and a mu on `PATH` older than
  the verb exits 2 on it (this mu itself always exits 0). It acts only for a pane mu started, never for a
  `claude -p` or `codex exec` that pane runs. Muse Code ignores a stop block's
  reason, so it gets no entry and follows the skill's rule.
- **Wait on refs.** A bare `mu wait` owns only what a pi session or a managed
  pane started. From codex or cursor in a plain shell it is a usage error.
  Name what you started (`mu wait task:<ws>/<a> task:<ws>/<b>`), or the
  caller (`mu wait --as <ws>/<name>`; refused while another wait holds it).
- **Delegate through `scratch`**, since there is no `mu_delegate`. Spawn a pi
  agent there (the first spawn creates the workstream; `init` refuses it),
  `send --fresh --json -`, then wait on the exact ref the send prints. See
  [tasks-or-calls](../../skills/mu/recipes/tasks-or-calls.md).

## With no multiplexer

Task, DAG, `sql`, `log` and `mu wait task:` verbs work. `workstream init`,
`state`, and the agent verbs exit 5 and name the install. The child-pi
delegate (`mu delegates run`) needs pi.
