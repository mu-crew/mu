# Naming conventions

Terms are defined in [VOCABULARY.md](../VOCABULARY.md).

## Flags and positionals

The primary entity a verb acts on is positional. Scope, modifiers, and
payload are flags: `mu task close <id>`, `mu agent send <name> <text>`.

- The workstream is a scope (`-w`) everywhere except under
  `mu workstream`, where it is the entity. `init` and `teardown` take
  it positionally; if the positional and `-w` disagree, mu exits 2.
- When one verb takes a payload positionally and a sibling takes it as
  a flag, both shapes are accepted (`mu task note <id> --text "..."`).
  Adding an alias is not a breaking change; removing a shape is.
- One concept, one parser: `--blocked-by` and `--by` are both blocker
  lists and accept repeated, comma-separated, or mixed forms.

## Empty and blank list fragments

`parseCsvFlag` (`src/cli.ts`) applies one rule to every list flag
(`--status`, `--by`, `--blocked-by`, `-w`):

| Input | Kind | Result |
| --- | --- | --- |
| `--status "OPEN,"` | empty fragment | dropped: `[OPEN]` |
| `--blocked-by ""` | empty fragment | dropped: `[]` |
| `--status " "` | blank fragment | `UsageError`, exit 2 |
| `--status "OPEN, "` | blank fragment | `UsageError`, exit 2 |

A blank `-w ' '` is also rejected. Whether zero fragments is legal is
per verb: `--by ''` exits 2, while `mu task reparent --blocked-by ''`
clears all blockers.

## Ids

| Id | Shape | Unique within |
| --- | --- | --- |
| Agent name | `[a-z][a-z0-9_-]*`, ≤ 32 chars | workstream |
| Task `local_id` | `[a-z][a-z0-9_-]*`, ≤ 64 chars | workstream |
| Workstream name | `[a-z][a-z0-9_-]*`, ≤ 32 chars; mux session is `mu-<name>` | DB |
| Window (`--tab`) | not validated; passed to the mux as given. Avoid `:` and `.`, which tmux reads as target separators | workstream |

`scratch` is reserved: it is created only by the first
`mu agent spawn <name> -w scratch`, and `mu workstream init scratch`
is rejected. The `mu-` prefix is reserved too.

## Workstream names

Name a workstream `<project>-<purpose>`: `hail-auth`, `swayward-v2`,
`dotfiles-zsh`. The project is the repo or folder; the purpose is the
effort. Two repos then never share `auth`, and `mu workstream list`
groups by project. `workstream init` prints a hint for a name with no
`-`.

- **One workstream per effort.** Tear it down when the effort ships;
  the ops log keeps the history and `mu undo` restores it. A long-lived
  catch-all becomes a log nobody reads: `mu state` hints once a
  workstream passes 300 tasks with fewer than 10% open.
- **Ultrathink runs** get their own: `<project>-ut-<topic>`.
- **Delegate-only work** (reviewing someone's PR or a doc) goes in
  `scratch`, never a new workstream.
- `mu-` is reserved, so the mu repo's own workstreams use the purpose
  alone or another prefix.

## Agent names

Name agents by role with a numeric suffix: `worker-1`, `reviewer-1`,
`scout-1`. Human names (`alice`, `bob`) read as people in commands and
make `mu agent list` harder to scan. mu does not enforce this; test
fixtures may use human names.

| Role | Use |
| --- | --- |
| `worker` | Long-lived implementer (the default) |
| `reviewer` | Reads diffs; usually `--role read-only` |
| `scout` | One-shot recon |
| `oracle` | Second opinion before acting |
| `auditor` | Long-lived watcher; `--role read-only` |
| `planner` | Writes implementation plans |

## File paths

The state dir is `MU_STATE_DIR`, else `$XDG_STATE_HOME/mu`, else
`~/.local/state/mu`.

| Path | Contents |
| --- | --- |
| `<state-dir>/mu.db` | The SQLite DB for every workstream |
| `<state-dir>/workspaces/<workstream>/<agent>/` | Per-agent VCS workspace, created by `mu agent spawn --workspace` |
| `<sync-dir>/<machine_id>.jsonl` | This machine's segment; `<sync-dir>` is `MU_SYNC_DIR` |
| `<sync-dir>/<machine_id>.manifest` | `{count, last_hlc, sha256}` for segment verification |

Never put `MU_DB_PATH` inside `MU_SYNC_DIR`: syncing a live SQLite
file and its `-wal` and `-shm` sidecars corrupts it. `mu doctor` checks
for this.

mu reads no agent-template directory (`~/.pi/agent/agents/`,
`.pi/agents/`). A role is a name and a brief.
