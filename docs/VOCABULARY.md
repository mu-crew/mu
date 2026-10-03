# Vocabulary

Canonical terms for mu. Use these exact words in code, docs, error
messages, and the skill. If a doc uses a term not defined here, fix the
doc. Add a new term here before the code lands.

Verbs and flags live in `mu --help` and `mu <verb> --help`. Env vars are
in [reference/env.md](reference/env.md). Naming rules for flags, ids,
agent names, and file paths are in [reference/naming.md](reference/naming.md).

## Terms

### Topology and multiplexer

| Term | Meaning | Don't use |
| --- | --- | --- |
| **workstream** | The unit of organization: one **mux session** and one DB partition. | "project", "session" (alone), "context" |
| **scratch workstream** | The reserved workstream `scratch` for helpers outside any task DAG. Auto-created on first spawn with explicit `-w scratch`; `mu workstream init scratch` is rejected. | "throwaway ws", "temp workstream" |
| **multiplexer** / **mux** | The terminal program that owns panes: **tmux** or **herdr**. "mux" in code (`src/mux/`, `MU_MUX`), "multiplexer" in prose; one is active per invocation. | "terminal", "emulator", "backend" (alone) |
| **mux backend** | An implementation of `MuxBackend` (`src/mux/tmux.ts`, `src/mux/herdr.ts`). Owns everything backend-specific. | "driver", "provider", "adapter" |
| **mux detection** | Picks the mux backend: `MU_MUX` → `HERDR_ENV=1` → `$TMUX` → binary on `PATH` (tmux wins a tie) → `NoMultiplexerError`. | "auto-detect", "probe" |
| **mux session** | The container for one workstream's panes: tmux session `mu-<workstream>`, or herdr workspace labelled `mu-<workstream>`. | "mux workspace", "session" (alone) |
| **tmux session** | The tmux flavour of a **mux session**. | "session" (alone) |
| **window** | The grouping inside a mux session (tmux window, herdr tab), named by **window name**. | "tab" (except the `--tab` flag) |
| **window name** | A window's name: the agent's `--tab` value, or the agent name. | "tab name" |
| **pane** | One shell view inside a **window**. | "terminal", "shell" |
| **pane id** | The mux's stable pane handle: tmux `%15`, herdr `w1:p1`. Not the volatile tmux pane index, which is never stored. | "pane number", "pane index" |
| **pane title** | Equals the agent name. The fallback for **actor** identity when `$MU_AGENT_NAME` is absent. | "pane name" |
| **substrate** | An external system mu depends on: tmux, herdr, jj, sl, git, SQLite. | "dependency" (an npm dep), "service" |
| **crew** | Informal: the agents in a workstream. Prose only. | |

### Agents

| Term | Meaning | Don't use |
| --- | --- | --- |
| **agent** | A named process in a pane with a row in `agents`. Identity is `$MU_AGENT_NAME`, else the **pane title**. | "subagent", "worker" (a role) |
| **worker** | An agent in its role as task claimer. Prefer **agent** when ambiguous. | |
| **remote worker** | A worker running on another machine while its pane and the DB stay local. Recorded in task notes as `REMOTE: <host>:<path>` and `REMOTE_BASE: <agent>:<sha>`. | "remote agent record", "host registry" |
| **actor** | Whoever caused a state change (`ops.actor`); need not be a worker. | "caller", "author" (notes only) |
| **role** | The capability flag: `full-access` or `read-only`. | "permission", "tier" |
| **persistent** | An agent that stays alive across tasks. | "long-lived" (prose only) |
| **one-shot** | An agent that exists for one task. | "ephemeral", "transient" |
| **nudge** | The pi extension's one-shot keep-driving reminder: after a dispatch, if the orchestrator ends its turn with work IN_PROGRESS, it injects the SKILL.md rule once and continues. Logged as `--kind nudge`. | "goal", "loop" |
| **delegate** | A scratch agent started for one task; its answer returns when its control-socket `wait` resolves. The `mu_delegate` tool does it in one call; the pane stays attachable. | "subagent", "child agent" |
| **hidden subagent** | A child agent in other tools (pi-subagents, Claude Code and Codex task tools) with no pane to attach or steer. mu's counterpart is the **delegate**. | "subagent" (alone) |
| **agent state** | `busy`, `needs_input`, `needs_permission`, or `unknown`, from the **state source**. Not persisted; see [Agent state values](#agent-state-values). | "agent status", "lifecycle state" |
| **state source** | The **control socket** for pi agents; else herdr's `paneStatus()` or, on tmux, murmur. A silent pi socket gives `unknown` (`ctl missing`, `ctl refused`). | "scraper" |
| **control socket** / **ctl** | The per-agent unix socket (`$MU_CTL_SOCK`) the mu pi extension serves inside pi. **ctl state** is `ok`, `missing`, or `refused`. | "rpc", "daemon" |
| **session command** | `/new`, `/reload`, or `/compact [instructions]` sent to a pi agent. mu runs it inside pi through the ctl `command` op, never as a paste. Any other slash command to a pi agent is refused; `--via mux` types it into the pane. | "slash paste" |
| **outdated extension** | A running pi whose loaded extension is older than mu (exit 4 on a missing op). pi's `/reload` fixes it. | |
| **lastText** | A pi run's final assistant message, returned verbatim by `wait`. mu never interprets it. | "result", "output" (alone) |
| **ghost** | An `agents` row whose `pane_id` no longer exists. Pruned by **reconcile**. | "dead agent", "stale row" |
| **reaper** | The part of reconcile that releases a ghost's tasks to `OPEN`. Makes `mu task wait` exit 6. | "garbage collector", "janitor" |
| **needs attention** | An `IN_PROGRESS` task whose owner has been `needs_input` for `--stuck-after` seconds. Check with `mu agent read <owner>`. | "stuck", "stalled" (kept only in the `stuck` JSON field and exit-7 `STALL_DETECTED`) |
| **adopt** | Register an existing pane in the workstream's mux session as an agent (`mu agent adopt`). | "import", "absorb" |
| **reconcile** | Re-derive registry rows from the mux. Runs in `mu agent list` and `mu doctor`. | "sync", "refresh" |
| **extension** | The pi extension shipped in the mu package. | "plugin" |
| **skill** | The bundled `SKILL.md` that teaches the LLM. | "system prompt" |

### Tasks

| Term | Meaning | Don't use |
| --- | --- | --- |
| **task** | A node in the DAG with mandatory `impact` and `effort_days`, a **task status**, and a **substate**. | "issue", "ticket", "item" |
| **task status** | `OPEN`, `IN_PROGRESS`, or `CLOSED`. Any `CLOSED/*` satisfies a blocker. | "state" |
| **substate** | What the status means, shown as `STATUS/substate`; never null. `OPEN`: `todo`, `parked`. `IN_PROGRESS`: `active`. `CLOSED`: `done`, `rejected`, `wontfix`, `duplicate`, `superseded`. | "resolution", "reason" |
| **park** / **unpark** | `OPEN/todo` ↔ `OPEN/parked` (park needs `--why`). Parked tasks leave **ready**. | "defer", "snooze" |
| **task DAG** / **graph** | The directed acyclic graph of tasks. | "task list", "tree" |
| **edge** | The single edge type: `A blocks B` means A must close before B starts. | "dependency" (prose only) |
| **subtree** / **scope** | Tasks reachable from a root via blocks-edges. | "subgraph" |
| **track** | An independent subtree found by parallel-track detection. | "branch", "lane" |
| **diamond merge** | Merging two tracks that share a prerequisite into one. | "join" |
| **ready** | An `OPEN/todo` task with no open blockers (the `ready` view). | "unblocked", "available" |
| **goals** | Tasks with no outgoing edges (the `goals` view). | "leaves", "targets" |
| **sort key** | `--sort` value: `roi` (impact ÷ effort), `recency`, `age`, or `id`. | "order by" |
| **note** | An append-only piece of context on a task. | "comment", "log" |
| **claim** | Set `tasks.owner` to an agent. Atomic compare-and-set. | "assign" (prose only), "lock" |
| **owner** | The worker in `tasks.owner`; NULL after an **anonymous claim**. Never syncs. | "claimer", "assignee" |
| **anonymous claim** | A `--self` claim by an actor that is not a worker. `owner` stays NULL; `ops.actor` records who. | "unowned claim" |
| **release** | Clear `tasks.owner`. | "unclaim", "unassign" |

### Workspaces and housekeeping

| Term | Meaning | Don't use |
| --- | --- | --- |
| **workspace** | A VCS-isolated checkout (jj workspace, sl or git worktree, or a copy). Never the herdr sense. | "branch", "checkout" |
| **VCS backend** / **backend** | An implementation of `VcsBackend` or `MuxBackend`. Qualify which when both are in scope. | "driver", "provider" |
| **stale workspace** | A workspace behind the default branch (the `behind` column). mu never fetches. | "out of date", "drifting" |
| **refresh** | Rebase an agent's workspace onto a fresh base without touching its pane. | "recycle", "reset" |
| **workspace orphan** | A dir under `<state-dir>/workspaces/<workstream>/` with no `vcs_workspaces` row. Blocks later `--workspace` spawns. | "stray dir" |
| **stranded** | A workspace orphan whose workstream row is gone too. Only `mu workspace orphans --all` and `mu doctor` reach it. | "abandoned" |
| **missing workspace dir** | A `vcs_workspaces` row whose path is gone. Worse than an orphan: read surfaces still call it healthy. | "dangling row" |
| **dormant** | An idle workstream with no agents or workspaces: **finished** (all closed, 14 days) or **abandoned** (open tasks, 60 days). | "stale", "dead", "empty" |
| **residue** | Bytes in `<state-dir>` that no row references and no code reads. Reported by `mu doctor`, never removed. | "garbage", "junk" |
| **disk↔DB reconciliation** | `mu doctor`'s report-only `disk` section. Not **reconcile** (rows vs mux) or **drift** (log vs tables). | "gc", "cleanup" |
| **doctor** | The diagnostic command and its report. | "health check" |

### Ops log, sync, and undo

| Term | Meaning | Don't use |
| --- | --- | --- |
| **op** | One `ops` row, written by a trigger in the mutation's transaction. Holds only changed columns. | "event", "delta", "change" |
| **ops log** | The `ops` table: the append-only record that sync, undo, and history read. | "event log", "journal", "WAL" |
| **log entry** | An op as rendered by `mu log`, through one formatter (`src/log-render.ts`). | "message", "event" |
| **kind** | The operator's channel tag on a log entry (`mu log --kind`), stored as the op's `entity`. | "category", "type" |
| **log ledger** | A convention: a custom `--kind` used as a watcher loop's durable dedupe record. | "state file" |
| **intent** | The semantic label on an op (`task.close`), set once per SDK function via **op context**. | "verb", "action" |
| **group** | The ops of one user action (`group_id`), undone as a unit. Any unique id prefix works. | "transaction", "batch" |
| **op context** | The `_op_ctx` temp table that stamps intent, actor, and group onto ops. Set only via `src/op-context.ts`. | "thread local" |
| **apply** | Land one op under the **merge rules** (`src/apply.ts`). Idempotent; mints no op. | "merge", "import", "replay" |
| **merge rules** | Notes: **grow-only set**. Tasks, workstreams: **per-field LWW**. Edges: **LWW-element-set**. Unknown entities are ignored. | "conflict resolution", "CRDT" |
| **per-field LWW** | Each field keeps the value from the newest **HLC** that wrote it. | "row LWW" |
| **grow-only set** | Insert-only entities (notes, log messages). Identity is `(task, author, content, created_at)`. | "append-only log" |
| **LWW-element-set** | Add and remove both carry an HLC, so re-adding converges in any order. | "2P-set" |
| **tombstone** | An `op='del'` row. There is no tombstone table. | "deletion marker" |
| **resurrection** | A put newer than a seen tombstone, which legitimately recreates the row. | "undelete", "revive" |
| **provenance** | Which HLC last wrote a field, derived from the ops log by query, never stored. | "version vector" |
| **inverse op** | The op that reverts another; an ordinary op, so undo syncs and is undoable. | "rollback" |
| **superseded** (group) | A later group wrote the same field, so `mu undo` refuses (exit 4) without `--force`. | "stale" |
| **teardown** | Kill a workstream's mux session and delete its rows. `mu undo` restores rows, not panes or dirs. | "destroy", "nuke", "purge" |
| **drift** | The ops log and live tables disagree. Always a bug. | "inconsistency", "corruption" |
| **shallow / deep check** | Drift checks in `mu doctor` and `mu doctor --deep` (full rebuild). | "fsck" |
| **portable** | Syncable: `workstreams`, `tasks`, `task_edges`, `task_notes`. The rest is **machine-local** (`src/db.ts`). | "shared", "global" |
| **HLC** | Hybrid logical clock `(wall_ms, counter, machine_id)`; orders every op. Never regresses. | "timestamp", "version" |
| **machine_id** | Per-state-dir uuid naming this DB's **peer** and **segment**. | "device id", "host id" |
| **segment** | `<sync-dir>/<machine_id>.jsonl`: one machine's ops, single writer. | "replica", "shard" |
| **peer** | Another machine, found by its segment; named by `machine_id` prefix. **Stale** after 24h unchanged. | "node", "remote" |
| **watermark** | `sync_peers.last_applied_seq`: how many lines of a peer's segment have been applied. | "offset", "cursor" |
| **flush** / **ingest** | Write my ops to my segment; apply peers' from their watermarks. Every invocation, when `MU_SYNC_DIR` is set. | "push", "pull" |
| **reprojection** | After ingest, apply deferred ops whose parent arrived from another peer. | "retry queue" |
| **mixed fleet** | Machines sharing state across different OSes or filesystems. | "cluster" |

### CLI and TUI

| Term | Meaning | Don't use |
| --- | --- | --- |
| **CLI** | The `mu` binary. | "tool" |
| **operation** | A canonical mu verb, each a thin wrapper over a typed SDK function. | "command", "action" |
| **qualified ref** | `<workstream>/<name>`, used instead of `-w`. | "prefixed name" |
| **DB** / **registry** | `<state-dir>/mu.db` and its tables. | "store" |
| **TUI** | The read-only ink dashboard: bare `mu` in a TTY, or `mu state --tui`. | "GUI" |
| **dashboard** | The TUI's grid of cards. | "home screen" |
| **card** | A dashboard tile with a toggle digit 0-9. | "panel", "section" |
| **popup** | A card's full-screen drill-down (`Shift+digit`). One at a time. | "modal", "dialog" |
| **TitledBox** | The bordered component every card and popup uses. | "box" (alone) |
| **tick** | The TUI's data refresh (default 1s; `+`, `-`, `=` adjust). | "poll", "frame" |
| **yank** | Copy the focused row's `mu` command to the clipboard (`y`). | "copy" |
| **act-intent** | The action a yank stands for. The TUI never runs it. | "action proposal" |
| **footer** | The bottom line showing the last yank. `c` clears it. | "status line" |
| **toast** | A transient in-popup message. | "notification" |
| **help overlay** | The `?` or `F1` keymap overlay. | "cheat sheet" |
| **glanceable** / **drill-down** | The two TUI properties: cards are never exhaustive; popups are scrollable and filterable. | "compact", "detail view" |

## Topology

```
  workstream  (one DB partition)
  ┌──────────────────────────────────────────────────────────────┐
  │  mux session: mu-auth-refactor  (tmux session / herdr ws)    │
  │  ┌──────────────────────────┐  ┌──────────────────────────┐  │
  │  │ window: Backend          │  │ window: Review           │  │
  │  │ ┌──────────┐ ┌─────────┐ │  │ ┌──────────────────────┐ │  │
  │  │ │ worker-1 │ │worker-2 │ │  │ │ reviewer-1 (read-only)│ │  │
  │  │ │ pane     │ │ pane    │ │  │ │ pane                 │ │  │
  │  │ └──────────┘ └─────────┘ │  │ └──────────────────────┘ │  │
  │  └──────────────────────────┘  └──────────────────────────┘  │
  └──────────────────────────────────────────────────────────────┘
```

Actor resolution reads `$MU_AGENT_NAME`, then the **pane title**
(adopted panes have only a title). On tmux, read `#{pane_title}`, not
`#W`: they differ when agents share a window.

## Agent state values

Glyphs live in `src/glyphs.ts` (`AGENT_STATE_GLYPH`).

| Value | Glyph | Meaning |
| --- | --- | --- |
| `busy` | nf-fa-play | Working |
| `needs_input` | nf-fa-moon_o | Waiting for input |
| `needs_permission` | nf-fa-lock | Waiting for a human answer |
| `unknown` | nf-fa-question_circle | No usable reading; a reason accompanies it |

The extension's `busy` maps to `busy` and `idle` to `needs_input`. Murmur
`working` maps to `busy`, `blocked` to `needs_permission`, and `idle`,
`done`, and `crashed` to `needs_input`. The `agents.status` column is
deprecated, always `spawning`, and never read.

## Reserved and avoided terms

| Avoid | Why | Use instead |
| --- | --- | --- |
| "subagent" | Means a hidden child in other tools; mu has none | "agent", "delegate", or "hidden subagent" when contrasting |
| "session" | pi, tmux, and herdr each have one | "workstream", "mux session", "tmux session" |
| "workspace" (mux sense) | Collides with the VCS workspace | "mux session"; "herdr workspace" only about herdr's CLI |
| "project" | Means a `.pi/` project root | "workstream" |
| "context" | LLM, project, and fork context | Be specific: "task context" |
| "tab" | tmux has windows (herdr calls them tabs) | "window"; `--tab` is the flag |
| "thread" | OS, chat, and git threads | Be specific |
| "message" | LLM message, log message, pane input | "log entry", "send" |
| "config" | mu has no config file | "settings", "options" |
| "manager", "instance" | Vague | The specific noun |
| "service", "broker" | Imply a daemon or middleware; mu has none | Be specific |
| "plugin" | pi has extensions | "extension" |
| "checkpoint", "snapshot" | mu has no savepoints | "group" (undo unit), "backup" (whole-DB copy) |
| "agent type", "agent definition", "agent template" | mu has no class system or templates; spawn flags and the prompt define an agent | "agent role", or describe the spawn |
| "worker" (general) | Names the task-claimer role | "agent" |
| "claimer" | | "owner" |

## Senses of "session"

| mu term | What it is |
| --- | --- |
| **workstream** | mu's unit of organization |
| **mux session** | The backend-agnostic container for a workstream's panes |
| **tmux session** | The tmux session `mu-<workstream>` |
| **herdr session** | herdr's server-level unit (one socket). Not a mux session: a workstream maps to a herdr workspace, one level down |
| **pi session** | pi's conversation |
| **agent session** | Colloquial for an agent's lifetime; avoid in code |

New columns and variables say `workstream_id`, not `session_id`. The
`agents.session_id` column keeps its name for schema stability.
