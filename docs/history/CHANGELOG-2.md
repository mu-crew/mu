# Changelog: mu 2

Release 2.0.0. Newer releases: [CHANGELOG.md](../../CHANGELOG.md).

## [2.0.0] — 2026-09-28

### Changed

- **Agent state comes from murmur.** mu no longer reads pane text to decide
  what an agent is doing, and no longer stores it. On tmux it reads
  [murmur](https://github.com/mu-crew/murmur) 1.0.0 or later: one
  `tmux list-panes` call for local agents, and `murmur status --json`
  (cached for 10 s) only for agents running on other hosts. On herdr it reads
  herdr. Without murmur, agent state shows `unknown` and `mu doctor` says why.
  Remote workers now report real state instead of an ssh-rendered pane.
- `mu task wait --stuck-after` times the stall from murmur's
  `@murmur_pane_since`, the moment the agent went idle, instead of the last
  time mu happened to reconcile.
- `mu agent spawn` waits for murmur to claim the pane. Without murmur it
  returns after the liveness check; the first `mu agent send` still waits
  for pi to accept input.
- `mu doctor` has an `agent state` row (`environment.agentState` in `--json`).

### Breaking

- Agent JSON (`mu agent list/show --json`, `mu state --json`, `mu me --json`)
  drops `status` and adds `state` (`busy`, `needs_input`,
  `needs_permission` or `unknown`), `source` (`murmur`, `herdr` or `none`),
  `since` (ISO time or null) and `reason` (when `unknown`).
- `mu agent wait` and `mu task wait --stuck-after` never fire on `unknown`.
  Without murmur they wait until `--timeout`.
- The `free` and `spawning` agent statuses are gone. `mu agent adopt` no
  longer marks an agent free.
- SDK: removed `AgentStatus`, `detectPiStatus`, `extractTail`,
  `updateAgentStatus`, `agentStatusGlyph`,
  `AGENT_STATUS_GLYPH` and `STATUS_EMOJI`. Added `readAgentStates`,
  `RuntimeState`, `StateSource`, `StateReading`, `LiveAgent`,
  `agentStateGlyph` and `MuxPaneStatus`.
- The `agents.status` column is unused and always `spawning`. It is dropped
  at the next schema migration.

### Unchanged

Tasks, claims, `mu task wait` on task status, workspaces, spawn, send and read
work the same with or without murmur.

### Upgrade

```sh
npm i -g @mu-crew/mu@2 @mu-crew/murmur@^1
murmur init        # once per machine
murmur link pi     # then restart pi sessions
mu doctor          # agent state : ok agent state from murmur 1.x
```
