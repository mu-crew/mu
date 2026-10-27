# Dogfood 4: the settle wait and delegate delivery, after v_settle

Task `dogfood_after_v_settle`. An isolated loop like [dogfood-3](dogfood-3.md) on `e87c382` (v_settle merged) + `npm run build`, never installed. Host linuxpc, pi 1.4.0, tmux 3.7c, 2026-10-26 23:54 to 00:51 (7 runs, 3 to 12 min each). Orchestrator = sonnet-5-5 with the checkout's `dist/extension/mu-pi.js` and `skills/mu`.

## Setup

- `/var/tmp/d6/env.sh` unsets every inherited `MU_*`, `PI_*`, `TMUX*`, `HERDR*`. It sets `MU_STATE_DIR=/var/tmp/d6/state`, `MU_DB_PATH`, `MU_SYNC_DIR=` (blank), `MU_TMUX_SOCKET=d6`, `TMPDIR=/var/tmp/d6/tmp`, `PI_CODING_AGENT_DIR=/var/tmp/d6/pa` (modelbridge only, so no 3.x `mu.ts`) and `MU_PI_COMMAND=/var/tmp/d6/piwrap.sh`. `/var/tmp/d6/bin/mu` runs `dist/cli.js`.
- Run 1 drove `pi --mode rpc` from a script. Runs 3 to 7 ran the TUI in a pane of the private tmux server (typed prompts, real Esc and `/reload`). Per run: a workstream `d6<x>`, tasks that begin with `sleep` (40 to 130 s), a umbrella, and a throwaway git repo.
- Each run: 1 or 2 pi workers (`agent spawn --task --worktree --send -`) plus a wave of 1 to 3 `mu_delegate` calls (`sleep 5..60`, read-only). Every step had a timeout (`timeout 20..120`, the drivers 480 to 600 s).
- Isolation: after the runs nothing under `~/.local/state/mu-next` or `~/.cache/mu` was newer than the start (`find -newer`), and the live `mu.db-wal` and `~/mu` segment mtimes were still 23:53:38, before run 1. `tmux -L d6 kill-server`; no `pi` or `mu wait` left.
- Harness trap (run 2, not a mu defect): a pane's zsh rc resets `PATH`, so the pane delegates ran 3.13.3 (`DB is v13; this mu understands up to v11`). `piwrap.sh` now sets `PATH` and the env itself. Run 2 is excluded.

## What the brief asked

| Check | Result |
| --- | --- |
| Turn does not end while work is owed | Pass. Runs 4 and 6: the model said "dispatched" with no tool call and the settle ran `mu wait`, then continued the turn at the first event (run 4: 48 s later, run 6: 26 s, again at the worker's settle, 00:12:17). The turn ended with the work closed only (run 4 merged and closed the umbrella) |
| Delegate answer while a worker runs | Pass for a single call: run 6, answer recorded 00:10:40.4, shown 00:10:40, worker closed 00:12:15. A wave member is held until its siblings finish or another event fires (design). Run 4: r1/r2 recorded 00:04:19/:44, shown with x1's close at 00:05:05 ("Another event came before the rest of wave"). No answer starved |
| Wave summary once | Pass in runs 4, 5, 6 per wave (one summary, `answers=1..2`; run 3 never ended its turn: the model waited itself). **Fail in run 1**: F1 |
| Esc mid-wait | Run 5, Esc during the wave wait: the `mu wait` child was gone in 2 s. The wait's result was still written as a summary entry (r1 done, "2 pending") but started no turn; r2 recorded 4 s later and its wake line (`mu-delegate`, pointer, no text) started the turn. Esc on the model's own bash `mu wait`: "Command aborted", the next answer left one wake line |
| `/reload` | pi refuses while a settle wait runs ("Wait for the current response to finish before reloading"); after Esc it reloads and a later prompt gets its settle wait again. A running pane delegate is orphaned: F2 |
| Cost | 11 to 18 assistant turns and $0.02 to $0.08 per run. Workers closed their own tasks in runs 4 to 6; run 1's model closed them |

## Findings

**F1 (P2): a wave whose answers are already recorded is shown once per delegate.** Run 1: the model ended its turn after reading the delegates' task notes itself. The settle then fired 5 times: three `wave summary` entries (each "0/3 ... 3 UNVERIFIED, 0 pending" with one `Delegate answer:`), then `closed task:d6/w1` and `closed task:d6/w2`. Each carried "Work you own is still running" with `open:0`. The model counted "five such settles". Cause (`extension/nudge.ts` `answers()`): with no pending sibling the loop is skipped and only the firing call goes into `shown`, so the next settle repeats the summary for the next call. dogfood-3 F1 saw the same on the mux-free path; v_settle_delivery's wave summary did not close it. Task `triage_df4_wave_once`.

**F2 (P2): `/reload` orphans a running pane delegate; its answer is never recorded.** Runs 6 and 7 (7: one delegate, Esc then `/reload`, nothing else). A pane delegate (state `running`) outlives the `/reload`, finishes (`needs_input`, answer visible in its pane) and nothing records it: the call stays `running`, its task `IN_PROGRESS`, no report note, `mu doctor` ok. The settle wait owes it for ever: after the next prompt it was still blocked at `open:1` 4 min 44 s later (run 6, 00:29:31); I ended it with Esc. `session_shutdown` only warns ("answers will not come back here; use `mu agent wait`"), and `docs/guide/delegate.md` says a lost wake "(Escape, compaction, `/reload`) loses nothing". True for Escape; not for `/reload`, unlike the mux-free child, which finishes onto its task. I did not see the warning in a pane capture. Task `triage_df4_reload_orphan`.

## P3 (one line each, on `v_docs_final`)

1. `mu wait --resume <h> --first/--on-stall/-w d6` is a UsageError the model hit in runs 4, 5, 6 (the result prints `resume` to copy); `-w` says "does not match the stored wait (no workstream)". The message is clear; the `resume` line could say "no other flags".
2. A delegate called without `record` closes with "CLOSE: answered NO VERDICT" and the wave says "0/3 CONFIRMED ... UNVERIFIED"; the model read it as failure in 3 runs.
3. A settled worker that closed its own task shows `close:{applied:false, reason:"no CLOSE block"}` and `needs_input`; the model read it as a failure (runs 4, 6).
4. `next: mu wait -w <ws>` follows every command, the umbrella close included.
5. Esc stops only the current wait; a later delegate answer still wakes an idle pi (run 5, 4 s later). Say so next to the Esc line in the guide.
6. 2 of 22 delegate answers came back in Chinese (modelbridge sonnet child); a model matter, not mu's.
