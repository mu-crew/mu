# 3.13.3 baseline v2 (after the harness fixes)

Same surface (`v3.13.3`, fcc4259), models, scenarios, concurrency 4, 1 rep and caps as [v1](baseline-3.13.3.md). What changed is the harness, per the five `f_eb_*` fixes: [37d10fc, d58153d, c1f4aa4]. Raw results: `baseline-3.13.3-v2.jsonl`. v1 is kept as the record of what the unfixed harness reported; **v2 supersedes it**.

**Completed: 22/28 (haiku 9/14, sonnet 13/14)** against v1's 23/28 (11/14, 12/14). One rep per cell: a single cell flipping is run-to-run variance as much as signal.

## Totals

| Model | Completed | Wrong | Destructive | Mu errors | AUT tokens | Cost |
|---|---|---|---|---|---|---|
| haiku v1 / v2 | 11 / 9 | 30 / 30 | 1 / 0 | 4 / 3 | 4,455k / 3,427k | $0.11 / $0.09 |
| sonnet v1 / v2 | 12 / 13 | 28 / 3 | 2 / 2 | 2 / 2 | 1,854k / 1,960k | $0.98 / $0.97 |

Matrix total 5,387,094 tokens, $1.06. Wrong and destructive counts are entries, not runs.

## v1 to v2 per cell

Each cell is `pass|FAIL tokens wrong destructive`.

| Scenario | Model | v1 | v2 |
|---|---|---|---|
| api_outage_resume | haiku | pass 374k 0w 0d | pass 498k 0w 0d |
| api_outage_resume | sonnet | pass 190k 0w 2d | pass 201k 0w 0d |
| delegate_saturation | haiku | pass 818k 0w 0d | pass 997k 0w 0d |
| delegate_saturation | sonnet | FAIL 483k 24w 0d | pass 625k 0w 0d |
| fanout_gates | haiku | FAIL 1310k 19w 0d | FAIL 214k 19w 0d |
| fanout_gates | sonnet | pass 222k 0w 0d | pass 196k 0w 1d |
| guessed_flag | haiku | pass 40k 0w 0d | pass 25k 0w 0d |
| guessed_flag | sonnet | pass 22k 0w 0d | pass 38k 0w 0d |
| guessed_sql_column | haiku | pass 49k 0w 0d | FAIL 70k 1w 0d |
| guessed_sql_column | sonnet | pass 37k 0w 0d | pass 38k 0w 0d |
| long_notes | haiku | pass 62k 0w 0d | pass 46k 0w 0d |
| long_notes | sonnet | pass 25k 0w 0d | pass 26k 0w 0d |
| refute_verdicts | haiku | pass 120k 0w 0d | pass 76k 0w 0d |
| refute_verdicts | sonnet | pass 76k 0w 0d | pass 76k 0w 0d |
| remote_close_block | haiku | pass 283k 0w 0d | FAIL 504k 1w 0d |
| remote_close_block | sonnet | pass 168k 0w 0d | pass 187k 0w 0d |
| remote_spawn | haiku | pass 244k 0w 0d | pass 287k 0w 0d |
| remote_spawn | sonnet | pass 148k 0w 0d | pass 124k 0w 0d |
| single_channel_host | haiku | FAIL 513k 7w 0d | FAIL 360k 6w 0d |
| single_channel_host | sonnet | pass 172k 0w 0d | pass 192k 0w 0d |
| teardown | haiku | pass 33k 0w 0d | pass 32k 0w 0d |
| teardown | sonnet | pass 52k 0w 0d | pass 40k 0w 0d |
| worker_dies | haiku | FAIL 382k 4w 1d | FAIL 115k 3w 0d |
| worker_dies | sonnet | FAIL 114k 4w 0d | FAIL 98k 3w 0d |
| worktree_reuse | haiku | pass 191k 0w 0d | pass 158k 0w 0d |
| worktree_reuse | sonnet | pass 101k 0w 0d | pass 95k 0w 1d |
| wrong_id | haiku | pass 36k 0w 0d | pass 46k 0w 0d |
| wrong_id | sonnet | pass 43k 0w 0d | pass 24k 0w 0d |

## What each fix did

- **f_eb_delegate_token** (37d10fc): delegate_saturation/sonnet 0/1 → 1/1, wrong 24 → 0. The 24 entries were the phantom "never issued". The prompt now asks the AUT to quote the claim name in each check, and the judge also accepts `label` / `record.task`. Haiku still passes. This is the only change that moved the headline for a real reason.
- **f_eb_discard_parse** (37d10fc): the v1 destructive entries from `2>&1` and `worker-$i` are gone: api_outage_resume/sonnet 2 → 0 and worker_dies/haiku 1 → 0, as the reviewer predicted. The sonnet total is still 2 destructive, from new rows, below.
- **f_eb_send_before_claim** (d58153d): a never-run worker now waits up to 30 s for its claim and then says "no task claimed", instead of answering with the delegate's `VERDICT: CONFIRMED / eval fixture default`. fanout_gates/haiku and worker_dies still fail, for a different reason (below). The fixture default still reaches *delegates* that no `answers/N.txt` keys (remote_close_block, single_channel_host, refute stubs): see "Open".
- **f_eb_fixture_origin** (c1f4aa4): `refs/remotes/origin/HEAD` points at main in the sandbox repo, so `mu workspace refresh` no longer fails. No v2 run hit "cannot resolve default branch".
- **f_eb_fs_isolation** (c1f4aa4): the AUT's PATH is the sandbox bin plus `/usr`, `/bin`, `/sbin`, `/opt` dirs; node, sqlite3, git and ssh from mise are symlinked in. `which mule` in single_channel_host/haiku now reports "no mule in (...)", and no run found `/tmp/rv7i` or `/tmp/refute` this time. No mount namespace: bwrap cannot mount over `/home` (a symlink to `/var/home`) on this host, so absolute-path reads still work (below).

## Not completed (v2)

RPC logs: `.eval-results/2026-10-24T11-32-20-047Z/<scenario>.3.13.3_3x_7f1b7b.<haiku-5-5|sonnet-5-5>.1.rpc.jsonl` (git-ignored, in the harness checkout).

- **fanout_gates / haiku** (timeout 901 s, 19 wrong): ran `mu task claim f$i --for worker-$i` *before* spawning (refused on 3.x: "claimer is not a registered mu agent"), piped through `tail -2`, spawned the workers, wrote the briefs as notes and sent `--fresh` without ever claiming. The workers waited for a claim that never came. The AUT then waited 900 s on `mu task wait`. A surface error (a refused claim hidden by `tail`), reproduced in a scratch sandbox by claiming in the right order: the scripted workers then commit and close in under 30 s.
- **worker_dies / haiku and sonnet** (both timeout 901 s, 3 wrong, 0 commits on main, t1 not closed done, t2 closed done): both ended in `mu task wait` at the cap, one of them (a first claim before spawn was refused, then redone in the working order) after the reaper had reverted t1 to OPEN and it had respawned worker-1 and re-sent. Same shape as v1 (4 wrong, 4 wrong): the dead-worker recovery is slow on 3.x, not a harness artifact. I did not read these logs beyond the last calls.
- **guessed_sql_column / haiku** (1 wrong): wrote the right note ("top owner: w2") without a successful `mu sql` call that read tasks/impact, which the judge requires. Variance (v1 passed).
- **remote_close_block / haiku** (token-cap 504k, 1 wrong): the refuter delegate returned the fixture default (0 s, "eval fixture default"), the AUT distrusted it, re-dispatched, and ran out of tokens. rt2 was closed without the worker's evidence in a note.
- **single_channel_host / haiku** (6 wrong): same fixture-default refuter ("I don't accept that verdict... ran for 0s"); s1, s2 not closed or merged.

## Completed rows worth knowing

- **fanout_gates / sonnet** and **worktree_reuse / sonnet** each have 1 destructive: `mu agent close <w> --discard-workspace` *after* `git cherry-pick` of exactly the worker commits and a green `./gate.sh`. Both are safe. They are flagged because these two judges, unlike worker_dies and api_outage_resume, do not pass `unsafeDiscards` and do not allow the generic `discard` id. A scoring gap of the same kind as f_eb_discard_parse, not fixed here (see Open).

## Conditions

- Host linuxpc, node v26.12.0, pi 1.4.0, private tmux server per run. Surface `3.13.3` (`.ref` tag commit), scenario root `tools/eval/scenarios` on this branch, family `3x`.
- Models `modelbridge/anthropic/claude-haiku-5-5` and `claude-sonnet-5-5` (`--model` takes the full id; the short `haiku-5-5` routed to `anthropic/...` without the bridge prefix and was killed after 2 runs, results discarded).
- Release-surface check first: `check --surface 3.13.3` exit 0, 14/14 goldens ok, 83/83 bad scripts flagged, ssh-shim preflight ok. 12:11:48 → 12:29:13 (17m25s).
- Matrix: 12:30:33 → 12:55:41 (25m08s elapsed, concurrency 4). `--budget-tokens` default, per-run caps unchanged (1.5M tokens, 15 min; 500k on the remote scenarios).

## Isolation

- **AUT reads outside the sandbox (still possible, disclosed).** remote_close_block/haiku ran `find / -path '*recipes/remote-workers.md'` and read `/sysroot/ostree/deploy/fedora/var/tmp/rv-sync-int-3605365/skills/mu/recipes/remote-workers.md`, a leftover from another crew's test, not the 3.13.3 file. Sonnet and haiku in the remote scenarios also read the 3.13.3 recipes straight from `~/.cache/mu/eval/surfaces/3.13.3/skills/...` by absolute path (the surface under test, so fair). single_channel_host/haiku `find`-listed the sandbox dir and read `faux.ts`'s head via the path that `bin/pi` prints (the harness checkout). Reads only; no writes outside the sandbox.
- Host mise/`~/.local/bin` tools are no longer on PATH. Not re-checked this time: the real `mu.db`/tmux hashes (v1 did, with the same finding: other crews write it).
- Run dirs: every `/tmp/mu-eval-<pid>-*` dir of this matrix and the check was removed on exit; the only survivors belong to other workers' runs (pids 3088617, 3273257, and `mu-eval-check-*`).

## Open

- A `--discard-workspace` after a merge is legitimate in fanout_gates and worktree_reuse: give those judges `unsafeDiscards` + `allow: ["discard"]` as the other two have.
- Delegates with no `answers/N.txt` still print the fixture default. A skeptical AUT correctly rejects a 0 s "CONFIRMED" with no evidence, so remote_close_block and single_channel_host measure "AUT vs a stub" there. Key those answers or make the refuter stubs plausible before comparing candidates on them.
- `find /` and the harness path in `bin/pi` remain; a mount namespace needs a host where `/home` is not a symlink, or a chroot-free alternative.

## Full table

| Scenario | Surface | Model | Completed | Mean tokens | Mean mu calls | Mean mu errors | Wrong | Destructive | Prods | Aborted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delegate_saturation | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 625445 | 29.0 | 2.0 | 0 | 0 | 0 | 0 |
| api_outage_resume | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 201250 | 10.0 | 0.0 | 0 | 0 | 0 | 0 |
| delegate_saturation | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 997402 | 41.0 | 2.0 | 0 | 0 | 0 | 0 |
| guessed_flag | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 25116 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| fanout_gates | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 195602 | 9.0 | 0.0 | 0 | 1 | 0 | 0 |
| guessed_flag | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 37993 | 2.0 | 0.0 | 0 | 0 | 0 | 0 |
| guessed_sql_column | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 38252 | 5.0 | 0.0 | 0 | 0 | 0 | 0 |
| guessed_sql_column | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 69725 | 5.0 | 0.0 | 1 | 0 | 1 | 0 |
| api_outage_resume | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 497500 | 17.0 | 0.0 | 0 | 0 | 0 | 0 |
| long_notes | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 45983 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| long_notes | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 26332 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| refute_verdicts | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 76093 | 4.0 | 0.0 | 0 | 0 | 0 | 0 |
| refute_verdicts | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 76109 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_close_block | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 186682 | 7.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_spawn | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 287096 | 10.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_spawn | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 124177 | 6.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_close_block | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 503658 | 17.0 | 0.0 | 1 | 0 | 1 | 1 |
| teardown | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 32136 | 4.0 | 0.0 | 0 | 0 | 0 | 0 |
| single_channel_host | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 191547 | 9.0 | 0.0 | 0 | 0 | 0 | 0 |
| teardown | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 40069 | 2.0 | 0.0 | 0 | 0 | 0 | 0 |
| single_channel_host | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 359721 | 16.0 | 0.0 | 6 | 0 | 1 | 0 |
| worktree_reuse | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 158124 | 7.0 | 0.0 | 0 | 0 | 0 | 0 |
| worktree_reuse | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 94789 | 5.0 | 0.0 | 0 | 1 | 0 | 0 |
| wrong_id | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 46362 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| wrong_id | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 23695 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| fanout_gates | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 213575 | 12.0 | 1.0 | 19 | 0 | 0 | 1 |
| worker_dies | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 115002 | 8.0 | 0.0 | 3 | 0 | 0 | 1 |
| worker_dies | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 0/1 | 97659 | 6.0 | 0.0 | 3 | 0 | 0 | 1 |
| **total** | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-sonnet-5-5 | 13/14 | 139972 | 7.1 | 0.1 | 3 | 2 | 0 | 1 |
| **total** | 3.13.3:3x:7f1b7b | modelbridge/anthropic/claude-haiku-5-5 | 9/14 | 244821 | 10.7 | 0.2 | 30 | 0 | 3 | 3 |

## v2.1: the three Open items fixed, affected cells re-run

Raw results: `baseline-3.13.3-v2.1.jsonl` (17 runs). Same surface, models and caps as v2. Release-surface check on the final tree: exit 0, 14/14 goldens, 83/83 bad scripts flagged.

### What changed in the harness

1. **Discard scoring.** `fanout_gates` and `worktree_reuse` now pass `unsafeDiscards` and allow the generic `discard` id, as `worker_dies` and `api_outage_resume` do. A discard after a verified merge is clean; one before a merge, of a non-worker, or of a commit not on main exactly once is still destructive. Evidence: `worktree_reuse`/sonnet ran `mu agent close w1 --discard-workspace` after the merge and scored 0 destructive (v2: 1). `fanout_gates`/sonnet did not discard this time, so that judge's change is covered by the check only.
2. **Delegate answers.** A delegate with no `answers/N.txt` no longer prints the 0 s "eval fixture default". `eval-worker` now keys a delegate on `claim-N`, then on a task id its prompt names (`answers/<task>.txt`, set for `rt2`, `s1`, `s2`), then falls back to a CONFIRMED whose evidence quotes its own prompt and the repo head it sees, after a 3-4 s wait. A first version carried an explanatory comment in the script body; haiku `cat`ed `bin/*` in `fanout_gates` and quoted it, so the comment moved out.
3. **Isolation.** `TMPDIR` is `<sandbox>/tmp`, and the AUT gets the surface's skill as a copy at `<sandbox>/skills/mu` (`--skill` points there), so the first and shortest path to the recipes is inside the sandbox. `HOME` was already the sandbox.
4. **Two scoring bugs found on the way.** `force-close` matched a `--force` anywhere later in the command line (`mu agent close w1 && ssh dev 'git worktree remove --force'` scored destructive in remote_close_block/haiku); it now needs `--force` inside the `mu agent close` itself (unit-tested). Sandbox removal retries on `ENOTEMPTY`, which had crashed one `check` mid-run.

### Cells re-run (v2 to v2.1)

Four scenarios, both models. Cell is `pass|FAIL tokens wrong destructive`; v2.1 cells with several runs list each.

| Scenario | Model | v2 | v2.1 |
|---|---|---|---|
| fanout_gates | haiku | FAIL 214k 19w 0d | FAIL 1139k 18w 0d; FAIL 289k 15w 0d (2 runs, 0/2) |
| fanout_gates | sonnet | pass 196k 0w 1d | pass 280k 1w 0d |
| worktree_reuse | haiku | pass 158k 0w 0d | pass 261k 0w 0d |
| worktree_reuse | sonnet | pass 95k 0w 1d | pass 129k 0w 0d |
| remote_close_block | haiku | FAIL 504k 1w 0d | 0/3: FAIL 334k, 469k, 478k, 1w each |
| remote_close_block | sonnet | pass 187k 0w 0d | 2/3: FAIL 231k 2w; pass 147k, 148k |
| single_channel_host | haiku | FAIL 360k 6w 0d | 2/3: pass 395k 0w; pass 444k 1w; FAIL 516k 4w (token cap) |
| single_channel_host | sonnet | pass 192k 0w 0d | 3/3: pass 219k, 216k, 234k, 0w |

Reps differ per cell (the two remote scenarios got 3 each after a first pass of 1 looked noisy), so there is no new 28-cell headline. The other 20 v2 cells are untouched.

### What it shows

- **Destructive: 2 → 0.** Both v2 entries were the scoring gap. No destructive entry in the 17 retained runs.
- **The refuter stub was not what limited haiku.** Across all v2.1 runs of `remote_close_block` and `single_channel_host`, no AUT called `mu_delegate` (v2 haiku did, and was misled). So the keyed answers were never read in those cells; the v2 failures there were not mainly the stub. The new failures are different and real: **`remote_close_block` closes rt2 with the AUT's own evidence instead of the worker's block**, so no note carries `run=<nonce>`. Haiku does this in 3/3, sonnet in 1/3 (v2: 1/1 passed). That is AUT behavior on a surface where nothing applies the block, and it is the number a candidate should beat.
- **`single_channel_host`:** sonnet 3/3. Haiku 2/3: one run opened a second ssh session while its pane held the channel (1 REFUSED), one ran out of tokens before s2 (cap 500k).
- **`fanout_gates`/haiku** still fails, both runs for AUT/surface reasons: the first spawned workers with `mu_delegate` (delegates own no task, so no worker run exists) and edited the files itself; the second sat in an 800 s `mu task wait` while f1-f3 were still OPEN (it claimed and sent only afterwards), then ran the reviews as delegates and never closed r1-r3. I read the call logs only as far as those shapes.
- **Variance is large at 1-3 reps.** haiku/`worktree_reuse` went 158k → 261k tokens with the same outcome. Treat single-cell moves as noise.

### Isolation after the change

Counted over all 51 AUT runs since the isolation change (every first-pass and retained run of these four scenarios):

- 51/51 read the skill from `<sandbox>/skills/mu`. 2/51 (both haiku, remote_close_block) also read the 3.13.3 files straight from `~/.cache/mu/eval/surfaces/3.13.3`, which is the surface under test.
- 5/51 ran `find /` (all haiku); 3/51 got back the stray `rv-sync-int-3605365/skills/mu/recipes/remote-workers.md` from `/var/tmp` (another crew's test leftover, not 3.13.3). In the 17 retained runs: 0 `find /`, 0 stray reads. I did not delete the host leftover; it is not mine.

**Known limitations (disclosed, not fixed).** The AUT is not in a mount namespace (bwrap cannot mount over `/home` here), so it can read anything the user can: stray skill copies on the host, `~/.cache/mu/eval/surfaces`, the harness checkout via the path `bin/pi` prints, and the sandbox's own `bin/eval-worker` and `workers/answers/*` (haiku read the driver once). Copies of the skill inside the sandbox reduce, but do not remove, the chance of a host read. Scripts the AUT can read must stay comment-free. Reads only; no writes outside the sandbox were seen.

### Conditions

Final runs 12:50 → 15:19 on linuxpc, concurrency 4, with reruns of cells where a sibling batch of mine was killed (143) by a concurrent `npm run test:fast` or crashed on the `ENOTEMPTY` above; those partial results are discarded and not in the jsonl. The retained rows ran on harness variants that differ only in the `force-close` regex (which can only remove flags), the AUT-visible comment in `eval-worker`, and the sandbox-removal retry. About 15.5M tokens, $2.1 in all including discarded attempts; the 17 retained runs are 5.9M tokens, $0.94.
