# How to run a worker on another machine

The pane is local and the agent is remote. A pi session worker uses a
forwarded control socket. On tmux, session workers running claude, codex,
cursor-agent or muse use remote [`hooks`](#a-claude-codex-cursor-agent-or-muse-worker).
On Rex they use `mux`: no hook receipt or hook-based `CLOSE:` processing.
For plugin jobs, check `mu agent list`: a plugin can declare its own channel.
Lease and plugin job views (any `--plugin` profile, even one that stores
`transport=session`) run on tmux only ([ladder](remote-ladder.md#refusals)).
mu never connects and
knows no ssh flags: a host profile holds your own command templates, and
`mu agent spawn --host` fills them. The full recipe, with collecting and
the traps, is in
[skills/mu/recipes/remote-workers.md](../../skills/mu/recipes/remote-workers.md).
Read it before your first remote spawn. Which rung fits (a one-off
`mu host exec`, a session pane, a lease, a provider host) is in
[the ladder](remote-ladder.md); this page covers rungs 3 to 5 and the
shared profile grammar.

## Prepare the host

1. On the host, install the harnesses its workers run. For pi, add the mu
   package: `pi install npm:@mu-crew/mu`. For claude, codex, cursor-agent or
   muse, add murmur and its hook entries (`murmur init`). Log each harness in
   there yourself. The host needs no mu DB: a remote worker
   cannot run `mu task` verbs. Ask it to end with a `CLOSE:` block. For
   `ctl` and `hooks` workers, `mu wait` applies it on settle; `mu agent wait`
   does not. Without that channel support, read the report, re-run the
   evidence and close the task yourself.
2. For pi workers, allow unix-socket forwards in the host's sshd:
   `AllowStreamLocalForwarding yes`.
3. Have a git repo there for `--worktree` to branch from. One profile serves
   every repo on the host: `--max-sessions` caps the machine, so never add
   the same machine twice.

Use one orchestrator DB on your machine. Do not run a second mu on the
host for the same work: task ownership points into your local `agents`
table.

## Run one command without an agent

`mu host exec dev -- <cmd>` runs a single command through the host's link
and returns its exit. No agent, pane or task, so it works on herdr
too. Details and limits: [rung 1](remote-ladder.md#rung-1-mu-host-exec).

## Add a profile and check it

```bash
mu host init dev --ssh --template   # prints a starter `mu host add`; runs nothing
```

The starter, as printed (it already sets `--max-sessions 2`: one live worker plus
one transient slot for collect or hook exec; run it unchanged):

```bash
mu host add dev \
  --shell 'ssh -o ControlMaster=no -o ControlPath=none -o StreamLocalBindUnlink=yes -o ExitOnForwardFailure=yes -L {local_sock}:{remote_sock} dev -t '"'"'cd {cwd:sh} && {env} "$SHELL" -ilc {cmd:sh}'"'"'' \
  --exec 'ssh -o ControlMaster=no -o ControlPath=none -o BatchMode=yes dev {cmd}' \
  --fetch 'git fetch ssh://dev{cwd} HEAD' \
  --max-sessions 2
mu host check dev --root '~/repo'   # host answers, repo, harnesses and hooks, pi and mu extension
```

A live session pane uses a slot. Set mu's `--max-sessions` to the number of
live panes plus at least one for collect, hook brief writes and hook reads.
This is mu's cap across connections, not sshd's per-connection `MaxSessions`.

## Spawn the agent

```bash
mu agent spawn worker-1 -w auth --host dev --worktree --root '~/repo' --task build --send - <<'EOF'
<the whole brief: the host has no mu DB, so no `Read: mu task notes` line>
EOF
```

Without `--send`, `--host --task` sends the task's authored brief note. It refuses (exit 2)
when the task has none, or only the one-line fallback an earlier local spawn pinned.

- The pane runs the profile's `--shell` template, filled with the remote
  identity (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`,
  `MU_CTL_SOCK`, `MU_REMOTE`, never your DB, state or sync dir, which are unset in the pane), your
  `--command` (default `pi`), the local and remote socket paths and the
  remote cwd. The template starts the remote pi and forwards its control
  socket to the local derived path.
- `--worktree` makes a detached `git worktree add` in the remote repo
  `--root` names (default: the profile's `--repo`; with neither the spawn
  refuses) through its `--exec`, at
  `~/.local/state/mu-next/remote-worktrees/<ws>/<name>` on the host. Its path,
  base commit and the repo's absolute toplevel are the agent's `cwd`, `base`
  and `repo`; close and recovery use that repo, never the profile's.
  The base is `--from` (default `HEAD`) resolved in your checkout, so run
  the spawn inside it. mu never fetches or pushes for a static host: a host
  repo without that commit refuses, naming the sha and the fix (fetch it on
  the host, or push it somewhere the host can fetch first); retry with
  `--from <sha>`.
  `--cwd` names an existing remote directory instead; without either, the
  agent starts in `--root` (default the profile's repo), else the login
  directory. Without a repo, templates get `.` for `{cwd}`. `--root` is part
  of a `--task` attempt's identity: the same attempt in another repo conflicts.
- `--task` without `--send` sends the task's brief note in full (the host has
  no mu DB, so never a `Read: mu task notes` pointer). A task with no brief
  note is refused (exit 2) before anything is spawned: pass `--send`, as above.
  Local spawns still fall back to a one-line title pointer.
- `--task` is the same one journaled attempt as for a local agent: claim
  for the new agent, then the brief, never sent twice.
- mu reserves the host's channel before its first remote command and
  keeps it while the pane lives (`--max-sessions` counts it; one exception
  under the path rule below). A full host
  refuses the spawn up front and names the holder. A failed spawn removes
  only the worktree it made (still clean, still at its base) and frees
  the slot. If the host's answer was lost after it made the worktree (a
  timeout), spawning the same name again takes that tree over only if its
  prepare marker names this DB and the tree is clean, at its base and unused.
  A different DB or an unknown owner (empty or missing marker) refuses with
  exit 4. If the owning DB is a known sync peer, the refusal shows the same
  prefix as `mu sync`. Close the tree from its owning DB, or verify it is
  unused and remove it by hand. All DBs sharing the host must run a version
  that checks the marker; older versions ignore its contents.
- The pane is the connection: closing it, or its death, ends the agent
  and frees the slot. A session-template pane runs on tmux and Rex; herdr
  refuses `--host` in one line. Lease and plugin job views need tmux.
  A workstream's panes live on one backend: a spawn refuses while a row names
  another ([ladder](remote-ladder.md#one-backend-per-workstream)).
- A spawn without `--worktree` refuses (exit 4, `RemotePathOwnedError`) when
  the cwd its exec resolved (`pwd -P`) is exactly, on that host profile,
  another agent's managed remote worktree (one mu made with `--worktree`, in
  any workstream) or the path or parked aside of any `remote_recovery`
  record: mu's close removes that tree and collect credits its commits to its
  owner, so a second user loses work. The refusal names the owner and the way
  out: close it, collect then close the record (`--recovery <id>`), or give
  the new agent its own tree (`--worktree --from <the owner's commit>`, also
  for a reviewer). A command gate cannot take `--worktree`: it is offered the
  owner's close or the gate in an unmanaged checkout (`--cwd <repo root>`,
  unless that root is itself a managed tree).
  Agents sharing an unmanaged checkout (the repo root, a user directory) are
  not refused. Only the exact path is checked, per
  profile name: a subdirectory of the tree, or the same host reached through
  another profile, is not. The check runs before any pane, so the agent never
  starts, and again with the row's insert. An owner that lands while the pane
  opens is refused there: the pane is killed, or, if mu cannot prove it gone,
  the error names its id, backend and kill command, and the pane may still
  run its transport. That pane has no agent row and is not reliably surfaced
  by `mu agent list`; orphan recognition uses foreground-command names and
  CLI overrides within the default workstream session. Use the refusal's
  backend-specific kill command. Its session channel may be reclaimed once
  the spawning process exits, so `host check` and the channel count can
  undercount until it is killed. A pane id another agent's row holds by then
  is left alone, and the error says so with no kill command.
- A non-pi `--command` (`--host dev --command 'npm test'`, no `--cli pi`) is a
  **command gate**, not a worker: its pane is kept after the command ends, and
  `mu wait agent:auth/gate-1` returns the command's own exit status (the
  `exit` of the result and of the process; 23 stays 23) when the gate's event
  fires. Never a held
  `ssh dev …`. The remote command writes a token-bound completion record that
  mu reads once the pane has exited; no record, a signal or a lost connection is
  exit 6, never 0. Close the gate after it fires, since the close removes
  the record. Preview with `mu agent close gate-1 -w auth`, then run
  `mu agent close gate-1 -w auth --if <rev>` to free the pane and remove
  the record. No `--worktree`, no `--task`.
- If the spawn reports `ctl refused` or `missing`, run
  `mu host check dev --agent worker-1 -w auth`, then check
  `AllowStreamLocalForwarding` on the host.

## Drive it like a local agent

A pi worker's `mu agent send`, `wait`, `abort` and `check` go through the
forwarded socket and behave as they do locally. `mu state` shows remote workers
as agent records with `host`, `cwd`, `base` and `collected_head`.

## A claude, codex, cursor-agent or muse worker

With a session template on tmux, `--cli claude` (or `codex`, `cursor-agent`,
`muse`) uses `hooks`. Install the hooks on the host (`murmur init` there),
and put `murmur` on the PATH the profile's `--exec` sees.

- The worker gets its row's auto-approve preset in its remote command, as
  a local worker does.
- The spawn gives the worker a remote key (`MU_REMOTE_KEY` and its anchor).
  Its hooks on the host write under that key to murmur's remote area, never
  the host's own `murmur status`.
- On tmux the local pane carries `@mu_host <host>`, so murmur names the
  host the worker runs on rather than `here`.
- mu reads that area with `murmur pane --remote <key> --json` through
  `--exec`, and copies what it read into the local pane's inbox, only on a
  send (and `--interrupt`, abort, answer), during `mu agent wait` and `mu
  wait` (every few seconds), and on `collect`. Each read is one `--exec`
  and passes the host's channel admission: at `--max-sessions 1` the
  worker's pane holds the only slot, so give such a host 2 or more.
- `mu agent send` pastes into the pane and returns `ack: sent`; the next
  wait confirms the run. A host that cannot be read makes the send `unknown`
  (`--force` pastes anyway). `--interrupt` and abort press Escape. codex,
  muse and cursor-agent report their own interrupt, which reads confirmed
  (`idle`) once it reaches the host; otherwise mu records the interrupt on
  the host (`idle?`). `--fresh` is refused: send the harness's fresh command,
  then the text.
- `mu wait` applies the worker's `CLOSE:` block when it sees the turn end;
  `collect` applies it too, once its commits are pinned, but only from the
  turn that wrote it: a turn that failed or ended without text applies
  nothing. Either way it is applied once.
- `--task` hands it the brief as a local `hooks` worker gets it: mu reads the
  host until the worker reports its session (claude and cursor-agent; codex
  and muse are read once), writes the brief to
  `<remote cwd>/.mu/brief-<agent>-<attempt key>.md` (with `.mu/.gitignore`)
  through one `--exec`, and pastes a one-line pointer (`ack: sent`, confirmed
  by the next read). The brief travels inside that command as one argument:
  exec templates have no stdin, so a brief over 96 KB (its `\` and `'`
  counted escaped) is refused before anything is spawned
  (`RemoteBriefTooLargeError`, exit 2), and so is a write whose filled exec
  template would reach Linux's 128 KiB on one argument. At
  `--max-sessions 1` the pane holds the only slot and the write is refused
  (unsent, rolled back).
- A `--command` whose argv0 is a harness (`claude --model opus`), or a
  `--cli` key that maps to one (`--cli claude-big`), is a worker, not a
  command gate.

## What a host can run

`mu host check` resolves each harness's launcher by name (`claude`, `codex`,
`cursor-agent`, `muse`, `pi`) in the shell a spawn's command gets: a session
profile's login shell (`$SHELL -ilc`), a lease job's bare `sh -c` (no rc
files, so a `MU_<KEY>_COMMAND` set in a shell rc there proves nothing). A
remote spawn runs its literal command and never reads your local
`MU_<KEY>_COMMAND`. A login profile that execs another shell on a tty
(`exec zsh -l` in `~/.bash_profile`) replaces the template's shell before it
runs pi, and no flag in the template stops that. `host check` can pass (it
has no tty) while the pane sits at a prompt. When the forward is up, pi never
answers and the live pane's last line looks like a prompt, spawn names this as
the likely cause. Start that shell by its absolute path in the template
(`/usr/bin/zsh -ilc`).

- The `harnesses` step lists what it found; it fails only when it found none.
  The `hooks` step needs murmur's `murmur hook <harness>` entries in each found
  hook harness's own config (`murmur init` on the host); a missing
  `mu hook stop` entry is a warning (it never acts for a remote worker).
- The pi and `extension` steps run only when the host has pi, so a
  claude-only host passes.
- The result and its time are recorded on the profile (`host show`, the
  `HARNESSES` column of `host list`). A spawn whose command is a harness the
  last check did not find is refused before any effect
  (`HostHarnessMissingError`, exit 2, naming host and harness). A host never
  checked, or a wrapper command the check did not try, is not refused.
- Logging each harness in on each host stays your job.

## Collect and close

```bash
cd ~/repo                              # the local repo the commits come home to
mu agent collect worker-1 -w auth      # runs the profile's --fetch, prints the merge
git merge <sha>                        # mu prints the exact sha; it never merges
mu agent close worker-1 -w auth        # preview; copy its revision
mu agent close worker-1 -w auth --if <rev>
```

- `collect` runs the `--fetch` template locally, in the current directory's
  git repo, under one channel. It pins the fetched commit as
  `refs/mu/collect/<ws>/<agent>` (gc keeps it) and records it as the
  agent's `collected_head`. A fetch that fails, or succeeds without leaving a
  commit, records nothing. Collecting the same HEAD again says so.
- The pane is the connection, so a live worker holds its host's channel. At
  `--max-sessions 1`, `collect` is refused with the holder named; raise the
  cap to collect while the worker runs.
- `close` kills the pane first (that frees the channel), then removes the
  remote worktree **only if** it is clean, its HEAD is the base, the
  collected HEAD or on a branch (or remote-tracking ref) of the root repo
  (checked again just before the removal), and no process on the host is
  inside it. Its `git worktree
  remove` never uses git's `--force`. A process still inside it after a
  30 s wait, or a host with
  neither /proc nor lsof to check, refuses naming `close --force`, which
  removes past either with a warning. A newer HEAD refuses with one line:
  `collect` again, or preview with `--keep-branch` and apply with
  `--keep-branch --if <rev>` to keep the commits on the remote
  branch `mu/<ws>/<agent>-<sha12>` and remove the worktree. Uncommitted files
  always refuse (`--discard` and `--keep-branch` do not override that).
- A `--cwd` agent has no remote worktree of its own: close never touches the
  host. When a row is deleted (its pane died and the
  reaper took it, a workstream teardown, a peer's workstream delete, even a raw
  SQL delete) the database keeps a
  machine-local `remote_recovery` record of the host, path and base (`mu sql
  "select * from remote_recovery"`; `mu rebuild` loses it). A failed spawn whose
  own rollback removed the tree (or found it gone) leaves none. With no agent row left,
  `mu agent close <name> -w <ws>` (or a qualified name) previews that
  worktree; repeat with `--if <rev>` to close it (no pane, no task; the
  recorded host profile only). `mu agent collect <name> -w <ws>` fetches from
  it. Several records of one name need `--recovery <id>` (on preview and
  apply). A current agent of the name or path, a newer record of the same
  path, or a changed `--exec` refuses (a changed default repo does not).
  While a record exists, a `--worktree` spawn of that name on the recorded
  profile refuses (exit 4): collect, then close the record first. Another
  profile cannot reclaim an existing tree of that name either, but can
  create a tree if the path is free.

## Host profiles

A host profile stores your own command templates, so you stop retyping
them. mu never connects and knows no ssh flags: it fills the templates and
runs them with `/bin/sh -c`. `spawn --host` uses them (above); `agent
collect` runs the `--fetch` template.

```bash
mu host init dev --ssh --template   # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --max-sessions 2
mu host check dev --root '~/repo'   # host answers, repo, harnesses and hooks, pi and mu extension
mu host show dev              # templates and the holders of its channels
```

- Placeholders: `{env}` (the five `MU_*` identity variables only), `{cmd}`,
  `{local_sock}`, `{remote_sock}`, `{cwd}`; a lease profile adds `{job_file}`
  (its `shell`, exactly once) and `{job}` (its `stop`, required). A name valid
  in only some fields is refused in the others. Each value is one quoted word and
  is exactly the text you passed, also inside your own `"..."` or `'...'`.
  A template that hands command text to a second shell (ssh's remote login
  shell) says so per placeholder: `{cmd:sh}`, `{cwd:sh}` quote the value for
  that shell too. Write `{{` and `}}` for literal braces. Anything else in
  braces is refused.
- A command that times out, or whose caller is killed, takes its whole process
  group with it (TERM, then KILL after 5 s) before its channel is freed, so
  `--max-sessions` never undercounts a live connection (except a pane a
  path-owner refusal could not prove gone: see [Spawn the agent](#spawn-the-agent)).
- An `exec` or `fetch` template that exits 3 is a hand-back (a hardware key, a
  prompt): mu stops with exit 5, `human needed`, and the template's first line.
  Never retried; `host check` reports a `handback` step.
- A `shell` template may ride a shared ssh master. The starter keeps `-o
  ControlMaster=no -o ControlPath=none` so each pane's forward dies with it;
  where only master reuse connects, drop both. On a session-capped host use a
  lease ([below](#session-capped-hosts)).
- Where a fresh ssh connection from the agent's process tree is impossible
  (the OS blocks a new connection or the key file from that tree, so `ssh -o
  ControlMaster=no -o ControlPath=none` fails inside the pane but works in your terminal),
  drop both options so the templates ride your master, or use the
  [mule plugin](plugins.md#register-the-mule-plugin): you open mule's private
  master from your own terminal, and exec and the pane ride it. The plugin has
  no fetch: `collect` needs its own working `--fetch` (the default is git over
  ssh, which hits the same block), so give `host add` a `--fetch` command that
  works from the agent's tree, or commits stay stranded on the host.
- `mu host show` and `list` print the transport (`session` or `lease`) and,
  for a lease, the `stop` template.
- `--max-sessions N` counts every channel mu holds for the profile. At the cap
  mu refuses with one line naming the holder. Use one mu-counted profile per
  machine for admission caps: two profiles count separately even if they
  reach the same machine. The SSH session starter uses
  `2` so a collect or brief exec fits beside one live pane. The starter's
  pane and exec each open their own SSH connection; sshd's per-connection
  `MaxSessions 1` does not require a mu cap of `1`. A mule plugin link
  declares its own admission (`slots: self`): its exec, prepare and lease
  view take no mu slot, so `--max-sessions` does not cap them. Only the
  `--fetch` template fallback (collect) can take one.
- `host check --agent <name> -w <ws>` also probes that agent's forwarded
  control socket, and on a lease agent reports its recorded job handle.
- A registered plugin can be a host's link instead of `--shell` and
  `--exec`: `mu plugin add box -- /abs/mu-plugin-box`, then `mu host add dev
  --plugin box` (plus `--fetch '<fetch cmd>'` when the plugin's link does not
  fetch). An agent spawns on it when the plugin declares a job seam. See
  [Use a plugin](plugins.md).

## Provider hosts

A host can also come from a provider plugin (`mu plugin add`) instead of
a profile: a machine provisioned on demand.

```bash
mu host acquire box1 --provider cloud --param size=large --repo /work/repo
mu host list                 # asks each provider host its status once
mu host drain box1           # no new spawns; agents keep running
mu host release box1         # once no agent, job or recovery record names it
```

A crashed or unanswered acquire stays `acquiring`: run the same
`mu host acquire` again and it resolves that request, never acquiring a
second host. A host the provider reports gone is `lost`: closing its
agents records their trees gone, and a final collect still owed there is
kept as uncollected work. To drop it, preview with
`mu agent close <name> -w <ws> --abandon-job`, then repeat with `--if <rev>`.
`mu host release <name> --abandon` drops the host and every record of
it without asking the provider, and logs what was lost. Inside
`MU_HOST_DEADLINE_MARGIN_MS` of the provider's deadline, spawns refuse
and the host drains, `mu wait` fires `deadline` (exit 7) for its agents,
and `mu state` lists their collect and close.

If the provider reports an idle-reclaim window and mu has no active job
recorded, `mu host exec` and `mu agent spawn --host` warn on stderr before
acting. The window is not time remaining, and mu does not keep the host
alive. Use a standing host for work that must survive reclaim.

```bash
mu agent spawn w1 -w auth --host box1 --worktree --cli claude --task t1 --send "$BRIEF"
mu wait agent:auth/w1@0      # fires only for w1; first settle runs an in-life collect
mu agent close w1 -w auth   # preview; copy its revision
mu agent close w1 -w auth --if <rev>   # stop, final collect, close the tree
```

This example assumes an at-start job kind and a provider that can fetch
HEAD. Run the spawn from your checkout. A start with no answer is never
resent: `mu agent check w1 <msgId> -w auth` resolves it.

## Session-capped hosts

sshd's `MaxSessions 1` allows one session per connection. The SSH session
starter opens an independent connection per pane, so that limit alone does
not require a lease. If only one connection is practical and it has one
session, use a `lease` profile: the local **carrier** owns a detached remote
job without holding a session open for its lifetime.

```bash
mu host init dev --mule --template   # prints the starter below; runs nothing
mu host add dev --transport lease \
  --shell 'mule run --host dev --lease --human --cwd {cwd} --job-file {job_file} --forward-unix {local_sock}:{remote_sock} -- env {env} sh -c {cmd}' \
  --exec  'mule exec --host dev -- sh -c {cmd}' \
  --stop  'mule rm --host dev {job}' \
  --attach 'mule run --host dev --lease --attach {job} --job-file {job_file} --forward-unix {local_sock}:{remote_sock}' \
  --fetch 'git fetch ssh://dev{cwd} HEAD'
mu host check dev --root '~/repo'
```

- The `shell` template must contain `{job_file}` once, `{local_sock}` and
  `{remote_sock}`: the carrier writes the job handle to the file, and mu records
  it in the name's `carrier_jobs` reservation (machine-local; `mu sql "SELECT *
  FROM carrier_jobs"`). The reservation is taken before the pane opens. While
  it exists, every spawn of that name refuses. Once a carrier may have launched,
  a failed spawn that never got a handle keeps the reservation and the tree
  for `mu agent close <name> -w <ws>` (preview, then `--if <rev>`).
  `--stop` must contain `{job}`, and must be idempotent: exit 0 for a job that
  already ended. `{env}` is refused there, `{cwd}` is always `.`.
- `--attach` is optional: it opens a new carrier for a job that still runs
  (reattaching a reaped lease agent). It must contain `{job}` and `{job_file}`
  once each, `{local_sock}` and `{remote_sock}`; `{cmd}` and `{env}` are refused
  (nothing is dispatched). There is no `host update`: `host add --replace`
  (or `host rm`, then `host add`) with a byte-equal `--stop`, so every reservation stays stoppable.
- `local_sock` determines `remote_sock`: both derive from (workstream, agent),
  so a carrier's forward table never maps one local socket to two remote ones.
- The mule starter leaves `--max-sessions` unset. A lease pane uses no mu
  channel slot, and mule serializes SSH commands on its private master, so
  only one session runs there even with `MaxSessions 1`. If you set a mu
  cap of `1`, a collect can still run beside the lease pane, but mu refuses
  a second transient command until the first releases its slot.
- `--fetch` stays plain SSH: it uses a separate connection from mule's
  master, so a bulk transfer does not hold up mule's commands.
- A `-L` asked of a control master is bound by the master, not by the
  client, and outlives the pane; a second request for the same forward binds
  nothing. So each session spawn forwards a fresh local path
  (`{local_sock}`), which the agent's derived socket links to. The master's
  old forwards stay bound, to removed paths, until it exits.
- mule jobs run in a non-login shell: a host that finds `pi` only through login
  files edits `sh -c` to `zsh -ilc`, or fixes `PATH` in `.bashrc`. `host check`
  runs `pi` without a login shell on a lease profile for that reason.
- An exit 3 from any host template (`stop` included) is a hand-back: stop and
  ask a human. mu never retries it.
- Each dropped master is a hand-back. A resumable transport under the master
  (for example Eternal Terminal forwarding a port to the host's sshd) makes
  drops rare, with no template change. See mule's SPEC, *SSH master*.
- `agent spawn --host` on a lease profile waits for the job handle
  (`MU_SPAWN_JOB_MS`, default 30 s) even under `--no-ctl`. A spawn that fails
  after the handle runs `stop` before it removes the worktree. A failed stop
  keeps both the handle and the worktree, and a respawn of that name refuses
  until you preview `mu agent close <name> -w <ws>` and apply it with
  `--if <rev>` to stop the job. A lease profile runs no command gates.

- After the preview, `agent close --if <rev>` on a lease agent kills the
  pane and proves it gone as usual,
  then runs `stop` for the job, and only then removes the worktree. A stop that
  fails (the template's first stderr line is named), hands back (exit 3) or
  finds the `stop` template changed keeps the agent and its handle: fix that,
  then close again. `--force` never skips the stop. A handle the spawn had not
  recorded yet is read from the job file; with neither, close refuses (`spawn in
  progress`).
- With no agent row left (the carrier was `kill -9`ed and reconcile reaped it,
  a teardown, a raw delete), preview with `mu agent close <name> -w <ws>`,
  then repeat with `--if <rev>` to stop the job and drop its handle first,
  then close the recovery worktree, if any. A
  tree that refuses (dirty, uncollected) no longer keeps the name fenced: the
  retry only closes the tree. `agent collect` never stops a job.
- A reaped lease agent whose job still runs (a tmux restart, a `kill -9`)
  shows in `mu agent list` as a leftover whose `next` is the reattach or the
  close preview. `mu agent reattach <name> -w <ws>` previews, `--if <rev>` opens a new carrier
  on the job through the profile's `--attach`. It refuses while the old pane or
  spawn process may live, and rolls back if the job has ended (close it then).
  Reattach is pi only: close a reaped non-pi lease agent instead. The reaper
  parked the agent's tasks (the job may still write); `--task <id>` claims
  each back once ctl answers. After a close instead, `mu task unpark <id>`.
- A host that is gone for good: preview with
  `mu agent close <name> -w <ws> --abandon-job`, then repeat with `--if <rev>`.
  This drops the handle without a stop and logs the host and handle; the job
  may still run there. It is the only way past an unreachable host.

### Smoke-test a lease end to end

`scripts/smoke-lease.sh` drives a real mule against a loopback `sshd
MaxSessions 1` on this machine (no other host), with a ctl-speaking fake pi
(`scripts/smoke-fake-pi.mjs`) as the remote job. Vitest never runs it:

```bash
MU=/path/to/mu MULE=/path/to/mule bash scripts/smoke-lease.sh
```

- It builds both (`cargo build --release`, `npm run build`), then checks spawn
  (a job handle, no host channel, the forward bound by mule's master), a
  second master with `ssh -S` during the worker, `collect` at `--max-sessions
  1`, send and wait (the settled `lastText` must echo the sent text), and a
  close that leaves no job, forward, socket, job file, worktree or
  `carrier_jobs` row. It then `kill -9`s a carrier, lets reconcile reap the
  row, and closes by name, which must stop the job.
- Exit 0 is a pass. A missing prerequisite (sshd, ssh, tmux, node, cargo,
  lsof, `MULE`, `node_modules`) exits 2. It is never a pass.
- Everything is private: its own `/tmp/mu-smoke.*` dir, `HOME`, `TMPDIR`,
  `XDG_*`, `MU_DB_PATH`, a blank `MU_SYNC_DIR`, a private tmux server and
  mule `--config`. Your mule config, mule state and mu DB are never read. An
  exit trap stops every process it started, on failure too. `SMOKE_KEEP=1`
  keeps the dir for a post-mortem.

To use the mule plugin instead of this template, or to move a template host
to it, see [the ladder](remote-ladder.md#use-the-mule-plugin-rungs-2-and-4) and
[migration](remote-ladder.md#migrate-a-mule-lease-template-to-the-plugin).

Spec: [lease transport](../specs/2026-10-28-lease-transport.md).
