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
| **scratch workstream** | The reserved workstream `scratch` for helpers outside any task DAG. Auto-created on first spawn with explicit `-w scratch`; `mu workstream init scratch` is rejected. Its session keeps a `_mu` window, so it stays open after the last agent closes; `teardown --empty` skips it. | "throwaway ws", "temp workstream" |
| **multiplexer** / **mux** | The terminal program that owns panes: **tmux** or **herdr**. "mux" in code (`src/mux/`, `MU_MUX`), "multiplexer" in prose; one is active per invocation. | "terminal", "emulator", "backend" (alone) |
| **mux backend** | An implementation of `MuxBackend` (`src/mux/tmux.ts`, `src/mux/herdr.ts`). Owns everything backend-specific. | "driver", "provider", "adapter" |
| **mux detection** | Picks the mux backend: `MU_MUX` → `HERDR_ENV=1` → `$TMUX` → binary on `PATH` (tmux wins a tie) → `NoMultiplexerError`. | "auto-detect", "probe" |
| **mux session** | The container for one workstream's panes: tmux session `mu-<workstream>`, or herdr workspace labelled `mu-<workstream>`. | "mux workspace", "session" (alone) |
| **tmux session** | The tmux flavour of a **mux session**. | "session" (alone) |
| **window** | The grouping inside a mux session (tmux window, herdr tab), named by **window name**. | "tab" (except the `--tab` flag) |
| **window name** | A window's name: the agent's `--tab` value, or the agent name. | "tab name" |
| **pane** | One shell view inside a **window**. | "terminal", "shell" |
| **pane id** | The mux's stable pane handle: tmux `%15`, herdr `w1:p1`. Not the volatile tmux pane index, which is never stored. | "pane number", "pane index" |
| **substrate** | An external system mu depends on: tmux, herdr, git, SQLite. | "dependency" (an npm dep), "service" |
| **crew** | Informal: the agents in a workstream. Prose only. | |

### Agents

| Term | Meaning | Don't use |
| --- | --- | --- |
| **agent** | A named process in a pane with a row in `agents`. Identity is `$MU_AGENT_NAME`; mu never reads or writes pane titles. | "subagent", "worker" (a role) |
| **worker** | An agent in its role as task claimer. Prefer **agent** when ambiguous. | |
| **remote worker** | An agent spawned with `--host <profile>`: its pane is local and is the transport (the profile's `shell` template runs there and forwards the remote pi's control socket), its process is remote, and its host, remote cwd and base are `agents.host/cwd/base`. The pane dying is the agent dying. | "REMOTE: note", "remote-env" | "remote agent record", "host registry" |
| **collect** | `mu agent collect <agent>`: run a remote worker's `--fetch` template locally and pin the fetched commit as `refs/mu/collect/<ws>/<agent>`; the commit is recorded as `agents.collected_head`, and `agent close` accepts a remote worktree at its base or that HEAD. mu prints the merge, never runs it. | "pull", "sync" (that is `mu sync`) |
| **delivery unknown** | A send/fresh/interrupt/command request was written to a live agent's control socket but no reply arrived (`AgentSendIndeterminateError`). pi may have acted; read the pane before resending. | "refused" (the request never went out) |
| **actor** | Whoever caused a state change (`ops.actor`); need not be a worker. | "caller", "author" (notes only) |
| **role** | Advisory label, `full-access` or `read-only`: recorded and shown, not enforced and not a security boundary. A read-only auditor simply gets no worktree. | "permission", "tier", "capability" |
| **persistent** | An agent that stays alive across tasks. | "long-lived" (prose only) |
| **one-shot** | An agent that exists for one task. | "ephemeral", "transient" |
| **nudge** | The pi extension's one-shot keep-driving reminder: after a dispatch, if the orchestrator ends its turn with work IN_PROGRESS, it injects the SKILL.md rule once and continues. Logged as `--kind nudge`. | "goal", "loop" |
| **delegate** | A scratch agent started for one check. Its call is a `delegate`-kind task; its answer is that task's report and returns to pi as a follow-up echo. The `mu_delegate` tool does it in one call; the pane stays attachable. | "subagent", "child agent" |
| **envelope** | The one JSON document a `--json` invocation prints on stdout: `{ok:true,data,next}`, or on failure `{ok:false,error,message,next,exit}` with the real non-zero exit (`src/output-contract.ts`). A failed verb that already produced evidence (a spawn whose `--send` failed, a `doctor` report) carries it in `data`. `mu log --tail` is always NDJSON (one item per line), never enveloped. | "wrapper", "result object" |
| **delegate call** | Using a delegate for one check (a refuter, judge, claim checker): one `mu_delegate` call, or `mu agent spawn -w scratch` + `send --fresh` + `wait --json` without the tool. A call is a task (see **task kind**) with a `call_id` and a state (`queued starting running recording done failed refused cancelled`, `mu delegates`). Its verdict is recorded on the task it judged, then the call's own report and close. Admission control (`MU_DELEGATE_MAX` running, a bounded queue) stays; a call past it is **refused**: durable, parked, reissuable, never dropped. | "subtask" |
| **hidden subagent** | A child agent in other tools (pi-subagents, Claude Code and Codex task tools) with no pane to attach or steer. mu's counterpart is the **delegate**. | "subagent" (alone) |
| **agent state** | `busy`, `needs_input`, `needs_permission`, or `unknown`, from the **state source**. Not persisted; see [Agent state values](#agent-state-values). | "agent status", "lifecycle state" |
| **state source** | The **control socket** for pi agents; else herdr's `paneStatus()` or, on tmux, murmur. A silent pi socket gives `unknown` (`ctl missing`, `ctl refused`). | "scraper" |
| **control socket** / **ctl** | The per-agent unix socket (`$MU_CTL_SOCK`) the mu pi extension serves inside pi. **ctl state** is `ok`, `missing`, or `refused`. | "rpc", "daemon" |
| **session command** | `/new`, `/reload`, or `/compact [instructions]` sent to a pi agent. mu runs it inside pi through the ctl `command` op, never as a paste. Any other slash command to a pi agent is refused. | "slash paste" |
| **outdated extension** | A running pi whose loaded extension is older than mu (exit 4 on a missing op). pi's `/reload` fixes it. | |
| **lastText** | A pi run's final assistant message, returned verbatim by `wait`. `mu_delegate` `record` finds its first `VERDICT:` line (also behind one role word such as `REFUTER:`) and writes everything from it, uncapped, as a `verdict` task note, then the call's report; mu applies no close or status change to the judged task from it. Planned: only a valid **CLOSE block** at its end is applied. | "result", "output" (alone) |
| **ghost** | An `agents` row whose `pane_id` no longer exists. Pruned by **reconcile**. | "dead agent", "stale row" |
| **reaper** | The part of reconcile that releases a ghost's tasks to `OPEN`. Makes `mu task wait` exit 6. | "garbage collector", "janitor" |
| **needs attention** | An `IN_PROGRESS` task whose owner has been `needs_input` for `--stuck-after` seconds. Check with `mu agent read <owner>`. | "stuck", "stalled" (kept only in the `stuck` JSON field and exit-7 `STALL_DETECTED`) |
| **reconcile** | Re-derive registry rows from the mux. Runs in `mu agent list` and `mu doctor`. | "sync", "refresh" |
| **extension** | The pi extension shipped in the mu package. | "plugin" |
| **skill** | The bundled `SKILL.md` that teaches the LLM. | "system prompt" |

### Tasks

| Term | Meaning | Don't use |
| --- | --- | --- |
| **task** | A node in the DAG with mandatory `impact` and `effort_days`, a **task status**, and a **substate**. | "issue", "ticket", "item" |
| **task status** | `OPEN`, `IN_PROGRESS`, or `CLOSED`. Any `CLOSED/*` satisfies a blocker. | "state" |
| **substate** | What the status means, shown as `STATUS/substate`; never null. `OPEN`: `todo`, `parked`, `triage`. `IN_PROGRESS`: `active`. `CLOSED`: `done`, `rejected`, `wontfix`, `duplicate`, `superseded`. | "resolution", "reason" |
| **park** / **unpark** | `OPEN/todo` ↔ `OPEN/parked` (park needs `--why`). Parked tasks leave **ready**. | "defer", "snooze" |
| **triage** / **accept** | `OPEN/triage` is a proposed task, usually a review **finding**, not yet accepted as work: out of **ready**, refused by `claim`, but it blocks its dependents. `mu task add --triage` creates one; `mu task accept` moves it to `OPEN/todo`; declining is `close --as rejected` or `--as duplicate`. | "inbox", "pending" |
| **human-needed** | `mu human-needed <reason>`: the caller records a `human` task, `OPEN/parked`, whose brief is the reason; the loop's only legitimate stop. Scoped to the caller (`human_needs`, machine-local: managed `<ws>/<agent>` or `pi:<session>`, never a note author; a rebuild keeps the task but loses the caller). Same reason is a no-op; a new reason appends a brief. A `human` task resolves only by an explicit `mu task close`: unpark, claim (even `--force`) and a CLOSE block are refused. Never created on an error or a queue refusal. | "blocker", "escalation" |
| **finding** | One problem a reviewer, checker, or auditor reports. Recorded as an `OPEN/triage` task (the mu way), or as an answer line when a **delegate** reviews something nobody will track. | "issue", "comment" |
| **task DAG** / **graph** | The directed acyclic graph of tasks. | "task list", "tree" |
| **edge** | The single edge type: `A blocks B` means A must close before B starts. | "dependency" (prose only) |
| **subtree** / **scope** | Tasks reachable from a root via blocks-edges. | "subgraph" |
| **explicit scope** / **injected scope** | The workstream a verb acts on: `-w <name>` or a qualified `<ws>/<name>` ref (explicit), else the `MU_WORKSTREAM` spawn gives a managed worker (injected, only with `MU_MANAGED_AGENT=1`). Nothing else routes a verb: not `MU_SESSION`, not the mux session name, which only appears as a suggestion in the one-line error. | "ambient workstream", "current workstream", "default workstream" |
| **track** | An independent subtree found by parallel-track detection. | "branch", "lane" |
| **diamond merge** | Merging two tracks that share a prerequisite into one. | "join" |
| **ready** | An `OPEN/todo` task with no open blockers (the `ready` view). | "unblocked", "available" |
| **goals** | Tasks with no outgoing edges (the `goals` view). | "leaves", "targets" |
| **sort key** | `--sort` value: `roi` (impact ÷ effort), `recency`, `age`, or `id`. | "order by" |
| **note** | An append-only piece of context on a task. | "comment", "log" |
| **claim** | Set `tasks.owner` to an agent. Atomic compare-and-set. | "assign" (prose only), "lock" |
| **owner** | The worker in `tasks.owner`; NULL after an **anonymous claim**. Never syncs. | "claimer", "assignee" |
| **anonymous claim** | A `--self` claim by an actor that is not a worker. `owner` stays NULL; `ops.actor` records who. | "unowned claim" |
| **release** | Clear `tasks.owner`; an `IN_PROGRESS` task returns to `OPEN` (`--reopen` also reopens a `CLOSED` one). | "unclaim", "unassign" |

### Recipe gates

| Term | Meaning | Don't use |
| --- | --- | --- |
| **fast gate** | Repo-defined iteration checks: format, lint, unit tests and cheap integration tests. Cost is measured, not guaranteed seconds. | "gate command" (alone) |
| **slow gate** | The remaining merge checks: real-environment e2e, release and packaging checks. | "gate command" (alone) |
| **gate budget** | The slow gate's target wall time; crossing it prioritises test upkeep. | "timeout" |
| **gate record** | A note identifying commit/tree, exact command/scope, result, duration, environment/toolchain and skips; reuse needs equivalent conditions. | "tests pass" (alone) |
| **test upkeep** | Ordinary DAG work to profile, speed up, move down, merge or remove tests while preserving coverage; see [test-health](../skills/mu/recipes/test-health.md). | "coverage reduction" |
| **test level** | Unit < integration < e2e; use the lowest level that catches the guarded failure. | |
| **review gate** | A review task blocked by a work task, deciding whether its commits count. | "gate command" |
| **merge batch** | Accepted commits combined into one pinned tree for full merge verification, without a crew-wide barrier. | "wave" (when only verification is batched) |

### Worktrees and housekeeping

| Term | Meaning | Don't use |
| --- | --- | --- |
| **worktree** | A git worktree for one agent (`spawn --worktree`): `git worktree add --detach`, the agent's cwd. Closed by the one rule: dirty refuses, merged is removed, unmerged commits keep a branch. Git only. | "workspace", "checkout" |
| **worktree registry** | The machine-local `worktrees` table (path, agent, workstream, root, base, last collected head). Outlives the agent row; only closing the worktree removes it. | "workspace row" |
| **backend** | An implementation of `MuxBackend` (tmux, herdr). | "driver", "provider" |
| **missing worktree dir** | A `worktrees` row whose path is gone. Read surfaces still call it healthy. | "dangling row" |
| **dormant** | An idle workstream with no agents or worktrees: **finished** (all closed, 14 days) or **abandoned** (open tasks, 60 days). | "stale", "dead", "empty" |
| **residue** | Bytes in `<state-dir>` that no row references and no code reads. Reported by `mu doctor`, never removed. | "garbage", "junk" |
| **disk↔DB reconciliation** | `mu doctor`'s report-only `disk` section. Not **reconcile** (rows vs mux) or **drift** (log vs tables). | "gc", "cleanup" |
| **doctor** | The diagnostic command and its report. | "health check" |

### Ops log and sync

| Term | Meaning | Don't use |
| --- | --- | --- |
| **op** | One `ops` row, written by a trigger in the mutation's transaction. Holds only changed columns. | "event", "delta", "change" |
| **ops log** | The `ops` table: the append-only record that sync and history read. | "event log", "journal", "WAL" |
| **log entry** | An op as `mu log` prints it: one escaped line of at most 400 characters (or one JSON item keyed by the `ops` column names: `key`, `actor`, `entity`, `group_id`, `created_at`, `rendered`), through one formatter (`src/log-render.ts`). Parent-row touch ops are not entries. A cut says `more=N`/`cut=N` and names the read that recovers it by seq (`mu log --seq A..B`, `mu log --after S`), never by filter. An intent this build does not know prints as `op put|del <key> intent=… kind=… patch=…`, never as a verb. | "message", "event" |
| **kind** | The operator's channel tag on a log entry (`mu log --kind`), stored as the op's `entity`. `workstream`, `task`, `edge`, and `note` are reserved. | "category", "type" |
| **log ledger** | A convention: a custom `--kind` used as a watcher loop's durable dedupe record. | "state file" |
| **intent** | The semantic label on an op (`task.close`), set once per SDK function via **op context**. | "verb", "action" |
| **group** | The ops of one user action (`group_id`), read as a unit (`mu log --group`). Any unique id prefix works. | "transaction", "batch" |
| **op context** | The one-row `op_ctx` table that stamps intent, actor, and group onto ops. Written only by `src/op-context.ts`, inside a transaction the wrapper owns, so it holds defaults at rest. | "thread local" |
| **scoped views** | The `TEMP` views `ready`, `blocked`, `blockers` that `mu db query -w <ws>` (or `mu db --shell -w <ws>`) installs on its own connection, cutting the global views to one workstream (id as a literal; same columns). `main.ready` stays the global one. | "filtered view", "session views" |
| **apply** | Land one op under the **merge rules** (`src/apply.ts`). Idempotent; mints no op. | "merge", "import", "replay" |
| **merge rules** | Notes: **grow-only set**. Tasks, workstreams: **per-field LWW**. Edges: **LWW-element-set**. Unknown entities are ignored. | "conflict resolution", "CRDT" |
| **per-field LWW** | Each field keeps the value from the newest **HLC** that wrote it. | "row LWW" |
| **grow-only set** | Insert-only entities (notes, log messages). Identity is `(task, author, content, created_at)`. | "append-only log" |
| **LWW-element-set** | Add and remove both carry an HLC, so re-adding converges in any order. | "2P-set" |
| **tombstone** | An `op='del'` row. There is no tombstone table. | "deletion marker" |
| **resurrection** | A put newer than a seen tombstone, which legitimately recreates the row. | "undelete", "revive" |
| **provenance** | Which HLC last wrote a field, derived from the ops log by query, never stored. | "version vector" |
| **teardown** | Soft: kill a workstream's mux session, delete its machine-local agent rows whose pane is dead (a live pane keeps its row, orphaned; worktrees are never removed), set `torn_down_at`. Tasks, edges and notes stay, hidden. Previewed first, applied with `--if <rev>`. Panes do not come back. Reusing the name (`init --if`) hard-deletes the old rows. | "destroy", "nuke", "purge" |
| **agent incarnation** | `AgentRow.incarnation`: the registry row's AUTOINCREMENT id (`id` in `--json` agent records, with `pane_id`, `workstream_id`; the SDK keeps camelCase). Never reused, so a name deleted and created again is a new one even on the same pane id. Every destructive agent write compares it (`deleteAgent`'s `expected`, `agent close --if`); not pi's **incarnation**. | "agent id", "pane id" |
| **incarnation** | A pi process's id on its control socket: minted once per process, kept across `/new` and `/reload`, new after a restart. `send` returns it; `wait --inc` refuses another one. | "session id", "pid" |
| **msgId / receipt** | The id a ctl `send`, `--fresh` or `--interrupt` carries. `status {msgId}` (`mu agent check`) says whether the extension accepted it: the receipt for a send that got no reply. Never a reason to resend. | "ack", "nonce" |
| **drift** | The ops log and live tables disagree. Always a bug. | "inconsistency", "corruption" |
| **shallow / deep check** | Drift checks in `mu doctor` and `mu doctor --deep` (full rebuild). | "fsck" |
| **scored** | `tasks.scored`: impact/effort were given (`-i`/`-e`, `update`), not defaulted (50 / 1). `ready` order: scored by impact/effort desc, then unscored oldest first. | "prioritised" |
| **dispatch host** | `tasks.dispatch_host` (synced): the `machine_identity` allowed to dispatch the task; `mu task auto` sets it to this machine; `next` on another machine skips it. Not the remote **host profile** that `--host` selects. | "target machine" |
| **local-write guard** | A persistent trigger gated on `applying = 0`: claim CAS, close needs evidence, close to `done` refuses open blockers. Ingest and import are never blocked; `mu doctor` warns about the states they accept. | "constraint", "validation" |
| **task record** | One task as a read prints it: a single escaped TAB-separated line `task id STATE key=value … title` (<= 400 characters), or one JSON item whose keys are the SQL column names (`id` is the `local_id`; `workstream_id` and `owner_id` are the real foreign keys; `owner` appears only while IN_PROGRESS). A cut says `more=N`/`cut=N` and names one way back: the same command with `--all` (`--full` on `owned-by`), uncapped. | "row", "card", "name" (as a key) |
| **open frontier** | The part of the task DAG `task tree` and the dashboard read (`loadOpenTaskFrontier`): open tasks expand, CLOSED neighbours are leaves counted past a few, depth and node counts are capped, and every cap says how much it left out. Not `loadFullDag`, which is the whole workstream. | "subtree" |
| **note kind** | `task_notes.kind`: `brief`, `report`, `verdict`, `close` or `note`. Set once at insert; a local change raises. | "note type", "tag" |
| **torn down** | `workstreams.torn_down_at` set (soft teardown). Views and reads skip it (exit 3 "is torn down"); ingest still sees the row. Teardowns an earlier mu wrote as deletes stay final and are listed from the ops log. | "archived", "deleted" |
| **revision** | `rev=<n>`: a number a preview prints and `--if <n>` must repeat. `workstreamRevision` hashes the newest op touching the workstream plus its agents (name, pane) and worktrees, so any change in those since the preview makes the destructive verb refuse (exit 4). `taskRevision` (src/revision.ts) is the task-side revision: a hash derived from current state (task row, owner, incoming and outgoing edges, note count; never a counter, so sync apply and cascades move it too), shown as `revision` by `task show`/`list` and as `rev` by a `task delete` preview; `--if <rev>` on `task delete`/`block`/`unblock`/`reparent`/`claim`/`release` refuses a changed task (exit 4, `expected_rev`/`current_rev` in `--json`). `agentRevision` is the agent-side one: a hash of the registry **agent incarnation**, the row's fields, every owned task (any workstream) and the registered worktree rows (an orphan worktree has its own); bare `agent close` previews it and `--if <rev>` applies. Also called **preview revision**. | "etag", "version" |
| **portable** | Syncable: `workstreams`, `tasks`, `task_edges`, `task_notes`. The rest is **machine-local** (`src/db.ts`). | "shared", "global" |
| **HLC** | Hybrid logical clock `(wall_ms, counter, machine_id)`; orders every op. Never regresses. | "timestamp", "version" |
| **machine_id** | Per-state-dir uuid naming this DB's **peer** and **segment**. | "device id", "host id" |
| **segment** | `<sync-dir>/<machine_id>.jsonl`: one machine's ops, single writer. | "replica", "shard" |
| **peer** | Another machine, found by its segment; named by `machine_id` prefix. **Stale** after 24h unchanged. | "node", "remote" |
| **watermark** | `sync_peers.last_applied_seq`: how many lines of a peer's segment file have been applied. A conflict copy has its own, keyed by its file stem. | "offset", "cursor" |
| **flush** / **ingest** | Write my ops to my segment; apply peers' from their watermarks. Every invocation, when `MU_SYNC_DIR` is set. | "push", "pull" |
| **fold** | The pure function from the ops of one key (and its tombstone horizon) to that row's state (`src/fold.ts`). Live apply and rebuild both use it, so live == rebuild for any arrival order. | "merge", "reprojection", "retry queue" |
| **mixed fleet** | Machines sharing state across different OSes or filesystems. | "cluster" |

### CLI and TUI

| Term | Meaning | Don't use |
| --- | --- | --- |
| **CLI** | The `mu` binary. | "tool" |
| **operation** | A canonical mu verb, each a thin wrapper over a typed SDK function. | "command", "action" |
| **qualified ref** | `<workstream>/<name>`, used instead of `-w`. | "prefixed name" |
| **DB** / **registry** | `<state-dir>/mu.db` and its tables. | "store" |
| **TUI** | The read-only ink dashboard. The 3.x card TUI (cards, popups, toasts, tick, help overlay) is removed; bare `mu` prints help until the planned dashboard lands. | "GUI" |

### Planned terms (mu-next, not shipped)

Terms for the [mu-next contract](mu-next/surface-contract.md). None
describes shipped behaviour; each unit named there moves its rows up
into the tables above, without the "planned" label, in the commit that
ships the code. The kernel pieces that do ship are marked.

<!-- doc-cli-drift:skip-start -->

| Term | Meaning | Don't use |
| --- | --- | --- |
| **task kind** | `tasks.kind`: `work` (default), `delegate` or `human`. Not a **note kind** (`task_notes.kind`) and not a log **kind** (`mu log --kind`): three columns, three vocabularies. | "task type" |
| **wave** | `tasks.wave`: a label grouping the delegate calls of one fan-out so one wait returns one verdict tally. Not a **merge batch**. | "batch" |
| **call_id** | The durable id of one `mu_delegate` call (`delegate_calls.call_id`), session-qualified: `pi:<session>:<n>`. A repeat of the same call is deduplicated by it; a changed request under it is refused. Not a **msgId**. | "request id" |
| **attempt key** | Names one task-bound spawn attempt with its task: `agent spawn --task <t> [--attempt <k>]` is the key `manual:<k>` (default `manual:<task id>`). The same key replays its saved outcome and never sends a second prompt; a changed request under it conflicts (exit 4); reopened work takes a new key. The executor's authorised attempts live in `task_auto.last_spawn`, a different namespace. | "nonce" |
| **remote recovery** | `remote_recovery`: one machine-local row per ORIGINAL registry incarnation (`agents.id`) of a finalized remote worker (host, worktree path and base all recorded), written by an AFTER DELETE trigger on `agents` (and a BEFORE DELETE one on `workstreams` for the cascade; `src/db-recovery.ts`) in the transaction of ANY delete of its row: the reaper (`reap`, also raw SQL), workstream teardown (`teardown`) and a workstream deletion cascade (`workstream-delete`). It keeps the host, path, base, last collected HEAD, the exact aside path (`asideOf(cwd, agents.id)`, never derived from a later id), the profile's exec/repo when it existed, and why. No foreign key (it outlives the agent, its workstream and its host profile), no op, no sync; `mu rebuild` reports it lost. A record of a resource, not a live channel or an agent. `agent close` that itself removed the tree writes none. `agent close <name>` / `agent collect <name>` read it back when no agent holds the name (`--recovery <id>` = the original incarnation, picks one of several; the preview's `kind` is `recovery`, its `recovery_id` is never the registry `id`); a current agent, a shared path (a live agent, or a NEWER record of the same host and path), or a changed profile refuses; a `--recovery <id>` that is gone is never read as the live agent, and only that record is deleted, only once the tree is removed, kept on a branch or gone. | "tombstone", "graveyard" |
| **spawn receipt** | `spawn_receipts`: one machine-local row per (task, attempt key), written BEFORE each effect: `reserved`, `pane` (agent row + pane exist), `claimed`, `sending` (the prompt may be written: never resend), then `sent` or `unknown`; `failed` is definitely unsent and rolled back. It stores the registry id (`agents.id`) and pane with no foreign key, so a replay after the agent was deleted or the name reused says `stale` and never acts on the replacement; the send re-checks that id + pane and the claim just before the write. | "journal row", "ticket" |
| **delivery unknown** | A prompt that may or may not have landed (written, no reply; a pane that died after the write; a pane paste). Never resent and never reaped: the pane and the claim stay, `mu agent check` asks the extension, and an id the extension no longer remembers (it keeps the last 64) is still unknown, not unsent. | "failed send" |
| **spawn replay** | Returning the saved `{msgId, incarnation, runs}` for a repeated spawn attempt. A **receipt** (msgId) answers "did pi accept this send"; replay answers "was this attempt already made". | "retry" |
| **spawner** | `agents.spawner`: who spawned an agent: `<workstream>/<agent>` for a managed caller, else `pi:<PI_SESSION_ID>`. Never guessed from task ownership; null on older rows. | "parent" (alone), "owner" |
| **wait ref** | One thing a wait watches: a task, an agent (with `--after-runs`, `--inc`) or a delegate. | "target" |
| **wait event** | What ended a wait: `closed`, `settled`, `input`, `dead`, `stall`, `delegate`, `pane-exit`, `heartbeat` or `interrupted`, with the ref, **incarnation** and `runs`. | "result" (alone) |
| **first / all** | A wait returns on the **first** event of any owned ref (default) or, with the all-of alias, once every ref has closed. | "any", "race" |
| **heartbeat** | A wait's own cap (about 25 minutes): it ends with `timedOut` true and `ok:true`, never an error. | "keepalive" |
| **embedded exit** | The process exit number repeated inside the JSON (`exit`), so a pipe that hides the status keeps the reason: 0 fired or timed out, 6 dead, 7 stall, 130 interrupted. | "status code" |
| **wait cursor** | `wait_cursors`: per caller and ref, the last consumed incarnation and runs, so a settled run is never reported twice and a restart is not mistaken for one. Machine-local. | "offset", **watermark** (that is sync) |
| **completion token** | What a **wait cursor** stores as `(incarnation, runs)` once an event is delivered: an agent's ctl incarnation and settled run count; `closed` + the task's newest note id (a re-close is news); `delegate` + 1. Written only for delivered refs, in the transaction that ends the wait. | "ack" |
| **owned event** | An event on a ref the callers own: their registered refs and their own delegate calls. The wait observes them while listed refs are waited on (`eventScope: owned`, the default; `refs` sees only the listed ones); another caller's are never seen. | "global event" |
| **callers** | The SET a wait owns for: the managed `<ws>/<agent>` (spawned workers, human stops) and `pi:<session>` (delegate calls), whichever are present. Owned refs, delegates, human needs and the tally are the union. An empty set owns nothing; never "every caller". | "identity", "user" |
| **unconsumed baseline** | `wait_registrations.baselines_json`: per registered agent ref, the ctl run count, pi incarnation and registry id a producer saw BEFORE its effect, so a run that settles before any wait starts is still delivered. Not a **cursor** (which is what a wait already delivered). | "watermark" |
| **stall** | A wait event: an IN_PROGRESS work task whose owner sat needs_input (or behind a dead control socket) for `stuckAfterMs`. The engine detects and reports it (exit 7); `handleStall` owns any action. | "stuck" (the legacy warning) |
| **urgent event** | In an **all** wait: a dead owned ref, an agent blocked on a dialog or an owned delegate report. Ends the wait early and does not count toward "all". | "interrupt" |
| **wait registration** | `wait_registrations`: per caller, the typed refs it still owes a wait (each existed when registered), and whether a wait is `armed` (work owed) or `waiting` (inside one). `generation` counts the waits begun: a wait that ends compares it, so an older one cannot overwrite a newer. Ending a wait removes only the refs it delivered. An optimisation and observable state, never the only test: the settle hook also reads the tasks and delegates directly. Not a **cursor**. | "subscription" |
| **agent observation** | `AgentObservation`: one typed read or watch result of an agent. `agentId` is the registry row id (a number); `incarnation` is pi's process string; `settled` is true only for a ctl wait that ended `settled`. | "snapshot" (that is the legacy `AgentStatusSnapshot`) |
| **settle replay** | `agent_settles`: one row per (agent, incarnation, runs) already applied, so a **CLOSE block** takes effect once per settled run. | "dedupe table" |
| **CLOSE block** | The last lines of a pi worker's final message: `CLOSE: task=<id> evidence="..."` then `REPORT:` and the text. Counts only at the very end and for the worker's own task; applied as report plus close in one op group. `mu task close` stays. | "completion marker" |
| **report / verdict** | The pinned notes of a task: **report** is the closer's account (`kind=report`), **verdict** a judge's (`kind=verdict`). With the **brief** they are never truncated in the default notes view. | "result" |
| **pinned content** | A task's brief, last report and verdicts: exempt from output caps. Ordinary notes are capped and cut with `more=N`. | "important notes" |
| **more / cut** | `more=N`: N notes left out of a view; `cut=N`: N records dropped by a size cap. Each names the exact command that fetches the rest. | "truncated" |
| **NextPlan** | The `next` of a result: `{mode, commands}`. `seq` is an ordered sequence, never truncated; `alt` is alternatives. Only state-advancing, executable-as-printed moves. | "suggestion" |
| **auto** | A task authorised for the executor (`mu task auto`: a machine-local `task_auto` row, `enabled`, with a cli key, worktree mode and run ceiling, plus this machine as `dispatch_host`; `--off` keeps the counters). Ready is not permission: `next` acts only on `auto` tasks. | "autopilot" |
| **host profile** | A machine-local template (`shell`, `exec`, `fetch`, `repo`, `max_sessions`) for one remote host, filled by mu and run with `/bin/sh -c` (`exec`, `fetch`) or as the local pane's command (`shell`); mu never connects. Selected by `spawn --host`. Not the **dispatch host**. | "remote config" |
| **host template** | One field of a host profile (`shell`, `exec`, `fetch`) with `{env}`, `{cmd}`, `{local_sock}`, `{remote_sock}`, `{cwd}` placeholders. Each value is one shell-quoted word (inside your own quotes, the value itself); `{name:sh}` adds a second-shell quoting layer; `{env}` is whitelisted `KEY='value'` words; `{{` `}}` are literal braces; anything else in braces is refused. | "ssh command" |
| **host channel** | One connection slot of a host (an attached pane, `--exec`, `--fetch` or `host check`) counted against `max_sessions`: one `host_channels` row per holder. **Transient** rides one invocation (reclaimed only when its pid is proven gone and its template's process group, recorded before it runs, is gone too); **attached** rides an agent's registry id and pane: `spawn --host` reserves it before the pane opens, binds it to the new id + pane, and `deleteAgent` frees it (reclaimed otherwise only when the pane is proven dead). A refusal is one line naming the holder. | "session" |
| **collected HEAD** | A remote worktree's HEAD as last fetched home (`worktrees.last_collected_head` ships; `agents.collected_head` is planned). A remote close needs HEAD equal to the base or this. | "synced commit" |
| **identity trio** | Three unrelated identities: **spawner** (who started an agent), **dispatch host** (which machine may dispatch a task), **revision** (`workstreamRevision`, a preview fence). Do not substitute one for another. | |
| **dashboard** | Planned: the human-only read-only four-tab view (Tasks, DAG, Agents, Log) over a workstream row, opened by bare `mu` on a TTY; keys yank commands and never run them. Replaces the removed card TUI. Its read model is `loadDashboard` (`src/dashboard-data.ts`); its `next` is "unavailable" until computed, never "no authorised work". | "home screen" |

<!-- doc-cli-drift:skip-end -->

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

Actor resolution reads `$MU_AGENT_NAME` only; pane titles are not identity.

## Agent state values

Glyphs live in `src/glyphs.ts` (`AGENT_STATE_GLYPH`).

| Value | Glyph | Meaning |
| --- | --- | --- |
| `busy` | nf-fa-play | Working |
| `needs_input` | nf-fa-moon_o | Waiting for input |
| `needs_permission` | nf-fa-lock | Waiting for a human answer |
| `unknown` | nf-fa-question_circle | No usable reading; a reason accompanies it |

The extension's `busy` maps to `busy` and `idle` to `needs_input`; an
open extension dialog (its `blocked` field) maps to `needs_permission`. Murmur
`working` maps to `busy`, `blocked` to `needs_permission`, and `idle`,
`done`, and `crashed` to `needs_input`. The `agents.status` column is
deprecated, always `spawning`, and never read.

## Reserved and avoided terms

| Avoid | Why | Use instead |
| --- | --- | --- |
| "subagent" | Means a hidden child in other tools; mu has none | "agent", "delegate", or "hidden subagent" when contrasting |
| "session" | pi, tmux, and herdr each have one | "workstream", "mux session", "tmux session" |
| "workspace" | The retired word for a worktree; in the mux sense only "herdr workspace", about herdr's CLI | "worktree"; "mux session" |
| "project" | Means a `.pi/` project root | "workstream" |
| "context" | LLM, project, and fork context | Be specific: "task context" |
| "tab" | tmux has windows (herdr calls them tabs) | "window"; `--tab` is the flag |
| "thread" | OS, chat, and git threads | Be specific |
| "message" | LLM message, log message, pane input | "log entry", "send" |
| "config" | mu has no config file | "settings", "options" |
| "manager", "instance" | Vague | The specific noun |
| "service", "broker" | Imply a daemon or middleware; mu has none | Be specific |
| "plugin" | pi has extensions | "extension" |
| "checkpoint", "snapshot" | mu has no savepoints | "group" (op group), "backup" (whole-DB copy) |
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

Columns and variables say `workstream_id`, never `session_id`.
