# mu plugins: hosts, jobs, links, channels

Status: draft 1, written 2026-11-09. Not built. It goes to a refutation
round before P1 starts. It covers mu and, for one unit (P7), mule. The
starting design was a short decision sketch: three state machines and six
seams. Five code surveys of mu at `42881032` and of mule 0.4.0 tested that
sketch. Where a survey contradicted it, the survey won, and each decision
below says so ([Where the surveys overrode the sketch](#where-the-surveys-overrode-the-sketch)).

## Goal

Let mu drive remote and elastic agent backends correctly, without putting
any one backend's code in mu. Two kinds of backend motivate this:

- **Machines provisioned on demand.** A host exists because someone asked
  for it. It has a deadline after which it is gone whatever mu does, and
  the backend may reclaim it once it sits idle. Work left on it at that
  moment is lost.
- **Session-hosted agents.** The agent's state lives in a remote service
  that mu can ask. No local process holds it, so a pane dying proves
  nothing about the agent.

Today's mu cannot express either. An agent's liveness is its pane's
liveness. A host is a fixed template that never goes away. A crash
between an intent and its effect is handled case by case. A backend that
cannot say what state a job is in has no way to say so.

mu gets mu-owned state machines for hosts, jobs and turns. It gets one
TypeScript interface per seam, with today's code re-expressed behind those
interfaces and its behaviour unchanged. External implementations
(**plugins**) speak a versioned JSON-RPC protocol over stdio, and mu drives
them through one built-in adapter. mule becomes the first plugin. A
private plugin for a provisioning backend is written against the published
contract, outside this repo.

## Principles

1. **One interface per seam, two kinds of implementation.** Built-ins
   implement a seam in process. Plugins implement it through the adapter.
   If a built-in cannot live behind the interface, the interface is
   incomplete.
2. **mu owns the state machines; implementations report facts.** A plugin
   never writes mu's DB, its state directory or its log. Every effect
   returns facts, and mu records the transitions.
3. **Every effect is written ahead and keyed.** mu records the intent on
   the subject's row and generates an idempotency key, persisting both
   before the call. After a crash, mu reconciles by asking, never by
   guessing or resending.
4. **Status is mandatory and truthful.** Every implementation answers
   "what is this host, job or turn now?". `unknown` is an honest answer.
   An outcome that is unknown is terminal until something asks and gets a
   definite answer.
5. **Capabilities have defined meanings and are enforced.** mu's verbs gate
   on declared capabilities. The contract suite checks that each
   implementation behaves as it declares.
6. **A seam opens only where two real implementations need it.** A
   built-in plus a plugin that a real user runs counts as two. The
   contract suite's fake plugin does not count. `MuxBackend` stays closed.
7. **Behaviour is unchanged until the last mu unit.** P1–P5 move code
   behind interfaces, and their tests keep their assertions. Only P6 adds
   reachable behaviour. Even then, built-in hosts, jobs and channels keep
   behaving as they do today.

## Where the surveys overrode the sketch

| Sketch said | Code says | Chosen |
| --- | --- | --- |
| A Transport seam: `exec`, `fetch`, `push`, and a worktree contract | "transport" already names a profile's `session`/`lease` (`docs/VOCABULARY.md:251`, `src/hosts.ts:199`) and a channel alias (`src/agents/transport.ts:30`). `push` has no call site. mule forbids bulk transfer on its connection (`mule/SPEC.md:541`). | The seam is the **link**: `exec`, plus an optional `fetch`. There is no `push`. The worktree contract is mu's own scripts over `exec`, not plugin methods (D7). |
| `start` returns a handle mu records | A lease carrier publishes its handle from inside mu's pane, through a file mu polls (`src/agents/lease-carrier.ts:248`) | `start` returns a view command and says where the handle comes from: the pane, a file, or the reply (D8). |
| Job states reserved, launching, running, stopped, lost, all persisted | ROADMAP rejects runtime agent state in `mu.db` (`docs/ROADMAP.md:146`) | mu persists only the transitions it makes. Liveness (running, ended, lost, unknown) is asked at read time (D1). |
| Liveness belongs to the job, so a pane is only a view | mule ties a lease job to its pane by design: a signal stops the job (`mule/SPEC.md:102`). Every agent row needs a pane (`src/db.ts:1098`). | Every agent keeps a view pane in this version. A view is `bound` (its death ends the job: pane, lease and gate jobs) or `detached` (plugin jobs only) (D3). |
| Two job built-ins, pane and lease | The command gate is a third non-pane job kind, with its own status (`src/agents/gate.ts:27-31`) | Three built-in job kinds: `pane`, `lease`, `gate` (D8). |
| The idempotency key is passed to every effect | `carrier_jobs.token` is generated (`src/carrier-jobs.ts:125`) but never sent anywhere. The job file is named by (workstream, name) (`src/agents/lease-carrier.ts:118`). mule rejects caller-chosen ids (`mule/SPEC.md:517`). | Keys are sent from P6 on. `lookup(key)` is a seam method. mule gains `--key` in P7 (D4, D15). |
| `fence` is a remote callback | ctl's fence runs synchronously in the socket's connect handler, immediately before the one write (`src/ctl/client.ts:166-180`) | A plugin fence is two-phase: prepare, then mu's compare-and-set, then commit. This is a trust assumption, stated as one (D13). |
| `receipt` alone reconciles a delivery | The hooks journal reconciles by counting turns past a baseline, not by msgId (`src/agents/task-spawn.ts:717-720`) | A new `reconcile(intent)` on `AgentChannel` (D9). |
| `carrier_jobs` and `remote_recovery` merge into new job and host tables | Released binaries read `carrier_jobs` as the name fence (`src/agents.ts:416-424`). `remote_recovery` is filled by triggers on every delete path (`src/db-recovery.ts:76-100`). | `carrier_jobs` stays the job record and gains columns. `remote_recovery` is unchanged and blocks a host's release. A new `hosts` table holds only provider hosts (D5). |
| Lifecycle hooks are a plugin seam | Collect and close are mu's own destructive or networked effects. No plugin code is needed to decide when to run them. | They are **lifecycle policies**: mu-owned and driven by host facts. Collect at settle is automatic; closing is only ever suggested (D10). |
| Host provider `capacity()` | `max_sessions` counts connection slots, not jobs. A lease pane holds none (`src/agents/spawn-remote.ts:178,194`). | Capacity has two parts. The link declares who counts connection slots. The provider reports job slots as a host fact (D6, D7). |
| Run states idle, running, blocked, settled | Readings also carry `unknown` (`src/agent-state.ts:11`), unconfirmed idle, `queued` (`src/channels/dispatch.ts:94-110`) and pending messages. "run" already names the executor's charge (`docs/VOCABULARY.md:242`). | The machine is called the **turn**, and its state set includes all of these (D1). |

## Decisions

### D1. The model: hosts, jobs and turns, owned by mu

Three state machines. mu alone moves them. Implementations report the
facts that move them.

**Host.** A machine that jobs run on. A **static host** is a host profile
(`host_profiles`, `src/db.ts:1338-1349`). It is always `ready`, it is never
persisted as a host record, and `mu host add`/`rm` stay its whole
lifecycle. A **provider host** has a host record (D5). Its transitions:

| Transition | Triggered by | Persisted before the effect | Persisted after |
| --- | --- | --- | --- |
| → `acquiring` | `mu host acquire <name> --provider <p>` (P6) | the record: name, provider, plugin instance, spec digest, mu-generated key, creator pid and start time, `pending_op = acquire`. The name is fenced in the same transaction. | — |
| `acquiring` → `ready` | the provider's `acquire` reply, or `lookup(key)` after a crash | — | handle, `deadline_at`, `idle_reclaim_ms`, `max_jobs`; pending cleared |
| `acquiring` → deleted | a `permanent` or `retryable` error (nothing happened), or `lookup` proves no host | — | an event in the log |
| `acquiring` stays | crash, timeout, `unknown-outcome`, or `lookup` answers `unknown` | — | nothing: unknown is terminal until asked (D4) |
| `ready` → `draining` | `mu host drain`, or a spawn refused inside the deadline margin (D10) | `state` | — |
| `ready`/`draining` → `lost` | any host read whose `status` answers `gone` while mu has not released it | — | `state`, `reason` |
| `draining`/`lost` → `releasing` | `mu host release`, only when no agent row, job record or `remote_recovery` row names the host, and every remote worktree on it was closed under the close rules | `pending_op = release`, key `<key>:release` | — |
| `releasing` → deleted | `release` returns, or `status` answers `gone` | — | an event in the log |

`--abandon` on `host release` drops a record the provider can no longer
answer for. It works like `agent close --abandon-job`: a human decision,
logged, never implied by `--force`.

**Job.** One agent's process. Each job has a **job kind** (D8):

- `pane`: today's local panes and the remote `session` panes.
- `lease`: today's carrier.
- `gate`: a command gate.
- one kind per job plugin.

A pane job has no record of its own: the agents row is the record, and its
pane id is the handle. Every other job has a **job record**: a
`carrier_jobs` row, today's **reservation** (`src/db-carrier.ts:23-43`).

| Transition | Triggered by | Persisted (today's code) |
| --- | --- | --- |
| → `reserved` | spawn, under the agent lock, before any effect (`src/agents/spawn.ts:503`, `src/agents/lease-carrier.ts:191`) | the row, an immutable token (`src/carrier-jobs.ts:114-125`), and the host and stop identity. The row is the name fence (`src/agents/lease-carrier.ts:174`, `src/agents.ts:416-424`). |
| `reserved` → `launching` | spawn, just before the start effect (`src/agents/spawn.ts:842`) | `launch = 'intent'` (`src/carrier-jobs.ts:203`) |
| `launching` → `started` | the job handshake (`src/agents/lease-carrier.ts:248`), a plugin's `start` reply, or `lookup(key)` after a crash | the handle (`src/carrier-jobs.ts:265`), the view pane (`:210`), the agent (`:225`) |
| `reserved` → deleted | rollback while `launch` is still `none` (`src/agents/lease-carrier.ts:317`) | — |
| `launching` with no handle | the pane died first, the deadline passed, or the job file is invalid or unreadable (`src/agents/lease-carrier.ts:265-297`) | nothing: the row stays and stays unknown (`describeEmptyReservation`, `:412`). From P6, `lookup(key)` resolves it when the kind declares `lookup`. |
| `started` → `stopping` | `agent close`, after the view proof for a bound view (`src/agents/close.ts:546-568`) | new: `pending_op = stop`, key `<token>:stop` |
| `stopping` → deleted | `stop` proves the job gone (`src/carrier-stop.ts:66-117`), then the job file and tree are cleaned up (`src/agents/lease-carrier.ts:590`) | the settle mode, which the reaper reads: stopped by mu or abandoned means the tasks reopen as todo; ended or lost on its own means they are parked (`src/agents/reap.ts:55-78`) |
| any → deleted | `agent close --abandon-job` (`src/agents/lease-carrier.ts:466`) | an event naming the handle |

**Liveness** is a reading, asked at read time and never stored: `running`,
`ended(exit)`, `lost(reason)`, `unknown(reason)`. Which source answers
depends on the view:

- **bound view:** the pane answers. The answer is the same as today's
  `paneAlive` (`src/mux/types.ts:330`).
- **detached view:** the job kind's `status` answers.

mu never moves a job record on a reading alone. A job that reads `ended`
is still stopped (stop is idempotent) before its record is released.

**Turn.** One prompt-to-settle of an agent, what the channels count as
`runs`. Its states are the channel readings:

- `idle` and `idle?` (unconfirmed, `src/channels/types.ts:310-316`);
- `running`, `queued` (in muzzle) and `blocked`;
- `settled(text, outcome)`;
- `unknown`.

A turn is never persisted (ROADMAP's rejection of runtime agent state
stands). mu persists only what it consumed: the wait cursor's completion
token and the applied settle, keyed by the agent's registry id plus the
channel incarnation (`wait_cursors`, `agent_settles`, `src/db.ts:1243`,
`:1272`). A fresh that starts a new job would break that key, so it is a
declared capability (D12), not a silent change of incarnation.

**Today's records under the model:**

| Record | Role in the model |
| --- | --- |
| `agents` row | The agent. Its incarnation is the row id. `pane_id` (NOT NULL, `src/db.ts:1098`) is the view and, for a pane job, the job handle. `host`, `host_transport` and `channel` name the host, the job kind and the channel. Unchanged. |
| `carrier_jobs` | The job record of every non-pane job. `token` is the job key. It gains columns in P6 (D5). |
| `remote_recovery` | A remote worktree's record after its agent row is gone, written by triggers (`src/db-recovery.ts:76-100`). Not host state. It blocks a provider host's release. Unchanged. |
| `host_profiles` | The static provider's hosts. The template link's `exec` and `fetch`. The job kind, through `transport` (`session` means `pane`, `lease` means `lease`). It gains a `plugin` column (D5). |
| `host_channels` | The link's connection slots. mu keeps admission (`src/hosts.ts:781`) for every link that declares `slots: "mu"` (D7). Not host state. |
| `spawn_receipts`, `wait_action_receipts`, delegate call states | Delivery intents, unchanged. They are the journals D4 extends to plugin channels. |
| `hosts` (new, P6) | Provider hosts. |
| `plugins` (new, P6) | Plugin registrations (D14). |

### D2. Names

The words below enter `docs/VOCABULARY.md` with this spec. Existing words
keep their meaning.

- **link**, not "transport". "transport" stays the profile field (`session`
  or `lease`), which in this model selects the job kind. P2 renames the
  `Transport = ChannelName` alias (`src/agents/transport.ts:30`) to
  `SendChannel`, freeing the third meaning.
- **turn**, not "run". **run** stays the executor's charge.
- **job kind**, not "driver" or "backend".
- **effect intent**, not "intent", which stays the op label.
- **plugin** means only a `mu-plugin-<name>` executable. pi's are
  **extensions**, as before.
- **capability** means a declared, enforced property of an implementation.
  It is not **host capabilities** (the probed harness record,
  `src/host-harnesses.ts:218-228`) and not a **role**.
- **write fence** and **run baseline**: the code uses "fence" for both
  (`AgentChannel.fence`, `src/channels/types.ts:150`; `hooksFence`,
  `sentFence` at `src/cli/wait-arm.ts:97-106`). P4 renames the second to
  run baseline.

### D3. Every agent keeps a view pane (this version)

A job's **view** is the pane mu opens for it through `MuxBackend.spawnAgent`
(`src/mux/types.ts:323`). In this version every agent has one:

- **pane job:** the view is the job.
- **lease job:** the view is the carrier.
- **gate job:** the view is the foreground command.
- **plugin job:** the view runs the plugin's view command.

Why every agent keeps a pane:

- **VISION's visible crews.** Each agent sits in a pane you can attach to.
- **`agents.pane_id` is NOT NULL** and appears in 13 `pane_id = ?`
  predicates outside `src/mux/`, among them `deleteAgent` (`src/agents.ts:576`), the guarded
  release and the action receipts (`src/db.ts:1312`). Keeping a real pane
  keeps every one of them correct without a rebuild.
- **Released builds stay safe** (D5). They see a live pane and keep the
  row.

A view is **bound** or **detached**. That is the job kind's `view`
capability (D12):

- **Bound:** the view's death ends the job, or starts its stop. This is
  how the `pane`, `lease` and `gate` kinds behave today. mule's carrier
  stops its job on SIGHUP, SIGINT or SIGTERM by design (`mule/SPEC.md:102`).
- **Detached:** the job outlives its view. reconcile asks the job kind's
  `status` before treating the row as a ghost. A detached job whose view
  died stays registered with no view, and **reattach** opens a new view for
  it. Only plugin kinds may declare `detached`.

A plugin view is read-only. mu starts it with stdin from `/dev/null`, so
no keystroke or paste reaches the job except through its channel. This
holds even from a released build that derives the wrong channel (D5).

### D4. Crash safety: effect intents, keys, reconcile by asking

**An effect** is a call that changes something outside mu's DB. Each one
follows the same four rules. Today's journals already follow them; D4
names the rules and applies them to every seam.

1. **Write ahead.** Before the call, mu writes the **effect intent** on
   the subject's row, with a mu-generated **idempotency key**, in one
   immediate transaction that also fences the subject. Examples today:
   - `launch = 'intent'` (`src/agents/spawn.ts:842`);
   - the `sending` state of a spawn receipt (`src/agents/task-spawn.ts:564`);
   - the `sending` state of an action receipt (`src/db.ts:1304-1320`).
2. **Keyed.** The key goes with the call. An implementation that declares
   key dedupe returns the first call's result for a repeat. One that does
   not declare it is never sent a repeat.
3. **Reconcile by asking.** After a crash, a timeout or an
   `unknown-outcome` error, the next verb that touches the subject first
   asks (`lookup`, `status`, `receipt`, `reconcile`). Asking is read-only
   and may be repeated. Nothing is resent.
4. **Unknown is terminal until asked.** A subject whose intent has no
   definite outcome refuses every new effect on it: a spawn of the name, a
   stop, a release. Only two things end that state:
   - a later ask that gets a definite answer;
   - a human's explicit abandon verb, which logs what it dropped.

   `--force` never stands in for an answer.

Where each effect's intent lives. There is no separate effects table: each
intent sits on its subject, and the existing journals keep their roles.
Folding them together would be a wrapper around a wrapper (`docs/ROADMAP.md:28`).

| Effect | Subject record | Key | After a crash, mu asks |
| --- | --- | --- | --- |
| host acquire | `hosts` row, `acquiring` | `hosts.key` (UUID) | `provider.lookup(key)` |
| host release | `hosts` row, `releasing` | `<key>:release` | `provider.status`; `gone` means done. `release` is idempotent. |
| lease job start | `carrier_jobs`, `launch = 'intent'` | `token` | the job file, as today. From P7, `lookup(token)`. |
| plugin job start | `carrier_jobs`, `launch = 'intent'` | `token` | `job.lookup(token)`, mandatory for such kinds (D8) |
| job stop | `carrier_jobs`, `pending_op = stop` | `<token>:stop` | stop again (idempotent: exit 0 for an ended job, `mule/SPEC.md:366`) |
| pane spawn | the placeholder row `%pending-<name>` (`src/agents.ts:550-559`) | the name | the dead-staging rules, unchanged |
| task-spawn delivery | `spawn_receipts`, `sending` | `msg_id` | `channel.reconcile` (D9) |
| stall steer | `wait_action_receipts`, `sending` | (task, owner, incarnation, action) | `channel.reconcile` |
| remote worktree make | fixed path plus a `mu-prepared` mark | the path | reclaim of an unused leftover (`src/remote-agent.ts:83-100`) |
| remote worktree remove | `remote_recovery.aside` | `asideOf(path, incarnation)` (`src/remote-agent.ts:276`) | observe, which resumes the aside |
| collect | the pin ref plus `collected_head` | the agent identity | rerun: `FETCH_HEAD` is deleted first (`src/remote-collect.ts:10-17`) |

**Retries.** Only an error of kind `retryable` may be retried, because the
implementation says nothing happened. A retry reuses the same key, mu tries
at most three times, and only for a method whose kind declares key dedupe.
`human` is never retried (as `HostHandbackError` is today, `src/hosts.ts:924`).

**The key reaches the far side.** Today `carrier_jobs.token` is never sent
anywhere. From P6, every plugin call carries its key. From P7, mule stores
it with the job (D15). That closes today's dead end: an empty reservation
with `launch = 'intent'` that nothing can resolve.

### D5. Schema: additive at 13, state dir unchanged

**Decision.** Everything stays at schema 13, through `upgradeSchema`
(`src/db.ts:476-505`), in `mu-next` (`src/state-dir.ts:15-18`). P1–P5 add
nothing to the schema. P6 adds two machine-local tables and a few nullable
columns.

**Why not a version bump and a new state directory.** AGENTS.md
"State directories" requires a new directory only for a change that breaks
on-disk compatibility with the released version. A v14 file makes every
released build refuse the DB (`SchemaTooNewError`, `src/db.ts:440-455`),
so the bump itself would be the break, and it would buy nothing: nothing
here needs a migration ladder. The other choice, `mu5` with an importer,
costs every user a move for the same additions. What must hold instead is
that a released build which opens a DB holding plugin rows **fails
closed**: it never acts on a plugin row as if it understood it. Each
addition is shaped for that:

| Addition | Why a released build stays safe |
| --- | --- |
| `plugins`, `hosts` (new tables) | Ignored: `schemaIsCurrent` checks only the objects it expects (`src/db.ts:682-707`); tables have been added before with no bump (`src/db.ts:736-740`). A provider host has no profile, so a released build refuses the remote verbs that need one: a stop refuses `no-host` (`src/carrier-stop.ts:81-85`), and `assertRecoveryProfile` refuses a record with no profile (`src/remote-recovery.ts:344-363`). The skew script (P6) checks the rest. |
| `carrier_jobs.kind`, `plugin`, `identity`, `pending_op`, `pending_at`, `host_id`; NULL `kind` means `lease` | Plugin jobs are rows in the table released builds already read as the name fence (`src/agents.ts:416-424`), so they keep fencing. A plugin job on a provider host makes a released close refuse with `no-host`. One on a profile host (mule, D15) keeps the profile's `stop` in `host_stop`, so a released close stops it through the template exactly as today. |
| `host_profiles.plugin` | A plugin-backed profile keeps its templates. A released build uses the templates; this build uses the plugin for the seams the plugin implements. |
| `spawn_receipts.channel` (for a plugin channel); `transport` stays NULL | The `transport` CHECK (`src/db-receipts.ts:42`) must not be dropped. A released build detects a table whose SQL lacks `'hooks'` as the old shape and rebuilds it with its own CHECK (`src/db-receipts.ts:58-63`, `src/db.ts:527-528`), and a plugin value would then fail that rebuild and every later `openDb`. With `transport` NULL, a released replay says "no receipt to ask" and never resends (`src/agents/task-spawn.ts:718`). |
| `agents.channel` holding a plugin channel name | A released build coerces an unknown name to NULL (`src/agents.ts:387`) and derives `mux` (`src/channels/select.ts:43-62`). Its send is then refused or lands in the read-only view (D3). Its reconcile sees a live view pane and keeps the row. |

Released builds cannot see a provider host's deadline, so they apply no
lifecycle policy (D10). The release notes say so.

**Tables.**

- `hosts`: id, name, provider, key UNIQUE, handle, state CHECK (`acquiring`,
  `ready`, `draining`, `releasing`, `lost`), `deadline_at`,
  `idle_reclaim_ms`, `max_jobs`, `pending_op`, `pending_at`, `creator_pid`,
  `creator_start`, `reason`, `created_at`, `updated_at`. A unique index on
  `name`; a released host's row is deleted.
- `plugins`: name PK, path, protocol, version, instance, `seams_json`,
  `caps_json`, `schema_digest`, `added_at`, `checked_at`.

Both are listed in `MACHINE_LOCAL_TABLES` (`src/db.ts:893-918`) and
`UNREBUILDABLE_TABLES` (`src/rebuild.ts:127`). They are not captured, so
`CAPTURE_VERSION` is unchanged. P6 updates `EXPECTED_TABLES` (29 → 31) and
`test/db.test.ts`.

**The next major** renames `carrier_jobs` to `jobs`, drops
`spawn_receipts.transport` for `channel`, and moves to a versioned state
directory with an importer. It is not part of this spec.

### D6. Seam: host provider

```ts
// src/host-provider.ts
/** A mu-generated idempotency key, persisted before the call that carries it. */
export type EffectKey = string;

/** Every seam call gets mu's deadline; past it mu cancels, and an effect's outcome is unknown. */
export interface Call {
  deadline: number; // epoch ms
  signal: AbortSignal;
}

/** What `lookup(key)` found: the result, proof of none, or no answer. */
export type KeyLookup<T> = { found: T } | { found: null } | { unknown: string };

/** Provider-defined parameters; opaque to mu, recorded by digest. */
export interface HostSpec {
  params: Readonly<Record<string, string>>;
}

export interface HostFacts {
  /** Opaque, `JOB_HANDLE_RE`-shaped (src/hosts.ts:206). */
  handle: string;
  /** Epoch ms after which the host is gone whatever mu does. Absent: none. */
  deadlineAt?: number;
  /** The backend reclaims the host after this long idle. Absent: never. */
  idleReclaimMs?: number;
  /** Jobs the host runs at once. Absent: no provider limit. */
  maxJobs?: number;
}

export type HostStatus =
  | ({ state: "up" } & HostFacts)
  | { state: "gone"; reason: string }
  | { state: "needs-human"; remedy: string }
  | { state: "unknown"; reason: string };

export interface HostProvider {
  /** "static", or the plugin's name. */
  readonly name: string;
  /** Acquire one host. A repeat with the same key returns the first call's host. */
  acquire(spec: HostSpec, key: EffectKey, call: Call): Promise<HostFacts>;
  /** Which host, if any, `key` acquired. Mandatory: reconcile by asking. */
  lookup(key: EffectKey, call: Call): Promise<KeyLookup<HostFacts>>;
  /** What the host is now. "Cannot tell" is `unknown`, never a throw. */
  status(handle: string, call: Call): Promise<HostStatus>;
  /** Idempotent: a host already released resolves. */
  release(handle: string, key: EffectKey, call: Call): Promise<void>;
}

/** What the rest of mu holds for `--host <name>`. */
export interface HostView {
  name: string;
  provider: HostProvider;
  link: HostLink;
  jobKind: JobKind;
  /** Static hosts only. */
  profile?: HostProfile;
  /** Provider hosts only. */
  record?: HostRecord;
}

/** `--host <name>`: a profile is a static host; otherwise a ready host record. */
export function resolveHost(db: Db, name: string): HostView;
```

**Built-in `static`.** `status` answers `up` with the profile name as the
handle, without a round trip. Reachability stays a per-call fact, as it is
today. `acquire`, `lookup` and `release` refuse: a static host is added and
removed with `mu host add`/`rm`, and `removeHost` keeps its current rule
(`src/hosts.ts:290-300`).

**Moves behind it in P3:**

- every `getHost(db, name)` outside `hosts.ts` and the profile verbs:
  `src/agents/close.ts`, `src/agents/spawn-remote.ts` and
  `src/carrier-stop.ts`. The template runners that look the profile up
  by name (`runHostTemplate`, `withHostChannel`) take a `HostView` after
  P2 and P3.
- the raw `host_profiles` read in `src/agents/reattach-check.ts:102`.

**Missing from the sketch:**

- `lookup(key)`;
- `needs-human` as a status;
- the deadline and capacity as facts on `status`, not as methods. The
  sketch's `capacity()` took no host.
- the split between job slots (`maxJobs`, a provider fact) and connection
  slots (the link's `slots`, D7). Today's `max_sessions` counts only
  connection slots.

**Deliberately unchanged.** Today a static `host rm` succeeds while a
lease job runs: a lease holds no channel (`src/agents/spawn-remote.ts:194`).
Its stop then refuses with `no-host`, and re-adding the identical profile
recovers it. Changing that would change behaviour; it is
[open question 5](#open-questions). The "released only when every job is
closed and collected" rule applies to provider hosts.

**Second implementation:** an out-of-tree provisioning plugin, the one the
[Goal](#goal) motivates. mule is not a provider: it never opens or
provisions machines (`mule/SPEC.md:505`).

### D7. Seam: link, and the worktree contract

```ts
// src/host-link.ts
export interface LinkRun {
  exitCode: number | null; // null: timed out, and nothing is left running
  stdout: string;
  stderr: string;
  /** The output was cut (mule's exit 7, mule/src/errors.rs:13): refuse to parse it. */
  partial: boolean;
}

export interface LinkCaps {
  /** Whether this link can bring a commit home; false: the profile's fetch template does. */
  fetch: boolean;
  /** The largest script `exec` accepts (today EXEC_ARG_MAX_BYTES, src/agents/hooks-brief.ts:72). */
  maxScriptBytes: number;
  /** "mu": every call holds a host channel (src/hosts.ts:781). "self": the link arbitrates its own connection. */
  slots: "mu" | "self";
}

export interface HostLink {
  /** "template", or the plugin's name. */
  readonly name: string;
  readonly caps: LinkCaps;
  /** The identity recovery records and the probe record pin. Template: the exec bytes. Plugin: name plus instance. */
  fingerprint(host: HostView): string;
  /**
   * Run a POSIX sh script in `cwd` ("." = the login directory). The call
   * returns only once nothing it started still runs (src/hosts.ts:897-902).
   * A hand-back throws HostHandbackError. Never retried.
   */
  exec(host: HostView, req: { script: string; cwd: string; timeoutMs: number }, call: Call): Promise<LinkRun>;
  /** Leave `remoteCwd`'s HEAD in `localRepo`'s FETCH_HEAD. mu verifies the commit itself. */
  fetch?(host: HostView, req: { remoteCwd: string; localRepo: string; timeoutMs: number }, call: Call): Promise<LinkRun>;
}
```

**Built-in `template`.** Today's `exec` and `fetch` templates, run by
`runLeasedTemplate` (`src/hosts.ts:903-933`). Admission, the pgid record
taken before the command starts (`:857`), the timeout plus `HOST_GRACE_MS`
(`:888`), and exit 3 as a hand-back (`:924`) are unchanged. `slots: "mu"`.
`fingerprint` is the exec bytes, which is what `remote_recovery.host_exec`
already pins (`src/db-recovery.ts:82,94`).

**Moves behind it in P2:**

- every call to `runLeasedTemplate` and `runHostTemplate` outside
  `hosts.ts`: `remote-agent.ts`, `remote-collect.ts`, `agents/gate.ts`,
  `agents/hooks-brief.ts`, `channels/hooks-remote.ts` and
  `carrier-stop.ts`;
- the `RemoteReader` (`src/channels/types.ts:104`), which reads through
  `link.exec`. Today it is a channel-to-template dependency;
- the brief's size check (`src/agents/hooks-brief.ts:151`), which reads
  `caps.maxScriptBytes`.

**The worktree contract is mu's, over `exec`.** Make, observe, quiesce and
remove are mu's shell scripts. They are split in P2 from `remote-agent.ts`
(671 lines) into `src/remote-worktree.ts`. A link has no worktree methods.
The contract a link must meet for these scripts:

- `exec` runs POSIX sh with git on the far side.
- The far side has `/proc` or `lsof`, and the scanner sees its own `$$`.
  Otherwise the quiescence proof refuses (`src/remote-agent.ts:292-299`).
- stdout arrives whole (`partial` false), because the scripts answer with
  tagged lines.
- A script that times out leaves nothing running.

```ts
// src/remote-worktree.ts (mu-owned; every method is one or two link.exec calls)
export interface RemoteWorktree {
  make(h: HostView, r: { root: string; from: string; path: string; reclaim: boolean }): Promise<{ repoAbs: string; base: string; path: string }>;
  observe(h: HostView, r: { path: string; root: string; aside: string }): Promise<{ state: "clean" | "dirty" | "gone"; head: string | null; merged: boolean }>;
  quiesce(h: HostView, r: { aside: string; force: boolean }): Promise<{ proven: true } | { held: { pid: number; etime: string; args: string }[] } | { unproven: string }>;
  /** The 12 outcomes of REMOTE_RM_RE (src/remote-agent.ts:265). */
  remove(h: HostView, r: { aside: string; wantHead: string; keepBranch?: string; viaRef: boolean }): Promise<RemoteRemoval>;
  rollbackRemove(h: HostView, r: { path: string; base: string }): Promise<"removed" | "kept" | "gone">;
}
```

These are git-only, as remote worktrees are today. Local worktrees go
through `src/vcs/`.

**Missing from the sketch:**

- `fingerprint`;
- `maxScriptBytes`. An external link cannot be measured from outside, so
  the limit must be declared.
- `partial`;
- `slots`;
- the env as a structured map rather than shell words. That goes on the job
  (D8) and removes the `env {env} sh -c` workaround the mule starter needs
  (`src/hosts.ts:324`).

**Dropped from the sketch:** `push`, which has no call site, and a key on
`exec`. `exec` is not idempotent; mu's scripts carry their own keys: the
path, the mark and the aside.

**Second implementation:** mule (P7), with `fetch: false`, because bulk
transfer may not ride its connection (`mule/SPEC.md:47,541`), and
`slots: "self"`.

### D8. Seam: job kind

```ts
// src/jobs/types.ts (new cluster: types, pane, lease, gate, liveness; an ARCHITECTURE row)
/** Exactly the fields MuxBackend.spawnAgent takes for the pane's process (src/mux/types.ts:62-90). */
export interface PaneCommand {
  command: string;
  env: Record<string, string>;
  cwd?: string;
}

export interface JobSpec {
  workstream: string;
  name: string;
  /** The agent's command on the host. */
  cmd: string;
  cwd: string;
  /** Only HOST_ENV_KEYS (src/hosts.ts:392); mu refuses any other key before the call. */
  env: Partial<Record<HostEnvKey, string>>;
  /** The control socket pair, when the agent's channel is ctl. */
  sockets?: { local: string; remote: string };
}

export type JobStart = {
  /** mu opens this pane through MuxBackend. Every job has one in this version (D3). */
  view: PaneCommand;
  /** Where the handle comes from: the view pane's id, a file the view writes, or this reply. */
  handle: { from: "pane" } | { from: "file"; path: string } | { from: "reply"; value: string };
};

export type JobLiveness =
  | { state: "running" }
  | { state: "ended"; exit: number | null }
  | { state: "lost"; reason: string }
  | { state: "unknown"; reason: string };

export interface StartedJob {
  key: EffectKey;
  handle: string;
  host: HostView | null; // null: a local pane job
  viewPaneId: string;
  /** The identity recorded with the handle: today host_stop. */
  identity: string;
}

export interface JobCaps {
  view: "bound" | "detached";
  /** lookup(key) answers. Mandatory when handle.from is "reply". */
  lookup: boolean;
}

export interface JobKind {
  /** "pane" | "lease" | "gate" | a plugin's kind. */
  readonly name: string;
  readonly caps: JobCaps;
  /** The stop fence: the identity a later stop must match (lease: the stop template bytes). */
  identity(host: HostView | null): string;
  start(host: HostView | null, spec: JobSpec, key: EffectKey, call: Call): Promise<JobStart>;
  lookup(host: HostView | null, key: EffectKey, call: Call): Promise<KeyLookup<string>>;
  status(job: StartedJob, call: Call): Promise<JobLiveness>;
  /** Idempotent. Resolves only on proof the job is gone; a hand-back throws HostHandbackError. */
  stop(job: StartedJob, key: EffectKey, call: Call): Promise<void>;
  /** A new view for a job that still runs. */
  attach(job: StartedJob, call: Call): Promise<PaneCommand>;
}

/** The one read every "is this agent alive" site uses from P1 on. */
export function jobLiveness(db: Db, row: AgentRow, call: Call): Promise<JobLiveness>;
```

**Built-ins:**

| Kind | `start` | `status` | `stop` | `attach` |
| --- | --- | --- | --- | --- |
| `pane` | the local command, or the `session` profile's `shell` template; `handle.from = pane` | `paneAlive` (`src/mux/types.ts:330`). A throw is `unknown`. | `killPane` plus a `paneAlive` proof (`src/agents/close.ts:546-568`). `force` stands in only for a pane that no multiplexer can answer for, as today. | refused |
| `lease` | the lease `shell` template; `handle.from = file` (`src/agents/lease-carrier.ts:118`) | through the bound view: the pane, as today | `runStop` behind the `host_stop` byte fence (`src/carrier-stop.ts:88,97`) | the `attach` template, behind the pending-carrier marker |
| `gate` | the gate command; `handle.from = pane` | the pane plus the host's completion record over `link.exec` (`src/agents/gate.ts:133`) | `killPane` plus a proof | refused |

**Moves behind `jobLiveness` in P1.** These are the sites that assume a
dead pane means a dead agent:

- `src/reconcile.ts:105-145`, the ghost prune;
- `src/agents/close.ts:546-568`, the row rule;
- `src/agents/spawn-rollback.ts`;
- `src/agents/spawn-ready.ts`;
- `src/agents/lease-carrier.ts:265-297`;
- `src/workstream.ts:566,590`, teardown;
- `src/hosts.ts:706-716`, `probeAttached`;
- `src/agents/gate.ts:133`;
- `src/remote-agent.ts:667`, `localPaneAlive`;
- the liveness merge in `src/channels/dispatch.ts:115-139`;
- the dropped-watch fallback in `src/channels/ctl.ts:222-224`.

`runStop`, the job handshake and the lease reattach move behind the
`lease` kind. The reservation's SQL stays mu's.

**Missing from the sketch:**

- `lookup(key)`;
- where the handle comes from (`JobStart.handle`);
- `identity`, the stop fence;
- the view capability;
- the gate kind;
- stop's contract: idempotent, a hand-back typed, and the row never
  deleted by the kind;
- the settle mode the reaper needs (D1).

**Not on the job record:**

- `tree_path` and `tree_agent_id`: the worktree pointer, which belongs to
  the host side;
- `workstream_id`: a generation stamp;
- `creator_pid` and `creator_start`: they belong to the reservation, not
  to the job.

They stay columns of `carrier_jobs`; the seam does not carry them.

**Second implementation:** mule (P7), the `lease` kind with `lookup`.
After it, a plugin kind with `detached` views and `handle.from = reply`
for session-hosted agents.

### D9. Seam: agent channel, an open registry

`AgentChannel` (`src/channels/types.ts:143-185`) and `ChannelDelivery`
(`:356`) stay the seam. They change as follows:

```ts
// src/channels/types.ts
/** Registered channel names. Unknown stored names are an error, never a derived fallback. */
export type ChannelName = string & { readonly __channel: unique symbol };

export interface ChannelCaps {
  fence: "sync" | "two-phase" | "none";
  receipt: "exact" | "acknowledged" | "none";
  /** A repeated delivery with the same msgId is a no-op. All three built-ins: false. */
  dedupe: boolean;
  steer: boolean;
  interrupt: "exact" | "unconfirmed" | "none";
  fresh: "in-place" | "new-job" | "none";
  answer: boolean;
  command: boolean;
  watch: "stream" | "poll";
  /** Whether lastRun's text is the settled turn's own (a CLOSE block needs "tied"). */
  settleText: "tied" | "untied" | "none";
}

export interface AgentChannel extends ChannelDelivery {
  readonly name: ChannelName;
  /** Replaces `readonly fence: boolean`. */
  readonly caps: ChannelCaps;
  // readStates, watch, baseline, receipt and lastRun keep their signatures.
  /** Did the delivery journaled under `msgId` land? Never resends; never throws. */
  reconcile(target: ChannelTarget, intent: { msgId: string; baseline?: RunBaseline }): Promise<"accepted" | "not-accepted" | "unknown">;
}

/** Every delivery result names its channel, its acknowledgement and the turn a wait counts from. */
export type SendResult = {
  channel: ChannelName;
  ack: "exact" | "confirmed" | "sent" | "unknown";
  baseline?: RunBaseline;
  msgId?: string;
  // The per-channel detail fields stay, optional.
};

/** Renamed from CtlGuard. A channel whose caps.fence is "none" refuses a guard. */
export interface WriteGuard {
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeWrite?: () => boolean;
}

export function registerChannel(channel: AgentChannel): void;
```

**Built-ins and their capabilities** (the matrix the contract suite
asserts, extending `test/channel-contract.test.ts:118-142`):

| Capability | `ctl` | `hooks` | `mux` |
| --- | --- | --- | --- |
| fence | `sync` (`src/ctl/client.ts:166-180`) | `none` (`src/channels/hooks.ts:221`) | `none` (`src/channels/mux.ts:29`) |
| receipt | `exact`: `status {msgId}`; the last 64 are kept (`src/ctl/protocol.ts:116`) | `acknowledged`: `run_count` past a baseline | `none` |
| dedupe | false: the extension does not dedupe (`src/wait-actions.ts:32`) | false | false |
| steer | true | false (`src/channels/hooks.ts:262`) | false |
| interrupt | `exact` | `unconfirmed` (per harness: claude reads `idle?`) | `none` |
| fresh | `in-place` | `in-place` (refused remote) | `none` |
| answer, command | false, true | true, true (both by paste or keys) | true, true |
| watch | `stream` | `stream`, a poll loop inside the channel (`src/channels/hooks.ts:693`) | `poll` (`watch` returns undefined) |
| settleText | `tied` | `tied` or `untied` per murmur | `none` |

**What moves in P4:**

- `agentChannel` becomes a registry lookup. Today it is an exhaustive
  ternary (`src/channels/dispatch.ts:63-66`).
- `readChannelStates` groups agents by channel and calls each one's
  `readStates`. Today it hardwires ctl first and mux for the rest
  (`:115-139`). Liveness for an agent whose channel cannot answer comes
  from `jobLiveness` (P1), not from a mux reading.
- `markQueued` reads a capability, not `!== "ctl"` (`:100`).
- Delivery results carry `ack` and `baseline`, so these sites stop
  recomputing a wait's run baseline by channel name:
  - `src/cli/wait-arm.ts:97-106`;
  - `src/cli/agent-send.ts:217`;
  - `src/agents/task-spawn.ts:666`.
- Replay calls `reconcile` instead of branching on the transport (the
  code at `src/agents/task-spawn.ts:717-720` and `src/next.ts:584`).
- Name branches outside `src/channels/` become capability checks, for
  example:
  - the steer hint (`src/messages.ts:241-244`);
  - the answer hint (`:199-202`);
  - the CLOSE trust rule (`src/close-block.ts:219`);
  - the stall grace (`src/wait.ts:781`);
  - the rewatch (`src/wait-latch.ts:86`).
- `StateSource` (`src/agent-state.ts:12`) gains an `exact` flag in place of
  its `source === "ctl"` tests.

**Missing from the sketch:**

- `reconcile`;
- the normalised `ack` and `baseline`;
- `dedupe`, because a persisted key alone is not idempotence;
- `settleText`;
- `answer` and `command`;
- the turn states `unknown`, `idle?`, `queued` and pending;
- `RemoteReader` over the link.

**D4 of the every-harness spec is amended.** It kept "the lease carrier
and the remote socket plumbing" on ctl directly. The dropped-watch fallback
that reads "control socket lost; the pane is alive" (`src/channels/ctl.ts:222-224`)
now asks `jobLiveness`.

**Second implementation:** a plugin channel for session-hosted agents.
`ctl`, `hooks` and `mux` stay in process, as peers of plugin channels.

### D10. Lifecycle policies, not a plugin seam

The sketch made `onSettle`, `beforeDeadline` and `onRelease` plugin hooks.
What they would trigger are mu's own effects: collect, which is networked
but idempotent, and close, which is destructive. Plugin code would only
decide when to run them, and the host facts already decide that. Letting a
plugin trigger a close would let it cause a mu effect, breaking principle
2. So they are mu-owned policies, chosen by host facts:

```ts
// src/lifecycle.ts
export type LifecycleEvent =
  | { kind: "turn-settled"; agent: AgentRow; host: HostView }
  | { kind: "deadline-near"; host: HostView; remainingMs: number };

export type LifecycleAction =
  /** Run by mu at once, through `mu agent collect`'s own compare-and-set. */
  | { kind: "collect"; agent: AgentRow }
  /** Shown as a wait event or notice with `next`; never run. */
  | { kind: "notice"; text: string; next: string[] };

export interface LifecyclePolicy {
  readonly name: "collect-at-settle" | "deadline-notice";
  applies(host: HostView): boolean;
  react(db: Db, event: LifecycleEvent): LifecycleAction[];
}
```

- **`collect-at-settle`** applies to a host with `idleReclaimMs`. When
  `mu wait` observes a remote worker's turn settle, it runs the worker's
  collect before it returns the settle. A failed collect is a warning on
  the result, never a lost settle.
- **`deadline-notice`** applies to a host with `deadlineAt`. When the
  remaining time is under `MU_HOST_DEADLINE_MARGIN_MS` (P5 picks the
  default), three things happen:
  - spawns on the host are refused (`HostDeadlineError`);
  - `mu wait` fires an urgent `deadline` event naming the host and its
    agents;
  - `mu state` shows a notice whose `next` lists each agent's collect and
    close.

  mu never closes an agent on its own.
- **Release** is `mu host release` under the D1 guard, not a hook.

The triggers are the invocations that already read these facts: `mu wait`,
`mu next`, `mu state` and spawn. There is no timer and no background
process (VISION constraint 4). Static hosts carry no facts, so no policy
applies to them, and today's behaviour stands.

### D11. Seam: host checks (doctor steps)

```ts
// src/host-checks.ts
/** Widened from the closed union at src/hosts.ts:956-969. Plugin steps are named `<plugin>:<step>`. */
export interface HostCheckStep {
  step: string;
  ok: boolean | null;
  detail: string;
}

export interface HostChecks {
  readonly name: string;
  steps(host: HostView, call: Call): Promise<HostCheckStep[]>;
}
```

`checkHost` (`src/hosts.ts:1018`) composes the steps under one channel, in
today's order:

- the link's: `reachable`, `repo`;
- the job kind's: `shell`, `stop`, `attach`, `job`;
- the channels': `pi`, `extension`, `ctl`, `hooks`;
- the harness probe: `harnesses`.

A `handback` step still skips the rest. `mu doctor` keeps its `lease-job`
hint (`src/cli/doctor.ts:399`), now read through the job kind, and gains a
`plugins` section in P6: each registration's path, protocol and last
handshake.

**Second implementation:** mule's steps (P7), its master and forward
checks, replacing the lease template's expand-only `shell`, `stop` and
`attach` steps.

### D12. Capabilities

A capability is declared once, at the handshake for a plugin or in code for
a built-in. The contract suite checks that the implementation behaves as
declared. Each capability has an enforcement point in mu's verbs:

| Capability | Meaning | Enforced where |
| --- | --- | --- |
| channel `fence` | `sync`: an in-process veto immediately before the one write. `two-phase`: prepare writes nothing; commit is the one write (D13). `none`: no veto. | Every caller that passes a write guard: the steer (`src/wait-actions.ts:446-474`) and the close notice. With `none` it refuses before any write, as `src/channels/mux.ts:29` and `src/channels/hooks.ts:221` do today. |
| channel `receipt` | `exact`: answers by msgId. `acknowledged`: answers by a turn past the journaled baseline. `none`: cannot answer. | spawn replay and `mu next` recovery through `reconcile`. `mu agent check` refuses `none`. |
| channel `dedupe` | a repeat with the same msgId is a no-op | the D4 retry rule: no delivery is ever resent without it |
| channel `steer` | input can join a running turn | `send --steer`, `--on-stall steer`, the `mu next` steer executor. The typed refusal names the channel (`src/channels/hooks.ts:262`). |
| channel `interrupt` | `exact`: the abort is confirmed. `unconfirmed`: the agent reads `idle?` until its next event. | `send --interrupt` and abort. `none` refuses. |
| channel `fresh` | `in-place`: a new session in the same job, a new channel incarnation. `new-job`: the backend's fresh starts a job. | `send --fresh` refuses `new-job` and `none` with a typed error naming close then spawn. That keeps the wait cursor key (D1). |
| channel `answer`, `command` | keys reach a pending dialog; session commands run | `agent answer`, the session commands |
| channel `watch` | `stream`: `watch` returns one watch that settles when the turn ends, however the channel learns it. `poll`: `watch` returns undefined and mu polls `readStates`. | `mu wait`'s watch path (`src/wait-ctl.ts`) |
| channel `settleText` | the last text is the settled turn's own | CLOSE blocks apply only with `tied` (`src/close-block.ts:219`) |
| job `view` | `bound`: the view's death ends the job. `detached`: the job outlives it. | reconcile, the reaper, close, teardown and `mu wait` through `jobLiveness` |
| job `lookup` | answers which handle a key started | at load: a kind with `handle.from = reply` without it is refused. Also the empty-reservation path. |
| link `fetch` | brings a commit home | `agent collect`: false falls back to the profile's fetch template, and refuses when the host has none |
| link `maxScriptBytes` | the largest `exec` script | the remote brief file and every worktree script, before the call |
| link `slots` | who counts connection slots | `admit` runs only for `"mu"` |
| host `deadlineAt`, `idleReclaimMs`, `maxJobs` | provider facts | spawn's admission (`maxJobs`, the deadline margin) and the lifecycle policies (D10) |

### D13. The plugin protocol

**Transport layer.**

- JSON-RPC 2.0, one JSON object per line on the plugin's stdin and stdout,
  UTF-8, at most 1 MiB per message.
- stderr is drained into a bounded buffer and never parsed. Its first line
  may appear in an error message, and it is never stored.
- The framing and validation are hand-rolled, like `src/ctl/protocol.ts`.
  No dependency is added.

**Process.**

- mu starts the plugin the first time an invocation needs it. The plugin is
  mu's child, in its own process group, and lives only as long as that mu
  invocation.
- At exit mu sends `shutdown`. After `HOST_GRACE_MS` (`src/hosts.ts:888`)
  it kills the group.
- A plugin never daemonizes and leaves no process behind. The contract
  suite checks that its group is empty after `shutdown`.
- When the link declares `slots: "mu"`, the plugin's group is the one
  recorded on the host channel row (`src/hosts.ts:857`).

**Handshake.**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"mu":"4.6.0","seams":["link","job","checks"]}}
{"jsonrpc":"2.0","id":1,"result":{"protocol":1,"plugin":{"name":"mule","version":"0.5.0"},"instance":"9f2c…","schema":"sha256:…","seams":{"link":{"fetch":false,"maxScriptBytes":131072,"slots":"self"},"job":{"kind":"lease","view":"bound","lookup":true},"checks":{}}}}
```

Several mismatches refuse at load with `PluginRefusedError` (exit 4), and
nothing runs:

- a protocol range with no overlap;
- a seam the registration needs but the plugin does not implement;
- a missing mandatory method (`status`; `lookup` where D8 requires it);
- a schema digest that does not match the protocol version.

`instance` names the backend configuration the plugin addresses. mu
records it with every handle as the stop fence, as `host_stop` is today. A
stop or release whose recorded instance differs from the current one
refuses with `stop-changed`. A plugin upgrade inside one protocol version
keeps live jobs stoppable.

**Methods.** These mirror D6–D11, one to one:

- `host.acquire`, `host.lookup`, `host.status`, `host.release`;
- `link.fingerprint`, `link.exec`, `link.fetch`;
- `job.identity`, `job.start`, `job.lookup`, `job.status`, `job.stop`,
  `job.attach`;
- `channel.readStates`, `channel.watch`, `channel.baseline`,
  `channel.receipt`, `channel.reconcile`, `channel.lastRun`,
  `channel.prepare`, `channel.commit`, `channel.abandon`,
  `channel.interrupt`, `channel.abort`, `channel.answer`,
  `channel.command`;
- `checks.steps`.

Every effect method's params carry `key`. Every call carries `deadline`.

**Timeouts and cancellation.**

- mu enforces each call's deadline locally. Defaults: `link.exec` takes
  the caller's `timeoutMs`, else `HOST_COMMAND_TIMEOUT_MS` (20 s,
  `src/hosts.ts:885`). Reads take 10 s. `host.acquire` takes 10 min.
  `channel.watch` has no deadline of its own; `mu wait --timeout` bounds
  it.
- On expiry or SIGINT, mu sends the `$/cancel {id}` notification, waits
  `HOST_GRACE_MS`, then kills the group.
- A cancelled read is `unknown`. A cancelled effect is `unknown-outcome`
  (D4).

**Typed errors.** Every JSON-RPC error carries `data.kind`:

| `kind` | Means | mu does |
| --- | --- | --- |
| `retryable` | nothing happened; trying again may work | retries with the same key, at most three times, for a method that declares key dedupe; otherwise surfaces it (exit 5) |
| `permanent` | nothing happened; trying again will not work | surfaces it, exit 5 (the "remote host" lane, `src/cli/handle.ts:690-691`) |
| `human` | a person must act (`data.remedy`) | `HostHandbackError`, exit 5 (`src/cli/handle.ts:693-695`); never retried, never recorded as `human-needed` |
| `unknown-outcome` | the effect may have happened | leaves the intent; `EffectOutcomeUnknownError`, exit 1 (the lane of delivery unknown, `src/cli/handle.ts:616-618`); the next touch asks |

A malformed message, an unknown method or a reply that fails validation
counts as `unknown-outcome` for an effect and `unknown` for a read. The
plugin is then marked broken for the rest of the invocation.

**Streaming watch.**

1. `channel.watch {target, afterRuns?, inc?}` returns `{watchId, initial, afterRuns?}`.
2. The plugin later sends one notification: `watch/settled {watchId, observation}`
   or `watch/restarted {watchId, incarnation}`. The latter is today's
   fatal rejection of `settled`.
3. mu ends a watch with `$/cancel`. The answer is then `unknown`, never
   dead.

A watch lives only inside the one mu invocation that asked, like ctl's
blocking `wait` (VISION constraint 4).

**The two-phase write fence.** Today's write fence is a synchronous SQLite
compare-and-set that runs immediately before ctl's single write
(`src/ctl/client.ts:166-180`; the steer's `beforeWrite`,
`src/wait-actions.ts:446-463`). A remote process cannot hold that window,
so a plugin channel with `fence: "two-phase"` splits the write:

1. `channel.prepare {msgId, expectIncarnation?, text, mode}`. The plugin
   connects, binds and checks. It writes nothing.
2. mu runs the guard's compare-and-set in process. If it says no, mu sends
   `channel.abandon {msgId}`. Nothing was written, so the receipt row stays
   `reserved` (`src/wait-actions.ts:38-40`).
3. `channel.commit {msgId}` is the one write. From here any failure is
   `unknown-outcome`, and recovery goes through `reconcile`.

mu cannot prove that `prepare` wrote nothing. That is a **trust
assumption**, and the contract suite tests it with a fake backend that
counts writes. A plugin that cannot split its write declares `fence: "none"`.

**Schema publication.**

- The protocol is published as `docs/reference/plugin-protocol.md`, the
  normative prose, plus `schemas/plugin-protocol-v1.json`, which ships in
  the package's `files`.
- mu's hand-written narrowers and the JSON Schema are checked against the
  same fixture messages (`test/plugin-schema.test.ts`), so neither can
  drift alone.
- The protocol version rises only on an incompatible change. An additive
  field rises nothing.
- Skew tests run the fake plugin speaking protocol 0, 1 and 2 against mu
  (`test/plugin-skew.test.ts`). A plugin built against an older mu runs the
  newer contract suite in CI.

### D14. Registration, trust, env and secrets

**User-configured, never discovered.**

- `mu plugin add <name> <absolute path>` records a plugin. Its basename
  must be `mu-plugin-<name>`.
- `add` runs the handshake once and stores the `plugins` row.
- `mu plugin list` and `mu plugin rm` complete the set. `rm` refuses while
  any host, profile, job record or agent names the plugin.
- A profile or host names its plugin explicitly: `mu host add … --plugin <name>`
  or `mu host acquire … --provider <name>`.

mu never scans `PATH`, a directory or a package for plugins. This is not a
config file: registrations are machine-local rows made by a verb, like host
profiles.

**Trust.** A plugin runs with the user's privileges, as a host template
does today. mu refuses:

- a path that is not absolute;
- a file that is group- or world-writable, or not owned by the user;
- a symlink to either.

mu does not hash the binary. Upgrades are expected, and `instance` is the
fence that matters (D13).

**Env.**

- The plugin process gets mu's environment minus `LOCAL_ONLY_ENV`
  (`src/remote-agent.ts:573`) and every `MU_DB_PATH`, `MU_STATE_DIR` and
  `MU_SYNC_DIR`. It has no path to mu's DB or state, and needs none.
- An agent's env crosses the protocol as a structured map, restricted to
  `HOST_ENV_KEYS` (`src/hosts.ts:392-400`), seven keys; the header comment
  that says "five" (`:40`) is fixed in P2. mu refuses any other key before
  the call, as `hostEnvWords` does today (`:408`).
- Nothing crosses as shell words.

**Secrets.**

- mu stores only typed reply fields:
  - handles, `JOB_HANDLE_RE`-shaped (`src/hosts.ts:206`);
  - keys, states and facts;
  - the instance.
- Free text (`message`, `detail`, `remedy`) is shown in error lines, first
  line only, capped at 400 characters. Where today's code already stores a
  reason (`carrier_jobs.reason`), it is stored there.
- Request bodies are never logged. Plugin authors must put no secret in a
  message.
- The contract suite fails a plugin that echoes an env value it was given
  into any reply field.

### D15. mule, the first out-of-process plugin

mule is already an external executable that mu drives through templates
(`src/hosts.ts:324-337`). mu reads none of its exit codes and uses only
pane liveness (`mule/SPEC.md:102`). It implements the link, the `lease`
job kind and host checks. It is not a host provider, because it never
opens or provisions machines (`mule/SPEC.md:505`).

What mule already guarantees:

- **An idempotent, proving stop.** `rm <id>` exits 0 only on proof that the
  sessions and the state directory are gone, and a missing job also exits 0
  (`mule/SPEC.md:366`).
- **A write-ahead handle.** The id is written to the job file before
  dispatch (`mule/src/lease.rs:329`).
- **An attach that never replaces the job file** (`mule/src/lease.rs:381`).

**The four gaps.** No shim can close these; mule must change:

| Gap | Today | mule adds (P7) |
| --- | --- | --- |
| A status mu can trust | `poll --json` answers running, done or orphan (`mule/src/cli.rs:742,799-803`). A missing job is exit 1, the same code as any probe failure. The probe uses `has-session` and `[ -d ]` (`mule/src/probe.rs:89-90`), which mule's own spec says confuse a protocol mismatch with absence (`mule/SPEC.md:366`). | `poll --json` answers `missing` and `unknown` with exit 0, using `rm`'s proven-absence checks |
| A caller key | ids are generated (`mule/src/wrapper.rs:294`) and caller names are rejected (`mule/SPEC.md:517`). A re-dispatch is not idempotent. | `run --lease --key K`: K is stored as `$d/key`, and a dispatch whose key exists returns that job. The key is not a name: the id stays generated, so mule's reason for rejecting caller names still holds. |
| Listing mu's own jobs | there is no local index (`mule/SPEC.md:521`). `--human` strips `MU_AGENT_NAME` (`mule/src/wrapper.rs:108-109`). | `ls --json --key-prefix P` and a `key` field in the JSON output. The remote directory stays the only record. |
| Host lifecycle | mule never opens a master or provisions a host (`mule/SPEC.md:505`) | nothing. mule reports facts: `host info --json` with `master: false` becomes a `needs-human` check step with its `remedy`. Static profiles stay the provider. |

**What a shim can do**, so the plugin can be a thin `mule plugin`
subcommand that reuses mule's `Transport`, probe and remove code:

- `job.stop` maps to `rm`;
- `job.attach` maps to `run --lease --attach`;
- `link.exec` maps to `mule exec`, with exit 7 mapped to `partial`;
- exit 3 maps to `human`;
- the master check maps to `host info --json`.

mule is not a daemon (`mule/SPEC.md:547`). The plugin process is mu's
child for one invocation and never supervises, retries a dispatch or
watches.

**Capabilities mule declares:**

- link `fetch: false`, because bulk transfer may not ride its connection
  (`mule/SPEC.md:541`), so the profile's `fetch` template stays;
- link `slots: "self"`;
- job `view: "bound"` and `lookup: true`.

A `detached` lease, where a pane's death detaches the job instead of
stopping it, is not in this spec. It would need mule's signal path to
change, and that is mule's decision.

**Profile migration.**

- `mu host add <h> --plugin mule` keeps the templates `hostMuleStarter`
  prints, so a released build still works with the profile (D5).
- A reservation recorded before the plugin was used has a `host_stop`
  equal to the profile's `stop`. The plugin stops it: `mule rm` on the same
  handle, the same effect.
- A profile generator that rewrites profiles with `mu host rm`/`add` keeps
  working as long as it writes the same templates. The byte fence is
  unchanged (`src/carrier-stop.ts:88,97`).

### D16. Proof: contract suites and fault injection

**One contract suite per seam**, run against every implementation:

| Suite | Built-ins | Plugins |
| --- | --- | --- |
| `test/host-provider-contract.test.ts` | `static` | the fake plugin. A private provider runs it in its own CI. |
| `test/link-contract.test.ts` | `template` over `test/_fake-remote-node.ts` | the fake plugin; mule (P7, in mule's CI against a test host) |
| `test/job-contract.test.ts` | `pane`, `lease` (over `test/_carrier.ts`), `gate` | the fake plugin (`bound` and `detached`); mule |
| `test/channel-contract.test.ts` (extended) | `ctl`, `hooks`, `mux`, pi on `hooks` | the fake plugin (`two-phase`, `stream`) |
| `test/host-checks-contract.test.ts` | template plus the built-in kinds | the fake plugin; mule |

Each suite asserts the declared capabilities:

- what each one promises;
- that a refusal is typed;
- that `status` and `lookup` never throw for "cannot tell";
- the idempotence a kind declares.

The fake plugin (`test/_fake-plugin.mjs`) is a real executable that speaks
the protocol over stdio, backed by a JSON file. It can be told to fail at
any fault point. The suites are exported (`@mu-crew/mu/contract`), so an
out-of-tree plugin runs exactly the same assertions.

**Fault injection.** `test/plugin-faults.test.ts` drives the fake plugin
and the built-ins through each point. The pass criterion is the same at
every point: replay yields exactly one effect, and reconcile converges.

| Point | Injected | Must hold |
| --- | --- | --- |
| F1 | mu killed after the intent commits, before the call | the next touch asks; `lookup` finds nothing; one start on retry |
| F2 | the plugin killed mid-call | `unknown-outcome`; nothing resent; `lookup` decides |
| F3 | mu killed after the plugin applied the effect, before the reply is recorded | `lookup` finds the handle; it is recorded; no second effect |
| F4 | the reply is lost (stdout closed) | as F3 |
| F5 | timeout, then a late reply | `$/cancel`; the group is killed; `unknown-outcome`; the late reply is ignored |
| F6 | `retryable` twice, then success | one effect under one key |
| F7 | `prepare` succeeds, the guard vetoes | `abandon`; the backend counted no write; the receipt stays `reserved` |
| F8 | mu killed between `commit` and its reply | `reconcile` answers; never resent |
| F9 | the plugin replaced between start and stop with a different `instance` | the stop refuses `stop-changed` |
| F10 | the host is `gone` during close | the job reads `lost`; the release waits for close or abandon |

The crash points between mu's steps are seeded the way
`test/spawn-receipts.test.ts:582` ("a receipt left in each stage") seeds
them today: the journal is written in the intermediate state and the next
verb is run. A crash inside the plugin is a SIGKILL of the fake plugin's
group.

### D17. The pledge amendment

The user approved amending ROADMAP's plugin-runtime pledge
(`docs/ROADMAP.md:37`) and VISION's "no plugin system" (`docs/VISION.md:184`)
on 2026-11-07. Both are amended in this commit.

**What changed.** mu may drive an external executable over a versioned
stdio protocol, for exactly five seams: host provider, link, job kind,
agent channel and host checks.

**Still refused:**

- discovery of any kind;
- loading third-party code into mu's process;
- a resident plugin host or daemon;
- plugins that add verbs, flags, tables, wait events or op kinds;
- plugins that write mu's DB or state;
- RPC into mu;
- a verb registry.

VISION's idempotency gap (`docs/VISION.md:359`) and constraint 4 are not
amended here. P6 amends the first once plugin effects carry keys. A
plugin's watch fits constraint 4 as written: it is a child's stdout inside
one invocation.

## Units

Each mu unit is under about a week. It ends green on the fast gate and the
targeted slow gate for its area, and its "Accepted when" can fail. P1–P5
change no behaviour: the tests that pin today's behaviour keep their
assertions, though their import paths may change. Each unit adds its
ARCHITECTURE row, VOCABULARY changes and CHANGELOG entry.

The order follows the surveys' blast-radius analysis:

1. Job liveness is the largest change, and channels and hosts depend on it
   (a channel must not reimplement a pane check).
2. The link wraps the single choke point, `runLeasedTemplate`, before the
   host provider wraps `getHost`.
3. The channel registry needs job liveness for its fallback.
4. Policies and checks need the host facts and the link.
5. The protocol comes last, when every seam has a built-in behind it.

| Unit | Content | Accepted when | Pinned by |
| --- | --- | --- | --- |
| P1 | Job liveness. The `src/jobs/` cluster: `JobKind`, the `pane`, `lease` and `gate` kinds, `jobLiveness`. Every D8 site reads liveness through it. `runStop`, the job handshake and the lease reattach go behind the `lease` kind. No schema change. | `test/job-imports.test.ts` proves no listed site calls `paneAlive`, `paneUp` or `localPaneAlive` directly. `test/job-contract.test.ts` passes against `pane`, `lease` and `gate`. Every pinning test passes with its assertions unchanged. | `reconcile.integration`, `reconcile-race`, `close-proof.integration`, `close-unknown-probe`, `wait-dead-after-reap`, `agent-reaper-transactional`, `workstream-teardown-*` (6), `host-channels`, `lease-spawn`(+`.integration`), `lease-close`, `lease-reattach`(+`.integration`), `reap-lease-park`, `remote-gates`(+`.integration`) |
| P2 | Link and the worktree contract. Rename `Transport` to `SendChannel`. `HostLink` with the `template` built-in. Every `runLeasedTemplate`/`runHostTemplate` caller outside `hosts.ts` goes through it. `RemoteReader` goes over the link. `remote-worktree.ts` is split out of `remote-agent.ts`. Fix the stale comments `src/hosts.ts:40,1274`. | An import test proves only the link module calls `runLeasedTemplate`. `test/link-contract.test.ts` passes against `template`. The remote tests are unchanged. `remote-agent.ts` is under 400 lines. | `host-channels`, `host-handback`, `host-profiles`, `host-check-lease`, `host-check.integration`, `hooks-remote`, `remote-gates`, `remote-task-brief`, `remote-spawn`(+`.integration`), `remote-prepare-lost.integration`, `remote-recovery`, `remote-recovery-close`(+`.integration`), `remote-collect`(+`.integration`) |
| P3 | Host provider. `HostProvider`, `HostView`, `resolveHost`, the `static` built-in. Every remote-path host read goes through it, including `reattach-check.ts`. | `test/host-provider-contract.test.ts` passes against `static`. An import test proves no file outside `hosts.ts`, `host-provider.ts` and `cli/host.ts` calls `getHost` or reads `host_profiles`. The pinning tests are unchanged. | `host-profiles`, `host-lease-profile`, `lease-spawn`, `lease-reattach`, `remote-spawn`, `remote-recovery`, `host-harnesses` |
| P4 | Open channel registry. `ChannelCaps` replaces `fence`; `reconcile`; the normalised `ack` and `baseline`; the registry lookup; `readChannelStates` per channel with `jobLiveness` as the fallback; name branches become capability checks; "fence" in the run baseline sense is renamed. `spawn_receipts` is untouched. | `test/channel-contract.test.ts` asserts the D9 matrix for every built-in, pi on `hooks` included. `test/channel-imports.test.ts` fails on any `=== "ctl" \| "hooks" \| "mux"` outside `src/channels/`. Replay goes through `reconcile` with unchanged results. | `channel-contract`, `channel-imports`, `wait-action-steer`, `wait-action-receipts`, `wait-action-transport`, `close-notice`, `spawn-receipts`(+`-mux`, `.integration`), `channel-hooks-verbs`, `hooks-remote`, `next-recover` |
| P5 | Lifecycle policies and host checks. `LifecyclePolicy` with `collect-at-settle` and `deadline-notice`, both inert on static hosts. `HostChecks`, with `checkHost` composed from the link, job kind and channel steps. | `host check` output is byte-identical on the fixtures. `test/lifecycle-policy.test.ts` drives both policies against an in-process fake provider host: one collect per settle, a refused spawn inside the margin, a `deadline` wait event, and never a close. | `host-check-lease`, `host-check.integration`, `lease-job-doctor`, `host-harnesses` |
| P6 | Plugins: the behaviour change, in two commits. **6a:** the protocol, the process manager, the adapter for link, job kind and checks; `plugins`; `mu plugin add`/`list`/`rm`; the profile `--plugin` column; the `carrier_jobs` columns; the fake plugin; the schema and its doc. **6b:** the provider adapter, `hosts`, `mu host acquire`/`drain`/`release`; the channel adapter (two-phase, stream, `reconcile`) and `spawn_receipts.channel`; fault injection; the doctor `plugins` section; the `docs/VISION.md:359` amendment. | Every D16 suite passes against the built-ins and the fake plugin. `test/plugin-faults.test.ts` passes F1–F10. `test/plugin-skew.test.ts` and `test/plugin-schema.test.ts` pass. `scripts/skew-released.sh` (slow gate) installs the latest released mu in a temp prefix, opens a fixture DB holding plugin rows, and asserts: `openDb` succeeds, no plugin agent is reaped while its view lives, a stop refuses, a replay stays unknown, and the file stays v13. With no plugin registered, the full suite is unchanged. | the above, plus `db`, `entities`, `loop-storage` (`test/fixtures/v13-populated.db.gz`), `rebuild`, `carrier-jobs`, `leftovers`, `acceptance.integration` |
| P7 | mule as a plugin, in the mule repo. `run --lease --key`; the four-state `poll --json`; `ls --json --key-prefix` and the `key` field; `mule plugin` serving the link, the `lease` kind and checks. In mu: the `hostMuleStarter` output gains `--plugin mule`. | `cargo test` passes. mu's exported link, job and host-checks suites pass against `mule plugin` on a test host. Kill the mu spawn between intent and handle, and `lookup(token)` recovers the job with one dispatch. A reservation made under the template is stopped by the plugin. | mule's own tests; mu's `scripts/smoke-lease.sh` against a test host, with the plugin registered |

P6 is the one unit at the size limit, so it lands as two commits (6a,
6b), each green. P1–P6 release together: P3 and P5 open seams whose
second implementation arrives only in P6 ([open question 1](#open-questions)).

## Risks

- **Polling cost.** `mu wait` reconciles on every poll (`src/cli/wait.ts:146`).
  For a detached job, `status` is a backend round trip per tick per job.
  Mitigations:
  - a status younger than the poll interval is reused, as the remote
    reader does (`src/channels/types.ts:104-115`, `maxAgeMs`);
  - `watch: stream` channels avoid the poll.
- **The two-phase fence is trusted, not proven.** A plugin that writes in
  `prepare` breaks steer's at-most-once. The fake-backend test catches it
  only for the fake. Declaring `fence: "none"` is always allowed.
- **Released builds and plugin rows.** D5's table rests on how released
  code behaves today. `scripts/skew-released.sh` is the check; it runs in
  the slow gate, against each new release.
- **Pane-id reuse.** Teardown relies on tmux never reusing a pane id
  (`src/workstream.ts:583`). Plugin handles carry no such guarantee, so
  every job-record write stays keyed by its token.
- **`carrier_jobs` holds non-carrier jobs** until the next major. The table
  name misleads; VOCABULARY's **job record** row says so.
- **SDK exports.** `src/index.ts` exports the host functions P2 and P3
  move (`runHostTemplate`, `withHostChannel`, `closeRemoteWorktree`, the
  channel admission calls). Each unit keeps or renames them in one
  commit, and its CHANGELOG entry says which; no forwarding wrappers.
- **The deadline margin is a guess.** A collect slower than the margin
  loses the last commits on a host that is reclaimed. The `deadline` event
  is urgent so that an orchestrator acts early.

## Open questions

Only a human can decide these.

1. **Release granularity.** P3 (host provider) and D10's policies have one
   in-tree implementation each. Their second is an out-of-tree provider
   plugin. Is a private plugin run by a real user enough to meet "two real
   implementations", and do P1–P6 ship together as one minor?
2. **Registration surface.** Is `mu plugin add` (a verb that writes a
   machine-local row) acceptable, or must registration be an env var
   (`MU_PLUGINS=name=/abs/path,…`) to keep the "no config file" pledge
   literal?
3. **The mandatory view pane.** Is one local pane per session-hosted agent,
   read-only, an acceptable cost for keeping `agents.pane_id` and the
   released-build safety (D3, D5)?
4. **Automatic collect at settle.** D10 runs a networked collect inside
   `mu wait` for hosts with idle reclaim. Is that within "mu's own process
   stays ssh-free" (`docs/ROADMAP.md:139-141`), given that it runs the
   operator's own template or plugin, as `mu agent collect` does?
5. **Static `host rm` under a running lease job.** Keep today's behaviour,
   where the stop later refuses with `no-host`, or refuse the removal? The
   second is a behaviour change outside this spec's rule.
6. **mule's SPEC.** `--key`, the four-state `poll` and `--key-prefix`
   amend mule's "Let users choose job names" and "Store a local job index"
   decisions (`mule/SPEC.md:517,521`). That is mule's maintainer's call.
7. **A detached lease** (D15): whether mule should ever let a job outlive
   its pane.

## Out of scope

- An open `MuxBackend`, or any multiplexer plugin.
- Plugin verbs, plugin wait events, plugin tables.
- A provider or channel for any named vendor in this repo.
- The next-major rename of `carrier_jobs` to `jobs` and the state-dir move.
- Detached views for built-in job kinds.
- Placement across hosts (muzzle's host integration is its own spec).

## History

Draft 1, 2026-11-09. It started from a decision sketch written after a
private experiment showed that a provisioned machine stays up under a
dormant session while a child works. That sketch named three machines,
six seams, the plugin protocol and its proof.

Five read-only surveys tested the sketch against mu `42881032` and mule
0.4.0:

- job liveness;
- link and hosts;
- channels;
- mule;
- persistence and crash safety.

Each overruled the sketch somewhere; the table
[Where the surveys overrode the sketch](#where-the-surveys-overrode-the-sketch)
lists every case. Every file:line here was reopened at `42881032` while
writing.
