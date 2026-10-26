# Dogfood 2: `mu wait` after v_wait_cli

Task `dogfood_after_v_wait_cli`. A 10-minute isolated loop like [dogfood-1](dogfood-1.md), on checkout `8a7f672` (one `mu wait` verb, arming, the pre-engine wait code deleted) + `npm run build`, run as `mun` and never installed. Host linuxpc, node 24.22.1, tmux 3.7c, pi 1.4.0, 2026-10-26 13:16 to 13:27.

## Setup

- `/var/tmp/df2/env.sh` unsets every inherited `MU_*` and `PI_*`, then sets `MU_STATE_DIR=/var/tmp/df2/state`, `MU_DB_PATH=/var/tmp/df2/state/mu.db`, `MU_SYNC_DIR=` (blank), `MU_TMUX_SOCKET=mu-dogfood`, and `MU_PI_COMMAND=/var/tmp/df2/piwrap.sh`. `bin/mun` and `bin/mu` both run `node <checkout>/dist/cli.js`. No step needs 3.x here.
- `piwrap.sh` runs `pi -ne -e modelbridge.ts -e <checkout>/dist/extension/mu-pi.js --no-skills --skill docs/mu-next/skill-draft --model modelbridge/anthropic/claude-sonnet-5-5`.
- tmux: `tmux -L mu-dogfood -f /dev/null start-server ; set -g history-limit 2000 ; set -g exit-empty off`. At most 3 panes (session pane and 2 workers; the probes ran one worker at a time). After `kill-server`, tmux printed `no server running on /tmp/tmux-1000/mu-dogfood`.
- Repo: a throwaway git repo, `/var/tmp/df2/repo`, containing `textutil.js`, `test.js` and `package.json`.

## Orchestrator run

Prompt (`/var/tmp/df2/prompt.md`): workstream `df2`, umbrella `df2-wave` with ceiling 2. Two workers, each in its own worktree, add `truncate` and `capitalize` to the same two files. The orchestrator merges both onto main with `node test.js` green. It waits **only with `mu wait`**: once with no refs, once with typed refs, and with `resume` once. At the end it lists every wrong or misleading hint.

| Outcome | Result |
| --- | --- |
| Tasks | `trunc`, `cap`, `df2-wave` all `CLOSED/done` with evidence; umbrella closed with `--if-ready` |
| main | `d9ab4d4 Add truncate`, `22ded57 Add capitalize` (conflict in both files resolved by hand); `node test.js` prints `ok` |
| Concurrency | 2 workers alive at once, never 3 (dogfood-1 F9 not hit) |
| Orchestrator | 13 turns, 14 tool calls, 20.1k input, 4.6k output, 168k cache read; 13:17:16 to 13:18:13 = 57 s |
| Workers | 3 turns each, about 0.5k output tokens, both closed with `node test.js -> ok` |
| `mu wait` no refs | `mu wait -w df2 --timeout 20 --json` returned firing `closed task:df2/cap`, exit 0, `resume` set. The caller's spawned agents and their tasks were all in the snapshots |
| `mu wait` typed refs | `mu wait task:df2/trunc agent:df2/worker-1 -w df2` returned `closed task:df2/trunc`, `open:1` |
| `--resume` | `mu wait --resume 73b45573d1 --json` returned `settled agent:df2/worker-1` (run 1), then `resume:null` with `resumeWhy` |
| `agent close` | the preview + `--if <rev>` pair, run verbatim from the printed `Next:`; the hint names the left-over branch `mu/df2/worker-N-<sha>` |

The orchestrator used `mu wait` without a single misuse. Its one refused call was `--resume` together with `--timeout 20` (UsageError, exit 2, and the message says what to do). It then ran the handle bare.

## Probes (by hand, same env)

| Probe | Result |
| --- | --- |
| Heartbeat | `mun wait agent:df2/worker-3 -w df2 --timeout 5` returned `firing heartbeat`, `timedOut:true`, exit 0, a resume handle, and a `warning` that the deadline was the caller's. Running the handle gave another heartbeat with a fresh handle. Correct |
| Settle text | `mun wait 'agent:df2/worker-3@0'` returned `settled`, `lastText` with the agent's final reply, `sessionFile`, and `close:{applied:false,reason:"no CLOSE block..."}`. The spawn hint's "returns its final text" is true (the orchestrator missed it because it cut the output at 400 chars) |
| dogfood-1 F1 regression | worker closed on purpose after its task CLOSED: `mun wait task:df2/slow` and `mun task wait slow` both returned `closed`, exit 0. **Fixed** (`df1_wait_stale_dead`) |
| No refs, no caller | `mun wait -w df2` from a plain shell returned UsageError exit 2: `nothing to wait for. Name refs ... or run as a managed agent or a pi session`. Clear |
| Pane killed while waiting | wait running, `kill-pane`: `firing dead task:df2/t4`, exit 6, `reason ... its owner's pane died`. Correct |
| Pane killed, then wait | **F1**: heartbeat, exit 0, task OPEN, `dead:false` |
| Pane killed between heartbeat and resume | **F1**: heartbeat, exit 0 (twice: t8, t9) |
| Pane killed, no-ref wait from the spawner (`PI_SESSION_ID` set) | `firing dead agent:df2/worker-7`, exit 6. The hint is wrong (**F2**) |

## Findings

### F1 `df2_wait_dead_after_reap` (P1; fix task + `review_df2_wait_dead_after_reap`)

```
$ tmux -L mu-dogfood kill-pane -t <pane of worker-6>   # owns t5, IN_PROGRESS
$ mun wait task:df2/t5 -w df2 --timeout 10
{"ok":true,"data":{"firing":{"kind":"heartbeat","ref":null},"exit":0,"timedOut":true,"reason":"no event before the deadline; 1 still open","snapshots":[{"kind":"task","ref":"task:df2/t5","status":"OPEN","substate":"todo","fired":false,"dead":false}],...
$ mun task show t5 -w df2 | tail -1
note 2 by=reaper ... [reaper] previous owner worker-6 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```

The resume path behaves the same way. A handle taken while the worker was alive, run after the pane died, returns a heartbeat, exit 0. The wait's own first read runs the reaper. The reaper-flip check needs an in-memory `priorTask` from an earlier poll of the *same* process, and the resume row does not store it. So exit 6 shows only when the death happens while one `mu wait` process is polling. In the documented loop (heartbeat, then run `resume`), a worker that dies between two calls is never reported: the task sits OPEN/todo and each round heartbeats until the cap. A no-ref wait from the spawner does catch it, through provenance, as `dead agent:...`.

### F2 `df2_dead_hint_agent_ref` (P2)

```
{"firing":{"kind":"dead","ref":"agent:df2/worker-7"},"exit":6,...,"nextSteps":[{"intent":"See what the dead worker left","command":"mu task show worker-7 -w df2"}]}
$ mun task show worker-7 -w df2
not found: no such task: worker-7
```

`src/cli/wait.ts` passes the agent name to `task show` for every non-task ref.

### F3 (P3, on v_docs_final) resume handle vs help

Every `resume` prints `mu wait --resume <id> -w df2`. Help says of `--resume` "nothing else may be passed", yet `-w` is accepted and `--timeout` is refused.

### F4 (P3, on v_docs_final) `cursor` / `cursorCut` unexplained

`mu wait --help` does not name these fields. The orchestrator listed them as unexplained.

### Stale skill draft (note on `df1_skill_wait_stale`, already open)

The orchestrator named the following, all of which are already covered by the open task:

- `SKILL.md`: "Wait with `mu task wait`".
- `orchestrator-loop.md` step 4: "Exit 5: timeout" and `TODO(v_wait_surface)`. A heartbeat from `mu wait` is ok:true, exit 0.
- The "Delegate waves" paragraph. `mu wait` now takes `delegate:` refs and `--wave`.
- `TODO(v_hints)`, which says `next` is null.

Not filed: the orchestrator also called the two-step `agent close` (dogfood-1 F6, open) and finding commit shas for cherry-pick friction. The hint after the close gives the branch, so I counted the second one as working.

## Isolation

`~/.local/bin/mu`, `~/mu` and `~/.local/state/mu` were not written by `mun`. Their mtimes moved together with this crew's live 3.x traffic, including my own `mu task add/note` calls. `~` has no `mu-next` dir. `~/.local/state/mu-next/locks` moved to 13:18:44, while the crew's slow gates (`vitest`, started 13:15 and 13:21) were running. After that, `mun task list`, `wait` and `state` with the isolated env left it unchanged (stat before/after). Same pattern as dogfood-1 F10. pi wrote its session logs to `~/.pi/agent/sessions/--var-tmp-df2-*` (pi's own dir, outside mu's isolation). Scratch: `/var/tmp/df2`, 1.2 MB, kept for reproduction.
