# How to run mu with other agent CLIs

mu is built around pi, but codex, cursor-agent and claude can be its workers
or its orchestrator. They get less: they have no control socket, so mu
cannot hand them a prompt on tmux, abort them, or read their final text, and
nothing replaces `mu_delegate`. Tested with codex 0.164 and cursor-agent
2026.10.22 on tmux ([report](../mu-next/eval/harnesses.md)).

## Pin the mu the harness runs

Check this first. codex and cursor-agent run each shell command through your
interactive shell rc. If `~/.zshrc` puts another `mu` first on `PATH`, or
exports `MU_SYNC_DIR` / `MU_DB_PATH`, the harness uses that `mu` and that DB,
not the env mu gave its pane. Pin it for each harness:

- codex: `codex --disable shell_snapshot` (as `MU_CODEX_COMMAND`, or in a
  wrapper).
- cursor-agent: `ZDOTDIR=<a dir with an empty .zshrc> cursor-agent`.
- Or keep the rc file from adding `mu` and `MU_*` at all.

Then check from inside the harness:
`command -v mu; mu --version; echo "<$MU_SYNC_DIR>"`.

## Run one as a worker

On tmux, mu cannot type into a non-pi pane, so `spawn --send` and `agent
send` exit 4. Put the brief in a task note, start the agent with the prompt
as its argument, then claim:

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

- **Dialogs.** A new folder makes codex ask "Trust this folder?", and
  unreviewed hooks ask again. On tmux mu cannot answer them. Pre-trust the
  repo (`-c 'projects."<repo>".trust_level="trusted"'`; worktrees inherit the
  root's trust), or attach and press the key.
- **State** comes from murmur on tmux, from herdr on herdr. Wire murmur's
  notify hook (codex `notify`, cursor `.cursor/hooks.json` `stop`; see
  murmur's `docs/setup.md`). Without it the agent is `unknown` throughout.
  With it, you see `needs_input` when a turn ends, but never `busy`.
- **Wait on the task, not the agent.** `mu wait task:<ws>/<id>` fires when the
  worker closes it. `mu wait agent:<w>` fires only on busy → not busy, as in
  3.x: an agent already idle, or one that goes from `unknown` to
  `needs_input`, does not count. murmur's notify path never reports `busy`,
  so on tmux that wait runs to its timeout. `--until-text <re>` matches the
  pane's tail instead.
- **Stalls are approximate.** codex notifies at turn start too, so
  `--stuck-after` can report a running codex worker as stalled. Read the pane
  (`mu agent read`) before you act.
- **No abort, no CLOSE block.** Stop it with `mu agent close` (preview, then
  `--if`). The brief must end with the worker's own `mu task close`.

## Run one as the orchestrator

Install the skill (`npx skills add mu-crew/mu`) and point the harness at it.
It dispatches pi workers as usual (`spawn --worktree --task --send -`).

- **Wait on refs.** A bare `mu wait` owns only what a pi session or a managed
  pane started. From codex or cursor in a plain shell it is a usage error.
  Name what you started: `mu wait task:<ws>/<a> task:<ws>/<b>`.
- **Delegate through `scratch`**, since there is no `mu_delegate`. Spawn a pi
  agent there (the first spawn creates the workstream; `init` refuses it),
  `send --fresh --json -`, then wait on the exact ref the send prints. See
  [tasks-or-calls](../../skills/mu/recipes/tasks-or-calls.md).

## With no multiplexer

Task, DAG, `sql`, `log` and `mu wait task:` verbs work. `workstream init`,
`state`, and the agent verbs exit 5 and name the install. The child-pi
delegate (`mu delegates run`) needs pi.
