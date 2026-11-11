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

## Use it as a host's link

A plugin can replace a profile's `--shell` and `--exec` templates:

```bash
mu host add dev --plugin box [--fetch '<fetch cmd>']
mu host check dev
mu agent spawn w1 --host dev --worktree --task t1
```

`--fetch` is needed only when the plugin's link does not fetch. Agents spawn
there only if the plugin declares a job seam. Otherwise the host is
link-only. Everything else works as for any remote host:
[Run a worker on another machine](remote.md).

## Use it as a provider of hosts

A provider plugin provisions machines on demand:

```bash
mu host acquire box1 --provider box --param size=large --repo /work/repo
mu agent spawn w1 --host box1 --worktree --task t1
mu host drain box1      # no new spawns
mu host release box1    # once nothing names it
```

Re-running a crashed `acquire` resolves the same request and never acquires
a second host. Deadlines, lost hosts and `--abandon` are covered in
[Provider hosts](remote.md#provider-hosts).

## When an outcome is unknown

If a plugin call that starts a job or delivers a prompt gets no answer, mu
reports `EffectOutcomeUnknownError` (exit 1) and never resends.
`mu agent check <agent> <msgId>` asks the plugin and settles it. Closing the
agent drops whatever is still unresolved.

## Try the example

[`examples/plugins/mu-plugin-ssh`](../../examples/plugins/mu-plugin-ssh) is
a plugin of about 200 lines that gives a host a link over plain ssh. The mu
host's name is the ssh destination:

```bash
mu plugin add ssh -- "$(npm root -g)/@mu-crew/mu/examples/plugins/mu-plugin-ssh"
mu host add devbox --plugin ssh
mu host check devbox
```

It declares only the link seam, so no agent spawns on it. If your npm
install is owned by root, copy the file somewhere you own first: mu refuses
a plugin someone else can write.

## Write a plugin

Start from the example. The contract is [the plugin protocol](../reference/plugin-protocol.md), with
its schema in [`schemas/plugin-protocol-v1.json`](../../schemas/plugin-protocol-v1.json).
[`test/_fake-plugin.mjs`](../../test/_fake-plugin.mjs) implements
every seam (job, channel, host) for mu's tests. The design is in
[the plugins spec](../specs/2026-11-09-mu-plugins.md).
