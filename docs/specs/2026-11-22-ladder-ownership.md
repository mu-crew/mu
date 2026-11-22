# Ladder ownership: DB capability, CLOSE, delegates, host identity, cross-DB

Status: **DRAFT**, not approved. Spec B of the ladder work. It is not on
the D15 path, and nothing in it ships before the human approves it. The
review rounds and the approval come later. Do not add an approved section
to this draft.

Builds on the approved [ladder placement spec](2026-11-20-ladder-placement.md)
(Spec A), Part 1: §1 (the four places), §2 (R1-R5), §8.2 and §8.3 (the
refusals) and §9 (cross-DB refusal and no reclaim). Spec A decided those
rules. This spec does not reopen them. It settles the questions that Spec A
left to rung 2 (§C "The rung-2 spec must settle") or to "Spec B" (§I, the
`sync_ownership` row). See also the [sync guide](../guide/sync.md) and the
[remote guide](../guide/remote.md).

Every claim about today cites code at commit `9e4a9a81` (this branch's
base). Every decision below is **open**: each lists options and a
recommendation, and none is decided.

## 1. Today's storage model

### 1.1 What travels and what does not

- **Sync moves task data.** The portable tables are `checks`, `tasks`,
  `task_edges`, `task_notes` and `workstreams`
  (`src/db-schema.ts:256-262`). Every other table is machine-local
  (`src/db-schema.ts:332-360`), among them `agents`, `worktrees`,
  `remote_recovery`, `carrier_jobs`, `host_profiles`, `hosts` and
  `machine_identity`. The guide says the same: agents and worktrees stay on
  their machine (`docs/guide/sync.md:77-86`).
- **Ownership does not sync.** `tasks.owner_id` is captured for local
  history, but it is a foreign key into the machine-local `agents` table,
  so it never reaches a peer (`src/capture.ts:343-366`,
  `src/db-schema.ts:328-331`). The status column does travel. A task
  claimed on one machine shows `IN_PROGRESS` with no owner on a peer.
- **Last writer wins, and that is not a lock.** Merges are per field by
  HLC (`docs/guide/sync.md:84-86`). The claim CAS
  (`_cap_tasks_claim_cas`, `src/capture.ts:604-610`) guards only local
  writes: it is gated on `applying = 0`, so ingest never trips it. Two
  synced DBs can each claim the same task. Neither one sees the other's
  claim as a conflict.

### 1.2 Local worktrees: keyed by path

- `worktrees` is keyed by the absolute path (`src/db-schema.ts:973-986`)
  under `<state dir>/worktrees/<ws>/<agent>` (`src/worktree.ts:127-134`).
  The row outlives its agent.
- A leftover at the path is reclaimed only when this DB registered it, it
  is clean, and its HEAD is the recorded base or the last collected head.
  An unregistered tree refuses "not a worktree mu registered"
  (`src/worktree.ts:285-315`). Two DBs that share a state dir (only
  `MU_DB_PATH` differs) therefore cannot take each other's local trees.

### 1.3 Remote worktrees: the agent row, then recovery by agent id

- **The owner is the agent row.** A row with `host`, `cwd` and `base`
  set is an owned remote worktree (`OWNED`, `src/db-recovery.ts:34-36`).
  When the row is deleted (by reap, teardown, `mu sql DELETE` or a
  workstream cascade), triggers copy it into `remote_recovery`. That
  table is keyed by the original `agents.id` and pins the host identity
  (`src/db-recovery.ts:67-120`). This is Spec A's R2.
- **The host identity is the profile's identity.** For a template profile
  it is the exec bytes, for a plugin profile `plugin:<name>:<instance>`,
  and for a provider host `provider:<id>:<instance>`
  (`src/db-recovery.ts:41-50`). Nothing records which physical machine or
  remote user a profile reaches.
- **The path depends on (workstream, name), under the remote user's
  `$HOME`:**
  `$HOME/.local/state/mu-next/remote-worktrees/<ws>/<name>`
  (`src/remote-worktree.ts:115-118`). The repo plays no part
  (host-profile spec, [Out of scope](2026-10-28-host-profile-per-machine.md#out-of-scope)).
  Synced DBs share workstream names, so they derive the same path on a
  shared host.
- **The recovery guard matches by profile name.** A `--worktree` spawn
  refuses while a recovery record names the same (ws, name) **on the same
  profile name** (`src/remote-recovery.ts:227-236`; called from
  `src/agents/spawn-remote.ts:158,180`). The live-agent and path checks
  also key on the profile name (`src/remote-recovery.ts:383-423`).
- **Prepare claims the path and marks it** (shipped as `sync_ownership`,
  commits `63fbc74f` and `2bcbf66c`; Spec A §9). One link exec runs
  `mkdir "$wt"` as the atomic claim and writes this DB's `machine_id` into
  `mu-prepared` in the tree's Git directory. If Git fails, it removes only
  the directory it made itself (`src/remote-worktree.ts:250-305`).
- **A reclaim needs this DB's marker.** A tree already at the path is
  reclaimed only when the marker holds this DB's `machine_id` and the
  tree is a clean worktree of the root, at the base and quiescent
  (`src/remote-worktree.ts:134-147,264-273`). A foreign or unknown owner
  refuses with exit 4 (`RemoteWorktreeConflictError`,
  `src/remote-worktree.ts:41-56`). Static and plugin spawns always pass
  `reclaim: true` once the recovery guard has passed
  (`src/agents/spawn-remote.ts:203`, `src/agents/spawn-plugin.ts:258`).
- **The marker names the DB, not the machine.** `machine_id` belongs to the
  state dir (`src/db-schema.ts:510-517`, `src/segments.ts:177-183`). The
  state import mints a new one (`src/state-import.ts:15`). A byte copy of
  a DB file keeps the old one.

### 1.4 What a worker can reach today

- **A rung-0 worker has the orchestrator's whole DB.** Spawn pins
  `MU_DB_PATH` and `MU_STATE_DIR` into the pane, absolute, so the worker's
  `mu` reaches the same task graph from any cwd
  (`src/agents/spawn.ts:652-674`). No verb refuses a worker by identity.
  `MU_MANAGED_AGENT` only picks the implicit workstream and the caller
  (`src/cli.ts:109-135`, `src/wait-callers.ts:14-20`).
- **A remote worker gets no DB.** Only `HOST_ENV_KEYS` cross to the host,
  `MU_REMOTE=1` among them (`src/hosts.ts:518-526`,
  `src/remote-agent.ts:36-49,73-77`, `src/agents/spawn-plugin.ts:354-362`).
  A `mu` that the worker runs on the host reaches the host's own mu and
  default DB, if mu is installed there (Spec A R4).
- **Withholding `MU_DB_PATH` does not withhold the DB.** With neither
  `MU_DB_PATH` nor `MU_STATE_DIR` set, mu opens the default DB of the
  machine it runs on, and on first open it may run the state import
  (`src/state-dir.ts:18-45`, `src/state-import.ts:1-22`). On the DB's
  machine that is the user's real DB, which may not be the orchestration's
  DB.
- **CLOSE is applied to any settled ctl run, local or remote**
  (`src/wait.ts:497-503`, `src/wait-db.ts:83-115`,
  `src/close-block.ts:1-52`). The close nudge and the keep-driving nudge
  skip a process with `MU_REMOTE=1` (`extension/nudge.ts:329,469`).
- **Delegates.** `mu_delegate` runs the CLI (`mu agent spawn`, `send`,
  `wait`, `read`, `close`). The delegate starts in the caller's cwd, or
  with `workspace: true` in its own worktree branched from that repo
  (`extension/delegate.ts:1-22,489-499,889-900`).

### 1.5 Since Spec A

- **Shipped:** the §9 claim, marker and exit 4 (`sync_ownership`, above),
  and the §8.2 backend guard (`c6731ea0`, `9e4a9a81`). The guard is an
  advisory spawn refusal while a row of another managed backend exists,
  and reconcile keeps such rows. A rung-2 loop's local pane is a managed
  pane, so the guard covers it without change.
- **In progress, not merged into this branch:** pane identity
  (`agents.pane_identity`, the tmux server that a pane was born on, as an
  added column). It decides when a local pane is still the agent's. A
  rung-2 row's local pane depends on it the same way a rung-0 row's does.
  The owner row of a remote tree is reaped only on proof that its pane is
  dead. This spec assumes that work lands as reviewed and does not
  design it.
- **Rung 2 itself is not built** (Spec A §C; unit `local_loop_placement`).
  The rows it will write reuse `host`, `cwd`, `base` and `repo`
  (Spec A §1.3). So R2, recovery and §9 apply to it without a new table.

## 2. Decisions (open)

Each decision is scoped to rung 2 unless it says otherwise. The rung-2
first release is static mule hosts, pi only, with no rung-2 orchestrator
(Spec A §C, §8.3).

### D1. DB capability of a rung-2 agent

A rung-2 loop is a local pi process of the same user, on the DB's machine.
Under R4 (decided) its workspace tools go to the host, while `mu`,
`mu_delegate`, skills and credentials stay with the loop. The remote shell
is therefore not a capability boundary. The pi process, its extensions and
the routed `mu` all run where the DB is (§1.4).

**D1.1 What the loop's `mu` may do on the orchestration's DB.**

- **(a) Rung-0 parity, with the risk accepted explicitly.** The R4 `mu`
  route runs the local mu with `MU_DB_PATH` and `MU_STATE_DIR` pinned, as
  rung 0 does (`src/agents/spawn.ts:672-673`). It can run every verb a
  rung-0 worker can. This adds no mechanism, and the exposure equals rung
  0's, which has seen no incident.
- **(b) Refuse in-worker verbs by identity.** mu reads `MU_MANAGED_AGENT`
  and the row's placement, and refuses verbs outside a set (spawn, close
  of others, `host`, `sync`). This is advisory: the model can unset the
  env, and the rung-0 worker next to it has no such check. It adds a
  policy table that every new verb must update.
- **(c) An allowlist at the R4 `mu` route.** The extension forwards only
  a fixed verb set (task note, close and show, `state --me`, read verbs).
  `mu_delegate` keeps its own in-process calls. R4 already makes every
  workspace tool remote or hidden, so the route is the model's only local
  reach. Against the model, that makes this a real boundary. It is not a
  boundary against the user or the extension. Its cost is a second verb
  list beside `--help`, and it diverges from rung 0.
- **(d) No DB.** The agent reports only by CLOSE (R5-like), and the route
  refuses `mu`. A rung-2 worker then cannot take notes, and
  `mu_delegate`, which runs the CLI, breaks (see D3).
- **Rejected: withhold `MU_DB_PATH`.** That is not a capability. A local
  mu falls back to the default DB, which can be a different DB from the
  orchestration's and can trigger the state import (§1.4).

**Recommendation: (a).** State the accepted risk in the rung-2 guide: a
rung-2 worker can do what a rung-0 worker can. Keep (c) as the upgrade
if a user hits a rung-2 worker misusing the DB twice (the roadmap
promotion rule). The rung-2 tests assert that the route pins both
variables, so `mu` never falls back to the default DB.

**D1.2 A `mu` run on the host from the remote shell.** A script or a
`bash -c` that calls `mu` bypasses the literal `mu` route. It runs the
host's mu, which opens the host's default DB, someone else's DB if mu is
installed there.

- **(a) Accept it and document it.**
- **(b) mu refuses to open any DB under `MU_REMOTE=1`, on every remote
  rung.** This also covers rungs 3-5, where Spec A R4 describes the
  host's mu as reachable. It breaks `mu_delegate` in a remote pi, which
  today runs against the host's DB, so it would decide Spec A §D's
  candidate ("refusing `mu_delegate` in a remote pi"). It needs its own
  Spec A amendment.
- **(c) A rung-2-only marker in the remote command env.** mu refuses,
  before it opens anything (like the sync-dir refusal), when it sees the
  marker without an explicit `MU_DB_PATH`. The marker is one new env var
  (a reference entry and a VOCABULARY row).

**Recommendation: (c).** It is a real mechanism, it is small, and it
leaves rungs 3-5 and Spec A untouched. (b) stays with Spec A §D's
candidate.

### D2. CLOSE on rung 2

The loop is local and on `ctl`, so `closeSettledRun` already applies a
CLOSE block at the orchestrator's wait (§1.4). The open part is whether
anything else closes.

- **(a) As on rung 0.** The CLOSE block is applied at wait. The loop's env
  has no `MU_REMOTE=1`, so the close nudge runs, and the worker may also
  run `mu task close` through the route (D1.1a). The work sits in the
  remote tree until `mu agent collect`. Rung 0's work also sits unmerged in
  a local tree, so closing before collect is the same as closing before
  merge.
- **(b) CLOSE only, as R5.** The loop gets `MU_REMOTE=1`. That skips both
  nudges, including the keep-driving one (`extension/nudge.ts:329,469`),
  and it mislabels a local process. `mu task close` must also be refused
  (only D1.1c or d can do that).
- **(c) Apply CLOSE at collect, as a remote hook harness does**
  (`src/remote-collect.ts:303-355`). That ties a close to its commits
  being local. It adds a second CLOSE path for pi and delays every close
  to an explicit collect.

**Recommendation: (a).** It is consistent with D1.1a and adds no new path.
The rung-2 spawn must not set `MU_REMOTE=1` in the loop's env. The
remote command env (D1.2c) is a separate env.

### D3. Delegates of a rung-2 agent

`mu_delegate` starts its delegate in the caller's cwd (§1.4). A rung-2
agent's files are in the remote tree.

- **(a) Inherit the placement.** The delegate is a rung-2 agent on the same
  host. Without `workspace` it shares the parent's tree (inherits
  `--mule <host>:<tree>`) as a **non-owner**: its row records no `base`,
  so it is not `OWNED`, writes no recovery record, and is never collected
  or closed as a tree. That needs one exception to the shipped refusal of
  a non-worktree spawn on a managed remote tree
  (`docs/guide/remote.md:84-95`): the owner's own delegates (spawner =
  the owner row). With `workspace: true` it gets its own remote tree,
  prepared on the same host from the parent's HEAD. That commit is already
  in the host's repo, so §3.3's missing-base refusal cannot fire. Each
  delegate's remote calls queue on mule's per-connection lock (Spec A
  §4.3), so a fan-out of N costs about N round trips per step.
- **(b) Local delegates.** The delegate runs at rung 0 in the loop's local
  cwd, which is not the workspace. It suits only research that never
  reads the tree. A review or a check of the code would read the wrong
  files without saying so.
- **(c) Refuse `mu_delegate` in a rung-2 agent** in the first release. This
  is safe and small, but it costs rung-2 workers the fresh-context checks
  the mu skill asks for.

**Recommendation: (a)** with `workspace: false` in the first release.
Refuse `workspace: true` with a message until the rung-2 prepare can be
called for a delegate. The delegate-process fallback (no multiplexer)
follows the same rule. Ownership stays with the parent row (R2).

### D4. Host identity across profiles

One machine can be reached through two profiles, for example `box` (a
session template for rung 3) and `box-mule` (the mule plugin for rungs 2
and 4). The host-profile spec says a profile names a machine, but
nothing enforces that, and Spec A §7.1 keeps templates while new features
target plugins. Today's identity is the profile (§1.3), so across two
profiles of one machine:

1. **The recovery guard misses.** A recovery record under `box` does not
   stop a `--worktree` spawn of the same (ws, name) under `box-mule`. That
   spawn finds the tree at the shared path. The marker names this DB, so
   prepare reclaims the tree if it is clean, at the base and quiescent.
   One tree then has two owners, an R2 breach. The old record's close is
   held off only while the new agent holds the name
   (`src/remote-recovery.ts:390-398`). After that row is reaped, two
   recovery records name one tree, and each record's close acts on the
   other's work.
2. **Caps add up.** `max_sessions` counts per profile. A mule link
   self-admits and counts no mu row (Spec A §4.2), so this matters only
   between two mu-counted profiles.
3. **The live-path and newer-record checks miss**
   (`src/remote-recovery.ts:383-423`). Both match `host = ? AND cwd = ?`
   by profile name.

Options:

- **(a) Keep profile identity and document "one profile per machine".**
  The gap in point 1 stays.
- **(b) No reclaim while a recovery record names (ws, name) on any
  profile.** Spawn passes `reclaim: false` in that case and still creates
  a tree when the path is free (the `mkdir` claim decides). On another
  machine the path is free and the spawn proceeds. On the same machine the
  tree is there, so prepare refuses with exit 4, owner this DB, and the
  fix is to close the recovery record. This needs no schema change and
  touches one call site. It does not fix points 2 and 3.
- **(c) A probed machine identity.** `host check` or prepare records
  something like a hash of the host's machine id, remote user and
  `$HOME` in an added column. Recovery, the live-path check and
  admission then key on it. This fixes all three points, but it costs a
  per-OS probe (no `/etc/machine-id` on macOS) and an added column, and a
  probe that changes (a reimaged host) strands records.
- **(d) A declared machine key** (`mu host add --machine <key>`). The same
  checks key on it. It is cheap, but the user must keep it true, and a
  wrong key is silent.

**Recommendation: (b) now, plus (a)'s documentation for caps.** (b) closes
the one path that can destroy a live tree, with a refusal and no new
state. Points 2 and 3 cause refusals or overcommit, not lost work. Take
(c) only if a real user hits them twice.

### D5. Cross-DB beyond refusal

Spec A §9 decided refusal and no reclaim. The shipped code
(`sync_ownership`) does exactly that, and §9.4 defers an atomic claim. The
open part is what, if anything, comes next.

- **(a) Stop at refusal.** The fix stays "close it from its DB, or verify
  it is unused and remove it by hand" (`src/remote-worktree.ts:52`).
- **(b) Name the owner.** When the marker's `machine_id` is a known sync
  peer (`sync_peers`, `src/db-schema.ts:952-956`), the refusal names it
  by the prefix `mu sync` prints, so the user knows which DB to close
  from. This is read-only and small.
- **(c) An atomic claim on the host.** A lock directory holding the DB id
  with a lease and stale takeover, used for every create and reclaim.
  This is new host state with expiry rules, which is daemon-adjacent
  (VISION: no background process), and the `mkdir` claim already settles
  creates.
- **(d) Hand-off between DBs.** A verb exports a recovery record to a peer
  DB, which adopts the tree. Agents and worktrees are machine-local by
  design (`docs/guide/sync.md:79-82`). This would make one of them
  travel, outside sync.
- **(e) Sync worktree ownership.** Last writer wins is not a lock (§1.1),
  so two DBs could each believe they own a tree. This contradicts R1.

**Recommendation: (a) plus (b).** Reject (d) and (e). Keep (c) behind the
promotion rule (a real user hits a cross-DB race twice). Known limit:
a byte copy of a DB file shares the `machine_id`, so the marker cannot
tell the copy from the original. The same copy already breaks sync's
one-writer-per-segment rule, so it needs no rule of its own.

## 3. Out of scope

- R4's routing of each built-in tool, path routing, the remote
  `AGENTS.md`, a master drop mid-turn, and the rest of D1/D8: the rung-2
  spec (Spec A §C).
- mule serve and its ops, thresholds and acceptance (Spec A §C).
- The pane identity design, beyond relying on it (§1.5).
- Anything Spec A decided: R1-R5, §8.2's advisory guard, §8.3's
  orchestrator refusal, §9's claim and marker.
- A durable per-workstream backend binding (Spec A Open 4b), provider-backed
  rung 2, and claude and codex on rung 2.
- A schema bump. D4c's column would be additive (`ADDED_COLUMNS`), and it
  is not recommended.
- The remote root's `mu-next` path segment (`src/remote-worktree.ts:117`).
  Spec A §9.4 covers mixed versions on a host. Renaming the segment would
  move every live remote tree.
- Visibility: placement columns, a Hosts tab, notices (Spec A §D).

## 4. What approval would bind

If the human approves the recommendations, these units take them: D1.1a
and D2a go to `local_loop_placement`, as tests that the route pins the DB
and the loop has no `MU_REMOTE`. D1.2c, D3a and D4b each become a small
unit with a regression that fails today. D5b joins the §9 owner. This list
is a proposal, not an approval.
