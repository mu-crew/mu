# Run the checkout in isolation

To run a pi orchestrator on a mu-next checkout next to a live 3.x install,
without touching 3.x state. Found by dogfood-1 ([eval/dogfood-1.md](eval/dogfood-1.md), F8).

```bash
# env.sh: source it before anything below
for v in $(env | grep -E '^(MU_|PI_SESSION_ID)' | cut -d= -f1); do unset "$v"; done
export MU_STATE_DIR=/tmp/mun/state MU_DB_PATH=/tmp/mun/state/mu.db MU_SYNC_DIR=
export MU_TMUX_SOCKET=mun PATH=/tmp/mun/bin:$PATH
export MU_PI_COMMAND=/tmp/mun/bin/piwrap
```

- `/tmp/mun/bin/mu`: `exec node <checkout>/dist/cli.js "$@"`. Name it `mu`:
  the skill and every brief say `mu`. It hides the 3.x binary, so call that
  by full path (the [Move recipe](skill-draft/recipes/move.md)'s `<mu3>`).
- `/tmp/mun/bin/piwrap`: `exec pi -ne -e <checkout>/dist/extension/mu-pi.js
  --no-skills --skill <checkout>/docs/mu-next/skill-draft "$@"`. Without
  `-ne` the global `~/.pi/agent/extensions/mu.ts` loads the 3.x extension.
  `MU_PI_COMMAND` gives spawned workers the same flags; start the
  orchestrator with `piwrap` too.
- Unset every inherited `MU_*` and `PI_SESSION_ID`: a 3.x pane's
  `MU_DB_PATH`, `MU_CTL_SOCK` and `MU_AGENT_NAME` point the checkout at the
  live DB and identity.
- `MU_TMUX_SOCKET` runs tmux with `-f /dev/null`, so no `~/.tmux.conf`
  applies. Start the server first to set scrollback:
  `tmux -L mun new-session -d -s base \; set -g history-limit 2000`.
