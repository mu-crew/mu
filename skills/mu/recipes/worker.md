# Worker loop

Use when you are the worker: a task was claimed for you, or you were
told to claim one.

`$MU_AGENT_NAME` (injected at spawn) resolves identity; adopted panes
fall back to the pane title. In a worker pane, bare `mu task claim <id>`
works. In the unregistered orchestrator pane it errors; use `--self`,
`--for <worker>`, or `mu agent adopt <pane>`.

```bash
mu me
mu me next
mu task show <id>; mu task notes <id>
mu task claim <id> --evidence "starting; read notes"
mu task note <id> "FILES: ...\nDECISION: ...\nVERIFIED: ..."
mu task close <id> --evidence "tests pass: ..."  # LAST action
```

The note follows the task note contract in SKILL.md. Commit before you
close: the orchestrator cherry-picks your commits, not your tree.

Done when the task is closed. Skipping close makes the orchestrator's
wait hang. Won't do it: `close --as wontfix --why "..."`.
