# How to run a worker on another machine

The pane is local and the pi process is remote. mu runs no ssh
itself. `mu agent remote-env` prints the ssh pieces, and you put them
in the spawn command. The full recipe, with recording, collecting,
and the traps, is in
[skills/mu/REMOTE_WORKERS.md](../../skills/mu/REMOTE_WORKERS.md).
Read it before your first remote spawn.

## Prepare the host

On the remote host:

1. Install mu and run `mu link pi`, so the remote pi loads the mu
   extension.
2. Allow unix-socket forwards in the host's sshd:
   `AllowStreamLocalForwarding yes`.
3. Create the worker's checkout yourself. `--workspace` works only
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

`mu agent kick` does not reach a remote process. Use `mu agent abort`,
or close the pane.
