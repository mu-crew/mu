# The plugin protocol, version 1

A **plugin** is an executable that implements one or more of mu's seams
out of process. mu runs it as a child, speaks JSON-RPC 2.0 to it over
stdio, and records what it reports. A plugin only reports facts. It never
writes mu's database, state directory or log, and it cannot call into mu.

This page is the normative prose. The machine-readable schema is
[`schemas/plugin-protocol-v1.json`](../../schemas/plugin-protocol-v1.json),
shipped in the package. Terms are in [VOCABULARY](../VOCABULARY.md#plugins-hosts-and-jobs).

Status: this build drives every seam: the **link** (`mu host add
--plugin`), the **host** (`mu host acquire --provider`), the **job** (spawn,
`--task` included, stop, reattach of an agent on a plugin host) and the
**channel** (its agents' reads, watches and deliveries). A provider host's
facts drive `mu wait`'s deadline timer, its in-life collects and `mu state`'s
notices (below).

## Registration and trust

```sh
mu plugin add <name> -- /absolute/path/mu-plugin-<name> [args…]
mu plugin list
mu plugin rm <name>
```

- mu never discovers a plugin. It does not scan `PATH`, a directory or a
  package; it runs only the argv you registered.
- The executable's basename is `mu-plugin-<name>`. mu refuses the plugin
  if the path is not absolute, if the file (or a symlink's target) is not
  a regular file you own, or if the group or the world can write it.
  These checks run at `add` and again every time mu starts the plugin.
- `add` runs the handshake once and stores what the plugin declared.
  Running `add` again with the same argv re-checks the plugin and records
  its new declaration. A different argv for a registered name is refused
  (`mu plugin rm` first).
- `rm` is refused while a host profile, a host record, a job record or an
  effect names the plugin.
- A channel's identity is its plugin and its name, and an agent's row
  records both. `add` refuses a plugin whose channel name another registered
  plugin's channel holds in the same DB.
- mu does not hash the binary. The handshake's `instance` is the fence.

A host profile uses a plugin as its link:

```sh
mu host add box --plugin <name> [--fetch '<template>'] [--repo …] [--max-sessions …]
```

Such a profile has no `--shell` and no `--exec`. Its `--fetch` template
runs when the plugin's link declares `fetch: false`, and is required
then; a link that declares `fetch: true` needs none. An agent spawns on it
through the plugin's job seam (below); a link-only plugin's host takes no
spawn.

## Transport

- JSON-RPC 2.0. Each message is one JSON object on one line, UTF-8, at
  most 1 MiB, on the plugin's stdin (from mu) and stdout (from the
  plugin). A line that is not valid UTF-8 is an invalid message; mu
  never repairs one.
- stderr is drained and never parsed or stored. Its first line may appear
  in an error, cut to 400 characters.
- A reply always carries `result`; an absent result is `null`. An error
  carries `data.kind` (below).
- The plugin sends no request to mu. Its only notifications are
  `watch/settled` and `watch/restarted`, which end a watch.
- A message that is not valid (not JSON, an unknown field, a reply to no
  pending request, a request to mu) breaks the plugin for the rest of the
  invocation. mu reaps it and treats every pending call as unanswered.

## Process

- mu starts the registered argv on first need, as its child in its own
  process group, for one invocation.
- The plugin gets mu's environment minus mu's local-only variables
  (`MU_DB_PATH`, `MU_STATE_DIR`, `MU_SYNC_DIR`, the agent identity and
  control-socket variables). Every call's `target` carries the identity
  it needs.
- To stop a plugin, at a normal exit or on a SIGINT, SIGTERM or SIGHUP,
  mu sends `$/cancel` for each pending call and `shutdown`, closes stdin,
  waits at most 5 s for the plugin's group to empty, and kills the
  group. Every stop is this one sequence, whatever begins it (a call's
  deadline, an abort, a signal, an invalid message, the leader's exit).
- The first such signal also means mu is terminating: from then on no
  plugin starts or restarts and no request is sent, and later signals are
  absorbed. Once every plugin's group is empty, a signal no verb handles
  is raised again. Only an exit that cannot wait (a crash) kills the group
  at once.
- On stdin EOF the plugin must cancel or finish its in-flight calls and
  exit within 5 s. This is what it sees when mu dies, even by SIGKILL.
- mu tracks the group, not the leader. When the leader exits, anything
  left in its group is killed at once.
- The plugin never detaches a helper or a run (`setsid`, a double fork
  into another group): everything it starts stays in its group. The
  contract suite reports a process the plugin started outside its group.

## Handshake

mu sends:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":{"min":1,"max":1},"mu":"5"}}
```

The plugin answers with the protocol version it chose, its name and
version, an `instance`, the schema digest and its seams:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocol":1,"plugin":{"name":"box","version":"0.1.0"},"instance":"prod-eu","schema":"sha256:…","seams":{"link":{"fetch":false,"slots":"self","remoteOnTimeout":"unknown","quiescence":"provable","maxScriptBytes":131072,"checks":["reach"]}}}}
```

- `instance` names the backend configuration the plugin addresses (1–128
  characters). A `--plugin` host's identity is `plugin:<name>:<instance>`:
  a worktree recovery pinned under one instance refuses under another.
- `schema` is `sha256:` and the hex sha256 of the exact bytes of the
  `schemas/plugin-protocol-v<n>.json` the plugin was built against.

### Seams

| Seam | Object | Notes |
| --- | --- | --- |
| `link` | `fetch`, `push` (optional: can seed a host's repo with a commit), `slots` (`mu`: each call holds a host channel; `self`: the plugin arbitrates), `remoteOnTimeout` (`stopped`, `stopping` or `unknown`), `quiescence` (`provable` or `unprovable`), `maxScriptBytes`, `checks` | `maxScriptBytes` is required |
| `job` | `kind`, `view` (`bound`, `detached`), `handle` (`pane`, `file`, `reply`), `start` (key capabilities), `channel`, `checks`, and optional `firstTurn` (`on-send`, `at-start`), `outlivesHost`, `honours` (`{command, env, sockets, roles}`) | `honours` absent: `env` only, `full-access` only |
| `host` | `acquire` (key capabilities) | needs `link` and `job` |
| `channel` | `name`, `caps` (`fence`, `receipt`, `dedupe`, `steer`, `interrupt`, `fresh`, `answer`, `command`, `watch`, `settleText`) | |

Key capabilities are `{lookup, fenceKey, dedupe?: {exact: true, windowMs}, inFlightMs?}`.
`checks` lists the `host check` phases (`template`, `reach`, `agent`) the
seam contributes steps to.

### Load rules

mu refuses the plugin (exit 4) when:

- the protocol version is outside mu's range, or the plugin answered the
  handshake with an error;
- its name is not the registered name, or its schema digest is not the
  published file's;
- the declaration does not match the schema: a missing or unknown field,
  an unknown seam or value;
- a seam the registration or a host needs is missing, or no seam is
  declared;
- a `host` seam comes without `link` and `job`;
- `host.acquire`, or `job.start` with `handle: "reply"`, declares neither
  `lookup` nor exact `dedupe`;
- a channel declares `watch` other than `stream`, `settleText: "none"`, or
  a `fence` other than `none`;
- `job.channel` is not the channel seam's `name`;
- `firstTurn: "at-start"` comes without `handle: "reply"`, or
  `honours.env: false` without a `channel`;
- the declaration differs from the one recorded by `mu plugin add`.

## Calls

Every request's `params` carries `deadline` (epoch ms) and a `target`:

```ts
{
  agent?: { workstream: string; name: string; incarnation: number },
  job?: { kind: string; key: string; handle?: string },
  host: { name: string; handle?: string; instance?: string },
}
```

The `params` mu sends are the same on every resend. Only the envelope `id`
and the `deadline` are new each time.

### The host

A provider plugin (`mu host acquire --provider <name>`) declares `host`
with `link`, and with `job` when its hosts run jobs (a host whose provider
declares no job seam refuses a spawn up front). A provider host's link and job calls carry its
`handle` and `instance` in `target.host`.

| Method | Params beyond `target`, `deadline` | Result |
| --- | --- | --- |
| `host.acquire` (effect) | `key`, `params` (the `--param` map) | `{handle, deadlineAt?, idleReclaimMs?, maxJobs?}` |
| `host.lookup` | `key`, `fence` | exactly one of `{found: <acquire's result>}`, `{pending: true}`, `{none: true}`, `{unknown: reason}` |
| `host.status` | — | `{state: "up", handle, …facts}`, `{state: "gone", reason}`, `{state: "needs-human", remedy}`, `{state: "unknown", reason}` |
| `host.release` (effect, idempotent) | `key` | `null`; a host already released resolves |

An `up` status's facts are a patch over the last ones mu recorded: an
omitted fact keeps its value, and a fact sent as `null` is cleared.

`gone` is a proof: the machine and its worktrees no longer exist, and its
jobs too unless the job seam declares `outlivesHost`. mu then records the
host `lost`: its trees are recorded gone and its jobs stopped without a
call, except an `outlivesHost` job, which mu still stops with `job.stop`.

### The link

| Method | Params beyond `target`, `deadline` | Result |
| --- | --- | --- |
| `link.exec` | `script` (POSIX sh), `cwd` (`.` is the login directory), `timeoutMs` | `{exitCode, stdout, stderr, partial}`; `exitCode: null` when timed out, `partial` when output was cut |
| `link.fetch` | `remoteCwd`, `localRepo`, `timeoutMs` | as `link.exec`. On success `localRepo`'s `FETCH_HEAD` names `remoteCwd`'s HEAD |
| `link.push` (only with `push: true`) | `localRepo`, `remoteRepo`, `rev` (a full sha), `timeoutMs` | as `link.exec`. On success `remoteRepo` (created as a git repository if absent) holds `rev`. Idempotent: a repo that already holds it succeeds untouched. Not an effect: a timed-out push is re-run, and mu's own `rev-parse` check still runs before a worktree is made from `rev` |
| `link.checkSteps` | `phase`, `root?`, `agent?` | `[{step, ok, detail}]`, `ok` one of `true`, `false`, `null` (skipped) or `"warn"` (passed with a warning: `host check` prints a `warn` line and does not fail); mu names each step `<plugin>:<step>`, except `handback`. A `human` error, or a `handback` step, is a hand-back: `host check` skips the steps that follow |

The plugin enforces `timeoutMs` itself and answers with `exitCode: null`.
With `remoteOnTimeout: "stopped"` it guarantees nothing it started still
runs when it answers. With `"stopping"` it guarantees that within one grace
(5 s) after its answer: a relay whose remote side stops asynchronously. mu
then waits the grace out, still holding the call's channel, before it
returns the timed-out run, and counts the link as `stopped`. With
`"unknown"` a timed-out script may still run. mu computes `fits` (a script's bytes against `maxScriptBytes`) and
the host identity, and deletes `FETCH_HEAD` before a fetch. These are not
wire calls.

### The job

| Method | Params beyond `target`, `deadline` | Result |
| --- | --- | --- |
| `job.start` (effect) | `key` (the job record's token), `spec` (the whole `JobSpec`: workstream, name, harness, role, cmd, `commandSource`, cwd, env, sockets?, firstPrompt?) | `{view: {command, env, cwd?}, handle?, baseline?}`; `handle` when the kind's handle is `reply` |
| `job.lookup` | `key`, `fence` | exactly one of `{found: {handle, view?, baseline?}}` (a `reply` kind's is its whole start reply; a `file` kind's may be the handle alone), `{pending: true}`, `{none: true}`, `{unknown: reason}` |
| `job.status` | — | `{state: "running"}`, `{state: "ended", exit}`, `{state: "lost" \| "unknown", reason}` |
| `job.stop` (effect, idempotent) | `key` | `null`, only on proof the job is gone |
| `job.attach` | — | a view `{command, env, cwd?}` |
| `job.checkSteps` | `phase`, `agent?` | steps, as `link.checkSteps` |

A spawn that requests a `JobSpec` field the kind does not `honours` (a
`read-only` role, a `--command`, the sockets of an agent on ctl) is refused
before any call (exit 2); mu never drops the field.

A spawn on a plugin host (`mu agent spawn <name> --host <h>`, a provider
host or a `--plugin` profile whose plugin declares `job`) runs in this
order, each step before the next one's effect:

1. Refusals, before anything is written: a field the kind does not
   `honours`, a kind without `channel` (its agents' own channel is not
   driven yet), a backend that cannot run a command line (herdr), an
   `at-start` kind without a first prompt (`--send` or `--task`).
2. The job record (the name's fence; a provider host's admission: `ready`,
   outside the deadline margin, under `maxJobs`).
3. The site. A `--worktree` on a provider host resolves `--from` (default
   `HEAD`) in the caller's checkout, `link.push`es it when declared, and
   makes the tree from that commit; the record owes its final collect.
4. `job.start` with the whole `JobSpec`. An `at-start` kind's
   `firstPrompt` is `--send`'s text, or `--task`'s brief: that delivery goes
   only here, never as a `channel.send` (every later send carries
   `firstPrompt: false`). Its reply, and its `job.lookup`'s `found`, must
   carry `baseline` with `runs: 0`: anything else is an invalid reply, so the
   start's outcome is unknown. Before it, an `at-start` kind's spawn writes
   the agent's placeholder row; a `--task` spawn claims the task for it and
   journals its receipt `sending`, and `firstPrompt.msgId` is the receipt's
   msgId (the job record's `first_msg_id`).
5. The view: a pane running the start's `view` command with stdin from
   `/dev/null`, and the agent row on the kind's channel.
6. Readiness: the start's `baseline` (an `at-start` kind), else
   `channel.baseline` answering within `MU_SPAWN_JOB_MS`. A failure after
   the start stops the job (`job.stop`) before the tree and the record go.

An `at-start` start with no definite answer is never resent and never
rolled back: the placeholder, the claim and the job record stay, and the
spawn reports the delivery unknown (exit 1) with the msgId. A replay of the
same `--task` attempt, or `mu agent check <agent> <msgId>` with the job
record's `first_msg_id`, resolves the start by its rule-table row (below):
a `found` start records the handle and `first_inc`, opens the view from the
reply's `view` (else `job.attach`) and answers `accepted runs=0` (exit 0);
an unresolved one answers `unreachable` (exit 1) naming the effect key; a
proven `none` fails the attempt and rolls it back, and the check then asks
`channel.receipt` as for any msgId.

A `bound` view's death ends the job: `agent close` kills the view, then
stops the job. A `detached` job outlives its view: reconcile keeps a row
whose view is gone while `job.status` reads `running` or `unknown`, `agent
close` stops the job before it kills the view, and `agent reattach` opens a
new view from `job.attach` on the same row (refused before the call on a
backend that cannot run a command line). A view the backend fails to start,
even after it reported the pane, fails the spawn (the job is stopped) or the
reattach (the row keeps its pane).

### The channel

A plugin channel's `name` is the agents' `agents.channel`, and its readings'
source is `plugin:<plugin>`. It never decides liveness: mu asks the job's
`job.status` for every reading, watch and last run, and an `ended` or
`lost` job reads dead whatever turn state the plugin reports (`unknown` is
never a death). An observation or reading is the asked agent's: one about
another agent, or one with no reading at all, is an unknown turn, and its
liveness is still the asked job's. A turn state is `idle`, `busy`, `blocked` (a pending
dialog) or `unknown`; `runs` is dense (0 before any settle, one more per
settled turn in the incarnation); `incarnation` names the channel's
session.

| Method | Params beyond `target`, `deadline` | Result |
| --- | --- | --- |
| `channel.readStates` | `targets` (mu asks one agent per call) | `{"<workstream>/<name>": {state, since, runs, incarnation, reason?, pending?}}` |
| `channel.baseline` | — | `{runs, incarnation?}` or `null` |
| `channel.receipt` | `msgId` | `{state: "accepted", id, runs?, at?, incarnation?}`, `{state: "not-accepted", id}`, `{state: "unreachable", id, reason}` |
| `channel.lastRun` | `afterRuns`, `inc?` | the settled turn past `afterRuns` as an observation, or `null` |
| `channel.watch` | `afterRuns?`, `inc?` | `{watchId, initial, afterRuns?}`, then one notification |
| `channel.send` (effect) | `text`, `msgId`, `mode` (`followUp`, `steer`), `force`, `firstPrompt` (never true for an `at-start` kind), `expectIncarnation?` | `{channel, ack, baseline?, msgId?}` |
| `channel.fresh` (effect) | `text`, `msgId`, `force`, `expectIncarnation?` | as `send` |
| `channel.command` (effect) | `name`, `instructions?`, `force`, `expectIncarnation?` | as `send` |
| `channel.interrupt` (effect) | `text`, `msgId`, `timeoutMs`, `expectIncarnation?` | `{wasBusy, pending, runs?, msgId?, incarnation?}` |
| `channel.abort` (effect) | `timeoutMs` | `{before, after, settled, aborted, pending}` (`idle` or `busy`) |
| `channel.answer` (effect) | `keys`, `force` | `{keys, ack}` (`confirmed` or `unknown`) |

An observation is `{status, settled, since, runs, incarnation, reason?,
pending?, lastText?, lastTextTruncated?, lastError?}`: mu adds the agent's
identity from its own row. A send reply's `channel` is the seam's name, its
`msgId` the one sent; `baseline` is the turn count before the turn the
delivery started, which the delivery's wait counts from.

The watch streams. After the reply the plugin sends exactly one
notification, `watch/settled {watchId, observation}` once a turn past
`afterRuns` settled (at once if one already has), or `watch/restarted
{watchId, incarnation}` when the channel restarted. mu ends a watch early
with `$/cancel {watchId}`; a notification that crosses the cancel is
ignored. A watch lives only in the invocation that asked.

A capability that is `none` or `false` means mu never calls that method:
`steer: "none"` refuses `send --steer`, `fresh` other than `in-place`
refuses `send --fresh`, `interrupt: "none"` refuses interrupt and abort,
`answer` and `command` false refuse theirs, each with the built-ins' typed
error. A job on a `lost` host takes no delivery.

### Effects and replay

Before an effect (`job.start`, `job.stop`, `host.acquire`, `host.release`, a
delivery), mu writes its intent: the key, the exact `params` and their
sha256, the plugin's `instance` and process group. A definite reply deletes
it. After a crash, a timeout or `unknown-outcome`, the next verb on the
subject resolves it, and refuses while the invocation that wrote it, or
another resolving it, still lives:

- under another `instance`, nothing is asked or resent (`stop-changed`);
- `job.stop` and `host.release` are reissued;
- `job.start` and `host.acquire`: `lookup(key)` if declared, else the
  identical `params` again if `dedupe` is exact and inside its window. A
  `none` counts only once mu's writer and the plugin process it called are
  proven gone, and either the lookup was fenced (`fenceKey`) or
  `inFlightMs` has passed; a `handle: "file"` kind never acts on it;
- a delivery: `channel.receipt` if `receipt: "exact"` (only `accepted`
  resolves), else a deduped resend, only while no newer delivery to the
  agent was written.

A repeat within the dedupe window must return the first result and make no
second effect.

Every reply is checked against its request: a `reply` kind's `job.start`
result and `job.lookup` `found` carry the handle and the view; a
`channel.receipt` echoes the asked `msgId`; a `channel.readStates` answer
holds the asked agent's reading (others are ignored). A reply that fails is
an unknown outcome or an unknown answer, never a success. Every call that
names a recorded job, host or effect (a stop, a resend, `job.status`,
`job.attach`, a lookup, a receipt, a readStates) goes only to the instance
it was recorded under; under another, mu sends nothing.

### Host facts in mu's reads

A provider host's `deadlineAt` and `idleReclaimMs` are facts; mu runs no
daemon. Inside `MU_HOST_DEADLINE_MARGIN_MS` (default 10 minutes) of
`deadlineAt`, spawns on the host refuse (`HostDeadlineError`) and it drains;
`mu wait` caps its sleep at the earliest margin of the agents it watches
and fires an urgent `deadline` event (exit 7) naming the agent; `mu state`
lists the agent's collect and close as notices. On a host with either fact,
a `mu wait` that fires an agent's settle, or its `deadline`, then runs one
in-life collect over `link.fetch` (into the spawning checkout's repo),
backing off on failure; it never clears the final collect, which `agent
close` runs after `job.stop`. A job owing its final collect once stopped,
or whose agent is gone, is a `mu state` notice too.

## Errors

| `data.kind` | Means | mu does |
| --- | --- | --- |
| `retryable` | nothing happened | retries with the same params, at most three times; else exit 5 |
| `permanent` | nothing happened, and a retry will not help | exit 5 |
| `human` | a person must act (`data.remedy`) | a host hand-back, exit 5; never retried |
| `unknown-outcome` | it may have happened | an effect's outcome is unknown (exit 1); a `link.exec` returns no exit code |

## Timeouts and cancel

- `link.exec` and `link.fetch` take the caller's `timeoutMs` (20 s by
  default). The plugin enforces it and answers with `exitCode: null`.
  mu's own deadline (the call's `deadline`) is `timeoutMs` plus one grace
  (5 s), so an answer at `timeoutMs` arrives in time.
- Reads (the handshake, `link.checkSteps`) take 10 s.
- Past the deadline, or when the verb cancels the call (its abort signal),
  mu sends `{"jsonrpc":"2.0","method":"$/cancel","params":{"id":<id>}}`,
  then stops the plugin as above: the deadline plus one grace bounds every
  call. A reply that arrives meanwhile is ignored, and does not cut the
  grace short.
- A call whose cancel came before it was written is never sent: it fails
  as a definite refusal (exit 5), not an unknown outcome, and the plugin
  is not stopped. The call has no answer: a read is unknown, an effect
  is an unknown outcome. The next call starts the plugin again; a plugin
  that sent an invalid message stays refused for the invocation.

## Secrets

mu stores only typed reply fields and first-line error text. The contract
suite runs a plugin with `MU_PLUGIN_CANARY=<random>` in its environment,
and fails it if the canary appears in any reply, message or stderr line.
