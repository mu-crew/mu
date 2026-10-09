# VISION: A persistent crew of agents

Terms are defined in [VOCABULARY.md](VOCABULARY.md).

## What mu is

mu is a small, durable control plane for a persistent crew of AI agents
in multiplexer panes. Agents have names and roles, outlive sessions, and
work on a built-in task graph, each in its own VCS workspace. Humans and
agents drive them through one CLI. State lives in one SQLite file. Every
feature is a typed verb over that state or a reconciled view of reality.

```bash
mu agent spawn worker-1   --tab Backend --workspace
mu agent spawn reviewer-1 --tab Review  --workspace --role read-only
mu task add --title "Build auth" --impact 80 --effort-days 3
mu task claim build_auth --for worker-1 --evidence "have implementation plan"
mu agent send worker-1 "Implement build_auth per the description"
mu state                                # canonical state card
mu log --tail                           # subscribe to every state change
```

Everything else makes those lines recover from failure and scale to
dozens of agents and hundreds of tasks.

## Why it exists

Existing tools force a choice:

- **Hidden subagents** (pi-subagents, the Claude Code and Codex task
  tools) hand one-shot work to a child you cannot see, steer, or keep
  talking to. Its transcript collapses into a result.
- **tmux orchestration tools** spawn agents in panes but leave
  coordination to chat transcripts or filesystem conventions.
- **Task trackers** (GitHub Issues, Linear) model the work but do not
  run the agents.
- **Large orchestration platforms** hold the coordination state but
  carry breadth that costs more to maintain than it returns. See
  [What a prior runtime taught us](#what-a-prior-runtime-taught-us).

mu joins the first three without becoming the fourth.

## Design principles

### 1. The CLI is the product

Everything mu does works from a shell with no pi extension loaded. A
feature that needs the extension does not ship. The pi extension
(`mu link pi`) serves the control socket and the `mu_delegate` tool, and
three rules keep it thin:

1. **The DB is canonical.** The extension reads and writes through the
   same modules as the CLI. It keeps no state of its own.
2. **Every operation works from the CLI.** No extension tool has logic
   the CLI lacks.
3. **The skill teaches the CLI.** A pi session without the extension
   still gets a working mu from [skills/mu/SKILL.md](../skills/mu/SKILL.md).

Delegation is CLI: `mu agent spawn -w scratch`, `mu agent send`, and
`mu agent wait --json`. `mu_delegate` only adds the callback that puts
the answer into the parent conversation.

### 2. One DB is canonical

All state lives in `~/.local/state/mu/mu.db` (SQLite WAL, safe for
concurrent processes). In-memory state is a cache. The extension and the
CLI share the DB, so they cannot diverge.

### 2b. One log records every change

The `ops` table is the only change record. SQLite triggers write it in
the same transaction as the mutation, so capture cannot be forgotten or
drift from the data. Sync, undo, rebuild, and history are queries or
replays over that log.

Reads still go to the tables. mu is not event-sourced: the tables are
the materialized view and triggers keep them in step with the ops.
`mu doctor` rebuilds into a temp DB and diffs, so that is verified, not
assumed. A capture bug therefore breaks sync, undo, and rebuild at once,
which is why the drift check is load-bearing.

### 2c. Local-first, transport-agnostic

Every machine keeps a complete DB. Machines exchange append-only JSONL
segments, one per machine with a single writer, so no file is contended
and any file mover works (Syncthing, rsync, scp, git, a USB stick). mu
reads and writes files. The user owns transport. mu has no network
code, no daemon, and no membership config: peers are found from the
segment files present.

### 3. Reality wins reconciliation

`mu agent list` queries the mux, prunes ghosts, and surfaces orphans.
The DB records what mu last observed.

### 4. Agents are dumb workers; the task graph is the brain

The task DAG is the center of mu, not a sidecar. Tasks require `impact`
and `effort_days`. Edges are `blocks` relations. `ready`, `blocked`, and
`goals` are SQL views. The parallel-track detector runs union-find and
merges diamonds, so two agents never collide on a shared dependency.

"What next?" and "can we parallelize?" are deterministic queries. The
LLM decides what to type to an agent. The graph decides which agent gets
which task.

### 5. One workstream per mux session

A workstream is a mux session: a tmux session on tmux, a herdr workspace
on herdr. Its agents are panes in that session, so
`tmux a -t mu-<workstream>` shows the whole crew. Workstreams on one
machine are separate sessions, partitioned in the DB by `workstream_id`.
The crew survives detach and reattach.

The multiplexer is a backend chosen by detection
(`MU_MUX` → `HERDR_ENV` → `$TMUX` → `PATH`), like the VCS backend.
Topology, the paste protocol, scrollback capture, pane-id validation,
and identity fallback live behind `MuxBackend` in `src/mux/`. There are
two implementations. A third needs its own friction evidence.

### 6. Pi-first, with reported agent state

mu never infers agent state from pane text. Each state source reports it:

| Agent | Send, abort, wait | State |
| --- | --- | --- |
| pi (any backend, local or remote over `ssh -L`) | control socket, exact | control socket |
| other CLI on herdr | mux | herdr |
| other CLI on tmux | mux (bracketed paste) | murmur |

With no source, state is `unknown` with a reason. A pi agent whose
socket does not answer fails loudly; mu never falls back to pasting.
murmur is optional for pi agents.

`MU_PI_COMMAND="pi-alt --some-flag"` swaps the pi command for every
spawn. First-class support for other CLIs is not planned. It can earn promotion
under the [ROADMAP](ROADMAP.md) criteria: spawn accepts any command and
`agents.cli` is TEXT.

### 7. TypeScript on Node

mu uses a few well-known npm dependencies (`commander`,
`better-sqlite3`, `cli-table3`, `picocolors`, `execa`, and `ink` for the
TUI). There is no native code to maintain and no build matrix.

- **Types pay.** The typed error classes map to exit codes in
  `handle()`. The `assertXInWorkstream` family stays type-safe across
  namespaces. `noUncheckedIndexedAccess` has caught real bugs.
- **`better-sqlite3` fits.** Synchronous calls match a short-lived CLI,
  and `db.transaction()` is the right shape.
- **Iteration is fast.** Several substantive changes a day land in
  about 99k lines of `src/` and `test/`.

The weak spot is cold start: Node takes 30–50 ms to boot, which matters
only in tight loops. If that changes, Rust is the port target.
`better-sqlite3` needs prebuilds (darwin-arm64/x64, linux-x64/arm64,
win32-x64) or a C++ toolchain.

### 8. Schema-first: typed verbs over read views, SQL as escape hatch

- **Read views**: the `ready`, `blocked`, and `goals` views, and
  `mu state` as the state card.
- **Typed verbs** that map to resource transitions (`task claim`,
  `task close`, `agent spawn --workspace`, `workstream teardown`).
- **`--json` on every read verb**, so scripts use `jq`, not table parsing.
- **`mu sql`** underneath, as the explicit escape hatch.

There is no DSL, no plugin system, no workflow engine, and no verb
registry. The commander wiring in `src/cli.ts` is the verb surface. A new
verb is one SDK function plus one commander block.

### 9. Observed vs claimed

A mutating verb records what the caller said it relied on.
`mu task close design --evidence "npm test exit 0"` lands in the ops log
with the evidence. mu does not run the tests, but `mu log` can search
the grounding for every change.

### 10. Get out of the model's way

mu coordinates agents and does not reason about them. It does not own:

- **Model selection or thinking levels.** No tiers, no provider matrix.
  pi already takes `--model` and `--thinking`. Pass them through the
  spawn command.
- **Prompts.** No system-prompt templates and no role registry. The
  prompt is the spawn command plus the first message.
- **Tool routing.** The agent CLI owns tool allowlists, MCP servers, and
  extensions.
- **Output interpretation.** mu does not parse panes for state, facts,
  or tool calls. `--evidence` is recorded as given.

The whole vendor surface is one lookup: `--cli <key>` reads
`$MU_<KEY>_COMMAND`. Per-role models are a convention in your shell rc:

```bash
export MU_PI_MINI_COMMAND="pi --model haiku:off"   # → --cli pi_mini
export MU_PI_BIG_COMMAND="pi --model opus:high"    # → --cli pi_big

mu agent spawn worker-1   --cli pi_mini
mu agent spawn reviewer-1 --cli pi_big
```

The skill's [model tiers](../skills/mu/recipes/models.md) are advice to
the agent choosing; mu reads none of it.

## What it enables

- **Visible crews.** Spawn agents once and send them work all day. Each
  sits in a pane you can attach to.
- **Isolation.** Each agent gets a jj workspace, sl clone, git worktree,
  or `cp -a` copy, detected automatically and freed by `mu agent close`.
- **Wakeups without a daemon.** `mu log --tail` and event-driven
  `mu agent wait` replace polling.
- **Crash recovery.** The reaper reopens a dead agent's IN_PROGRESS
  tasks with a note.

## What it is not

- **Not an orchestrator.** mu provides primitives. The policy (when to
  spawn, what to assign, when to free) is yours: bash, `jq` over
  `--json`, or an LLM following the bundled skill. There is no workflow
  engine and no `mu run script.ts`. <!-- doc-cli-drift:skip -->
- **Not a chat protocol.** Agents communicate through notes, claims, and
  the ops log.
- **Not a hidden-subagent runner.** A delegate is an ordinary agent in a
  visible pane: attach, steer, abort, or keep talking to it. It costs one
  pane and one pi process. A hidden subagent is lighter for many tiny
  calls. mu bets that visibility and steering are worth the cost. There
  are no agent types: the brief is plain text. A delegate's answer is
  not recorded in mu; only what the caller writes back (a note, a state
  change) is. The one extension-held list with no pane is the delegate
  queue: bounded, shown in pi's footer, cancellable, and named at
  shutdown when it is dropped.
- **DB-undoable, not substrate-undoable.** `mu undo <group> --yes`
  restores rows. It does not revive killed panes or freed workspace
  directories. Reconciliation then reports ghosts and orphans.

## Key constraints

1. **A multiplexer is required** (tmux or herdr). `mu doctor` reports
   the backend. Agent verbs exit 5 when none is reachable.
2. **The agent never acknowledges a send.** For pi, the control socket
   confirms that pi accepted the message. On the mux path, mu confirms
   only that the text reached the pane and warns when it cannot confirm
   submission. Use `mu agent wait` or `mu log --tail` to see the effect.
3. **Recursion is opt-in.** `mu_delegate` is hidden in agents mu spawned
   (`MU_MANAGED_AGENT`). Agents have `mu` on PATH, but the skill tells
   them they are not the orchestrator.
4. **Every invocation is short-lived, except two interactive readers.**
   No daemon, no resident state outside SQLite, no background process.
   The exceptions are `mu log --tail` and the TUI (`mu state --tui`, or
   bare `mu` on a TTY). Both are:
   - owned by a human or parent script and gone when it ends;
   - free of user actions: TUI keys copy the `mu <verb>` command to
     the clipboard and exit, so every change the operator asks for is a
     fresh CLI call. The TUI's slow tick still does the housekeeping
     any `mu` invocation does: ambient sync (ingest peer ops, flush the
     local segment) and reconcile (prune agents whose pane died, which
     reopens their tasks with a `[reaper]` note, and refresh pane
     titles);
   - limited to stdin, stdout, and a poll timer: no sockets or watches.
     The TUI's slow tick runs short-lived probes (mux liveness, VCS
     status) and ambient sync, and its handoffs (lazygit, tuicr, attach,
     clipboard) run one foreground child each; none outlives the TUI;
   - TTY-gated: pipes, CI, `--json`, and `MU_NO_TUI=1` never enter the
     TUI, and plain `mu state` prints the static card.

   The control socket is not a third exception. The pi process serves it
   and it dies with that process. Any other long-lived process needs its
   own promotion; the [anti-feature pledges](ROADMAP.md#anti-feature-pledges)
   stand.

## What a prior runtime taught us

A council review of mu's design ancestor, a larger internal multi-agent
runtime, found it justified only as a durable coordination control
plane. Its minimal core: sessions, an agent registry, a task graph,
workspace ownership, an event log, wakeups, human approvals, a typed
control API, read-only state cards, and orphan recovery. Everything else
(chat, workflow DSLs, memory, dashboards) had to prove its worth.

mu ships nine of the ten. Approvals are missing because 200+ dogfooded
tasks never needed them. Below the point where coordination is itself
the work, pi plus manual tmux is more transparent than mu.

Known gaps, none promoted yet: `--evidence` grounds but does not verify,
mutations have no declared idempotency keys, most mutations have no dry
run (`workstream teardown`, `task delete`, and `undo` do), and the `role`
field is stored but not enforced.
