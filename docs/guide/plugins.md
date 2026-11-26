# How to use a plugin

A **plugin** is an executable that runs some of mu's machinery out of
process: a host's link (how mu runs commands and fetches commits there), the
machines themselves (a provider that acquires and releases hosts), the jobs
agents run as, and the channel mu drives them through. mu starts it as a
child for one invocation and speaks JSON-RPC to it over stdio. The plugin
only reports facts. mu keeps every state machine and writes its effects
ahead, so a crash never runs a start or a delivery twice.

## Register a plugin

```bash
mu plugin add box -- /abs/path/mu-plugin-box [args…]
mu plugin list
mu plugin rm box
```

- mu never discovers plugins. It runs only the argv you registered.
- The file must be named `mu-plugin-<name>`, be owned by you and be writable
  by no one else. mu checks this at `add` and every time it starts the
  plugin.
- `add` runs the handshake once and records the seams the plugin declares.
  Run it again after upgrading the plugin.
- `rm` refuses while a host, job record or unresolved effect names the
  plugin.

A `--host` spawn with `--task` and no `--send` sends the task's authored brief
note. With no such note it refuses (exit 2): the host has no mu DB, so a
`Read: mu task notes` pointer would be unrunnable ([Spawn the
agent](remote.md#spawn-the-agent)). The examples below pass the whole brief as
`--send "$BRIEF"` (or `--send -` on stdin).

## Use it as a host's link

A plugin can replace a profile's `--shell` and `--exec` templates:

```bash
mu host add dev --plugin box [--fetch '<fetch cmd>'] [--repo <remote repo>]
mu host check dev
mu agent spawn w1 -w <ws> --host dev --worktree --task t1 --send "$BRIEF"
```

`--fetch` is needed only when the plugin's link does not fetch. A spawn with
`--worktree` needs the host's remote repo: `--repo` on `host add`, or `--root
<remote repo>` on each spawn (without either it refuses: no default repo). Agents spawn
there only if the plugin declares a job seam. Otherwise the host is
link-only. Everything else works as for any remote host:
[Run a worker on another machine](remote.md).

## Use it as a provider of hosts

A provider plugin provisions machines on demand:

```bash
mu host acquire box1 --provider box --param size=large --repo /work/repo
mu agent spawn w1 -w <ws> --host box1 --worktree --task t1 --send "$BRIEF"
mu host drain box1      # no new spawns
mu host release box1    # once nothing names it
```

Re-running a crashed `acquire` resolves the same request and never acquires
a second host. Deadlines, lost hosts and `--abandon` are covered in
[Provider hosts](remote.md#provider-hosts).

## When an outcome is unknown

If a plugin call that starts a job or delivers a prompt gets no answer, mu
reports `EffectOutcomeUnknownError` (exit 1) and never resends.
`mu agent check <agent> <msgId> -w <ws>` asks the plugin to settle it.
To close the agent instead, preview with `mu agent close <agent> -w <ws>`,
then repeat with `--if <rev>`; applying the close drops unresolved delivery.

## Try the example

[`examples/plugins/mu-plugin-ssh`](../../examples/plugins/mu-plugin-ssh) is
an example plugin over plain ssh. The mu host's name is the ssh destination:

```bash
mu plugin add ssh -- "$(npm root -g)/@mu-crew/mu/examples/plugins/mu-plugin-ssh"
mu host add devbox --plugin ssh --repo /work/repo
mu host check devbox
mu agent spawn w1 -w <ws> --host devbox --worktree --task t1 --send "$BRIEF"   # a pane over ssh
```

It gives the host a link (exec, fetch) and an example `pane` job kind. If
your npm install is owned by root, copy the file somewhere you own first: mu
refuses a plugin someone else can write.

**It is an example, not the supported path to a remote loop.** Session
templates and lease templates ([remote.md](remote.md)) are supported. The pane kind has these
limits (the file header has the rest):

- Its view needs its own ssh connection, so a host where only one
  connection is practical does not fit.
- Stop covers only the recorded process group. Descendants that leave it
  survive.
- The plugin keeps a state root on the host (`MU_SSH_STATE_DIR`, else
  `$HOME/.local/state/mu-plugin-ssh`). Keep it intact while jobs or delayed
  views may exist: if it goes missing, stop fails; if you replace it at the
  same path, stop can report a live job gone.
- Use a short root whose components are handle-safe. Trailing newlines are
  stripped before validation and can select the wrong directory.

## Register the mule plugin

`mule init` registers the bundled `mu-plugin-mule` (manually: `mu plugin add
mule -- /abs/mu-plugin-mule`). Then `mu host add <h> --plugin mule --fetch
'...'`. The plugin serves the link and the `lease` job kind; the lease's view needs
tmux, while the link's `exec` is pane-free and runs on any backend.
Setup, migration from a lease template, and refusals:
[placement](placement.md#use-the-mule-plugin).

## Write a plugin

Start from the example. The contract is [the plugin protocol](../reference/plugin-protocol.md), with
its schema in [`schemas/plugin-protocol-v1.json`](../../schemas/plugin-protocol-v1.json).
[`test/_fake-plugin.mjs`](../../test/_fake-plugin.mjs) implements
every seam (job, channel, host) for mu's tests. The design is in
[the plugins spec](../specs/2026-11-09-mu-plugins.md).
