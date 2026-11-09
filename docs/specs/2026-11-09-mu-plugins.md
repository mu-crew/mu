# mu plugins: hosts, jobs, links, channels

Status: draft 2, written 2026-11-09. Not built. Draft 1 was refuted by
three reviewers (facts, correctness, plan), who raised 49 findings.
[Refutation round 1](#refutation-round-1) records how each was settled;
the sections below are written to those settlements. The spec covers mu
and, for one unit (P7), mule.

Draft 1 started from a short decision sketch: three state machines and six
seams. Five code surveys of mu at `42881032` and of mule 0.4.0 tested that
sketch. Where a survey contradicted it, the survey won
([Where the surveys overrode the sketch](#where-the-surveys-overrode-the-sketch)).

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
liveness. A host is a fixed template that never goes away. A crash between
an intent and its effect is handled case by case. A backend that cannot
say what state a job is in has no way to say so.

mu gets mu-owned state machines for hosts, jobs and turns, and one
TypeScript interface per seam. Today's code is re-expressed behind those
interfaces with its behaviour unchanged. External implementations
(**plugins**) speak a versioned JSON-RPC protocol over stdio, and mu drives
them through one built-in adapter. mule becomes the first plugin.

## Principles

1. **One interface per seam, two kinds of implementation.** Built-ins
   implement a seam in process. Plugins implement it through the adapter.
   If a built-in cannot live behind the interface, the interface is
   incomplete.
2. **mu owns the state machines; implementations report facts.** A plugin
   never writes mu's DB, its state directory or its log. Every effect
   returns facts, and mu records the transitions.
3. **Every effect mu may replay is written ahead and keyed.** mu records
   the intent on the subject's row and generates an idempotency key,
   persisting both before the call. After a crash, mu reconciles by
   asking, never by guessing. It resends only through a declared key
   dedupe (D4).
4. **Status is mandatory and truthful.** Every implementation answers
   "what is this host, job or turn now?". `unknown` is an honest answer.
   An outcome that is unknown is terminal until something asks and gets a
   definite answer.
5. **Capabilities have defined meanings and are enforced.** mu's verbs gate
   on declared capabilities. The contract suite checks that each
   implementation behaves as it declares.
6. **Behaviour is unchanged until the plugin units.** P1–P5 move code
   behind interfaces, and their tests keep their assertions. Only P6a–P6d
   add reachable behaviour. Even then, built-in hosts, jobs and channels
   keep behaving as they do today.
7. **A seam opens only where two real implementations need it.** A
   built-in plus a plugin that a real user runs counts as two. The
   contract suite's fake plugin does not count. Nothing gets an interface
   for one implementation. `MuxBackend` stays closed.

## Where the surveys overrode the sketch

| Sketch said | Code says | Chosen |
| --- | --- | --- |
| A Transport seam: `exec`, `fetch`, `push`, and a worktree contract | "transport" already names a profile's `session`/`lease` (`docs/VOCABULARY.md:251`, `src/hosts.ts:199`) and a channel alias (`src/agents/transport.ts:30`). `push` has no call site. mule forbids bulk transfer on its connection (`mule/SPEC.md:541`). | The seam is the **link**: `exec`, plus an optional `fetch`. There is no `push`. The worktree contract is mu's own scripts over `exec` (D7). |
| `start` returns a handle mu records | A lease carrier publishes its handle from inside mu's pane, through a file mu polls (`src/agents/lease-carrier.ts:248`) | The job kind declares where its handle comes from: the pane, a file, or the reply (D8). |
| Job states reserved, launching, running, stopped, lost, all persisted | ROADMAP rejects runtime agent state in `mu.db` (`docs/ROADMAP.md:146`) | mu persists only the transitions it makes. Liveness is asked at read time (D1). |
| Liveness belongs to the job, so the pane is only a view | mule ties a lease job to its pane by design: a signal stops the job (`mule/SPEC.md:102`). Every agent row needs a pane (`src/db.ts:1098`). | Every agent keeps a view pane in this version. A view is `bound` (built-ins and mule) or `detached` (plugin kinds only, P6d) (D3). |
| Two job built-ins, pane and lease | The command gate is a third job kind, with its own exit status and a retained pane (`src/agents/gate.ts:120-135`) | Three built-in job kinds: `pane`, `lease`, `gate`. The gate has no job record (D1, D8). |
| The idempotency key is passed to every effect | `carrier_jobs.token` is generated (`src/carrier-jobs.ts:125`) but never sent. The job file is named by (workstream, name) (`src/agents/lease-carrier.ts:118`). mule rejects caller-chosen ids (`mule/SPEC.md:517`). | Keys are sent from P6a on. `lookup(key)` or declared key dedupe is a seam requirement. mule gains `--key` in P7 (D4, D15). |
| `fence` is a remote callback | ctl's fence runs synchronously immediately before the one write (`src/ctl/client.ts:166-180`) | Plugin channels have no write fence in this version (D11). |
| `receipt` alone reconciles a delivery | The hooks journal reconciles by counting turns past a baseline (`src/agents/task-spawn.ts:717-720,744-760`) | A new `reconcile(intent)` on `AgentChannel`, with a turn-cause rule for backends whose turns start on their own (D4, D9). |
| `carrier_jobs` and `remote_recovery` merge into new job and host tables | Released binaries read `carrier_jobs` as the name fence (`src/agents.ts:416-424`). `remote_recovery` is filled by triggers on every delete path (`src/db-recovery.ts:76-100`). | `carrier_jobs` stays the job record and gains columns. `remote_recovery` and its triggers are unchanged, and recovery on a provider host is proven another way (D5). |
| Lifecycle hooks and doctor steps are plugin seams | Collect and close are mu's own effects. Host checks have one entry point (`src/hosts.ts:1018`). | Two mu-owned host policies, which are functions, not an interface (D10). Check steps are an optional method on the link and the job kind (D11). |
| Host provider `capacity()` | `max_sessions` counts connection slots, not jobs. A lease pane holds none (`src/agents/spawn-remote.ts:178,194`). | The link declares who counts connection slots. The provider reports job slots as a host fact, checked atomically at spawn (D6). |
| Run states idle, running, blocked, settled | Readings also carry `unknown` (`src/agent-state.ts:11`), unconfirmed idle, `queued` (`src/channels/dispatch.ts:94-110`) and pending messages. "run" already names the executor's charge (`docs/VOCABULARY.md:242`). | The machine is the **turn**, with all of those states (D1). |

## Decisions

### D1. The model: hosts, jobs and turns, owned by mu

Three state machines. mu alone moves them. Implementations report the
facts that move them.

#### Host

A machine that jobs run on.

- A **static host** is a host profile (`host_profiles`,
  `src/db.ts:1338-1349`). It is always `ready`, it has no host record, and
  `mu host add`/`rm` stay its whole lifecycle.
- A **provider host** has a host record (D5).

Provider host transitions:

| Transition | Triggered by | Persisted before the effect | Persisted after |
| --- | --- | --- | --- |
| → `acquiring` | `mu host acquire <name> --provider <p>` (P6c). It refuses a name that a profile or another record holds. | the record: name, provider, plugin instance, spec digest, a mu-generated key, the creator's pid and start time, `pending_op = acquire`. One immediate transaction. | — |
| `acquiring` → `ready` | the `acquire` reply; or, after a crash, the reconciler's `lookup` or deduped resend (D4) | — | handle, `deadline_at`, `idle_reclaim_ms`, `max_jobs`; pending cleared |
| `acquiring` → deleted | a `permanent` or `retryable` error (nothing happened); or `lookup` answers `none` under the D4 gate | — | an event in the log |
| `acquiring` stays | crash, timeout, `unknown-outcome`, `pending`, or `unknown` | — | nothing. Running `mu host acquire <name>` again resumes it: it asks under the same key and never acquires a second host. |
| `ready` → `draining` | `mu host drain`, or the deadline margin (D10) | `state` | — |
| `ready`/`draining` → `lost` | any host read whose `status` answers `gone` while mu has not released the host | — | `state`, `reason` |
| `draining`/`lost` → `releasing` | `mu host release`. Its immediate transaction proves that no agent row, job record or `remote_recovery` row names the host, then sets the state. A spawn's reservation re-checks `ready` in its own immediate transaction (D6), so neither can pass the other. | `pending_op = release`, key `<key>:release` | — |
| `releasing` → deleted | `release` returns, or `status` answers `gone` | — | an event in the log |
| any → deleted | `mu host release <name> --abandon`, a human decision, logged in one op group. It refuses while any agent row names the host. It deletes the job records and recovery records naming the host in the same transaction, because a host one abandons is gone, and so is its work. | — | the event names every dropped record |

**Name rule.** A provider host's name is referenced by rows only while its
record exists. Release requires no references, and abandon deletes them.
So a name that is released and acquired again never inherits stale rows.

#### Job

One agent's process. Each job has a **job kind** (D8):

- `pane`: today's local panes and remote `session` panes;
- `lease`: today's carrier;
- `gate`: a command gate, a foreground pane on a session profile.
  Lease profiles refuse gates (`src/agents/lease-carrier.ts:180-182`).
- one kind per job plugin.

A pane job or a gate job has no job record of its own. The agents row is
the record: its pane id is the handle, and a gate also has its
`gate_token`. Only a job that reserves today has a **job record**: a lease
(`src/agents/spawn.ts:501-504`), and from P6b a plugin job. The record is
a `carrier_jobs` row, today's **reservation** (`src/db-carrier.ts:23-43`).

| Transition | Triggered by | Persisted (today's code) |
| --- | --- | --- |
| → `reserved` | spawn, under the agent lock, before any effect (`src/agents/spawn.ts:503`, `src/agents/lease-carrier.ts:191`) | the row, an immutable token (`src/carrier-jobs.ts:114-125`), the host, and the stop identity. The row is the name fence (`src/agents/lease-carrier.ts:174`, `src/agents.ts:416-424`). |
| `reserved` → `launching` | spawn, just before the start effect (`src/agents/spawn.ts:842`) | `launch = 'intent'` (`src/carrier-jobs.ts:203`). From P6b, also the plugin's process-group id and start time. |
| `launching` → `started` | the job handshake (`src/agents/lease-carrier.ts:248`); a plugin's `start` reply; or, after a crash, the reconciler's `lookup` or deduped resend (D4) | the handle (`src/carrier-jobs.ts:265`), the view pane (`:210`), the agent (`:225`) |
| `reserved` → deleted | rollback while `launch` is still `none` (`src/agents/lease-carrier.ts:317`) | — |
| `launching` with no handle | the pane died first, the deadline passed, or the job file is invalid or unreadable (`src/agents/lease-carrier.ts:265-297`) | nothing: the row stays unknown (`describeEmptyReservation`, `:412-434`). From P6b, the D4 reconcile resolves it for a kind that declares `lookup` or dedupe. |
| `started`, no agent row | mu died after recording the handle but before the agent row; or a released build reaped the row (D5) | nothing new. This is today's lease-job **leftover**. `agent close` stops the job through its kind, and `agent reattach` opens a view (P6d for plugin kinds). |
| `started` → `stopping` | `agent close`. For a bound view, after the view proof (`src/agents/close.ts:546-568`). For a detached view, before the view is touched (D3). | new: `pending_op = stop`, key `<token>:stop` |
| `stopping` → deleted | `stop` proves the job gone, then the job file and tree are cleaned up (`src/agents/lease-carrier.ts:590`) | the settle mode the reaper reads. Stopped by mu or abandoned: the tasks reopen as todo. Ended on its own: they are parked (`src/agents/reap.ts:55-78`). |
| any → deleted | `agent close --abandon-job` (`src/agents/lease-carrier.ts:466`) | an event naming the handle |

**Two reads**, never stored and never confused:

- **View presence** asks whether the pane exists: reconcile's `listPanes`
  (`src/reconcile.ts:113-142`). A retained gate pane whose command ended
  is present. For a bound kind, presence alone decides a ghost, as it does
  today.
- **Liveness** asks whether the job runs: `running`, `ended(exit)`,
  `lost(reason)` or `unknown(reason)`. It is answered per kind:
  - `pane`: the pane, as `paneAlive` answers (`src/mux/types.ts:330`).
  - `lease`: the carrier pane as `localPaneAlive` reads it,
    `paneResult(...).state === "running"` (`src/remote-agent.ts:667-671`).
  - `gate`: running while the pane runs. Once it exits, the host's
    completion record gives the exit (`src/agents/gate.ts:120-135`).
  - plugin kinds: the job kind's `status`.

For a **detached** kind (D3), reconcile asks liveness before it treats a
row as a ghost. mu never moves a job record on a reading alone: a job that
reads `ended` is still stopped (stop is idempotent) before its record is
released.

#### Turn

One prompt-to-settle of an agent: what the channels count as `runs`. Its
states are the channel readings:

- `idle` and `idle?` (unconfirmed, `src/channels/types.ts:310-316`);
- `running`, `queued` (in muzzle) and `blocked`;
- `settled(text, outcome)`;
- `unknown`.

A channel must report `running` while its backend has any work in flight
for the agent, children it started included. `settled` means the backend
says the agent is idle. mu models only agents it spawned; a backend's
internal children are not mu agents.

A turn is never persisted. mu persists only what it consumed: the wait
cursor's completion token and the applied settle, keyed by the agent's
registry id plus the channel incarnation (`src/db.ts:1243`, `:1272`). A
turn may start on its own, for example when a child's settle wakes its
parent; D4 and D9 say what that does to receipts and waits.

#### Today's records under the model

| Record | Role in the model |
| --- | --- |
| `agents` row | The agent. Its incarnation is the row id. `pane_id` (NOT NULL, `src/db.ts:1098`) is the view, and for a pane or gate job also the handle. `host`, `host_transport` and `channel` name the host, the job kind and the channel. P6 adds `plugin_channel` and `collect_due` (D5). |
| `carrier_jobs` | The job record of every lease job and plugin job. `token` is the job key. It gains columns in P6b (D5). |
| `remote_recovery` | A remote worktree's record after its agent row is gone, written by triggers (`src/db-recovery.ts:76-100`). Not host state. It blocks a provider host's release. Unchanged, triggers included. |
| `host_profiles` | The static provider's hosts. The template link's `exec` and `fetch`. The job kind, through `transport`: `session` means `pane` (or `gate`), `lease` means `lease`. It gains a `plugin` column (D5). |
| `host_channels` | The link's connection slots. mu keeps admission (`src/hosts.ts:781-816`) for every link that declares `slots: "mu"`. Not host state. |
| `spawn_receipts`, `wait_action_receipts`, delegate call states | Delivery intents, unchanged. D4 extends them to plugin channels. |
| `hosts` (new, P6c) | Provider hosts. |
| `plugins` (new, P6a) | Plugin registrations (D14). |

### D2. Names

The words below enter `docs/VOCABULARY.md` with this spec. Existing words
keep their meaning.

- **link**, not "transport". "transport" stays the profile field
  (`session` or `lease`), which in this model selects the job kind. P2
  renames the `Transport = ChannelName` alias
  (`src/agents/transport.ts:30`) to `SendChannel`.
- **turn**, not "run". **run** stays the executor's charge.
- **job kind**, not "driver" or "backend".
- **effect intent**, not "intent", which stays the op label.
- **plugin** means only a `mu-plugin-<name>` executable. pi's are
  **extensions**, as before.
- **capability** means a declared, enforced property of an
  implementation. It is not **host capabilities** (the probed harness
  record, `src/host-harnesses.ts:218-228`) and not a **role**.
- **write fence** and **run baseline**: the code calls both "fence"
  (`AgentChannel.fence`, `src/channels/types.ts:150`; `hooksFence` and
  `sentFence` at `src/cli/wait-arm.ts:97-106`). P4 renames the second to
  run baseline.
- **view presence** and **liveness**: the two reads D1 keeps apart.

### D3. Views

A job's **view** is the pane mu opens for it through
`MuxBackend.spawnAgent` (`src/mux/types.ts:323`). In this version every
agent has one:

- **pane job:** the view is the job.
- **lease job:** the view is the carrier.
- **gate job:** the view is the foreground command.
- **plugin job:** the view runs the job kind's view command.

Why every agent keeps a pane:

- **VISION's visible crews.** Each agent sits in a pane you can attach to.
- **`agents.pane_id` is NOT NULL** and appears in 13 `pane_id = ?`
  predicates outside `src/mux/`, among them `deleteAgent`
  (`src/agents.ts:576`) and the action receipts (`src/db.ts:1312`).
  Keeping a real pane keeps every one of them correct without a rebuild.
- **Released builds** see a live pane and treat the row as alive (D5).

**Where a view can run.** A view runs a command line, so a job kind with a
view command needs a backend whose `spawnAgent` runs one
(`runsShellCommand`, `src/mux/types.ts:286-290`). herdr starts its own
agent kinds instead (`src/mux/herdr.ts:741-751,811-820`). A spawn whose job
kind needs a command on such a backend refuses with a typed error before
any effect. That is already true of `spawn --host` on herdr.

**View input** follows the agent's channel:

- **Interactive.** Every built-in channel needs an interactive view:
  - `hooks` pastes into the pane;
  - `mux` uses `sendToPane`;
  - a pi on `ctl` is a TUI a human may attach to and type into.

  mule's lease view is such a pane, the carrier's TUI attach
  (`mule/src/lease.rs:355`), and stays interactive.
- **Read-only.** An agent on a plugin channel (P6d) gets a view whose
  stdin is `/dev/null`. Every delivery to it goes through its channel's
  receipts, never through keystrokes. Plugin-channel agents require tmux
  in this version: a released build's derived `mux` send then refuses
  (`src/channels/mux.ts:35-42`, tmux has no `sendToPane`), rather than
  pasting into a pane that reads nothing.

**Bound or detached.** This is the job kind's `view` capability (D12):

- **Bound:** the view's death ends the job, or starts its stop. This holds
  for `pane`, `lease` and `gate`, and for mule's carrier, which stops its
  job on SIGHUP, SIGINT or SIGTERM by design (`mule/SPEC.md:102`).
- **Detached:** the job outlives its view. Only plugin kinds may declare
  it, from P6d.
  - reconcile asks liveness before it treats the row as a ghost.
  - `agent close` stops the job first and kills the view after, the
    reverse of the bound order (`src/agents/close.ts:540-573`).
  - `agent reattach` on a row whose detached view is gone opens a new view
    with `job.attach` and compares-and-sets `agents.pane_id`, keeping the
    incarnation.
  - Today's reattach (no row, `src/agents/reattach-check.ts:75,140-144`)
    is unchanged.

### D4. Crash safety: effect intents, keys, reconcile by asking

An **effect** is a call that changes something outside mu's DB. D4's rules
apply to every effect mu may **replay**:

- host acquire and release;
- job start and stop;
- task-spawn delivery (`spawn_receipts`);
- the stall steer (`wait_action_receipts`);
- remote worktree changes;
- collect.

The interactive delivery verbs (`agent send`, `--fresh`, `--interrupt`,
abort, `answer`, session commands) are not replayed. The caller holds the
outcome, and today's rule stands for them: one attempt, an indeterminate
result is reported as **delivery unknown** and never resent, and
`mu agent check` asks by msgId (`src/agents.ts:708-726`;
`src/agents/abort.ts:60-78` journals nothing). A plugin channel follows the
same rule.

**The rules:**

1. **Write ahead.** Before the call, mu writes the **effect intent** on
   the subject's row, with a mu-generated **idempotency key**, in one
   immediate transaction that also fences the subject. Examples today:
   - `launch = 'intent'` (`src/agents/spawn.ts:842`);
   - the `sending` state of a spawn receipt (`src/agents/task-spawn.ts:564`);
   - the `sending` state of an action receipt (`src/db.ts:1304-1320`).

   For a plugin call, the intent also records the plugin process's group
   id and start time.
2. **Keyed.** The key goes with the call.
3. **One reconciler.** After a crash, a timeout or an `unknown-outcome`
   error, the next verb that touches the subject first claims it. It
   compares-and-sets the intent row to `resolving` with its own pid and
   start time, in an immediate transaction. Only the winner asks and acts.
   A loser refuses and names the winner's pid. A claim whose pid is proven
   gone is taken over, as the agent lock is today (`src/agents/lock.ts`).
4. **Reconcile by asking.** The winner asks: `lookup`, `status`,
   `receipt` or `reconcile`. Asking is read-only and may be repeated.
5. **Unknown is terminal until asked.** A subject whose intent has no
   definite outcome refuses every new effect on it: a spawn of the name, a
   stop, a release. It leaves that state only through a later definite
   answer, or through a human's explicit abandon verb, which logs what it
   dropped. `--force` never stands in for an answer.

**What `lookup(key)` may answer**, and when each answer is acted on:

```ts
export type KeyLookup<T> =
  | { found: T }       // the effect happened under this key
  | { pending: true }  // the backend holds the key; the effect is in flight
  | { none: true }     // the backend holds no record of the key
  | { unknown: string };
```

- **`found`** is recorded as the effect's result.
- **`pending`** and **`unknown`** leave the intent as it is.
- **`none`** proves that nothing happened only when all three hold.
  Otherwise mu treats it as `unknown`.
  1. **The creator is gone.** The mu process that wrote the intent is
     proven gone by pid and start time. This is the rule today's empty
     reservation uses (`src/agents/lease-carrier.ts:418-433`).
  2. **The carrier is gone.** The plugin process that carried the call is
     proven gone by its recorded group. A plugin exits on stdin EOF (D13),
     so a SIGKILLed mu leaves no plugin running, though D13 cannot force
     that.
  3. **No late success is possible.** Either the plugin declares
     `fenceKey` and was asked with `fence: true` (from then on the backend
     refuses that key), or the plugin's declared `inFlightMs` has passed
     since `pending_at`. That covers a request already on the wire that
     the backend has not seen yet.

**The resend rule, for a backend with key dedupe but no read-only
lookup.** A method that declares `dedupe: {windowMs}` promises that a
repeat with the same key, within the window, returns the first call's
result and makes no second effect. For such a method, a resend is an ask.
After `unknown-outcome`, the reconciler may repeat the call with the same
key while `now < pending_at + windowMs`, and record the reply as the
effect's result. Past the window it may not; the subject is terminal until
a lookup or a human resolves it.

An effect that can start something must declare `lookup`, dedupe, or both:
`host.acquire`, `job.start` with `handle.from = reply`, and
`channel.send`/`fresh` for task-spawn replay. A plugin that declares
neither is refused at load for that method. The contract suite checks the
promise: a fake backend counts effects across repeats.

**The receipt rule, for backends whose turns start on their own.** A
channel declares `turns: "on-delivery"` (a turn starts only when something
is delivered) or `"self-starting"` (a turn may start without a delivery,
for example when a child's settle wakes its parent).

- **`acknowledged` receipts** (a turn past the journaled baseline means
  accepted, as hooks does, `src/agents/task-spawn.ts:744-760`) are allowed
  only on `on-delivery`. A self-starting channel declaring them is refused
  at load.
- **Reconciling a self-starting channel** goes by msgId (`receipt: exact`),
  or answers `unknown`.
- **A wait pinned by a send** (`afterRuns` from a delivery on a
  self-starting channel) fires only for a settled turn whose `cause` is
  that msgId. The channel reports the cause on every observation. A turn
  with another cause is news for other waits, not for this one.

**Where each effect's intent lives.** There is no separate effects table:
each intent sits on its subject, and the existing journals keep their
roles. Folding them together would be a wrapper around a wrapper
(`docs/ROADMAP.md:28`).

| Effect | Subject record | Key | After a crash, the reconciler asks |
| --- | --- | --- | --- |
| host acquire | `hosts` row, `acquiring` | `hosts.key` (UUID) | `provider.lookup(key)`, or a deduped resend |
| host release | `hosts` row, `releasing` | `<key>:release` | `provider.status`; `gone` means done. `release` is idempotent. |
| lease job start | `carrier_jobs`, `launch = 'intent'` | `token` | the job file, as today. From P7, `lookup(token)`. |
| plugin job start | `carrier_jobs`, `launch = 'intent'` | `token` | `job.lookup(token)`, or a deduped resend |
| job stop | `carrier_jobs`, `pending_op = stop` | `<token>:stop` | stop again (idempotent: exit 0 for an ended job, `mule/SPEC.md:366`) |
| pane spawn | the placeholder row `%pending-<name>` (`src/agents.ts:550-559`) | the name | the dead-staging rules, unchanged |
| task-spawn delivery | `spawn_receipts`, `sending` | `msg_id` | `channel.reconcile` (D9) |
| stall steer | `wait_action_receipts`, `sending` | (task, owner, incarnation, action) | `channel.reconcile`; ctl only, since it needs a write fence (D11) |
| remote worktree make | fixed path plus a `mu-prepared` mark | the path | reclaim of an unused leftover (`src/remote-agent.ts:83-95`) |
| remote worktree remove | `remote_recovery.aside` | `asideOf(path, incarnation)` (`src/remote-agent.ts:276`) | observe, which resumes the aside |
| collect | `agents.collect_due`, the pin ref, `collected_head` | the agent identity | rerun: `FETCH_HEAD` is deleted first (`src/remote-collect.ts:10-17`) |

**Retries.** Only an error of kind `retryable` may be retried, because the
implementation says nothing happened. mu tries at most three times, with
the same key. `human` is never retried (as `HostHandbackError` is not
today, `src/hosts.ts:924`).

### D5. Schema: additive at 13, state dir unchanged

**Decision.** Everything stays at schema 13, through `upgradeSchema`
(`src/db.ts:476-505`), in `mu-next` (`src/state-dir.ts:15-18`). P1–P5 add
nothing to the schema. P6a–P6d add two machine-local tables and a few
nullable columns.

**Why not a version bump and a new state directory.** AGENTS.md "State
directories" requires a new directory only for a change that breaks
on-disk compatibility with the released version. A v14 file makes every
released build refuse the DB (`SchemaTooNewError`, `src/db.ts:440-455`),
so the bump would itself be the break, and nothing here needs a migration
ladder. What must hold instead: a released build that opens a DB holding
plugin rows never takes an effect it does not understand, never drops a
fence, and never loses work it could have kept.

| Addition | What a released build does with it |
| --- | --- |
| `plugins`, `hosts` (new tables) | Ignores them: `schemaIsCurrent` checks only the objects it expects (`src/db.ts:682-707`), and tables have been added before with no bump (`src/db.ts:736-740`). A released `mu rebuild` drops them without reporting it, because it reports only its own list (`src/rebuild.ts:127-152,267-271`). That is a known limitation, stated in the release notes; this build adds both tables to `UNREBUILDABLE_TABLES`. |
| `carrier_jobs.kind`, `plugin`, `instance`, `pending_op`, `pending_key`, `pending_at`, `pending_pgid`, `host_id`; NULL `kind` means `lease`; `host_stop = ''` for a job on a provider host (the column is NOT NULL, `src/db-carrier.ts:29`) | Plugin jobs sit in the table released builds read as the name fence (`src/agents.ts:416-424`), so the fence holds. A released `agent close` kills the view (`src/agents/close.ts:540-544`), proves it gone (`:567`), then asks the lease stop (`:573`). On a provider host that refuses `no-host` (`src/carrier-stop.ts:81-85`), keeping the row and the reservation. The next released reconcile reaps the row, and the reaper parks the tasks because the reservation holds a job (`src/agents/reap.ts:55-78`). The job is never stopped wrongly, the fence never drops, and this build later shows it as a leftover to close or reattach. On a profile host (mule), `host_stop` is the profile's `stop`, so a released close stops the job through the template exactly as today. |
| `host_profiles.plugin` | A plugin-backed profile keeps its templates. A released build uses the templates; this build uses the plugin for the seams it implements. |
| `agents.plugin_channel`; such a row stores `channel = 'mux'`, `host_transport = 'lease'` and the harness key as `cli` | A released build reads `mux`. A stored channel beats derivation (`src/channels/select.ts:46`), so it never derives `ctl` and never sees a broken ctl to release a task over (`src/wait-actions.ts:25-26`). Its sends refuse on tmux (`src/channels/mux.ts:35-42`). Its close takes the lease path above: `host_transport = 'lease'` with no reservation refuses (`src/agents/close.ts:724-736`). |
| `spawn_receipts.channel` for a plugin channel; `transport` stays NULL | The `transport` CHECK (`src/db-receipts.ts:42`) must not be dropped. A released build detects a table whose SQL lacks `'hooks'` as the old shape and rebuilds it with its own CHECK (`src/db-receipts.ts:58-63`, `src/db.ts:527-528`), and a plugin value would then fail every later `openDb`. With `transport` NULL, a released replay says "no receipt to ask" and never resends (`src/agents/task-spawn.ts:718`). |
| `agents.collect_due` | Ignored. A released build runs no lifecycle policy (D10), and the release notes say so. |

**Provider-host worktree recovery, with the triggers unchanged.** The
recovery triggers pin `host_profiles.exec` (`src/db-recovery.ts:82,94`),
which is NULL for a provider host. Recovery then refuses
(`src/remote-recovery.ts:344-363`, read at `:414-419`). Changing the
triggers is not safe while released builds recreate their own `_v2`
triggers. So the triggers stay, and P6c gives `assertRecoveryProfile` a
provider branch.

- The record's host must have a host record that is not deleted.
- The record must have been written after that host was acquired
  (`remote_recovery.preserved_at >= hosts.created_at`).
- The host's link fingerprint is taken from its record.

This is sound because of the name rule in D1: a provider host's name is
referenced only while its record exists, and abandon deletes the
references. So a recovery row can only name the machine it was written
on. A `--plugin` profile's fingerprint is its `exec` bytes, exactly what
the triggers already pin (D7).

**Cross-namespace fence.** `mu host add` refuses a name held by a host
record, and `host acquire` refuses a profile's name. A released build
cannot see host records, so it can add a colliding profile. `resolveHost`
then refuses the ambiguous name with a typed error naming both, and
nothing acts on it.

**Tables.**

- `hosts`: id, name UNIQUE, provider, `instance`, `spec_digest`, key
  UNIQUE, handle, state CHECK (`acquiring`, `ready`, `draining`,
  `releasing`, `lost`), `deadline_at`, `idle_reclaim_ms`, `max_jobs`,
  `pending_op`, `pending_at`, `pending_pgid`, `resolver_pid`,
  `resolver_start`, `creator_pid`, `creator_start`, `reason`,
  `created_at`, `updated_at`. `instance` and `spec_digest` are per-host
  and immutable: a plugin's current registration is not the fence.
- `plugins`: name PK, path, protocol, version, instance, `seams_json`,
  `caps_json`, `schema_digest`, `added_at`, `checked_at`.

Both are listed in `MACHINE_LOCAL_TABLES` (`src/db.ts:893-918`) and
`UNREBUILDABLE_TABLES` (`src/rebuild.ts:127`). They are not captured, so
`CAPTURE_VERSION` is unchanged. `EXPECTED_TABLES` goes from 29 to 31.

**The next major** renames `carrier_jobs` to `jobs`, replaces
`spawn_receipts.transport` and `agents.channel = 'mux'` with the real
names, and moves to a versioned state directory with an importer. It is
not part of this spec.

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
  acquire(spec: HostSpec, key: EffectKey, call: Call): Promise<HostFacts>;
  /** Which host, if any, `key` acquired (D4 KeyLookup). `fence: true` asks the backend to refuse the key from now on. */
  lookup(key: EffectKey, opts: { fence: boolean }, call: Call): Promise<KeyLookup<HostFacts>>;
  /** "Cannot tell" is `unknown`, never a throw. */
  status(handle: string, call: Call): Promise<HostStatus>;
  /** Idempotent: a host already released resolves. */
  release(handle: string, key: EffectKey, call: Call): Promise<void>;
}

/** What the rest of mu holds for `--host <name>`. P2 introduces it with `name`, `profile` and `link`; P3 adds the rest. */
export interface HostView {
  name: string;
  link: HostLink;
  provider: HostProvider;
  jobKind: JobKind;
  /** Static hosts only. */
  profile?: HostProfile;
  /** Provider hosts only, in any state but deleted. */
  record?: HostRecord;
}

/**
 * `--host <name>`: a profile, or a host record in any state. Refuses a name that is both.
 * Each verb checks the state it needs: spawn needs `ready`; close, stop and collect accept
 * `ready`, `draining` and `lost`; release needs `draining` or `lost`.
 */
export function resolveHost(db: Db, name: string): HostView;
```

**Atomic admission.** A spawn on a provider host reserves inside one
immediate transaction, the agent lock already held. That transaction
re-reads the host record, refuses unless `state = 'ready'`, and counts the
host's job records and pane agents against `max_jobs`. The precedent is
today's channel admission, which reads its cap inside the immediate
transaction that inserts (`src/hosts.ts:781-816`). Release sets
`releasing` inside its own immediate transaction after its counts, so a
spawn and a release cannot both pass.

**Built-in `static`.**

- `status` answers `up` with the profile name as the handle, without a
  round trip. Reachability stays a per-call fact, as today.
- `acquire`, `lookup` and `release` refuse: a static host is added and
  removed with `mu host add`/`rm`. `removeHost` keeps its current rule
  (`src/hosts.ts:290-300`), and so does a static `host rm` under a running
  lease job (D18).

**Moves behind it in P3:**

- every `getHost(db, name)` outside `hosts.ts` and the profile verbs:
  `src/agents/close.ts`, `src/agents/spawn-remote.ts`,
  `src/carrier-stop.ts`;
- the raw `host_profiles` reads in `src/agents/reattach-check.ts:102` and
  `src/remote-recovery.ts:414-419`.

**Missing from the sketch:**

- `lookup` and its `fence`;
- `needs-human`;
- facts carried on `status` rather than methods;
- job slots split from connection slots;
- atomic admission;
- `resolveHost` covering every state.

**Second implementation:** a provider plugin for machines provisioned on
demand. mule is not a provider: it never opens or provisions machines
(`mule/SPEC.md:505`).

### D7. Seam: link, and the worktree contract

```ts
// src/host-link.ts
export interface LinkRun {
  exitCode: number | null; // null: timed out
  stdout: string;
  stderr: string;
  /** The output was cut (mule's exit 7, mule/src/errors.rs:13): never parsed. */
  partial: boolean;
}

export interface LinkCaps {
  /** Can bring a commit home; false: the profile's fetch template does. */
  fetch: boolean;
  /** "mu": every call holds a host channel (src/hosts.ts:781). "self": the link arbitrates its own connection. */
  slots: "mu" | "self";
  /** After a timeout, whether the remote script is proven stopped or may still run. */
  remoteOnTimeout: "stopped" | "unknown";
  /** Whether a quiescence scan over `exec` sees the processes the host's jobs run as (same user, same PID namespace). */
  quiescence: "provable" | "unprovable";
}

export interface HostLink {
  /** "template", or the plugin's name. */
  readonly name: string;
  readonly caps: LinkCaps;
  /** The identity recovery records and the probe record pin. Template, and a `--plugin` profile: the exec bytes. A provider host: plugin name plus the host's instance. */
  fingerprint(host: HostView): string;
  /** Whether `script` in `cwd` fits the link's limit. Template: the expanded exec argument under EXEC_ARG_MAX_BYTES (src/agents/hooks-brief.ts:148-151). Plugin: the script's bytes under its declared limit. */
  fits(host: HostView, script: string, cwd: string): boolean;
  /**
   * Run a POSIX sh script in `cwd` ("." = the login directory). Returns once nothing it
   * started LOCALLY still runs (src/hosts.ts:896-901). A hand-back throws HostHandbackError.
   * Never retried. A timeout is an unknown outcome: the remote side may have run, per
   * `caps.remoteOnTimeout`.
   */
  exec(host: HostView, req: { script: string; cwd: string; timeoutMs: number }, call: Call): Promise<LinkRun>;
  /** Leave `remoteCwd`'s HEAD in `localRepo`'s FETCH_HEAD. mu verifies the commit itself. */
  fetch?(host: HostView, req: { remoteCwd: string; localRepo: string; timeoutMs: number }, call: Call): Promise<LinkRun>;
  /** This link's host-check steps (D11). */
  checkSteps?(host: HostView, call: Call): Promise<HostCheckStep[]>;
}
```

**Built-in `template`.** Today's `exec` and `fetch` templates, run by
`runLeasedTemplate` (`src/hosts.ts:903-933`). Admission, the pgid record
taken before the command starts (`:857`), the timeout plus `HOST_GRACE_MS`
(`:888`), and exit 3 as a hand-back (`:924`) are unchanged. Its
capabilities:

- `slots: "mu"`;
- `remoteOnTimeout: "unknown"`: killing a local ssh does not stop the
  remote command (`mule/src/transport.rs:432-438` measured exactly this);
- `quiescence: "provable"`, which is today's assumption that the exec user
  is the job's user.

**What a timeout means.** mu's worktree scripts are already written to be
re-run safely: reclaim, marks, the aside. A timed-out exec is therefore
reported as an unknown outcome, and the next run re-observes.
`quiescence: "unprovable"` makes every removal refuse without `--force`,
as a host with neither `/proc` nor `lsof` does today
(`src/remote-agent.ts:543`). The scan proves only that it ran
(`src/remote-agent.ts:288-294`); whether it sees the job's processes is
the link's declared fact.

**Moves behind it in P2:**

- every call to `runLeasedTemplate`, `runHostTemplate` and
  `withHostChannel` outside `hosts.ts`. The callers today are
  `remote-agent.ts`, `remote-collect.ts`, `agents/gate.ts`,
  `agents/hooks-brief.ts`, `channels/hooks-remote.ts` and
  `carrier-stop.ts`.
- the `RemoteReader` (`src/channels/types.ts:104`), which then reads
  through `link.exec`;
- the brief's size check (`src/agents/hooks-brief.ts:148-151`), which
  becomes `link.fits`.

**The worktree contract is mu's, over `exec`.** Make, observe, quiesce and
remove are mu's shell scripts, split in P2 from `remote-agent.ts` (671
lines) into `src/remote-worktree.ts`. A link has no worktree methods. The
contract a link must meet:

- POSIX sh and git on the far side;
- `/proc` or `lsof`, a scanner that sees its own `$$`, and
  `quiescence: "provable"`;
- stdout arrives whole (`partial` false);
- scripts may be re-run after a timeout.

```ts
// src/remote-worktree.ts (mu-owned; every method is one or two link.exec calls)
export interface RemoteWorktree {
  make(h: HostView, r: { root: string; from: string; path: string; reclaim: boolean }): Promise<{ repoAbs: string; base: string; path: string }>;
  observe(h: HostView, r: { path: string; root: string; aside: string }): Promise<{ state: "clean" | "dirty" | "gone"; head: string | null; merged: boolean }>;
  quiesce(h: HostView, r: { aside: string; force: boolean }): Promise<{ proven: true } | { held: { pid: number; etime: string; args: string }[] } | { unproven: string }>;
  /** The 11 outcomes of REMOTE_RM_RE (src/remote-agent.ts:265-266). */
  remove(h: HostView, r: { aside: string; wantHead: string; keepBranch?: string; viaRef: boolean }): Promise<RemoteRemoval>;
  rollbackRemove(h: HostView, r: { path: string; base: string }): Promise<"removed" | "kept" | "gone">;
}
```

This is one implementation, so it is a module, not a seam. It is git-only,
as remote worktrees are today.

**Missing from the sketch:** `fingerprint`, `fits`, `partial`, `slots`,
`remoteOnTimeout` and `quiescence`. **Dropped from the sketch:** `push`,
and a key on `exec`.

**Second implementation:** mule (P7), with `fetch: false` (bulk transfer
may not ride its connection, `mule/SPEC.md:47,541`) and `slots: "self"`.

### D8. Seam: job kind

```ts
// src/jobs/types.ts (new cluster: types, view, pane, lease, gate; an ARCHITECTURE row)
/** Exactly the fields MuxBackend.spawnAgent takes for the pane's process (src/mux/types.ts:62-90). */
export interface PaneCommand {
  command: string;
  env: Record<string, string>;
  cwd?: string;
}

export interface JobSpec {
  workstream: string;
  name: string;
  /** The `--cli` key: which harness the job runs. */
  harness: string;
  role: "full-access" | "read-only";
  model?: string;
  /** The agent's command on the host. */
  cmd: string;
  cwd: string;
  /** Only HOST_ENV_KEYS (src/hosts.ts:392-400); mu refuses any other key before the call. */
  env: Partial<Record<HostEnvKey, string>>;
  /** The control socket pair, when the agent's channel is ctl. */
  sockets?: { local: string; remote: string };
}

export type JobStart = {
  /** mu opens this pane through MuxBackend; every job has one in this version (D3). */
  view: PaneCommand;
  /** Present when caps.handle is "reply". */
  handle?: string;
};

export type JobLiveness =
  | { state: "running" }
  | { state: "ended"; exit: number | null }
  | { state: "lost"; reason: string }
  | { state: "unknown"; reason: string };

/** Everything a liveness read needs; built from an agents row, or from a pane id alone for a pane job. */
export interface JobRef {
  kind: string;
  viewPaneId: string;
  key?: EffectKey;
  handle?: string;
  host?: { name: string; handle?: string };
  gateToken?: string;
  /** The recorded stop fence: today host_stop; a plugin's instance. */
  identity?: string;
}

export interface JobCaps {
  view: "bound" | "detached";
  /** Where the handle comes from, fixed for the kind and declared at the handshake. */
  handle: "pane" | "file" | "reply";
  lookup: boolean;
  fenceKey: boolean;
  dedupe?: { windowMs: number };
  inFlightMs?: number;
  /** The channel this kind's agents use: a plugin channel of the same plugin; absent, the harness's own. */
  channel?: string;
}

export interface JobKind {
  /** "pane" | "lease" | "gate" | a plugin's kind. */
  readonly name: string;
  readonly caps: JobCaps;
  identity(host: HostView | null): string;
  start(host: HostView | null, spec: JobSpec, key: EffectKey, call: Call): Promise<JobStart>;
  lookup(host: HostView | null, key: EffectKey, opts: { fence: boolean }, call: Call): Promise<KeyLookup<string>>;
  status(job: JobRef, call: Call): Promise<JobLiveness>;
  /** Idempotent. Resolves only on proof the job is gone; a hand-back throws HostHandbackError. Never deletes a record. */
  stop(job: JobRef, key: EffectKey, call: Call): Promise<void>;
  /** A new view for a job that still runs. */
  attach(job: JobRef, call: Call): Promise<PaneCommand>;
  /** This kind's host-check steps (D11). */
  checkSteps?(host: HostView, call: Call): Promise<HostCheckStep[]>;
}

// src/jobs/view.ts: the two reads (D1)
/** A pane's state, for the sites that hold only a pane id. Wraps paneAlive, paneResult and paneUp. */
export function viewState(paneId: string): Promise<"running" | "exited" | "absent" | "unknown">;
/** A job's liveness, by its kind. */
export function jobLiveness(job: JobRef, call: Call): Promise<JobLiveness>;
```

**Built-ins:**

| Kind | `start` | `status` | `stop` | `attach` |
| --- | --- | --- | --- | --- |
| `pane` | the local command, or the `session` profile's `shell` template; `handle: "pane"` | `paneAlive` (`src/mux/types.ts:330`). A throw is `unknown`. | `killPane` plus a `paneAlive` proof (`src/agents/close.ts:540-568`). `force` stands in only where no multiplexer can answer, as today. | refused |
| `lease` | the lease `shell` template; `handle: "file"` (`src/agents/lease-carrier.ts:118`) | `paneResult(...).state === "running"` (`src/remote-agent.ts:667-671`) | `runStop` behind the `host_stop` byte fence (`src/carrier-stop.ts:88,97`) | the `attach` template, behind the pending-carrier marker |
| `gate` | the gate command; `handle: "pane"` | the retained pane plus the host's completion record (`src/agents/gate.ts:120-135`) | `killPane` plus a proof | refused |

**Moves behind `viewState` and `jobLiveness` in P1.** These are the sites
that assume a dead pane means a dead agent:

- `src/agents/close.ts:540-568`, the row rule;
- `src/agents/spawn-rollback.ts`;
- `src/agents/spawn-ready.ts:244` (`checkSpawnHealth`, which takes a pane
  id);
- `src/agents/lease-carrier.ts:265-297`;
- `src/workstream.ts:566,590`, teardown;
- `src/hosts.ts:706-716` (`probeAttached`);
- `src/agents/gate.ts:120-135`;
- `src/remote-agent.ts:667-671` (`localPaneAlive`);
- `src/channels/ctl.ts:85,222-224` (`paneUp` and the dropped-watch
  fallback).

Sites holding only a pane id call `viewState`; sites holding a row call
`jobLiveness`. Two things are not moved:

- reconcile's `listPanes` (`src/reconcile.ts:113`) is view presence, which
  D1 keeps separate;
- the liveness merge in `src/channels/dispatch.ts:115-139` moves in P4.

**Missing from the sketch:**

- `lookup`, `fenceKey`, `dedupe` and `inFlightMs`;
- the handle source, declared per kind;
- `identity`, the stop fence;
- the view capability;
- the gate kind;
- stop's contract;
- the settle mode the reaper needs;
- `JobSpec.harness`, `role` and `model`;
- `caps.channel`;
- `JobRef`, so liveness needs no `Db`.

**How a plugin job picks its channel (P6d).** If `caps.channel` names a
plugin channel, spawn records `plugin_channel` on the row. It skips the
ctl handshake (`src/agents/spawn.ts:969`) and the remote anchor wrapper
(`:680`), and takes readiness from the channel's `baseline` answering
within `MU_SPAWN_JOB_MS`. `finalizeAgentRow` stores `channel = 'mux'` and
`host_transport = 'lease'` (D5). Without `caps.channel`, the harness's own
channel applies, as today.

**Second implementation:** mule (P7), the `lease` kind with `lookup`.
After it, a plugin kind with a detached view and `handle: "reply"`, for
session-hosted agents.

### D9. Seam: agent channel, an open registry

`AgentChannel` (`src/channels/types.ts:143-185`) and `ChannelDelivery`
(`:356`) stay the seam. They change as follows:

```ts
// src/channels/types.ts
/** Registered channel names. An unregistered stored name is a typed error, never a derived fallback. */
export type ChannelName = string & { readonly __channel: unique symbol };

export interface ChannelCaps {
  /** "sync": ctl's in-process veto immediately before the one write. Plugins: "none" in this version (D11). */
  fence: "sync" | "none";
  receipt: "exact" | "acknowledged" | "none";
  /** Whether turns start only on delivery (D4). */
  turns: "on-delivery" | "self-starting";
  dedupe?: { windowMs: number };
  steer: boolean;
  interrupt: "exact" | "unconfirmed" | "none";
  fresh: "in-place" | "new-job" | "none";
  answer: boolean;
  command: boolean;
  watch: "stream" | "poll";
  /** Whether lastRun's text is the settled turn's own (a CLOSE block needs "tied"). */
  settleText: "tied" | "untied" | "none";
}

/** Who the channel is asked about: the row's identity plus the job and host handles a stateless plugin needs. */
export interface ChannelTarget {
  agent: ObservedAgent;
  stateDir?: string;
  socket?: string;
  remote?: RemoteReader;
  /** From P4, filled from carrier_jobs and hosts when the row is listed (no Db at the channel). */
  job?: JobRef;
}

export interface AgentChannel extends ChannelDelivery {
  readonly name: ChannelName;
  /** Replaces `readonly fence: boolean`. */
  readonly caps: ChannelCaps;
  // readStates, watch, baseline, receipt and lastRun keep their signatures;
  // StateAgentRef gains the same `job?: JobRef`.
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

/** A settled turn says what started it (D4); self-starting channels must set it. */
export interface TurnCause {
  cause?: { msgId: string } | { self: true };
}

/** Renamed from CtlGuard. A channel whose caps.fence is "none" refuses a guard. */
export interface WriteGuard {
  signal?: AbortSignal;
  timeoutMs?: number;
  beforeWrite?: () => boolean;
}

export function registerChannel(channel: AgentChannel): void;
```

**Built-ins and their capabilities.** This is the matrix the contract
suite asserts, extending `test/channel-contract.test.ts:118-142`.

| Capability | `ctl` | `hooks` | `mux` |
| --- | --- | --- | --- |
| fence | `sync` (`src/ctl/client.ts:166-180`) | `none` (`src/channels/hooks.ts:221`) | `none` (`src/channels/mux.ts:29`) |
| receipt | `exact`: `status {msgId}`; the last 64 are kept (`src/ctl/protocol.ts:116`) | `acknowledged`: `run_count` past a baseline | `none` |
| turns | `on-delivery` | `on-delivery` | `on-delivery` |
| dedupe | none: the extension does not dedupe (`src/wait-actions.ts:32`) | none | none |
| steer | true | false (`src/channels/hooks.ts:262`) | false |
| interrupt | `exact` | `unconfirmed` (claude reads `idle?`) | `none` |
| fresh | `in-place` | `in-place` (refused remote) | `none` (`src/channels/mux.ts:60-63`) |
| answer, command | false, true | true, true (`src/channels/hooks.ts:935,959`) | true, true (`src/channels/mux.ts:65,77`) |
| watch | `stream` | `stream`, a poll loop inside the channel (`src/channels/hooks.ts:693`) | `poll` (`watch` returns undefined) |
| settleText | `tied` | `tied` or `untied` per murmur | `none` |

**What moves in P4:**

- `agentChannel` becomes a registry lookup. Today it is an exhaustive
  ternary (`src/channels/dispatch.ts:63-66`).
- `readChannelStates` groups agents by channel and calls each one's
  `readStates`. Today it hardwires ctl first and mux for the rest
  (`:115-139`). An agent whose channel cannot answer takes its liveness
  from `jobLiveness` (P1).
- `markQueued` reads a capability, not `!== "ctl"` (`:100`).
- Delivery results carry `ack` and `baseline`, so these sites stop
  recomputing a wait's baseline by name: `src/cli/wait-arm.ts:97-106`,
  `src/cli/agent-send.ts:217` and `src/agents/task-spawn.ts:666`.
- Replay calls `reconcile` (`src/agents/task-spawn.ts:717-720`,
  `src/next.ts:584`).
- Name branches that a capability covers become capability checks:
  - the steer hint (`src/messages.ts:241-244`);
  - the answer hint (`:199-202`);
  - the CLOSE trust rule (`src/close-block.ts:219`);
  - the stall grace (`src/wait.ts:781`);
  - the rewatch (`src/wait-latch.ts:86`).
- **The hooks-only features stay named.** These branches belong to
  features of the `hooks` channel that no capability describes:
  - the brief file and session wait (`src/agents/task-spawn.ts:547,589`);
  - the turn-failure acknowledgement (`src/next.ts:836`,
    `src/next-recover.ts:96,135,324`);
  - the first-prompt and send gate (`src/cli/agent-send.ts:81,325`);
  - the Stop hook (`src/hook-stop.ts:506`);
  - the pi fallback (`src/agents/spawn.ts:418`).

  They stay as they are. P4's test pins exactly that list, so any new name
  branch fails. A plugin channel gets none of these features.
- `StateSource` (`src/agent-state.ts:12`) gains an `exact` flag in place
  of its `source === "ctl"` tests.

**Missing from the sketch:**

- `reconcile`;
- `ack` and `baseline`;
- `dedupe`, because a persisted key alone is not idempotence;
- `turns` and the turn cause;
- `settleText`, `answer` and `command`;
- the job and host handles on the target. A stateless plugin cannot
  otherwise tell which remote session a call is about: neither
  `StateAgentRef` (`src/agent-state.ts:48-53`) nor `ObservedAgent`
  (`src/agents/observe.ts:31-34`) carries one.
- the turn states `unknown`, `idle?`, `queued` and pending.

**D4 of the every-harness spec is amended.** It kept "the lease carrier and
the remote socket plumbing" on ctl directly. The dropped-watch fallback
that reads "control socket lost; the pane is alive"
(`src/channels/ctl.ts:222-224`) now asks `viewState`.

**Second implementation:** a plugin channel for session-hosted agents.
`ctl`, `hooks` and `mux` stay in process, as peers of plugin channels.

### D10. Host policies: mu-owned, two functions

The sketch had plugin lifecycle hooks: `onSettle`, `beforeDeadline` and
`onRelease`. What they would trigger are mu's own effects: collect, which
is networked but idempotent, and close, which is destructive. The host
facts are enough to decide when to run them. A plugin trigger would let a
plugin cause a mu effect, against Principle 2. There are exactly two
policies, each with one implementation, so by Principle 7 they are two
functions in `src/host-policy.ts`, not an interface. Both start in P6c,
with provider hosts.

**`collectAtSettle(db, agent, host)`** applies to a host with
`idleReclaimMs`. When `mu wait` observes a remote worker's turn settle on
such a host:

1. In the immediate transaction that records the settle (before the wait
   cursor commits), mu sets `agents.collect_due` to the settled turn.
2. It runs the worker's collect, through `mu agent collect`'s own
   compare-and-set. A success clears `collect_due`.
3. It commits the cursor and returns the settle.

If the collect fails, the settle is still returned, with a warning and
`next: mu agent collect …`. `collect_due` stays set, and every later
`mu wait`, `mu state` and `mu next` that touches the host announces it as
a notice. Each such invocation whose turn settles on that host tries again.
A crash between the steps leaves `collect_due`, so the work is never
silently dropped. Notices name an idle-reclaim host with any `collect_due`
agent as **work at risk**.

**`deadlineNotice(db, host)`** applies to a host with `deadlineAt`. Inside
`MU_HOST_DEADLINE_MARGIN_MS` of the deadline (P6c picks the default):

- spawns on the host are refused (`HostDeadlineError`), and the host moves
  to `draining`;
- `mu wait` fires an urgent `deadline` event naming the host and its
  agents;
- `mu state` shows a notice whose `next` lists each agent's collect and
  close.

mu never closes an agent on its own.

**The wake-up.** A wait whose agents are all watched sleeps until a
settle, the deadline or an abort, and does no polling
(`src/wait.ts:1450-1470`). So D10 caps that sleep: `mu wait` sets its own
timer to the earliest `deadline_at − margin` among the hosts of the agents
it waits on, and fires `deadline` when the timer runs out. This is a
timer inside one invocation, like `--timeout`, not a background process
(VISION constraint 4).

The policies run in `mu wait`, `mu next`, `mu state` and spawn. Static
hosts carry no facts, so neither policy applies to them, and today's
behaviour stands.

### D11. What Principle 7 cut

The ponytail review asked, for each piece of draft 1, whether two real
implementations need it.

- **The two-phase write fence: cut.** Today's only write fence is ctl's
  synchronous `beforeWrite` (`src/ctl/client.ts:166-180`). Only two
  callers use it:
  - the stall steer (`src/wait-actions.ts:446-474`), whose steer only ctl
    can do anyway;
  - the close notice, which is pi-only (`src/close-notice.ts:101`).

  No second implementation needs a remote fence. A plugin channel declares
  `fence: "none"`. With that, the steer falls back to reporting the stall,
  as hooks does, and the close notice does not apply. A plugin's at-most-
  once comes from never resending outside a declared dedupe (D4). If a
  real plugin later needs steer with exclusion, a fence goes through the
  roadmap with that plugin as its evidence.
- **The HostChecks seam: folded.** Check steps are an optional
  `checkSteps` method on `HostLink` and `JobKind`. Each built-in and mule
  supply one; `checkHost` composes them. There is no fifth interface and
  no fifth contract suite. The composition keeps today's order exactly
  (`src/hosts.ts:1018-1180`):
  1. the lease kind's template steps: `shell`, `stop`, `attach`
     (`:1045`);
  2. the link's `reachable` and `repo` (`:1094-1099`);
  3. mu's `harnesses` and `hooks` (`:1103-1123`);
  4. `pi` and `extension`, which run only when the harness probe found pi
     (`:1124-1140`);
  5. the lease kind's `job` (`:1157`);
  6. `ctl` (`:1159-1168`).

  A `handback` step still skips the rest. `HostCheckStep.step` widens from
  its closed union (`src/hosts.ts:956-969`) to `string`, and plugin steps
  are named `<plugin>:<step>`.
- **The LifecyclePolicy interface: cut.** It had two policies with one
  implementation each, so they became two functions (D10).
- **P6 was one unit: split** into P6a–P6d, each about a week
  ([Units](#units)).

### D12. Capabilities

A capability is declared once, at the handshake for a plugin or in code
for a built-in. The contract suite checks that the implementation behaves
as declared. Each capability has an enforcement point in mu's verbs:

| Capability | Meaning | Enforced where |
| --- | --- | --- |
| channel `fence` | `sync`: an in-process veto immediately before the one write. `none`: no veto. | Every caller that passes a write guard, the steer (`src/wait-actions.ts:446-474`): with `none` it refuses before any write, as `src/channels/mux.ts:29` and `src/channels/hooks.ts:221` do today. |
| channel `receipt` | `exact`: answers by msgId. `acknowledged`: answers by a turn past the journaled baseline (only with `turns: on-delivery`). `none`: cannot answer. | spawn replay and `mu next` recovery through `reconcile`. `mu agent check` refuses `none`. Checked at load. |
| channel `turns` | whether a turn starts only on delivery | at load (the `acknowledged` rule); `mu wait` pins a send's wait by `cause` on `self-starting` (D4) |
| channel and job `dedupe` | a repeat with the same key, within the window, returns the first result and makes no second effect | the D4 resend rule; nothing is ever resent without it |
| job `lookup`, `fenceKey`, `inFlightMs` | lookup by key; whether a lookup can make the key unusable; how long a request may stay in flight | the D4 gate on `none`. At load, a starting method with neither lookup nor dedupe is refused. |
| channel `steer` | input can join a running turn | `send --steer`, `--on-stall steer`, the `mu next` steer executor. The typed refusal names the channel (`src/channels/hooks.ts:262`). |
| channel `interrupt` | `exact`: the abort is confirmed. `unconfirmed`: the agent reads `idle?` until its next event. | `send --interrupt` and abort. `none` refuses. |
| channel `fresh` | `in-place`: a new session in the same job, a new channel incarnation. `new-job`: the backend's fresh starts a job. | `send --fresh` refuses `new-job` and `none` with a typed error naming close then spawn. That keeps the wait cursor key (D1). |
| channel `answer`, `command` | keys reach a pending dialog; session commands run | `agent answer`, the session commands |
| channel `watch` | `stream`: `watch` returns one watch that settles when the turn ends. `poll`: `watch` returns undefined and mu polls `readStates`. | `mu wait`'s watch path (`src/wait-ctl.ts`) |
| channel `settleText` | the last text is the settled turn's own | CLOSE blocks apply only with `tied` (`src/close-block.ts:219`) |
| job `view` | `bound`: the view's death ends the job. `detached`: the job outlives it. | reconcile, the reaper, close order, reattach and `mu wait`, through D1's two reads |
| job `handle` | where the handle comes from | at load; a `start` reply that disagrees is `unknown-outcome` |
| job `channel` | the channel the kind's agents use | spawn (D8) |
| link `fetch` | brings a commit home | `agent collect`: false falls back to the profile's fetch template, and refuses when the host has none |
| link `fits` | the size limit on a script | the remote brief file and every worktree script, before the call |
| link `slots` | who counts connection slots | `admit` runs only for `"mu"` |
| link `remoteOnTimeout`, `quiescence` | what a timeout leaves behind; whether a scan can see the job's processes | worktree close: `unprovable` refuses removal without `--force` |
| host `deadlineAt`, `idleReclaimMs`, `maxJobs` | provider facts | spawn's atomic admission (`maxJobs`, the deadline margin) and the host policies (D10) |

### D13. The plugin protocol

**Transport layer.**

- JSON-RPC 2.0, one JSON object per line on the plugin's stdin and stdout,
  UTF-8, at most 1 MiB per message.
- stderr is drained into a bounded buffer and never parsed. Its first line
  may appear in an error message, and it is never stored.
- The framing and validation are hand-rolled, like `src/ctl/protocol.ts`.
  No dependency is added.

**Process.**

- mu starts the plugin the first time an invocation needs it. The plugin
  is mu's child, in its own process group, and lives no longer than that
  invocation.
- **On stdin EOF** (mu exited, or was SIGKILLed), the plugin cancels or
  finishes its in-flight calls within `HOST_GRACE_MS` (5 s,
  `src/hosts.ts:888`) and exits. The contract suite kills mu's side
  mid-call and checks that the plugin's group is empty after the grace.
- At a normal exit mu sends `shutdown`. After `HOST_GRACE_MS` it kills the
  group.
- A plugin never detaches a helper (`setsid`, a double fork) and leaves no
  local process behind. The same contract test checks this.
- The plugin's group id and start time are recorded with each effect
  intent (D4).
- When the link declares `slots: "mu"`, the plugin's group is the one
  recorded on the host channel row (`src/hosts.ts:857`).

**Handshake.**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"mu":"4.6.0","seams":["link","job"]}}
{"jsonrpc":"2.0","id":1,"result":{"protocol":1,"plugin":{"name":"mule","version":"0.5.0"},"instance":"9f2c…","schema":"sha256:…","seams":{"link":{"fetch":false,"maxScriptBytes":131072,"slots":"self","remoteOnTimeout":"stopped","quiescence":"provable","checks":true},"job":{"kind":"lease","view":"bound","handle":"file","lookup":true,"fenceKey":false,"inFlightMs":30000,"checks":true}}}}
```

These mismatches refuse at load with `PluginRefusedError` (exit 4), and
nothing runs:

- a protocol range with no overlap;
- a seam the registration needs but the plugin does not implement;
- a missing mandatory method: `status`, and `lookup` or dedupe where D4
  requires one;
- an inconsistent capability set (`acknowledged` with `self-starting`);
- a schema digest that does not match the protocol version.

`instance` names the backend configuration the plugin addresses. mu
records it on every job record and host record as the stop and release
fence, as `host_stop` is today. A stop or release under another instance
refuses with `stop-changed`. A plugin upgrade inside one protocol version
keeps live jobs stoppable.

**Methods.** These mirror D6–D9 one to one; checks are `link.checkSteps`
and `job.checkSteps`. Every effect method carries `key`, and every call
carries `deadline`. Every channel and job method carries `target`: the
agent's workstream, name and registry incarnation, plus `job: {kind, key,
handle}` and `host: {name, handle}`.

| Method | Params beyond `target`, `key` and `deadline` | Result |
| --- | --- | --- |
| `host.acquire`, `host.lookup`, `host.status`, `host.release` | as D6 (`spec`, `fence`, `handle`) | as D6 |
| `link.fingerprint`, `link.fits`, `link.exec`, `link.fetch`, `link.checkSteps` | as D7 | as D7 |
| `job.identity`, `job.start`, `job.lookup`, `job.status`, `job.stop`, `job.attach`, `job.checkSteps` | as D8; `start` takes the whole `JobSpec` | as D8 |
| `channel.readStates`, `channel.baseline`, `channel.receipt`, `channel.reconcile`, `channel.lastRun` | as D9 | readings and observations; observations carry `cause` |
| `channel.watch` | `afterRuns?`, `inc?` | `{watchId, initial, afterRuns?}`, then one notification (below) |
| `channel.send` | `text`, `msgId` (always minted by mu), `mode: "followUp" \| "steer"`, `force`, `firstPrompt`, `expectIncarnation?` | `SendResult` |
| `channel.fresh` | `text`, `msgId`, `force`, `expectIncarnation?` | `SendResult` |
| `channel.command` | `name`, `instructions?`, `force`, `expectIncarnation?` | `SendResult` |
| `channel.interrupt` | `text`, `msgId`, `timeoutMs`, `expectIncarnation?` | `InterruptResult` |
| `channel.abort` | `timeoutMs` | `AbortOutcome` (`onAbort` becomes the `aborted` flag; mu logs it) |
| `channel.answer` | `keys`, `force` | `AnswerResult` |

A capability that is false or `none` means mu never calls that method,
and refuses at the verb with the typed error the built-ins use today.

**Timeouts and cancellation.**

- mu enforces each call's deadline locally. Defaults: `link.exec` takes
  the caller's `timeoutMs`, else `HOST_COMMAND_TIMEOUT_MS` (20 s,
  `src/hosts.ts:885`). Reads take 10 s. `host.acquire` takes 10 min.
  `channel.watch` has no deadline of its own; `mu wait --timeout` and the
  D10 timer bound it.
- On expiry or SIGINT, mu sends the `$/cancel {id}` notification, waits
  `HOST_GRACE_MS`, then kills the group.
- A cancelled read is `unknown`. A cancelled effect is `unknown-outcome`
  (D4).

**Typed errors.** Every JSON-RPC error carries `data.kind`:

| `kind` | Means | mu does |
| --- | --- | --- |
| `retryable` | nothing happened; trying again may work | retries with the same key, at most three times; otherwise surfaces it (exit 5) |
| `permanent` | nothing happened; trying again will not work | surfaces it, exit 5 (the "remote host" lane, `src/cli/handle.ts:690-691`) |
| `human` | a person must act (`data.remedy`) | `HostHandbackError`, exit 5 (`src/cli/handle.ts:693-695`); never retried, never recorded as `human-needed` |
| `unknown-outcome` | the effect may have happened | leaves the intent; `EffectOutcomeUnknownError`, exit 1 (the delivery-unknown lane, `src/cli/handle.ts:616-618`); the next touch reconciles (D4) |

A malformed message, an unknown method or a reply that fails validation
counts as `unknown-outcome` for an effect and `unknown` for a read. The
plugin is then marked broken for the rest of the invocation.

**Streaming watch.**

1. `channel.watch` returns `{watchId, initial, afterRuns?}`.
2. The plugin later sends one notification: `watch/settled {watchId,
   observation}` (the observation carries `cause`), or `watch/restarted
   {watchId, incarnation}`. The latter is today's fatal rejection of
   `settled`.
3. mu ends a watch with `$/cancel`. The answer is then `unknown`, never
   dead.

A watch lives only inside the one mu invocation that asked, like ctl's
blocking `wait` (VISION constraint 4).

**Schema publication.**

- The protocol is published as `docs/reference/plugin-protocol.md` (the
  normative prose) plus `schemas/plugin-protocol-v1.json`, which ships in
  the package's `files`.
- mu's hand-written narrowers and the JSON Schema are checked against the
  same fixture messages (`test/plugin-schema.test.ts`), so neither can
  drift alone.
- The protocol version rises only on an incompatible change. An additive
  field rises nothing.
- Skew tests run the fake plugin speaking protocol 0, 1 and 2 against mu
  (`test/plugin-skew.test.ts`). A plugin built against an older mu runs
  the newer contract suite in CI.

### D14. Registration, trust, env and secrets

**User-configured, never discovered.**

- `mu plugin add <name> <absolute path>` records a plugin. Its basename
  must be `mu-plugin-<name>`.
- `add` runs the handshake once and stores the `plugins` row.
- `mu plugin list` and `mu plugin rm` complete the set. `rm` refuses while
  any host record, profile, job record or agent names the plugin.
- A profile or host names its plugin explicitly: `mu host add … --plugin
  <name>` or `mu host acquire … --provider <name>`.

mu never scans `PATH`, a directory or a package for plugins. This matches
`mu host add` (D18): registrations are machine-local rows made by a verb,
not a config file.

**Trust.** A plugin runs with the user's privileges, as a host template
does today. mu refuses:

- a path that is not absolute;
- a file that is group- or world-writable, or not owned by the user;
- a symlink to either.

mu does not hash the binary: upgrades are expected, and `instance` is the
fence that matters (D13).

**Env.**

- The plugin process gets mu's environment minus `LOCAL_ONLY_ENV`
  (`src/remote-agent.ts:573`) and every `MU_DB_PATH`, `MU_STATE_DIR` and
  `MU_SYNC_DIR`. It has no path to mu's DB or state, and needs none: the
  target carries the identity it needs (D13).
- An agent's env crosses the protocol as a structured map, restricted to
  `HOST_ENV_KEYS` (`src/hosts.ts:392-400`), which has seven keys; the
  header comment that says "five" (`:40`) is fixed in P2. mu refuses any
  other key before the call, as `hostEnvWords` does (`:408`).
- Those keys are identity, not secrets: the agent's name and workstream
  rightly come back in observations (`src/agents/observe.ts:36-40`).

**Secrets.**

- mu stores only typed reply fields: handles, `JOB_HANDLE_RE`-shaped
  (`src/hosts.ts:206`); keys; states; facts; the instance.
- Free text (`message`, `detail`, `remedy`) is shown in error lines, first
  line only, capped at 400 characters, and stored only where today's code
  already stores a reason (`carrier_jobs.reason`).
- Request bodies are never logged.
- The contract suite starts the plugin with a canary variable in its own
  environment (`MU_PLUGIN_CANARY=<random>`) and fails it if the canary's
  value appears in any reply, message or stderr line. That is the
  stand-in for a credential the plugin holds.

### D15. mule, the first out-of-process plugin

mule is already an external executable that mu drives through templates
(`src/hosts.ts:324-337`). mu reads the exit codes of its templates: 3 is a
hand-back (`src/hosts.ts:924-929`), and only 0 proves a stop
(`src/carrier-stop.ts:109-115`). Of the lease pane, mu reads no exit code,
only liveness (`mule/SPEC.md:102`). The mule plugin implements the link
and the `lease` job kind, with check steps on both. It is not a host
provider: it never opens or provisions machines (`mule/SPEC.md:505`).

What mule already guarantees:

- **An idempotent, proving stop.** `rm <id>` exits 0 only on proof that
  the sessions and the state directory are gone, and a missing job also
  exits 0 (`mule/SPEC.md:366`).
- **A write-ahead handle.** The id is written to the job file before
  dispatch (`mule/src/lease.rs:329-345`).
- **An attach that never replaces the job file.**

**The gaps.** No shim can close these; mule must change.

| Gap | Today | mule adds (P7) |
| --- | --- | --- |
| A status mu can trust | `poll --json` has four states: running, done, orphan, missing (`mule/src/cli.rs:799-805`). But `missing` exits 1 as an error (`:758-760`). The probe uses `has-session` and `[ -d ]` (`mule/src/probe.rs:89-90`), which mule's own spec says confuse a protocol mismatch with absence (`mule/SPEC.md:366`). | five states, with exit 0: running, done, orphan, `missing` (proven by `rm`'s absence checks) and `unknown` (anything those checks cannot verify) |
| A caller key | ids are generated (`mule/src/wrapper.rs:294`) and caller names are rejected (`mule/SPEC.md:517`). A re-dispatch is not idempotent. | `run --lease --key K`: K is stored as `$d/key`, and a dispatch whose key exists returns that job. The key is not a name: the id stays generated, so mule's reason for rejecting names still holds. The job file stays the far side's write-ahead. |
| Listing mu's own jobs | no local index (`mule/SPEC.md:521`); `--human` strips `MU_AGENT_NAME` (`mule/src/wrapper.rs:108-109`) | `ls --json --key-prefix P` and a `key` field in the JSON |
| Cancellation that leaves nothing behind | on a signal, `mule exec` detaches its cleanup with `setsid` and exits without waiting (`mule/src/exec.rs:326-336`, `mule/src/cleanup.rs:213-230`) | under `mule plugin`, a cancelled exec runs its `rm` in the plugin's own group within mu's grace, then reports `remoteOnTimeout: "stopped"` or an unknown outcome. It never detaches. |
| Host lifecycle | mule never opens a master or provisions a host | nothing: mule reports facts. `host info --json` with `master: false` becomes a `needs-human` check step with its `remedy`. Static profiles stay the provider. |

**What a shim can do**, so the plugin can be a thin `mule plugin`
subcommand that reuses mule's `Transport`, probe and remove code:

- `job.stop` maps to `rm`;
- `job.attach` maps to `run --lease --attach`;
- `link.exec` maps to the exec path, with exit 7 mapped to `partial`;
- exit 3 maps to `human`;
- the master check maps to `host info --json`.

mule is not a daemon (`mule/SPEC.md:547`). The plugin process is mu's
child for one invocation, and it never supervises, retries a dispatch or
watches.

**Capabilities mule declares:**

- link `fetch: false` (`mule/SPEC.md:541`), `slots: "self"` and
  `quiescence: "provable"`;
- job `view: "bound"`, `handle: "file"`, `lookup: true` and `inFlightMs`
  equal to its dispatch timeout.

Its view stays interactive (D3). There is no detached lease (D18).

**Profile migration.**

- `mu host add <h> --plugin mule` keeps the templates `hostMuleStarter`
  prints, so a released build still works with the profile (D5).
- A reservation recorded before the plugin was used has a `host_stop`
  equal to the profile's `stop`. The plugin stops it with `mule rm` on the
  same handle: the same effect.
- A generator that rewrites profiles with `mu host rm`/`add` keeps working
  as long as it writes the same templates. The byte fence is unchanged
  (`src/carrier-stop.ts:88,97`).

### D16. Proof: contract suites and fault injection

**One contract suite per seam**, run against every implementation:

| Suite | Built-ins | Plugins |
| --- | --- | --- |
| `test/host-provider-contract.test.ts` | `static` | the fake plugin; any provider plugin, in its own CI |
| `test/link-contract.test.ts` | `template` over `test/_fake-remote-node.ts`, `checkSteps` included | the fake plugin; mule (P7, in mule's CI against a test host) |
| `test/job-contract.test.ts` | `pane`, `lease` (over `test/_carrier.ts`), `gate` | the fake plugin (bound and detached); mule |
| `test/channel-contract.test.ts` (extended) | `ctl`, `hooks`, `mux`, pi on `hooks` | the fake plugin (`on-delivery` and `self-starting`) |

Each suite asserts:

- the declared capabilities;
- that a refusal is typed;
- that `status` and `lookup` never throw for "cannot tell";
- that dedupe makes one effect, counted by the fake backend;
- the EOF and no-detach process rules (D13);
- the secret canary (D14).

The fake plugin (`test/_fake-plugin.mjs`) is a real executable that speaks
the protocol over stdio, backed by a JSON file. It can be told to fail at
any fault point. The suites are exported (`@mu-crew/mu/contract`), so any
plugin runs exactly the same assertions.

**Fault injection.** `test/plugin-faults.test.ts` drives the fake plugin
and the built-ins through each point. The pass criterion is the same at
every point: replay yields exactly one effect, and reconcile converges.

| Point | Injected | Must hold |
| --- | --- | --- |
| F1 | mu killed after the intent commits, before the call | the next touch reconciles; `none` is accepted only under the D4 gate; one start |
| F2 | the plugin killed mid-call | `unknown-outcome`; nothing resent outside dedupe; the reconciler decides |
| F3 | mu killed after the plugin applied the effect, before the reply is recorded | `lookup` finds it, or a deduped resend returns it; it is recorded; no second effect |
| F4 | the reply is lost (stdout closed) | as F3 |
| F5 | timeout, then a late reply | `$/cancel`; the group is killed; `unknown-outcome`; the late reply is ignored |
| F6 | `retryable` twice, then success | one effect under one key |
| F7 | mu SIGKILLed mid-call; the plugin sees EOF | the plugin exits within the grace; its group is empty; the late effect is found by the next reconcile |
| F8 | two mu processes reconcile one intent | one wins the `resolving` claim; the other refuses naming it; one effect |
| F9 | `lookup` answers `none` while the creator lives, or inside `inFlightMs` | treated as `unknown`; nothing deleted, nothing started |
| F10 | the plugin replaced between start and stop with a different `instance` | the stop refuses `stop-changed` |
| F11 | the host is `gone` during close | the job reads `lost`; the release waits for close or abandon |
| F12 | a self-starting channel wakes a turn after a send's intent | the receipt stays unknown unless the msgId is reported; the wait pinned by the send does not fire on the woken turn |

The crash points between mu's steps are seeded the way
`test/spawn-receipts.test.ts:582` ("a receipt left in each stage") seeds
them today: the journal is written in the intermediate state and the next
verb is run. A crash inside the plugin is a SIGKILL of the fake plugin's
group.

### D17. The pledge amendment

The user approved amending ROADMAP's plugin-runtime pledge
(`docs/ROADMAP.md:37`) and VISION's "no plugin system"
(`docs/VISION.md:184`) on 2026-11-07. Both are amended.

**What changed.** mu may drive an external executable over a versioned
stdio protocol, for exactly four seams: host provider, link, job kind and
agent channel.

**Still refused:**

- discovery of any kind;
- loading third-party code into mu's process;
- a resident plugin host or daemon;
- plugins that add verbs, flags, tables, wait events or op kinds;
- plugins that write mu's DB or state;
- RPC into mu;
- a verb registry;
- a seam with fewer than two real implementations.

VISION's idempotency gap (`docs/VISION.md:359`) is amended in P6b, once
plugin effects carry keys. A plugin's watch fits VISION constraint 4 as
written: it is a child's stdout inside one invocation.

### D18. Decided by the user

Draft 1 left seven questions open. The user decided them on 2026-11-09:

1. **Release.** A plugin that a real user runs counts as the second
   implementation of a seam; the contract suite's fake plugin does not.
   P1–P6d ship together as one minor release.
2. **Registration** is the `mu plugin add` verb writing a machine-local
   row, like `mu host add` (D14).
3. **One view pane per agent**, read-only on a plugin channel, is
   accepted for this version (D3).
4. **Collect at settle** runs inside `mu wait` (D10). It runs the
   operator's own template or plugin, as `mu agent collect` does, so mu's
   own process stays ssh-free (`docs/ROADMAP.md:139-141`).
5. **Static `host rm`** keeps today's behaviour under a running lease job
   (D6).
6. **mule's SPEC** takes the `--key`, five-state `poll` and `--key-prefix`
   amendments (D15). The user maintains mule.
7. **No detached mule leases** in this version (D15).

## Units

Each mu unit is under about a week. It ends green on the fast gate and on
the targeted slow gate for its area, and its "Accepted when" can fail.
P1–P5 change no behaviour: the tests that pin today's behaviour keep their
assertions, though their import paths may change. Each unit adds its
ARCHITECTURE row, VOCABULARY changes and CHANGELOG entry.

The order follows the surveys' blast-radius analysis:

- **P1, job liveness,** comes first. It is the largest change, and
  channels and hosts depend on it.
- **P2, the link,** wraps the single choke point, `runLeasedTemplate`. It
  introduces `HostView` with only the static fields.
- **P3** puts the provider behind that view.
- **P4, the channel registry,** needs P1's liveness for its fallback.
- **P5** composes host checks from the P2 and P1 methods.
- **P6a–P6d** add the plugin paths one seam at a time, ending with
  channels, the most delicate.

| Unit | Content | Accepted when | Pinned by |
| --- | --- | --- | --- |
| P1 | Job liveness. The `src/jobs/` cluster: `JobKind`, `JobRef`, `viewState`, `jobLiveness`, and the `pane`, `lease` and `gate` kinds. Every D8 site goes through `viewState` or `jobLiveness`. `runStop`, the job handshake and the lease reattach go behind the `lease` kind. No schema change, bound kinds only, close order unchanged. | `test/job-imports.test.ts` lists the D8 sites and fails if any calls `paneAlive`, `paneResult`, `paneUp` or `localPaneAlive` directly; reconcile's `listPanes` is allowed as view presence. `test/job-contract.test.ts` passes against `pane`, `lease` and `gate`, including a retained exited gate (present, `ended`). Every pinning test passes with its assertions unchanged. | `reconcile.integration`, `reconcile-race`, `close-proof.integration`, `close-unknown-probe`, `wait-dead-after-reap`, `agent-reaper-transactional`, `workstream-teardown-*` (6), `host-channels`, `lease-spawn`(+`.integration`), `lease-close`, `lease-reattach`(+`.integration`), `reap-lease-park`, `remote-gates`(+`.integration`) |
| P2 | Link and the worktree contract. Rename `Transport` to `SendChannel`. `HostLink` with the `template` built-in, `fits` and `checkSteps`. A minimal `HostView {name, profile, link}`. Every `runLeasedTemplate`, `runHostTemplate` and `withHostChannel` caller outside `hosts.ts` goes through the link. `RemoteReader` goes over the link. `remote-worktree.ts` is split out. Fix the stale comments at `src/hosts.ts:40,1274`. | An import test proves only `hosts.ts` and `host-link.ts` call those three functions. `test/link-contract.test.ts` passes against `template`. The remote tests are unchanged. `remote-agent.ts` is under 400 lines. | `host-channels`, `host-handback`, `host-profiles`, `hooks-remote`, `remote-gates`, `remote-task-brief`, `remote-spawn`(+`.integration`), `remote-prepare-lost.integration`, `remote-recovery`, `remote-recovery-close`(+`.integration`), `remote-collect`(+`.integration`) |
| P3 | Host provider. `HostProvider`, `resolveHost` over every state, the `static` built-in; `HostView` gains `provider`, `jobKind` and `record`. The `getHost` callers and the raw `host_profiles` reads in `reattach-check.ts` and `remote-recovery.ts` go through it. | `test/host-provider-contract.test.ts` passes against `static`. An import test fails on any `getHost(` or `host_profiles` outside the allowlist: `hosts.ts`, `host-provider.ts`, `cli/host.ts`, `db.ts` (DDL), `db-recovery.ts` (trigger SQL) and `host-harnesses.ts` (the probe compare-and-set). The pinning tests are unchanged. | `host-profiles`, `host-lease-profile`, `lease-spawn`, `lease-reattach`, `remote-spawn`, `remote-recovery`, `host-harnesses` |
| P4 | Open channel registry. `ChannelCaps` (`fence: sync \| none`, `turns`, `dedupe`) replaces `fence`; `reconcile`; `ack` and `baseline`; the registry lookup; `ChannelTarget.job`; `readChannelStates` per channel with `jobLiveness` as the fallback; capability checks at the D9 sites; the run-baseline rename. `spawn_receipts` is untouched. | `test/channel-contract.test.ts` asserts the D9 matrix for every built-in, pi on `hooks` included. `test/channel-imports.test.ts` fails on any channel-name comparison outside `src/channels/` except the D9 hooks-feature allowlist, pinned by file and line. Replay goes through `reconcile` with unchanged results. | `channel-contract`, `channel-imports`, `wait-action-steer`, `wait-action-receipts`, `wait-action-transport`, `close-notice`, `spawn-receipts`(+`-mux`, `.integration`), `channel-hooks-verbs`, `hooks-remote`, `next-recover` |
| P5 | Host checks composed from `link.checkSteps` and `jobKind.checkSteps` in D11's order. `HostCheckStep.step` becomes a string. The doctor's `lease-job` hint reads the job kind. | `host check` output is byte-identical on the fixtures, skips included (`handback`, no pi). | `host-check-lease`, `host-check.integration`, `lease-job-doctor`, `host-harnesses` |
| P6a | Protocol core and the link adapter. Framing, the process manager (EOF, group, cancel), the handshake; `plugins`; `mu plugin add`/`list`/`rm`; `host_profiles.plugin`; the schema doc and JSON; the fake plugin's link. | `test/link-contract.test.ts` passes against the fake plugin, the process rules and the canary included. `test/plugin-schema.test.ts` and `test/plugin-skew.test.ts` pass. With no plugin registered, the full suite is unchanged. | `db`, `entities`, `loop-storage` (`test/fixtures/v13-populated.db.gz`), `host-profiles` |
| P6b | Job adapter. The `carrier_jobs` columns; plugin job kinds (bound); the D4 reconciler (`resolving` claim, the `none` gate, deduped resend); the VISION:359 amendment. | `test/job-contract.test.ts` passes against the fake plugin's bound kind. `test/plugin-faults.test.ts` passes F1–F10 for jobs. | `carrier-jobs`, `leftovers`, `lease-*`, `reap-lease-park`, `rebuild` |
| P6c | Provider adapter and host policies. `hosts`; `mu host acquire`/`drain`/`release`/`--abandon`; atomic admission; the recovery provider branch and the name rule; `collectAtSettle` (`agents.collect_due`) and `deadlineNotice` with the wait timer. | `test/host-provider-contract.test.ts` passes against the fake provider. F1–F11 pass for hosts. `test/host-policy.test.ts`: one collect per settle; a crash between the steps leaves `collect_due` and a notice; a spawn inside the margin is refused; a fully watched `mu wait` fires `deadline` on its timer; never a close. `scripts/skew-released.sh` (slow gate) installs the latest released mu in a temp prefix, opens a fixture DB with provider hosts and plugin jobs, and asserts the D5 table row by row: `openDb` succeeds, the fence holds, a released close keeps the reservation and parks the tasks, no stop runs on a provider host, and the file stays v13. | `remote-recovery*`, `remote-collect*`, `acceptance.integration` |
| P6d | Channel adapter and detached jobs. The channel methods (D13 table); `agents.plugin_channel`, `spawn_receipts.channel`; the spawn path for plugin channels (D8), tmux-only; detached views (reconcile asks liveness, close order, view reattach); turn cause. | `test/channel-contract.test.ts` passes against the fake plugin, `on-delivery` and `self-starting`. F12 passes. `test/job-contract.test.ts` passes for the fake detached kind. The skew script gains the D5 rows for plugin channels: a released send refuses on tmux, and a released replay stays unknown. `docs/reference/plugin-protocol.md` is complete. | `channel-*`, `spawn-receipts*`, `wait-*`, `reconcile*`, `lease-reattach*`, `acceptance.integration` |
| P7 | mule as a plugin, in the mule repo. `run --lease --key`; the five-state `poll --json` with exit 0; `ls --json --key-prefix` and the `key` field; a cancel that never detaches; `mule plugin` serving the link and the `lease` kind with check steps. In mu: `hostMuleStarter` output gains `--plugin mule`. | `cargo test` passes. mu's exported link and job suites pass against `mule plugin` on a test host. Kill the mu spawn between intent and handle, and `lookup(token)` recovers the job with one dispatch. A reservation made under the template is stopped by the plugin. | mule's own tests; mu's `scripts/smoke-lease.sh` against a test host, with the plugin registered |

P1–P6d release together (D18). If a unit runs past a week, it splits along
its seams, never by deferring its tests.

## Risks

- **Polling cost.** `mu wait` reconciles on every poll
  (`src/cli/wait.ts:146`). For a detached job, liveness is a backend round
  trip per tick per job. Mitigations:
  - a status younger than the poll interval is reused, as the remote
    reader does (`maxAgeMs`, `src/channels/types.ts:104-115`);
  - `watch: stream` channels avoid the poll.
- **Declared facts are trusted.** `dedupe`, `fenceKey`, `inFlightMs` and
  `quiescence` are a plugin's promises. The contract suite tests them only
  against the fake backend. A plugin that lies about them can cause a
  second effect or an unsafe removal.
- **Released builds and plugin rows.** D5's table rests on how released
  code behaves today. `scripts/skew-released.sh` is the check; it runs in
  the slow gate, against each new release.
- **Pane-id reuse.** Teardown relies on tmux never reusing a pane id
  (`src/workstream.ts:583`). Plugin handles carry no such guarantee, so
  every job-record write stays keyed by its token.
- **`carrier_jobs` holds non-carrier jobs,** and plugin-channel rows store
  `channel = 'mux'`, until the next major. VOCABULARY's **job record** row
  says so.
- **SDK exports.** `src/index.ts` exports host functions that P2 and P3
  move: `admitHostChannel` (`:313`), `runHostTemplate` (`:351`),
  `withHostChannel` (`:353`) and `closeRemoteWorktree` (`:463`). Each unit
  keeps or renames them in one commit, and its CHANGELOG entry says which;
  there are no forwarding wrappers.
- **The deadline margin is a guess.** A collect slower than the margin
  loses the last commits on a reclaimed host. The `deadline` event is
  urgent so that an orchestrator acts early.

## Out of scope

- An open `MuxBackend`, or any multiplexer plugin.
- Plugin verbs, plugin wait events, plugin tables.
- A remote write fence for plugin channels (D11).
- A provider or channel for any named vendor in this repo.
- The next-major rename of `carrier_jobs` to `jobs` and the state-dir
  move.
- Detached views for built-in job kinds, and detached mule leases.
- Plugin channels on herdr and Rex.
- Placement across hosts (muzzle's host integration is its own spec).

## Refutation round 1

Three fresh reviewers refuted draft 1 (`f1e092e0`), from three lenses:

- **facts** (F): every claim against the code;
- **correctness** (C): races, crashes, invariants;
- **plan** (P): buildability, unit boundaries, scope.

Each finding was reproduced against the cited file:line before it was
settled. Findings raised by two or more lenses are marked ⇄.

| ID | Sev | Lens | Finding (short) | Disposition | Where / evidence |
| --- | --- | --- | --- | --- | --- |
| F1 ⇄ | high | facts | `remote_recovery` triggers pin `host_profiles.exec`; provider-host recovery is uncollectable | fixed | D5 provider branch and name rule; `src/db-recovery.ts:82,94`, `src/remote-recovery.ts:344-363,414-419` |
| F2 ⇄ | high | facts | `hosts` lacks instance and spec digest | fixed | D5 `hosts` columns; D13 instance fence |
| F3 | high | facts | send, fresh, interrupt, abort, answer and commands have no journal | fixed (scope) | D4: they are not replayed; today's delivery-unknown rule stands (`src/agents.ts:708-726`, `src/agents/abort.ts:60-78`) |
| F4 | high | facts | the timeout guarantee overreaches; mule detaches its cleanup | fixed | D7 `remoteOnTimeout`, local-only guarantee; D13 no-detach; D15 gap row (`mule/src/exec.rs:326-336`, `mule/src/cleanup.rs:213-230`, `mule/src/transport.rs:432-438`) |
| F5 | high | facts | a fully watched wait never wakes for the deadline | fixed | D10 wait timer (`src/wait.ts:1450-1470`); P6c test |
| F6 ⇄ | high | facts | `channel.send`/`fresh` missing on the wire; prepare params | fixed | D13 methods table; prepare cut (D11) |
| F7 | high | facts | gate jobs have no `carrier_jobs` reservation | fixed | D1: the gate has no job record (`src/agents/spawn.ts:501-504`, `src/agents/lease-carrier.ts:180-182`) |
| F8 | high | facts | D11 host-check order is wrong | fixed | D11 order (`src/hosts.ts:1045,1094-1168`) |
| F9 | high | facts | the echo ban conflicts with identity fields | fixed | D14: identity keys allowed; secret canary instead |
| F10 ⇄ | medium | facts | a NULL channel can derive `ctl`, not `mux` | fixed | D5: store `channel = 'mux'` plus `plugin_channel` (`src/channels/select.ts:46-47`, `src/db.ts:1097`) |
| F11 ⇄ | medium | facts | bound-gate liveness is not `paneAlive` | fixed | D1 two reads and per-kind liveness; D8 table (`src/remote-agent.ts:667-671`, `src/agents/gate.ts:120-135`) |
| F12 | medium | facts | herdr cannot run a view command | fixed | D3 "Where a view can run" (`src/mux/types.ts:286-290`, `src/mux/herdr.ts:741-751`) |
| F13 | medium | facts | "mu reads none of mule's exit codes" overgeneralizes | fixed | D15 opening (`src/hosts.ts:924-929`, `src/carrier-stop.ts:109-115`) |
| F14 | medium | facts | "four-state poll" vs. the additions | fixed | D15: five states; `missing` exists but exits 1 (`mule/src/cli.rs:758-760,799-805`) |
| F15 | medium | facts | `EXEC_ARG_MAX_BYTES` measures the expanded argument | fixed | D7 `fits` (`src/agents/hooks-brief.ts:148-151`) |
| F16 | low | facts | `REMOTE_RM_RE` has 11 outcomes, not 12 | fixed | D7 (`src/remote-agent.ts:265-266`) |
| F17 ⇄ | medium | facts | the Goal and History named specific integrations instead of motivating with remote and elastic backends in general | fixed | Goal and History rewritten to the general motivation only |
| C1 ⇄ | high | correctness | `lookup` `none` is acted on with no creator-gone gate; a plugin outlives mu; racing reconcilers | fixed | D4 `none` gate, `resolving` claim, `pending`; D13 EOF; F7–F9 |
| C2 ⇄ | high | correctness | `remote_recovery` wedges recovery and release on provider hosts | fixed | as F1 |
| C3 | high | correctness | release and spawn are not atomic; `maxJobs` race | fixed | D6 atomic admission; D1 release row (`src/hosts.ts:781-816` precedent) |
| C4 | high | correctness | `resolveHost` returns only ready hosts | fixed | D6 `resolveHost` over every state, per-verb checks |
| C5 | high | correctness | no resend under dedupe; mandatory lookup | fixed | D4 resend rule: a deduped resend within the window is an ask; lookup or dedupe required |
| C6 | high | correctness | `acknowledged` receipts break when turns start on their own | fixed | D4 receipt rule; D9 `turns`, `cause`; F12 (`src/agents/task-spawn.ts:744-760`) |
| C7 | medium | correctness | collect-at-settle ordering, retries, no idle-reclaim notice | fixed | D10 `collect_due`, ordering, retry, work-at-risk notice |
| C8 ⇄ | medium | correctness | `hosts` lacks `instance` for the release fence | fixed | as F2 |
| C9 | medium | correctness | `handle.from = reply` cannot be enforced at load | fixed | D8 `JobCaps.handle` declared at the handshake |
| C10 | medium | correctness | an `acquiring` host stuck on `unknown` has no verb | fixed | D1: re-run `host acquire` resumes; `--abandon` from any state |
| C11 ⇄ | medium | correctness | NULL channel derives `ctl`; stall release on a live remote agent | fixed | as F10 (`src/wait-actions.ts:25-26`) |
| C12 | medium | correctness | a send into a read-only view is lost, not refused | fixed | D3 tmux-only plugin channels; D5 refusal (`src/channels/mux.ts:35-42`) |
| C13 | medium | correctness | crash after a plugin start leaves no row; a released build reaps a detached job | fixed | D1 "started, no agent row" leftover; D5 released-close analysis; P6c skew rows |
| C14 | medium | correctness | `$$` proves the scan ran, not that it sees the job's processes | fixed | D7 `quiescence` capability (`src/remote-agent.ts:288-294`) |
| C15 | medium | correctness | a plugin link's fingerprint vs. recovery pinning exec bytes | fixed | D7: a `--plugin` profile's fingerprint is its exec bytes; provider hosts take D5's branch |
| C16 | medium | correctness | stale rows after abandon and re-acquire; profile and host names not cross-fenced | fixed | D1 name rule; D5 cross-namespace fence |
| C17 | low | correctness | a released `mu rebuild` drops `hosts`/`plugins` silently | fixed (documented) | D5 table: a released build cannot be changed; release notes; this build lists both (`src/rebuild.ts:127-152,267-271`) |
| C18 | low | correctness | the plugin is not required to exit on stdin EOF | fixed | D13 process rules; F7 |
| P1 ⇄ | critical | plan | `channel.send`/`fresh` missing; prepare params incomplete | fixed | as F6 |
| P2 | critical | plan | a stateless plugin channel cannot identify the remote session | fixed | D9 `ChannelTarget.job`; D13 `target` (`src/agent-state.ts:48-53`, `src/agents/observe.ts:31-34`) |
| P3 ⇄ | critical | plan | `remote_recovery` wedges provider hosts | fixed | as F1 |
| P4 | critical | plan | no way to select a plugin channel at spawn; ctl handshake and anchor hardwired | fixed | D8 `caps.channel`, `JobSpec.harness`/`role`, spawn path (`src/agents/spawn.ts:680,969`) |
| P5 | high | plan | a read-only view breaks mule's TUI and paste delivery | fixed | D3 view input: read-only only on plugin channels (`mule/src/lease.rs:355`) |
| P6 | high | plan | P1 unbuildable: `jobLiveness` needs a `Db` the sites lack; reconcile; close order | fixed | D8 `JobRef`, `viewState`; reconcile kept as view presence; bound close order unchanged, detached order in P6d |
| P7 ⇄ | high | plan | the gate liveness contradiction would prune an exited gate | fixed | as F11 |
| P8 | high | plan | reattach refuses a live row and is hardwired to pi, lease and ctl | fixed | D3 detached reattach in P6d; today's reattach unchanged (`src/agents/reattach-check.ts:140-144`, `src/agents/reattach.ts:218-224`) |
| P9 | high | plan | P2 uses `HostView` before P3; P3's check misses readers | fixed | P2 minimal `HostView`; P3 allowlist and moved reads |
| P10 | high | plan | P4's name-branch check cannot pass: hooks-only features | fixed | D9 hooks-feature allowlist, pinned |
| P11 ⇄ | high | plan | a released close kills the view before the stop; `host_stop` NOT NULL | fixed | D5 released-close analysis (`src/agents/close.ts:540-573`); `host_stop = ''` |
| P12 ⇄ | medium | plan | motivation beyond remote and elastic backends in general | fixed | as F17 |
| P13 | medium | plan | over-build: two-phase fence, HostChecks, LifecyclePolicy, P6 size | fixed | D11: fence cut, HostChecks folded, policy interface cut, P6 split into P6a–P6d |
| P14 ⇄ | medium | plan | `lookup` `none` without a creator-gone gate | fixed | as C1 |

No finding was rebutted outright. Three were narrowed rather than built as
proposed:

- **F3:** non-replayed verbs need no journal; the existing
  delivery-unknown rule covers them.
- **C17:** a released build's behaviour cannot be fixed, only documented.
- **P13:** the fence was cut rather than simplified.

## History

- **Draft 1** (`f1e092e0`, 2026-11-09) started from a short decision
  sketch: three state machines, six seams, the plugin protocol and its
  proof. Five read-only surveys (job liveness, link and hosts, channels,
  mule, persistence) tested it against mu `42881032` and mule 0.4.0, and
  overruled it where the table at the top says.
- **Draft 2** (2026-11-09) settles the 49 findings of refutation round 1
  and the seven open questions (D18). It cuts the remote write fence, the
  host-checks seam and the policy interface, and splits P6 into four units.
  Every file:line in it was reopened at `42881032` (mu) and `1192781`
  (mule) while writing.
