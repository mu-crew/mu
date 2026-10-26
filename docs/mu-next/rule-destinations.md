# Rule inventory: 3.x skill and recipes → mu-next default

Drafted in `v_skill_draft`, shipped in `v_skill_ship`. Source: the 3.x
`skills/mu/SKILL.md` (2,468 words) and 26 recipes (15,519 words). Surface: the
merged `dist/cli.js` at `a4e2eeb`, checked against `--help` and a scratch DB.
Destinations are the shipped `skills/mu/` files; the dropped 3.x recipes are
in git history.

**Dispositions.** **K** keep: the rule survives, at the cited place in
`skills/mu/`. **C** code: a verb, guard or hint now enforces it; the cited
file is the proof, and the prose is gone. **D** drop: the reason follows.
`K*` means kept shorter, with the cut named.

A **C** row is not proof the rule is safe to drop, only that code now does
the work. Slice B and `t_skill` own that evidence. A **D** row that has no
measured failure is a hill-climb candidate: put it back if a scenario flags
its absence (README, Prose budget, rule 7 "Promote back").

## 1. SKILL.md

| # | 3.x rule | | mu-next destination |
|---|---|---|---|
| 1 | Trust `--help` over the skill; absent verbs do not exist | K | SKILL.md top; `-w` only where `--help` lists it (`doctor`, `sync`, `delegates show`, `delegates finish`, `rebuild`, `db forget`, `host add` reject it) |
| 2 | Default output is a card plus `Next:`; read both | K*/C | SKILL.md line 2: the envelope, and `next` is null until **TODO v_hints**; today the hints are `data.nextSteps` (errors: top-level `nextSteps`). `src/output-contract.ts` |
| 3 | `data` shapes per collection (`{items,count}`, `agent list` exception, `sql` `more`, `log --tail` NDJSON) | K* | SKILL.md line 2 keeps one clause: collections are `{items,count}`, `agent list` is `{workstreamName,agents,orphans}`. `--help` states no shape (checked on `task list`, `agent list`, `delegates list`), so this is **not** C: `agent list ... d["items"]` raised `KeyError`, the README's `KeyError: 'id'` class. `sql` `more` and `log --tail` NDJSON dropped. Revisit when `agent list` returns `items` or a shape guard lands |
| 4 | Errors on stdout with `exit`; `nextSteps` survives | K | SKILL.md line 2 (`{ok:false,error,message,next,exit}`) and the `nextSteps` location, until **TODO v_hints** fills `next` |
| 5 | A cut names its way back | K* | SKILL.md ("run it" dropped: the `next=` is executable) |
| 6 | Vocabulary: workstream, agent, mux, ctl, claim, release, note, worktree | D | `mu --help`, VOCABULARY.md; models use the words correctly unprompted |
| 7 | Vocabulary: task statuses and substates, `CLOSED/*` satisfies `--blocked-by` | C | `task close --help`, `task list --substate` choices; `src/tasks/status.ts` |
| 8 | Task has mandatory `impact` and `effort_days` | C | defaults 50/1 and `tasks.scored` (`task add --help`) |
| 9 | Track: tasks joined by `block` edges; spawn one agent per ready task, not per track | D | `mu next`/`task next` list ready tasks, not tracks; track card was retired |
| 10 | `mu task block B --by A` puts B on A's track; one edge direction | K* | SKILL.md word list: "B blocks A" |
| 11 | Recipe word: umbrella (blocked by every unit; holds brief, criteria, stop rule; `--if-ready`) | K | SKILL.md |
| 12 | Recipe word: unit | D | self-evident; used plainly in every recipe |
| 13 | Recipe words: fast/slow gate, gate budget, gate record, test upkeep, review gate | K | test-health.md (defined where used) |
| 14 | Recipe word: wave (units from one main revision; refresh worktrees) | K* | refresh is `orchestrator-loop` step 3; "wave" as delegate label is `delegates tally --wave` |
| 15 | Recipe word: finding = `OPEN/triage` task | K | SKILL.md |
| 16 | Recipe word: verdict + EVIDENCE lines; REFUTED on a brief means rewrite | K | SKILL.md (verdict), tasks-or-calls.md (shape), SKILL.md rule "rewrite on REFUTED" |
| 17 | Recipe word: stop rule, written on the umbrella first | K | SKILL.md rule "Stop rule on the umbrella first" |
| 18 | When to use mu vs stay in one context | D | the description's trigger carries it |
| 19 | Before acting on a claim, cause, plan, fix or brief, a delegate call refutes it, another family | K | SKILL.md description and "Checks are calls" rule; models.md |
| 20 | Inside pi `mu_delegate`; outside pi a `scratch` spawn | K | tasks-or-calls.md (both forms) |
| 21 | `record: {task}` writes the verdict; hand-written `REFUTER` note on the spawn path; none without a task | C+K | extension `record` (`delegates finish`, `src/delegates.ts`: verdict note before report and close); the hand-written form stays in tasks-or-calls.md because outside pi has no `record` (TODO v_delegate_nomux) |
| 22 | `agent wait --first` instead of a sleep loop; exit 0/5/6 | C | `agent wait --help`; the skill rule is "no sleep loops" |
| 23 | Watcher recipe pointer | D | see §2 `watcher` |
| 24 | One agent per independent unit | D | obeyed by default; `task next -n 0` lists the ready set |
| 25 | `--worktree` for any helper that may edit, build or test | K | SKILL.md rule "Edit or build: `--worktree`" |
| 26 | `unknown (ctl missing)` right after spawn is pi's trust prompt; `--approve` | C | the error teaches it at the decision point: `src/agents/errors.ts:393-400` (`--command 'pi --approve'`) |
| 27 | Move off `scratch` when work gains dependencies or gates | D | obeyed; no failure behind it |
| 28 | Two builds in one checkout corrupt each other | K* | `--worktree` rule |
| 29 | Never make your own `git worktree`/copy for a local agent | K | SKILL.md ("Never make your own"): mu cannot list, diff or free what it did not create |
| 30 | Worktrees are git only; exit 4 outside a repo | C | error message |
| 31 | `agent close` previews until `--if <rev>`; dirty worktree refuses; unmerged commits kept on `mu/<ws>/<agent>-<sha>`; `--discard` | C | `agent close --help`; `WorktreeDirtyError` (`src/agents/close.ts:49,244`); preview-then-`--if` is the hint |
| 32 | Before a `--fresh` send, `git fetch && rebase <base>`; on conflict abort and tell the human | K | orchestrator-loop.md step 3 (README: "Refresh is one skill sentence"; `pv_refresh_per_send`) |
| 33 | Remote: pane is local transport, process remote; pane dying is agent dying | K | remote-workers.md |
| 34 | Remote: one orchestrator DB, the remote worker cannot close; read the remote recipe first | K | remote-workers.md (brief ends with a `CLOSE:` block; read it from `agent wait` `lastText`; `task close --evidence`), worker.md remote bullet; SKILL.md gotcha pointer |
| 35 | `mule` exit 3 is a hand-back; never retry or open `ssh -MNf` | K | remote-workers.md last bullet (destructive/irreversible: operator's key) |
| 36 | Workstream names `<project>-<purpose>`, one per effort, torn down when shipped | C | `workstream init` prints the hint and `workstream --help` says it |
| 37 | Reviews nobody will track run as `scratch` delegates | K* | findings.md mode paragraph |
| 38 | Agent names: roles with smallest unused suffix; no human names | C | `agent spawn --next-free` |
| 39 | Task note contract: FILES/COMMANDS/FINDINGS/DECISION/NEXT/VERIFIED/ODDITIES | K*/D | worker.md keeps FILES, COMMANDS, VERIFIED. FINDINGS/DECISION/NEXT/ODDITIES dropped: `task notes` default view pins brief, report and verdicts (`cc_last5_hides_brief`), and nothing measured those four fields. Hill-climb candidate |
| 40 | Close with grounding: `close --evidence "tests pass: ..."` | C+K | `task close` refuses `done` without evidence (`UsageError`, exit 2; its `nextSteps` is the fix); worker.md shows one |
| 41 | **Keep driving**: the turn ends only when all is closed or a human must decide; summary is a log line | K | SKILL.md, inside the `mu:keep-driving` markers (`extension/nudge.ts:36-37,88-102`; pinned opening in `test/extension-nudge.test.ts:78-83`; `um_prods_outage`: ~2/3 of 95 prods were real stalls). Rewritten: one summary per wave, "an error never means a human is needed", `mu human-needed` named. Nudge still fires from this block |
| 42 | Read orchestrator-loop before dispatching | K | SKILL.md |
| 43 | Claim before sending, even one-shot reviewers | C+K | `agent spawn --task --send` claims after the pane exists, one journaled attempt (`src/agents/task-spawn.ts`, `spawn_receipts`); rule kept as the one line |
| 44 | Pipeline; don't barrier | K* | orchestrator-loop.md Merging ("as they close") |
| 45 | Verify the merge, not the worker's rerun; only `CLOSED/done` ships | K | SKILL.md |
| 46 | Push after merged-tree gates pass; full slow once per batch; queue upkeep at milestones | K* | orchestrator-loop.md Merging + test-health.md |
| 47 | Define done before a long run | K | SKILL.md ("Stop rule on the umbrella first") |
| 48 | New work to pi is `send --fresh`; never chain `/new` and a prompt | C | `--fresh` is one operation (`agent send --help`); `/new` over the ctl socket refused while busy |
| 49 | `task wait --first --on-stall exit`; exit 7 means read the pane and answer | K | orchestrator-loop.md step 4 only (exits 5/6/7); SKILL.md says "no sleep loops" and links, **TODO v_wait_surface** (`mu wait`: first owned event, resume) |
| 50 | Stop a worker gently: `abort`, then `close` | K | orchestrator-loop.md Stopping |
| 51 | `--interrupt` redirects a busy pi now; `--steer` waits for the tool | K | SKILL.md, orchestrator-loop.md Sending (`test/agent-interrupt.test.ts:299-307` reads the path and forbids "--steer … interrupt the") |
| 52 | Send, don't note, a running worker | K | SKILL.md |
| 53 | Refute a brief claiming a cause, fix, threshold or code fact; else `REFUTE-EXEMPT: <why>` | K | SKILL.md rule "Checks are calls" states refute-before-act once; brief.md keeps only the exempt note and links |
| 54 | Checks are calls, not tasks; issue all in one turn; `record`; judges `WINNER:` | K* | tasks-or-calls.md; `WINNER:` dropped: the judge recipes are cut (§2) |
| 55 | `MU_DELEGATE_MAX` (16) run at once; the rest queue | C | extension admission control; tasks-or-calls.md states the queue/refuse/reissue once |
| 56 | Leave no scratch files; stdin for pure delegate calls; one `mktemp -d`, `rm -rf` | D | `agent send -`, `mu_delegate task`, `delegates register --text -` are file-free; the cleanup rule was obeyed by default |
| 57 | Findings are `task add --triage` tasks, decided by `accept` or `close --as rejected\|duplicate`; untracked reviews run as delegates | K | findings.md |
| 58 | `close --as rejected\|wontfix --why` unblocks dependents; `rejected` false, `wontfix` true but not worth it; `task park --why` keeps them waiting | K | SKILL.md Gotchas (judgement the verb cannot make; the close output lists `unblocked`, `src/tasks/lifecycle.ts:273`) |
| 59 | Waits use `task wait`, not `log --tail`; `log --kind` is your own ledger | K* | "No sleep loops". The `log --kind` ledger is dropped with watcher (§2) |
| 60 | Apostrophes end `'...'`; use a quoted heredoc | C+K | `-` stdin, and a "too many arguments" error that hints the apostrophe (`test/prose-quoting.test.ts`); brief.md Quoting keeps the two heredoc shapes |
| 61 | Never put `MU_DB_PATH` inside `MU_SYNC_DIR` | C | `DbInsideSyncDirError`, exit 4 (`src/fleet-hazards.ts:55`, `pv_fleet_hazards`) |
| 62 | Before rebuild, teardown, sync setup, a `doctor --deep` DRIFT or cleanup output, read recovery | K | SKILL.md Gotchas + recovery.md |
| 63 | You pick the model; tiers per role; local models last resort | K | models.md |
| 64 | `mu_delegate` takes `model`; spawn takes `--command "pi --model <id>"` | K | models.md |
| 65 | A checker runs at the author's tier or higher, another family; no `model` = the cli default | K | models.md only; SKILL.md Gotchas and adversarial-review step 3 link to it |
| 66 | Reaper: a dead pane reopens IN_PROGRESS tasks with a `[reaper]` note; no manual release | C | `src/agents/reap.ts:64` (`877 reaps`); SKILL.md keeps the failure half: `unknown` is not dead |
| 67 | pi state through ctl, needs no murmur; other CLIs through murmur (tmux) or herdr; `unknown` means no source | D | `mu doctor` says why (`agent state`/`ctl` rows); murmur has its own docs. Non-pi CLIs are rare |
| 68 | Before merge/close `--as rejected`/abort/teardown read the pane, `log --tail`, task notes | C | `agent close` preview prints revision, owned tasks, worktree state; `unknown is not dead` rule keeps the pane read |
| 69 | You are a worker: follow worker.md; close as the last action or the wait hangs | K | SKILL.md pointer; worker.md |
| 70 | Guardrails: task ownership outranks agent state; coordinate through notes and the log; edges within one workstream; bounded paths | D | edges across workstreams are refused by `task block`; ownership is `claim` CAS (`kg_local_ownership`); bounded paths is brief.md FILES |
| 71 | Recipe index of 26 | K* | SKILL.md table of 10 core; the other 16 are slice B's (§4) |
| 72 | `See also: mu --help` | D | stated at the top |

## 2. Recipes

15,519 words become 2,357 (core ten) plus a slice-B allowance (§4).

### orchestrator-loop (1,156 → 249)

| 3.x rule | | Destination |
|---|---|---|
| Every turn: `mu state`, spawn one per ready task, claim, rebase, brief, wait, merge, repeat | K | steps 1-5 |
| Claim before sending | C+K | `spawn --task --send` in step 3 |
| Ceiling written on the umbrella so a resume keeps it | K* | step 2 (one line, no numbers) |
| Delegate concurrency 10-20, start at 8; `MU_DELEGATE_MAX`, queue 4×, refuse | C | extension admission; recipe says nothing about the numbers |
| Answers arrive when you stop; `followUpMode: "all"` | K* | **superseded by v_settle** (README "never stop, never starve"): answers arrive through the settle wait, a wave's as one summary; the pi message is only a wake. Before it shipped, answers arrived only as follow-ups. Delegate waves says so and adds the wave's delegate task ids to the `task wait --first` (`task wait` on a `kind=delegate` task verified: exit 0, `firing` set). `followUpMode` and the batch-reading advice dropped |
| Workers with worktrees: one per CPU core | D | unmeasured; the ceiling is the orchestrator's note |
| Stream dispatch; codemode driver for batches | D | drivers are cut (§2 codemode-driver) |
| Waiting: `--first --on-stall exit`; exit 6/7; the exit's `Next:` leads with `agent wait --after-runs` | K | step 4 (exit codes). The `Next:` text is code (v_hints TODO) |
| Never release because the owner reads `unknown`; the reaper acts only on a dead pane | K | SKILL.md rule "`unknown` is not dead" |
| `MU_IDLE_THRESHOLD_MS` 5m | D | `--help`/doctor; no failure behind it |
| Remote owner: `agent wait --after-runs` first | K | remote-workers.md |
| Merging: pipeline, cherry-pick new commits, bounded batch | K | Merging |
| Pin the batch tree; full slow once; fast if slow excludes it; independent workers continue | K* | Merging "gate one pinned batch"; test-health.md orchestrator bullet |
| Bisect a failed batch | D | obeyed by default (an engineer's reflex); one clause lost |
| Push only the verified tree; `git push` last under `set -e`; record gate result with the tree | K* | "push only the verified tree". `set -e` and the log line dropped |
| Accept evidence, not close notes; re-run from a clean checkout; a gate that cannot fail is no evidence | K | Merging |
| Build cache (private targets per worktree, Cargo target, warm-up) | D | repo-specific build guidance, not mu; the recipe said so itself ("not a new mu cache") |
| Sending table (plain/steer/interrupt/fresh) | K | Sending |
| claude-code/codex: send `/new` then prompt | D | non-pi sends are herdr-only and atomic (`agent send --help`); tmux refuses |
| Use `mu agent send`, not raw mux input | C | tmux paste send was cut; send is ctl or herdr `agent prompt` |
| Cross-workstream wait/claim use qualified refs | C | `-w` help: "a qualified `<ws>/<name>` ref carries its own" |
| Stopping: abort then close | K | Stopping |

### tasks-or-calls (644 → 241)

| Rule | | Destination |
|---|---|---|
| A task is graph-tracked work; checking is a call; the two-column table | K | table |
| Delegate call shape: starts empty, brief carries everything, VERDICT block | K | The call |
| Fan out in one turn | K | bullet |
| `scratch` pane stays attachable; closed after clean finish, kept on crash | C | extension (`keep`); dropped |
| An API error is yours to decide: reissue or UNVERIFIED, then close the kept pane | D→C | `delegates` states `failed`/`refused`, `mu_delegate_reissue`; orchestrator-loop names reissue |
| Outside-pi form: spawn, `send --fresh --json -`, `wait --after-runs`, note, close | K | The call, last paragraph. **TODO v_delegate_nomux** replaces it if that unit ships a verb |
| `REFUTER n: no verdict (<outcome>)` on a timed-out wait | K* | same paragraph; extension writes the identical shape (`src/delegate-verdict.ts:55`) |
| Counting: units + gates + findings; > few hundred means checks became tasks | D | measured nowhere; the table prevents it |
| Examples (30 findings → 30 calls) | D | the table |

### worker (233 → 222)

| Rule | | Destination |
|---|---|---|
| `$MU_AGENT_NAME` resolves identity; bare `claim` works in a worker pane | C | spawn env injection; `task claim --help` |
| `mu me` / `me next` first | D→C | the brief carries id and task (README: "Workers get identity and task in the brief") |
| show, notes, claim, note, close as last action | K | code block |
| Gate records in the final note (test-health) | K | bullet |
| Keep each tool call to minutes; steering reaches you only between calls | K | bullet |
| Commit before you close; the orchestrator cherry-picks commits, not your tree | K | code comment |
| Never `cd` into your worktree | K | brief.md bullet only (the worker reads its cwd; 5,755 redundant `cd` calls); worker.md says "your cwd is your worktree" |
| Skipping close hangs the wait; won't do it: `--as wontfix --why` | K | closing lines |
| CLOSE block as the final lines of a pi worker's message | **TODO v_wait_core** | `src/close-block.ts` parses and applies it but nothing calls `applySettledClose` yet (grep: only `observe.ts` builds the input). One TODO line; `mu task close` stays |

### brief (562 → 240)

| Rule | | Destination |
|---|---|---|
| End on a checkable, exhaustive criterion | K | bullet 1 |
| Inline what every path needs; point to the rest (`Read: mu task notes umbrella`) | K | "Share once" |
| State the target, not the ban | K | bullet |
| Reuse the recipe words | D | obeyed |
| Cut the default (no "be careful") | D | writing-for-agents covers it; models obey |
| Evidence, not reassurance | K | bullet |
| A brief that makes claims is refuted | K | bullet |
| Shape template | K | code block (`NOTE:` gate-record line dropped: test-health.md owns it) |
| Quoting: heredoc, `-`, `--why`/`--evidence` have no `-` form | K | Quoting |
| Chain batched adds with `&&` then `task list` | C | `task add` takes several ids atomically (`add --help`) |

### findings (946 → 246)

| Rule | | Destination |
|---|---|---|
| Pick mode first: DAG fix → workstream; read once → delegate | K | Mode |
| Delegate mode: one `FINDING:` line each; promote to triage when it turns into work | K* | Mode paragraph; "promote" dropped (obvious) |
| Record: `OPEN/triage` blocking the umbrella; one `FINDING:` line | K | Record |
| Severity grading, strict; lower when unsure | K* | Record. "Vague drops a level" and "2+ levels to the human" dropped (unmeasured) |
| More than 5 findings: `FINDING:` lines in the note, a `triage_<umbrella>` task | D | `task add` takes batches atomically and `--blocks`; the cap existed to save calls. Hill-climb candidate |
| Triage by whom (self vs `triage_` task) | D | same |
| Refute each with a recorded call; skip low style; three refuters for high, accept at 2 | K | Triage 1 |
| Decision table with good and bad reasons | K* | Triage 2 (bad-reason column dropped; the 40-char weak-reason warning is code: `WEAK_REASON_CHARS`, `src/tasks/lifecycle.ts:471`) |
| UNVERIFIED is not REFUTED; stays in triage, reported to the human | K | Triage 2 |
| Group findings sharing files; supersede the grouped ones | K | Triage 3 |
| Umbrella closes `--if-ready`; an UNVERIFIED finding blocks it | K | last line |
| The report is a query (`task list --substate rejected`) | D | obeyed |

### adversarial-review (845 → 238)

| Rule | | Destination |
|---|---|---|
| Criteria first | K | step 1 |
| `review_x` blocked by `x`; `task add ... --blocked-by x` | K | step 2 |
| Fresh reviewer, worker's tier or higher, another family; only the diff, criteria, gate records | K | step 3 |
| Reviewer brief (reproduce, report categories, UNVERIFIED, close forms) | K* | step 4 (the full block shrinks to a sentence plus the two close commands) |
| ACCEPT = `CLOSED/done`, REJECT = `CLOSED/rejected`; re-block downstream on `review_x_2` | K | step 5 (rejecting unblocks dependents: the trap) |
| Two rejections stop the loop | K | step 6 |
| No evidence, no verdict | K | bullet |
| Only-UNVERIFIED review is not a REJECT | K | bullet |
| A reviewer that has the author's reasoning agrees with it | K* | step 3 ("not the worker's reasoning") |
| Reviewers drift into fixing | K* | step 3 ("only writes are findings…") |
| Closing a review yourself needs `COMMIT: <sha>` and a named check | D | a rare path; the weak-reason warning covers thin closes. Candidate |
| Review is not merge verification | K | step 5 |

### test-health (737 → 243)

| Rule | | Destination |
|---|---|---|
| Use the repo's `## Gates`; never waive a repo check | K | Gate contract |
| Worker/reviewer/orchestrator allocation | K | three bullets |
| Gate record (GATE/RESULT/CONDITIONS) and reuse conditions | K | code block, one paragraph |
| Targeted pass, zero cases, skipped privileged check is not a full pass; clear inherited selectors | K | "is not a full pass" (the selector clause dropped) |
| Adding tests: lowest level; new slow case states why; red-green for cheap bug targets | K* | one sentence; red-green dropped (the TDD skill owns it) |
| Poll with a bound; retain deliberate sleeps | D | an engineering default |
| Upkeep loop (profile, classify, refute, do, measure, report) | K* | six lines; "Refute MERGE/DELETE" kept (a deleted test must name the failure it no longer catches) |
| Commit `docs/test-health/<date>.md`; add, never edit | K* | step 6 |
| Done-when paragraph | D | the steps carry it |

### models (878 → 232)

Tier table, role table, checkers (level or up, another family, same model with higher effort), passing the model and effort, herdr refuses overrides: **K**. Dropped: how to rank an unknown model (long paragraph; probe and compare), "a local model never reviews" kept as one clause, "`ctl: ok` does not test the model" and the probe command (`pi --list-models` states it), "thinking effort strengthens a model" kept as "Effort is no other family", the gateway prefix example (`modelbridge/...`): **D**, it is host-specific and `mu_delegate: model must be one pi model id like 'provider/id:thinking'` already teaches it (`extension/delegate.ts:1029`).

### remote-workers (1,985 → 239; README target ≤ 200, exceeded to carry the close step; cap 250)

| 3.x rule | | Destination |
|---|---|---|
| Pane is transport; pane dying is agent dying | K | first paragraph |
| One orchestrator DB; the remote worker cannot claim or close; you close from its reported sha | K | first paragraph and the brief's `CLOSE:` line; no code applies the block yet (`applySettledClose` has no caller, **TODO v_wait_core**), so you read it and run `task close` |
| Registry fields (`agents.host`, `cwd`, `base`); no `REMOTE:` note | C | `mu state` shows them; the `REMOTE:` note is gone |
| Profile: `host init --ssh`, `host check` | K | code block |
| One journaled spawn: `--host --worktree --task --send` | K | code block |
| `--worktree` makes a detached remote worktree; `--root` refused; channel reserved before the first remote command; a failed spawn removes only what it made | C | `spawn --help` (`--host`), `v_remote_spawn` |
| `collect` pins `refs/mu/collect/...`; `close` removes the worktree only if clean and at base or collected HEAD; never `--force` | C | `agent collect --help`, `agent close --help`; one bullet keeps the refusal reasons |
| `--max-sessions 1`: the live pane holds the only channel; collect refuses; raise the cap | K | bullet (`single_channel_host`, holdout) |
| ctl forward requirements (extension on the host, no multiplexing, `AllowStreamLocalForwarding`) | C | `host check --agent` probes it; one failure, one line. Candidate to restore a half-line |
| herdr cannot run `--host` | C | refused in one line |
| Wait once per reported-done turn; never `sleep`; set a deadline | K* | code block uses `agent wait --after-runs`; TODO v_wait_surface will replace |
| Fetch from the worktree: quote the URL; no shared remote | D | the profile's `--fetch` template is yours; `collect` runs it |
| Run the merged gate on the host (push to temp ref, `mule run --wait`, delete the ref) | K*/D | "Long remote gates are panes" bullet; the mule recipe is dropped: `v_remote_gates` (OPEN) owns non-pi gate panes; `wait_remote_gate` scenario measures it |
| Non-pi spawn on an auth prompt looks healthy | D | non-pi remote agents are tmux-only via host profile; confirm-with-`agent read` is a reflex. Candidate |
| Use the host's real pi command, not a wrapper | D | the `host check` runs `pi list` and names mu; candidate |
| Dropped connection is a dead agent; commits stay in the remote worktree | C | `remote_recovery` record; `agent close --recovery`, `agent collect --recovery` (`v_remote_recovery*`) |
| `abort`/`close` through the forward | C | `agent abort --help` ("works for remote agents") |
| murmur section | D | see SKILL #67 |
| `MaxSessions 1`: `ssh-add -l`, `ps` for the holder, ET, mule table | D | `--max-sessions` refusal names the holder (README Remote workers); ET and the mule exit table are outside mu. **mule exit 3 hand-back is kept**, the one destructive-by-retry case |

### recovery (281 → 207)

Teardown soft with preview and `--if` (**K**/**C**: `workstream teardown --help`); rebuild writes a new DB and re-spawn (**K**); never confuse `db backup` with recovery (**K***); sync folder, `--repair` safe, agents/worktrees/ownership never travel (**K**); `db forget` only what the human named (**K**); `doctor --deep` DRIFT: back up, report, never rebuild (**K**, a destructive-order rule); `doctor` disk section runs no cleanup (**K**). Dropped: the done-when paragraph (**D**).

### Recipes not in the core ten (16)

All **D** from the default set, pending slice B's allowance (§4). Each row says what the destination of its rules is.

| Recipe (words) | Rules and their destination |
|---|---|
| ultrathink (695) | Define done, plan the whole phase as tasks, review every unit, close against the stop rule on the merged tree with one final refuter, own workstream `<project>-ut-<topic>`, calibrate on a slice. **K\*** as one 110-word recipe (§4); the table of shapes is the SKILL.md index; `prompts/ultrathink.md` points at it |
| plan (541) | Map files and gates, size to a reviewable unit, root `task_0`, brief with INTERFACES/STEPS, no placeholders, edges for dependencies only, self-review against the spec, refute claim-making briefs. **K\*** as a 110-word recipe; `task add` batch and `--blocks` make the how-to code |
| fan-out (321) | Enumerate with a command, one task per unit into an umbrella, shared brief on the umbrella, cap, pipeline, per-unit review when wrong is costly, `--if-ready` and the count matches. **K\*** 90 words; `prompts/mu-sweep.md` |
| loop-until-done (311) | Stop rule + no-progress rule, one task per round, measurement in the note, you check the rule, refute the umbrella on the merged tree. **K\*** 90 words; `prompts/mu-until.md` |
| refute (423) | Pin scope, one finder per slice, finders record findings, refute with calls, UNVERIFIED not REFUTED, cheap finders strong refuters. **D**: every rule lives in findings.md and models.md; `prompts/mu-refute.md` retargets to findings |
| review-panel (451) | One reviewer per angle, merge duplicates, refute, vary families, panel is not the slow gate. **K\*** 90 words, absorbing the angle table; `prompts/mu-review.md` |
| tournament (345) | Rubric first, pairwise judges, swap order on close calls, vary families, `WINNER:`. **K\*** 70 words; `prompts/mu-tournament.md` |
| hypothesis-panel (348) | Symptom with repro and count, one reader per evidence source, `PREDICTS:`, kill or survive, fix then review. **K\*** 60 words; `prompts/mu-debug.md` |
| deep-research (529) | Question and bar, one searcher per angle, `CLAIM:` with source and quote, one checker per claim, confirmed claims only. **K\*** 70 words; `prompts/mu-research.md` |
| rules-audit (656) | One checker per rule, skeptic pass; mine corrections. **D**: mine mode needs a session archive (museum), not mu; check mode is review-panel's "rules" angle. `prompts/mu-rules-audit.md` retargets |
| waves (191) | Bucket by file cluster; chain with `block`; refresh before dispatch; pipeline the merge. **D**: all four are orchestrator-loop steps 3 and Merging; "blanket freeze idled four of five workers" is a one-line trap, cut |
| long-run (254) | Define done first; split into units; state in the DB; bound each tool call; accept evidence. **D**: ultrathink + orchestrator-loop carry each; `DEAD-END:` notes are the one unmeasured loss |
| drift-audit (681) | Seven read-only checks over `mu sql` (unsent notes, stale pins, closed-task notes, thin decisions, silent tasks, missing work, unrefuted briefs). **D**: the SQL is the trap; `task notes` since-claim filters and the SKILL "send, don't note" rule cover check 1, `agent check` covers delivery. Candidate to restore only if a scenario flags a lost instruction |
| watcher (223) | Last-seen state in a `mu log --kind` ledger, attempt cap, cooldown, untrusted comment text. **D**: no measured use in the mined sessions beyond one author; reinstate on demand |
| backlog-triage (330) | Quarantined readers, dedupe against the DAG, record seen items. **D**: same |
| codemode-driver (953) | Script rules (delete it mid-run and lose nothing), workers and delegate-table snippets. **D**: README makes `mu wait` the primitive; the snippets used an envelope-less shape and an undefined `json` helper (the refuter's finding: `codemode-driver.md:35-36,76-77`). Not rewritten |

## 3. Rules now enforced by code (cited)

The destination "C" rows above, collected by guard, so slice B's destination
table can point at one place.

| Guard | Rule it replaced | Cite |
|---|---|---|
| `agent spawn --task --send` | claim-before-send, rollback on failure, replay never resends | `src/agents/task-spawn.ts`, `spawn_receipts` |
| `agent send --fresh` | no chained `/new` + prompt | `agent send --help`, extension `--fresh` |
| `agent check <msgId>` | unknown delivery is checked, never resent | `src/cli/agents.ts:1266` |
| `agent close` preview and `--if` | teardown/close fence, dirty refuses | `src/agents/close.ts:49,244` |
| `workstream teardown` preview and `--if` | previewed teardown | `src/workstream.ts`, `--help` |
| `task close` evidence and `--why` guards, `--if-ready` | grounding, substate reasons | `src/tasks/lifecycle.ts` |
| `weakDecisionWarning` | thin decision reasons | `src/tasks/lifecycle.ts:471-486` |
| `task accept`, triage state | findings stay out of `next`/`claim` | `task accept --help`, `claim --force` |
| `delegates register/finish/tally/mark`, extension `record` | verdict lands on the judged task before the report; waves; queue | `src/delegates.ts`, `src/delegate-verdict.ts`, `extension/delegate.ts` |
| `mu human-needed` | the only way the loop stops for a human; never automatic | `src/human-needed.ts`, CHANGELOG |
| reaper | dead pane reopens tasks | `src/agents/reap.ts` |
| `DbInsideSyncDirError`, `assertSyncDirV2` | db not in the sync dir; no 3.x segments | `src/fleet-hazards.ts`, `src/sync-dir-guard.ts` |
| `--host` spawn, `host check`, `--max-sessions`, `collect`/`close` refusals, recovery records | the remote recipe's procedure | `src/hosts.ts`, `src/remote-*.ts` |
| `-` stdin and the apostrophe hint | quoting | `test/prose-quoting.test.ts` |
| `--next-free`, `workstream init` hint, `scratch` auto-create | naming and scratch rules | `src/agents/spawn.ts`, `src/workstream.ts:54` |
| error teaches the trust prompt | trust-prompt note | `src/agents/errors.ts:393-400` |
| `no such column` lists the columns | sql guess traps | `mu sql --help` (`um_sql_column_guess`) |

## 4. Slice B: allowances and hand-offs

**Budget arithmetic.** Core ten = 2,357 words. The total cap is 4,000 and
`v_move_recipe` reserves up to 250, so the other recipes share ≈ 1,393. The
proposed allowances sum to 690 (§2: ultrathink 110, plan 110, fan-out 90,
loop-until-done 90, review-panel 90, tournament 70, hypothesis-panel 60,
deep-research 70). Slack: ≈703, so slice B can restore any D row below that
measurement supports, one 250-word recipe at a time.

**SKILL.md has 14 words of headroom** (586 of 600). Index rows for those
eight recipes plus `move` cost ≈ 100 words. Slice B must either cut Gotchas
(first candidate: the `park` and tier bullets) or reach the extra recipes
from `ultrathink.md`'s shape table and the `prompts/` pointers instead of
the SKILL index. Decide with `t_skill` evidence, not by word count.

**Consumers that bind the draft (all kept intact):**

- `extension/nudge.ts:36-37,88-102` reads `<!-- mu:keep-driving -->` blocks;
  `test/extension-nudge.test.ts:78-83` pins the opening
  `**While workers run, keep driving.**`. The draft keeps both.
- `test/agent-interrupt.test.ts:299-307` reads `recipes/orchestrator-loop.md`;
  no line there pairs `--steer` with "interrupt the".
- `test/extension-mu-pi.test.ts:1154-1204`: skill frontmatter is YAML-safe
  (block scalar) and every `prompts/*.md` links an existing recipe. Slice B
  retargets `mu-refute.md`, `mu-rules-audit.md`, `mu-debug.md` and
  `mu-research.md` if their recipes are cut.
- `test/docs-cli-drift.test.ts` lists recipes statically and must be updated
  when files are removed or `move.md` lands. Slice B owns that.

**Not shipped at `a4e2eeb`; the draft says so or says nothing.**

| Unit | What the draft would otherwise state | Draft today |
|---|---|---|
| `v_wait_surface`, `v_wait_arming` | one `mu wait` over tasks, agents, delegates; first owned event; `send --wait`, `claim --and-wait`; registered waits | still `task wait --first --on-stall exit`, `TODO(v_wait_surface)` in SKILL.md and orchestrator-loop.md |
| `v_settle`, `v_settle_wait` | an answer or settle wakes an idle turn; keep-driving by state | orchestrator-loop.md Delegate waves states the current rule "until v_settle"; SKILL.md keeps the nudge block unchanged |
| `v_wait_core` | applying a worker's CLOSE block on settle | `TODO(v_wait_core)` in worker.md |
| `v_hints` | every `Next:` hint executable; a rule set | SKILL.md: `TODO(v_hints)`, `next` is null today, hints in `nextSteps` |
| `v_exec_dispatch`, `v_exec_recover`, `v_exec_refute`, `v_auto` | `mu next`, `task auto` | silent (`task auto` exists; `mu next` does not). Add one line when dispatch lands |
| `v_wait_actions`, `v_wait_release`, `v_wait_steer` | `--on-stall steer\|release` | silent |
| `v_delegate_nomux` | delegates outside tmux without a pane | tasks-or-calls.md keeps the manual `scratch` form |
| `v_move_recipe` | the move recipe and its index row | silent; 250 words reserved |

**Findings for the orchestrator.**

1. `mu me` still exists as a top-level verb; README says it becomes
   `state --me`. `state --help` has no `--me` yet. The draft uses neither.
2. `mu delegates tally` requires `--wave` (CommanderError without it);
   `delegates show` rejects `-w`. Real surface, not draft errors.
3. `task wait <delegate-task-id>` for a `kind=delegate` task works (round 2
   check: exit 0, `firing` set once the call closed). Until v_settle the draft
   puts the wave's delegate task ids in the `task wait --first`, then tallies through
   `mu delegates tally`.
4. The old codemode-driver snippets were stale beyond naming (refuter's
   finding); the draft drops the recipe rather than repairing it.

## 5. Verification

- `wc -w`: SKILL.md 586 (cap 600); every recipe 207-249 (cap 250); recipes
  total 2,357 (cap 4,000). Counted
  with `wc -w`, so frontmatter, code blocks and tables count.
- A throwaway vitest (not committed) ran `checkDocCommand` over every `mu`
  snippet in the draft against `buildProgram()`: 0 invalid verbs or flags
  after the fixes (it caught the unshipped `mu wait`, now a TODO). It also
  confirmed `keepDrivingRule()` returns the block with the pinned opening
  and that every relative link in the draft resolves.
- `test/prose-budget.test.ts` does not exist yet (slice B), so there is no
  budget test to point at the draft.
