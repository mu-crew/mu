<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# Ladder placement: where an agent's loop, workspace, shell and DB live

Status: draft 1, written 2026-11-20, awaiting two refutation rounds, then
the human's approval of Part 1. Part 1 is **normative**: the core contract
the D15 path builds on (`job_plugin_builtin_channels`, `plugin_mule_link`,
`plugin_mule_lease`, `host_exec`, `plugin_ssh_pane`). Part 2 is
**informative**: the capability matrix, guidance, the rung-2 stub, and what
is deferred.

Builds on the [plugins spec](2026-11-09-mu-plugins.md) (D1, D7, D8, D15),
the [lease transport spec](2026-10-28-lease-transport.md), mule's `SPEC.md`
(cited at mule `main`, with the strict-codes and size-cap sections), the
[remote guide](../guide/remote.md) and [backends guide](../guide/backends.md).
Decisions marked *decided* come from the human brainstorm of 2026-11-20
(Qn is the question's number there).
Every rule cites the code or spec line it builds on, or says **new**.

## Part 1: core contract (normative)

### §1. The four places

| Place | What it holds |
| --- | --- |
| **loop** | the harness process: model calls, credentials, skills, extensions, `mu_delegate`, its control socket |
| **workspace** | the worktree: files, git, build outputs |
| **shell** | where bash, git and make run |
| **DB** | the `mu.db` that holds the agent's row, its tasks, its worktree's owner record and recovery |

1. **Local** means the DB's machine. Rungs are relative to it: an
   orchestrator that ssh's into a machine and runs mu against that
   machine's DB makes that machine local (*decided*, Q3).
2. Placement is per agent. One orchestrator may mix placements in one
   workstream, under one managed mux backend (§8.2).
3. Rungs label combinations, not an order (Part 2 §A): **0** local
   worker; **1** an orchestrator's command on a host (`mu host exec`);
   **2** loop local, workspace and shell remote (planned, §C); **3** remote
   worker in a session pane; **4** remote worker on a lease; **5** worker
   on a provider host.
4. On rungs 0 and 3-5, loop, workspace and shell share the job's machine.
   Rung 1 runs no agent. Only rung 2 separates loop from workspace.
5. The DB is authoritative for placement: `agents.host`, `host_transport`
   and `cwd`, `carrier_jobs`, `hosts`. A mux-side mirror (tmux pane
   options) is derived and never read back as truth. v1 writes no herdr or
   Rex metadata (*decided*, Q16). Rendering belongs to the visibility spec.

### §2. Ownership: R1-R5 against today's storage

- **R1. One DB per orchestration.** `agents`, `worktrees`, `carrier_jobs`,
  `remote_recovery` and `host_channels` are machine-local and never sync;
  sync moves workstreams, tasks, edges and notes (`docs/guide/sync.md:77-82`).
  `MU_SYNC_DIR` connects orchestrators' DBs, never workers: a remote
  worker's env never carries `MU_DB_PATH`, `MU_STATE_DIR` or `MU_SYNC_DIR`
  (`src/remote-agent.ts:36-49`).
- **R2. Every worktree has one owner record, in one DB.** A local tree is a
  `worktrees` row keyed by path (`src/db-schema.ts:970-983`). A remote tree
  is its agent row (host and `cwd`), then a `remote_recovery` record keyed by
  agent id once the row goes (`src/db-recovery.ts:67-91`); a job record
  names a leftover's tree (plugins D1, Job). Within one DB the remote path
  derives from (workstream, name) (`src/remote-worktree.ts:76-78`), and
  spawn refuses while a recovery record names it
  (`src/agents/spawn-remote.ts:127,148`). Across DBs: §9.
- **R3. Workspace commands run where the workspace is.** Builds, tests and
  git inside the tree run in the job on its host, or through
  `mu host exec` (§6). Two things are excluded: collect's fetch, which runs
  in the orchestrator's checkout and pulls (`docs/guide/remote.md:194-200`;
  mule `SPEC.md:557`), and loop operations (R4). *Narrowed* from the draft
  rule, which covered every command.
- **R4. Loop resources stay with the loop.** Skills, extension docs,
  credentials, mu verbs and `mu_delegate` never travel through bash or
  remote tools. On rungs 0 and 3-5 that holds by construction (§1.4). On
  rung 2 it becomes a tool-routing contract (Part 2 §C). **New** as a rule;
  the D15 units add no remote tool.
- **R5. A remote worker never writes the orchestration DB.** It reports by
  a `CLOSE:` block (`src/close-block.ts:5-52`, `src/task-brief.ts:82`),
  which the orchestrator applies at collect; `MU_REMOTE=1` tells the remote
  extension there is no mu DB there (`src/hosts.ts:474-481`). Where the
  shell runs is not a capability: a mu run on the host opens that host's
  own default DB (`src/db.ts:155-158`), never this one. No in-worker mu
  tool is added (*decided*, Q4). Known gap: a remote pi still registers
  `mu_delegate` (`extension/delegate.ts:1080`), which acts on the host's
  state, outside this orchestration.

### §3. Orchestrator placement and mixed crews

1. An orchestrator's mu verbs run on the DB's machine (R1). Its delegates
   are child processes of its loop and run beside it
   (`src/delegate-process.ts:1-9`). A rung-2 orchestrator is refused (§8.3).
2. **Integration point:** the orchestrator's checkout. A local worker's
   commits are merged from its worktree. A remote worker's are collected,
   pinned at `refs/mu/collect/<ws>/<agent>`, then merged
   (`docs/guide/remote.md:194-200`). mu never merges (`:192`).
3. **Base commit on a static plugin-link host** (*decided*, Q5; **new**).
   A `--worktree` spawn resolves `from` (default `HEAD`) in the caller's
   checkout to a sha, as a provider host does (plugins D7 G3;
   `src/agents/spawn-plugin.ts:121-197`). The host's repo must already hold
   that commit. The prepare exec checks it before `git worktree add`
   (`src/remote-worktree.ts:209-210`). If the commit is absent, spawn
   refuses with `RemoteBaseMissingError` (exit 5,
   `src/remote-worktree.ts:44-58`). The error names the sha, host and repo,
   and the fix: publish the commit where the host's repo fetches from, then
   `mu host exec <h> -- git -C <repo> fetch`. Nothing is made on the host,
   and the local placeholder row and reservation roll back. mu neither
   fetches nor pushes for a static host (§F). Template profiles keep
   today's rule (plugins D7, `:733`).
4. **Cross-rung review works both ways with no new mechanism.** A local
   author's commit reaches a remote reviewer by §3.3. A remote author's
   reaches a local reviewer by collect, then `--from
   refs/mu/collect/<ws>/<author>`.

### §4. Per-host admission

1. mu counts a host's connection slots only for a link with
   `slots: "mu"`. Each call holds one `host_channels` row under
   `max_sessions` (`src/hosts.ts:47-56`, `withHostChannel` at `:965`).
2. A link with `slots: "self"` admits itself, and mu keeps no counter for
   it (`src/plugins/link.ts:106`). No caller admits a self link twice
   (*decided*, Q12).
3. The mule link is `slots: "self"` (plugins D15). Every ssh call to a
   mule host goes through mule's per-host ticket lock on mule's private
   connection (mule `SPEC.md:39,55-57`): mu's host exec, stop and check,
   `hooks` remote reads (`src/channels/hooks-remote.ts:13-16`), each
   carrier's own probes, and later rung-2 ops. **Everything on one capped
   connection serialises:** N concurrent calls take about N times one (§E).
4. A lease pane holds no host channel (`docs/guide/remote.md:346-348`).
   Collect's fetch is a template on another connection, never mule's (mule
   `SPEC.md:49`; plugins D15 `fetch: false`).
5. Job slots on a provider host stay `max_jobs`, checked atomically at
   spawn (plugins D1, `:139-141`; D6).
6. **Host tmux is a named stance limit** (*decided*, Q15). mule needs
   tmux on the job host for every job, exec included (mule `SPEC.md:43-45`).
   On a mule-link host, `host check` reports a missing tmux as a failed
   step (**new**). The only tmux-free path is serve's bounded ops for
   rung 2 (mule's invariant-3 amendment, accepted, not yet in `SPEC.md`).

### §5. What a dropped master means

A dropped master is not host loss (*decided*, Q13; amends plugins D1 and
D8, **new**).

1. A hand-back is a request for a human (mule `SPEC.md:281-295`; lease
   spec, *Hand-back*). Three things count as one: mule's no-master exit 3,
   a template's exit 3 (`src/hosts.ts:1024`), and a plugin's `human` error
   (`src/plugins/link.ts:149-155`). None of them is evidence that a host,
   job or tree is gone.
2. On a hand-back alone, mu must not move a provider host to `lost`,
   record a job stopped or lost, record a tree gone or an owed collect
   lost, drop a handle, or reap a row. Only the provider's `gone` (plugins
   D1, `:134`) or a human's `--abandon`/`--abandon-job` (`:137,168`) do.
3. **Lease agents pause.** The carrier keeps holding while the master is
   gone (mule `SPEC.md:96`), so its view stays present and reconcile keeps
   the row (`src/reconcile.ts:130-133`). Sends fail as unreachable and are
   not resent. A close or stop that hands back exits `human needed` (exit
   5, `src/cli/handle.ts:745-748`) and keeps the agent and its handle
   (`docs/guide/remote.md:374-378`). The job runs on; when the master
   returns, the carrier's drift check re-forwards (mule `SPEC.md:96-97`).
4. A static host has no `lost` state (plugins D1, Host). On a provider
   host, D1's one status ask after a failed call still runs. Only the
   provider's answer moves the host.
5. The rest of the D1/D8 amendment waits for rung 2 (§C).

### §6. `mu host exec` (rung 1)

`mu host exec <host> [--cwd <dir>] [--timeout <s>] [--json] -- <cmd>…`
(*decided*, Q6, Q7)

1. **A link call, never a gate job.** It calls `HostLink.exec`
   (`src/host-link.ts`) and creates no agent row, task, pane or job record
   (*decided*). It is meant for workspace commands (R3), not for
   bulk transfer (mule `SPEC.md:49`) and not for mu verbs (R4). In v1 it is
   the only gate on a capped host. Durable named gates (`plugin_mule_gate`)
   are deferred.
2. **Synchronous.** It returns when the link's exec returns. Admission
   follows §4: one host channel for `slots: "mu"`, none for `slots: "self"`.
3. **Size.** A command that the link's `fits` rejects is refused before
   admission, exit 2. The limits: the template's `EXEC_ARG_MAX_BYTES`
   (`src/host-link.ts:40`), a plugin's `maxScriptBytes`, and mule's 112 KiB
   dispatch cap, which mule enforces before any ssh (mule `SPEC.md:625-629`).
4. **Bounded output.** mu keeps at most 1 MiB of stdout and stderr
   together. Plugin replies are already bounded (`src/plugins/protocol.ts:32`);
   the template capture is not, so its bound is **new**. Output that is
   cut, or that the link marks `partial` (mule exit 7, `SPEC.md:338`), is
   reported as partial and never parsed.
5. **Timeout.** `--timeout` defaults to 600 s. On timeout, mu kills the
   local group after `HOST_GRACE_MS` (`src/hosts.ts:986`). It reports the
   remote outcome by the link's `remoteOnTimeout`: `unknown` means the
   command may still run (`src/host-link.ts:72-73`).
6. **Hand-back.** `HostHandbackError` maps to `human needed` (exit 5) and
   is never retried (`src/cli/handle.ts:745-748`). The mule link runs
   `mule exec --strict-codes`, under which 3 is only mule's hand-back (mule
   `SPEC.md:283`). mu never interprets mule's 8 or its stderr note: they
   pass through as the command's result, so a command's own 3 surfaces as
   8 (*decided*). A template link keeps its contract, exit 3 = hand-back
   (`src/hosts.ts:1024`), so a template that runs mule passes
   `--strict-codes`.
7. **Exit and output.** Plain mode prints stdout and stderr as received
   and exits with the command's code. mu's own outcomes (hand-back,
   timeout, partial output, an admission refusal, an unknown host) use
   mu's exit lanes, with a labelled stderr line, so a command's own 2, 4
   or 5 looks like mu's. `--json` separates them: a command that ran puts
   `{exit, partial, timedOut, remote, stdout, stderr}` in the envelope's
   `data`; mu's own failure is `ok: false` (VOCABULARY, *envelope*).
8. **Record.** Each call writes one log entry of kind `host` (**new**). It
   holds the host, the command's first line cut to 200 characters, the
   exit or outcome, and the duration, never the output. It is an op and
   travels with sync (`src/logs.ts:349-370`), so keep secrets off the
   command line. Host exec opens no pane, so it runs under every mux
   backend, herdr included.

### §7. Templates and migration

1. **Templates stay as a documented escape hatch.** The template link
   (`src/host-link.ts:174-190`) and session and lease profiles keep today's
   behaviour (plugins Principle 6). New placement features target plugin
   links only.
2. **Drain, collect and close before switching** (*decided*, Q8; amends
   plugins D15's "a reservation made before the plugin was used is stopped
   by the plugin's `rm`", `:1399-1400`). A profile is never converted live.
   To move host `h` to a plugin: collect and close every agent, recovery
   record and leftover on `h`, then `mu host rm h` and
   `mu host add h --plugin <p>`.
3. `mu host add <h> --plugin` refuses while any agent row, `carrier_jobs`
   row or `remote_recovery` record names `<h>`, listing them (**new**). It
   mirrors `host release`'s proof (plugins D1, `:135`); why: §F.

### §8. Refusals

Every refusal is typed and happens before any remote effect. Its message
names the fix.

1. **herdr on worker paths of rungs 2-5** (*decided*, Q14). herdr cannot
   run a per-agent command or view (`runsShellCommand: false`,
   `src/mux/herdr.ts:1217`). Spawn, reattach and plugin spawn already
   refuse with `HostSpawnUnsupportedError`, exit 2 (`spawn-remote.ts:129`,
   `spawn-plugin.ts:100`, `reattach-view.ts:92` in `src/agents/`). The
   message names the unsupported part and says "use tmux or Rex". Rung 0
   and host exec are allowed on herdr.
2. **Mixed managed backends in one workstream** (*decided*, Q2; **new**).
   A spawn refuses when the workstream has a live row whose pane id the
   active backend rejects (`isValidPaneId`, `src/mux/types.ts:319`;
   mid-spawn placeholder ids excepted), naming the backend those rows
   use (why: §F). A Rex terminal may still drive a tmux workstream
   (`MU_MUX=tmux`). Lifting the rule is roadmap.
3. **A rung-2 orchestrator** (*decided*, Q3; **new**). The rung-2 path
   refuses a session or spawn that is an orchestrator (`MU_ORCHESTRATOR`,
   which never reaches a remote job, `src/remote-agent.ts:44-46`): its mu
   verbs must run on the DB's machine, and rung 2 runs its bash remotely.
4. Elsewhere: a missing base commit (§3.3), an oversized host exec
   (§6.3), a link switch with live records (§7.3), another DB's tree (§9).

### §9. Cross-DB: refusal and no reclaim

*Decided*, Q9; **new**. Two DBs joined by sync can derive the same
remote path on one host, and today's reclaim checks only this DB (§F).

1. Prepare writes the creating DB's machine identity
   (`machine_identity.machine_id`, `src/db-schema.ts:507-509`) into the
   marker.
2. A reclaim requires the marker to name this DB. A marker that names
   another DB, or an empty one from an older mu, refuses (exit 4, the
   existing `already exists` lane, `src/remote-worktree.ts:100`). The
   refusal names the path, says which DB owns it, and gives the fix: close
   it from that DB, or remove it by hand.
3. No atomic claim protocol: a plain create already refuses an existing
   path (`[ ! -e "$wt" ]`, `git worktree add`; `:211-215`).

## Part 2: informative

### §A. Capability matrix

The matrix has four axes:

- **loop:** can the host run the loop (credentials, an outbound model API,
  the harness installed)?
- **capped:** does the host allow only one session per connection?
  `MaxSessions` counts per connection (mule `SPEC.md:39`).
- **provisioning:** static profile or provider host.
- **harness:** pi uses `ctl`; claude, codex, cursor-agent and muse use
  `hooks` on tmux.

Cells name only combinations that exist: **shipped** today, or delivered
by a named D15 unit (seams: `src/host-provider.ts:120-182`,
`src/jobs/types.ts:116-134`).

| Rung | Provider · link · job · channel | Loop on host | Capped OK | tmux | Rex | herdr | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | none · none · `pane` · `ctl`/`hooks`/`mux` | n/a | n/a | yes | yes | yes | shipped |
| 1 | static · `template` or plugin · none · none | not needed | yes, over mule (link or `exec` template) | yes | yes | yes | `host_exec` |
| 3 | static · `template` (session) · `pane` · `ctl` fwd / `hooks` remote | needed | no: the pane holds a session | yes | yes | refused | shipped |
| 3 | static · ssh plugin · `pane` · built-in `ctl`/`hooks` | needed | no | yes | yes | refused | `plugin_ssh_pane`, `job_plugin_builtin_channels` |
| 4 | static · `template` (lease) · `lease` · `ctl` fwd / `hooks` remote | needed | yes | yes | yes | refused | shipped |
| 4 | static · mule plugin · `lease` · built-in `ctl` | needed | yes | yes | yes | refused | `plugin_mule_link`, `plugin_mule_lease`, `job_plugin_builtin_channels` |
| 5 | provider plugin · plugin · plugin kind · the plugin's own channel | needed | provider's | yes | yes | refused | shipped (`src/agents/spawn-plugin.ts:86`) |
| 5 | provider plugin · plugin · plugin kind · built-in `ctl`/`hooks` | needed | provider's | yes | yes | refused | `job_plugin_builtin_channels` |
| gate | static · `template` (session) · `gate` · none | needed | no | yes | yes | refused | shipped; lease profiles run no gates (`docs/guide/remote.md:370`) |

`hooks` is tmux-only. On Rex, a non-pi worker is on `mux`
(`src/agents/spawn.ts:1259-1272`). The Rex columns for rungs 3 and 4 are
source-reviewed, not smoked (template level). Rung 2 is absent because it
is not implemented (§C).

### §B. When to reach for what

| Situation | Reach for |
| --- | --- |
| One build or test on a host, no agent | rung 1, `mu host exec` |
| The host can run the loop and is uncapped | rung 3 |
| The host is capped (`MaxSessions 1`) | rung 4 on mule |
| A crew on one capped host | rung 4, not rung 2: only polls cross the connection |
| The host cannot run the loop (no credentials or model API) | rung 2, once it ships |
| You need a machine on demand | rung 5, a provider host |
| herdr is your multiplexer and you need a remote worker | `MU_MUX=tmux` or Rex for that workstream |

Provider host or standing host? Weigh these:

- **capacity:** on demand, or fixed.
- **lifetime:** a deadline and idle reclaim, or none.
- **credentials and identity:** whose, and set up by whom.
- **installed harness.**
- **warm caches and build state.**
- **setup cost per job.**

Do not assume a provisioned host has mu or a git identity. R5 reporting
needs neither, but commits need an identity that the provider sets up.

### §C. Rung 2 (stub)

**Outcome: GO on mule serve** (human, 2026-11-20). The invariant-3
amendment was accepted with it. It adds a third ssh use class: bounded
synchronous ops (a remote timeout of at most 1 s, plus a hard local kill),
each in one locked round trip without tmux, sent from a per-caller stdio
child with no daemon. Longer work stays on `mule run` or `mule exec`.

**Thresholds.** p50 is the acceptance metric. Observed p95 jitter is
accepted.

| Measure | Threshold |
| --- | --- |
| single op | ≤ 0.5 s |
| chain step | ≤ 0.5 s |
| 20-way burst | ≤ 3 s |
| 200 KB write | ≤ 3 s |
| cancel | leaves nothing behind |

The prototype met all five at p50 (§E).

**First-release scope:** static hosts on the mule link only, pi only, and
no rung-2 orchestrator (§8.3). No provider-backed rung 2. Rex waits for
`rex_ladder_env` to prove that launch inputs survive `$SHELL -ic`
(`docs/guide/backends.md:69-73`). herdr is refused (§8.1).

**The rung-2 spec must settle:**

- **R4 routing.** List every built-in (`read`, `write`, `edit`, `bash`,
  `grep`, `find`, `ls`, `user_bash`). Each tool that touches the workspace
  is either remote or hidden. None stays local by accident: codemode's
  `grep` and `find` stay local unless overridden. `mu`, `mu_delegate`,
  skills and credentials stay with the loop.
- **Context:** path routing, and the remote `AGENTS.md`.
- **Delegates** of a rung-2 agent.
- **Master drop mid-turn,** and the rest of the D1/D8 amendment (§5.5).
- **serve production gaps:** the unit `serve_production`.

### §D. Out of scope, deferred

These move to the visibility spec (a follow-up workstream):

- TUI placement columns, a Hosts tab, attention and legend;
- murmur dedup, dash and picker routes;
- unified host notices;
- the tmux pane-option mirror (§1.5).

Also deferred: the host init wizard, satellite docs, herdr and Rex parity
smokes, and lifting the one-backend rule (§8.2). The same goes for push
for static links (§3.3), durable named gates (`plugin_mule_gate`), an
atomic cross-DB claim (§9.3), claude and codex on rung 2 (MCP), and
provider-backed rung 2. The mule batch verb is cut. mule's fast path and
daemon stay triage. Refusing `mu_delegate` in a remote pi is a candidate
(§2, R5).

### §E. Evidence (scrubbed aggregates)

Two remote hosts over a WAN-class link, with rounded figures. There are no
loopback numbers.

- **mule exec today:** about 4 round trips per op, 1.3-2 s. A plain ssh
  over a master takes about 0.4-0.5 s.
- **Parallel calls** serialise on the ticket lock: 5 parallel reads take
  about 5 times one read.
- **Extension-side coalescing** over exec recovers 9-20x on bursts. It does
  nothing for single calls or chains (about 1.5 s per step).
- **Payloads:** one op over about 45 KB of argv failed before mule's
  dispatch cap existed. Writes need stdin or a file.
- **The serve prototype** (p50): single op 0.3-0.4 s, chain step
  0.3-0.4 s, 20-way burst 0.4-0.6 s in one round trip, 200 KB write over
  stdin 0.5-1.1 s, and 0 of 20 cancels left anything behind. p95 for single
  ops and chain steps ran 0.65-1.0 s.
- **Not yet measured:** the loopback `MaxSessions 1` floor and the sshd
  suites, which the agent sandbox blocks. `smoke_mule` must cover host exec
  and the lease over the real mule link before release.

### §F. Why, for some Part 1 rules

- **§3.3, no fetch or push for static hosts.** A fetch on the host's
  behalf needs the host's own credentials and may prompt. Push for static
  links is roadmap. Template profiles resolve `from` in the remote repo
  (`src/remote-worktree.ts:209`), and changing that would break existing
  profiles.
- **§7.3, no link switch with live records.** A lease job's stop is fenced
  on the `host_stop` bytes it was made with (`src/carrier-stop.ts:88,97`),
  and a recovery close needs the recorded profile
  (`docs/guide/remote.md:221-225`). A new link could stop neither.
- **§8.2, one managed backend.** Reconcile lists only the active
  backend's session and prunes every other row as a ghost
  (`src/reconcile.ts:113-147`; VISION §5).
- **§9, cross-DB.** Synced DBs share workstream names, so they derive one
  remote path per (workstream, name) on a host
  (`src/remote-worktree.ts:76-78`). Today prepare may reclaim an unused
  leftover there, checked only by the empty `mu-prepared` marker
  (`src/remote-worktree.ts:98-110,217`) and this DB's recovery records
  (`src/agents/spawn-remote.ts:147-171`).
- **§5.5, the rest of D1/D8.** Process host versus workspace host, and
  whether rung 2 reuses `outlivesHost` (plugins `:807`, D1 `:134`).

### §G. ROADMAP draft (pasted only on approval)

> **Approved: ladder placement core (D15 path).** The core contract is
> Part 1 of the ladder placement spec (`specs/2026-11-20-ladder-placement.md`):
> four places, ownership, per-host admission, `mu host exec`, a dropped
> master is not host loss, the refusals, drain-before-switch migration,
> and cross-DB no-reclaim. It gates `job_plugin_builtin_channels`,
> `plugin_mule_link`, `plugin_mule_lease`, `host_exec` and
> `plugin_ssh_pane`. Rung 2 is a separate track (GO on mule serve).

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
