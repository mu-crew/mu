# Roadmap

If a feature is not here, it is not planned. Shipped work is in
[CHANGELOG.md](../CHANGELOG.md). Pillars are in [VISION.md](VISION.md).

## Promotion criteria

A roadmap item is built when all three hold:

1. **Proven friction.** A real user hit the gap in a real workflow at
   least twice.
2. **No pillar refactor.** It fits without bending a
   [VISION](VISION.md) pillar.
3. **Bounded scope.** It fits in <300 LOC, or a smaller subset does.

Data-loss footguns ship on the first occurrence. Polish (bug fixes,
ergonomics, error wording, docs) needs no promotion: ship it through the
green gate.

## Anti-feature pledges

mu does not add these unless one earns its way back under the criteria:

- **A config file.** Config is CLI flags and env vars.
- **A daemon, watcher, or background process** beyond tmux and SQLite.
- **Abstractions with no current consumer** (the cautionary tale: a
  `RunContext` trait with no implementor).
- **Wrappers around wrappers** (`TextStream`/`TextState`/`StreamResult`).
- **Codegen, an embedded JS engine, macros, or decorators.** No workflow
  DSL.
- **Templates or definitions for agent roles.** Spawn flags and the first
  message are the definition.
- **Render layers beyond `cli-table3` + `picocolors`**, except `ink` in
  `src/cli/tui/`. If `ink` stops paying off, replace it. Never run two
  TUI stacks.
- **Bundling pi.** It is a peer dependency.
- **A plugin runtime, web UI, RPC, chat or docs integrations, a memory
  system, or a workflow engine.** A prior internal runtime collected all
  of these. Not inheriting them is the point.

## Rejected sync substrates

mu syncs through the SQLite ops log plus append-only JSONL segments.
These alternatives were rejected:

| Substrate | Why not |
| --------- | ------- |
| **Litestream** | Daemon, single writer, one-way to object storage, and `restore` overwrites the whole file. It does disaster recovery, not laptop↔devserver merges. |
| **LiteFS** | FUSE, which on macOS means a macFUSE kernel extension. |
| **rqlite / dqlite / Marmot** | A consensus cluster and daemons to sync two machines that are rarely both awake. |
| **cr-sqlite** | Merges rows by primary key. mu's `INTEGER PRIMARY KEY AUTOINCREMENT` ids collide across machines and merge silently. Also WIP upstream, no DDL sync, and a native build matrix. |
| **RocksDB / LMDB for the op log** | No triggers, so a forgotten capture silently corrupts undo and sync. Single-process access forces a daemon. Loses SQL views, JOINs, and `mu sql`. |
| **SQLite file per peer** | A torn transfer makes the whole file unreadable instead of one JSONL line. `-wal`/`-shm` sidecars in a synced folder corrupt DBs. Page churn defeats delta transfer. |
| **`MU_SYNC_PEERS` list** | A config file that must match on every machine. Peers come from segment filenames instead. |
| **`mu sync --push/--pull <host>` <!-- doc-cli-drift:skip -->** | mu's first ssh egress, with ssh config, auth, and error mapping. mu prints an rsync line instead. |

The chosen design adds no dependency beyond `better-sqlite3`.

## Possible: small additions with an obvious shape

These have a design but no proven friction yet.

- **A third mux backend** (zellij, wezterm, kitty). tmux and herdr are
  the two implementations that justify `MuxBackend`. A third needs its
  own friction evidence. The existing interface is not evidence.
- **Subscription-based wakeups.** `mu log --tail` polls once a second.
  SQLite update hooks or `fs.watch` on the WAL would cut latency for
  more machinery. Build it when someone hits the limit.

- **`mu agent list --json` as `{items, count}`.** It emits
  `{workstreamName, agents, orphans}`, the one collection off the
  documented shape (SKILL.md notes the exception). Conforming breaks
  `.agents` readers, `mu_delegate` among them; do it with the next
  breaking release. Reported in
  docs/bugs/2026-10-08-review-panel-friction.md (#3).

## Open questions

- **Capability tags on operations.** Today the only authorization is
  "the agent ran the verb". Enforce capabilities when an agent does real
  damage.
- **Per-workstream config.** Resisted by the pledges, but "this
  workstream uses a different pi binary" is a gap env vars solve poorly.
  Revisit when a second user hits it.

## Next schema change

Drop the deprecated `agents.status` column in schema v12. In v11 it
stays for compatibility and always holds `spawning`.

## Explicitly rejected

- **A JS or Lisp DSL** (`mu run`, `mu eval`, `mu repl`) <!-- doc-cli-drift:skip -->. bash, `jq`,
  and `--json` cover it.
- **A `defineOperation()` registry.** No consumer after the DSL went.
- **Markdown agent-definition discovery.** Spawn flags and the first
  message are the definition.
- **mu as only a pi extension or only a library.** Children and humans
  could not drive it from a shell, and processes would fight over the DB.
- **Two binaries (`mu-agents` + `mu-tasks`).** Agents and tasks need one
  transactional surface.
- **A `TaskSurface` adapter.** The built-in graph is the point.
- **Live sync through a daemon or remote backend.** Sync rides on
  ordinary mu calls and mu only reads and writes files. See
  [Rejected sync substrates](#rejected-sync-substrates).
- **Network-opening verbs (`mu remote check`, `mu sync --push/--pull`)** <!-- doc-cli-drift:skip -->.
  Every network hop is an operator command. Spawn passes it through
  `--command` for the mux to run, or mu prints it as a next step. mu's
  own process stays ssh-free.
- **An HTTP API over SQLite** or **a hosted mu.**
- **Personal agent names (`alice`, `bob`).** Use role names
  (`worker-1`, `reviewer-1`).
- **Pane scraping as a state fallback.** No state source means `unknown`.
- **Runtime agent state in `mu.db`.** The copy goes stale. The control
  socket, herdr, or murmur owns the current reading.
- **Reading murmur's `state.db`.** Use its public contract.
- **murmur as a hard dependency.** pi agents and the task graph do not
  need it.
