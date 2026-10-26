# Dogfood 3: `mu_delegate` with no multiplexer, after v_delegate_nomux

Task `dogfood_after_v_delegate_nomux`. A 10-minute isolated loop like [dogfood-2](dogfood-2.md), on checkout `a7ec8dd` (v_delegate_nomux merged) + `npm run build`, never installed. Host linuxpc, pi 1.4.0, 2026-10-26 19:09 to 19:12.

## Setup

- `/var/tmp/df3/env.sh` unsets every inherited `MU_*`, `PI_*`, `TMUX*` and `HERDR*`. It sets `MU_STATE_DIR=/var/tmp/df3/state`, `MU_DB_PATH`, `MU_SYNC_DIR=` (blank) and `PI_CODING_AGENT_DIR=/var/tmp/df3/pa` (only modelbridge in its extensions, so no global 3.x `mu.ts` shim loads). It also sets `PATH=/var/tmp/df3/bin:/usr/bin:/bin`. `bin` holds `node`, `git`, `pi` and `mu` (the checkout's `dist/cli.js`). Neither `command -v tmux` nor `command -v herdr` finds anything.
- Orchestrator: `pi --mode rpc -ne -e modelbridge.ts -e <checkout>/dist/extension/mu-pi.js --no-skills --skill <checkout>/skills/mu --model modelbridge/anthropic/claude-sonnet-5-5`, driven by a small script (`/var/tmp/df3/drive.py`). The settle wait was on (`MU_NUDGE` unset).
- Repo: throwaway git repo with `a.js` (defines `foo`), `b.js` (calls it) and `README.md`. Tasks `c1`..`c3` in workstream `df3`, each holding one claim: c1 false, c2 and c3 true.

## Run

Prompt: no tmux or herdr is on this machine. Fan out one delegate per claim (`record`, wave `df3`) and close each task by its verdict. Also start one delegate with `keep: true` and cancel another right after starting it. At the end, list every wrong or misleading mu output.

| Outcome | Result |
| --- | --- |
| Registration | `mu_delegate`, `mu_delegate_cancel` and `mu_delegate_reissue` were all present with no mux |
| Fan-out | 5 `mu_delegate` calls in one turn, each answered at once with `Delegated ... as a child pi process: no multiplexer, so no pane to attach` and `transport: process` |
| Verdicts | c1 REFUTED, c2 CONFIRMED, c3 CONFIRMED, each recorded on its task by the runner before the delegate task closed. `mu delegates --all` shows them `done` with the verdict; the wave was `df3` |
| Closes | c1 `rejected`, c2 and c3 `done`. Each close came after its verdict note |
| keep | the result said `keep: true needs a multiplexer; the child stops after its answer`. The lister ran and finished, and its answer arrived |
| Cancel | `mu_delegate_cancel` returned at 9.1 s. The call is `cancelled`, its task `CLOSED/wontfix`, and no follow-up was sent for it |
| Follow-ups | 4 arrived ("finished after 6-8s. Child pi stopped.", plus the session). They were held behind the AUT's own 60 s `sleep` tool call, so they arrived at 82-89 s |
| Processes | no `pi --mode rpc` left running afterwards. One receipt dir per call under `state/delegate-process/` |
| Orchestrator | 156 s wall in total, of which 60 s was its own sleep. 12 tool calls |
| Isolation | nothing under `~/.local/state/mu` or `~/.local/state/mu-next` was newer than the run (`find -newer`) |

## Findings (none P1, none P2)

1. **Settle re-fires once per delegate event after the work is done** (note on `v_settle_delivery`, which owns it). The AUT had already closed c1..c3 from the task notes. Then each of the 5 delegate events, the cancelled one included, ended a settle with the "Work you own is still running" framing while the result showed `open: 0`. That cost 4 extra turns and caused no wrong action. It is not specific to running without a mux. The wave summary in the `v_settle_delivery` plan (one entry per wave) addresses it.
2. **P3 (v_docs_final):** in `mu task close --help`, "`--why` required unless --as done" reads as if `--why` were enough for done. The AUT's first close with `--as done --why` failed with exit 2.
3. **P3 (v_docs_final):** `mu task notes` prints a verdict note's newlines as a literal `\n`. This is the text-record contract (one record per line, escaped), but the AUT read it as corruption. The help could say so.
4. **P3 (v_docs_final):** `cursorCut` in `mu wait` results is unexplained (dogfood-2 F4 asked the same about `cursor`).

No defect in the mux-free path itself. Admission, record, cancel, the keep notice, child cleanup and isolation all behaved as documented.
