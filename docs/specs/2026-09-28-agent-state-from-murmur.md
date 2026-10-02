# Agent state from murmur (mu 2.0.0, murmur 1.0.0)

Status: shipped in 2.0.0; partly superseded in 3.2.0 by the control socket ([architecture/control-socket.md](../architecture/control-socket.md)). Approved 2026-09-28. Task `crew/mu_status_from_murmur`.

## Problem

mu works out what an agent is doing by reading the last 20 lines of its
pane (`src/detect.ts`), and stores the answer in `agents.status`. This fails
in three ways:

- **Remote workers.** The local pane holds an ssh client that renders a
  nested tmux. `skills/mu/REMOTE_WORKERS.md` records wrong answers in both
  directions in one session: a stall fired at 300 s on a worker that was
  mid-turn, and `mu agent list` showed `needs_input` for a worker that was
  working.
- **Wrappers.** Each pi wrapper with different chrome has needed its own
  patch (the Braille-spinner fallback).
- **Stale copies.** The stored status is only as recent as the last
  reconcile, and `mu agent show` needed a fix to re-detect before it printed.

murmur's pi extension reports state from inside the agent on its own host,
and it publishes the state on each pane (`@murmur_pane_state`) and across
machines (`murmur status --json`). mu already exports the variables that
murmur uses to recognise mu's workers (`MU_MANAGED_AGENT`, `MU_AGENT_NAME`,
`MU_WORKSTREAM`).

## Decision

**murmur is the answer for agent state.** mu owns the work: the DAG, task
owners, workspaces and panes. murmur owns what an agent is doing. mu does
not read pane text to decide agent state, and it does not store agent state.

Sources of runtime state, in order:

1. herdr's `paneStatus()` on the herdr backend. This is herdr's own report,
   not scraping.
2. On tmux, murmur. The local read is the pane's `@murmur_pane_state` and
   `@murmur_pane_since`. The remote read is `murmur status --json`, matched
   on `agent_name` and `workstream`.
3. Otherwise `unknown`, and mu says why.

This follows ZEN rules 2 (report state, don't scrape it), 3 (absence means
absence) and 5 (standalone tools that compose). mu's core needs none of this
to work: the DAG, `claim`/`close`, `task wait`, workspaces, spawn, send and
read.

## Scope

In:

- A state resolver module that replaces every state read from
  `detectPiStatus`:
  - reconcile, including `mu agent list` and `mu state`
  - `mu agent show`
  - `mu agent wait`
  - stall detection in `mu task wait`
  - spawn readiness
  - `computeAgentIdle`
  - the TUI cards and popups
- Stop writing `agents.status` after the initial insert, and stop reading it
  everywhere.
- A new `--json` shape for agents: `state` and `source`, with no `status`.
- `mu doctor` checks for murmur and its pi extension.
- Updates to the README, the skill, `REMOTE_WORKERS.md`, ARCHITECTURE,
  DECISIONS and ROADMAP.
- murmur 1.0.0: a contract section in its ARCHITECTURE, and the release.

Out:

- The two input-timing checks in `send`. `awaitPaneQuiescence` waits out
  pi's re-init modal, which eats the Enter. `isTextStranded` detects a
  prompt that was typed but never submitted. Both are about typing into a
  terminal, not about agent state, and murmur cannot see either. They keep a
  private helper for spinner and work-marker text. It is used only by
  `send`, returns no status, and is not exported.
- `detectSpawnStartupError` in `src/agents/spawn.ts`. It scans a new pane
  for provider and auth errors (a dud spawn), which is a spawn failure, not
  agent state. It stays for the same reason as the `send` checks.
- Dropping the `agents.status` column. mu has no migration path: v10 is both
  the minimum and the current schema. The drop waits for the first change
  that needs a v11 anyway, and ROADMAP records it.
- Reading murmur's SQLite files. Reading them would couple mu to murmur's
  private schema.
- Any feature added to murmur for mu. murmur only documents what it already
  publishes.

## Design

### Caller's view

```ts
const states = await readAgentStates(db, agents);        // one tmux read, ≤1 murmur call
const s = states.get(agent);  // { state: "busy", source: "murmur", since: 1790581553851 }
if (s.state === "unknown") hint(s.reason);               // "murmur not installed" | ...
```

`mu agent list --json`:

```json
{ "name": "worker-1", "pane": "%4", "state": "busy", "source": "murmur",
  "since": "2026-09-28T07:45:53Z" }
{ "name": "worker-9", "pane": "%9", "state": "unknown", "source": "none",
  "reason": "murmur not installed" }
```

### State resolver (`src/agent-state.ts`, new)

```ts
type RuntimeState = "busy" | "needs_input" | "needs_permission" | "unknown";
type StateSource = "murmur" | "herdr" | "none";
interface StateReading {
  state: RuntimeState;
  source: StateSource;
  since: number | null;  // ms; when the state last changed, from the source
  reason?: string;       // set when state is unknown
}
function readAgentStates(db: Db, agents: AgentRow[]): Promise<Map<AgentRow, StateReading>>;
```

- It takes a batch of agents, so a whole display costs one read.
- **herdr backend:** calls `paneStatus()` per pane, as today.
- **tmux, local:**
  - One `list-panes -a -F '#{pane_id}\t#{@murmur_pane_state}\t#{@murmur_pane_since}'`
    call.
  - A pane with a value is read from murmur. A pane with no value is a
    candidate for the remote read.
  - murmur publishes `@murmur_pane_state` only for a pane its extension has
    claimed (fixed in murmur `3c8c1a7`).
- **tmux, remote:** the agents with no local value.
  - One `murmur status --json` call, cached per mu process for
    `MURMUR_CACHE_MS` (10 s), so the 1 s poll in `mu agent wait` does not
    start Node every tick. murmur limits its own ssh collect to one per
    30 s ± 10 s.
  - A row matches when `agent_name` and `workstream` are equal and `local`
    is false.
  - Zero matches gives `unknown`, with reason "murmur has no row". More
    than one match gives `unknown`, with reason "ambiguous: N hosts". A
    peer that murmur reports as stale gives `unknown`, with reason "remote
    snapshot stale".
- **`since`:**
  - For a local pane, it is `@murmur_pane_since`: the time the pane entered
    its current state (see murmur 1.0.0 below).
  - For a remote row, it is the row's `updated_at`. That is an
    approximation, because it also moves on runtime updates. It is used
    only for remote idle and stall timing, where scraping had no answer at
    all.
  - Only the remote path starts `murmur`. A machine with no remote workers
    never runs it.
- **When murmur is missing:** no `murmur` on PATH, or the pi extension not
  linked (`~/.pi/agent/extensions/murmur.ts` missing).
  - Every tmux agent gets `unknown`, with reason "murmur not installed" or
    "murmur pi extension not linked".
  - The resolver checks this once per process.

### Mapping

| murmur | mu |
| --- | --- |
| `working` | `busy` |
| `idle` | `needs_input` |
| `done` | `needs_input` |
| `blocked` | `needs_permission` |
| `crashed` | `needs_input` |

- `done` and `idle` both mean "waiting for a prompt".
- `blocked` means waiting on a human answer, which is what a permission
  dialog means.
- For `crashed`, pi is gone but the pane may still be alive. The mapping
  makes waits and stall detection fire. Pane death stays with the reaper.

herdr's mapping does not change: `working` gives `busy`; `blocked` gives
`needs_permission`; `idle`, `done` and `unknown` give `needs_input`.

### Consumers

- **reconcile.** It keeps pruning dead panes and refreshing titles. It
  stops detecting and writing status. `report-only` mode stays read-only.
- **`mu agent list`, `mu state`, `mu agent show`, TUI.** These show
  `state` from the resolver. An `unknown` state shows `?` and a one-line
  hint, printed once per invocation: "agent state needs murmur (see mu
  doctor)".
- **`mu agent wait`.** It fires on busy → not busy, as today. `unknown`
  never fires. If every watched agent is `unknown` at the first tick, it
  prints the reason once and keeps waiting until `--timeout`.
- **`mu task wait` stall detection.** The stall timer measures time in
  `needs_input` using `since`. `unknown` never counts as a stall. The rest
  of `task wait` is unchanged: it polls the DB, which is exact.
- **Spawn readiness.**
  - With murmur present, spawn waits until the pane's `@murmur_pane_state`
    is set, within the existing budget. murmur publishes it right after the
    extension claims the pane.
  - Without murmur, spawn skips the wait and keeps the "pane died on spawn"
    check. The first `send` waits for pi through its input-timing checks.
- **`computeAgentIdle`.** An agent is idle when it is `needs_input` and
  `since` is older than the threshold, taken from the resolver. It was
  `agents.updated_at`.
- **`mu doctor`.** It reports murmur on PATH, the version (≥ 1.0.0), the pi
  extension linked, and whether the identity exists. A failure is a
  warning, not an error.

### `agents.status` in 2.0

- It is deprecated in place.
- Inserts write the fixed value `'spawning'` to satisfy `NOT NULL` and the
  CHECK. Nothing updates it and nothing reads it.
- Mid-spawn is already marked by the `pending:` pane-id placeholder.
- `free` (from `adopt`) and the "sticky until activity" overwrite rule
  disappear, because nothing overwrites anything.
- `db.ts` marks the column deprecated.
- The SDK drops `AgentStatus`, `shouldOverwriteAgentStatus`,
  `updateAgentStatus` and the `detectPiStatus` export. It exports
  `RuntimeState`, `StateReading` and `readAgentStates`.

### murmur 1.0.0

1.0.0 means the interfaces mu reads are stable. A breaking change to them
needs a major version.

- **New: `@murmur_pane_since`.** This is the time (ms since the epoch)
  the pane entered its current `@murmur_pane_state`.
  - It is set in the same tmux command as the state, and only when the
    state changes: `if -F '#{!=:#{@murmur_pane_state},<new>}' 'set -p
    @murmur_pane_since <now>' ; set -p @murmur_pane_state <new>`.
  - The compare-and-set runs inside tmux, so every writer (the extension,
    the collector, `clear`) agrees, and a repeated write of the same state
    leaves the value alone. This was checked on a scratch server:
    `working → working → idle` kept the first time and then moved.
  - It is unset together with the state. It needs no store schema change.
- **The contract**, listed in the "Contract" section of its ARCHITECTURE:
  - `@murmur_pane_state` and its five values, and `@murmur_pane_since`
  - the `status --json` fields `panes[].{pane, local, agent_name,
    workstream, driver, activity, attention, freshness, updated_at}`
  - the `MU_*` variables murmur reads
- **Release:** it ships main (the idle-label fix) plus
  `@murmur_pane_since`, with a CHANGELOG entry that says what 1.0 means.
  There is no 0.6.2.
- **Order:** murmur 1.0.0 first, then mu 2.0.0.

## Cost

Measured on the dev machine with 5 local agents:

| Read | Before (scrape) | After |
| --- | --- | --- |
| local state, 5 agents | 5 × `capture-pane`, 13 ms | 1 × `list-panes`, 2 ms |
| `agent wait`, per 1 s tick | 5 captures, plus detection in JS | 1 × `list-panes` |
| local idle and stall timing | a DB timestamp that only moved on reconcile | `@murmur_pane_since`, read in the same call |
| remote agents | captures that gave wrong answers | `murmur status --json`, 90 ms, cached for 10 s |

`mu agent list` and `mu state` take about 0.8 s, and most of that is mu's
startup (`mu --version` takes 0.30 s). This change removes work from both
commands. No local path starts a second Node process.

## Testing

- **Unit tests** for the resolver, using a fake tmux and a fake `murmur`
  runner:
  - the local value
  - a remote match
  - no match, an ambiguous match and a stale peer
  - murmur missing and the extension not linked
  - the herdr path
  - cache reuse within `MURMUR_CACHE_MS`
  - no `murmur` process started when every agent has a local option
- **Consumer tests:**
  - `agent wait` never fires on `unknown`
  - stall detection uses `since` and ignores `unknown`
  - spawn readiness with murmur and without it
  - `computeAgentIdle`
- **Removal checks:**
  - No state path imports the send helper. A grep test in the style of
    murmur's cheap-tick check enforces this.
  - `src/detect.ts` exports no status.
- **Integration:**
  - With real tmux and a fake `@murmur_pane_state` set with `tmux set -p`:
    `mu agent list --json` shows `source: murmur`.
  - Without the option, it shows `unknown` with its reason.
- **Live check** on this machine: spawn a worker, send it work, and check
  `mu agent list` for busy and then needs_input, plus `mu agent wait` and
  `mu task wait --on-stall exit`.
- **Gates:**
  - mu: `npm run typecheck && npm run lint && npm run test`
  - murmur: `npm run check`

## Implementation checklist

1. murmur: publish `@murmur_pane_since` with a compare-and-set in
   `setPaneState`, with tests (set on change, kept on a repeat, unset with
   the state). Add the Contract section to ARCHITECTURE and the 1.0.0
   CHANGELOG entry. Live check, then release 1.0.0 through CI.
2. mu: add `src/agent-state.ts` (the resolver, mapping and cache) and its
   unit tests.
3. mu: switch reconcile, `agent list/show`, `mu state` and the TUI to the
   resolver. Stop writing status.
4. mu: switch `agent wait`, `task wait` stall detection and
   `computeAgentIdle` to the resolver.
5. mu: switch spawn readiness to the murmur option, or skip it when murmur
   is missing.
6. mu: move the send input-timing checks to a private helper, remove the
   state exports from `src/detect.ts`, and add the grep test.
7. mu: add the `--json` shape (`state`, `source`, `since`, `reason`), and
   make the SDK export changes.
8. mu: add the `mu doctor` murmur check.
9. mu docs:
   - README: "agent state needs murmur"
   - the skill and `REMOTE_WORKERS.md`: drop the "ask murmur by hand" step
   - ARCHITECTURE: rewrite § "Status detection"
   - DECISIONS: this decision and what it rejects
   - ROADMAP: the column drop, and update § murmur
   - VOCABULARY
10. mu: CHANGELOG 2.0.0 (breaking: `status` is gone, murmur is needed for
    state); do the live check, then release through CI.

## Rejected

- **Scraping as a fallback.** It keeps two answers, one for each source. It
  also keeps the wrapper-patch cycle, and the misreads return whenever
  murmur is absent. `unknown` is honest.
- **Scraping only for remote workers.** Remote is exactly where scraping is
  wrong.
- **Storing runtime state in `mu.db`.** The copy goes stale. The data
  belongs in murmur.
- **Dropping the column now.** It would make this release mu's first
  migration, and the only gain would be deleting an unused column.
- **Reading murmur's `state.db`.** It couples mu to a private schema.
- **Making murmur a hard dependency.** It pulls murmur's native
  `better-sqlite3` build into installs that want only the task graph.
- **Removing the send checks.** They fixed measured failures, such as a
  prompt lost to pi's session-naming modal, and murmur cannot replace them.

## Open questions

None.
