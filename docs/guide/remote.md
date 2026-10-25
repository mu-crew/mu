# How to run a worker on another machine

The pane is local and the pi process is remote. mu never connects and
knows no ssh flags: a host profile holds your own command templates, and
`mu agent spawn --host` fills them. The full recipe, with collecting and
the traps, is in
[skills/mu/recipes/remote-workers.md](../../skills/mu/recipes/remote-workers.md).
Read it before your first remote spawn.

## Prepare the host

1. On the host, install pi and the mu package:
   `pi install npm:@mu-crew/mu`. The host needs no mu DB, and a remote
   worker cannot claim or close tasks: you close.
2. Allow unix-socket forwards in the host's sshd:
   `AllowStreamLocalForwarding yes`.
3. Have a git repo there for `--worktree` to branch from.

Use one orchestrator DB on your machine. Do not run a second mu on the
host for the same work: task ownership points into your local `agents`
table.

## Add a profile and check it

```bash
mu host init dev --ssh   # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --repo '~/repo' --max-sessions 1
mu host check dev        # host answers, repo, pi, mu extension
```

## Spawn the agent

```bash
mu agent spawn worker-1 -w auth --host dev --worktree --task build --send 'Read: mu task notes build -w auth'
```

- The pane runs the profile's `--shell` template, filled with the remote
  identity (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`, `MU_WORKSTREAM`,
  `MU_CTL_SOCK`, `MU_REMOTE`, never your DB, state or sync dir, which are unset in the pane), your
  `--command` (default `pi`), the local and remote socket paths and the
  remote cwd. The template starts the remote pi and forwards its control
  socket to the local derived path.
- `--worktree` makes a detached `git worktree add` in the profile's
  `--repo` through its `--exec`, at
  `~/.local/state/mu/remote-worktrees/<ws>/<name>` on the host. Its path
  and base commit are the agent's `cwd` and `base`. `--cwd` names an
  existing remote directory instead. `--root` is refused.
- `--task` is the same one journaled attempt as for a local agent: claim
  for the new agent, then the brief, never sent twice.
- mu reserves the host's channel before its first remote command and
  keeps it while the pane lives (`--max-sessions` counts it). A full host
  refuses the spawn up front and names the holder. A failed spawn removes
  only the worktree it made (still clean, still at its base) and frees
  the slot.
- The pane is the transport: closing it, or its death, ends the agent
  and frees the slot. tmux only; herdr refuses `--host` in one line.
- If the spawn reports `ctl refused` or `missing`, run
  `mu host check dev --agent worker-1 -w auth`, then check
  `AllowStreamLocalForwarding` on the host.

## Drive it like a local agent

`mu agent send`, `wait`, `abort` and `check` go through the forwarded
socket and behave as they do locally. `mu state` lists remote workers
(agent, host, remote cwd, base). Collect the work by fetching from the
remote worktree, then close the agent; `agent close` does not remove the
remote worktree yet, so remove it once collected:

```bash
git fetch "ssh://dev/<cwd>" HEAD && git cherry-pick FETCH_HEAD
```

## Host profiles

A host profile stores your own command templates, so you stop retyping
them. mu never connects and knows no ssh flags: it fills the templates and
runs them with `/bin/sh -c`. `spawn --host` uses them (above); `agent
collect` (the `--fetch` template) is a later unit.

```bash
mu host init dev --ssh        # prints a starter `mu host add`; runs nothing
mu host add dev --shell '<pane cmd>' --exec '<run cmd>' --fetch '<fetch cmd>' --repo '~/repo' --max-sessions 1
mu host check dev             # host answers, repo, pi, mu extension
mu host show dev              # templates and the holders of its channels
```

- Placeholders: `{env}` (the five `MU_*` identity variables only), `{cmd}`,
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
