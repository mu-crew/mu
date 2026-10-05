# CLI and SDK surface

Every user-visible operation is a typed SDK function plus a thin
Commander wrapper. This page covers the boundary rules, errors, tests
and packaging. Overview: [ARCHITECTURE.md](../ARCHITECTURE.md).

## One surface, two callers

`src/cli.ts` (`buildProgram`) and the namespace files under `src/cli/`
are the verb surface: no generated registry, no DSL, no separate
operation schema. Programmatic callers import the same functions from
`src/index.ts`. Agents and scripts compose verbs with `--json`.

A verb's path:

1. The Commander block calls a `cmd<Verb>` wrapped in `handle()`.
2. `handle()` opens the DB, runs ambient sync ingest
   ([sync.md](sync.md#the-ambient-hook)), and calls the SDK function.
3. The SDK function opens `db.transaction(fn)()` for multi-statement
   writes. Agent ops call the mux (and jj, sl or git for workspaces);
   task ops are pure SQL. Read paths reconcile against the mux.
4. Capture triggers record ops in the same transaction
   ([ops-log.md](ops-log.md)). Machine-local changes go through
   `emitEvent`. `mu log --tail` sees them on its next 1-second poll.
5. On error the transaction rolls back and the typed error reaches
   `handle()`, which maps it to an exit code. Flush runs on both paths.

Output is self-documenting: `src/output.ts` (`printNextSteps`,
`errorNextSteps`) prints `Next:` hints, quoted by `src/shell-quote.ts`
so they paste cleanly.

## Surrogate-PK and SDK-boundary discipline

Every entity table has this shape:

```
(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate; internal
  <scope_id>    INTEGER NOT NULL REFERENCES <parent>(id) ON DELETE CASCADE,
  <name>        TEXT NOT NULL,                        -- operator-facing; mutable
  -- ... domain attributes
  UNIQUE (<scope_id>, <name>)                         -- per-scope unique
)
```

FKs reference `<parent>_id` (INTEGER), never the TEXT name. The name is
an attribute: searchable, displayable, cheap to rename. The surrogate
id is the identity.

**TEXT by design:**

- the workstream's own `name` (it is the mux session name; globally
  unique);
- `task_notes.author` and `ops.actor` (free-text labels such as
  `"orchestrator"`);
- `ops.entity` (open enum; a new entity needs no migration);
- `agents.cli` (a new CLI needs no schema change);
- every column of `ops`. The log is FK-free and addresses rows by
  natural key, so an op outlives its row and its workstream.

**The boundary rule** matches REST: the external API uses business
identifiers, the internal layer uses primary keys.

> **Public SDK functions take operator-facing names.**
> **Internal helpers take surrogate ids.**
> **Resolution happens at the public-function entry, exactly once.**

```ts
// PUBLIC: takes operator-facing names
export function claimTask(
  db: Db,
  workstream: string,
  localId: string,
  opts?: ClaimOptions,
): ClaimResult {
  const wsId = resolveWorkstreamId(db, workstream);
  const taskId = tryResolveTaskId(db, wsId, localId);
  if (taskId === null) throw new TaskNotFoundError(localId);
  const agentId = resolveCurrentAgentId(db, wsId);
  return claimTaskById(db, taskId, agentId, opts);
}

// INTERNAL: takes surrogate ids; never re-resolves
function claimTaskById(db, taskId, agentId, opts): ClaimResult { ... }
```

Resolving once gives three things: no double resolution; no
workstream context needed below the boundary, because the FKs make
scope implicit; and one place for error mapping.
`WorkstreamNotFoundError` comes from `resolveWorkstreamId` in
`src/db.ts`. `TaskNotFoundError` and `AgentNotFoundError` are raised by
callers wrapping a `tryResolve*` null, so exit 3 holds whichever lookup
missed.

**Workstream scoping is mandatory at the CLI boundary.** TEXT names
(`tasks.local_id`, `agents.name`) are unique per workstream, so the
same name can exist in two. Every public function taking such a name
also takes the workstream; internal SQL filters by
`(workstream_id, name)`.

**`--json` keeps operator-facing names.** Surrogate ids never appear in
`--json`, error payloads, log lines or exports. Exposing them would
bring back a global namespace.

## State of truth

- The DB (`~/.local/state/mu/mu.db`, or `MU_DB_PATH`) is canonical.
  Everything else is a cache, including pane titles.
- Writes go through the typed SDK functions, which validate, transact
  and reconcile. Op capture is the triggers' job.
- In-memory state lives only for one command's connection.
- Multiple `mu` processes share the file safely through SQLite WAL.

## Errors

Errors are typed classes per layer (`src/agents/errors.ts`,
`src/tasks/errors.ts`, `MuxError` with `TmuxError` / `HerdrError`, and
so on). Nothing swallows them. `src/cli/handle.ts` maps them to exit
codes:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | generic error |
| 2 | usage error (Commander's default) |
| 3 | not found (agent, task, workspace) |
| 4 | conflict (name collision, double claim, dirty tree, schema too old or new, outdated extension) |
| 5 | substrate unavailable or unsafe (no multiplexer, mux or VCS failure, DB locked, ops-log drift, a `mu doctor` FAIL row, timeout) |
| 6 | `mu task wait`: the reaper reopened a watched task (its pane died) |
| 7 | `mu task wait`: a watched task stalled (`--on-stall exit`) |

Errors carry structured context (operation, target, attempted action)
so `mu doctor` can show them readably.

## Testing layers

Fast tier (`npm run test:fast`) excludes `*.integration.test.ts` and
`*.smoke.test.ts`. It uses real SQLite in per-test temp DBs and a
mocked mux (`installMux()` from `test/_mux.ts`). Integration tests use
real tmux or herdr, and real git, jj or sl in `os.tmpdir()`; jj and sl
tests skip when the binary is missing. Conventions live in
[AGENTS.md](../../AGENTS.md) and `test/README.md`.

| Area | What the tests pin |
| --- | --- |
| `src/capture.ts`, `src/op-context.ts` | payloads hold only changed columns (asserted by key count); echo suppression; cascade grouping; FK-CASCADE tombstone keys; the null-intent fail-safe |
| `src/apply.ts` | injected HLCs, no sleeps: field convergence in both orders; same-field LWW determinism; all four put and del orderings; resurrection; grow-only notes; the set-to-NULL trap; `owner_id` stripping; replay idempotence |
| `src/rebuild.ts` | round trip row by row per portable table (a count-only check passes on a garbage rebuild); tombstones; byte-identical ops; `machine_id` and clock carried |
| `src/drift.ts`, `src/fleet-hazards.ts` | drift planted the way a capture bug would (`withCaptureSuppressed` plus a direct write), with equal weight on false positives |
| `src/dormant.ts` | `updated_at` written directly; weighted to the boundary between `finished` and `abandoned` |
| `src/disk-recon.ts` | a per-test `MU_STATE_DIR` with the on-disk shape built by hand, both directions |
| `src/segments.ts`, `src/sync.ts` | two temp DBs and one shared dir; each robustness layer; machine-local ops never reaching a file |
| `src/hlc.ts` | an injected clock: backward jumps, stalled milliseconds, concurrent minting |
| `sync-session.integration` | 8 rounds of two machines: byte-identical portable content, no `--deep` drift, a quiet round adds zero ops |
| `test/acceptance.integration.test.ts` | the end-to-end gate: 10 tasks, 3 agents |

`npm run test:stress` repeats the suite with per-run timeouts,
optionally in parallel (`MU_TEST_STRESS_MODE=parallel`).

Two fixture traps:

- A convergence fixture must share one creation op. Two independent
  `task add` calls for the same id make the later creation win every
  field.
- An ordering-sensitive sync test must rename segments to pin ingest
  order, since peers are discovered by `localeCompare` over random-UUID
  filenames.

Treat a test that passes alone and fails under load as a concurrency
bug first. Drive wait and reaper tests from poll-loop seams, not fixed
timers, and wait for stable Ink output instead of sleeping.

## Distribution

One npm package, `mu`. `tsup` bundles three entries:

| Output | Role |
| --- | --- |
| `dist/cli.js` | `bin: { mu: ./dist/cli.js }` |
| `dist/index.js`, `dist/index.d.ts` | SDK and types |
| `dist/extension/mu-pi.js` | the pi extension `mu link pi` points at |

`skills/` and `docs/` ship alongside. There is no build step on the user's
machine. pi stays a peer dependency: the extension types pi's API
structurally. Per-role agent guidance lives in the user's repo, not in
mu. The rule for adding a dependency is in
[ROADMAP § Anti-feature pledges](../ROADMAP.md#anti-feature-pledges).
