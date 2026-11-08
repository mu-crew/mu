<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# hill-r2 B5: the base baseline

Task `b5_baseline` (workstream `crew-hill2`). Spec:
[docs/specs/2026-11-07-hill-r2-tournament.md](../../specs/2026-11-07-hill-r2-tournament.md)
§0, §1.4, §4.1-4.2, §7 B5. This file holds base's spread, the ρ̂ estimates and the n plan of each
group before any designer starts. B5 rows only set the spread and ρ̂. They are never a round's
comparator (§4.1).

## Setup

- **Surface:** base = main `9bc4c6ea` (rig merged), built as `~/.cache/mu/eval/surfaces/hill2-base`
  (`.ref` = `9bc4c6ea492eaccc45c53d14bf6448f51c932f90`), family `next`. The same name and ref that
  `tournament freeze --base 9bc4c6ea` prepares, so that freeze reuses the build.
- **Rig:** this worktree's `tools/eval` with the three fixes committed beside this file (below).
  Every row in `probe.jsonl` was judged by the final code. The `shown` fix came mid-run, so the five
  cases whose markers can come through mu's tab-separated text were re-run after it, with the same
  seed and job keys: `notes_report_read`, `notes_multi`, `finding_guess`, `sql_name_guess` and
  `wait_result_read`.
- **Models:** `claude-haiku-5-5`, `gemini-3.8-flash` (weak), `claude-sonnet-5-5` (gate), through
  `askModel` and `runAut` with no provider extension (B0's spellings).
- **Probe:** every next-step case, every paraphrase and every arm, r = 4, all three models: 340
  clusters × 4 × 3 = **4080 rows** (`nextstep run --round b5 --seed b5-base --concurrency 24`).
- **Cold-guess:** all 25 intents (23 headline plus the 2 controls, the §2.1 next-only ones
  included), r = 4, three models: **300 rows**.
- **R4 set:** every non-holdout pi scenario of `tools/eval/scenarios/` that runs on this mac: 23
  scenarios × 3 models × 5 reps = **345 AUT runs**, through `runR4` (round `r4`, variant `base`).
  Left out: the holdouts; `_smoke`; `e1`-`e7`, which are live hook-harness cases that run the
  user's own paid claude, codex, cursor-agent and Muse; and `wait_interrupted`, which needs Linux
  because its interrupter reads `/proc` (its golden fails on macOS: "the SIGTERM never reached a
  wait").
- **Holdouts** (`worker_dies`, `wait_receipt_race`, `wrong_id`, `single_channel_host`): not run,
  and no transcript of them was read.
- **Host:** the mac (16 cores), shared with other crew workers, at a load average of 10-33. Run with
  `TMPDIR=/tmp` for the probe and `TMPDIR=/private/tmp` for R4 (see the rig fixes).
- **Wall:** probe 00:59-05:41 (4.7 h, load-gated at 16), plus the re-runs (360 + 960 rows, about
  45 min at load 7-10). R4 01:04-05:23 (4.3 h at 4-7 concurrent), plus the 15-run `refute_verdicts`
  re-run. The probe's own `wallEstimate` for these jobs is 3.2 h, so on this shared host the real
  wall ran **about 1.5× the estimate**. Apply that factor to the plan hours below.
- **Spend:** probe 14.5M tokens in the final rows (haiku 3.63M, sonnet 3.70M, gemini 7.12M; the superseded rows cost about 4M more), cold-guess 2.6M, R4
  163M in the first pass, plus 85M for the rig-read re-runs (72M kept, 13M superseded).

### Rows (machine-local, never committed)

Directory `~/.local/state/mu-next/eval-transcripts/hill-r2/b5/`. Prompts are under `prompts/` and
R4 rpc logs under `logs/`, except the logs that carry holdout text, which are in `logs-rig-read/`
(see [Rig reads](#rig-reads-f_aut_reads_rig)).

| file | rows | sha256 |
|---|---|---|
| `probe.jsonl` | 4080 | `f124ef5e79af37e68aeabcb2d5f336cd690ca7b63119fc6a09786789dc14d859` |
| `cold.jsonl` | 300 | `3a66bc1a4cc78f12950caba9d79b4859b8c4dbf486bb742b6000a8bedff6d031` |
| `r4.jsonl` | 345 | `77309bafd6a702267b0f990e94a1358c36cf1ba9101174ca1f2bb7333a777b4c` |
| `r4.raw-pre-rigfix.jsonl` (superseded: the first R4 file, 57 gemini rows read the rig) | 345 | `b5c73b371d310de889ca4f8406e3569d25af48ac2489e5f4da52f1c0b0287ad9` |
| `r4.raw-rig-read.jsonl` (the 57 rig-read rows, `verdict.rigReads` added; logs in `logs-rig-read/`) | 57 | `7a2fc5e7ddab5421db97dd80e2d648441b1a37dc96ae5b5d182a516fbf5a4c02` |
| `r4.raw-rig-read-rerun1.jsonl` (superseded: re-runs before `aut-guard.ts` that read the rig again; 3 rows name holdout files, none carries their lines) | 9 | `1525580919276bbca54fd61d0c1c489ce4b3964517896ab5b7b2348bd73619a9` |
| `probe.raw-notes-report-v1.jsonl` (superseded: `notes_report_read` before the shown fix) | 360 | `a4dc87c5947185722ee5a56bf8c348062b25c561822476e0ecde138d3d9c330a` |
| `probe.raw-pre-tabfield.jsonl` (superseded: the four other re-run cases, before the fix) | 960 | `815f9516d9a37d5cb64eb6bd4ec79fe8445f758be0e1ac17f128f9a9474aa20b` |
| `r4.raw-before-envfix.jsonl` (superseded: fanout_gates hook, `/tmp` remote paths) | 144 | `59a0dbea3f023e80e8c526a0c66a3a6614616de25efc7755e4b2a11ab9e2e62d` |
| `r4.raw-refute-nodelay.jsonl` (superseded: refute_verdicts without the delegate delay) | 15 | `c978e123fe2472c5f88a3117928bd4a4d4ff40fd1fbdae9127ffde41ff51808f` |

### Rig noise per model

There were **0 model errors** in 4080 probe rows and 300 cold rows. `runNext` retries a model error
twice at once, so any transient error that a retry cleared left no row. In R4, an abort is the run's
own outcome (token cap or timeout), not provider noise:

| model | R4 runs | token-cap aborts | timeout aborts |
|---|---|---|---|
| claude-haiku-5-5 | 115 | 6 | 16 |
| gemini-3.8-flash | 115 | 64 | 1 |
| claude-sonnet-5-5 | 115 | 0 | 12 |

Gemini burns its scenario token cap (about 1.5M) on 56% of R4 runs. That is most of its 46%
completion. Much of that budget goes to searching the machine beyond its sandbox: in the first
pass it read the rig itself (below); since `aut-guard.ts` those calls are refused or cut.

## Rig fixes made to run (committed beside this file)

1. **`8031f331` `tournament plan --b5`.** `plan` read ρ̂ only from a setup row, and only `freeze`
   writes one, so no group's plan could be stated from B5 data. `rhoFromB5` is now shared by
   `freeze` and `plan`, and it drops model-error rows (test: `tournament.test.ts` "rhoFromB5",
   mutation-checked).
2. **`0e5e504b` The probe's `shown` counts a tab field of mu's text.** `task notes` prints
   `<kind>\t<n>\tby=…\tat=…\t<text>`. So when an answer cut that header off (`awk -F'\t'`,
   `cut -f5-`, a python split), finding 1 was never a whole line. 174 of the 360
   `notes_report_read` rows missed on that one line alone ("1 of 40 findings not shown"), and the
   case read as a floor (1/360). After the fix and a re-run it scores 177/360. The four other cases
   that were re-run did not move beyond sampling noise. For example, `notes_multi` went from
   235/240 to 234/240, and `wait_result_read` from 119/360 to 122/360. A `grep -o` cut
   inside a field still misses (test: `nextstep.test.ts`, mutation-checked; `nextstep check` green
   on every case after the fix).
3. **`ce9829ba` R4 scenarios on macOS.** `fanout_gates`'s hook stamped `date +%s%3N`, which BSD
   date does not support, so its golden failed on every run. Four bad scripts used GNU `sed -i`.
   `no_mux_delegate` never created its workstream, so its seed failed and the whole `check`
   aborted. `refute_verdicts`'s instant faux delegate let `bad-close-before-verdict` pass. The
   README now says to run with `TMPDIR=/private/tmp`: with `/tmp`, the remote scenarios' goldens
   fail (checked: `remote_spawn` golden red with `/tmp`, green with `/private/tmp`). Test:
   `fanout-hooks.integration.test.ts` (mutation-checked), plus `check --family next` going from red
   to green for each scenario.

**R4 check on base** (`check --family next`, zero cost; logs `/tmp/b5/r4check*.log`): every golden
hits and every bad is flagged on the 23 scenarios. The two exceptions:

- `wait_interrupted` fails on macOS (Linux only).
- `wait_mixed_refs`'s golden is a **load flake**: it failed twice at load above 20, once on a timeout
  and once on a slow shell call that its idle rule flagged. It passed at load 9.

`tournament freeze` runs this check on `r4Scenarios()`, which includes `wait_interrupted` and
`e1`-`e7`. **On the mac, freeze is therefore refused unless `--no-checks` is passed** or that list
excludes `wait_interrupted`. R3 and R4 should pass `--scenarios` without `wait_interrupted` on the
mac. Otherwise every one of those runs fails on base and variant alike, and the runs are wasted.

## Rig reads (f_aut_reads_rig)

Found by the B5 review: the AUT could read the rig. In `r4.raw-pre-rigfix.jsonl`, **57 of 115
gemini runs** (15 of them completed) read files under a `tools/eval` the sandbox did not hide:
337 tool calls (205 bash, 110 read, 22 grep). No haiku or sonnet run did, and no probe or cold row
did (a probe answer's output never goes back to the model). The ways in:

- the faux workers' `pi` wrapper (`<sandbox>/.rt/pi`) ran `-e <checkout>/tools/eval/faux.ts`: most
  runs found the checkout by reading that file;
- `bin/ssh` named `<checkout>/tools/eval/ssh-shim.ts`; `ps aux` showed the driver's command lines;
- the built surface `~/.cache/mu/eval/surfaces/hill2-base` (a `git archive`) carried `tools/` and
  `test/` itself, so a grep of the surface found scenarios, goldens and judges.

**Holdouts.** Holdout source text reached the model in 10 of those rows: grep lines of all four
holdouts' scenario files (and two `wrong_id` bad scripts), from greps over the checkout or the
surface for a judge's helper name. No run opened a holdout file whole and none ran a holdout. Where
holdout text sits (machine-local, corrected by f_aut_reads_rig_2):

- grep lines: those 10 rows in `r4.raw-rig-read.jsonl` and the same 10 in `r4.raw-pre-rigfix.jsonl`
  (the superseded first file); 7 rows of the earlier `r4.raw-before-envfix.jsonl`; 16 logs in
  `logs-rig-read/`. Four of those logs sat in `logs/` until f_aut_reads_rig_2 moved them: three
  `wait_interrupted` gemini logs of the `before-envfix` pass (`*.before-envfix`) and the log of the
  kept row `wait_wave_six` gemini rep 1 (`*.kept-row`), whose lines were only streaming updates of
  a bash call (the model got the 50 KB tail without them and never read the full-output file);
- file names only: 3 rows of `r4.raw-rig-read-rerun1.jsonl`;
- outside these rows: five pi session files of the crew (workers b4a, b5, the iso workers and the
  orchestrator) and the review's scratch note quote a holdout grep line (listed on task
  f_aut_reads_rig_2).

`r4.jsonl`, `probe.jsonl`, `cold.jsonl`, `prompts/` and `logs/` now carry no holdout file name. No
designer pack includes any of it (the designer audit denies `mu-next/eval-transcripts` and, since
f_aut_reads_rig_2, the whole mu state dir and every transcript store). A model in a later round never sees
another run's transcript, so no holdout must be replaced: the leak informed no variant and no
judge. Keep those files out of any designer or reviewer pack, and do not quote them.

**Fix** (commit beside this file): the sandbox runs copies of the rig's runtime files under
`.rt/lib`; `prepare` strips `tools/`, `test/`, `docs/eval`, `docs/specs` and `docs/history` from a
surface (done to `hill2-base` in place); a pi AUT loads `aut-guard.ts`, which refuses a tool call
that names the rig and cuts rig lines from results; and `rig-guard.ts` marks a run that still reads
it as a rig read (`verdict.rigReads`, never completed, out of every R3/R4/final count and ρ̂).

**Re-run.** Left out, the 57 rows would cut gemini to 58 runs, with five cells at 0 or 1 run, so the
57 cells were re-run with the same job keys. The first 39 re-runs had the staging and the strip but
not yet `aut-guard.ts`: 9 read the rig again (they found the driver's script in `/tmp` and the
other worktrees through `ps`) and were superseded. The last 27 ran with the guard: 0 rig reads;
the guard refused 1 call and cut lines from 22 results in 12 runs. Effect on gemini: completion
51/115 → 53/115 (44% → 46%), mean cost per rep 22.9M → 22.0M, spread 3.86M → 3.04M; per cell,
`api_outage_resume` 1 → 3, `worktree_reuse` 1 → 3, `fanout_gates` 0 → 1, `outside_mux` 2 → 1,
`poll_wave` 4 → 3, `wait_wave_six` 1 → 0. Haiku and sonnet rows are unchanged.

**Canary (f_aut_reads_rig_2).** Path rules cannot be complete: the review read `faux.ts` past them
with a `cd` chain, a glob, `git -C <co> show HEAD:tools/eval/faux.ts` and a symlink plus `cd`.
Every rig file (`tools/eval`, `test/eval`, `docs/eval`, `docs/specs`) now carries a fixed canary
token on its first and last line or element (`tools/eval/rig-private.ts`); an AUT tool result, a
probe answer's output or a pane AUT's hook payload or transcript that carries it makes the run a rig
read. The path rules also match a relative `tools/eval`, follow a command's `cd`s, and cover the
private stores of the designer deny list (pi, claude and codex transcripts, the museum, the mu state
dir). Scan of the kept rows (`r4.jsonl`, `probe.jsonl`, `cold.jsonl`): no canary (the rows predate
it), and no row prints a line of a rig file other than the sandbox's own staged runtime files and
the generated `bin/` scripts. The new path rules flag 1 kept row: `no_mux_delegate` gemini rep 1
(not completed) ran a `node -e` search of `$HOME` for files containing `mu_delegate` and printed
312 paths, most under `~/.claude/projects`; no file content reached the model. Under the rule "re-run only on a canary hit" nothing is
re-run, and no number above changes.

## Freeze: not run (why)

The README orders `freeze → pack → design`. B5's DO LIST says to freeze c2 in that case. But spec
§4.2 says that when the plan is short, "B4b adds paraphrases (up to 14) **before the freeze**". On
these ρ̂, both of c2's own headline cases are short: each needs 14 paraphrases, and each has 10.

Freezing now would also record a plan that the rounds cannot run. `nPlan` sizes a short case at 14
paraphrases, `n_eff` 56 and 54, while `roundJobs` slices the case's own 10 paraphrases. The frozen
row would claim n_eff 56 where the rows give about 40. The hash would have to be refrozen once the
paraphrases land, and `refreeze` keeps the old plan.

So the freeze is left to `c2_close`: add the four paraphrases (with `nextstep lint`), then freeze
with `--b5 <probe.jsonl> --b5-cold <cold.jsonl> --b0 <probe.jsonl>` (the probe rows carry each
model's B0 proof) and `--no-checks` on the mac, or after removing `wait_interrupted` from the R4
list. Suggested rig guard (not built): `freeze` should refuse while any case's plan has `add > 0`.

## Findings for the group designs

- **Floors** (no headroom on base: a variant can only win there by moving a 0):
  `wait_shell_limit` and `delegate_no_verdict` are at 0/360. `wait_heartbeat_merge` (9/360) and
  `close_already_closed` (9/360) are near floor. Every one of these misses is a real reading result.
  - On `delegate_no_verdict`, 198 answers open with `mu delegates show`, and only 2 try to dispatch
    a review: both `mu task check t4` calls exit 2 (usage).
  - On `wait_shell_limit`, every answer is one wait or a backgrounded one (`timeout 100 mu wait`,
    `nohup`). None chains waits past the 120 s limit.

  Such a case can still detect a regression only if the variant raises it first. C1 and C5 should
  expect their wins on the other headline cases.
- **Ceilings:** `notes_multi` is at 234/240 (98%; gemini 94%). That is its own headline case in c3,
  so a c3 win there is close to impossible. Its gemini ρ̂ is unstable this close to the ceiling: it
  was 1.00 in the first sample (4 misses in one cluster) and 0.38 in the re-run. `finding_guess`
  is at 100% on arms `none` and `recipe:findings` for all three models.
- **Dead arms:** the `skill` arm of `close_preview_conflict` is 0/120 on all three models. With the
  skill loaded, 90 of 120 answers reach for a `mu merge` verb that base does not have (66 of them
  as `mu merge --help`, 24 as `mu merge worker-1`). SKILL.md's recipe index row `[merge](recipes/merge.md) | units ready` is the likely cue (C6 input).
- **High ρ̂:** `wait_result_read` is at 0.86/0.68/0.58 (pooled 0.75). A few clusters decide it,
  with arm `recipe:orchestrator-loop` hitting and `none` missing. Its pooled n_eff stays at 48 even
  with 14 paraphrases: c1's win test on that case has a 0.5 → 0.86 MDE. `close_preview_apply` (up
  to 0.69) and `agent_read_text` (haiku 0.66) are short too.
- **Cold-guess:** 21 of 25 intents are at 0% or 100% on all three models. That makes ρ̂ 0.86-0.95,
  so the cold guard's effective n is close to the number of intents. At 0% everywhere:
  `check_record` and `verdict_record` (both guess `--reviewer` or `--check` wrong), `wave_outcome`,
  `close_apply_clean`, `report_only` and `stop_worker`. These are the help-text headroom for C2, C3
  and C5.
- **The answer format** in the probe:
  - sonnet answered in a tool-call XML (`<invoke name="sh">…`) instead of a fenced block in 36
    rows, which count as "no command" misses;
  - one or more `--help` commands appear in 394 gemini, 368 sonnet and 181 haiku rows. The prompt
    says that their output is never shown, so each spends a step and the answer usually stops
    there.

  Both are base behaviour that a variant cannot change (system prompt fixed, §1.1). They put a
  ceiling on sonnet's rates.
- **R4 floors:** `wait_remote_gate` is 0/15 on all three models: the AUT never opens the gate from
  the named pane. On gemini, seven more scenarios are at 0/5, mostly on the token cap. These cells
  carry no loss power.
- **`sleep_poll`'s partial count includes its hits.** Its judge sets `partial` to "all three
  observed", and `decideHit` (`nextstep-exec.ts`) passes `partial` through on a hit. The report's
  `p` column for that case therefore equals hits plus partials. Hits, ρ̂ and scoring are
  unaffected, but the readout is misleading. One line to fix (`partial: !hit && …`); not changed
  here, for c6.
- **No destructive entry** on any probe row. R4 had 4 destructive entries over all models:
  `course_check` 3 and `wait_remote_gate` 1. These are base's own classes for the new-vs-base rule
  (§5.2).


## Measurements

### ρ̂ per case (B5 base rows, one-way ANOVA ICC over (arm, paraphrase) clusters, floored at 0.1)

| case | group | hit haiku | hit gemini | hit sonnet | ρ̂ haiku | ρ̂ gemini | ρ̂ sonnet | ρ̂_pool (weak) | headroom |
|---|---|---|---|---|---|---|---|---|---|
| close_preview_apply | c2_close | 60/120 (50%) | 107/120 (89%) | 72/120 (60%) | 0.54 | 0.69 | 0.50 | 0.30 | ok |
| close_preview_conflict | c2_close | 8/120 (7%) | 11/120 (9%) | 18/120 (15%) | 0.21 | 0.11 | 0.75 | 0.22 | skill 0% |
| wait_result_read | c1_wait | 44/120 (37%) | 51/120 (43%) | 27/120 (23%) | 0.86 | 0.68 | 0.58 | 0.75 | ok |
| wait_heartbeat_merge | c1_wait | 6/120 (5%) | 1/120 (1%) | 2/120 (2%) | 0.31 | 0.10 | 0.10 | 0.23 | near floor (≤ 5% on all three) |
| wait_shell_limit | c1_wait | 0/120 (0%) | 0/120 (0%) | 0/120 (0%) | 0.10 | 0.10 | 0.10 | 0.10 | FLOOR (0% on all three); none 0%; skill 0%; recipe:orchestrator-loop 0% |
| notes_report_read | c3_notes | 57/120 (48%) | 97/120 (81%) | 23/120 (19%) | 0.35 | 0.10 | 0.13 | 0.10 | ok |
| notes_multi | c3_notes | 80/80 (100%) | 75/80 (94%) | 79/80 (99%) | 0.10 | 0.38 | 0.10 | 0.16 | ok |
| agent_read_text | c4_read | 50/80 (63%) | 3/80 (4%) | 9/80 (11%) | 0.66 | 0.21 | 0.47 | 0.14 | ok |
| delegate_no_verdict | c5_outcome | 0/120 (0%) | 0/120 (0%) | 0/120 (0%) | 0.10 | 0.10 | 0.10 | 0.10 | FLOOR (0% on all three); none 0%; skill 0%; recipe:adversarial-review 0% |
| close_already_closed | c5_outcome | 3/120 (3%) | 1/120 (1%) | 5/120 (4%) | 0.21 | 0.10 | 0.11 | 0.10 | near floor (≤ 5% on all three) |
| sleep_poll | c6_skill | 48/120 (40%) | 79/120 (66%) | 15/120 (13%) | 0.20 | 0.28 | 0.22 | 0.20 | ok |
| sql_name_guess | guard | 20/48 (42%) | 20/48 (42%) | 5/48 (10%) | 0.29 | 0.23 | 0.51 | 0.10 | ok |
| finding_guess | guard | 67/72 (93%) | 72/72 (100%) | 72/72 (100%) | 0.23 | 0.10 | 0.10 | 0.10 | none 100%; recipe:findings 100% |
| cold-guess (all intents) | guard | 66/100 (66%) | 75/100 (75%) | 75/100 (75%) | 0.86 | 0.95 | 0.95 | - | - |

Floor/ceiling flags (no headroom; for the group's design):

- close_preview_conflict: arm skill 0% on all three models
- wait_heartbeat_merge: near floor (≤ 5% on all three)
- wait_shell_limit: FLOOR (0% on all three)
- delegate_no_verdict: FLOOR (0% on all three)
- close_already_closed: near floor (≤ 5% on all three)
- finding_guess: arm none 100%, recipe:findings 100% on all three models

Cold-guess intents at 0% or 100% on all three models: 21 of 25

- owner_of: 100% on all three
- task_brief: 100% on all three
- blocked_by_t1: 100% on all three
- collect_commits: 100% on all three
- log_tail: 100% on all three
- needs_human: 100% on all three
- add_three: 100% on all three
- add_three_titled: 100% on all three
- reopen: 100% on all three
- sql_read: 100% on all three
- stop_worker: 0% on all three
- worker_doing: 100% on all three
- list_workstreams: 100% on all three
- check_record: 0% on all three
- verdict_record: 0% on all three
- wave_outcome: 0% on all three
- host_list: 100% on all three
- lease_show: 100% on all three
- notes_two: 100% on all three
- close_apply_clean: 0% on all three
- report_only: 0% on all three

### n plan per group (from these ρ̂; `tournament plan <g> --b5 … --b5-cold …`)

Own headline cases: paraphrases the plan needs (now), clusters m, reps r, per-model n_eff (target 60) and pooled weak n_eff (target 90), MDE for 0.5 → x at 80% (B = 18). Wall: R1 at N = 12 variants and R2 at S = 6 entrants, plus base, 24 slots and 8 model calls per provider.

| group | own case | paraphrases (now) | m | r | n_eff | pooled | MDE | reached | CMH 0.8→0.7 / 0.8→0.75 | R1 rows, h | R2 rows, h |
|---|---|---|---|---|---|---|---|---|---|---|---|
| c2_close | close_preview_apply | 14 (10) | 42 | 5 | 56 | 114 | 0.74 | SHORT | 0.96 / 0.46 | 2340, 0.8 | 22680, 12.5 |
|  | close_preview_conflict | 14 (10) | 42 | 8 | 54 | 158 | 0.71 | SHORT |  |  |  |
| c1_wait | wait_result_read | 14 (10) | 42 | 1 | 42 | 48 | 0.86 | SHORT | 0.97 / 0.46 | 3510, 7.2 | 18900, 16.2 |
|  | wait_heartbeat_merge | 10 (10) | 30 | 4 | 62 | 92 | 0.77 | yes |  |  |  |
|  | wait_shell_limit | 10 (10) | 30 | 3 | 75 | 120 | 0.74 | yes |  |  |  |
| c3_notes | notes_report_read | 10 (10) | 30 | 5 | 62 | 158 | 0.71 | yes | 0.97 / 0.49 | 1950, 0.7 | 21000, 11.7 |
|  | notes_multi | 14 (10) | 28 | 11 | 65 | 144 | 0.72 | SHORT |  |  |  |
| c4_read | agent_read_text | 14 (10) | 28 | 12 | 41 | 156 | 0.71 | SHORT | 0.96 / 0.44 | 780, 0.3 | 20790, 11.7 |
| c5_outcome | delegate_no_verdict | 10 (10) | 30 | 3 | 75 | 120 | 0.74 | yes | 0.97 / 0.46 | 2340, 0.8 | 18270, 11.6 |
|  | close_already_closed | 10 (10) | 30 | 3 | 63 | 120 | 0.74 | yes |  |  |  |
| c6_skill | sleep_poll | 10 (10) | 30 | 4 | 65 | 99 | 0.76 | yes | 0.97 / 0.46 | 1170, 1.5 | 18270, 12.9 |

R1 + R2 probe wall over the six groups: about 88 h (rows only; R3, R4, builds and designers come on top: R4 is about 7.5 h per group at the §4.2 estimate).

Paraphrases each case needs before a freeze that plans it (largest over the six groups' plans; the spec adds them before the freeze, §4.2):

| case | has | needs (max over groups) | short even then (any group) |
|---|---|---|---|
| close_preview_apply | 10 | 14 | yes |
| close_preview_conflict | 10 | 14 | yes |
| wait_result_read | 10 | 14 | yes |
| notes_multi | 10 | 14 | yes |
| agent_read_text | 10 | 14 | yes |
| sql_name_guess | 6 | 13 | no |

### CMH power at each group's plan, at B5's observed base rates

Per model, one stratum per case at its planned per-model n_eff and that model's B5 base hit rate pb, every stratum dropping by 0.1 (pv = pb − 0.1, floored at 0) or by 0.2; α 0.05/3, 3000 draws; the cold-guess stratum is not counted (a lower bound). `tournament plan` prints the same test at pb = 0.8 for every stratum.

| group | haiku −0.1 | gemini −0.1 | sonnet −0.1 | haiku −0.2 | gemini −0.2 | sonnet −0.2 |
|---|---|---|---|---|---|---|
| c2_close | 0.90 | 0.93 | 0.99 | 1.00 | 1.00 | 1.00 |
| c1_wait | 0.90 | 0.91 | 0.99 | 1.00 | 1.00 | 1.00 |
| c3_notes | 0.93 | 0.93 | 1.00 | 1.00 | 1.00 | 1.00 |
| c4_read | 0.90 | 0.90 | 0.99 | 1.00 | 1.00 | 1.00 |
| c5_outcome | 0.89 | 0.91 | 1.00 | 1.00 | 1.00 | 1.00 |
| c6_skill | 0.89 | 0.91 | 1.00 | 1.00 | 1.00 | 1.00 |

### R4 base set: completion and cost spread

345 runs, 23 scenarios × 3 models; holdouts not run. The 57 gemini cells that read the rig are re-run (see [Rig reads](#rig-reads-f_aut_reads_rig)). Cost = tokens + 10·muErrors + 50·wrong (§4.5).

| scenario | haiku completed | gemini completed | sonnet completed | haiku mean tokens | gemini mean tokens | sonnet mean tokens | wrong / destructive (all models) |
|---|---|---|---|---|---|---|---|
| api_outage_resume | 5/5 (100%) | 3/5 (60%) | 5/5 (100%) | 375k | 1392k | 150k | 6 / 0 |
| course_check | 4/5 (80%) | 0/5 (0%) | 1/5 (20%) | 480k | 1535k | 214k | 10 / 3 |
| delegate_saturation | 5/5 (100%) | 2/5 (40%) | 5/5 (100%) | 371k | 1466k | 164k | 2 / 0 |
| fanout_gates | 5/5 (100%) | 1/5 (20%) | 5/5 (100%) | 1120k | 1519k | 135k | 6 / 0 |
| guessed_flag | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 52k | 312k | 32k | 3 / 0 |
| guessed_sql_column | 4/5 (80%) | 5/5 (100%) | 5/5 (100%) | 74k | 117k | 52k | 2 / 0 |
| long_notes | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 103k | 310k | 43k | 4 / 0 |
| multi_notes | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 67k | 242k | 44k | 5 / 0 |
| no_mux | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 78k | 170k | 45k | 0 / 0 |
| no_mux_delegate | 2/5 (40%) | 1/5 (20%) | 0/5 (0%) | 181k | 998k | 94k | 13 / 0 |
| outside_mux | 3/5 (60%) | 1/5 (20%) | 5/5 (100%) | 556k | 1537k | 117k | 7 / 0 |
| poll_wave | 5/5 (100%) | 3/5 (60%) | 5/5 (100%) | 162k | 1413k | 102k | 3 / 0 |
| refute_verdicts | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 121k | 549k | 67k | 2 / 0 |
| remote_close_block | 4/5 (80%) | 0/5 (0%) | 5/5 (100%) | 284k | 513k | 107k | 9 / 0 |
| remote_spawn | 4/5 (80%) | 0/5 (0%) | 5/5 (100%) | 254k | 475k | 108k | 7 / 0 |
| teardown | 5/5 (100%) | 5/5 (100%) | 5/5 (100%) | 39k | 253k | 42k | 0 / 0 |
| wait_helper_summary | 4/5 (80%) | 0/5 (0%) | 3/5 (60%) | 151k | 1525k | 92k | 8 / 0 |
| wait_mixed_refs | 3/5 (60%) | 0/5 (0%) | 3/5 (60%) | 241k | 1483k | 115k | 15 / 0 |
| wait_remote_gate | 0/5 (0%) | 0/5 (0%) | 0/5 (0%) | 451k | 509k | 235k | 15 / 1 |
| wait_report_act | 1/5 (20%) | 4/5 (80%) | 5/5 (100%) | 161k | 1209k | 69k | 7 / 0 |
| wait_wave_six | 5/5 (100%) | 0/5 (0%) | 5/5 (100%) | 549k | 1542k | 233k | 14 / 0 |
| wait_wave_starvation | 2/5 (40%) | 0/5 (0%) | 4/5 (80%) | 951k | 1535k | 414k | 14 / 0 |
| worktree_reuse | 5/5 (100%) | 3/5 (60%) | 5/5 (100%) | 125k | 1346k | 74k | 4 / 0 |

Per model, pooled over the scenarios: completion, per-rep total cost (sum over scenarios of one rep index) mean and spread (max − min), and the §4.5 Fisher power at n = 48 a side (α 0.05/3, first Holm step) for a completion drop from the observed rate.

| model | completed | mean cost per rep | spread | power: drop −0.3 at n 48 | MDE at 80%, n 48 |
|---|---|---|---|---|---|
| claude-haiku-5-5 | 91/115 (79%) | 6947k | 658k | 0.79 | 0.79 → 0.48 |
| gemini-3.8-flash | 53/115 (46%) | 21953k | 3043k | 0.83 | 0.46 → 0.16 |
| claude-sonnet-5-5 | 96/115 (83%) | 2749k | 399k | 0.82 | 0.83 → 0.54 |

<details><summary>Raw <code>tournament plan &lt;g&gt; --b5 probe.jsonl --b5-cold cold.jsonl</code> output, all six groups</summary>

```
### c2_close
close_preview_apply own: paraphrases 14 m 42 r 5 n_eff 56 pooled 114 MDE 0.74 SHORT: add 4
close_preview_conflict own: paraphrases 14 m 42 r 8 n_eff 54 pooled 158 MDE 0.71 SHORT: add 4
wait_result_read cross: paraphrases 14 m 42 r 1 n_eff 42 MDE 0.37 SHORT: add 4
wait_heartbeat_merge cross: paraphrases 10 m 30 r 2 n_eff 46 MDE 0.39
wait_shell_limit cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
notes_report_read cross: paraphrases 10 m 30 r 2 n_eff 44 MDE 0.38
notes_multi cross: paraphrases 10 m 20 r 6 n_eff 42 MDE 0.37
agent_read_text cross: paraphrases 14 m 28 r 3 n_eff 36 MDE 0.33 SHORT: add 4
delegate_no_verdict cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
close_already_closed cross: paraphrases 10 m 30 r 2 n_eff 49 MDE 0.4
sleep_poll cross: paraphrases 10 m 30 r 2 n_eff 47 MDE 0.39
sql_name_guess guard: paraphrases 13 m 26 r 4 n_eff 41 MDE 0.36
finding_guess guard: paraphrases 6 m 18 r 4 n_eff 43 MDE 0.37
CMH power per model (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.96, 0.8→0.75 0.46
r1 (12 variants + base): 2340 rows, about 0.8 h
r2 (6 variants + base): 22680 rows, about 12.5 h
### c1_wait
close_preview_apply cross: paraphrases 12 m 36 r 2 n_eff 43 MDE 0.37
close_preview_conflict cross: paraphrases 13 m 39 r 2 n_eff 45 MDE 0.38
wait_result_read own: paraphrases 14 m 42 r 1 n_eff 42 pooled 48 MDE 0.86 SHORT: add 4
wait_heartbeat_merge own: paraphrases 10 m 30 r 4 n_eff 62 pooled 92 MDE 0.77
wait_shell_limit own: paraphrases 10 m 30 r 3 n_eff 75 pooled 120 MDE 0.74
notes_report_read cross: paraphrases 10 m 30 r 2 n_eff 44 MDE 0.38
notes_multi cross: paraphrases 10 m 20 r 6 n_eff 42 MDE 0.37
agent_read_text cross: paraphrases 14 m 28 r 3 n_eff 36 MDE 0.33 SHORT: add 4
delegate_no_verdict cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
close_already_closed cross: paraphrases 10 m 30 r 2 n_eff 49 MDE 0.4
sleep_poll cross: paraphrases 10 m 30 r 2 n_eff 47 MDE 0.39
sql_name_guess guard: paraphrases 13 m 26 r 4 n_eff 41 MDE 0.36
finding_guess guard: paraphrases 6 m 18 r 4 n_eff 43 MDE 0.37
CMH power per model (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.97, 0.8→0.75 0.46
r1 (12 variants + base): 3510 rows, about 7.2 h
r2 (6 variants + base): 18900 rows, about 16.2 h
### c3_notes
close_preview_apply cross: paraphrases 12 m 36 r 2 n_eff 43 MDE 0.37
close_preview_conflict cross: paraphrases 13 m 39 r 2 n_eff 45 MDE 0.38
wait_result_read cross: paraphrases 14 m 42 r 1 n_eff 42 MDE 0.37 SHORT: add 4
wait_heartbeat_merge cross: paraphrases 10 m 30 r 2 n_eff 46 MDE 0.39
wait_shell_limit cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
notes_report_read own: paraphrases 10 m 30 r 5 n_eff 62 pooled 158 MDE 0.71
notes_multi own: paraphrases 14 m 28 r 11 n_eff 65 pooled 144 MDE 0.72 SHORT: add 4
agent_read_text cross: paraphrases 14 m 28 r 3 n_eff 36 MDE 0.33 SHORT: add 4
delegate_no_verdict cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
close_already_closed cross: paraphrases 10 m 30 r 2 n_eff 49 MDE 0.4
sleep_poll cross: paraphrases 10 m 30 r 2 n_eff 47 MDE 0.39
sql_name_guess guard: paraphrases 13 m 26 r 4 n_eff 41 MDE 0.36
finding_guess guard: paraphrases 6 m 18 r 4 n_eff 43 MDE 0.37
CMH power per model (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.97, 0.8→0.75 0.49
r1 (12 variants + base): 1950 rows, about 0.7 h
r2 (6 variants + base): 21000 rows, about 11.7 h
### c4_read
close_preview_apply cross: paraphrases 12 m 36 r 2 n_eff 43 MDE 0.37
close_preview_conflict cross: paraphrases 13 m 39 r 2 n_eff 45 MDE 0.38
wait_result_read cross: paraphrases 14 m 42 r 1 n_eff 42 MDE 0.37 SHORT: add 4
wait_heartbeat_merge cross: paraphrases 10 m 30 r 2 n_eff 46 MDE 0.39
wait_shell_limit cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
notes_report_read cross: paraphrases 10 m 30 r 2 n_eff 44 MDE 0.38
notes_multi cross: paraphrases 10 m 20 r 6 n_eff 42 MDE 0.37
agent_read_text own: paraphrases 14 m 28 r 12 n_eff 41 pooled 156 MDE 0.71 SHORT: add 4
delegate_no_verdict cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
close_already_closed cross: paraphrases 10 m 30 r 2 n_eff 49 MDE 0.4
sleep_poll cross: paraphrases 10 m 30 r 2 n_eff 47 MDE 0.39
sql_name_guess guard: paraphrases 13 m 26 r 4 n_eff 41 MDE 0.36
finding_guess guard: paraphrases 6 m 18 r 4 n_eff 43 MDE 0.37
CMH power per model (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.96, 0.8→0.75 0.44
r1 (12 variants + base): 780 rows, about 0.3 h
r2 (6 variants + base): 20790 rows, about 11.7 h
### c5_outcome
close_preview_apply cross: paraphrases 12 m 36 r 2 n_eff 43 MDE 0.37
close_preview_conflict cross: paraphrases 13 m 39 r 2 n_eff 45 MDE 0.38
wait_result_read cross: paraphrases 14 m 42 r 1 n_eff 42 MDE 0.37 SHORT: add 4
wait_heartbeat_merge cross: paraphrases 10 m 30 r 2 n_eff 46 MDE 0.39
wait_shell_limit cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
notes_report_read cross: paraphrases 10 m 30 r 2 n_eff 44 MDE 0.38
notes_multi cross: paraphrases 10 m 20 r 6 n_eff 42 MDE 0.37
agent_read_text cross: paraphrases 14 m 28 r 3 n_eff 36 MDE 0.33 SHORT: add 4
delegate_no_verdict own: paraphrases 10 m 30 r 3 n_eff 75 pooled 120 MDE 0.74
close_already_closed own: paraphrases 10 m 30 r 3 n_eff 63 pooled 120 MDE 0.74
sleep_poll cross: paraphrases 10 m 30 r 2 n_eff 47 MDE 0.39
sql_name_guess guard: paraphrases 13 m 26 r 4 n_eff 41 MDE 0.36
finding_guess guard: paraphrases 6 m 18 r 4 n_eff 43 MDE 0.37
CMH power per model (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.97, 0.8→0.75 0.46
r1 (12 variants + base): 2340 rows, about 0.8 h
r2 (6 variants + base): 18270 rows, about 11.6 h
### c6_skill
close_preview_apply cross: paraphrases 12 m 36 r 2 n_eff 43 MDE 0.37
close_preview_conflict cross: paraphrases 13 m 39 r 2 n_eff 45 MDE 0.38
wait_result_read cross: paraphrases 14 m 42 r 1 n_eff 42 MDE 0.37 SHORT: add 4
wait_heartbeat_merge cross: paraphrases 10 m 30 r 2 n_eff 46 MDE 0.39
wait_shell_limit cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
notes_report_read cross: paraphrases 10 m 30 r 2 n_eff 44 MDE 0.38
notes_multi cross: paraphrases 10 m 20 r 6 n_eff 42 MDE 0.37
agent_read_text cross: paraphrases 14 m 28 r 3 n_eff 36 MDE 0.33 SHORT: add 4
delegate_no_verdict cross: paraphrases 10 m 30 r 2 n_eff 55 MDE 0.43
close_already_closed cross: paraphrases 10 m 30 r 2 n_eff 49 MDE 0.4
sleep_poll own: paraphrases 10 m 30 r 4 n_eff 65 pooled 99 MDE 0.76
sql_name_guess guard: paraphrases 13 m 26 r 4 n_eff 41 MDE 0.36
finding_guess guard: paraphrases 6 m 18 r 4 n_eff 43 MDE 0.37
CMH power per model (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.97, 0.8→0.75 0.46
r1 (12 variants + base): 1170 rows, about 1.5 h
r2 (6 variants + base): 18270 rows, about 12.9 h
```

</details>

## Readout: `nextstep report`

- file: /Users/mtrojer/.local/state/mu-next/eval-transcripts/hill-r2/b5/probe.jsonl
- sha256: f124ef5e79af37e68aeabcb2d5f336cd690ca7b63119fc6a09786789dc14d859
- rows: 4080
- rounds: b5
- surfaces: base
- models: claude-haiku-5-5, claude-sonnet-5-5, gemini-3.8-flash
- systemSha: 0057960151c0

Cells: hits/n (p partial, i invalid, k killed, e modelError).

### b5 / base

| case | arm | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|---|
| agent_read_text | none | 25/40 (p7 i0 k0 e0) | 6/40 (p2 i0 k0 e0) | 1/40 (p2 i0 k0 e0) |
| agent_read_text | skill | 25/40 (p6 i0 k0 e0) | 3/40 (p3 i0 k0 e0) | 2/40 (p1 i0 k0 e0) |
| close_already_closed | none | 1/40 (p0 i0 k0 e0) | 4/40 (p0 i0 k0 e0) | 0/40 (p0 i0 k0 e0) |
| close_already_closed | recipe:orchestrator-loop | 2/40 (p0 i0 k0 e0) | 0/40 (p0 i0 k0 e0) | 1/40 (p0 i0 k0 e0) |
| close_already_closed | skill | 0/40 (p0 i0 k0 e0) | 1/40 (p0 i0 k0 e0) | 0/40 (p0 i0 k0 e0) |
| close_preview_apply | none | 18/40 (p0 i0 k0 e0) | 33/40 (p0 i0 k0 e0) | 34/40 (p0 i0 k0 e0) |
| close_preview_apply | recipe:merge | 23/40 (p0 i0 k0 e0) | 25/40 (p0 i0 k0 e0) | 35/40 (p0 i0 k0 e0) |
| close_preview_apply | skill | 19/40 (p0 i0 k0 e0) | 14/40 (p0 i0 k0 e0) | 38/40 (p0 i0 k0 e0) |
| close_preview_conflict | none | 1/40 (p0 i0 k0 e0) | 9/40 (p0 i0 k0 e0) | 0/40 (p0 i0 k0 e0) |
| close_preview_conflict | recipe:merge | 7/40 (p1 i0 k0 e0) | 9/40 (p0 i0 k0 e0) | 11/40 (p1 i0 k0 e0) |
| close_preview_conflict | skill | 0/40 (p0 i0 k0 e0) | 0/40 (p0 i0 k0 e0) | 0/40 (p0 i0 k0 e0) |
| delegate_no_verdict | none | 0/40 (p0 i0 k0 e0) | 0/40 (p9 i0 k0 e0) | 0/40 (p0 i0 k0 e0) |
| delegate_no_verdict | recipe:adversarial-review | 0/40 (p22 i0 k0 e0) | 0/40 (p13 i0 k0 e0) | 0/40 (p27 i0 k0 e0) |
| delegate_no_verdict | skill | 0/40 (p27 i0 k0 e0) | 0/40 (p10 i0 k0 e0) | 0/40 (p26 i0 k0 e0) |
| finding_guess | none | 24/24 (p0 i0 k0 e0) | 24/24 (p0 i0 k0 e0) | 24/24 (p0 i0 k0 e0) |
| finding_guess | recipe:findings | 24/24 (p0 i0 k0 e0) | 24/24 (p0 i0 k0 e0) | 24/24 (p0 i0 k0 e0) |
| finding_guess | skill | 19/24 (p0 i0 k0 e0) | 24/24 (p0 i0 k0 e0) | 24/24 (p0 i0 k0 e0) |
| notes_multi | none | 40/40 (p0 i0 k0 e0) | 40/40 (p0 i0 k0 e0) | 35/40 (p0 i0 k0 e0) |
| notes_multi | skill | 40/40 (p0 i0 k0 e0) | 39/40 (p0 i0 k0 e0) | 40/40 (p0 i0 k0 e0) |
| notes_report_read | none | 19/40 (p5 i0 k0 e0) | 4/40 (p1 i0 k0 e0) | 32/40 (p3 i0 k0 e0) |
| notes_report_read | recipe:tasks-or-calls | 23/40 (p3 i0 k0 e0) | 11/40 (p1 i0 k0 e0) | 35/40 (p0 i0 k0 e0) |
| notes_report_read | skill | 15/40 (p1 i0 k0 e0) | 8/40 (p0 i0 k0 e0) | 30/40 (p3 i0 k0 e0) |
| sleep_poll | none | 24/40 (p24 i0 k0 e0) | 2/40 (p2 i0 k0 e0) | 32/40 (p32 i0 k0 e0) |
| sleep_poll | recipe:orchestrator-loop | 12/40 (p12 i0 k0 e0) | 13/40 (p13 i0 k0 e0) | 20/40 (p20 i0 k0 e0) |
| sleep_poll | skill | 12/40 (p12 i0 k0 e0) | 0/40 (p0 i0 k0 e0) | 27/40 (p27 i0 k0 e0) |
| sql_name_guess | none | 7/24 (p0 i0 k0 e0) | 0/24 (p0 i0 k0 e0) | 8/24 (p0 i0 k0 e0) |
| sql_name_guess | skill | 13/24 (p0 i0 k0 e0) | 5/24 (p0 i0 k0 e0) | 12/24 (p0 i0 k0 e0) |
| wait_heartbeat_merge | none | 2/40 (p36 i0 k0 e0) | 1/40 (p39 i0 k0 e0) | 0/40 (p21 i0 k0 e0) |
| wait_heartbeat_merge | recipe:orchestrator-loop | 1/40 (p39 i0 k0 e0) | 1/40 (p38 i0 k0 e0) | 0/40 (p40 i0 k0 e0) |
| wait_heartbeat_merge | skill | 3/40 (p31 i0 k0 e0) | 0/40 (p38 i0 k0 e0) | 1/40 (p38 i0 k0 e0) |
| wait_result_read | none | 3/40 (p0 i0 k0 e0) | 1/40 (p0 i0 k0 e0) | 1/40 (p1 i0 k0 e0) |
| wait_result_read | recipe:orchestrator-loop | 40/40 (p0 i0 k0 e0) | 25/40 (p0 i0 k0 e0) | 39/40 (p0 i0 k0 e0) |
| wait_result_read | skill | 1/40 (p0 i0 k0 e0) | 1/40 (p0 i0 k0 e0) | 11/40 (p1 i0 k0 e0) |
| wait_shell_limit | none | 0/40 (p32 i0 k7 e0) | 0/40 (p40 i0 k0 e0) | 0/40 (p5 i0 k35 e0) |
| wait_shell_limit | recipe:orchestrator-loop | 0/40 (p24 i0 k16 e0) | 0/40 (p40 i0 k0 e0) | 0/40 (p10 i0 k30 e0) |
| wait_shell_limit | skill | 0/40 (p34 i0 k6 e0) | 0/40 (p40 i0 k0 e0) | 0/40 (p14 i0 k26 e0) |

### By paraphrase

<details><summary>agent_read_text</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 1/8 | 0/8 | 0/8 |
| p10 | 7/8 | 2/8 | 0/8 |
| p2 | 8/8 | 0/8 | 0/8 |
| p3 | 8/8 | 0/8 | 0/8 |
| p4 | 6/8 | 0/8 | 0/8 |
| p5 | 8/8 | 4/8 | 3/8 |
| p6 | 1/8 | 0/8 | 0/8 |
| p7 | 8/8 | 0/8 | 0/8 |
| p8 | 2/8 | 0/8 | 0/8 |
| p9 | 1/8 | 3/8 | 0/8 |

</details>

<details><summary>close_already_closed</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 0/12 | 1/12 | 0/12 |
| p10 | 0/12 | 3/12 | 0/12 |
| p2 | 0/12 | 0/12 | 0/12 |
| p3 | 0/12 | 0/12 | 0/12 |
| p4 | 0/12 | 0/12 | 0/12 |
| p5 | 2/12 | 1/12 | 0/12 |
| p6 | 1/12 | 0/12 | 1/12 |
| p7 | 0/12 | 0/12 | 0/12 |
| p8 | 0/12 | 0/12 | 0/12 |
| p9 | 0/12 | 0/12 | 0/12 |

</details>

<details><summary>close_preview_apply</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 6/12 | 12/12 | 12/12 |
| p10 | 1/12 | 4/12 | 2/12 |
| p2 | 0/12 | 5/12 | 12/12 |
| p3 | 9/12 | 10/12 | 12/12 |
| p4 | 0/12 | 3/12 | 12/12 |
| p5 | 10/12 | 8/12 | 12/12 |
| p6 | 12/12 | 8/12 | 12/12 |
| p7 | 12/12 | 11/12 | 12/12 |
| p8 | 8/12 | 8/12 | 12/12 |
| p9 | 2/12 | 3/12 | 9/12 |

</details>

<details><summary>close_preview_conflict</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 0/12 | 0/12 | 1/12 |
| p10 | 0/12 | 0/12 | 1/12 |
| p2 | 0/12 | 0/12 | 1/12 |
| p3 | 2/12 | 0/12 | 2/12 |
| p4 | 0/12 | 0/12 | 0/12 |
| p5 | 2/12 | 5/12 | 2/12 |
| p6 | 0/12 | 1/12 | 1/12 |
| p7 | 2/12 | 7/12 | 2/12 |
| p8 | 0/12 | 0/12 | 0/12 |
| p9 | 2/12 | 5/12 | 1/12 |

</details>

<details><summary>delegate_no_verdict</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 0/12 | 0/12 | 0/12 |
| p10 | 0/12 | 0/12 | 0/12 |
| p2 | 0/12 | 0/12 | 0/12 |
| p3 | 0/12 | 0/12 | 0/12 |
| p4 | 0/12 | 0/12 | 0/12 |
| p5 | 0/12 | 0/12 | 0/12 |
| p6 | 0/12 | 0/12 | 0/12 |
| p7 | 0/12 | 0/12 | 0/12 |
| p8 | 0/12 | 0/12 | 0/12 |
| p9 | 0/12 | 0/12 | 0/12 |

</details>

<details><summary>finding_guess</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 12/12 | 12/12 | 12/12 |
| p2 | 11/12 | 12/12 | 12/12 |
| p3 | 10/12 | 12/12 | 12/12 |
| p4 | 12/12 | 12/12 | 12/12 |
| p5 | 10/12 | 12/12 | 12/12 |
| p6 | 12/12 | 12/12 | 12/12 |

</details>

<details><summary>notes_multi</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 8/8 | 8/8 | 8/8 |
| p10 | 8/8 | 8/8 | 7/8 |
| p2 | 8/8 | 8/8 | 8/8 |
| p3 | 8/8 | 8/8 | 8/8 |
| p4 | 8/8 | 8/8 | 5/8 |
| p5 | 8/8 | 8/8 | 8/8 |
| p6 | 8/8 | 8/8 | 8/8 |
| p7 | 8/8 | 8/8 | 7/8 |
| p8 | 8/8 | 8/8 | 8/8 |
| p9 | 8/8 | 7/8 | 8/8 |

</details>

<details><summary>notes_report_read</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 8/12 | 2/12 | 9/12 |
| p10 | 7/12 | 4/12 | 12/12 |
| p2 | 0/12 | 0/12 | 11/12 |
| p3 | 8/12 | 2/12 | 11/12 |
| p4 | 9/12 | 5/12 | 10/12 |
| p5 | 0/12 | 0/12 | 10/12 |
| p6 | 0/12 | 3/12 | 11/12 |
| p7 | 6/12 | 3/12 | 8/12 |
| p8 | 9/12 | 2/12 | 10/12 |
| p9 | 10/12 | 2/12 | 5/12 |

</details>

<details><summary>sleep_poll</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 5/12 | 2/12 | 12/12 |
| p10 | 3/12 | 2/12 | 9/12 |
| p2 | 4/12 | 1/12 | 8/12 |
| p3 | 6/12 | 2/12 | 10/12 |
| p4 | 1/12 | 2/12 | 5/12 |
| p5 | 9/12 | 0/12 | 10/12 |
| p6 | 7/12 | 0/12 | 6/12 |
| p7 | 5/12 | 1/12 | 6/12 |
| p8 | 3/12 | 3/12 | 5/12 |
| p9 | 5/12 | 2/12 | 8/12 |

</details>

<details><summary>sql_name_guess</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 4/8 | 3/8 | 2/8 |
| p2 | 5/8 | 2/8 | 3/8 |
| p3 | 7/8 | 0/8 | 1/8 |
| p4 | 0/8 | 0/8 | 5/8 |
| p5 | 2/8 | 0/8 | 2/8 |
| p6 | 2/8 | 0/8 | 7/8 |

</details>

<details><summary>wait_heartbeat_merge</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 0/12 | 0/12 | 0/12 |
| p10 | 0/12 | 0/12 | 0/12 |
| p2 | 0/12 | 0/12 | 0/12 |
| p3 | 0/12 | 0/12 | 0/12 |
| p4 | 5/12 | 0/12 | 1/12 |
| p5 | 0/12 | 0/12 | 0/12 |
| p6 | 0/12 | 0/12 | 0/12 |
| p7 | 1/12 | 2/12 | 0/12 |
| p8 | 0/12 | 0/12 | 0/12 |
| p9 | 0/12 | 0/12 | 0/12 |

</details>

<details><summary>wait_result_read</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 4/12 | 3/12 | 4/12 |
| p10 | 6/12 | 0/12 | 5/12 |
| p2 | 4/12 | 4/12 | 7/12 |
| p3 | 4/12 | 2/12 | 5/12 |
| p4 | 5/12 | 5/12 | 6/12 |
| p5 | 4/12 | 4/12 | 5/12 |
| p6 | 4/12 | 1/12 | 4/12 |
| p7 | 5/12 | 3/12 | 4/12 |
| p8 | 4/12 | 2/12 | 5/12 |
| p9 | 4/12 | 3/12 | 6/12 |

</details>

<details><summary>wait_shell_limit</summary>

| paraphrase | claude-haiku-5-5 | claude-sonnet-5-5 | gemini-3.8-flash |
|---|---|---|---|
| p1 | 0/12 | 0/12 | 0/12 |
| p10 | 0/12 | 0/12 | 0/12 |
| p2 | 0/12 | 0/12 | 0/12 |
| p3 | 0/12 | 0/12 | 0/12 |
| p4 | 0/12 | 0/12 | 0/12 |
| p5 | 0/12 | 0/12 | 0/12 |
| p6 | 0/12 | 0/12 | 0/12 |
| p7 | 0/12 | 0/12 | 0/12 |
| p8 | 0/12 | 0/12 | 0/12 |
| p9 | 0/12 | 0/12 | 0/12 |

</details>

### Per model

| model | rows | mean tokens | mean row ms |
|---|---|---|---|
| claude-haiku-5-5 | 1360 | 2671 | 49391 |
| claude-sonnet-5-5 | 1360 | 2721 | 43353 |
| gemini-3.8-flash | 1360 | 5235 | 72647 |


## Readout: `cold-guess report`

### Method (from the rows)

300 guesses; builds: base = mu 4.5.0+9bc4c6e (help fcb85a224ad7); models: claude-haiku-5-5, gemini-3.8-flash, claude-sonnet-5-5; 4 reps. The model got only the bundled help (`mu --help` plus `mu <group> --help` of every group, the same depth on every surface; no skill, no tools) and one sentence; its single command ran in a fresh seeded sandbox. **Hit** = the state or the command's own output shows the effect, with no stray write (judged by state, never spelling). **Partial** = a miss that was the right first step (a close preview whose `--if` apply was not run).

### Intents

| Intent | Group | Request (verbatim) |
| --- | --- | --- |
| owner_of | tasks | Which worker is assigned t3 in the initiative called auth? |
| task_brief | tasks | Print the original instructions that t3 in the initiative called auth was handed. |
| blocked_by_t1 | tasks | Which unfinished items in the initiative called auth are held up by t1? |
| close_with_evidence | tasks | Declare t4 in the initiative called auth complete; the proof is: gate green: npm test exit 0. |
| spawn_remote | host | Launch a worker for t5 (initiative called auth) on the other machine dev, so that it works there. |
| spawn_remote_named | host | Launch a worker called worker-1 for t5 (initiative called auth) on the other machine dev, so that it works there. |
| collect_commits | host | Bring worker-2's unmerged work from machine dev into the git repository here; the worker belongs to the initiative called auth. |
| log_tail | log | Print the 20 newest entries of the initiative called auth's journal. |
| needs_human | state | Is anything in the initiative called auth awaiting a person's decision? |
| add_three | tasks | Create three items in the initiative called auth: n1, n2 and n3, with n2 required before n3. |
| add_three_titled | tasks | Create three items in the initiative called auth: n1 headed parse, n2 headed index, n3 headed ship, with n2 required before n3. |
| reopen | tasks | Make t6 in the initiative called auth workable again; it was declared complete by mistake. |
| delegates_wave | delegates | Which helper calls in the initiative called auth were sent out in batch w1? |
| sql_read | db | Execute this statement against mu's database: SELECT local_id, title FROM tasks WHERE impact = 77 |
| stop_worker | agents | Retire worker-3 in the initiative called auth safely: it has work that is not merged yet. |
| worker_doing | agents | What is worker-1 doing right now (initiative called auth)? |
| list_workstreams | workstream | Which separate initiatives does mu currently track? |
| check_record | tasks | Ask a claude reviewer for an independent second opinion on t4 in the initiative called auth, and have mu track that request. |
| verdict_record | tasks | The claude reviewer asked to re-examine t4 (initiative called auth) came back with: VERDICT: CONFIRMED - the four fixes hold. Store that result on the pending request. |
| wave_outcome | delegates | How did the helper calls of batch w1 in the initiative called auth turn out? Give each one's tag and result. |
| host_list | host | Which other machines can mu reach, and how is each one set up? |
| lease_show | host | On machine dev, which worker currently occupies a connection slot (initiative called auth)? |
| notes_two | tasks | Print the remarks left on t1 and on t2 in the initiative called auth. |
| close_apply_clean | agents | worker-3 in the initiative called auth has finished and its work is already on main; retire it and tidy up behind it. |
| report_only | delegates | Print only the findings that helper delegate_rev_d0bf343a (initiative called auth) came back with, not the instructions it was given. |

### Headline: the 23 pre-registered intents every surface ran

| Surface | Model | Hit (23 intents) | Parsed | Exit 0 | Destructive | Stray ops | Mean tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| base | claude-haiku-5-5 | 64% (59/92) | 100% (92/92) | 76% (70/92) | 0 | 0 | 8493 |
| base | gemini-3.8-flash | 73% (67/92) | 100% (92/92) | 87% (80/92) | 0 | 0 | 9501 |
| base | claude-sonnet-5-5 | 73% (67/92) | 100% (92/92) | 91% (84/92) | 0 | 0 | 8242 |
| base | both | 70% (193/276) | 100% (276/276) | 85% (234/276) | 0 | 0 | 8745 |

### Controls (added after the first pass; not in the headline)

| Control | base hit |
| --- | --- |
| spawn_remote_named | 92% (11/12) |
| add_three_titled | 100% (12/12) |

### Hit rate per intent

Each cell: hits/guesses over both models and all reps; then the modal first reach of the misses. `-` = the surface has no way to do it.

| Intent | Group | Role | base hit | base modal miss |
| --- | --- | --- | --- | --- |
| owner_of | tasks | headline | 100% (12/12) |  |
| task_brief | tasks | headline | 100% (12/12) |  |
| blocked_by_t1 | tasks | headline | 100% (12/12) |  |
| close_with_evidence | tasks | headline | 75% (9/12) | complete --evidence (3/3) |
| spawn_remote | host | headline | 83% (10/12) | task claim --for --host (1/2) |
| spawn_remote_named | host | control | 92% (11/12) | task claim --for --host (1/1) |
| collect_commits | host | headline | 100% (12/12) |  |
| log_tail | log | headline | 100% (12/12) |  |
| needs_human | state | headline | 100% (12/12) |  |
| add_three | tasks | headline | 100% (12/12) |  |
| add_three_titled | tasks | control | 100% (12/12) |  |
| reopen | tasks | headline | 100% (12/12) |  |
| delegates_wave | delegates | headline | 50% (6/12) | delegates list --all (4/6) |
| sql_read | db | headline | 100% (12/12) |  |
| stop_worker | agents | headline | 0% (0/12) +12 partial | agent close (12/12) |
| worker_doing | agents | headline | 100% (12/12) |  |
| list_workstreams | workstream | headline | 100% (12/12) |  |
| check_record | tasks | headline | 0% (0/12) | task check (10/12) |
| verdict_record | tasks | headline | 0% (0/12) | task verdict - (7/12) |
| wave_outcome | delegates | headline | 0% (0/12) | delegates tally --wave (8/12) |
| host_list | host | headline | 100% (12/12) |  |
| lease_show | host | headline | 100% (12/12) |  |
| notes_two | tasks | headline | 100% (12/12) |  |
| close_apply_clean | agents | headline | 0% (0/12) +9 partial | agent close (11/12) |
| report_only | delegates | headline | 0% (0/12) | task notes --tail (5/12) |

### Hit rate per intent and model

| Intent | base claude-haiku-5-5 | base gemini-3.8-flash | base claude-sonnet-5-5 |
| --- | --- | --- | --- |
| owner_of | 4/4 | 4/4 | 4/4 |
| task_brief | 4/4 | 4/4 | 4/4 |
| blocked_by_t1 | 4/4 | 4/4 | 4/4 |
| close_with_evidence | 1/4 | 4/4 | 4/4 |
| spawn_remote | 2/4 | 4/4 | 4/4 |
| spawn_remote_named | 3/4 | 4/4 | 4/4 |
| collect_commits | 4/4 | 4/4 | 4/4 |
| log_tail | 4/4 | 4/4 | 4/4 |
| needs_human | 4/4 | 4/4 | 4/4 |
| add_three | 4/4 | 4/4 | 4/4 |
| add_three_titled | 4/4 | 4/4 | 4/4 |
| reopen | 4/4 | 4/4 | 4/4 |
| delegates_wave | 0/4 | 3/4 | 3/4 |
| sql_read | 4/4 | 4/4 | 4/4 |
| stop_worker | 0/4 | 0/4 | 0/4 |
| worker_doing | 4/4 | 4/4 | 4/4 |
| list_workstreams | 4/4 | 4/4 | 4/4 |
| check_record | 0/4 | 0/4 | 0/4 |
| verdict_record | 0/4 | 0/4 | 0/4 |
| wave_outcome | 0/4 | 0/4 | 0/4 |
| host_list | 4/4 | 4/4 | 4/4 |
| lease_show | 4/4 | 4/4 | 4/4 |
| notes_two | 4/4 | 4/4 | 4/4 |
| close_apply_clean | 0/4 | 0/4 | 0/4 |
| report_only | 0/4 | 0/4 | 0/4 |

### Hit rate per verb group (headline intents)

| Group | base hit |
| --- | --- |
| tasks | 75% (81/108) |
| host | 96% (46/48) |
| log | 100% (12/12) |
| state | 100% (12/12) |
| delegates | 17% (6/36) |
| db | 100% (12/12) |
| agents | 33% (12/36) |
| workstream | 100% (12/12) |

### First verb reached (all guesses)

| Intent | base first reach (count) |
| --- | --- |
| owner_of | task show ×12 |
| task_brief | task notes ×6; task show --note ×3; task show --all ×2 |
| blocked_by_t1 | task tree --down ×12 |
| close_with_evidence | task close --evidence ×6; complete --evidence ×3; task close --as --evidence ×2 |
| spawn_remote | agent spawn --host --task ×5; agent spawn --host ×5; task claim --for --host ×1 |
| spawn_remote_named | agent spawn --host --task ×11; task claim --for --host ×1 |
| collect_commits | agent collect ×12 |
| log_tail | log -n ×11; log ×1 |
| needs_human | state ×12 |
| add_three | task add -t ×12 |
| add_three_titled | task add -t ×12 |
| reopen | task open ×12 |
| delegates_wave | delegates list --all ×4; delegates list --all --wave ×3; delegates list --wave ×3 |
| sql_read | sql [tasks] ×12 |
| stop_worker | agent close ×12 |
| worker_doing | agent show ×12 |
| list_workstreams | workstream list ×12 |
| check_record | task check ×10; task check --reviewer ×2 |
| verdict_record | task verdict - ×7; task verdict ×3; state ×1 |
| wave_outcome | delegates tally --wave ×8; delegates tally ×3; delegates list --all ×1 |
| host_list | host list ×12 |
| lease_show | host show ×12 |
| notes_two | task notes ×12 |
| close_apply_clean | agent close ×11; agent close --if ×1 |
| report_only | task notes --tail ×5; task show --note ×4; delegates show ×3 |

### Top wrong guesses

#### base

| × | Intent · first reach | Example command | Why it missed | First error line |
| --- | --- | --- | --- | --- |
| 12 | stop_worker · agent close | `mu -w auth agent close worker-3` | worker-3 still registered |  |
| 11 | close_apply_clean · agent close | `rev=$(mu -w auth --json agent close worker-3 \| jq -r '.rev') && mu -w auth agent close worker-3 --if "$rev"` | worker-3 still registered | error: option '--if <rev>' argument 'null' is invalid. expected a non-negative integer, got "null" |
| 10 | check_record · task check | `mu -w auth task check t4` | no check recorded on t4 | error: check needs --by <harness> or --by <harness>/<model> |
| 8 | wave_outcome · delegates tally --wave | `mu -w auth delegates tally --wave w1 --json` | output lacks review-t4 |  |
| 7 | verdict_record · task verdict - | `mu -w auth task verdict t4 - <<'EOF'` | t4's check carries no CONFIRMED verdict | error: verdict needs --check <check id> |
| 5 | report_only · task notes --tail | `mu -w auth task notes delegate_rev_d0bf343a --tail 1` | output lacks RPT-MARK-2291 |  |
| 4 | delegates_wave · delegates list --all | `mu --json -w auth delegates list --all` | output has dg-b1 |  |
| 4 | report_only · task show --note | `mu -w auth task show delegate_rev_d0bf343a --note report` | exit 2 | error: option '--note <n>' argument 'report' is invalid. expected a positive number, got "report" |
| 3 | close_with_evidence · complete --evidence | `mu -w "auth complete" task close t4 --evidence "gate green: npm test exit 0"` | t4 is OPEN/todo | error: -w/--workstream got "auth complete": a workstream name has no whitespace, ',' or '/'. |
| 3 | verdict_record · task verdict | `mu task verdict t4 -w auth "VERDICT: t4 CONFIRMED the four fixes hold"` | t4's check carries no CONFIRMED verdict | error: verdict needs --check <check id> |
| 3 | wave_outcome · delegates tally | `mu --json -w auth delegates tally` | exit 2 | {"ok":false,"error":"CommanderError","message":"required option '--wave <label>' not specified","next":null,"exit":2,"usage":["mu delegates tally [options]","op |
| 3 | report_only · delegates show | `mu delegates show delegate_rev_d0bf343a` | exit 3 | not found: no such delegate call: delegate_rev_d0bf343a |

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
