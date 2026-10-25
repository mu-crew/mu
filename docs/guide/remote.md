# How to run a worker on another machine

The pane is local and the pi process is remote. mu runs no ssh
itself. `mu agent remote-env` prints the ssh pieces, and you put them
in the spawn command. The full recipe, with recording, collecting,
and the traps, is in
[skills/mu/recipes/remote-workers.md](../../skills/mu/recipes/remote-workers.md).
Read it before your first remote spawn.

## Prepare the host

On the remote host:

1. Install mu and run `pi install npm:@mu-crew/mu`, so the remote pi
   loads the mu extension.
2. Allow unix-socket forwards in the host's sshd:
   `AllowStreamLocalForwarding yes`.
3. Create the worker's checkout yourself. `--worktree` works only
   for local agents:

   ```bash
   ssh dev 'git -C ~/repo worktree add ~/ws/worker-1'
   ```

Use one orchestrator DB on your machine. Do not run a second mu on the
host for the same work: task ownership points into your local
`agents` table.

## Spawn the agent

```bash
eval "$(mu agent remote-env worker-1 -w auth --shell)"   # sets MU_SSH_ARGS, MU_REMOTE_ENV
mu agent spawn worker-1 -w auth --command \
  "ssh $MU_SSH_ARGS dev -t 'cd ~/ws/worker-1 && $MU_REMOTE_ENV \$SHELL -ilc \"pi --approve\"'"
```

What each part does:

- `MU_SSH_ARGS` forwards the remote pi's control socket to the local
  path mu connects to. It includes `-o ControlMaster=no -o
  ControlPath=none`, because a multiplexed ssh connection never binds
  the local end of the forward.
- `MU_REMOTE_ENV` sets the agent's identity inside the remote shell.
  tmux `-e` variables do not cross the ssh hop.
- `$SHELL -ilc` starts pi in an interactive login shell, so the
  remote `~/.zshrc` or `~/.bashrc` loads PATH and provider keys.
  Without it, ssh's non-interactive shell skips them and pi can die at
  startup.
- `pi --approve` skips pi's project-trust prompt. It trusts whatever
  directory the pane starts in, so use it only on your own code.

If the spawn reports `ctl refused`, check `AllowStreamLocalForwarding`
on the host.

## Drive it like a local agent

Claim, `mu agent send --fresh`, `mu agent wait`, and `mu agent abort`
all go through the forwarded socket and behave as they do locally:

```bash
mu task note build -w auth 'REMOTE: dev:~/ws/worker-1'
mu task claim build -w auth --for worker-1
mu agent send worker-1 -w auth --fresh 'Work on build. Read: mu task notes build -w auth'
```

The `REMOTE: <host>:<path>` note line is how `mu state` lists remote
workers. Collect the work by fetching from the remote checkout:

```bash
git fetch "ssh://dev/~/ws/worker-1" HEAD && git cherry-pick FETCH_HEAD
```

Use `mu agent abort` to stop a remote pi turn, or close the pane.

## Host profiles

A host profile stores your own command templates, so you stop retyping
them. mu never connects and knows no ssh flags: it fills the templates and
runs them with `/bin/sh -c`. `spawn --host` and `agent collect` that use
them arrive with the remote units; today the profile, its channel cap and
its check are in place.

```bash
mu host init dev --ssh        # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --repo '~/repo' --max-sessions 1
mu host check dev             # host answers, repo, pi, mu extension
mu host show dev              # templates and the holders of its channels
```

- Placeholders: `{env}` (the four `MU_*` identity variables only), `{cmd}`,
  `{local_sock}`, `{remote_sock}`, `{cwd}`. Each value is one quoted word and
  is exactly the text you passed, also inside your own `"..."` or `'...'`.
  A template that hands command text to a second shell (ssh's remote login
  shell) says so per placeholder: `{cmd:sh}`, `{cwd:sh}` quote the value for
  that shell too. Write `{{` and `}}` for literal braces. Anything else in
  braces is refused.
- A command that times out, or whose caller is killed, takes its whole process
  group with it before its channel is freed, so `--max-sessions` never
  undercounts a live transport.
- `--max-sessions N` counts every channel mu holds to the host. At the cap mu
  refuses with one line naming the holder.
- `host check --agent <name> -w <ws>` also probes that agent's forwarded
  control socket.
