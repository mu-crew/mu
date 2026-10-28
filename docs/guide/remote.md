# How to run a worker on another machine

The pane is local and the pi process is remote. mu never connects and
knows no ssh flags: a host profile holds your own command templates, and
`mu agent spawn --host` fills them. The full recipe, with collecting and
the traps, is in
[skills/mu/recipes/remote-workers.md](../../skills/mu/recipes/remote-workers.md).
Read it before your first remote spawn.

## Prepare the host

1. On the host, install pi and the mu package:
   `pi install npm:@mu-crew/mu`. The host needs no mu DB: a remote worker
   cannot run `mu task` verbs. It ends with a `CLOSE:` block. `mu wait`
   applies it when it sees the run settle; `mu agent wait` does not. Re-run
   the evidence first, or close the task yourself.
2. Allow unix-socket forwards in the host's sshd:
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
mu host check dev --root '~/repo'   # host answers, repo, pi, mu extension
```

## Spawn the agent

```bash
mu agent spawn worker-1 -w auth --host dev --worktree --root '~/repo' --task build --send 'Read: mu task notes build -w auth'
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
  keeps it while the pane lives (`--max-sessions` counts it). A full host
  refuses the spawn up front and names the holder. A failed spawn removes
  only the worktree it made (still clean, still at its base) and frees
  the slot. If the host's answer was lost after it made the worktree (a
  timeout), spawning the same name again takes that tree over while it is
  clean, at its base and unused; anything else at the path refuses.
- The pane is the transport: closing it, or its death, ends the agent
  and frees the slot. tmux only; herdr refuses `--host` in one line.
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

`mu agent send`, `wait`, `abort` and `check` go through the forwarded
socket and behave as they do locally. `mu state` shows remote workers
as agent records with `host`, `cwd`, `base` and `collected_head`.

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
  remote worktree **only if** it is clean and its HEAD is the base or the
  collected HEAD, and no process on the host is inside it. Its `git worktree
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

## Host profiles

A host profile stores your own command templates, so you stop retyping
them. mu never connects and knows no ssh flags: it fills the templates and
runs them with `/bin/sh -c`. `spawn --host` uses them (above); `agent
collect` runs the `--fetch` template.

```bash
mu host init dev --ssh        # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --max-sessions 1
mu host check dev --root '~/repo'   # host answers, repo, pi, mu extension
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
  `--max-sessions` never undercounts a live transport.
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

## Session-capped hosts

Some hosts allow one ssh session per connection (`MaxSessions 1`, the Meta
devvm). A `session` worker's pane holds that session for the worker's whole
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
  --fetch 'git fetch ssh://dev{cwd} HEAD'
mu host check dev --root '~/repo'
```

- The `shell` template must contain `{job_file}` once, `{local_sock}` and
  `{remote_sock}`: the carrier writes the job handle to the file, and mu records
  it in `carrier_jobs` (machine-local; `mu sql "SELECT * FROM carrier_jobs"`).
  `--stop` must contain `{job}`, and must be idempotent: exit 0 for a job that
  already ended. `{env}` is refused there, `{cwd}` is always `.`.
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

The spawn handshake (`agent spawn --host` on a lease profile), close and
`doctor` land in the next units; the profile alone is stored and checked today.
Spec: [lease transport](../specs/2026-10-28-lease-transport.md).
