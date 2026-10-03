# mu guide

Start with the tutorial, then open a how-to when you have that job.
`mu <verb> --help` is the reference: flags, defaults, and exit codes.
Terms are defined in [VOCABULARY.md](../VOCABULARY.md).

1. [Getting started](getting-started.md): install mu, plan two tasks,
   and ship one with a pi worker.

How-to guides:

- [Dispatch work to a worker](dispatch.md)
- [Stop a worker](stop-a-worker.md)
- [Delegate a task (mu_delegate)](delegate.md)
- [Run a worker on another machine](remote.md)
- [Recover from a broken state](recovery.md)
- [Sync between machines](sync.md)
- [Use the TUI dashboard](tui.md)
- [Query and script mu](sql.md)
- [Upgrade mu](upgrade.md)
- [Choose a multiplexer backend](backends.md)
- [Clean up](cleanup.md)

Agent-facing recipes (orchestrator loop, worker loop, recovery, waves,
long runs, watchers, remote workers) live
in [skills/mu/recipes/](../../skills/mu/recipes/). The skill's
[recipe index](../../skills/mu/SKILL.md#recipes) says when to read each.

For features mu does not have on purpose, see
[ROADMAP.md § Explicitly rejected](../ROADMAP.md#explicitly-rejected).
