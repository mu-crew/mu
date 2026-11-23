<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# Ladder placement: where an agent's loop, workspace, shell and DB live

Status: approved 2026-11-20 (Part 1 + Open items 1-6). Draft 1 was
refuted (round 1, 13 findings; disposition in §H); round 2's five D15
lifecycle findings went into the D15 unit briefs as acceptance criteria.
The human approved Part 1 and decided each Open item as recommended
(recorded in place below). Part 1 is **normative**: the core contract the
D15 path builds on (`job_plugin_builtin_channels`, `plugin_mule_link`,
`plugin_mule_lease`, `host_exec`, `plugin_ssh_pane`). Part 2 is
**informative** and not approved. §I binds each owning unit to its tests
as an execution gate, not as a human approval. The serve scope decision
stays recorded as its own human decision.

Builds on the [plugins spec](2026-11-09-mu-plugins.md) (D1, D3, D4, D7, D8,
D15), the [lease transport spec](2026-10-28-lease-transport.md), mule's
`SPEC.md` (at mule `main`), the [remote guide](../guide/remote.md) and the
[backends guide](../guide/backends.md). Provenance labels: *decided* (Qn)
is the human brainstorm of 2026-11-20; *brief* is this spec's approved
scope and its hybrid-crew addendum (scope, not wording); **new** is a rule
proposed here; *proposed mechanism* is an implementation choice no Qn
decided (Open item 6). Every rule cites code or a spec line.

## Part 1: core contract (normative)

§I binds each rule's owner unit to its tests; §F holds today's code.

### Open for approval (decided 2026-11-20)

Part 1 states the recommended option and tags the rule with the item.
The human chose the recommended option for every item; each decision is
recorded after the item.

1. **Q5's reading** (§3.3). "Fetchable" = already in the host's repo; mu
   neither fetches nor pushes. "Before any effect" = before any mu tree,
   `job.start`, pane or kept reservation; the check's own transport
   artifacts (over mule, an exec job removed in the same round trip,
   mule `SPEC.md:347-353`) don't count.
   **Decided:** as stated. The base commit must already be in the host's
   repo, refused before any effect; no automatic fetch or push. The
   missing-base refusal names the fix (see §3.3), since an orchestrator
   acts on it and will push when mu says something is missing:
   guardrails with actionable messages.
2. **`mu host exec`'s surface** (§6): flags, the 600 s default, the 1 MiB
   bound, the outcome table and metadata-only log fields are proposed (Q6
   set behaviour). Logging command text needs its own decision.
   **Decided:** the surface as proposed; the log keeps metadata only.
3. **Migration fence** (§7.3). (a) `host add --plugin` refuses while
   records name the host, with a restore path (recommended). (b) `host rm`
   refuses too, which breaks today's rm-then-add edit
   (`docs/guide/remote.md:342-343`).
   **Decided:** (a).
4. **Backend binding** (§8.2). (a) Advisory spawn refusal plus reconcile
   keeping other backends' rows (recommended). (b) A durable per-workstream
   backend: a schema change (parked approval), the only fix for two racing
   first spawns.
   **Decided:** (a).
5. **Status ask after a provider hand-back** (§5.5). (a) None, as collect
   does today (recommended). (b) Ask once, and let `gone` win.
   **Decided:** (a).
6. **Proposed mechanisms, not Qn decisions:** the §7.3 guard, the §8.2
   shape check, the §8.3 `MU_ORCHESTRATOR` check, the §9 marker, `mkdir`
   claim and exit 4, and R4 as a rung-2 rule.
   **Decided:** all approved.

### §1. The four places (*decided*, Q1)

**loop**: the harness process (model calls, credentials, skills,
extensions, `mu_delegate`, its control socket). **workspace**: the
worktree. **shell**: where bash, git and make run. **DB**: the `mu.db` with
the agent's row, tasks, worktree owner and recovery.

1. **Local** means the DB's machine (Q3). Placement is per agent: one
   orchestrator mixes placements in one workstream under one managed
   backend (§8.2) (*brief*).
2. Rungs name combinations, not an order (§A) (*brief*): **0** a local
   worker, **1** `mu host exec`, **2** a local loop with a remote workspace
   and shell (§C), **3** a session pane, **4** a lease, **5** a provider
   host. On rungs 0 and 3-5, all three share the job's machine.
3. **The DB holds placement** (Q16): `agents.host`, `cwd`,
   `host_transport` (null for plugin agents, `src/agents/spawn-plugin.ts:410`),
   `carrier_jobs`, `host_profiles`, `hosts`. The shipped mirror, tmux's
   `@mu_host` (`src/mux/types.ts:137-147`), is presentation that no mu
   decision reads; widening it is follow-up. No herdr or Rex metadata.

### §2. Ownership (R1-R3 *brief*; R4 **new**; R5 *decided*, Q4)

- **R1.** One DB per orchestration. Sync moves only `checks`, `tasks`,
  `task_edges`, `task_notes` and `workstreams`
  (`src/db-schema.ts:253-259`), between orchestrators and never workers.
- **R2.** A mu-managed worktree has one owner in one DB: its agent row,
  then its `remote_recovery` record (`src/db-recovery.ts:67-91`); a job
  record's tree and the prepare marker are bookkeeping (D1, Job); unmanaged
  checkouts have none (`docs/guide/remote.md:75-89`). Across DBs: §9.
- **R3.** Workspace commands run in the job or through host exec, except
  collect's fetch (in the orchestrator's checkout) and loop operations.
- **R4.** Rung-2 track only, not a shell ban: the extension routes `mu`,
  `mu_delegate`, skills and credentials to the loop's machine (§C). On
  rungs 0 and 3-5 a mu verb run from bash reaches the job machine's mu.
- **R5.** A remote worker reports only by its `CLOSE:` block
  (`src/close-block.ts:5-52`): for pi on `ctl`, applied at the
  orchestrator's wait on a settled run (`src/wait.ts:503`,
  `src/wait-db.ts:88-115`); for a remote hook harness, at collect
  (`src/remote-collect.ts:303-305,326-355`). This is routing, not
  isolation: only `HOST_ENV_KEYS` reach the worker (`src/hosts.ts:474-489`,
  `src/remote-agent.ts:36-49`); a host's env, a mounted DB or a person
  running mu there is outside it. `MU_REMOTE=1` skips only the close nudge
  (`extension/nudge.ts:329,469`); a remote pi still registers
  `mu_delegate` (`extension/delegate.ts:1080`). No in-worker tool.

### §3. Orchestrator placement and mixed crews (*brief*)

1. An orchestrator's mu verbs run on the DB's machine (Q3). Its delegates
   are panes in its workstream, or child pi processes with no multiplexer
   (`extension/delegate.ts:12-16`).
2. **Integration point:** the orchestrator's checkout. Remote workers are
   collected to `refs/mu/collect/<ws>/<agent>`, then merged
   (`docs/guide/remote.md:194-200`).
3. **Base commit on a static host** (Q5; Open 1). D7's static rule holds
   for template and plugin profiles: `from` (default `HEAD`) resolves to a sha in the caller's checkout before
   any remote call (`resolveStaticBase`, `src/agents/spawn-remote.ts`), and the
   static path never pushes, whatever the link advertises. A `from`
   naming no commit there refuses with exit 2 (`RemoteBaseRefError`, nothing
   run). A host repo without the sha exits a dedicated code mapped to
   `RemoteBaseMissingError` (exit 5), naming rev, host, repo and SHA.
   *Amended after approval:* the caller-side resolution replaces the first
   text's host-side resolution, so a retry names the same sha (`--from <sha>`).
   Open 1 ("the base must already be in the host's repo") holds either way;
   the local-resolution step is new text, shipped (CHANGELOG, Changed) and
   awaiting the human's approval note, as §5 and §7.2 carry theirs. The guard and the remedy are separate: mu never fetches
   or pushes itself, and the caller does the remedy the message names.
   The message gives an actionable fix for both cases. A published commit
   (a remote the host can fetch has it): `mu host exec <h> -- git -C
   <repo> fetch <remote> <rev>`. A local-only commit (only the
   orchestrator checkout has the object, so a host-side fetch cannot get
   it): push it to a remote the host can fetch, then run that fetch on
   the host, or spawn from a published commit. The missing-base
   acceptance test (§I) checks this message. The check precedes `git worktree add`, so the rollbacks
   leave no tree, job, pane, placeholder or reservation. A timeout is not
   a definite refusal.
4. **Cross-rung review.** Local to remote: fetch the commit on the host,
   `--from <sha>`. Remote to local: collect, `--from refs/mu/collect/…`.

### §4. Per-host admission

1. mu holds a `host_channels` row under `max_sessions` only for a
   `slots: "mu"` link on a static profile (`src/hosts.ts:47-56`,
   `src/plugins/link.ts:106`); calls passed a lease share its row
   (`src/host-link.ts:83-87`); a lease pane holds none
   (`docs/guide/remote.md:346-348`). Provider hosts count `max_jobs` (D6).
2. **No caller takes a mu row for a `slots: "self"` link** (Q12). This is
   new for spawn prepare and `host check` (§F). Collect still takes one:
   mule's link has `fetch: false`, so the template fetch runs on another
   connection (`src/plugins/link.ts:168,185-187`).
3. **mule serialises** (Q12). Each locked ssh call takes mule's ticket
   lock on its private connection (mule `SPEC.md:39,55`). `-O check` and
   local-unix forward and cancel skip the lock (`:55-59`). Jobs run
   detached and overlap, so only each session-opening round trip queues.
   N concurrent calls cost about N locked round trips per step (§E).
4. **Host tmux is a named stance limit** (Q15). mule needs tmux on the
   host for every job (mule `SPEC.md:45`). On a mule-link host,
   `host check` reports a missing master as the hand-back step (lock-free
   `-O check`, no unlocked ssh fallback, `:65`; `mule host info` already
   reports `master=false` with its remedy, mule `src/cli.rs:628-680`) and a
   missing tmux as a separate failed step (a mule probe that dispatches no
   job; `host info` does not report tmux). Only serve's rung-2 workspace
   operations skip tmux, not the diagnostic reads.

### §5. A dropped master is not host loss (*decided*, Q13)

Where plugins D1 and D8 differ, this section supersedes them (§G).

1. **A hand-back asks for a human** (mule `SPEC.md:281-295`): mule's
   no-master 3, any template 3 (`src/hosts.ts:1024-1030`), a plugin's
   `human` error (`src/plugins/link.ts:149-155`). It never shows loss.
2. **A hand-back alone records nothing** (no `lost` host, stopped or lost
   job, gone tree, lost collect, dropped handle). Existing proofs still act:
   a stop's proof; a bound row's reap after its pane died, which keeps the
   job record and writes recovery (`src/agents/reap.ts:56-66`); the
   provider's `gone` (D1, Host); `--abandon` or `--abandon-job` (D1, Job).
3. **Passive loss on a lease.** The carrier keeps holding (mule
   `SPEC.md:96`), and reconcile keeps the row (`src/reconcile.ts:132-133`).
   Sends fail as unreachable and are not resent. When the master returns,
   the carrier forwards again (`:97`).
4. **Close during the loss.** Close kills a bound view before its stop
   (`src/agents/close.ts:542-552,580`); the kill makes the carrier spawn
   mule's detached `rm --retry-for` (mule `SPEC.md:99,295`), so the job is
   being stopped. mu's stop hands back: `human needed` (exit 5), row and
   handle kept. The next full reconcile reaps the paneless row; job
   record, recovery record and waiting tasks survive. With the master
   back, `mu agent close <name> -w <ws>` stops by handle and closes the tree.
5. **Status asks** (Open 5). A static host has no `lost` state. Only the
   provider's answer moves a provider host, and mu does not ask the
   provider after a hand-back (Open 5a): a hand-back, dropped master or
   otherwise, is not host loss and triggers no `host.status` ask, whatever
   D1's ask-after-failed-call row says. The rest of D1/D8 (process
   host versus workspace host) waits for rung 2.

### §6. `mu host exec` (rung 1; *decided*, Q6, Q7; surface: Open 2)

`mu host exec <host> [--cwd <dir>] [--timeout <s>] [--json] -- <cmd>…`

1. **A synchronous link call** (`HostLink.exec`), admitted per §4, with no
   row, task, pane or job record; for workspace commands, not bulk
   transfer (mule `SPEC.md:49`); v1's only gate on the shared capped connection (Q7); an SSH template gate keeps its own connection (§A).
2. **Size.** (a) `link.fits` before admission: the template's expanded
   argv (`src/host-link.ts:186-192`) or a plugin's script plus cwd; a
   failure is a typed refusal, exit 2, nothing run. (b) Again in
   `admitted`, on the admitted profile (`src/host-link.ts:104-108`).
   (c) The link's own cap wins: mule measures its exact dispatch against
   112 KiB and exits 1 before any ssh (mule `SPEC.md:627`), a link reply.
3. **Output.** mu keeps 1 MiB of stdout plus stderr and clips the rest
   (`clipped`; the command still ran). A plugin bounds each stream so its
   escaped reply fits the 1 MiB frame (`src/plugins/protocol.ts:31-32`)
   and sets `partial` if it cut; an oversize frame is no answer.
4. **Deadline:** `--timeout`, default 600 s. Template: TERM, then KILL
   after `HOST_GRACE_MS` (`src/hosts.ts:986,1017-1022`). Plugin: deadline
   plus grace, `$/cancel`, group kill (`src/plugins/link.ts:131-146`,
   `src/plugins/reconcile.ts:115-129`); mule runs `exec --no-detach` so
   its stop stays in the group (mule `SPEC.md:361-363`). Both declare
   `remoteOnTimeout: "unknown"`: a timed-out command may still run.
5. **Outcomes,** reported only as far as mu sees them:

| Outcome | Evidence | `--json` | Plain exit |
| --- | --- | --- | --- |
| link reply, exit n | the link's code | `ok: true`, `data: {exit, partial, clipped, stdout, stderr}` | n |
| hand-back | `HostHandbackError` | `ok: false`, human needed | 5 |
| no exit code | timeout or no answer (`src/plugins/link.ts:156-162`) | `ok: false`, `data: {exit: null, remote}` | 5 |
| refused before any call | fits, admission, host, profile | `ok: false` | its lane |

   n is the command's code except where link codes overlap it: ssh's 255,
   mule's 1 and 7 (`SPEC.md:338,352`). A template link reads every 3 as a
   hand-back (`src/hosts.ts:1024`). The mule link passes `--strict-codes`:
   3 is only mule's (`SPEC.md:283`), a command's 3 arrives as 8 in n; mu
   reads neither 8 nor stderr. Only `--json` tells a command's 5 from
   mu's. Nothing is retried (`src/cli/handle.ts:745-748`).
6. **Record** (Q6): one `host` log op with host, link, outcome or exit,
   duration and command byte length; never the command text or output
   (`src/logs.ts:349-375`). No pane, so every backend runs it, herdr too.

### §7. Templates and migration (*decided*, Q8)

1. Templates, session profiles and lease profiles keep today's behaviour
   (`src/host-link.ts:174-190`). New placement features target plugins.
2. **Drain, collect and close before switching;** no live conversion.
   Supersedes D15's "a reservation made before the plugin was used is
   stopped by the plugin's `rm`" (plugins `:1399-1400`). Recipe: keep the
   old `host add` line; collect and close everything on `h`; `mu host rm
   h`; `mu host add h --plugin mule --fetch '<old fetch>' --repo <repo>`
   with the old limits (`src/hosts.ts:369-371`).
3. **Fence** (Open 3a). In its insert transaction, `host add <h> --plugin`
   refuses while an agent row, `carrier_jobs` row or `remote_recovery`
   record names `<h>`, listing them (`host release`'s proof, D1, Host).
   `host rm` keeps refusing only held channels (`src/hosts.ts:380-388`);
   a lease spawn past prepare holds none, but the fence sees its
   reservation. Records left by a `host rm` stay unstoppable until the old
   profile is re-added byte-equal (`src/carrier-stop.ts:80-88`); the
   refusal says so.

### §8. Refusals

Each refusal is typed, happens before any mu effect (§3.3), and names
the fix.

1. **herdr on rungs 2-5** (Q14). herdr runs no per-agent command or view
   (`src/mux/herdr.ts:1217`). **New:** each path checks the backend before
   any remote call and keeps its type: `HostSpawnUnsupportedError` (exit
   2) for template spawn, plugin spawn and detached-view reattach
   (`src/agents/spawn-remote.ts:129`, `spawn-plugin.ts:100`,
   `reattach-view.ts:92`); `ReattachRefusedError` (exit 4) for lease
   reattach (`reattach-check.ts:119`). The message names the part herdr
   cannot run and says "use tmux or Rex". Rung 0 and host exec run.
2. **One managed backend per workstream** (Q2; Open 4a). Pane-id shape is
   not authority (`src/mux/types.ts:318-320`), but tmux, herdr and Rex
   shapes are disjoint (`src/mux/tmux.ts:83`, `herdr.ts:233`, `rex.ts:62`).
   (a) Full reconcile keeps and reports a row whose pane id the active
   backend rejects (`src/reconcile.ts:127-147`). (b) A spawn refuses while
   one exists, naming its backend; advisory, since two first spawns can
   race. Same-backend servers look alike. A Rex terminal may drive a tmux
   workstream (`MU_MUX=tmux`).
3. **A rung-2 orchestrator** (Q3; Open 6). Rung 2 refuses a session
   marked `MU_ORCHESTRATOR`, a variable that never reaches a remote job
   (`src/remote-agent.ts:46`).
4. Others: §3.3, §6.2, §7.3, §9.

### §9. Cross-DB: refusal and no reclaim (*decided*, Q9; Open 6)

1. **A refused create never touches an existing path.** Create claims the
   path with one atomic `mkdir "$wt"` (parent first); a failed `mkdir`
   exits "already exists"; `undo` runs only after this run's own `mkdir`
   (`src/remote-worktree.ts:211-216`; `git worktree add` takes the empty
   directory).
2. **The marker names its DB:** prepare writes `machine_id`
   (`src/db-schema.ts:507-509`) into `mu-prepared`, and only this DB's
   marker is reclaimable. Another DB's id refuses, naming that id; an
   empty or missing marker is an unknown owner and refuses.
3. **Typed refusal:** prepare's exit 4 maps to a typed conflict, exit 4,
   like `RemotePathOwnedError` (`src/remote-recovery.ts:293`), naming
   path, owner and fix (close it from its DB, or remove it by hand).
4. **Mixed versions:** an older mu ignores the marker's contents; the
   guarantee holds once every DB on the host runs this rule. No atomic
   claim protocol.

### §10. The D15 file handle

D15 declares `handle: "file"` and `start.lookup` (today's gap: §F). (1)
mu claims the job file before `job.start`, as the lease template does
(`src/agents/spawn.ts:812`; path from (workstream, name),
`src/agents/lease-carrier.ts:66`); the reservation at `launch = 'intent'`
is the durable record. (2) `JobSpec` carries the path; mule's view writes
the handle there before dispatch. (3) mu reads it from that local file,
no master needed, before spawn returns; lookup by key comes second, and
`none` never acts (plugins `:377`). (4) A static plugin prepare records
its tree (`recordJobTree`).

## Part 2: informative

### §A. Capability matrix

Axes: can the host run the **loop**; is it **capped** (`MaxSessions`
counts sessions per connection, mule `SPEC.md:39`; mu's `--max-sessions`
counts per profile); **provisioning** (static or provider); **harness**.
A cell is **shipped**, or **planned** with the units that deliver it and
its conditions.

| Rung | Provider · link · job | tmux | Rex | herdr | Loop on host | One session per connection | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | none · none · `pane` | pi `ctl`; known hook harnesses `hooks`, other workers `mux`; pi `hooks` is an opt-in (`src/agents/spawn.ts:823-832,1259-1272`) | pi `ctl`, others `mux` | pi `ctl`, others `mux` | n/a | n/a | shipped |
| 1 | static · template or plugin · none | no channel | no channel | no channel | not needed | fine over the mule link | `host_exec` |
| 3 | static · template (session) · `pane` | pi `ctl` forwarded; others remote `hooks` | pi `ctl`; others `mux` | refused | needed | fine: each pane opens its own connection | shipped |
| 3 | static · ssh plugin · `pane` | built-in `ctl`/`hooks`, if conditions hold | built-in `ctl`; others `mux` | refused | needed | as above | `plugin_ssh_pane`, `job_plugin_builtin_channels` |
| 4 | static · template (lease) · `lease` | pi `ctl` via the carrier | pi `ctl` via the carrier | refused | needed | fine (one master) | shipped, pi only |
| 4 | static · mule plugin · `lease` | built-in `ctl`, if conditions hold | same | refused | needed | fine | `plugin_mule_link`, `plugin_mule_lease`, `job_plugin_builtin_channels` |
| 5 | provider plugin · plugin · plugin kind | the plugin's channel | same | refused | needed | provider's | core contract shipped (`src/agents/spawn-plugin.ts:86`); real-backend smoke separate |
| 5 | provider plugin · plugin · plugin kind | built-in `ctl`/`hooks`, if conditions hold | built-in `ctl`; others `mux` | refused | needed | provider's | `job_plugin_builtin_channels` |
| gate | static · template (session) · `gate` | `mux` | `mux` | refused | not needed: it runs a command (`docs/guide/remote.md:100-106`) | as rung 3 | shipped; lease profiles run no gates (`:370-371`) |

- **Conditions for a built-in channel on a plugin job:**
  `job_plugin_builtin_channels` delivers it; the kind honours `sockets`
  (for `ctl`) and the env; the view is interactive where the channel needs stdin (`hooks`, `mux`), not for `ctl` over a noninteractive mule carrier. Today plugin spawn
  gives the view stdin `/dev/null`, sets no hooks and hands no socket pair
  (`src/agents/spawn-plugin.ts:104,238-258,413-414`; plugins D3, D8). On
  rung 5 a built-in channel needs `firstTurn: "on-send"`; an at-start kind
  needs its own channel and a reply baseline (`:86-90,273-275`).
- Remote `hooks` needs a backend that anchors and pastes, and a remote key
  (`src/agents/spawn.ts:817-822,914-923`): tmux only. Elsewhere a non-pi
  worker is on `mux` (`:1259-1272`).
- A lease carrier does not forward stdin (mule `SPEC.md:98`), so a non-pi
  worker on a lease has no input path, on any backend.
- A session pane uses `ControlMaster=no ControlPath=none`
  (`src/hosts.ts:397-405`), so per-connection `MaxSessions 1` does not
  block it. A host where only one connection is practical (a prompted
  master) does. A session pane over a shared master is not supported.
- The Rex cells for rungs 3 and 4 are source-reviewed, not smoked. Rung 2
  is absent: it is not implemented (§C).

### §B. When to reach for what

| Situation | Reach for |
| --- | --- |
| One build or test on a host, no agent | rung 1, `mu host exec` |
| The host runs the loop and takes a new connection per pane | rung 3 |
| Only one connection is practical (a prompted master) | rung 4 on mule; rung 1 for gates |
| A crew on such a host | rung 4: only polls cross the connection |
| The host cannot run the loop (no credentials or model API) | rung 2, once it ships |
| You need a machine on demand | rung 5, a provider host |
| herdr is your multiplexer and you need a remote worker | `MU_MUX=tmux` or Rex for that workstream |

Provider host or standing host: weigh capacity (on demand or fixed),
lifetime (a deadline and idle reclaim, or none), credentials and identity
(whose, set up by whom), the installed harness, warm caches and build
state, and setup cost per job. Do not assume a provisioned host has mu or a
git identity: R5 needs neither, commits need an identity.

### §C. Rung 2 (stub)

**GO on mule serve** (*decided*, Q17), with the invariant-3 amendment: a
third ssh use class of bounded synchronous ops (a remote timeout of at most
1 s plus a hard local kill), each one locked round trip without tmux, from
a per-caller stdio child with no daemon.

**Not in the first D15 release** (course check #4): the first release is
D15 only; serve and its pi extension ship in neither artifact. Serve work
was paused until Part 1's approval (2026-11-20).

**Serve scope** (*decided*, 2026-11-20): fixed read, stat and write ops
only. Arbitrary commands, the agent's `bash` among them, stay on detached
mule jobs; serve runs no bounded exec. The track's units are
`serve_lifetime`, `serve_integrity` and `serve_final_acceptance`, which
runs one combined acceptance on the final sha (Linux, `MaxSessions 1`,
the thresholds below). `serve_production` is closed.

**Thresholds** (Q11). p50 is the acceptance metric for the four timed
rows; observed p95 jitter is accepted. Cancel is a zero-leftovers case, not
a p50 metric.

| Measure | Threshold |
| --- | --- |
| single op | ≤ 0.5 s |
| chain step | ≤ 0.5 s |
| 20-way burst | ≤ 3 s |
| 200 KB write | ≤ 3 s |
| cancel | leaves nothing behind |

The prototype met all five (§E).

**First rung-2 release scope** (*brief*): static hosts on the mule link,
pi only, no rung-2 orchestrator (§8.3), no provider-backed rung 2. Rex
waits for `rex_ladder_env` to prove that launch inputs survive `$SHELL -ic`
(`docs/guide/backends.md:69-73`). herdr is refused.

**The rung-2 spec must settle:** R4 routing for every built-in (`read`,
`write`, `edit`, `bash`, `grep`, `find`, `ls`, `user_bash`): each tool that
touches the workspace is remote or hidden, none local by accident
(codemode's `grep` and `find` stay local unless overridden); `mu`,
`mu_delegate`, skills and credentials stay with the loop. Also: path
routing and the remote `AGENTS.md`; a rung-2 agent's delegates; a master
drop mid-turn and the rest of D1/D8 (§5.5); the rung-2 herdr and
orchestrator refusals (§8.1, §8.3).

### §D. Out of scope, deferred

To the visibility follow-up: TUI placement columns, a Hosts tab, attention
and legend; murmur dedup, dash and picker routes; unified host notices;
widening the pane-option mirror beyond `@mu_host` (§1.3).

Also deferred: the host init wizard, satellite docs, herdr and Rex parity
smokes, a durable backend binding (Open 4), push for static links (§3.3),
durable named gates (`plugin_mule_gate`), an atomic cross-DB claim (§9.4),
claude and codex on rung 2 (MCP), and provider-backed rung 2. The mule
batch verb is cut from this release, not ruled out later. mule's fast path
and daemon stay triage. Refusing `mu_delegate` in a remote pi is a
candidate (R5).

### §E. Evidence (scrubbed aggregates)

Two remote hosts over a WAN-class link, with rounded figures; no loopback
numbers.

- **mule exec today:** about 4 round trips per op, 1.3-2 s. A plain ssh
  over a master takes about 0.4-0.5 s.
- **Parallel calls** serialise on the ticket lock: 5 parallel reads take
  about 5 times one read.
- **Extension-side coalescing** over exec recovers 9-20x on bursts; it does
  nothing for single calls or chains (about 1.5 s per step).
- **Payloads:** one op over about 45 KB of argv failed before mule's
  dispatch cap existed. Writes need stdin or a file.
- **The serve prototype** (p50): single op 0.3-0.4 s, chain step
  0.3-0.4 s, 20-way burst 0.4-0.6 s in one round trip, 200 KB write over
  stdin 0.5-1.1 s, 0 of 20 cancels left anything. p95 for single ops and
  chain steps ran 0.65-1.0 s.
- **Not yet measured:** the loopback `MaxSessions 1` floor and the sshd
  suites, which the agent sandbox blocks. `smoke_mule` must cover host exec
  and the lease over the real mule link before release.

### §F. Today's code, and why

- **§3.3.** As shipped, `resolveStaticBase` resolves `from` to a sha in
  the caller's checkout (exit 2, `RemoteBaseRefError`, when it names no
  commit), and the host's prepare exits 5 (`RemoteBaseMissingError`) when
  its repo lacks the sha (`src/remote-worktree.ts`). A fetch on the host's
  behalf needs its credentials and may prompt, and push for static links is
  roadmap. The static rollbacks that run on a refusal are at
  `src/agents/spawn-remote.ts:180-186` and
  `src/agents/spawn-plugin.ts:299-307`.
- **§4.2.** Static plugin spawn calls `admitRemoteSpawn`, which always
  admits a mu channel and then passes the lease to the link
  (`src/agents/spawn-plugin.ts:199-210`, `src/agents/spawn-remote.ts:200-244`).
  `checkHost` enters `withHostView`, which admits every static profile
  (`src/hosts.ts:1203`, `src/host-provider.ts:203-219`). The link's own
  skip covers only calls inside the link (`src/plugins/link.ts:106`).
- **§5.** Close kills the view and only then stops the job
  (`src/agents/close.ts:542-552,580`; `docs/guide/remote.md:373-378`).
  Reconcile reaps a bound row whose pane is gone (`src/reconcile.ts:134-147`).
  A hand-back in collect throws before the status ask
  (`src/remote-collect.ts:241-255`). `closePluginJob` asks for status
  before its stop (`src/host-policy.ts:207`).
- **§6.2.** A plugin's `fits` counts only the raw script
  (`src/plugins/link.ts:176-182`). mule's cap covers its wrapper, prune
  prefix and quoting, so mu cannot reproduce it (mule `SPEC.md:627-629`).
- **§6.5.** A number cannot say who produced it, and stderr belongs to
  the command. The template runner throws on any 3 (`src/hosts.ts:1024`).
  A plugin call with no answer becomes `exitCode: null`, the same as a
  timeout (`src/plugins/link.ts:156-162`). mu reports only what it
  observed.
- **§6.6.** `appendLog` writes an op that syncs (`src/logs.ts:349-375`).
  Cutting a command to its first line still keeps a secret placed there.
- **§7.3.** `removeHost` checks only held channels (`src/hosts.ts:380-388`).
  A lease job's stop is fenced on the `stop` bytes it was made with
  (`src/carrier-stop.ts:80-88`). A recovery close needs the recorded
  profile (`docs/guide/remote.md:221-225`). A new link could stop
  neither.
- **§8.1.** The message today names only tmux and the shell template
  (`src/messages.ts:421-422`). Lease reattach checks the backend after its
  other preflight reads (`src/agents/reattach-check.ts:99-119`).
- **§8.2.** Reconcile lists only the active backend's session and prunes
  every other row as a ghost (`src/reconcile.ts:113-147`, reached from
  `mu state`, `src/cli/state.ts:236-238`; VISION §5). Placeholders are
  skipped, so a first spawn has no backend to compare against.
- **§9.** Synced DBs share workstream names, so on a host they derive
  one remote path per (workstream, name) (`src/remote-worktree.ts:76-78`).
  Two prepares can both pass the existence test. The loser's
  `git worktree add` fails and `undo` force-removes and deletes the
  winner's tree (`:211-216`). A reclaim checks only the empty marker and
  this DB's recovery records (`:98-110`,
  `src/agents/spawn-remote.ts:147-171`). Prepare's exit 4 surfaces today as
  `RemotePrepareError`, exit 5 (`src/cli/handle.ts:736-743`).
- **§10.** Plugin spawn allocates no job file, and `JobSpec` has
  `sockets` but no job-file field (plugins D8). On a ready path it waits
  only for the channel. Only a provider prepare calls `recordJobTree`
  (`src/agents/spawn-plugin.ts:185-215`). `closePluginJob` looks the job
  up only when its handle is missing (`src/host-policy.ts:217-240`).

### §G. ROADMAP entry (pasted on approval, 2026-11-20)

The pasted entry adds the approval date, the serve scope (§C) and the
D15-only first release.

> **Approved: ladder placement core (D15 path).** Part 1 of the ladder
> placement spec (`specs/2026-11-20-ladder-placement.md`): four places,
> ownership, per-host admission, `mu host exec`, a dropped master is not
> host loss, the refusals, drain-before-switch migration, cross-DB
> refusal. It gates `job_plugin_builtin_channels`, `plugin_mule_link`,
> `plugin_mule_lease`, `host_exec` and `plugin_ssh_pane`. Rung 2 is a
> separate track (GO on mule serve, paused until this approval).

The approval commit also edits the plugins spec (done): D1 and D8 point at §5,
D15's migration bullet at §7.2, D15's job capabilities at §10's file
handle.

### §H. Refutation round 1: disposition

| Finding | Resolution |
| --- | --- |
| `spec_a_crossdb_create_race` | `mkdir` claim, DB-naming marker, typed exit 4, mixed versions: §9; owner `sync_ownership` behind Spec B: §I; mechanisms: Open 6 |
| `spec_a_mux_owner_guard` | reconcile keeps foreign rows, advisory spawn refusal: §8.2; owner and tests: §I; durable binding: Open 4 |
| `spec_a_static_base_effects` | D7's remote resolution kept, no push, static remedy, rollback: §3.3; tests: §I; "fetchable" and "effect": Open 1 |
| `spec_a_master_drop_close` | passive loss, close during loss, proofs, reap survivors, recovery: §5.2-5.4; tests: §I; status ask: Open 5 |
| `spec_a_exec_result_origin` | outcome table with observed provenance only: §6.5; values: Open 2 |
| `spec_a_exec_limits` | three size boundaries, two cancel paths, frame vs partial: §6.2-6.4 |
| `spec_a_self_admit_callers` | no row for self links from any caller, round trips not commands, tmux step: §4.1-4.4; callers: §F |
| `spec_a_d15_file_handle` | file handle and tree handoff: §10; owners and tests: §I |
| `spec_a_migration_fence` | fence, restore, recipe with `--fetch`: §7.2-7.3; owners: §I; location: Open 3 |
| `spec_a_matrix_routes` | per-backend cells, conditions, gate, connection axes: §A, §B |
| `spec_a_ownership_claims` | R1, R2, R4, R5 and §3.1 rewritten; CLOSE and env tests: §I |
| `spec_a_herdr_refusal` | per-path behaviour, the intended change: §8.1; owner and tests: §I |
| `spec_a_approval_trace` | provenance labels (header), Open list, Q16 (§1.3), supersession (§5, §7.2, §G), §C release scope |

### §I. Owners and required tests

`job_plugin_builtin_channels` remains the sole owner of shared spawn
edits. Work outside the five D15 units does not block them.

| Rule | Owner | Required tests |
| --- | --- | --- |
| R5, env | `job_plugin_builtin_channels` | template and plugin spawns hand over only `HOST_ENV_KEYS`; CLOSE is applied per channel (`ctl` at wait, remote `hooks` at collect) |
| §3.3 | `job_plugin_builtin_channels` | a `from` that names no commit in the caller's checkout (exit 2); a sha the host lacks (exit 5); a link that advertises `push`. Assert no push, tree, `job.start`, pane or kept reservation; the missing-base case also asserts the refusal names host, repo and SHA and both fixes (published: fetch on the host; local-only: push, then fetch, or spawn from a published commit) |
| §4.2 spawn prepare | `job_plugin_builtin_channels` | zero `host_channels` rows across a mule prepare |
| §4.2 host check | `host_exec` | zero rows across mule check and exec; one counted row for a template fetch |
| §4.4 | `plugin_mule_link` (mule's tmux signal, the link's `checkSteps`) | missing master and missing tmux are separate outcomes, with no unlocked ssh |
| §5 | `plugin_mule_lease` | master down, close, reconcile, master back, then a no-row close stops by handle; passive drop, then restore (forward back, send works); nothing recorded lost or gone |
| §6 | `host_exec`; `plugin_mule_link` sets `maxScriptBytes` headroom, stream bounds, `--strict-codes`, `--no-detach` | a long cwd, a quote-heavy script, a profile replaced at admission, a script under mu's limit but over mule's; an ordinary nonzero exit, a command's own 3 and 7, real truncation, a timeout vs no answer, a hand-back with zero retries, a clipped success; a secret sentinel in argv appears in no op |
| §7 | `migrate_profiles` (fence, recipe, doctor detection); `host_cli_wiring` (CLI) | agent-only, job-only and recovery-only records each refuse; rm then add refuses and names the restore; a lease spawn racing the switch |
| §8.1 | `herdr_refusal_message` | type, code and message, and no remote exec, job or pane, on template spawn, plugin spawn, lease reattach (preview and apply) and detached-view reattach |
| §8.2 | `mux_backend_guard` (to add to the DAG) | `mu state` on the wrong backend with a live row (no row, task or pane lost or made); two first spawns on two backends |
| §8.3, R4 | rung-2 track | — |
| §9 | `sync_ownership` (Spec B gate) | two DBs racing one path (the loser exits 4 and the winner's tree stays); a foreign, an empty and a missing marker each refuse |
| §10 | mu half: `job_plugin_builtin_channels`; mule half: `plugin_mule_lease` | a lost `job.start` answer; ctl ready, then immediate master loss; close by the right handle and tree after a restart; no unproven dispatch called absent |

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
