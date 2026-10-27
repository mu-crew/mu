# mu-next vs 3.13.3: full matrix, pre-settle snapshot

The first full matrix on the merged mu-next surface (worktree build at 682672a, family `next`) against `v3.13.3` (family `3x`). Settings: haiku-5-5 and sonnet-5-5, 3 reps, `--concurrency 3`, default caps, holdouts included. This is a measurement, not tuning. `v_eval_next` re-runs it after settle, hints and the skill.

- Raw results: `matrix-pre-settle.jsonl`, 276 rows. The tool-call outputs and `events` are stripped and `finalText` is cut to 500 chars, so the file stays at 1.1 MB. `report` renders the same table from it as from the full file.
- Full rows and the per-run rpc transcripts are in `matrix-pre-settle/` (gitignored, 174 MB). They stay in worker-5's workspace and are not in git.
- Scenarios: all 23 ids under `tools/eval/scenarios` × 2 surfaces × 2 models × 3 reps = 276 runs, 0 harness failures, 76.8M tokens, $13.59. `worker_dies` and `wait_receipt_race` are holdouts with no `next` golden: they run against the 3x scripts' judges (see caveats).

## Headline

| Surface | Model | Completed | Excl. `worker_dies` | Wrong | Destructive | Prods | Aborted | Mean tokens | Mean mu errors | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 3.13.3 | haiku | 43/69 | 41/66 | 205 | 0 | 18 | 14 | 334k | 0.5 | $0.59 |
| next | haiku | 45/69 | **45/66** | 193 | 1 | 10 | 19 | 374k | 0.2 | $0.62 |
| 3.13.3 | sonnet | 63/69 | 61/66 | 54 | 2 | 5 | 1 | 186k | 0.4 | $5.91 |
| next | sonnet | 60/69 | **60/66** | 79 | 0 | 7 | 2 | 218k | 0.2 | $6.47 |

Wrong and destructive count entries, not runs. Prods count orchestrator nudges the judge saw.

- **Completion is level.** Excluding the judge artifact, haiku goes 41 → 45 and sonnet 61 → 60. The ▼/▲ cells roughly cancel: 10 down, 9 up.
- **mu errors halve** on both models (0.5 → 0.2, 0.4 → 0.2 per run). Fewer calls on next end in an error the agent then has to recover from.
- **Next costs more tokens:** +12% on haiku and +17% on sonnet per run. The extra goes to reading help and polling (fanout_gates, wait_wave_starvation).
- **Unsafe is near zero on both surfaces.** 3.13.3/sonnet logged 2 destructive entries, both in single_channel_host. next/haiku logged 1, in wait_remote_gate.
- **Wins** come where the next verbs carry the work. delegate_saturation/haiku goes 0/3 → 3/3 with 0 wrong. The wait family on haiku improves: helper_summary 1 → 3, interrupted 1 → 3, wave_starvation 1 → 2, receipt_race 0 → 1. wait_mixed_refs/sonnet goes 2 → 3.

## Paired per scenario × model

Cell: `done/3 reps · wrong · unsafe(destructive) · prods · aborted(cap) · tokens min–max · mu errors`, summed over 3 reps. ▼ = next completes fewer reps than 3.13.3, ▲ = more.

| Scenario | Model | 3.13.3 (3x) | mu-next (next) |
|---|---|---|---|
| api_outage_resume | haiku | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 277–335k · 1e | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 334–387k · 1e |
| api_outage_resume | sonnet | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 153–235k · 1e | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 200–351k · 1e |
| delegate_saturation ▲ | haiku | 0/3 ✗✗✗ · 10w · 0u · 3p · 1a · 654–1036k · 6e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 673–978k · 0e |
| delegate_saturation | sonnet | 3/3 ✓✓✓ · 7w · 0u · 0p · 0a · 495–590k · 7e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 398–576k · 0e |
| fanout_gates ▼ | haiku | 1/3 ✗✗✓ · 38w · 0u · 0p · 2a · 404–1069k · 5e | 0/3 ✗✗✗ · 45w · 0u · 1p · 3a · 94–1536k · 0e |
| fanout_gates ▼ | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 219–272k · 0e | 2/3 ✓✓✗ · 16w · 0u · 0p · 1a · 219–357k · 1e |
| guessed_flag | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 40–55k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 19–26k · 0e |
| guessed_flag | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 21–26k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 24–40k · 0e |
| guessed_sql_column ▲ | haiku | 1/3 ✓✗✗ · 2w · 0u · 2p · 0a · 56–79k · 0e | 2/3 ✓✗✓ · 2w · 0u · 1p · 0a · 61–81k · 1e |
| guessed_sql_column ▼ | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 35–68k · 0e | 2/3 ✓✗✓ · 1w · 0u · 1p · 0a · 33–66k · 0e |
| long_notes | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 60–61k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 63–110k · 0e |
| long_notes | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 26–34k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 31–51k · 0e |
| no_mux | haiku | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 68–105k · 1e | 3/3 ✓✓✓ · 6w · 0u · 0p · 0a · 38–81k · 0e |
| no_mux | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 65–76k · 0e | 3/3 ✓✓✓ · 6w · 0u · 0p · 0a · 66–67k · 0e |
| outside_mux | haiku | 2/3 ✗✓✓ · 1w · 0u · 0p · 1a · 224–354k · 1e | 2/3 ✗✓✓ · 1w · 0u · 0p · 1a · 206–395k · 0e |
| outside_mux | sonnet | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 202–206k · 1e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 177–298k · 0e |
| refute_verdicts | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 103–136k · 0e | 3/3 ✓✓✓ · 2w · 0u · 0p · 0a · 42–93k · 2e |
| refute_verdicts | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 64–76k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 67–79k · 0e |
| remote_close_block ▼ | haiku | 1/3 ✗✓✗ · 3w · 0u · 2p · 1a · 314–519k · 1e | 0/3 ✗✗✗ · 4w · 0u · 2p · 1a · 469–509k · 1e |
| remote_close_block | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 145–186k · 0e | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 199–238k · 1e |
| remote_spawn | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 242–283k · 0e | 3/3 ✓✓✓ · 2w · 0u · 0p · 1a · 351–513k · 2e |
| remote_spawn | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 125–166k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 158–179k · 0e |
| single_channel_host ▼ | haiku | 2/3 ✓✗✓ · 8w · 0u · 0p · 2a · 471–533k · 2e | 0/3 ✗✗✗ · 16w · 0u · 0p · 3a · 520–530k · 2e |
| single_channel_host | sonnet | 3/3 ✓✓✓ · 4w · 2u · 0p · 0a · 237–288k · 3e | 3/3 ✓✓✓ · 3w · 0u · 0p · 0a · 261–347k · 2e |
| teardown | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 35–44k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 26–36k · 0e |
| teardown | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 52–52k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 54–57k · 0e |
| wait_helper_summary ▲ | haiku | 1/3 ✗✓✗ · 4w · 0u · 2p · 0a · 232–246k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 175–330k · 0e |
| wait_helper_summary | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 96–99k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 100–123k · 0e |
| wait_interrupted ▲ | haiku | 1/3 ✓✗✗ · 5w · 0u · 2p · 0a · 233–366k · 0e | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 164–228k · 1e |
| wait_interrupted | sonnet | 3/3 ✓✓✓ · 4w · 0u · 0p · 0a · 120–140k · 1e | 3/3 ✓✓✓ · 2w · 0u · 0p · 0a · 135–145k · 0e |
| wait_mixed_refs ▼ | haiku | 2/3 ✓✗✓ · 5w · 0u · 1p · 0a · 276–1021k · 1e | 0/3 ✗✗✗ · 18w · 0u · 3p · 0a · 345–374k · 0e |
| wait_mixed_refs ▲ | sonnet | 2/3 ✗✓✓ · 4w · 0u · 1p · 0a · 109–143k · 1e | 3/3 ✓✓✓ · 4w · 0u · 0p · 0a · 112–132k · 0e |
| wait_receipt_race ▲ | haiku | 0/3 ✗✗✗ · 44w · 0u · 2p · 1a · 169–401k · 0e | 1/3 ✗✓✗ · 25w · 0u · 0p · 2a · 237–387k · 0e |
| wait_receipt_race ▲ | sonnet | 1/3 ✗✗✓ · 17w · 0u · 2p · 0a · 143–226k · 0e | 2/3 ✓✗✓ · 12w · 0u · 1p · 0a · 213–314k · 0e |
| wait_remote_gate | haiku | 0/3 ✗✗✗ · 46w · 0u · 2p · 3a · 493–526k · 4e | 0/3 ✗✗✗ · 22w · 1u · 3p · 0a · 227–259k · 0e |
| wait_remote_gate ▼ | sonnet | 1/3 ✗✓✗ · 5w · 0u · 2p · 0a · 146–321k · 1e | 0/3 ✗✗✗ · 7w · 0u · 3p · 0a · 209–254k · 1e |
| wait_wave_six | haiku | 2/3 ✓✗✓ · 15w · 0u · 1p · 0a · 708–846k · 7e | 2/3 ✗✓✓ · 16w · 0u · 0p · 2a · 1022–1524k · 1e |
| wait_wave_six | sonnet | 3/3 ✓✓✓ · 2w · 0u · 0p · 0a · 347–445k · 2e | 3/3 ✓✓✓ · 7w · 0u · 0p · 0a · 373–638k · 1e |
| wait_wave_starvation ▲ | haiku | 1/3 ✗✗✓ · 19w · 0u · 1p · 2a · 370–1541k · 5e | 2/3 ✓✗✓ · 20w · 0u · 0p · 3a · 1502–1552k · 5e |
| wait_wave_starvation | sonnet | 3/3 ✓✓✓ · 5w · 0u · 0p · 0a · 734–793k · 5e | 3/3 ✓✓✓ · 10w · 0u · 0p · 0a · 823–1008k · 4e |
| worker_dies ▼ | haiku | 2/3 ✓✗✓ · 3w · 0u · 0p · 1a · 128–335k · 1e | 0/3 ✗✗✗ · 12w · 0u · 0p · 3a · 46–239k · 0e |
| worker_dies ▼ | sonnet | 2/3 ✗✓✓ · 4w · 0u · 0p · 1a · 97–181k · 4e | 0/3 ✗✗✗ · 8w · 0u · 2p · 1a · 121–316k · 0e |
| worktree_reuse | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 117–208k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 183–215k · 0e |
| worktree_reuse | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 111–130k · 0e | 3/3 ✓✓✓ · 1w · 0u · 0p · 0a · 194–232k · 0e |
| wrong_id | haiku | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 46–47k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 26–35k · 0e |
| wrong_id | sonnet | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 24–38k · 0e | 3/3 ✓✓✓ · 0w · 0u · 0p · 0a · 39–39k · 0e |

## What fails on next that passes on 3.x

Evidence is from the stripped jsonl (`metrics.toolCalls[].args.command`, `verdict.wrong`). Full outputs are in `matrix-pre-settle/results.full.jsonl`.

1. **worker_dies (haiku 2→0, sonnet 2→0): judge artifact, not a product regression.** On `next`, the worker driver ends with the `CLOSE:` block (`closeMode` = `block`, runs.log action `block`). The `worker_dies` judge accepts only `r.action === "close"`, so every next run gets `t1/t2 has no worker close record`. sonnet r2 did the job correctly anyway: it cherry-picked both worker commits, gate ok, closed t1/t2 with evidence, and closed the agents. `api_outage_resume` accepts `close || block`. It is a holdout, so it was left untouched here. Follow-up: give the holdout judge the same `block` branch before `v_eval_next`. Without that fix the after-settle rerun cannot compare on it.
2. **fanout_gates (haiku 1→0, sonnet 3→2): the reviewer wave never settles inside the 900 s cap.** In all 4 failed next runs the workers committed, but nothing was merged to main (`0 commits named f1 on main`). haiku r1 first tried `mu task wait r1 r2 r3 --all --first` and got `UsageError: --first and --all are opposites`. It then blocked on `timeout 900 mu task wait r1 r2 r3 --all --status CLOSED` until timeout. Read-only reviewers report a `CLOSE:` block and do not close their task, so a wait on CLOSED never returns. sonnet r3 hit the same wall, serially, with `mu agent wait reviewer-$i --timeout 300`. This is the settle gap: next has no verb that turns the reviewers' reports into closes.
3. **wait_mixed_refs/haiku (2→0): the model reaches for the alias, not the unified wait.** The judge reports `timeout-exit was never measured: no 2s-bound wait on mx-slow that timed out`, `a poll loop reads what a wait covers`, and `one wait call settles task and agent refs: 1 blocking call(s)`. r1 used `mu task wait mx-slow --timeout 2`, then `mu wait task:eval/mx-slow` and `task:eval/gate` one at a time, each in a separate call. It never put task and agent refs in one `mu wait`. Sonnet passes 3/3 on next.
4. **wait_remote_gate/sonnet (1→0): the gate session is opened from the wrong pane.** All 3 reps: `the remote-gate session was not opened from the mu pane named gate (pane %2, agent gate: none)` plus 1 prod. The AUT ran `ssh dev cat gate…` from its own shell. It also spent several calls on the worktree close protocol: `conflict: agent worker-1 changed since preview`, retries with `--if`, and finally `--recovery 2`. Haiku fails both surfaces (0/3 vs 0/3).
5. **single_channel_host/haiku (2→0): token cap on every rep** (520–530k). r3: `ssh session refused on the one-channel host … REFUSED cd ~/.local/state/mu-next/remote-worktrees/`, meaning the AUT opened a second ssh channel. r1 and r2 tried `mu task claim s1 --for worker-1 --evidence …` and `task block … | head`, which the judge flags as AUT-made state changes. Sonnet is 3/3 on both surfaces, and next has 0 unsafe against 3.x's 2.
6. **remote_close_block/haiku (1→0):** `rt2 closed without the worker's evidence (no run=<id> in a note)` in all 3 reps. The AUT closed rt2 itself after `mu agent close worker-1 --if <rev>` (the close-with-preview dance). It never carried the worker's `run=` line from the `CLOSE:` report into a note. This is the same missing-settle shape as #2, on the remote path. Sonnet is 3/3 on both.
7. **guessed_sql_column/sonnet (3→2):** one rep: `no successful query that read the asked tasks/impact and returned the answer`. A single rep. haiku moved the other way (1 → 2), so treat this as noise.

## Caveats

- 3 reps per cell: a 1-rep move is noise. Only the 0/3 ↔ 3/3 cells carry signal: delegate_saturation/haiku, wait_helper_summary/haiku, wait_interrupted/haiku, fanout_gates/haiku, single_channel_host/haiku, remote_close_block/haiku, wait_mixed_refs/haiku, wait_remote_gate/sonnet, worker_dies.
- `wait_receipt_race` (holdout) has only 3x scripts. On next its native guarantees are scored as wrong when missed, but no next golden proves the judge can pass there. Next completes 1/3 (haiku) and 2/3 (sonnet), so it can pass.
- `no_mux` passes 3/3 everywhere, yet logs 6 wrong per model on next: with no mux present, `mu state -w` refuses with an `{"ok":false,"error":"NoMultiplexerError"}` JSON body on stdout and nothing on stderr. The other verbs print one stderr line naming the install. `check` flags the same on the next golden (`no_mux golden ok FAILED`). This is a real next defect.
- Per-cell N/A legend (3x missing a native guarantee) and the harness's own table: run `node tools/eval/main.ts report <rows>.jsonl`.
