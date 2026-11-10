<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# mu plugins: hosts, jobs, links, channels

Status: draft 7, refuted six rounds, pending final check. Written
2026-11-09. P1–P6a are built on `spec/mu-plugins`, and P6b (in review)
on its own branch. Draft 7's amendments name the built code each one
changes ([Refutation round 6](#refutation-round-6-backend-mapping)).
Six refutation rounds shaped it:

- **Round 1:** 49 findings, settled in draft 2.
- **Round 2:** 38 findings, plus the orchestrator's rulings R1–R7, settled
  in draft 3 ([Refutation round 2](#refutation-round-2)).
- **Round 3:** 27 findings (9 high), settled here with the smallest rule
  or column that closes each ([Refutation round 3](#refutation-round-3)).
- **Round 4:** one high and 13 mediums and lows, settled in draft 5
  ([Refutation round 4](#refutation-round-4)).
- **Round 5:** one high and three mediums. Ruling R8 replaced the collect
  sequence with a final-collect flag, settled in draft 6
  ([Refutation round 5](#refutation-round-5)).
- **Round 6:** a mapping onto a provisioning backend with session-hosted
  agents. Five accepted items are settled here
  ([Refutation round 6](#refutation-round-6-backend-mapping)).

The rulings changed the acceptance criteria. The spec is judged on design
soundness: its model, transitions, crash safety, schema, protocol and
capabilities. It must also be enough to write an out-of-process plugin
end to end without inventing contract
([End to end](#end-to-end-a-provisioning-backend)). Each unit's exact checks
belong in that unit's brief (R6).

The spec covers mu 5 and, for one unit (P7), mule.

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

Today's mu cannot express either:

- An agent's liveness is its pane's liveness.
- A host is a fixed template that never goes away.
- A crash between an intent and its effect is handled case by case.
- A backend that cannot say what state a job is in has no way to say so.

mu gets mu-owned state machines for hosts, jobs and turns, and one
TypeScript interface per seam. Today's code is re-expressed behind those
interfaces with its behaviour unchanged. External implementations
(**plugins**) speak a versioned JSON-RPC protocol over stdio, and mu drives
them through one built-in adapter. mule becomes the first plugin. The
plugin units ship as mu 5, in a new state directory (D5).

## Principles

1. **One interface per seam, two kinds of implementation.** Built-ins
   implement a seam in process. Plugins implement it through the adapter.
   If a built-in cannot live behind the interface, the interface is
   incomplete.
2. **mu owns the state machines; implementations report facts.** A plugin
   never writes mu's DB, its state directory or its log. Every effect
   returns facts, and mu records the transitions.
3. **Every plugin effect is written ahead, with its payload.** Before the
   call, mu records the intent, the exact request and a mu-generated key.
   After a crash, mu reconciles by one rule table (D4): ask, else resend
   the identical request under the same key where the plugin declares
   exact dedupe, else unknown until a human decides.
4. **Status is mandatory and truthful.** Every implementation answers
   "what is this host, job or turn now?". `unknown` is an honest answer.
5. **Capabilities have defined meanings and are enforced.** mu's verbs gate
   on declared capabilities. The contract suite checks that each
   implementation behaves as it declares.
6. **Behaviour is unchanged until the plugin units.** P1–P5 move code
   behind interfaces, and their tests keep their assertions. P6a moves the
   state directory. P6b–P6e add the plugin paths. Built-in hosts, jobs and
   channels behave as they do today throughout.
7. **A seam opens only where two real implementations need it.** A
   built-in plus a plugin that a real user runs counts as two. The
   contract suite's fake plugin does not count. Nothing gets an interface
   for one implementation. `MuxBackend` stays closed.

## Where the surveys overrode the sketch

Draft 1 started from a short decision sketch. Five code surveys of mu at
`42881032` and of mule 0.4.0 tested it. Where a survey contradicted it,
the survey won:

| Sketch said | Code says | Chosen |
| --- | --- | --- |
| A Transport seam: `exec`, `fetch`, `push`, and a worktree contract | "transport" already names a profile's `session`/`lease` (`docs/VOCABULARY.md:251`, `src/hosts.ts:199`) and a channel alias (`src/agents/transport.ts:29`). `push` has no call site. mule forbids bulk transfer on its connection (`mule/SPEC.md:541`). | The seam is the **link**: `exec`, plus an optional `fetch`. The worktree contract is mu's own scripts over `exec` (D7). Round 6 adds an optional `push`, whose call site is a spawn on a provider host (G3). |
| `start` returns a handle mu records | A lease carrier publishes its handle from inside mu's pane, through a file mu polls (`src/agents/lease-carrier.ts:248`) | Each job kind declares where its handle comes from: the pane, a file, or the reply (D8). |
| Persisted job states | ROADMAP rejects runtime agent state in `mu.db` (`docs/ROADMAP.md:146`) | mu persists only the transitions it makes. Liveness is asked at read time (D1). |
| The pane becomes only a view | mule ties a lease job to its pane by design (`mule/SPEC.md:102`). Every agent row needs a pane (`src/db.ts:1098`). | Every agent keeps a view pane. A view is `bound` (built-ins and mule) or `detached` (plugin kinds only) (D3). |
| Two job built-ins | The command gate is a third job kind, with its own exit status (`src/agents/gate.ts:120-135`) | `pane`, `lease` and `gate`. The gate has no job record (D1). |
| A key per effect | `carrier_jobs.token` is generated (`src/carrier-jobs.ts:125`) but never sent. mule rejects caller-chosen ids (`mule/SPEC.md:517`). | Keys and payloads are persisted in `effects` and sent from P6c on. mule gains `--key` in P7 (D4, D15). |
| `fence` is a remote callback | ctl's fence runs synchronously immediately before the one write (`src/ctl/client.ts:166-180`) | Plugin channels have no write fence (D11). |
| `carrier_jobs` and `remote_recovery` merge into new tables | Both are read on every close and delete path (`src/agents.ts:416-424`, `src/db-recovery.ts:76-100`) | Both stay, with new columns. A new `hosts` table holds provider hosts (D5). |
| Lifecycle hooks and doctor steps are seams | Collect and close are mu's own effects. Host checks have one entry point (`src/hosts.ts:1018`). | Two mu-owned host policies (D10). Check steps are phased methods on the link and the job kind (D11). |
| `capacity()` | `max_sessions` counts connection slots, not jobs (`src/agents/spawn-remote.ts:178,194`) | The link declares who counts connection slots. The provider reports job slots, which spawn checks atomically (D6). |
| Run states | Readings also carry `unknown` (`src/agent-state.ts:11`), `idle?`, `queued` (`src/channels/dispatch.ts:94-110`). "run" already names the executor's charge (`docs/VOCABULARY.md:242`). | The machine is the **turn** (D1). |

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

| Transition | Triggered by | Persisted |
| --- | --- | --- |
| → `acquiring` | `mu host acquire <name> --provider <p> [--param k=v]… [--repo <path>]`. It refuses a name that a profile or another record holds, and `mu host add` refuses a name a host record holds. `resolveHost` refuses a name found in both tables, as a defence. | The record (name, provider, params, repo, creator pid and start time) and its `host.acquire` effect (D4), in one immediate transaction. |
| `acquiring` → `ready` | the `acquire` result, recorded by the caller or by a later reconciler (D4) | handle, instance, `deadline_at`, `idle_reclaim_ms`, `max_jobs` |
| `acquiring` → deleted | a `permanent` or `retryable` error (nothing happened), or a `lookup` answer of `none` under the D4 gate | an event in the log |
| `acquiring` stays | the effect is unresolved | nothing. Running `mu host acquire <name>` again reconciles the same effect. It never acquires a second host. |
| `ready` → `draining` | `mu host drain`, or the deadline margin (D10) | `state` |
| `ready`/`draining` → `lost` | a `host.status` answer of `gone` while mu has not released the host. mu asks `status` in three places: the host verbs (`list`, `drain`, `release`); once, before reporting it, after any failed or timed-out link or job call on a provider host, so that a close on a reclaimed host takes the `lost` path; and the D10 reads, at most once per poll interval per host. | `state`, `reason`. `gone` is the provider's proof that the machine and its worktrees no longer exist, and its jobs too unless their kind declares `outlivesHost` (D6, D8). So on a `lost` host `agent close` records the remote tree as gone. It records the job as stopped without calling the host only for a kind without `outlivesHost`. For an `outlivesHost` kind it still runs the `job.stop` effect and waits for its proof, and mu refuses new deliveries to the agent, so the job takes no turn mu cannot collect. A job whose final collect (D10) is still owed is marked lost with reason "uncollected work". Its record goes only by `--abandon-job` or `host release --abandon`, which log the loss. |
| `draining`/`lost`/`releasing` → `releasing` | `mu host release`. Its immediate transaction proves that no agent row, job record or `remote_recovery` row names the host. It then records the `host.release` effect. Re-running it on a `releasing` host reissues the release. | `state`, the effect |
| `releasing` → deleted | `release` returns. `release` is idempotent, so a reconciler reissues it (D4). | an event in the log |
| any → deleted | `mu host release <name> --abandon`, a human decision, logged in one op group. It refuses while any agent row names the host, and while any effect on the host or its jobs is held by a live creator or resolver (D4). Otherwise it deletes the job records, recovery records and effect rows naming the host in the same transaction: a host one abandons is gone, and so is its work. | the event names every dropped record and every unresolved effect key, so a human can look a late result up by key. It names each dropped `outlivesHost` job as possibly still running. |

A spawn reserves inside an immediate transaction that re-checks
`state = 'ready'` and counts against `max_jobs` (D6). A spawn and a
release therefore cannot both pass.

#### Job

One agent's process. Each job has a **job kind** (D8):

- `pane`: today's local and `session` panes;
- `lease`: today's carrier;
- `gate`: a command gate on a session profile;
- one kind per job plugin.

A pane job or a gate job on a static host has no job record. Its agents
row is the record: its pane id is the handle, plus the `gate_token` for a
gate. A lease job and every job on a provider host have a **job record**,
a `carrier_jobs` row (`src/db-carrier.ts:23-43`).

| Transition | Triggered by | Persisted (today's code where it exists) |
| --- | --- | --- |
| → `reserved` | spawn, under the agent lock, before any effect (`src/agents/spawn.ts:503`) | the row, an immutable token (`src/carrier-jobs.ts:114-125`), the host and the stop identity. The row is the name fence (`src/agents/lease-carrier.ts:174`, `src/agents.ts:416-424`). |
| `reserved` → `launching` | spawn, just before the start effect (`src/agents/spawn.ts:842`) | `launch = 'intent'`. For a plugin kind, also the `job.start` effect with its full `JobSpec` (D4). |
| `launching` → `started` | the job handshake (`src/agents/lease-carrier.ts:248`), the `start` result, or a reconciler (D4) | the handle (`src/carrier-jobs.ts:265`), the view pane, the agent |
| `reserved` → deleted | rollback while `launch` is still `none` (`src/agents/lease-carrier.ts:317`) | — |
| `launching`, no handle | the pane died first, the deadline passed, or the job file is unreadable (`src/agents/lease-carrier.ts:265-297`) | nothing. For `handle: "file"` kinds today's rule stands: the reservation is released only as provably unlaunched (`src/agents/lease-carrier.ts:431-432`). For `handle: "reply"` kinds, D4 applies. |
| `started`, start effect resolved, pane spawn failed | `mux.spawnAgent` threw after the handle arrived | the rollback stops the job by its handle (`job.stop`) before releasing. Today's lease rollback needs a pane id (`src/agents/lease-carrier.ts:356-358`); that rule stays for `handle: "file"` only. |
| `started`, no agent row | mu died after the handle and before the agent row, or the row was reaped | a **leftover**, as today. `agent close` stops it through its kind and closes the remote tree the job record names (`tree_path`, `tree_base`). A no-row plugin leftover is closed, never reattached (D3). |
| `started` → `stopping` | `agent close`: after the view proof for a bound view, before touching the view for a detached one (D3) | the `job.stop` effect |
| `stopping` → deleted | `stop` proves the job gone; the final collect runs (D10); then the job file and tree are cleaned up (`src/agents/lease-carrier.ts:590`) | the settle mode the reaper reads (`src/agents/reap.ts:55-78`) |
| any → deleted | `agent close --abandon-job` (`src/agents/lease-carrier.ts:466`), under the same live-owner refusal as host abandon | an event naming the handle and any unresolved effect key; the job's effect rows go with it. If the final collect was owed, the event records the loss. Abandoning the job does not abandon its tree: the tree's recovery record and the close rule (HEAD at its base or its collected head) still protect it. |

**Two reads**, never stored and never confused:

- **View presence** asks whether the pane exists: reconcile's `listPanes`
  (`src/reconcile.ts:113-142`), and the row rule in close and teardown. A
  retained gate pane whose command ended is present. For a bound kind,
  presence alone decides a ghost and a deletable row, as it does today.
- **Liveness** asks whether the job runs: `running`, `ended(exit)`,
  `lost(reason)` or `unknown(reason)`. It is answered per kind:
  - `pane`: `paneAlive` (`src/mux/types.ts:330`);
  - `lease`: `paneResult(...).state === "running"` (`src/remote-agent.ts:667-671`);
  - `gate`: the pane, then the host's completion record
    (`src/agents/gate.ts:120-135`);
  - plugin kinds: the job kind's `status`.

For a **detached** kind, reconcile asks liveness before it treats a row as
a ghost. mu never moves a job record on a reading alone.

#### Turn

One prompt-to-settle of an agent: what the channels count as `runs`.
`runs` is a dense count of the turns settled in the channel's
incarnation: 0, 1, 2, and so on, one per settle. It is never a backend's
sequence or run id (`src/next-recover.ts:157` subtracts one). Its states
are the channel readings:

- `idle` and `idle?` (unconfirmed after an interrupt, `docs/VOCABULARY.md`
  **idle?**);
- `running`, `queued` (in muzzle) and `blocked`;
- `settled(text, outcome)`;
- `unknown`.

**A turn starts only on delivery.** That holds for every built-in and is
required of every plugin channel (R1). A delivery is a channel send, or
the first prompt that the `job.start` of a `firstTurn: "at-start"` kind
carries (D8). A channel's reading is `running` from a delivery until the
turn it started settles. A turn is never
persisted. mu persists only what it consumed: the wait cursor's completion
token and the applied settle, keyed by registry id plus channel
incarnation (`src/db.ts:1243`, `:1272`).

#### Today's records under the model

| Record | Role |
| --- | --- |
| `agents` row | The agent. `pane_id` (NOT NULL, `src/db.ts:1098`) is the view, and for a pane or gate job also the handle. `channel` holds a registered channel name. |
| `carrier_jobs` | The job record of every lease job and every job on a provider host. `token` is the job key. It gains columns (D5). |
| `remote_recovery` | A remote worktree's record after its agent row is gone (`src/db-recovery.ts:76-100`). It blocks a provider host's release. From v14 it records the host's identity (D5). |
| `host_profiles` | The static provider's hosts, the template link and the job kind (`session` means `pane` or `gate`, `lease` means `lease`). It gains `plugin`. |
| `host_channels` | The link's connection slots, admitted by mu for links with `slots: "mu"` (`src/hosts.ts:781-816`) |
| `spawn_receipts`, `wait_action_receipts`, delegate states | Built-in delivery journals, unchanged |
| `effects` (new) | Every plugin effect's intent, request, key and resolver (D4) |
| `hosts`, `plugins` (new) | Provider hosts; plugin registrations (D14) |

### D2. Names

These enter `docs/VOCABULARY.md`:

- **link**, not "transport". "transport" stays the profile field. P2
  renames the `Transport` alias (`src/agents/transport.ts:29`) to
  `SendChannel`.
- **turn**, not "run". **run** stays the executor's charge.
- **job kind**, not "driver" or "backend".
- **effect** and **effect intent**, not "intent", which stays the op label.
- **plugin**, for a `mu-plugin-<name>` executable only. pi's are
  **extensions**.
- **capability**, not **host capabilities** and not a **role**.
- **write fence** and **run baseline**: two things the code calls "fence".
- **view presence** and **liveness**: the two reads.

### D3. Views

A job's **view** is the pane mu opens for it through
`MuxBackend.spawnAgent` (`src/mux/types.ts:323`). Every agent has one:

- **pane job:** the view is the job.
- **lease job:** the view is the carrier.
- **gate job:** the view is the foreground command.
- **plugin job:** the view runs the job kind's view command.

Every agent keeps a pane for two reasons. VISION's visible crews: each
agent sits in a pane you can attach to. And `agents.pane_id` is NOT NULL
and keys the pane-guarded writes of the agent and delivery tables
(`src/db.ts:1312`, `src/agents.ts:699-704`).

**Where a view can run.** A view command needs a backend whose
`spawnAgent` runs a command line (`runsShellCommand`,
`src/mux/types.ts:286-290`). herdr starts its own agent kinds instead
(`src/mux/herdr.ts:741-751`). A spawn whose job kind has a view command on
such a backend refuses before any effect, as `spawn --host` does on herdr
today.

**View input** follows the channel:

- **Interactive** for every built-in channel. `hooks` pastes, `mux` types,
  and a pi on `ctl` is a TUI a human may attach to. mule's carrier view is
  such a TUI (`mule/src/lease.rs:355`).
- **Read-only** for an agent on a plugin channel: stdin is `/dev/null`.
  Every delivery goes through the channel and its effects, never through
  keystrokes.

**Bound or detached** is the job kind's `view` capability:

- **Bound:** the view's death ends the job, or starts its stop. This holds
  for `pane`, `lease`, `gate` and mule (`mule/SPEC.md:102`).
- **Detached** (plugin kinds only): the job outlives its view.
  - reconcile asks liveness before it treats the row as a ghost.
  - `agent close` stops the job first and kills the view after, the
    reverse of the bound order (`src/agents/close.ts:540-573`).
  - `agent reattach` on a row whose view is gone calls `job.attach` and
    compares-and-sets `agents.pane_id`, keeping the incarnation. The row
    keeps everything a view needs (cli, role, command, channel).
  - A no-row leftover of a plugin kind is not reattached: nothing on the
    job record says how its agent was launched. `agent close` stops it and
    closes its tree (D1).
  - Today's lease reattach (`src/agents/reattach-check.ts:88-108`,
    `src/agents/reattach.ts:218-224`) is unchanged for lease jobs.

### D4. Crash safety: effects, payloads, one rule table

An **effect** is a plugin call that changes something outside mu's DB:

- `host.acquire` and `host.release`;
- `job.start` and `job.stop`;
- `channel.send`, `fresh`, `interrupt`, `abort`, `answer` and `command`.

Built-in effects keep their journals: `spawn_receipts`,
`wait_action_receipts`, the reservation's `launch`, and the delivery-unknown
rule for interactive sends. The plugin adapter adds one journal for plugin
effects. Built-ins do not use it.

**The `effects` row.** It is written in an immediate transaction, before
the call, together with the subject's own state change. Its columns are in
D5. It persists:

- `key`, mu-generated;
- `subject`: the host record, job record, or agent plus msgId;
- `method`, `params_json` and `params_sha`: the method's `params` object
  exactly as first sent. The JSON-RPC envelope (`id`) and the call's
  `deadline` are not part of it: every send, the first and any resend,
  gets a fresh id and a fresh deadline;
- `instance`: the plugin's handshake instance at intent time;
- the creator's pid and start time;
- the plugin process's group id and start time;
- `state`: `pending`, `resolving`, `unknown`.

A definite result is recorded on the subject, and the row is deleted in
the same transaction. Only unresolved effects stay.

**Reconcile.** After a crash, a timeout or an `unknown-outcome` error, the
next verb that touches the subject resolves the effect:

1. **Claim.** The verb compares-and-sets the row to `resolving`, with
   its own pid and start time. It may claim an `unknown` row, a
   `resolving` row whose resolver is proven gone, or a `pending` row only
   once the row's creator is proven gone. While the creator lives, the row
   is its own, and a second verb refuses, naming the creator's pid (a
   re-run `mu host acquire` during the first one's call says "in flight").
   The creator records its result with `WHERE state = 'pending'`; a
   resolver with `WHERE resolver_pid = me`. A loser's write changes
   nothing, so only one result is ever recorded.
2. **Fence on the instance.** If the plugin's current instance differs
   from the row's, the verb refuses (`stop-changed`). It never asks or
   resends to another backend configuration.
3. **Resolve by the rule table:**

| Method | Idempotent by contract | Resolve by, in order | If nothing answers |
| --- | --- | --- | --- |
| `host.acquire` | no | `lookup(key)` if declared; else a byte-identical resend if `dedupe: exact` and within its window | unknown until `--abandon` |
| `host.release` | **yes** (mandatory) | reissue the persisted request | — |
| `job.start` (`handle: "reply"`) | no | `lookup(key)`, whose `found` is the `JobStart` (D8); else a deduped resend. With `firstPrompt` (D8), this also resolves the first delivery: a found job proves its prompt accepted. | unknown until `--abandon-job` |
| `job.start` (`handle: "file"`) | no | the job file, as today; `lookup(key)` if declared, whose `found` fills the handle (`none` never acts) | today's unlaunched rule |
| `job.stop` | **yes** (mandatory) | reissue | — |
| `channel.send`, `fresh`, `interrupt` | no | `receipt(msgId)` if `receipt: exact` (only `accepted` resolves; `not-accepted` stays unknown, as today, `src/agents/task-spawn.ts:721-727`); else a deduped resend if declared for that method | delivery unknown, reported; until a human checks or closes |
| `channel.abort` | no | `readStates`: an idle agent means done | unknown, reported |
| `channel.answer`, `command` | no | a deduped resend if declared for that method | unknown, reported |

**A delivery is resent only if nothing newer was written.** Each agent
on a plugin channel has a durable delivery high-water mark,
`agents.delivery_seq`. Writing a delivery effect increments it in the same
immediate transaction and stores the new value on the effect row (`seq`).
The mark outlives the effect row, which is deleted once its outcome is
known. A `job.start` that carries `firstPrompt` is the agent's first
delivery: its row takes `seq` 1 and the prompt's `msg_id`.

- **Resend.** A deduped resend runs only if its claim transaction finds
  `effects.seq = agents.delivery_seq`. Otherwise the delivery stays
  unknown.
- **New deliveries.** Writing a new delivery refuses while another
  delivery to the agent is `resolving`, naming its key.

SQLite's write lock serializes both rules, so a stale instruction never
arrives after a newer one.

**When a lookup's `none` counts.** A `lookup(key)` may answer `found`,
`pending`, `none` or `unknown`. `found` is recorded, and `pending` and
`unknown` leave the row. `none` proves that nothing happened only when all
three of these hold; otherwise it is `unknown`:

1. The creator is proven gone, by pid and start time (as
   `src/agents/lease-carrier.ts:418-433` does today).
2. The plugin process group recorded on the row is proven gone, by group
   id and start time (as `groupAlive` does, `src/hosts.ts:688-695`). A
   plugin exits on stdin EOF (D13).
3. The plugin declares `fenceKey` and the lookup was asked with
   `fence: true`, or the declared `inFlightMs` has passed since the row
   was written.

`handle: "file"` kinds never act on `none`. Their dispatcher is the view
pane, not the plugin, so today's unlaunched rule decides
(`src/agents/lease-carrier.ts:431-432`).

**Load-time rules.**

- `host.acquire` and `job.start` with `handle: "reply"` must declare
  `lookup`, `dedupe: exact`, or both.
- `host.release` and `job.stop` must be idempotent.
- A plugin that breaks these is refused at load.
- A deduped resend sends the persisted bytes. The contract suite checks
  that a repeat within the window returns the first result and makes no
  second effect, counted by a fake backend.

**Who triggers.**

- the next verb on the subject. `agent close` on an unresolved
  dedupe-only `job.start` resends it and then stops the job: the resend is
  the only way to learn whether a job exists, and one start followed by a
  stop leaves nothing behind. For an `at-start` kind the resend may begin
  the first turn, and the stop ends it;
- `mu host acquire` or `release` re-run;
- `mu agent check <agent> <msgId>` for a delivery, and for an `at-start`
  kind's first prompt (D8);
- spawn replay, for a task-spawn delivery, whose spawn receipt names the
  effect's key as its `msg_id`. For an `at-start` kind the effect is
  `job.start`, found by the prompt's `msg_id`.

An unresolved delivery does not block later deliveries to the same
agent, as today's delivery unknown does not. Only one being resolved at
that moment does.

**Retries.** Only an error of kind `retryable` (nothing happened) is
retried, at most three times, with the same key and payload. `human` is
never retried.

### D5. Schema 14, state directory `mu5`, mu 5

**Decision (R2, a recorded default the user may overrule, D18).**

- The plugin units bump the schema to **14**. Every released build then
  refuses the DB (`SchemaTooNewError`, exit 4, `src/db.ts:440-455`), so
  nothing reasons about old builds reading new rows.
- By AGENTS.md "State directories" that is a break, so the state directory
  becomes **`mu5`** and the release is **mu 5**.

**The import.** On first open, when `mu5/mu.db` does not exist and
`mu-next/mu.db` does, mu imports once:

1. **Lock.** It takes the strict lock `mu5/locks/import`, made with
   atomic `mkdir` like the agent lock (`src/file-lock.ts`) and reclaimed
   only from a proven-dead pid. Parallel first opens are normal
   (`src/db.ts:136-147`): a second process waits for the lock, then finds
   `mu5/mu.db` and opens it. Only the lock holder may delete a leftover
   `mu5/mu.db.importing`.
2. It refuses if `mu5/mu.db` exists.
3. Nothing is checked on the source itself. Every check runs on the
   snapshot (step 5.3), so nothing mu 4 commits during the copy is missed.
4. It copies `mu-next/mu.db` with SQLite's backup API to
   `mu5/mu.db.importing`.
5. On the copy, three steps run in order:
   1. It sets a new `machine_id` (an `UPDATE`, since `seedMachineIdentity`
      does nothing on an existing row, `src/db.ts:426-431`). That way any
      op minted during the upgrade is mu 5's. mu 4 on `mu-next` and mu 5
      on `mu5` are then two sync peers, never sharing a segment.
   2. It runs today's v13 `upgradeSchema`, in its own transaction
      (`src/db.ts:477`).
   3. In one immediate transaction, it checks the snapshot and runs the
      13 → 14 step. The check refuses, and deletes the copy, in two cases:
      - **Unpublished ops.** When `MU_SYNC_DIR` is set, the copy holds an
        op under the old `machine_id` that is not yet in that machine's
        segment file. This is `mu doctor`'s `unpublished-ops`
        (`src/sync.ts:364-373`), checked against the snapshot, so an op
        mu 4 committed after the backup started is covered too. Segments
        publish only their own machine's ops (`src/segments.ts:248,477`),
        so mu 5 would never publish it. Fix: run `mu sync` with mu 4
        first. With no sync configured, that history stays local to the
        DB, so sync is configured before the import if peers need it.
      - **Live rows.** The copy has any `agents` or `carrier_jobs` row,
        or any `delegate_calls` row not in a final state. Those rows own files
      under `mu-next`: control sockets, job files, locks and delegate
      process files (`src/delegate-process.ts:124-136`). They are closed
      with mu 4 first.
6. It renames the copy to `mu5/mu.db` with a no-replace link (`link(2)`,
   then unlink the temporary name), and releases the lock.

`mu-next` is never written. The steps are not one transaction; the
copy is invisible until step 6, so the rename is the commit point. A
crash before it leaves only the `.importing` file, which the next lock
holder deletes and redoes.

**The 13 → 14 step.** Tables can now be rebuilt freely, with explicit
column lists:

- **`carrier_jobs`** gains `kind` (NULL: lease), `plugin`, `instance`,
  `host_id`, `tree_base` (with today's `tree_path`: the remote worktree
  the spawn prepared, written before `job.start`), `collect_repo`, and
  the final-collect columns `final_owed`, `stop_gen` and `collect_next_at`
  (D10), and, for an `at-start` kind, the first delivery's receipt
  `first_msg_id` and `first_inc` (D8). Those two are plain nullable
  columns. P6a built v14 without the `carrier_jobs` additions, so they
  join through `ADDED_COLUMNS` with no version bump (AGENTS.md).
  `host_stop` becomes nullable (it is a template's bytes, and a plugin job
  uses `instance`).
- **`spawn_receipts`** is rebuilt without its `transport` CHECK
  (`src/db-receipts.ts:42`), validated in code like `HOST_TRANSPORTS`.
  The rebuild lists its columns, never `SELECT *`.
- **`agents.channel`** holds any registered name. An unregistered stored
  name is a typed error from P6e on.
- **`remote_recovery`** gains `host_identity`, written by `_v3` triggers
  that replace the `_v2` ones (`src/db-recovery.ts:76-100`). It holds the host
  identity, in one of three forms:
  - a template profile: its exec bytes, as today;
  - a `--plugin` profile: `plugin:<name>:<instance>`;
  - a provider host: `provider:<hosts.id>:<hosts.instance>`. `assertRecoveryProfile`
  (`src/remote-recovery.ts:344-363`) compares it with the host's current
  identity. A host acquired again under the same name has a new id, so its
  identity differs and recovery refuses. Imported rows are backfilled with
  `host_identity = host_exec`, the bytes they already pinned.
- **`host_profiles`** is rebuilt with `plugin`, and with `shell` and `exec`
  nullable. A profile without `plugin` still requires both, checked in
  `addHost`. A `--plugin` profile stores neither: its link is the plugin,
  and its identity (the fingerprint and `host_identity`) is
  `plugin:<name>:<instance>`, from the registration current at the time.
- **`agents`** gains `delivery_seq` (D4), and `effects` gains `seq`.
- **New tables:** `hosts`, `plugins` and `effects`.

**Columns per table (R4).**

| Table | Columns |
| --- | --- |
| `hosts` | id, name UNIQUE, provider, `params_json`, `repo`, handle, `instance`, state CHECK (`acquiring`, `ready`, `draining`, `releasing`, `lost`), `deadline_at`, `idle_reclaim_ms`, `max_jobs`, `creator_pid`, `creator_start`, `reason`, `created_at`, `updated_at` |
| `effects` | `key` PK, `subject_kind` CHECK (`host`, `job`, `delivery`), `subject_id`, `msg_id`, `seq` (deliveries), `plugin`, `method`, `params_json`, `params_sha`, `instance`, state CHECK (`pending`, `resolving`, `unknown`), `creator_pid`, `creator_start`, `plugin_pgid`, `plugin_pgid_start`, `resolver_pid`, `resolver_start`, `created_at`, `updated_at` |
| `plugins` | name PK, `argv_json`, protocol, version, instance, `seams_json`, `caps_json`, `schema_digest`, `added_at`, `checked_at` |
| `carrier_jobs` | the additions above |

All new tables are machine-local (`MACHINE_LOCAL_TABLES`,
`src/db.ts:893-918`) and unrebuildable (`src/rebuild.ts:127-152`). None is
captured, so `CAPTURE_VERSION` is unchanged.

`ROADMAP.md`'s "Next breaking release" items may ride along in mu 5. They
are not part of this spec.

### D6. Seam: host provider

```ts
// src/host-provider.ts
export type EffectKey = string;

export interface Call {
  deadline: number; // epoch ms; past it mu cancels
  signal: AbortSignal;
}

export type KeyLookup<T> =
  | { found: T }
  | { pending: true }
  | { none: true }
  | { unknown: string };

export interface HostFacts {
  /** Opaque, JOB_HANDLE_RE-shaped (src/hosts.ts:206). */
  handle: string;
  deadlineAt?: number;
  /** The provider's idle-reclamation window, measured from the activity it counts. mu runs no timer from it. */
  idleReclaimMs?: number;
  maxJobs?: number;
}

/** `gone`: the machine and its worktrees no longer exist; its jobs too, unless their kind declares `outlivesHost`. */
export type HostStatus =
  | ({ state: "up" } & HostFacts)
  | { state: "gone"; reason: string }
  | { state: "needs-human"; remedy: string }
  | { state: "unknown"; reason: string };

/** Shared by every keyed seam: declared at the handshake (D13). */
export interface KeyCaps {
  lookup: boolean;
  dedupe?: { exact: true; windowMs: number };
  fenceKey: boolean;
  inFlightMs?: number;
}

export interface HostProvider {
  /** "static", or the plugin's name. */
  readonly name: string;
  readonly caps: { acquire: KeyCaps };
  acquire(params: Readonly<Record<string, string>>, key: EffectKey, call: Call): Promise<HostFacts>;
  lookup(key: EffectKey, opts: { fence: boolean }, call: Call): Promise<KeyLookup<HostFacts>>;
  status(handle: string, call: Call): Promise<HostStatus>;
  /** Idempotent: a host already released resolves. */
  release(handle: string, key: EffectKey, call: Call): Promise<void>;
}

/** What the rest of mu holds for `--host <name>`. P2 introduces it with name, profile and link; P3 adds the rest. */
export interface HostView {
  name: string;
  link: HostLink;
  provider: HostProvider;
  jobKind: JobKind;
  profile?: HostProfile; // static
  record?: HostRecord; // provider, any state
}

/**
 * A profile, or a host record in any state; a name in both refuses. Each verb checks the state it needs:
 * spawn needs `ready`; close, stop and collect accept `ready`, `draining`, `lost`;
 * release accepts `draining`, `lost`, `releasing`.
 */
export function resolveHost(db: Db, name: string): HostView;
```

**A provider host's link and job kind are its provider plugin's.** A
provider plugin must implement the `link` and `job` seams for the hosts it
provides; the handshake says so, or the plugin is refused for `--provider`.
`resolveHost` builds the view from `hosts.provider`.

**`gone` is a proof.** A provider answers `gone` only when the machine
and its worktrees no longer exist, and its jobs too unless their kind
declares `outlivesHost` (D8). Such a job, a session-hosted agent, may
survive its machine: `gone` then says nothing about it, and only its
`job.stop` proves it gone. The contract suite checks both against the
fake backend. D1's `lost` close relies on it.

**Idle reclaim.** `idleReclaimMs` is the provider's policy: how long the
host may sit idle, by whatever activity the provider counts, before it
may be reclaimed. It is not measured from anything mu observes. Since R8
mu runs no timer from it: a host that reports it gets in-life collects
(D10), and nothing reads its value.

**Atomic admission.** A spawn on a provider host reserves inside one
immediate transaction, the agent lock held. That transaction re-reads the
record, refuses unless `ready`, and counts the host's job records against
`max_jobs`. The precedent is channel admission (`src/hosts.ts:781-816`).

**Built-in `static`.**

- `status` answers `up` with no round trip.
- `acquire`, `lookup` and `release` refuse: static hosts are added and
  removed with `mu host add`/`rm`.
- `removeHost` keeps its rule (`src/hosts.ts:290-300`), as D18 decided.

**Second implementation.** The seam requires a provider plugin that a
real user runs (D18.1). This spec names none, and none is part of this
repo. mule is not one: it never provisions machines (`mule/SPEC.md:505`).

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
  fetch: boolean;
  /** Can seed a host's repo with a local commit (`push`). Absent: false. */
  push?: boolean;
  /** "mu": every call holds a host channel (src/hosts.ts:781). "self": the link arbitrates its connection. */
  slots: "mu" | "self";
  /** After a timeout: the remote script proven stopped, or possibly still running. */
  remoteOnTimeout: "stopped" | "unknown";
  /** Whether a scan over exec sees the processes the host's jobs run as (same user, same PID namespace). */
  quiescence: "provable" | "unprovable";
  /** Plugins: the largest script, in bytes. The template link measures the expanded argument instead. */
  maxScriptBytes?: number;
  /** The CheckContext phases this link contributes steps for (D11). */
  checks?: CheckPhase[];
}

export interface HostLink {
  readonly name: string; // "template" or the plugin
  readonly caps: LinkCaps;
  /** Computed by mu, never a wire call: the D5 host identity (template profile: exec bytes; `--plugin` profile: plugin:<name>:<instance>; provider host: provider:<id>:<instance>). */
  fingerprint(host: HostView): string;
  /** Template: the expanded exec under EXEC_ARG_MAX_BYTES (src/agents/hooks-brief.ts:148-151). Plugin: maxScriptBytes. */
  fits(host: HostView, script: string, cwd: string): boolean;
  /**
   * Run a POSIX sh script. Returns once nothing it started locally still runs (src/hosts.ts:896-901).
   * `admitted` runs inside admission, before the command, on the admitted snapshot: a throw runs nothing
   * (today's assertRecoveryProfile placement, src/remote-agent.ts:409, src/remote-collect.ts:195).
   */
  exec(host: HostView, req: { script: string; cwd: string; timeoutMs: number }, call: Call, admitted?: (h: HostView) => void): Promise<LinkRun>;
  /**
   * Bring `remoteCwd`'s HEAD home: on success, `localRepo`'s FETCH_HEAD names that commit. mu deletes
   * FETCH_HEAD first and accepts only `FETCH_HEAD^{commit}` afterwards (src/remote-collect.ts:196-231);
   * a fetch that imports objects but leaves no FETCH_HEAD is a failed collect.
   */
  fetch?(host: HostView, req: { remoteCwd: string; localRepo: string; timeoutMs: number }, call: Call, admitted?: (h: HostView) => void): Promise<LinkRun>;
  /**
   * Make `remoteRepo` hold commit `rev` (a full sha) from `localRepo`, creating it as a git repository if
   * absent. Idempotent: a repo that already holds `rev` succeeds untouched. Like `exec`, not an effect (D4):
   * a timed-out push is re-run. mu does not trust the exit alone: make's own `rev-parse` check still runs.
   */
  push?(host: HostView, req: { localRepo: string; remoteRepo: string; rev: string; timeoutMs: number }, call: Call, admitted?: (h: HostView) => void): Promise<LinkRun>;
  checkSteps?(ctx: CheckContext, call: Call): Promise<HostCheckStep[]>;
}
```

**Built-in `template`.** Today's `exec` and `fetch` templates, through
`runLeasedTemplate` (`src/hosts.ts:903-933`), unchanged:

- admission and the pgid record before the command starts (`:857`);
- the timeout plus `HOST_GRACE_MS` (`:888`);
- exit 3 as a hand-back (`:924`).

Its capabilities:

- no `push`;
- `slots: "mu"`;
- `remoteOnTimeout: "unknown"`, because a killed local ssh does not stop
  the remote command (`mule/src/transport.rs:432-438`);
- `quiescence: "provable"`.

The lease kind's `stop` and `attach` templates are **not** link calls.
They belong to the lease job kind (D8), which runs them through the same
template runner. So the template runner has three callers: the link, the
lease kind, and `checkHost`.

**The worktree contract is mu's, over `exec`.** Make, observe-and-remove
and rollback are mu's shell scripts, split in P2 from `remote-agent.ts`
into `src/remote-worktree.ts`, with today's exec boundaries kept:

```ts
// src/remote-worktree.ts (one implementation: a module, not a seam)
export interface RemoteWorktree {
  make(h: HostView, r: { root: string; from: string; path: string; reclaim: boolean }): Promise<{ repoAbs: string; base: string; path: string }>;
  /** Today's two execs (src/remote-agent.ts:374-560): observe, then aside + quiescence + checks + removal in one. */
  close(h: HostView, r: { path: string; root: string; aside: string; wantHead: string; keepBranch?: string; force: boolean; admitted: (h: HostView) => void }): Promise<RemoteRemoval>;
  rollbackRemove(h: HostView, r: { path: string; base: string }): Promise<"removed" | "kept" | "gone">;
}
```

`RemoteRemoval` holds the 11 outcomes of `REMOTE_RM_RE`
(`src/remote-agent.ts:265-266`).

**The base on a provider host (G3).** A provider host starts with no
clone of the project, and commits made after acquire never reach it.
So a `--worktree` spawn on a provider host resolves `from` (default
`HEAD`) in the caller's local checkout to a sha, as a local `--worktree`
spawn does (`src/agents/spawn.ts:1134`). That checkout is also the job's
`collect_repo` (D10).

- **With `push`:** spawn calls `link.push` with that sha and the host's
  repo (`--root`, else the record's `repo`), then runs `make` from the
  sha.
- **Without `push`:** `make` runs from the sha. If the host's repo lacks
  the commit, `make` refuses with `RemoteBaseMissingError` (exit 5, the
  `RemotePrepareError` lane). The error names the sha and the remote repo
  to push it to.

Static hosts keep today's rule: `from` resolves in the remote repo
(`src/remote-worktree.ts:139`).

A link with `quiescence: "unprovable"` may still host jobs, but every
removal on it refuses without `--force`, as a host with neither `/proc`
nor `lsof` does today (`src/remote-agent.ts:543`). `remoteOnTimeout:
"unknown"` makes a timed-out script an unknown outcome; mu's scripts are
written to be re-run (reclaim, marks, the aside).

**Second implementation:** mule (P7), with `fetch: false`, no `push`
(`mule/SPEC.md:47,541`) and `slots: "self"`.

### D8. Seam: job kind

```ts
// src/jobs/types.ts (new cluster: types, view, pane, lease, gate; an ARCHITECTURE row)
export interface PaneCommand {
  command: string;
  env: Record<string, string>;
  cwd?: string;
} // the fields MuxBackend.spawnAgent takes (src/mux/types.ts:62-90)

export interface JobSpec {
  workstream: string;
  name: string;
  harness: string; // the --cli key
  role: "full-access" | "read-only";
  model?: string;
  cmd: string;
  /** Where `cmd` came from (src/mux/types.ts:134): only "cli-key" is the harness's default. */
  commandSource: CommandSource;
  cwd: string;
  /** Only HOST_ENV_KEYS (src/hosts.ts:392-400); `{}` for a kind without `honours.env`. */
  env: Partial<Record<HostEnvKey, string>>;
  sockets?: { local: string; remote: string };
  /** Present exactly for a `firstTurn: "at-start"` kind: the prompt whose turn the start begins (D1). */
  firstPrompt?: { text: string; msgId: string };
}

export interface JobStart {
  view: PaneCommand;
  handle?: string; // present when caps.handle is "reply"
  /** Present for an `at-start` kind: the first turn's run baseline, `runs: 0` and the channel incarnation. */
  baseline?: RunBaseline;
}

export type JobLiveness =
  | { state: "running" }
  | { state: "ended"; exit: number | null }
  | { state: "lost"; reason: string }
  | { state: "unknown"; reason: string };

export interface JobRef {
  kind: string;
  viewPaneId: string;
  agentId?: number;
  key?: EffectKey;
  handle?: string;
  host?: { name: string; handle?: string; instance?: string };
  gateToken?: string;
  identity?: string; // the recorded stop fence: host_stop bytes, or the plugin instance
}

export interface JobCaps {
  view: "bound" | "detached";
  handle: "pane" | "file" | "reply";
  start: KeyCaps; // D6; required when handle is "reply"
  /** The channel this kind's agents use: the `name` of the same plugin's channel seam (D13); absent: the harness's own. */
  channel?: string;
  /** The CheckContext phases this kind contributes steps for (D11). */
  checks?: CheckPhase[];
  /** "on-send" (absent): the first turn starts on the first delivery. "at-start": `job.start` carries the first prompt and begins its turn. */
  firstTurn?: "on-send" | "at-start";
  /** The job may outlive its host's machine (a session-hosted agent): `gone` does not prove it gone (D1, D6). */
  outlivesHost?: boolean;
  /** The JobSpec fields the kind enforces (honour or refuse, below). Built-ins: all. Absent: `env` only, and only full-access. */
  honours?: { command: boolean; env: boolean; sockets: boolean; roles: ("full-access" | "read-only")[] };
}

export interface JobKind {
  readonly name: string; // "pane" | "lease" | "gate" | plugin kind
  readonly caps: JobCaps;
  /** Computed by mu, never a wire call: the stop fence (host_stop bytes for lease; the handshake instance for a plugin). */
  identity(host: HostView | null): string;
  start(host: HostView | null, spec: JobSpec, key: EffectKey, call: Call): Promise<JobStart>;
  /** `found`: a `handle: "reply"` kind returns the whole `JobStart` the start returned, as a deduped resend would; a `handle: "file"` kind need fill only `handle`. */
  lookup(host: HostView | null, key: EffectKey, opts: { fence: boolean }, call: Call): Promise<KeyLookup<{ handle: string } & Partial<JobStart>>>;
  status(db: Db, job: JobRef, call: Call): Promise<JobLiveness>;
  /** Idempotent; resolves only on proof the job is gone; a hand-back throws HostHandbackError. */
  stop(db: Db, job: JobRef, key: EffectKey, call: Call): Promise<void>;
  attach(db: Db, job: JobRef, call: Call): Promise<PaneCommand>;
  checkSteps?(ctx: CheckContext, call: Call): Promise<HostCheckStep[]>;
}

// src/jobs/view.ts: D1's two reads
export function viewState(paneId: string): Promise<"running" | "exited" | "absent" | "unknown">;
export function jobLiveness(db: Db, job: JobRef, call: Call): Promise<JobLiveness>;
```

**Built-ins:**

| Kind | `start` | `status` | `stop` | `attach` |
| --- | --- | --- | --- | --- |
| `pane` | the local command, or the `session` profile's `shell`; `handle: "pane"` | `paneAlive` | `killPane` plus a proof (`src/agents/close.ts:540-568`) | refused |
| `lease` | the lease `shell` template; `handle: "file"` | `paneResult` (`src/remote-agent.ts:667-671`) | `runStop` and its `host_stop` byte fence (`src/carrier-stop.ts:88,97`) | the `attach` template |
| `gate` | the gate command; `handle: "pane"` | `readGate`, which needs `db` (`src/agents/gate.ts:120-135`) | `killPane` plus a proof | refused |

**What P1 moves.**

- Every site that decides "is the agent alive" goes through `viewState` or
  `jobLiveness`. The row rule (`src/agents/close.ts:540-568`) and
  teardown (`src/workstream.ts:566,590`) use view presence and
  `viewState`, never liveness: an exited retained pane still holds its
  row.
- reconcile's `listPanes` stays as it is: it is view presence.

The exact site list is written in P1's brief after its code survey (R6).

**How a plugin kind spawns (P6d/P6e).** A `handle: "reply"` kind starts
its job (the `job.start` effect) before the view pane, under the agent
lock. It does not hold the spawn lock across the network call. If the pane
then fails, the rollback stops the job by its handle. With `caps.channel`,
spawn records that channel and skips the ctl handshake
(`src/agents/spawn.ts:969`) and the remote anchor wrapper (`:680`).
Readiness is the channel's `baseline` answering within `MU_SPAWN_JOB_MS`.

**Honour or refuse (G4).** A kind either enforces a `JobSpec` field or
mu refuses the spawn that requests it. The refusal is
`JobSpecUnsupportedError` (exit 2, the usage lane), raised in
`requireHostSpawn` (`src/agents/spawn-remote.ts:61`) before any effect.
It never drops a field silently:

- **`role`** must be in `honours.roles`. A kind that cannot enforce
  `read-only` leaves it out, and a `read-only` spawn refuses. It never
  runs with a wider role, such as its parent's.
- **`cmd`** from `--command` or `$MU_<CLI>_COMMAND` (`commandSource` other
  than `cli-key`) needs `honours.command`. herdr refuses the same way today
  (`src/mux/herdr.ts:742`).
- **`sockets`** is set only for an agent on `ctl`. It needs
  `honours.sockets`. A kind with its own `channel` never gets one.
- **`env`** is mu's identity map. A kind with `honours.env: false` gets `{}`
  and must declare `channel`, since a harness's own channel finds its
  agent through that env. Without `channel`, the kind is refused at load.

**A first turn at start (G1).** Some backends cannot create a job without
its first prompt, which starts turn 1. Such a kind declares
`firstTurn: "at-start"` and `handle: "reply"`. Its spawn folds the first
delivery into `job.start`:

- **The prompt.** `firstPrompt` is the text of `--task` (its brief) or of
  `--send`. A spawn with neither refuses (`JobSpecUnsupportedError`), and
  the kind never gets a `channel.send` with `firstPrompt: true`.
- **The order.** The spawn inserts the agent's placeholder row first, as
  `--worktree` does today (`src/agents/spawn.ts:1135`). A task spawn then
  claims the task for that registry id and journals `sending` before
  `job.start`. Today's order stays reserve, identity, claim, `sending`,
  write (`src/agents/task-spawn.ts:4-7`), with `job.start` as the write.
  The view pane opens after the start, as for every reply kind.
- **The key.** The effect's key is the job token. `firstPrompt.msgId` is
  the spawn receipt's `msg_id` for `--task`, and a fresh msgId for
  `--send`. The effect row carries that `msg_id` and `seq` 1 (D4).
- **The receipt (G1b).** The job record is the first delivery's receipt,
  with or without a task. It holds `first_msg_id`, written with the
  `job.start` effect, and `first_inc`, the opening incarnation, written
  with the start's result. A task spawn's receipt also records the
  `msg_id`, `runs: 0` and the incarnation, as today. A definite start
  result moves that receipt to `sent`. An unresolved one leaves it
  `unknown`, and replay resolves it by `job.start`'s rule-table row.
- **`mu agent check <agent> <msgId>`.** When the msgId is the agent's
  job record's `first_msg_id`, the check first resolves any unresolved
  `job.start` effect by the rule table (D4). Then it answers from the
  record:
  - a started job is `accepted runs=0` (exit 0);
  - a start that is still unresolved is `unreachable` (exit 1), naming
    the effect key;
  - a start proven never to have happened leaves no record, so the check
    answers as for any other msgId: by the channel's `receipt(msgId)`, as
    today.
- **The baseline.** The reply's `baseline` (`runs: 0` and the
  incarnation) is readiness: no separate `baseline` call is made. A
  `--send` spawn arms its wait from it, as `armSend` does today
  (`src/cli/agents.ts:253`). `mu wait agent:<name>@0` waits for the first
  turn.
- **Recovery (G1a).** `job.lookup`'s `found` is the `JobStart` the start
  returned: handle, view and baseline. So a replay that resolves the
  start by `lookup` has what a deduped resend would return. It records
  the handle and `first_inc`, opens the view from `view`, moves the
  receipt to `sent` with the baseline, and finishes readiness.

**Second implementation:** mule (P7), the `lease` kind. After it, a
plugin kind with a detached view and `handle: "reply"`, for
session-hosted agents.

### D9. Seam: agent channel, an open registry

`AgentChannel` (`src/channels/types.ts:143-185`) and `ChannelDelivery`
(`:356`) stay the seam, with these changes:

```ts
// src/channels/types.ts
export type ChannelName = string & { readonly __channel: unique symbol };

export interface ChannelCaps {
  /** "sync": ctl's in-process veto before the one write. Plugins: "none" (D11). */
  fence: "sync" | "none";
  receipt: "exact" | "acknowledged" | "none";
  /** Per delivery method: only the methods listed dedupe; D4. */
  dedupe?: Partial<Record<"send" | "fresh" | "interrupt" | "answer" | "command", { exact: true; windowMs: number }>>;
  steer: "mid-turn" | "as-send" | "none";
  interrupt: "exact" | "unconfirmed" | "none";
  fresh: "in-place" | "new-job" | "none";
  answer: boolean;
  command: boolean;
  /** A plugin channel must declare "stream" (D13); "poll" is the mux built-in's. */
  watch: "stream" | "poll";
  settleText: "tied" | "untied" | "none";
}

export interface ChannelTarget {
  agent: ObservedAgent;
  stateDir?: string;
  socket?: string;
  remote?: RemoteReader;
  /** Filled when the row is listed, so a stateless plugin knows which session and host (D13). */
  job?: JobRef;
}

export interface AgentChannel extends ChannelDelivery {
  readonly name: ChannelName;
  readonly caps: ChannelCaps; // replaces `fence: boolean`
  // readStates, watch, baseline, receipt and lastRun keep their signatures;
  // StateAgentRef gains `job?: JobRef`.
}

/** A delivery's reply, normalized (landed in P4, src/channels/types.ts:235-239). A plugin channel answers in it. */
export interface ChannelSendReply {
  channel: ChannelName;
  ack: "exact" | "acknowledged" | "none";
  baseline?: RunBaseline;
  msgId?: string;
}

export function registerChannel(channel: AgentChannel): void;
```

**The send result's conversion (G7).** A plugin's `channel.send`,
`fresh` and `command` answer a `ChannelSendReply`, which mu narrows and
uses as is. A built-in's own result converts to it through `sendRun`:

- `ctl` gives `exact` (`src/channels/ctl.ts:288`).
- `hooks` gives `acknowledged` when its ack is `confirmed` or `sent`, else
  `none` (`src/channels/hooks.ts:939`).
- `mux` gives `none` (`src/channels/mux.ts:74`).

The CLI's `--json` keeps today's `SendResult` through `toSendResult`
(`src/channels/registry.ts:80`):

- `channel` becomes `transport`;
- `baseline` becomes `runs` and `incarnation`;
- `msgId` is kept;
- the normalized `ack` is not printed, and hooks' own `ack` stays its
  detail field.

A delivery's recovery is not a channel method: D4's rule table drives it,
using `receipt` and a deduped resend.

**Built-ins and their capabilities.** This is the matrix the contract
suite asserts (`test/channel-contract.test.ts:118-142`).

| Capability | `ctl` | `hooks` | `mux` |
| --- | --- | --- | --- |
| fence | `sync` (`src/ctl/client.ts:166-180`) | `none` (`src/channels/hooks.ts:221`) | `none` (`src/channels/mux.ts:29`) |
| receipt | `exact` (last 64, `src/ctl/protocol.ts:116`) | `acknowledged` (`run_count` past a baseline) | `none` |
| dedupe | none (`src/wait-actions.ts:32`) | none | none |
| steer | `mid-turn` | `none` (`src/channels/hooks.ts:262`) | `as-send`: sent as plain text (`test/channel-contract.test.ts:487`) |
| interrupt | `exact` | `unconfirmed` | `none` |
| fresh | `in-place` | `in-place` (refused remote) | `none` (`src/channels/mux.ts:60-63`) |
| answer, command | false, true | true, true (`src/channels/hooks.ts:935,959`) | true, true (`src/channels/mux.ts:65,77`) |
| watch | `stream` | `stream`, polling inside the channel (`src/channels/hooks.ts:693`) | `poll` |
| settleText | `tied` | `tied`/`untied` per murmur | `none` |

**What P4 does.** Each change preserves today's behaviour:

- `agentChannel` becomes a registry lookup (`src/channels/dispatch.ts:63-66`).
- `readChannelStates` groups agents by channel (`:115-139`). For a ctl
  agent whose socket fails, liveness still comes from the batched mux
  read, as today. `jobLiveness` is used only for detached kinds (P6e).
- Delivery results carry `ack` and `baseline`, so callers stop
  recomputing them by name (`src/cli/wait-arm.ts:97-106`,
  `src/cli/agent-send.ts:217`, `src/agents/task-spawn.ts:666`).
- An unknown stored name still reads as null, as today
  (`test/channel-contract.test.ts:1085-1087`). The typed error arrives in
  P6e, with plugin names.

**P4's invariant.** Every channel-name comparison outside `src/channels/`
is either a capability check or on a pinned list of features that belong
to one built-in channel:

- the hooks brief file and session wait;
- turn-failure acknowledgement;
- the Stop hook and the pi fallback;
- ctl-only `agent wait --after-runs` and `--inc`.

The pinned list is written in P4's brief after its survey (R6).

A plugin channel gets none of those features. Its agents are waited on
through `mu wait`'s typed refs.

**Second implementation:** a plugin channel for session-hosted agents.

### D10. Host policies: mu-owned, two functions

The policies are functions in `src/host-policy.ts`, not an interface
(Principle 7). Both
start with provider hosts (P6d).

**Collects on provider hosts (R8).** Two kinds, with different jobs.

- **The final collect** is the obligation. It is a flag, `final_owed`,
  set when the job record of a `--worktree` job on a provider host is
  created. A `--cwd` job has no tree (`src/remote-collect.ts:331-336`), and
  jobs on static hosts keep today's close rule, so neither gets the flag.
  - **Clearing it.** Only a collect that **starts** after the job is
    stopped or lost clears it, when no turn can follow. The stop or lost
    transition sets `stop_gen`. That collect reads `stop_gen` before it
    fetches, and on success clears the flag with
    `WHERE stop_gen = <read value>`. Reads, reaps, settles and in-life
    collects never clear it. A `lost` host does not make an
    `outlivesHost` job lost: its stop sets `stop_gen`. Its tree went with
    the machine, so its owed collect is marked lost (D1).
  - **Where it runs.** `agent close` runs it between the stop and the tree
    close. `mu agent collect` on a leftover or recovery record runs it too,
    on the job record whose `tree_path` names the tree
    (`src/remote-collect.ts:171-183`).
  - **What waits on it.** Worktree removal and host release wait while it
    is owed. Only `--abandon-job` or `host release --abandon` skip it, and
    both log the loss.
  - **Who sees it.** The flag lives on the job record, not the agent row,
    so the discovery reads job records, never only live agents:
    - `mu agent list`'s leftovers (a job record whose agent is gone);
    - `mu state`'s notices ("final collect owed" with `next: mu agent
      collect …`);
    - `mu host release`'s refusal, which lists every owing job.
- **In-life collects** are best-effort protection on hosts with idle
  reclaim or a deadline.
  - **When.** They are attempted at each observed settle (by a `mu wait`,
    `mu state` or `mu next` that sees one) and before the deadline margin.
  - **Retries.** On failure, the job record's `collect_next_at` backs off:
    one poll interval, doubling to 5 minutes. The next mu verb or wait that
    touches the host retries once it has passed. Each failure is a warning.
  - **What they record.** `collected_head`, as `mu agent collect` does.
    They never touch `final_owed`.
  - **Timing.** They run after a wait's result is decided, outside its
    synchronous settle and commit, from the job record's `collect_repo`
    (the spawning invocation's local repository root). Without one, a
    notice suggests `mu agent collect`.

**`deadlineNotice`** applies to a host with `deadlineAt`. Inside
`MU_HOST_DEADLINE_MARGIN_MS` of the deadline:

- spawns refuse (`HostDeadlineError`), and the host moves to `draining`;
- `mu wait` fires an urgent `deadline` event;
- `mu state` lists each agent's collect and close as `next`.

mu never closes an agent on its own.

**The wake-up.** A fully watched wait does no polling
(`src/wait.ts:1450-1470`). So `mu wait` caps its sleep at the earliest
`deadline_at − margin` of the hosts of the agents it owns. This is a timer
inside one invocation, like `--timeout`.

### D11. What Principle 7 cut

- **The two-phase write fence: cut.** Only the stall steer
  (`src/wait-actions.ts:446-474`, a ctl-only steer) and the pi-only close
  notice (`src/close-notice.ts:101`) use a write fence. A plugin channel
  is `fence: "none"`: the steer falls back to reporting the stall, and the
  close notice does not apply.
- **The HostChecks seam: folded** into a phased `checkSteps` method on the
  link and the job kind:

  ```ts
  export type CheckPhase = "template" | "reach" | "agent";

  export interface CheckContext {
    db: Db;
    host: HostView;
    phase: CheckPhase;
    root?: string;
    agent?: { name: string; workstream: string };
  }
  ```

  `checkHost` calls each phase in today's order (`src/hosts.ts:1018-1180`):
  1. `template`: the lease kind's `shell`, `stop` and `attach`;
  2. `reach`: the link's `reachable` and `repo`;
  3. mu's own `harnesses`, `hooks`, `pi` and `extension`;
  4. `agent`: the lease kind's `job`;
  5. mu's own `ctl`.

  A `handback` still skips the rest. `HostCheckStep.step` becomes a
  string, and plugin steps are `<plugin>:<step>`.
- **The LifecyclePolicy interface: cut** into two functions (D10).
- **Self-starting turns: cut** (R1). A plugin channel whose turns start
  without a delivery is out of scope. The first turn of an `at-start` kind
  is not one: its `job.start` carries the prompt and is the delivery (D1,
  D8).
- **Released-build safety: cut** (R2, R7). The version bump replaces it.

### D12. Capabilities

Each is declared once: at the handshake for a plugin, in code for a
built-in. The contract suite checks it. The table gives each one's
enforcement point:

| Capability | Meaning | Enforced where |
| --- | --- | --- |
| channel `fence` | `sync`: an in-process veto before the one write | callers passing a write guard refuse `none` before any write (`src/channels/mux.ts:29`, `src/channels/hooks.ts:221`) |
| channel `receipt` | `exact`: answers by msgId. `acknowledged`: a turn past the journaled baseline. `none`. | D4 rule table, spawn replay, `mu agent check` |
| `dedupe` (channel, `job.start`, `host.acquire`) | a byte-identical repeat with the same key, within the window, returns the first result and makes no second effect | D4 rule table; nothing is resent without it |
| `lookup`, `fenceKey`, `inFlightMs` | lookup by key; whether a lookup can make the key unusable; how long a request may be in flight | D4 rule table and the `none` gate; at load |
| channel `steer` | `mid-turn`, `as-send` or `none` | `send --steer`, `--on-stall steer`, the steer executor |
| channel `interrupt` | `exact` or `unconfirmed` (reads `idle?`) | `send --interrupt`, abort; `none` refuses |
| channel `fresh` | `in-place` (a new channel incarnation) or `new-job` | `send --fresh` refuses `new-job` and `none`, naming close then spawn |
| channel `answer`, `command` | keys reach a dialog; session commands run | `agent answer`, session commands |
| channel `watch` | `stream`: one watch per turn. `poll`: mu polls. | `mu wait` (`src/wait-ctl.ts`) |
| channel `settleText` | the last text is the settled turn's own | CLOSE blocks apply only with `tied` (`src/close-block.ts:219`) |
| job `view` | `bound` or `detached` | reconcile, close order, reattach (D1, D3) |
| job `handle` | `pane`, `file` or `reply` | at load; spawn's order (D8); the `none` gate (D4) |
| job `channel` | the channel of the kind's agents | spawn (D8) |
| job `firstTurn` | `on-send`, or `at-start`: `job.start` carries the first prompt and begins its turn | at load (`at-start` needs `handle: "reply"`); spawn folds the first delivery into the start and refuses without a prompt (D8); the D4 `job.start` row |
| job `outlivesHost` | the job may survive its machine, so `gone` does not prove it gone | the `lost` close calls `job.stop` and waits for proof; deliveries to the agent refuse (D1) |
| job `honours` | the `JobSpec` fields the kind enforces: `command`, `env`, `sockets`, `roles` | `requireHostSpawn` refuses a requested field the kind lacks, before any effect; at load, `env: false` needs `channel` (D8) |
| link `fetch`, `push`, `slots`, `fits` | brings commits home; seeds the host's repo with the base; who counts slots; the script size limit | collect; a `--worktree` spawn on a provider host (D7); admission; every script before the call |
| link `remoteOnTimeout`, `quiescence` | what a timeout leaves behind; whether a scan sees the job's processes | timeouts are unknown outcomes; `unprovable` refuses removal without `--force` |
| host `deadlineAt`, `idleReclaimMs`, `maxJobs` | provider facts. `idleReclaimMs` is the provider's own idle window: mu runs no timer from it (D6). | atomic admission; D10 (`idleReclaimMs` only turns in-life collects on) |

### D13. The plugin protocol

**Transport layer.**

- JSON-RPC 2.0, one JSON object per line on the plugin's stdin and stdout,
  UTF-8, at most 1 MiB per message.
- stderr is drained, never parsed and never stored. Its first line may
  appear in an error.
- The framing and validation are hand-rolled, like `src/ctl/protocol.ts`.
  No dependency is added.

**Process.**

- mu starts the plugin's registered argv on first need, as its child in
  its own process group, for one invocation.
- On stdin EOF, the plugin cancels or finishes its in-flight calls within
  `HOST_GRACE_MS` (5 s, `src/hosts.ts:888`) and exits.
- It never detaches a helper (`setsid`, a double fork).
- At a normal exit mu sends `shutdown`. After the grace it kills the
  group.
- The group's id and start time go on every effect row (D4).

**Handshake.**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"mu":"5.0.0"}}
{"jsonrpc":"2.0","id":1,"result":{"protocol":1,"plugin":{"name":"mule","version":"0.5.0"},"instance":"9f2c…","schema":"sha256:…","seams":{"link":{"fetch":false,"slots":"self","remoteOnTimeout":"unknown","quiescence":"provable","maxScriptBytes":131072,"checks":["reach"]},"job":{"kind":"lease","view":"bound","handle":"file","start":{"lookup":true,"fenceKey":false},"checks":["template","agent"]}}}}
```

A channel seam, for a plugin that has one, adds
`"channel":{"name":"cloud","caps":{"fence":"none","receipt":"exact","dedupe":{"send":{"exact":true,"windowMs":86400000}},"steer":"none","interrupt":"exact","fresh":"none","answer":false,"command":false,"watch":"stream","settleText":"tied"}}`.

The plugin declares every seam it implements: `host`, `link`, `job` and
`channel`, each with its capabilities:

- **`host`** is `{acquire: KeyCaps}`, and must come with `link`, and with
  `job` when its hosts run jobs: a provider host with no job kind refuses
  a spawn up front (D6).
- **`channel`** is `{name, caps}`. `name` is the channel's registered
  name, and the job seam's `channel` must equal it.
- **A plugin channel** must declare `watch: "stream"` and a `settleText`
  other than `none`: mu's polled path is the mux built-in's alone (D9).
- **`job`** may add `firstTurn`, `outlivesHost` and `honours`, and **`link`**
  may add `push` (D7, D8). Each may be omitted, which means its default:
  `on-send`, false, `env` only (with `full-access` only) and no push.

These refuse at load with `PluginRefusedError` (exit 4):

- a protocol range with no overlap;
- a seam the registration or a host needs but the plugin does not
  implement;
- a missing mandatory method or capability (D4);
- `firstTurn: "at-start"` without `handle: "reply"`, or `honours.env: false`
  without `channel` (D8);
- a schema digest that does not match. `schema` is the sha256 of the
  exact bytes of the published `schemas/plugin-protocol-v<n>.json` the
  plugin was built against.

Each seam object may carry `checks`: the `CheckContext` phases (D11) for
which it contributes steps. It is `LinkCaps.checks` and `JobCaps.checks`,
typed `CheckPhase[]`.

`instance` names the backend configuration the plugin addresses. It is
recorded on every host record, job record and effect row. Every stop,
release, ask and resend is fenced on it (D4).

**Every call** carries `deadline`, and every effect also carries `key`.
Every host, link, job and channel call carries a serialisable `target`:

```ts
{
  agent?: { workstream: string; name: string; incarnation: number },
  job?: { kind: string; key: string; handle?: string },
  host: { name: string; handle?: string; instance?: string },
}
```

`HostView` stays inside mu. `fingerprint`, `fits` and `identity` are
computed by mu (D7, D8); they are not wire calls.

**Wire encoding.** Every result is plain JSON:

- **Maps:** a TypeScript `Map` (`readStates`' result) is a JSON object
  keyed `<workstream>/<name>`.
- **Absent results:** an optional `undefined` result (`baseline`,
  `lastRun`, `watch`) is `null`. A reply always carries `result`.
- **Observations:** the plugin returns an observation without its
  identity fields. mu adds `workstream`, `name`, `agentId` and `paneId`
  from its own row (`src/agents/observe.ts:36-41`), since only mu knows
  the view's pane.

**Methods.** These mirror D6–D9:

| Method | Params beyond `target`, `key`, `deadline` | Result |
| --- | --- | --- |
| `host.acquire`, `host.lookup`, `host.status`, `host.release` | `params`; `fence`; `handle` | as D6 |
| `link.exec`, `link.fetch`, `link.push`, `link.checkSteps` | as D7; `checkSteps` takes `CheckContext` without `db` and `host`: `{phase, root?, agent?}` | `LinkRun`, steps |
| `job.start` (the whole `JobSpec`, with `commandSource`, and `firstPrompt` for an `at-start` kind), `job.lookup`, `job.status`, `job.stop`, `job.attach`, `job.checkSteps` | as D8, plus `phase` | as D8. An `at-start` kind's `JobStart` carries `baseline`, and `job.lookup`'s `found` is that `JobStart`. |
| `channel.readStates`, `channel.baseline`, `channel.receipt`, `channel.lastRun` | as D9 | readings and observations. A plugin reading's `source` is `plugin:<name>`, and `StateSource` (`src/agent-state.ts:12`) widens to admit it. A plugin reading must carry `runs` and `incarnation`, its turn count and channel incarnation, which today only ctl fills. `runs` is dense (D1): 0 before any settle, then one more per settled turn, never a backend's sequence id. |
| `channel.watch` | `afterRuns?`, `inc?` | `{watchId, initial, afterRuns?}`, then one notification. A turn past `afterRuns` that already settled is reported at once, as ctl's `wait` does. |
| `channel.send` | `text`, `msgId`, `mode: "followUp" \| "steer"`, `force`, `firstPrompt` (a flag, never true for an `at-start` kind, whose first prompt went with `job.start`), `expectIncarnation?` | `ChannelSendReply` (D9) |
| `channel.fresh` | `text`, `msgId`, `force`, `expectIncarnation?` | `ChannelSendReply` |
| `channel.command` | `name`, `instructions?`, `force`, `expectIncarnation?` | `ChannelSendReply` |
| `channel.interrupt` | `text`, `msgId`, `timeoutMs`, `expectIncarnation?` | `InterruptResult` |
| `channel.abort` | `timeoutMs` | `AbortOutcome`, with an `aborted` flag |
| `channel.answer` | `keys`, `force` | `AnswerResult` |

A capability that is false or `none` means mu never calls that method, and
the verb refuses with the typed error the built-ins use.

**Timeouts.**

- `link.exec` takes the caller's `timeoutMs`, else 20 s
  (`HOST_COMMAND_TIMEOUT_MS`, `src/hosts.ts:885`).
- Reads take 10 s. `host.acquire` takes 10 min.
- `channel.watch` is bounded by `mu wait --timeout` and the D10 timer.
- On expiry or SIGINT, mu sends `$/cancel {id}`, waits `HOST_GRACE_MS`,
  and kills the group.
- A cancelled read is `unknown`. A cancelled effect is `unknown-outcome`.

**Typed errors.** Each error carries `data.kind`:

| `kind` | Means | mu does |
| --- | --- | --- |
| `retryable` | nothing happened | retries with the same key and payload, at most three times; else exit 5 |
| `permanent` | nothing happened, and retrying will not help | exit 5 (`src/cli/handle.ts:690-691`) |
| `human` | a person must act (`data.remedy`) | `HostHandbackError`, exit 5 (`src/cli/handle.ts:693-695`); never retried |
| `unknown-outcome` | the effect may have happened | leaves the effect row; `EffectOutcomeUnknownError`, exit 1 (`src/cli/handle.ts:616-618`) |

A malformed or invalid message counts as `unknown-outcome` for an effect
and `unknown` for a read. The plugin is marked broken for the rest of the
invocation.

**Streaming watch.** `channel.watch` returns an id. The plugin later sends
one notification: `watch/settled {watchId, observation}`, or
`watch/restarted {watchId, incarnation}`. mu ends a watch with
`$/cancel {watchId}`; `$/cancel {id}`, the JSON-RPC request id, is only
for a request still awaiting its reply. The watch's answer is then
`unknown`. A watch lives only inside the one
invocation that asked (VISION constraint 4).

**Schema publication.**

- The protocol is published as `docs/reference/plugin-protocol.md`, the
  normative prose, plus `schemas/plugin-protocol-v1.json`, which ships in
  the package.
- mu's narrowers and the schema are checked against the same fixture
  messages (`test/plugin-schema.test.ts`).
- Protocol-version skew tests run the fake plugin speaking 0, 1 and 2
  (`test/plugin-skew.test.ts`).

### D14. Registration, trust, env and secrets

- **User-configured, never discovered.**
  `mu plugin add <name> -- <absolute path> [args…]` records the argv,
  runs the handshake once, and stores the `plugins` row. The executable's
  basename must be `mu-plugin-<name>`.
  - `mu plugin list` shows the rows.
  - `mu plugin rm` refuses while any host record, profile, job record,
    effect or agent names the plugin.
  - A profile names its plugin with `mu host add … --plugin <name>`, and a
    provider host with `mu host acquire … --provider <name>`.
  - mu never scans `PATH`, a directory or a package.
- **Trust.** A plugin runs with the user's privileges. mu refuses:
  - a path that is not absolute;
  - a file that is group- or world-writable, or not owned by the user;
  - a symlink to either.

  mu does not hash the binary. `instance` is the fence.
- **Env.**
  - The plugin process gets mu's environment minus `LOCAL_ONLY_ENV`
    (`src/remote-agent.ts:573`), `MU_DB_PATH`, `MU_STATE_DIR` and
    `MU_SYNC_DIR`. The target carries all the identity it needs.
  - An agent's env crosses as a structured map, restricted to
    `HOST_ENV_KEYS` (`src/hosts.ts:392-400`: seven keys; P2 fixes the
    "five" at `:40`). These are identity, not secrets, and may come back
    in observations.
- **Secrets.**
  - mu stores only typed reply fields, the exact request in an effect row,
    and first-line error text capped at 400 characters.
  - The contract suite starts the plugin with
    `MU_PLUGIN_CANARY=<random>` in its own environment. It fails the
    plugin if the canary appears in any reply, message or stderr line.

### D15. mule, the first out-of-process plugin

mu drives mule through templates today (`src/hosts.ts:324-337`). mu reads
the exit codes of those templates: 3 is a hand-back
(`src/hosts.ts:924-929`), and 0 proves a stop (`src/carrier-stop.ts:109-115`).
Of the lease pane, mu reads only liveness (`mule/SPEC.md:102`).

The mule plugin implements the link and the `lease` job kind. It is not a
provider (`mule/SPEC.md:505`).

What mule already guarantees:

- an idempotent stop: `rm` exits 0 only on proof (`mule/SPEC.md:366`);
- a handle written before dispatch (`mule/src/lease.rs:329-345`);
- an attach that never replaces the job file.

The gaps, which no shim can close:

| Gap | Today | mule adds (P7) |
| --- | --- | --- |
| Truthful status | `poll --json` has running, done, orphan and missing (`mule/src/cli.rs:799-805`), but `missing` exits 1 (`:758-760`). The probe can confuse a protocol mismatch with absence (`mule/src/probe.rs:89-90`, `mule/SPEC.md:366`). | five states, exit 0: running, done, orphan, `missing` (proven by `rm`'s checks) and `unknown` |
| A caller key | ids are generated (`mule/src/wrapper.rs:294`), and names are refused (`mule/SPEC.md:517`) | `run --lease --key K`, stored as `$d/key`. A dispatch whose key exists returns that job. The id stays generated. |
| Listing mu's jobs | no local index (`mule/SPEC.md:521`) | `ls --json --key-prefix P` and a `key` field |
| Cancellation | a signalled `mule exec` detaches its cleanup with `setsid` (`mule/src/exec.rs:326-336`, `mule/src/cleanup.rs:213-230`) | under the plugin, a cancelled exec runs `rm` inside its group within the grace, and never detaches. The plugin declares `remoteOnTimeout: "unknown"`, since `rm` can outlast the grace. |
| An entry point | `mule` is one binary | a `mu-plugin-mule` bin target (D14's basename rule) serving the protocol |
| Host lifecycle | mule never provisions | nothing. `host info --json` with `master: false` becomes a `needs-human` step. |

**Capabilities mule declares:**

- link: `fetch: false`, no `push`, `slots: "self"`, `quiescence: "provable"`;
- job: `view: "bound"`, `handle: "file"`, `start.lookup: true`, and
  `honours` with every field and both roles: its view runs the command mu
  builds, as the lease template does today.

The view stays interactive, and there is no detached lease (D18).

**Profile migration.**

- `mu host add <h> --plugin mule` keeps only the `fetch` template, the
  one seam mule does not implement. The view command comes from the
  plugin's `job.start`, with `--key <token>` in it.
- A reservation made before the plugin was used is stopped by the
  plugin's `rm` on the same handle.

### D16. Proof: contract suites and fault injection

| Suite | Built-ins | Plugins |
| --- | --- | --- |
| `test/host-provider-contract.test.ts` | `static` | the fake plugin; any provider plugin in its own CI |
| `test/link-contract.test.ts` | `template` over `test/_fake-remote-node.ts` | the fake plugin; mule |
| `test/job-contract.test.ts` | `pane`, `lease` (`test/_carrier.ts`), `gate` | the fake plugin (bound, detached); mule |
| `test/channel-contract.test.ts` | `ctl`, `hooks`, `mux`, pi on `hooks` | the fake plugin |

Each suite asserts:

- the declared capabilities;
- typed refusals;
- that `status` and `lookup` never throw for "cannot tell";
- byte-identical deduped resends making one effect;
- the EOF and no-detach rules;
- the canary;
- for an `at-start` kind, that a found job had its first prompt accepted,
  that `lookup`'s `found` equals the start's reply, and that its turn
  settles at `runs: 1`; for every channel, that `runs` rises
  by one per settle;
- that a kind refuses nothing it declares in `honours`, and that a spawn
  requesting an undeclared field refuses before any effect;
- for a link with `push`, that a pushed sha passes make's `rev-parse`.

The fake plugin (`test/_fake-plugin.mjs`) is a real executable backed by a
JSON file. The suites are exported (`@mu-crew/mu/contract`).

**Fault injection.** `test/plugin-faults.test.ts`. The criterion at every
point: replay yields exactly one effect, and reconcile converges.

| Point | Injected | Must hold |
| --- | --- | --- |
| F1 | mu killed after the effect row commits, before the call | the next touch claims and resolves it; `none` only under the gate |
| F2 | the plugin killed mid-call | unknown outcome; resolved by the rule table |
| F3 | mu killed after the effect, before the result is recorded | lookup, or a deduped resend, returns it; one effect |
| F4 | the reply lost (stdout closed) | as F3 |
| F5 | a timeout, then a late reply | `$/cancel`; the group is killed; the late reply is ignored |
| F6 | `retryable` twice, then success | one effect, one key |
| F7 | mu SIGKILLed; the plugin sees EOF | the plugin exits within the grace; the next reconcile finds the effect |
| F8 | two mu processes resolve one effect | one claim wins; the other refuses, naming it |
| F9 | `none` while the creator lives, or inside `inFlightMs` | treated as `unknown` |
| F10 | the plugin's instance changed between intent and resolve | the ask, resend, stop or release refuses `stop-changed` |
| F11 | a host `gone` during close, or a crash after the release intent | `agent close` on the `lost` host records the tree gone; an `outlivesHost` job is stopped by `job.stop` with proof, any other is recorded stopped; a job owing its final collect is marked lost with "uncollected work" until abandoned; a crashed release is reissued and converges |
| F13 | a settle, then a crash before the final collect | `final_owed` stays set; the next close or collect of the record runs the final collect; release waits |
| F12 | a creator still in its call when a second verb tries to resolve | the second refuses, naming the creator; one result is recorded |

Crash points between mu's steps are seeded the way
`test/spawn-receipts.test.ts:582` seeds "a receipt left in each stage".

### D17. The pledge amendment

The user approved amending ROADMAP's plugin-runtime pledge
(`docs/ROADMAP.md:37`) and VISION's "no plugin system"
(`docs/VISION.md:184`) on 2026-11-07. Both are amended.

mu may drive an external executable over a versioned stdio protocol for
four seams: host provider, link, job kind and agent channel.

Still refused:

- discovery;
- in-process third-party code;
- a resident plugin host or daemon;
- plugin verbs, flags, tables, wait events or op kinds;
- plugins writing mu's DB or state;
- RPC into mu;
- a verb registry;
- a seam without two real implementations.

VISION's idempotency gap (`docs/VISION.md:359`) is amended when plugin
effects carry keys (P6c).

### D18. Decided by the user

The user decided these on 2026-11-09. R2 is the orchestrator's default,
recorded as needing the user, who may overrule it.

1. **Release.** A plugin a real user runs counts as a seam's second
   implementation; the fake plugin does not. The plugin units ship
   together.
2. **Registration** is the `mu plugin add` verb (D14).
3. **One view pane per agent**, read-only on a plugin channel (D3).
4. **Collect at settle** runs in mu's own reads (D10). It runs the
   operator's own template or plugin, as `mu agent collect` does
   (`docs/ROADMAP.md:139-141`).
5. **Static `host rm`** keeps today's behaviour (D6).
6. **mule's SPEC** takes `--key`, the five-state `poll` and `--key-prefix`
   (D15).
7. **No detached mule leases.**
8. **(R2, default)** Schema 14, state directory `mu5` with a one-shot
   import, major version mu 5 (D5). If the user overrules it, D5 falls
   back to draft 2's additive v13 design, with its released-build
   analysis.

## End to end: a provisioning backend

A plugin for machines provisioned on demand, running session-hosted
agents, needs only the contract above. Each step names the contract it
uses:

1. **Register.** `mu plugin add cloud -- /abs/mu-plugin-cloud`. The
   handshake declares the `host`, `link`, `job` and `channel` seams, with
   `host.acquire` and `job.start` keyed by `lookup` or `dedupe: exact`
   (D13, D4). Its link declares `push`. Its job kind declares
   `firstTurn: "at-start"`, `outlivesHost` and the `honours` it enforces
   (D7, D8).
2. **Acquire.** `mu host acquire box1 --provider cloud --param size=large
   --repo /work/repo`.
   - The `hosts` row and the `host.acquire` effect are written first.
   - The result records the handle, instance, deadline and idle reclaim.
   - On a crash, running `host acquire box1` again resolves the same
     effect (D1, D4).
3. **Spawn a session job.** `mu agent spawn w1 --host box1 --worktree
   --cli claude --task t1`.
   - `resolveHost` gives the plugin's link and job kind (D6).
   - A requested field the kind does not honour refuses here, before any
     effect (D8).
   - Atomic admission checks `ready` and `max_jobs`.
   - The caller's `HEAD` resolves locally to a sha, `link.push` seeds the
     host's repo with it, and `RemoteWorktree.make` runs from it over
     `link.exec` (D7).
   - The placeholder row claims t1, and the receipt goes to `sending`.
   - The `job.start` effect carries the whole `JobSpec`, with t1's brief
     as `firstPrompt`. The reply's handle and `baseline` are recorded, and
     the receipt goes to `sent` (D8, D4).
   - The read-only view opens, and the agent row takes the kind's channel.
   - Readiness is the start reply's `baseline` (D8).
4. **Send.** `mu agent send w1 …`, after the first turn.
   - A `channel.send` effect is written with the msgId and text.
   - An `unknown-outcome` is reported as delivery unknown and resolved by
     `receipt` or a deduped resend (D4).
5. **Wait for the settle.** `mu wait agent:w1@<runs>` (`@0` for the first
   turn), through `channel.watch`, which a plugin channel must stream. An
   already settled turn past `<runs>` is reported at once, with its text
   (D13). The turn started on delivery: the start's prompt, or a send
   (D1). The D10 timer bounds the wait for the deadline.
6. **Collect.**
   - An observed settle triggers an in-life collect over `link.fetch`,
     retried with backoff if it fails (D10).
   - The final collect runs at close, after `job.stop`, and clears
     `final_owed`.
7. **Release at the deadline.**
   - Inside the margin, spawns refuse and `deadline` fires.
   - The orchestrator closes. `agent close` calls `job.stop`, an
     idempotent effect, runs the final collect, and closes the worktree
     under the close rules.
   - `mu host release box1` checks no agent, job or recovery row remains,
     records the `host.release` effect, and reissues it after any crash
     (D1, D4).
   - If the provider reclaimed box1 first, it is `lost`. The sessions
     outlive it, so `agent close` still calls `job.stop` and waits for
     proof, and sends to them refuse. An owed final collect is recorded
     lost (D1, D10).

## Units

Each mu unit is about a week. It ends green on the fast gate and the
targeted slow gate. Each unit's brief carries its exact grep and import
checks, written after a pre-unit code survey (R6). The table states each
unit's **invariant** and the test files that pin it. P1–P5 change no
behaviour.

The order follows blast radius:

1. Liveness first: channels and hosts depend on it.
2. The link wraps the template runner before the provider wraps host
   lookup.
3. The channel registry needs liveness.
4. The checks need the link and the kinds.
5. The plugin units start with the state-directory move, then add one
   seam at a time.

| Unit | Content | Invariant | Pinned by |
| --- | --- | --- | --- |
| P1 | `src/jobs/`: `JobKind`, `JobRef`, `viewState`, `jobLiveness(db, …)`, and the `pane`, `lease` and `gate` kinds. `runStop`, the job handshake and the lease reattach behind `lease`. | Every "is it alive" decision goes through `src/jobs/`. The row rule and teardown use view presence. Built-in answers are identical. | `reconcile.integration`, `reconcile-race`, `close-proof.integration`, `close-unknown-probe`, `wait-dead-after-reap`, `agent-reaper-transactional`, `workstream-teardown-*`, `host-channels`, `lease-spawn`(+`.integration`), `lease-close`, `lease-reattach`(+`.integration`), `reap-lease-park`, `remote-gates`(+`.integration`) |
| P2 | `HostLink` (`template`) with `admitted`, `fits` and phased checks; a minimal `HostView`; `remote-worktree.ts` with today's exec boundaries; `Transport` renamed `SendChannel`. | Every remote template runs through the link, the lease kind or `checkHost`. The exec count per worktree operation and the admitted-profile guard are unchanged. | `remote-collect`(+`.integration`), `remote-recovery`, `remote-recovery-close`(+`.integration`), `remote-spawn`(+`.integration`), `remote-prepare-lost.integration`, `hooks-remote`, `host-handback`, `remote-task-brief` |
| P3 | `HostProvider`, `static`, `resolveHost`; `HostView` complete. | Every host lookup outside the profile verbs goes through `resolveHost`. | `host-profiles`, `host-lease-profile`, `lease-spawn`, `lease-reattach`, `remote-spawn`, `remote-recovery`, `host-harnesses` |
| P4 | `ChannelCaps`, the registry, `ack`/`baseline` results, `ChannelTarget.job`, the run-baseline rename. | Channel behaviour comes from the registry and capabilities, and the D9 matrix holds. Name comparisons outside `src/channels/` are capability checks or on the pinned feature list. | `channel-contract`, `channel-imports`, `agent-state-ctl`, `wait-action-*`, `close-notice`, `spawn-receipts*`, `channel-hooks-verbs`, `hooks-remote`, `next-recover` |
| P5 | Phased `checkSteps` on the link and the kinds; `checkHost` composes them. | `host check` output is byte-identical, skips included. | `host-check-lease`, `host-check.integration`, `lease-job-doctor`, `host-harnesses` |
| P6a | Schema 14, the `mu5` import, mu 5. | Released builds refuse v14. The import runs once, under its lock, and commits by a no-replace rename. It leaves `mu-next` untouched. It refuses when `mu5` exists, when unpublished ops remain, or when the snapshot has live rows, and it mints a new `machine_id` before the upgrade. | `db`, `entities`, `loop-storage` (`test/fixtures/v13-populated.db.gz`), `rebuild`, a new `state-import` test |
| P6b | Protocol core: framing, process manager, handshake, `plugins`, `mu plugin add`/`list`/`rm`, the schema doc, the fake plugin; the link adapter and `host_profiles.plugin`. | A plugin can only report facts. The load rules refuse bad declarations. EOF and no-detach hold. With no plugin registered, the full suite is unchanged. | `link-contract`, `plugin-schema`, `plugin-skew`, `host-profiles` |
| P6c | `effects`, the reconciler and the D4 rule table; the job adapter (bound); the `carrier_jobs` columns; the VISION:359 amendment. Round 6: the job caps `firstTurn`, `outlivesHost` and `honours` and the link cap `push` on the wire, in P6b's narrowers and schema (one digest change); `JobSpec.commandSource`; honour or refuse at spawn (G4). | Every plugin effect is written ahead with its params. A live creator owns its row. Resolution follows the rule table, fenced on the instance, and never resends a delivery older than another. A spawn requesting a field its kind does not honour refuses before any effect, and `read-only` never runs wider. | `job-contract`, `plugin-faults` F1–F10 and F12, `carrier-jobs`, `leftovers`, `lease-*`, `plugin-schema`, `remote-spawn` |
| P6d | `hosts`, `mu host acquire`/`drain`/`release`/`--abandon`, atomic admission, the provider adapter, `remote_recovery.host_identity`, both host policies. Round 6: `link.push` in the link adapter and the provider-host base rule with `RemoteBaseMissingError` (G3); `outlivesHost` on a `lost` host (G2); `idleReclaimMs` read only as the in-life-collect switch (G5). | A host's release waits for every reference; a `lost` host's rows close without the host, except that an `outlivesHost` job is stopped with proof first, and F11 converges. A provider-host worktree starts from the caller's commit or refuses, naming it. The final collect clears `final_owed` only when it started after the stop (`stop_gen` compare-and-clear); release and tree removal wait on it. | `host-provider-contract`, `link-contract`, `plugin-faults` F11, `host-policy`, `remote-recovery*`, `remote-collect*`, `remote-spawn` |
| P6e | The channel adapter, the plugin spawn path, detached views and the view reattach, the unknown-channel typed error, `docs/reference/plugin-protocol.md` complete. Round 6: the `at-start` first turn, folded into `job.start` for `--task` and `--send`, with its receipt and baseline (G1); `first_msg_id`/`first_inc` and `mu agent check` on them, and lookup recovery from the `JobStart` (G1a, G1b); dense `runs` in the channel suite (G5). | Deliveries to plugin channels go only through effects, encoded as D13 says. An `at-start` kind's first prompt goes only with `job.start`, after the claim, and is never sent again. A spawn replay resolved by `lookup` finishes readiness and the receipt; `mu agent check` answers a taskless first prompt. A detached job survives its view. The end-to-end walkthrough passes against the fake plugin. | `channel-contract`, `spawn-receipts*`, `wait-*`, `reconcile*`, `lease-reattach*`, `acceptance.integration`, a new `plugin-e2e` test |
| P7 | mule: `--key`, the five-state `poll`, `--key-prefix`, the non-detaching cancel, the `mu-plugin-mule` bin. In mu: `hostMuleStarter` adds `--plugin mule`. | mu's exported link and job suites pass against `mu-plugin-mule`. A killed spawn recovers its job by `lookup(token)` with one dispatch. | `cargo test`; `scripts/smoke-lease.sh` with the plugin |

## Risks

- **Polling cost.** `mu wait` reconciles every poll (`src/cli/wait.ts:146`).
  A detached job's liveness is a backend round trip. Mitigations: reuse a
  status younger than the poll interval (`maxAgeMs`,
  `src/channels/types.ts:104-115`), and prefer `watch: stream`.
- **Declared facts are trusted.** `dedupe`, `fenceKey`, `inFlightMs`,
  `quiescence`, `outlivesHost` and `honours` are a plugin's promises. The
  suite tests them only against the fake backend.
- **The state-directory move.** mu 4 and mu 5 may both run on one machine
  for a while. The import's new `machine_id` keeps them separate sync
  peers. Agents started by one are invisible to the other.
- **Pane-id reuse.** Teardown relies on tmux never reusing a pane id
  (`src/workstream.ts:583`). Plugin handles do not, so job-record writes
  stay keyed by token.
- **SDK exports.** `src/index.ts` exports things P2 and P3 move:
  - `Transport` (`:120`);
  - `admitHostChannel` (`:313`);
  - `runHostTemplate` (`:351`);
  - `withHostChannel` (`:353`);
  - `closeRemoteWorktree` (`:463`).

  Each unit keeps or renames them in one commit, with a CHANGELOG line;
  there are no forwarding wrappers.
- **A reclaimed host can take a turn's commits.** A backend that
  reclaims a machine between a settle and a successful in-life collect
  loses that turn's commits. mu reports it, but cannot prevent it: the
  final collect finds the host gone, and the job goes lost with
  "uncollected work". mu has no daemon, so in-life collects run only when
  some mu invocation runs.
- **The deadline margin is a guess.** A collect slower than the margin
  loses work. The `deadline` event is urgent so that an orchestrator acts
  early.

## Out of scope

- An open `MuxBackend`, or any multiplexer plugin.
- Plugin verbs, plugin wait events, plugin tables.
- A remote write fence for plugin channels.
- A plugin channel whose turns can start without a delivery.
- Any backend-specific plugin.
- Renaming `carrier_jobs`.
- Detached views for built-in kinds, and detached mule leases.
- Plugin views on herdr.
- Placement across hosts.

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

Round 1 is kept as written. Where the rulings superseded a disposition
(R1: self-starting turns; R2: released-build safety), round 2 says so.

## Refutation round 2

Three fresh reviewers refuted draft 2 (`7ad9d62a`), from three lenses:

- **dispositions** (D): were round 1's fixes real;
- **races** (X): concurrency and crash windows;
- **buildability** (B): units, contracts, and the end-to-end walk.

The orchestrator then ruled R1–R7. Every finding was reproduced at its
cited lines before it was settled.

| ID | Sev | Lens | Finding (short) | Disposition | Where |
| --- | --- | --- | --- | --- | --- |
| D1 | high | dispositions | the self-starting wait rule hangs | cut-by-R1 | D1 Turn; D11; Out of scope |
| D2 | high | dispositions | P4 check: nine unlisted name comparisons (`src/cli/agents.ts:919` and others) | deferred to unit brief | D9 P4 invariant (ctl-only `--after-runs`/`--inc` on the pinned list) |
| D3 | high | dispositions | the `none` gate drops today's no-pane rule for file-handle kinds | fixed | D4: `handle: "file"` never acts on `none` (`src/agents/lease-carrier.ts:431-432`) |
| D4 | medium | dispositions | resolver and pgid-start columns missing; receipt CHECKs | fixed (R4) | D5 `effects` columns; plugin effects never touch receipt states |
| D5 | medium | dispositions | no-row reattach for plugin kinds unspecified | fixed | D3 reattach, both cases; D1 leftover row |
| D6 | medium | dispositions | `checkSteps(host, call)` cannot make `job`/`ctl` steps or split phases | fixed | D11 `CheckContext` with phases, `db`, `agent`, `root` |
| D7 | medium | dispositions | the host seam has no caps or handshake object | fixed | D6 `KeyCaps`, `caps.acquire`; D13 `host` seam object |
| D8 | medium | dispositions | mule's `remoteOnTimeout: "stopped"` contradicts the 5 s grace | fixed | D13 example and D15: `"unknown"` |
| D9 | medium | dispositions | `collect_due` set only by `mu wait` | fixed (R5) | D10: due is a comparison on the settled count, read by any mu read (superseded in draft 6 by R8: the final-collect flag, D10) |
| D10 | medium | dispositions | the text implied an out-of-repo provider is in use | fixed | Principle 7, D6, D18.1: stated as a condition, not a fact |
| D11 | low | dispositions | P3 allowlist omits `src/rebuild.ts:137` | deferred to unit brief | P3 invariant |
| D12 | low | dispositions | a released `agent answer` types into a read-only view | cut-by-R2 | D5 |
| D13 | low | dispositions | Risks omit the `Transport` SDK export | fixed | Risks (`src/index.ts:120`) |
| D14 | low | dispositions | citation drift (`host_stop`, alias, `pane_id` predicates, `idle?` cite) | fixed | `src/db-carrier.ts:30`, `src/agents/transport.ts:29`, D3, D1 |
| X1 | high | races | a send-pinned wait cannot see a child-woken final turn | cut-by-R1 | D1 Turn |
| X2 | high | races | a dedupe-only channel has no recovery path (`reconcile` never resends) | fixed (R3) | D4 rule table; `reconcile` dropped from D9 |
| X3 | high | races | a deduped replay lacks the original payload | fixed (R3) | D4 `effects.params_json`, `params_sha` |
| X4 | high | races | no resolver ownership columns | fixed (R4) | D5 `effects` |
| X5 | high | races | recovery reads and resends not fenced on the instance | fixed (R4) | D4 step 2; F10 |
| X6 | high | races | a crash after the release intent leaves a host releasing forever | fixed (R4) | D1 release rows; D4 table: reissue; F11 |
| X7 | high | races | an older collect clears a newer due turn | fixed (R5) | D10 compare-and-clear on the count read before the fetch (`src/remote-collect.ts:337-338` fences no turn today) (superseded in draft 6 by R8: the final-collect flag, D10) |
| X8 | high | races | a reap drops the collect obligation | fixed (R5) / cut-by-R2 | D10: it lives on the job record (superseded in draft 6 by R8: the final-collect flag, D10); released builds cannot open v14 |
| X9 | high | races | a released `host add` collides with a provider host's name | cut-by-R2 | D5; `host_identity` also refuses a re-acquired name |
| B1 | critical | buildability | deduped replay unbuildable for channels, job start and hosts | fixed (R3) | D4 rule table, `effects`, D6 `KeyCaps` |
| B2 | critical | buildability | waits carry no msgId; child-woken final turn | cut-by-R1 | D1 Turn |
| B3 | high | buildability | `runStop` (the stop template) cannot go through `HostLink` | fixed | D7: stop and attach belong to the lease kind's template runner |
| B4 | high | buildability | `RemoteWorktree` split breaks exec counts; the admitted-profile guard is lost | fixed | D7 `close` keeps two execs (`src/remote-agent.ts:374-560`); `admitted` callback |
| B5 | high | buildability | `jobLiveness` without `db` breaks gate; the row rule via liveness deletes live rows; site list incomplete | fixed / deferred | D8 `jobLiveness(db, …)`; the row rule uses view presence; site list deferred to unit brief |
| B6 | high | buildability | P3 allowlist omits `src/rebuild.ts` | deferred to unit brief | P3 invariant |
| B7 | high | buildability | P4: unlisted comparisons; mux steer; unknown-name test; fallback breaks a mock test | fixed / deferred | D9 matrix `as-send` (`test/channel-contract.test.ts:487`); null kept in P4 (`:1085-1087`); fallback stays the batched read; list deferred |
| B8 | high | buildability | P5 `checkSteps` signature cannot split phases or reach `db`/agent/root | fixed | D11 `CheckContext` |
| B9 | high | buildability | `pgid_start`, `resolver_*`, `pending_key` missing | fixed (R4) | D5 `effects` |
| B10 | high | buildability | reattach contradiction; rollback cannot stop a started job with no pane | fixed | D3; D1 "pane spawn failed" row (`src/agents/lease-carrier.ts:356-358`) |
| B11 | high | buildability | walkthrough gaps: acquire params, link wire target, collect inside a synchronous commit, release re-run | fixed | D1 acquire flags; D6 link and kind from the provider; D13 serialisable `target`; D10 collect after the result; release from `releasing` |
| B12 | medium | buildability | `spawn_receipts.channel` breaks the `SELECT *` rebuild | fixed (R2) | D5: v14 rebuild with column lists; no new column |
| B13 | medium | buildability | the basename rule vs. a `mule plugin` subcommand | fixed | D14 argv; D15 `mu-plugin-mule` bin target |
| B14 | medium | buildability | `quiescence: "unprovable"` contradicts the link contract | fixed | D7: allowed; removal then needs `--force` |
| B15 | medium | buildability | the provider recovery branch checks no instance | fixed | D5 `remote_recovery.host_identity` with the instance; D4 fence |

No finding was rebutted:

- **Cut by the rulings:** five (D1, D12, X1, X9 and B2), plus X8 in part.
- **Deferred to the unit brief, with the invariant kept:** three about a
  unit's check wording (D2, D11 and B6), plus B5 and B7 in part.
- **Fixed:** the rest.

## Refutation round 3

Three reviewers refuted draft 3 (`074fc931`) under R1–R7, from three
lenses:

- **author** (A): can a plugin author implement the contract;
- **crash** (K): crash and concurrency windows;
- **dispositions** (S): were round 2's fixes real.

Each finding was reproduced at its cited lines. Draft 4 closes each one
with the smallest rule or column that does it; it adds no new mechanism.

| ID | Sev | Lens | Finding (short) | Disposition | Where |
| --- | --- | --- | --- | --- | --- |
| A1 | high | author | a byte-identical replay keeps an expired deadline | fixed | D4: the persisted request is the method's `params`; the envelope id and `deadline` are fresh on every send |
| A2 | high | author | `Map` and `undefined` results have no wire encoding | fixed | D13 "Wire encoding": a JSON object keyed `<ws>/<name>`; `null` for absent |
| A3 | high | author | the watch target lacks `paneId`, which observations require | fixed | D13: mu adds the identity fields (`src/agents/observe.ts:36-41`) |
| A4 | high | author | compare-and-clear cannot move to a new incarnation | fixed | D10: a compare-and-clear on turn counts (superseded in draft 6 by R8: the final-collect flag, D10) |
| A5 | medium | author | dedupe is one channel-wide capability | fixed | D9 `dedupe` per method; D13 example |
| A6 | medium | author | `not-accepted` receipts have no disposition | fixed | D4 table: only `accepted` resolves, `not-accepted` stays unknown (`src/agents/task-spawn.ts:721-727`) |
| A7 | medium | author | `channel.command` is missing from the effects | fixed | D4 inventory and table |
| A8 | medium | author | the fetch result obligation is unstated | fixed | D7 `fetch` doc: `FETCH_HEAD` must name the commit (`src/remote-collect.ts:196-231`) |
| A9 | medium | author | the channel handshake has no name field | fixed | D13 `channel: {name, caps}`; D8 `channel` must equal it |
| K1 | high | crash | the `mu5` import takes no lock, and its rename can replace | fixed | D5 step 1 (strict `mkdir` lock, `src/file-lock.ts`) and step 6 (no-replace link) |
| K2 | medium | crash | the live-row check runs before the copy and omits delegates | fixed | D5 step 5.3: checked on the snapshot, running `delegate_calls` included (`src/delegate-process.ts:124-136`) |
| K3 | medium | crash | unflushed ops under the old `machine_id` are never published | fixed | D5 step 3: refuse while unpublished ops remain (`src/segments.ts:248,477`, `src/sync.ts:364-373`) |
| K4 | low | crash | `upgradeSchema` cannot nest; the id seed does nothing on an existing row | fixed | D5 step 5: an `UPDATE` first, then `upgradeSchema` in its own transaction, then the 13 → 14 step; the rename is the commit point |
| K5 | medium | crash | the claim accepts a live creator's row; result writes are unfenced | fixed | D4 claim: a live creator owns `pending`; result writes are compare-and-set on owner; F12 |
| K6 | medium | crash | abandon ignores live effect owners and leaves effect rows | fixed | D1 abandon rows: refuse while a live owner holds an effect; delete the effect rows and log their keys |
| K7 | medium | crash | the clear compares `runs` across opaque incarnations | fixed | as A4 (superseded in draft 6 by R8: the final-collect flag, D10) |
| K8 | medium | crash | a deduped resend can land after a newer send | fixed | D4: a delivery is resent only while no newer delivery to the agent exists |
| K9 | medium | crash | F11 does not converge on a `lost` host | fixed | D1 `lost` row and D6 "`gone` is a proof": close records the tree gone and the job stopped; F11 |
| K10 | medium | crash | the fetch contract is unstated | fixed | as A8 |
| K11 | low | crash | close on an unresolved dedupe-only start launches it to stop it | rebutted | D4 "Who triggers": the resend is the only way to learn whether a job exists; start then stop leaves nothing, while refusing could leave an orphan |
| S1 | high | dispositions | the collect sequence fails on a new incarnation, after the reap, and for `--cwd` workers | fixed | D10: collect state on the job record, which survives the reap; a `--cwd` worker owes nothing (`src/remote-collect.ts:331-336`) (superseded in draft 6 by R8: the final-collect flag, D10) |
| S2 | high | dispositions | a `lost` host deadlocks close and release | fixed | as K9 (`src/agents/close.ts:579-584`, `src/remote-agent.ts:404-426`) |
| S3 | high | dispositions | polled `readStates` never settles a plugin wait; `rewatchOnPoll` hardcodes ctl | fixed | D13: a plugin channel must stream and tie its settle text; an already settled turn is reported at once. `src/wait-latch.ts:86` is a P4 capability site (D9 invariant) |
| S4 | high | dispositions | a no-row plugin reattach has no fields to launch from; trees go unrecorded | fixed | D3: no-row plugin leftovers are closed, never reattached; `carrier_jobs.tree_base` with `tree_path`, written before `job.start` (D5) |
| S5 | medium | dispositions | per-method dedupe; the channel name in the handshake | fixed | as A5, A9 |
| S6 | medium | dispositions | D15 keeps the starter's shell; the file-handle `lookup` is missing from D4 | fixed | D15: only `fetch` stays a template, and the view comes from `job.start` with `--key`; D4 row for `handle: "file"` |
| S7 | low | dispositions | `identity` and `fingerprint` are listed as wire calls and as computed | fixed | D7, D8: computed by mu; `job.identity` removed from D13 |

One finding is rebutted (K11) and the other 26 are fixed. Two round-2
dispositions changed:

- **B10 / D5:** a no-row plugin reattach is now cut rather than specified
  (S4).
- **X7:** the compare-and-clear is now on pairs (A4). Draft 6 supersedes
  both by R8: the final-collect flag (D10).

## Refutation round 4

Two reviewers checked draft 4 (`f7816b43`):

- **fix-check** (C): were round 3's fixes real. Verdict: refuted on one
  high.
- **fresh full read** (N): the whole spec from scratch. Verdict:
  confirmed, with mediums and lows. Its end-to-end walk (register through
  release) mapped every step to a stated contract.

Each finding was reproduced and closed with the smallest change.

| ID | Sev | Lens | Finding (short) | Disposition | Where |
| --- | --- | --- | --- | --- | --- |
| C1 | high | fix-check | an unobserved final settle disappears across a reap | fixed | D10: the reap made the job owe a collect (`src/reconcile.ts:137-142`, `src/agents/reap.ts:63`) (superseded in draft 6 by R8: the final-collect flag, D10) |
| C2 | medium | fix-check | the newer-delivery guard has no durable ordering and no serialization | fixed | D4: `agents.delivery_seq` and `effects.seq`; a resend claims only at the high-water mark; no new delivery while one is `resolving` |
| C3 | medium | fix-check | the unpublished-op check races the backup | fixed | D5 step 5.3: checked on the snapshot against the segment file (`src/sync.ts:364-373`, `src/segments.ts:475-479`) |
| C4 | medium | fix-check | a `--plugin` profile has no `exec`, but recovery pins exec bytes | fixed | D5: `host_profiles` rebuilt with nullable `shell`/`exec`; a `--plugin` profile's identity is `plugin:<name>:<instance>` (`src/db.ts:1338-1342`, `src/remote-recovery.ts:344-363`) |
| N1 | medium | fresh | the newer-delivery rule cannot be evaluated | fixed | as C2 |
| N2 | medium | fresh | the profile/host-record name fence was dropped | fixed | D1 acquire row: `host add` refuses a host record's name; D6 `resolveHost` refuses a name in both |
| N3 | medium | fresh | nothing calls `host.status`, so `lost` has no trigger | fixed | D1 `lost` row: host verbs; once after a failed link or job call on a provider host; the D10 reads |
| N4 | medium | fresh | no idle-reclaim wake-up | fixed | D10 wake-up for idle reclaim; Risks: no read, no wake-up (superseded in draft 6 by R8: the final-collect flag, D10); only the deadline timer remains |
| N5 | low | fresh | the pairs are said to survive the stop, but the record is deleted; release-while-due is vacuous | fixed | D10: the collect state lives on the job record until its tree's close; the vacuous release rule removed (superseded in draft 6 by R8: the final-collect flag, D10) |
| N6 | low | fresh | which id `$/cancel` cancels for a watch | fixed | D13: `$/cancel {watchId}` ends a watch; `{id}` is for a pending request |
| N7 | low | fresh | what `schema` digests; `checks` has no type | fixed | D13: the sha256 of the published schema file; `LinkCaps.checks`, `JobCaps.checks` |
| N8 | low | fresh | `StateSource` is closed; ctl-only `runs`/`incarnation`; `checkSteps` wire params | fixed | D13 methods table: `plugin:<name>` source, mandatory `runs`/`incarnation`, `{phase, root?, agent?}` (`src/agent-state.ts:12`) |
| N9 | low | fresh | no `host_identity` backfill for imported rows | fixed | D5: `host_identity = host_exec` |
| N10 | low | fresh | D6 read as claiming an out-of-repo provider exists | fixed | D6 "Second implementation" is a requirement; the out-of-scope line is generic |

All 14 are fixed, and none is rebutted.

## Refutation round 5

One reviewer checked draft 5 (`c4020464`) and refuted it on one high. The
orchestrator then ruled R8: a final-collect flag replaces the collect
sequence, which had drawn a new race every round. Draft 6 applies R8, and
D10 is shorter for it.

| ID | Sev | Lens | Finding (short) | Disposition | Where |
| --- | --- | --- | --- | --- | --- |
| V1 | high | fix-check | a delayed pre-reap read can erase the reap's due marking | cut-by-R8 | D10: nothing a read writes can clear `final_owed`; only a collect that started after the stop can (`stop_gen` compare-and-clear); F13 |
| V2 | medium | fix-check | reaped obligations have storage but no discovery path | fixed | D10 "Who sees it": leftovers, `mu state` notices and `mu host release`'s refusal read job records, not only live agents (`src/cli/state.ts:238-246`) |
| V3 | medium | fix-check | `--abandon-job` deletes the only record before the tree's close | fixed | D1 abandon row: it records the loss of an owed final collect; it does not abandon the tree, which its recovery record and the close rule still protect (`src/agents/close.ts:573-609`) |
| V4 | medium | fix-check | `--plugin` profile identity is contradictory across D5 and D7 | fixed | D5 `host_identity` and D7 `fingerprint` use the same three forms (`src/remote-recovery.ts:344-363`) |

All four are settled: one by the ruling, three fixed. R8 also removes the
idle-reclaim wake-up and every rule that depended on the collect
sequence. Risks now states the loss mu reports but cannot prevent.

## Refutation round 6: backend mapping

A survey mapped draft 6 onto a backend that provisions machines on
demand and runs session-hosted agents on them. It listed what the
protocol cannot express, under gap ids (C1–C3, H1–H3, M1–M4). Two fresh
reviewers refuted the list. Five items were accepted, and each is settled
with the smallest change. By then P1–P6a were built on `spec/mu-plugins`
and P6b (in review) on its own branch. So each row names the built code
it changes and the unit that carries it. Code under `src/plugins/` and
`schemas/` is P6b's, read on its branch.

| ID | Sev | Gap | Finding (short) | Disposition | Where | Unit | Built code it changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | critical | C1 | a backend that creates a job only with its first prompt, which starts turn 1, cannot be expressed: `JobSpec` has no prompt, and a turn starts only on a send | fixed | D1 Turn; D4 (`job.start` row, `seq`, triggers); D8 `firstTurn: "at-start"`, `JobSpec.firstPrompt`, `JobStart.baseline`, the folded spawn order; D11; D12; D13 (load rule, `job.start`, `channel.send`); walkthrough 3 and 5 | P6e (the caps on the wire in P6c) | `src/jobs/types.ts` `JobCaps`; P6b's job narrower in `src/plugins/protocol.ts` and `schemas/plugin-protocol-v1.json`; `src/agents/task-spawn.ts` and `src/agents/spawn.ts` (the placeholder row first for an `at-start` kind) |
| G2 | high | C2 | session-hosted jobs outlive their machine, but `gone` made the `lost` close record them stopped without a stop | fixed | D1 `lost` and abandon rows; D6 "`gone` is a proof"; D8 `outlivesHost`; D10; D12; F11; walkthrough 7 | P6d (the cap on the wire in P6c) | the `HostStatus` comment in `src/host-provider.ts`; P6b's job narrower. The `lost` close itself is P6d's, not yet built. |
| G3 | high | C3 | a fresh provider host has no clone of the project, and commits made after acquire never reach it, so `make`'s `rev-parse` fails | fixed | D7 `LinkCaps.push`, `HostLink.push`, the provider-host base rule and `RemoteBaseMissingError`; D12; D13; D15 (mule: no `push`); walkthrough 1 and 3; the survey table | P6d (the cap on the wire in P6c) | `src/host-link.ts` (an optional field and method: the template link is unchanged); `prepareRemote` in `src/remote-worktree.ts` (provider hosts only); P6b's link narrower and its link adapter, `src/plugins/link.ts` |
| G4 | high | H2 | `JobSpec` fields a hosted harness cannot honour (`cmd`, `env`, `role`, `sockets`) could be dropped silently; `read-only` could run with the parent's role | fixed | D8 `honours`, honour or refuse, `JobSpec.commandSource`; D12; D13 (load rule); D15 (mule honours all) | P6c | `requireHostSpawn` in `src/agents/spawn-remote.ts` (P3) hosts the refusal; `src/jobs/types.ts` `JobCaps` (built-ins honour all); P6b's job narrower |
| G5 | medium | M1, M2 | `runs` density was unstated; `idleReclaimMs` had no defined clock | fixed (wording) | D1 Turn and D13 readings (`runs` is dense); D6 and D12 (`idleReclaimMs` is the provider's window, with no mu timer) | P6e asserts `runs`; P6d reads `idleReclaimMs` | none in behaviour: `src/next-recover.ts:157` already relies on density; the `HostFacts` comment in `src/host-provider.ts` |

Both reviewers refuted H1 (an asynchronous release), H3 (a lookup that
cannot prove absence), M3 (a provider-wide quota) and M4 (a constant
incarnation): each is expressible today, and nothing changes. The
narrowers in P6b (in review) accept only the keys they name, so G1–G4's new fields
are a schema change, made once in P6c with one digest change. Each new
field is optional, so P6b's fixtures stay valid.

### Round 6b: the amendment refuted

Two reviewers checked draft 7 (`e93903a8`). One refuted it with two
highs and two mediums. The other confirmed it, with one low that matches
the first high. All four are fixed.

| ID | Sev | Finding (short) | Disposition | Where | Unit | Built code it changes |
| --- | --- | --- | --- | --- | --- | --- |
| G1a | high | a spawn replay that resolves an `at-start` start by `lookup` gets only a handle: no view and no opening incarnation for readiness and the receipt | fixed | D8 `lookup`'s `found` is the whole `JobStart` for a reply kind, and the recovery bullet; D4 `job.start` row; D13 `job.lookup`; D16 (`found` equals the reply) | P6e (the job adapter's lookup type in P6c) | none yet: `src/jobs/types.ts` gains `lookup`, with this type, in P6c |
| G1b | high | the first delivery's receipt lived on the spawn receipt, which needs a task (`src/db-receipts.ts:34,50`), so taskless `spawn --send` had none | fixed | D8: the job record is the receipt (`first_msg_id`, `first_inc`); `mu agent check` resolves the start effect, then answers `accepted runs=0` or `unreachable`; `--send` arms its wait from the start's baseline; D5 columns via `ADDED_COLUMNS`; D4 triggers | P6e | `carrier_jobs` (`src/db-carrier.ts:23-43`) and `ADDED_COLUMNS` (`src/db-schema.ts:59`); `cmdAgentCheck` (`src/cli/agents.ts:782`); the taskless `--send` path (`src/cli/agents.ts:196-253`) |
| G6 | medium | the "P6b landed" claim was false at the base: `spec/mu-plugins` has no `src/plugins/` or `schemas/` | fixed | status line, round 6 intro and table header, History: P6b is "(in review)" on its own branch | — | none |
| G7 | medium | D9/D13's `SendResult` (`channel`, ack `exact`/`confirmed`/`sent`/`unknown`) contradicted P4's `ChannelSendReply` | fixed | D9 now states `ChannelSendReply` exactly as landed (`src/channels/types.ts:235-239`, ack `exact`/`acknowledged`/`none`), and the conversion: built-ins through `sendRun`, the CLI through `toSendResult`; D13's send, fresh and command results | P6e | none: P4 already built it |

## History

- **Draft 1** (`f1e092e0`) started from a decision sketch, tested by five
  code surveys.
- **Draft 2** (`7ad9d62a`) settled round 1's 49 findings and the seven
  open questions. It cut the remote fence, the checks seam and the policy
  interface, and split P6.
- **Draft 3** (2026-11-09) applies rulings R1–R7 and settles round 2's 38
  findings:
  - it drops self-starting turns and released-build safety;
  - it moves to schema 14, `mu5` and mu 5;
  - it adds the `effects` journal with payloads and one rule table;
  - it splits P6 into P6a–P6e.

- **Draft 4** (2026-11-09) settles round 3's 27 findings with rules and
  columns only:
  - params-only replay;
  - the JSON wire encoding;
  - the creator-owned claim and newer-delivery rule;
  - the pair-based collect sequence;
  - `lost` hosts closing without the host;
  - the import lock and snapshot check;
  - per-method dedupe and the channel name.

- **Draft 5** (2026-11-09) settles round 4's 14 findings with rules and
  columns only:
  - a reap that made the job owe a collect (replaced in draft 6);
  - a per-agent delivery high-water mark;
  - the snapshot-side unpublished-op check;
  - `--plugin` profile identity;
  - the restored name fence;
  - the `status` call sites;
  - the idle-reclaim wake-up;
  - the wire details.

- **Draft 6** (2026-11-09) applies R8 and settles round 5's four
  findings:
  - the final-collect flag, cleared only by a collect that started after
    the stop;
  - best-effort in-life collects with backoff;
  - discovery through job records;
  - abandon records the loss;
  - one identity form per host kind.

  Every file:line was reopened at `42881032` (mu) and `1192781` (mule).

- **Draft 7** (2026-11-09) settles round 6's five accepted items, checked
  against the built P1–P6a and P6b (in review):
  - a first turn at `job.start` (`firstTurn: "at-start"`, `firstPrompt`);
  - jobs that outlive their host (`outlivesHost`);
  - seeding a provider host's repo (`link.push`, or a typed refusal);
  - honour or refuse for `JobSpec` fields (`honours`);
  - dense `runs` and the meaning of `idleReclaimMs`.

  Round 6b then fixes four findings on draft 7: lookup recovery returns
  the `JobStart`, the job record is a taskless first prompt's receipt,
  the send result is P4's `ChannelSendReply`, and P6b is marked in review.

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
