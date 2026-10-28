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

## Shipped in 4.0

The 4.0 rewrite was approved as a whole and was exempt from the
promotion criteria. Its units have merged: the contract as built is
[surface-contract.md](reference/surface-contract.md), and what changed is
in the [CHANGELOG](../CHANGELOG.md). Nothing beyond them is approved;
anything else follows the criteria above.

## Candidates

Each has a design but no proven friction yet. Most come from the prior
runtime, which hit the gap and fixed it its own way. Parked tasks may
track them; delete the row when one ships.

| Item | Gap today | Shape | Size |
| --- | --- | --- | --- |
| **Tag mux sessions with their DB** | `teardown --empty` never removes a `mu-*` session that has no DB row, because another DB may own it. | Set `@mu_db=<abs path>` at session creation. Remove unregistered sessions whose tag matches this DB, and keep foreign or untagged ones. Optional mux method, since herdr may have no equivalent. | ~60 LOC |
| **Token usage per run** | Orchestrators cannot budget a fan-out. | The extension reports pi's usage for the run, and `wait --json` carries it. Unknown stays unknown, never 0. No dollar estimates. | ~80 LOC |
| **Global delegate cap** | `MU_DELEGATE_MAX` applies per pi session. Several orchestrators, plus workers running `mu agent spawn -w scratch`, are not capped in total. | Count live `scratch` agents from the DB in the queue check. | ~30 LOC |
| **Delegate retention** | Every `mu_delegate` call and `mu next --refute` checker is a `kind=delegate` task in `scratch`, with its whole brief and report, kept forever and synced to every peer. Housekeeping, `teardown --empty` and `db forget` all skip `scratch`; the only cleanup is forgetting all of `scratch`, kept helpers included. | A `prune` subcommand of `delegates` taking an age (dry run by default; applying writes a backup first, like `db forget`): hard-delete CLOSED delegate tasks past the age, with their notes, call rows and ops. Verdict notes live on the judged task and stay; tallies of pruned waves go. | ~150 LOC |
| **Absolute deadline in `wait`** | A delegate re-armed after `/reload` restarts its countdown. | Report `deadline` (epoch ms) alongside `timeoutS`. | ~20 LOC |
| **Design-doc review angles** | [adversarial-review](../skills/mu/recipes/adversarial-review.md) reviews diffs, not design docs. | Add rollout and back-compat, alternatives, and integration angles. Synthesize into unanimous findings, tensions, and the strongest objection. | recipe |
| **Sender framing on sends** | The receiving agent cannot tell a peer's message from its human's. | Prefix text sent by a mu agent with `[mu: from <agent>]`. This touches prompts, so it follows logging the sender. | ~20 LOC |
| **A third mux backend** | None: tmux and herdr are the two implementations that justify `MuxBackend`. | zellij, wezterm or kitty. A third needs its own friction evidence; the existing interface is not evidence. | — |
| **CLI surface nits** (`rr_r4_p3_batch`) | `mu task --json` (bare namespace) is an unknown option while bare `mu task` prints help. `cli.ts`/`output.ts` export a few helpers used only in-file and by tests (`resolveSelfOptional`, `assertEntityInWorkstream`, `colorEnabled`, `isSqlVerbArgv`, `isWaitVerbArgv`). About 70 error literals are still built inline instead of in `messages.ts` (`delegates.ts`, `hosts.ts`, `wait-registration.ts`). | Accept `--json` on a bare namespace or leave it. Unexport when next touched. Migrate a file when its wording is next hill-climbed. | ~30 LOC |
| **Subscription-based wakeups** | `mu log --tail` polls once a second. | SQLite update hooks or `fs.watch` on the WAL. Lower latency for more machinery. | — |

## Next breaking release

- **Drop `agents.status`.** Schema 13 still carries it for
  compatibility; it always holds `spawning` and nothing reads it.
- **`mu agent list --json` becomes `{items, count}`.** It emits
  `{workstreamName, agents, orphans}`, the one collection off the
  documented shape. Conforming breaks `.agents` readers, `mu_delegate` among them.

## Open questions

- **Capability tags on operations.** Today the only authorization is
  "the agent ran the verb". Enforce capabilities when an agent does real
  damage.
- **Per-workstream config.** Resisted by the pledges, but "this
  workstream uses a different pi binary" is a gap env vars solve poorly.
  Revisit when a second user hits it.

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

### Rejected sync substrates

mu syncs through the SQLite ops log plus append-only JSONL segments.
These alternatives were rejected:

| Substrate | Why not |
| --------- | ------- |
| **Litestream** | Daemon, single writer, one-way to object storage, and `restore` overwrites the whole file. It does disaster recovery, not laptop↔devserver merges. |
| **LiteFS** | FUSE, which on macOS means a macFUSE kernel extension. |
| **rqlite / dqlite / Marmot** | A consensus cluster and daemons to sync two machines that are rarely both awake. |
| **cr-sqlite** | Merges rows by primary key. mu's `INTEGER PRIMARY KEY AUTOINCREMENT` ids collide across machines and merge silently. Also WIP upstream, no DDL sync, and a native build matrix. |
| **RocksDB / LMDB for the op log** | No triggers, so a forgotten capture silently corrupts sync. Single-process access forces a daemon. Loses SQL views, JOINs, and `mu sql`. |
| **SQLite file per peer** | A torn transfer makes the whole file unreadable instead of one JSONL line. `-wal`/`-shm` sidecars in a synced folder corrupt DBs. Page churn defeats delta transfer. |
| **`MU_SYNC_PEERS` list** | A config file that must match on every machine. Peers come from segment filenames instead. |
| **`mu sync --push/--pull <host>` <!-- doc-cli-drift:skip -->** | mu's first ssh egress, with ssh config, auth, and error mapping. mu prints an rsync line instead. |

The chosen design adds no dependency beyond `better-sqlite3`.
