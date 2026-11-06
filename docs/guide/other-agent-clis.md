# How to run mu with other agent CLIs

mu treats five agent CLIs (harnesses) as first-class: pi, Claude Code
(`claude`), Codex (`codex`), cursor-agent and Muse Code (`muse`). Any of
them can orchestrate, and any can work, side by side in one crew, locally and
on remote hosts. Each worker's harness and channel are on its agents row
(`mu agent list`), so every verb picks the right path per worker.

- **pi** is on the `ctl` channel: mu's pi extension serves a control socket,
  so send, steer, abort, wait and the final text are exact, and pi delegates
  through `mu_delegate`.
- **claude, codex, cursor-agent and muse** on tmux are on the `hooks`
  channel: mu pastes into the pane and reads the harness's own hook events
  through murmur. That is close to pi, but not equal: no mid-turn steer, a
  send confirmed by the turn count rather than exactly, and no
  `mu_delegate` (their own subagents check, recorded by mu).

This page sets each one up, then says what changes when one is a worker or
the orchestrator.

## Set up a machine

Run these once per machine, and again after upgrading:

```bash
murmur init   # this node's identity, and `murmur hook <harness>` entries: hook state
mu init       # mu's Stop hook entry, skill and prompt skills
muzzle init   # optional: queue heavy shell calls (muzzle's own hook entries)
mu doctor
```

Each `init` writes entries for every harness set up here (its config
directory exists), and touches only entries it wrote: your own handlers, and
the other tools', stay as they are. `mu init --harness <names>|all` also
writes harnesses not set up yet. codex asks you to trust a new or changed hook
once (`/hooks`): until then it fires none of them.

Without murmur's entries a `hooks` agent's state is `unknown`: sends are
refused without `--force`, waits never see a turn end, and stall detection
never fires.

`mu init` never writes into `~/.agents/skills` (or `~/.pi/agent/skills`),
where pi would find a second `mu` skill. If an older `npx skills add
mu-crew/mu` put mu's skill there, `init` leaves it as found and says so:
remove it (and the links to it in each harness's skill directory), then run
`mu init` again.

### Pin the mu the harness runs

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

## Each harness

mu only starts a harness: its launcher keeps its own sandbox, auth and model
access. mu spawns the launcher on `PATH`, or the command `MU_<KEY>_COMMAND`
names (`MU_CLAUDE_COMMAND`, `MU_CURSOR_AGENT_COMMAND`), and sets no base URL,
provider, key or proxy for it.

| | Claude Code | Codex | cursor-agent | Muse Code |
| --- | --- | --- | --- | --- |
| `--cli` | `claude` | `codex` | `cursor-agent` | `muse` |
| hook config the `init`s write | `~/.claude/settings.json` | `~/.codex/hooks.json` | `~/.cursor/hooks.json` | `hooks` in `~/.config/muse/settings.json` |
| keeps driving by | `mu hook stop` | `mu hook stop` | `mu hook stop` | the skill's rule |
| interrupt confirmed | no: reads `idle?` | yes | yes | yes |
| fresh command | `/clear` | `/new` | `/new-chat` | `/new` |
| worker preset | `--permission-mode acceptEdits` | `-s workspace-write -a never` | `--sandbox enabled` | `--approval-mode never` |
| a worktree mu made | inherits the repo's trust | `-c 'projects."<path>".trust_level="trusted"'` | `--trust` | `--trust-workspace` |
| mu's skill | `~/.claude/skills/mu` | `~/.codex/skills/mu` | Claude Code's or Codex's, else `~/.cursor/skills/mu` | `muse skills` |
| failed turn under `mu task auto` | retried once in place | not reported | retried once in place | parked as a human need |

Every row takes `--model <id>` through its own `--model` flag. The prompts pi
gets as commands (`/mu-review`, `/ultrathink`) are skills of the same name for
claude and cursor-agent: `/mu-review <target>`. They run only when you invoke
them (`disable-model-invocation`), so the model never starts a crew on its
own. codex gets none: it has no verified way to keep a skill from its model.

### Claude Code

- An interrupt fires no hook, so mu records it itself: the agent reads
  `idle?` until its next event. A send to `idle?` is allowed; if the Escape
  only closed an overlay, that send reports `ack: unknown`.
- Its subagents fire `SubagentStop`, not `Stop`, so they change no state.
- A worktree of a repo you trusted needs no flag.
- museum backs up its transcripts (`~/.claude/projects/`).

### Codex

- Folder trust is per exact path, so a `--worktree` spawn passes the
  `projects` override for the worktree it made. Hook trust is per hook
  definition: trust mu's and murmur's entries once (`/hooks`), and every
  worktree keeps it. `--disable hooks` turns them all off.
- Drop `notify` (`murmur notify`) from `~/.codex/config.toml`: murmur's hook
  entries replace it. codex runs a hidden turn to title each new thread, and
  `notify` reported that turn as finished seconds into the worker's first
  one. murmur drops that session's hook events.
- Its session starts with the first prompt, so a task spawn does not wait
  for one before it pastes.
- A failed turn reports nothing: `mu task auto` neither retries nor parks it.
- museum backs up its sessions (`~/.codex/sessions/`).

### cursor-agent

- It has no permission hook, so a dialog it waits on never reads `blocked`.
  Read the pane (`mu agent read`).
- It also reads Claude Code's and Codex's skill directories, so `mu init`
  gives it its own copies only when neither holds them: it sees one `mu`.
- `--force` (approve everything) is never a preset: pass it yourself in
  `--command` if you want it.
- Its last text can arrive after its `stop` event; murmur joins them.
- muzzle cannot rewrite its shell calls. It denies a heavy one with the exact
  `muzzle run` line to run instead.
- museum does not back up its chats: they are live SQLite databases.

### Muse Code

- `murmur init` writes Muse-format entries under the `hooks` key of
  `~/.config/muse/settings.json`, the only form that receives Muse's
  `Interrupt` event. A Claude-format plugin also works, behind
  `MUSE_EXPERIMENTAL_PLUGINS`, without `Interrupt`.
- Its hooks run with a cleared environment (no `$TMUX`, no `MU_*`), so they
  find the agent through mu's anchor file, which every pane mu starts writes.
- A Stop block does not hand the model its reason, so mu writes no Stop hook
  entry for it. A Muse orchestrator keeps driving by the skill's rule, and a
  Muse worker gets no close nudge.
- `mu init` does not install skills for it: add the package's `skills/mu`
  with Muse's own `muse skills`.
- `/new` is refused while a subagent runs.
- Its failed-turn event is unverified, so `mu task auto` parks a failed turn
  as a human need.

## Run one as a worker

On tmux, a local `hooks` worker gets a paste: `agent send` clears its input
line, pastes, and is confirmed when the harness's `run_count` rises. It is
refused while the agent waits on a permission dialog (answer it:
`mu agent answer worker-1 1 -w auth`) and, without `--force`, while a turn
runs or its state is unknown; an unconfirmed send reports `ack: unknown` and
is never resent. `--steer` is refused. `--interrupt` and `mu agent abort`
press Escape. `--fresh` sends the harness's fresh command and then the text.
A wait on the agent settles when the turn's stop hook fires, with that turn's
final text, and a `CLOSE:` block in it closes the task. Any wait knows the
text, even one started after the turn ended. With a murmur older than
`last_text_run`, only a wait that was watching before the turn ended knows it
(start it with `send --wait`).

`spawn --task` hands it the brief. The worker starts with no prompt; mu
waits for its `session_start` (claude and cursor-agent report one as they
start; codex and muse only with their first prompt), writes the brief to
`.mu/brief-<agent>-<attempt>.md` in its cwd (`.mu/.gitignore` keeps the
worktree clean), and pastes one line telling it to read that file. An
unconfirmed paste leaves the attempt `unknown`; a replay of the same command
reads the inbox and reports it `sent` once the worker's run shows. The
worker gets its row's preset unless its command already picks an approval or
sandbox mode, and a `--worktree` spawn adds the trust flag. Any CLI outside
the five still exits 4 on tmux, and refuses `--model`.

```bash
mu agent spawn worker-1 -w auth --cli codex --worktree --task build --send - <<'EOF'
<brief, ending with: mu task close build -w auth --evidence "...">
EOF
mu wait task:auth/build
```

- **Wait on the task.** `mu wait task:<ws>/<id>` fires when the worker closes
  it, or when its `CLOSE:` block does.
- **A worker that never trusts** its folder or its hooks fires no events,
  and its task spawn ends `unknown`. A `--worktree` spawn passes the trust
  flag for the worktree it made; elsewhere pre-trust the folder, or attach
  and press the key. `mu agent answer` is for permission dialogs only.
- **Stalls** mean the owner has read `needs_input` for `--stuck-after` while
  its task is still open. Read the pane (`mu agent read`) before you act. A
  worker queued in muzzle is waiting, never stalled.
- **On herdr and Rex** a non-pi agent is on the `mux` channel: `--send` and
  `agent send` work (herdr's `agent prompt`, see
  [dispatch](dispatch.md#non-pi-agents)), state comes from herdr or the
  agent's own OSC 7501 report, and abort and `CLOSE:` blocks do not work.
  herdr refuses `--command`. Stop a turn there with `mu agent close`, and end
  the brief with the worker's own `mu task close`.

## Run one as the orchestrator

Start it with `mu orchestrate -w <ws> --cli <key>`, so it has an identity:
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
  task is told once per session to close it. `mu init` writes the entry:
  `mu hook stop claude --timeout 600 || true` under `Stop` in
  `~/.claude/settings.json` with `"timeout": 600`, the same in
  `~/.codex/hooks.json` (`codex`), and a `stop` hook in `~/.cursor/hooks.json`
  (`cursor-agent`, with `"loop_limit": null`). An entry you wrote yourself
  that runs `mu hook stop` stays as it is, and `init` keeps none of its own
  beside it. Keep the `|| true`: claude and codex read a Stop hook's exit 2
  as "block and hand stderr to the model", and a mu on `PATH` older than the
  verb exits 2 on it (this mu itself always exits 0). It acts only for a pane
  mu started, never for a `claude -p` or `codex exec` that pane runs.
- **Wait on refs.** A bare `mu wait` owns only what a pi session or a managed
  pane started. From a harness in a plain shell it is a usage error. Name
  what you started (`mu wait task:<ws>/<a> task:<ws>/<b>`), or the caller
  (`mu wait --as <ws>/<name>`; refused while another wait holds it).
- **Check with native subagents, recorded.** There is no `mu_delegate`, so
  the harness's own subagents refute claims, findings and plans, and mu
  records each check: `mu task check <id> -w <ws> --by claude/opus --brief -`
  prints `check=<id>`, and `mu task verdict <id> -w <ws> --check <check> -`
  records its `VERDICT:` and `EVIDENCE:` lines. `mu state` lists every check
  still without a verdict, so a replacement orchestrator sees what a crash
  lost, and `close --if-ready` waits for them. For one refuter of each high
  or critical finding, use another model family: a pane in `scratch` (the
  first spawn creates the workstream), recorded the same way. Its first
  check is `mu agent send <name> -w scratch --force --wait -`: a new codex
  or muse pane reports no session before its first prompt, so it reads
  `unknown`, which only `--force` passes (a dialog is still refused); a
  later check on the same pane uses `--fresh --wait`. See
  [tasks-or-calls](../../skills/mu/recipes/tasks-or-calls.md).
- **Workers of any harness.** It dispatches pi workers as usual
  (`spawn --worktree --task --send -`) and `hooks` workers as above, mixed.

## pi on the `hooks` channel

If a pi build cannot load murmur's store or a native module, spawn it with
`MU_PI_CHANNEL=hooks` set (local, on tmux). Its row records `hooks`, so mu
drives it like the harnesses above, and murmur's pi extension writes inbox
events instead of opening its store. mu's pi extension still serves ctl for
the spawn handshake, delegates and `mu doctor`. It does not help a build that
loads no extensions. Unset, pi stays on ctl.

A `--task` spawn hands it the brief as the harnesses above get theirs: a
brief file and a pasted pointer.

## On a remote host

A remote claude, codex, cursor-agent or muse worker is on `hooks` too, with a
remote key: run `murmur init` on the host, and see
[Run a worker on another machine](remote.md#a-claude-codex-cursor-agent-or-muse-worker).

## With no multiplexer

Task, DAG, `sql`, `log` and `mu wait task:` verbs work. `workstream init`,
`state`, and the agent verbs exit 5 and name the install. The child-pi
delegate (`mu delegates run`) needs pi.
