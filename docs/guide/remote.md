# How to run a worker on another machine

The pane is local and the agent is remote: pi on its forwarded control
socket, claude, codex, cursor-agent or muse on the `hooks` channel
([below](#a-claude-codex-cursor-agent-or-muse-worker)). mu never connects and
knows no ssh flags: a host profile holds your own command templates, and
`mu agent spawn --host` fills them. The full recipe, with collecting and
the traps, is in
[skills/mu/recipes/remote-workers.md](../../skills/mu/recipes/remote-workers.md).
Read it before your first remote spawn.

## Prepare the host

1. On the host, install the harnesses its workers run. For pi, add the mu
   package: `pi install npm:@mu-crew/mu`. For claude, codex, cursor-agent or
   muse, add murmur and its hook entries (`murmur init`). Log each harness in
   there yourself. The host needs no mu DB: a remote worker
   cannot run `mu task` verbs. It ends with a `CLOSE:` block. `mu wait`
   applies it when it sees the run settle; `mu agent wait` does not. Re-run
   the evidence first, or close the task yourself.
2. For pi workers, allow unix-socket forwards in the host's sshd:
   `AllowStreamLocalForwarding yes`.
3. Have a git repo there for `--worktree` to branch from. One profile serves
   every repo on the host: `--max-sessions` caps the machine, so never add
   the same machine twice.

Use one orchestrator DB on your machine. Do not run a second mu on the
host for the same work: task ownership points into your local `agents`
table.

## Add a profile and check it

```bash
mu host init dev --ssh   # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --max-sessions 1
mu host check dev --root '~/repo'   # host answers, repo, harnesses and hooks, pi and mu extension
```

## Spawn the agent

```bash
mu agent spawn worker-1 -w auth --host dev --worktree --root '~/repo' --task build --send - <<'EOF'
<the whole brief: the host has no mu DB, so no `Read: mu task notes` line>
EOF
```

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
  `--cwd` names an existing remote directory instead; without either, the
  agent starts in `--root` (default the profile's repo), else the login
  directory. Without a repo, templates get `.` for `{cwd}`. `--root` is part
  of a `--task` attempt's identity: the same attempt in another repo conflicts.
- `--task` is the same one journaled attempt as for a local agent: claim
  for the new agent, then the brief, never sent twice.
- mu reserves the host's channel before its first remote command and
  keeps it while the pane lives (`--max-sessions` counts it; one exception
  under the path rule below). A full host
  refuses the spawn up front and names the holder. A failed spawn removes
  only the worktree it made (still clean, still at its base) and frees
  the slot. If the host's answer was lost after it made the worktree (a
  timeout), spawning the same name again takes that tree over while it is
  clean, at its base and unused; anything else at the path refuses.
- The pane is the transport: closing it, or its death, ends the agent
  and frees the slot. tmux and Rex; herdr refuses `--host` in one line.
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
  `exit` of the result and of the process; 23 stays 23). Never a held
  `ssh dev …`. The remote command writes a token-bound completion record that
  mu reads once the pane has exited; no record, a signal or a lost transport is
  exit 6, never 0. `mu agent close gate-1` frees the pane and removes that
  record. No `--worktree`, no `--task`.
- If the spawn reports `ctl refused` or `missing`, run
  `mu host check dev --agent worker-1 -w auth`, then check
  `AllowStreamLocalForwarding` on the host.

## Drive it like a local agent

A pi worker's `mu agent send`, `wait`, `abort` and `check` go through the
forwarded socket and behave as they do locally. `mu state` shows remote workers
as agent records with `host`, `cwd`, `base` and `collected_head`.

## A claude, codex, cursor-agent or muse worker

`--cli claude` (or `codex`, `cursor-agent`, `muse`) on a host runs that
harness behind the pane and reaches it on the `hooks` channel, as a local
one on tmux. Its hooks on the host must be installed (`murmur init` there),
and `murmur` must be on the PATH the profile's `--exec` sees.

- The worker gets its row's auto-approve preset in its remote command, as
  a local worker does.
- The spawn gives the worker a remote key (`MU_REMOTE_KEY` and its anchor).
  Its hooks on the host write under that key to murmur's remote area, never
  the host's own `murmur status`.
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
`MU_<KEY>_COMMAND`.

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
mu agent close worker-1 -w auth        # preview, then --if <rev>
```

- `collect` runs the `--fetch` template locally, in the current directory's
  git repo, under one channel. It pins the fetched commit as
  `refs/mu/collect/<ws>/<agent>` (gc keeps it) and records it as the
  agent's `collected_head`. A fetch that fails, or succeeds without leaving a
  commit, records nothing. Collecting the same HEAD again says so.
- The pane is the transport, so a live worker holds its host's channel. At
  `--max-sessions 1`, `collect` is refused with the holder named; raise the
  cap to collect while the worker runs.
- `close` kills the pane first (that frees the channel), then removes the
  remote worktree **only if** it is clean, its HEAD is the base, the
  collected HEAD or on a branch (or remote-tracking ref) of the root repo
  (checked again just before the removal), and no process on the host is
  inside it. Its `git worktree
  remove` never uses git's `--force`. A process inside it, or a host with
  neither /proc nor lsof to check, refuses naming `close --force`, which
  removes past either with a warning. A newer HEAD refuses with one line:
  `collect` again, or `close --keep-branch` to keep the commits on the remote
  branch `mu/<ws>/<agent>-<sha12>` and remove the worktree. Uncommitted files
  always refuse (`--discard` and `--keep-branch` do not override that).
- A `--cwd` agent has no remote worktree of its own: close never touches the
  host. When a row is deleted (its pane died and the
  reaper took it, a workstream teardown, a peer's workstream delete, even a raw
  SQL delete) the database keeps a
  machine-local `remote_recovery` record of the host, path and base (`mu sql
  "select * from remote_recovery"`; `mu rebuild` loses it). A failed spawn whose
  own rollback removed the tree (or found it gone) leaves none. With no agent row left,
  `mu agent close <name> -w <ws>` (or `<ws>/<name>`) previews and closes THAT
  worktree under the rule above (no pane, no task; the recorded host profile only), and
  `mu agent collect <name>` fetches from it. Several records of one name need
  `--recovery <id>`; a current agent of the name or path, a newer record of the same path, or a changed `--exec`, refuses (a changed default repo does not).
  While a record exists, a `--worktree` spawn of that name on that host
  refuses (exit 4): collect, then close the record first.

## Host profiles

A host profile stores your own command templates, so you stop retyping
them. mu never connects and knows no ssh flags: it fills the templates and
runs them with `/bin/sh -c`. `spawn --host` uses them (above); `agent
collect` runs the `--fetch` template.

```bash
mu host init dev --ssh        # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --max-sessions 1
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
  `--max-sessions` never undercounts a live transport (except a pane a
  path-owner refusal could not prove gone: see [Spawn the agent](#spawn-the-agent)).
- An `exec` or `fetch` template that exits 3 is a hand-back (a hardware key, a
  prompt): mu stops with exit 5, `human needed`, and the template's first line.
  Never retried; `host check` reports a `handback` step.
- A `shell` template must not ride a shared ssh master (keep `-o
  ControlMaster=no -o ControlPath=none`, as `host init --ssh` prints): a `-L`
  through a master is bound by the master, outlives the pane, and is never
  re-bound, so the next spawn of that name gets no socket. `host check` warns
  when the template lacks either option. On a session-capped host use a
  lease ([below](#session-capped-hosts)).
- `mu host show` and `list` print the transport (`session` or `lease`) and,
  for a lease, the `stop` template.
- `--max-sessions N` counts every channel mu holds to the host. At the cap mu
  refuses with one line naming the holder.
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
kept as uncollected work until `mu agent close <name> --abandon-job`.
`mu host release <name> --abandon` drops the host and every record of
it without asking the provider, and logs what was lost. Inside
`MU_HOST_DEADLINE_MARGIN_MS` of the provider's deadline, spawns refuse
and the host drains, `mu wait` fires `deadline` (exit 7) for its agents,
and `mu state` lists their collect and close.

```bash
mu agent spawn w1 --host box1 --worktree --cli claude --task t1   # HEAD pushed, brief in the start
mu wait agent:w1@0           # the first turn; its settle runs an in-life collect
mu agent close w1            # stops the job, runs the final collect, closes the tree
```

`--worktree` there starts from your checkout's commit and must run inside
it. A start with no answer is never resent: `mu agent check w1 <msgId>`
resolves it.

## Session-capped hosts

Some hosts allow one ssh session per connection (`MaxSessions 1`, e.g. a
managed dev VM). A `session` worker's pane holds that session for the worker's whole
life, so every other `ssh` to the host (the murmur collector, `git fetch`, you)
is refused, and it shows as a misleading `Permission denied`. A `lease` profile
fixes that: the pane runs a local **carrier** that owns a detached remote job on
its own connection, so no session is held.

```bash
mu host init dev --mule   # prints the starter below; runs nothing
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
  a failed spawn that never got a handle keeps the reservation and the tree for
  `mu agent close <name>`.
  `--stop` must contain `{job}`, and must be idempotent: exit 0 for a job that
  already ended. `{env}` is refused there, `{cwd}` is always `.`.
- `--attach` is optional: it opens a new carrier for a job that still runs
  (reattaching a reaped lease agent). It must contain `{job}` and `{job_file}`
  once each, `{local_sock}` and `{remote_sock}`; `{cmd}` and `{env}` are refused
  (nothing is dispatched). There is no `host update`: `host rm`, then `host add`
  with a byte-equal `--stop`, so every reservation stays stoppable.
- `local_sock` determines `remote_sock`: both derive from (workstream, agent),
  so a carrier's forward table never maps one local socket to two remote ones.
- A lease pane holds no host channel, so `--max-sessions` counts only what mu
  opens itself (`exec`, `fetch`, `stop`, `check`), and `collect` works while a
  lease worker runs.
- Why `--fetch` stays plain ssh: a fetch is a bulk transfer, and the carrier's
  channel is never lent to one.
- Why a session template must not ride a shared master: a `-L` asked of a
  control master is bound by the master, not by the client, and outlives the
  pane. mu then deletes the socket file but the master keeps the listener; the
  next spawn of that name asks for the same forward, ssh exits 0 and no file
  appears (`ctl: missing`, for that name, for good). A lease carrier binds and
  verifies its own forward; a session template keeps `ControlMaster=no
  ControlPath=none`.
- mule jobs run in a non-login shell: a host that finds `pi` only through login
  files edits `sh -c` to `zsh -ilc`, or fixes `PATH` in `.bashrc`. `host check`
  runs `pi` without a login shell on a lease profile for that reason.
- An exit 3 from any host template (`stop` included) is a hand-back: stop and
  ask a human. mu never retries it.
- `agent spawn --host` on a lease profile waits for the job handle
  (`MU_SPAWN_JOB_MS`, default 30 s) even under `--no-ctl`. A spawn that fails
  after the handle runs `stop` before it removes the worktree. A failed stop
  keeps both the handle and the worktree, and a respawn of that name refuses
  until `mu agent close <name>` stops the job. A lease profile runs no command
  gates.

- `agent close` on a lease agent kills the pane and proves it gone as usual,
  then runs `stop` for the job, and only then removes the worktree. A stop that
  fails (the template's first stderr line is named), hands back (exit 3) or
  finds the `stop` template changed keeps the agent and its handle: fix that,
  then close again. `--force` never skips the stop. A handle the spawn had not
  recorded yet is read from the job file; with neither, close refuses (`spawn in
  progress`).
- With no agent row left (the carrier was `kill -9`ed and reconcile reaped it,
  a teardown, a raw delete), `mu agent close <name> -w <ws>` stops the job
  and drops its handle first, then closes the recovery worktree, if any. A
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
- A host that is gone for good: `mu agent close <name> --abandon-job` drops the
  handle without a stop and logs the host and handle; the job may still run
  there. It is the only way past an unreachable host.

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

Spec: [lease transport](../specs/2026-10-28-lease-transport.md).
