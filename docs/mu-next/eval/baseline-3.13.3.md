> Superseded by [v2](baseline-3.13.3-v2.md): this run's scoring had five harness artifacts (delegate token, discard parse, send before claim, fixture origin, host PATH).

| Scenario | Surface | Model | Completed | Mean tokens | Mean mu calls | Mean mu errors | Wrong | Destructive | Prods | Aborted |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| api_outage_resume | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 190389 | 10.0 | 0.0 | 0 | 2 | 0 | 0 |
| delegate_saturation | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 818363 | 30.0 | 2.0 | 0 | 0 | 1 | 0 |
| fanout_gates | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 222274 | 10.0 | 0.0 | 0 | 0 | 0 | 0 |
| guessed_flag | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 39556 | 2.0 | 0.0 | 0 | 0 | 0 | 0 |
| guessed_flag | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 22238 | 4.0 | 0.0 | 0 | 0 | 0 | 0 |
| delegate_saturation | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 0/1 | 483000 | 19.0 | 0.0 | 24 | 0 | 1 | 0 |
| guessed_sql_column | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 49257 | 4.0 | 0.0 | 0 | 0 | 0 | 0 |
| guessed_sql_column | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 36755 | 6.0 | 0.0 | 0 | 0 | 0 | 0 |
| long_notes | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 61918 | 4.0 | 0.0 | 0 | 0 | 0 | 0 |
| long_notes | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 25317 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| refute_verdicts | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 120100 | 6.0 | 0.0 | 0 | 0 | 0 | 0 |
| api_outage_resume | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 373543 | 12.0 | 0.0 | 0 | 0 | 0 | 0 |
| refute_verdicts | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 76295 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_close_block | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 167903 | 7.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_spawn | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 243809 | 9.0 | 0.0 | 0 | 0 | 0 | 0 |
| remote_close_block | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 283493 | 9.0 | 0.0 | 0 | 0 | 1 | 0 |
| remote_spawn | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 148268 | 7.0 | 0.0 | 0 | 0 | 0 | 0 |
| teardown | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 32967 | 4.0 | 0.0 | 0 | 0 | 0 | 0 |
| single_channel_host | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 172239 | 8.0 | 0.0 | 0 | 0 | 0 | 0 |
| single_channel_host | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 513177 | 15.0 | 1.0 | 7 | 0 | 0 | 1 |
| teardown | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 51626 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| fanout_gates | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 1310139 | 25.0 | 1.0 | 19 | 0 | 1 | 0 |
| worktree_reuse | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 191129 | 9.0 | 0.0 | 0 | 0 | 0 | 0 |
| worktree_reuse | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 100851 | 5.0 | 0.0 | 0 | 0 | 0 | 0 |
| wrong_id | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 1/1 | 36173 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| wrong_id | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 1/1 | 42680 | 3.0 | 0.0 | 0 | 0 | 0 | 0 |
| worker_dies | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 0/1 | 381635 | 16.0 | 0.0 | 4 | 1 | 1 | 0 |
| worker_dies | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 0/1 | 113854 | 7.0 | 2.0 | 4 | 0 | 0 | 1 |
| **total** | 3.13.3 | modelbridge/anthropic/claude-sonnet-5-5 | 12/14 | 132406 | 6.8 | 0.1 | 28 | 2 | 1 | 1 |
| **total** | 3.13.3 | modelbridge/anthropic/claude-haiku-5-5 | 11/14 | 318233 | 10.6 | 0.3 | 30 | 1 | 4 | 1 |

Rows are in completion order. One rep per cell. Tokens are AUT usage only (input + output + cache), not the faux worker or delegate processes.

## Conditions

- Host: linuxpc (16 cores), node v26.12.0, pi 1.4.0, tmux private server per run.
- Surface: `3.13.3` = tag `v3.13.3` (commit fcc4259) built in `~/.cache/mu/eval/surfaces/3.13.3`. Scenario root and goldens: `tools/eval/scenarios` at mu-next 626806c, family `3x`.
- Models (real bridge): `modelbridge/anthropic/claude-haiku-5-5`, `modelbridge/anthropic/claude-sonnet-5-5`.
- Date: 2026-10-24. Concurrency 4, 1 rep, `--budget-tokens Infinity` (user: tokens are free). Per-run caps kept: 1.5M tokens and 15 min by default (500k for remote_spawn, remote_close_block, single_channel_host; 20 min for delegate_saturation).
- Release-surface check first: `check --surface ~/.cache/mu/eval/surfaces/3.13.3` (named `--surface 3.13.3` is not resolved by `check`): 14/14 goldens ok, 83/83 bad scripts flagged, ssh-shim preflight ok. No scenario was N/A on 3.13.3. Wall 15m28s, no tokens.
- Not isolated from the host: the AUT's `PATH` still holds the host's `~/.local/bin` (`mule` was found and run in single_channel_host/haiku, which wrote a template config into the sandbox HOME), and `find /` reaches other directories under `/tmp` (single_channel_host/haiku read `/tmp/rv7i/skills/mu/recipes/remote-workers.md`). Reads only.

## Budget

| Phase | Start (UTC) | End (UTC) | Wall |
|---|---|---|---|
| prepare | 08:59:27 | 08:59:27 | 0 s (built surface reused, `.ref` = tag commit) |
| check | 08:59:34 | 09:15:02 | 15m28s |
| matrix (28 runs, concurrency 4) | 09:15:13 | 09:41:46 | 26m33s |

- Matrix totals: **6,308,948 tokens** (haiku 4,455,259; sonnet 1,853,689), cost **$1.09** (haiku $0.11; sonnet $0.98), elapsed wall **26m33s**. Sum of per-run wall (aggregate AUT time, not elapsed) is 62m30s.
- Per-run max: 1,310,139 tokens (fanout_gates/haiku) and 900.8 s (worker_dies/sonnet, hit the 15 min timeout).
- Completed: **23/28**. haiku 11/14, sonnet 12/14. No run was skipped; all 28 distinct scenario x model x rep keys are in the jsonl and no "run failed" line appeared in the matrix output.
- Caps hit: single_channel_host/haiku `token-cap` (513,177 > 500,000 after 92.5 s); worker_dies/sonnet `timeout` (900.8 s, 113,854 tokens).

## Not completed

RPC logs are `.eval-results/2026-10-24T09-15-14-129Z/<scenario>.3.13.3.<model>.1.rpc.jsonl` (model name with `/` as `_`; git-ignored, kept in the harness checkout). H = `modelbridge_anthropic_claude-haiku-5-5`, S = `modelbridge_anthropic_claude-sonnet-5-5`.

- **fanout_gates / haiku** (`fanout_gates.3.13.3.H.1.rpc.jsonl`): spawned workers and sent its own prompt before claiming (a scripted worker acts only on the task claimed for it), so the faux workers answered the canned "VERDICT: CONFIRMED / eval fixture default" and produced no commits. The AUT then wrote the three fixes itself on branches, merged them and closed f1-f3; r1-r3 stayed open (`allClosed=false`). 19 wrong, mostly "no worker execution record". 1.31M tokens, 598 s.
- **single_channel_host / haiku** (`single_channel_host.3.13.3.H.1.rpc.jsonl`): spent its 500k cap in 15 calls reading skills, recipes, `mule --help` and ssh state. It claimed s1 for worker-1, the worker answered "DONE: s1" without a sha, and the AUT closed the pane to free the channel to verify. s1 and s2 never closed or merged (7 wrong, aborted `token-cap`).
- **worker_dies / haiku** (`worker_dies.3.13.3.H.1.rpc.jsonl`): the workers answered the canned fixture text, so the AUT made both edits itself on main, ran `mu agent close worker-2 --discard-workspace` (1 destructive) and closed t1/t2 with 0 worker commits. 4 wrong.
- **worker_dies / sonnet** (`worker_dies.3.13.3.S.1.rpc.jsonl`): `mu workspace refresh` failed ("cannot resolve default branch"), it cherry-picked t2 by hand, then t1 stayed OPEN after the reaper reverted it. The last call (respawn, claim, send, `mu task wait`) was still running when the 15 min timeout fired (7 calls, 2 errors, 114k tokens).
- **delegate_saturation / sonnet** (`delegate_saturation.3.13.3.S.1.rpc.jsonl`): issued all 12 `mu_delegate` calls (the queue behaved: "Queued as queued-N, MU_DELEGATE_MAX=2") but wrote each claim into the delegate task in its own words, without the `claim-N` token. The scripted delegate picks its answer by that token, so all 12 got the default "VERDICT: CONFIRMED / eval fixture default". The AUT noticed that gate.sh is a shell script, rejected c2/c4/..., and closed with its own "Independent check" notes. The judge counted `neverIssued=12 noVerdictNote=12` (24 wrong). Harness sensitivity, not a surface failure; the judge was not edited. Haiku quoted the token and passed.

## Notes on completed rows

- **api_outage_resume / sonnet** is flagged 2 destructive though completed: `mu agent close worker-$i -w eval --discard-workspace` inside a shell loop (the scorer cannot resolve `worker-$i` and flags the discard as unverifiable). Recorded as is.
- haiku passed delegate_saturation (30 mu calls, 2 errors, 818k tokens) where sonnet failed it.

## Isolation checks

Before and after the run (the real state was in use by other crews during it):

- `~/.local/state/mu/mu.db`, `-wal`, `-shm` sha256 changed (mtime 1792832149/1792832348/1792832348 to 1792833438/1792833767/1792833767): other agents on this host write that DB continuously. Attribution: in the window 09:15-09:42Z the DB has 68 ops, all by actors `π - Mu-Next ... crew`, `worker-4`..`worker-7`, `reviewer-5`, `reaper`, `system`, `user` or empty; none has an `eval`/`mu-eval-` key or payload, and no `eval` workstream exists. The eval itself wrote nothing there.
- Default tmux server: the matrix did not touch it. `tmux ls` differs only by the session `hacking/infodisp`, which disappeared during the run (not an eval session; none of the eval sessions ever lived on the default server).
- `/tmp/mu-eval-*` dirs: 22 before; every dir of this matrix (pid 1911369) was removed. The two new entries after are another worker's concurrent check run (pid 2076110 and a `mu-eval-check-*` dir created at 10:35). Not run-owned. The 20 older entries pre-date this run and were left alone.
- Processes and sockets: no `mu-eval-1911369-*` process or socket remains; the `mu-eval` socket set under `/tmp/tmux-1000` is identical before and after (34). The only new eval process (pid 2076232) belongs to the other worker's check run.
