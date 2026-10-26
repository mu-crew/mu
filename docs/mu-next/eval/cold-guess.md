# Cold-guess probe: mu-next vs 3.13.3 (no skill)

`e_cold_guess`, step 2 of `t_surface` pulled forward. Feeds `t_surface` (which verbs, flags and fields a cold reader reaches for) and `v_hints`. Not a scored scenario; no holdout is involved (the intents are one-liners, the holdouts are scenarios).

**Method.** The model gets only the output of `mu --help` of the build under test (no skill, no tools, empty HOME) and one sentence, and answers with the single shell command it would run. That command runs in a fresh seeded sandbox (private DB, state and tmux; `MU_SYNC_DIR` blank; ssh host `dev` is the eval shim). A guess is a **hit** when the state or the command's own output shows the effect and it wrote nothing it should not have; spelling is never judged. Judges are proven first: `cold-guess check` runs a golden, a plausible bad and a no-op per intent on each surface (`tools/eval/cold-guess.ts`, `cold-intents.ts`; `test/eval/cold-guess*.test.ts`). 3 reps x haiku-5-5 + sonnet-5-5. Rows: [cold-guess.jsonl](cold-guess.jsonl). Reproduce (from the repo root, with a build and `prepare 3.13.3 v3.13.3`):

```bash
export MU_SYNC_DIR= MU_DB_PATH=$(mktemp -u) MU_STATE_DIR=$(mktemp -d)
node tools/eval/main.ts cold-guess run --surface "next=$PWD:next" --surface "3.13.3=3.13.3:3x" \
  --model modelbridge/anthropic/claude-haiku-5-5 --model modelbridge/anthropic/claude-sonnet-5-5 \
  --reps 3 --out docs/mu-next/eval/cold-guess.jsonl
node tools/eval/main.ts cold-guess report docs/mu-next/eval/cold-guess.jsonl   # the tables below
```

`next` is this checkout at 56e5d87 (`mu --version` still says 3.13.3); `wait` and the unified `mu wait` are not on it yet, so no intent asks for one.

## Findings

- **mu-next reads cold better, not well: 57% vs 46%** over the 16 intents both surfaces ran (96 guesses each, both models; haiku 58 vs 44, sonnet 56 vs 48). Every guess parsed; the command exited 0 in 71 of 102 guesses on next (all 17 intents) vs 45 of 96 on 3.13.3. The two models are within a rep of each other: the misses are the surface's, not the model's (most cells are 3/3 or 0/3).
- **No destructive guess on either surface.** `stop_worker` (unmerged commit) never lost work. The one hazard class is a read that writes: `mu log -w auth --tail 20` (2 of 6 on next) is a *write* on mu-next, because `--tail` is a boolean flag and `20` becomes the log text ("stray op" in the table: the log got a record `20`).
- **Where next beats 3.13.3, by design:** `agent collect` (6/6 vs 0/6: 3.x has no verb, the model guessed `workspace collect --host`), `task add ... --title` without `-i/-e` (6/6 vs 0/6), `task show --note` / `task show` for the brief (6/6 vs 3/6, haiku invented `task brief` on 3.x), `delegates --wave` (6/6; no 3.x verb). `needs_human` is the other way (3/6 vs 6/6): on 3.x `mu state` shows everything, on next half the guesses went to `mu sql ... kind='human'` and then used a column `state` or a table `task` that does not exist.
- **Six intents miss on both surfaces, and the misses are the same words:**
  1. `reopen`: **`task reopen`** 6/6 on both. The verb is `task open`. Cheapest alias in the set.
  2. `add_three`, bare ids with no titles: **`task add n1`** 6/6 on both. With titles in the request (`add_three_titled`) next is 6/6 and 3.x is 0/6 (`--impact` still required).
  3. `spawn_remote`: the model reaches the right flags (**`--host dev --task t5`**, 24/24 on both surfaces) and still misses twice: no agent *name* (`missing required argument 'name'`), and with a name, `--task` without `--send` (`--task needs --send`). 3.x has no `--task` at all (`unknown option '--task'`).
  4. `blocked_by_t1`: **`mu sql ... FROM blockers WHERE blocker_id = 't1'`** (5/6 on next went to the `blockers` view): `blockers.blocker_id` is the integer row id, `blocker_local_id` is `t1`, so the query returns nothing and exits 0 (a silent empty answer; `--blocked-by` on `task list` does not exist on either surface). The right answer on next is `task tree t1 --down` (never guessed: no hint of it in `--help`).
  5. `stop_worker`: **`agent stop`** (3/6 on both: unknown command). Sonnet's `agent close worker-3` is the right first step on next (3/3 previews with the `--if <rev>` apply, counted *partial*, not a hit: the intent is that the worker is stopped); on 3.x the same guess is refused (`has a workspace`).
  6. `log_tail`: `--tail 20` (next, above) and `--limit 20` (3.x).
- **First reach, per intent, with counts** is in the "First verb reached" table below; the full per-guess record (`reply`, `command`, every mu call's argv, `firstError`, `why`) is in the jsonl.

## Caveats

- One command per intent, no retry: this measures the first reach from `--help`, not whether a model recovers after one error (that is the scenario matrix). Reps are highly correlated (temperature is the harness default); read a 0/6 or 6/6 as one finding, not six.
- `spawn_remote_named` and `add_three_titled` were added after the first pass of 15 intents, to separate two causes of a miss; they are controls, not extra surface. The surface-wide rows count them; the "every surface ran" row counts all 16 shared intents.
- `delegates_wave` has no 3.x spelling and is not run there. Seeds on next go through `PI_SESSION_ID` identity for `human-needed` and `delegates register`; the guess runs with the same identity.

## Method (from the rows)

198 guesses; builds: next = mu 3.13.3+56e5d87 (help 5af3367b8215); 3.13.3 = mu 3.13.3+fcc4259 (help e5afb1ce73d0); models: claude-sonnet-5-5, claude-haiku-5-5; 3 reps. The model got only `mu --help` (no skill, no tools) and one sentence; its single command ran in a fresh seeded sandbox. **Hit** = the state or the command's own output shows the effect, with no stray write (judged by state, never spelling). **Partial** = a miss that was the right first step (a close preview whose `--if` apply was not run).

## Intents

| Intent | Group | Request (verbatim) |
| --- | --- | --- |
| owner_of | tasks | Who owns task t3 in workstream auth? |
| task_brief | tasks | Show me the brief of task t3 in workstream auth. |
| blocked_by_t1 | tasks | List the open tasks in workstream auth that are blocked by t1. |
| close_with_evidence | tasks | Close task t4 in workstream auth; the evidence is: gate green: npm test exit 0. |
| spawn_remote | host | Spawn a worker for task t5 (workstream auth) on the remote host dev. |
| collect_commits | host | Collect worker-2's commits (workstream auth) into this repo; worker-2 runs on host dev. |
| log_tail | log | Read the last 20 log records of workstream auth. |
| needs_human | state | What in workstream auth needs a human? |
| add_three | tasks | Add three tasks to workstream auth, n1, n2 and n3, where n2 blocks n3. |
| reopen | tasks | Reopen task t6 in workstream auth. |
| delegates_wave | delegates | Show the delegates in wave w1 (workstream auth). |
| sql_read | db | Run this SQL read against mu's database: SELECT local_id, title FROM tasks WHERE impact = 77 |
| stop_worker | agents | Stop worker-3 in workstream auth safely: it has a commit that is not merged yet. |
| worker_doing | agents | What is worker-1 doing right now (workstream auth)? |
| list_workstreams | workstream | List the workstreams. |
| spawn_remote_named | host | Spawn a worker named worker-1 for task t5 (workstream auth) on the remote host dev. |
| add_three_titled | tasks | Add three tasks to workstream auth: n1 titled parse, n2 titled index, n3 titled ship, where n2 blocks n3. |

## Hit rate per surface and model

| Surface | Version | Model | Hit | Parsed | Exit 0 | Partial | Destructive | Stray ops | Mean tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| next | 3.13.3+56e5d87 | claude-sonnet-5-5 | 59% (30/51) | 100% (51/51) | 75% (38/51) | 3 | 0 | 2 | 1823 |
| next | 3.13.3+56e5d87 | claude-haiku-5-5 | 61% (31/51) | 100% (51/51) | 65% (33/51) | 0 | 0 | 0 | 2028 |
| 3.13.3 | 3.13.3+fcc4259 | claude-sonnet-5-5 | 48% (23/48) | 100% (48/48) | 50% (24/48) | 0 | 0 | 0 | 1249 |
| 3.13.3 | 3.13.3+fcc4259 | claude-haiku-5-5 | 44% (21/48) | 100% (48/48) | 44% (21/48) | 0 | 0 | 0 | 1431 |

## Hit rate on the intents every surface ran

| Surface | Model | Hit (16 intents) |
| --- | --- | --- |
| next | claude-sonnet-5-5 | 56% (27/48) |
| next | claude-haiku-5-5 | 58% (28/48) |
| next | both | 57% (55/96) |
| 3.13.3 | claude-sonnet-5-5 | 48% (23/48) |
| 3.13.3 | claude-haiku-5-5 | 44% (21/48) |
| 3.13.3 | both | 46% (44/96) |

## Hit rate per intent

Each cell: hits/guesses over both models and all reps; then the modal first reach of the misses. `-` = the surface has no way to do it.

| Intent | Group | next hit | 3.13.3 hit | next modal miss | 3.13.3 modal miss |
| --- | --- | --- | --- | --- | --- |
| owner_of | tasks | 100% (6/6) | 100% (6/6) |  |  |
| task_brief | tasks | 100% (6/6) | 50% (3/6) |  | task brief (3/3) |
| blocked_by_t1 | tasks | 0% (0/6) | 0% (0/6) | sql [blockers] (3/6) | task list --blocked-by (2/6) |
| close_with_evidence | tasks | 100% (6/6) | 100% (6/6) |  |  |
| spawn_remote | host | 0% (0/6) | 0% (0/6) | agent spawn --host --task (6/6) | agent spawn --host --task (6/6) |
| collect_commits | host | 100% (6/6) | 0% (0/6) |  | workspace collect --host (4/6) |
| log_tail | log | 67% (4/6) | 83% (5/6) | log --tail (2/2) | log --limit (1/1) |
| needs_human | state | 50% (3/6) | 100% (6/6) | sql [tasks] (2/3) |  |
| add_three | tasks | 0% (0/6) | 0% (0/6) | task add (6/6) | task add (6/6) |
| reopen | tasks | 0% (0/6) | 0% (0/6) | task reopen (6/6) | task reopen (6/6) |
| delegates_wave | delegates | 100% (6/6) | - |  |  |
| sql_read | db | 100% (6/6) | 100% (6/6) |  |  |
| stop_worker | agents | 0% (0/6) +3 partial | 0% (0/6) | agent close (3/6) | agent stop (3/6) |
| worker_doing | agents | 100% (6/6) | 100% (6/6) |  |  |
| list_workstreams | workstream | 100% (6/6) | 100% (6/6) |  |  |
| spawn_remote_named | host | 0% (0/6) | 0% (0/6) | agent spawn --host --task (6/6) | agent spawn --host --task (6/6) |
| add_three_titled | tasks | 100% (6/6) | 0% (0/6) |  | task add --title (5/6) |

## Hit rate per intent and model

| Intent | next claude-sonnet-5-5 | next claude-haiku-5-5 | 3.13.3 claude-sonnet-5-5 | 3.13.3 claude-haiku-5-5 |
| --- | --- | --- | --- | --- |
| owner_of | 3/3 | 3/3 | 3/3 | 3/3 |
| task_brief | 3/3 | 3/3 | 3/3 | 0/3 |
| blocked_by_t1 | 0/3 | 0/3 | 0/3 | 0/3 |
| close_with_evidence | 3/3 | 3/3 | 3/3 | 3/3 |
| spawn_remote | 0/3 | 0/3 | 0/3 | 0/3 |
| collect_commits | 3/3 | 3/3 | 0/3 | 0/3 |
| log_tail | 1/3 | 3/3 | 2/3 | 3/3 |
| needs_human | 2/3 | 1/3 | 3/3 | 3/3 |
| add_three | 0/3 | 0/3 | 0/3 | 0/3 |
| reopen | 0/3 | 0/3 | 0/3 | 0/3 |
| delegates_wave | 3/3 | 3/3 | - | - |
| sql_read | 3/3 | 3/3 | 3/3 | 3/3 |
| stop_worker | 0/3 | 0/3 | 0/3 | 0/3 |
| worker_doing | 3/3 | 3/3 | 3/3 | 3/3 |
| list_workstreams | 3/3 | 3/3 | 3/3 | 3/3 |
| spawn_remote_named | 0/3 | 0/3 | 0/3 | 0/3 |
| add_three_titled | 3/3 | 3/3 | 0/3 | 0/3 |

## Hit rate per verb group

| Group | next hit | 3.13.3 hit |
| --- | --- | --- |
| tasks | 57% (24/42) | 36% (15/42) |
| host | 33% (6/18) | 0% (0/18) |
| log | 67% (4/6) | 83% (5/6) |
| state | 50% (3/6) | 100% (6/6) |
| delegates | 100% (6/6) | - |
| db | 100% (6/6) | 100% (6/6) |
| agents | 50% (6/12) | 50% (6/12) |
| workstream | 100% (6/6) | 100% (6/6) |

## First verb reached (all guesses)

| Intent | next first reach (count) | 3.13.3 first reach (count) |
| --- | --- | --- |
| owner_of | task show ×6 | task show ×6 |
| task_brief | task show ×6 | task brief ×3; task show ×3 |
| blocked_by_t1 | sql [blockers] ×3; sql [blockers,tasks] ×2; task list --blocked-by --status ×1 | task list --blocked-by ×2; sql [task_edges,tasks] ×2; task list ×1 |
| close_with_evidence | task close --evidence ×6 | task close --evidence ×6 |
| spawn_remote | agent spawn --host --task ×6 | agent spawn --host --task ×6 |
| collect_commits | agent collect ×6 | workspace collect --host ×4; workspace pull --host ×1; workspace merge --host ×1 |
| log_tail | log ×2; log -n ×2; log --tail ×2 | log -n ×4; log ×1; log --limit ×1 |
| needs_human | sql [tasks] ×4; sql [task] ×1; state ×1 | state ×6 |
| add_three | task add ×6 | task add ×6 |
| reopen | task reopen ×6 | task reopen ×6 |
| delegates_wave | delegates --wave ×5; delegates list --wave ×1 |  |
| sql_read | sql [tasks] ×6 | sql [tasks] ×6 |
| stop_worker | agent close ×3; agent stop --collect ×2; agent stop ×1 | agent stop ×3; agent close ×3 |
| worker_doing | state ×6 | state ×5; agent show ×1 |
| list_workstreams | workstream list ×6 | workstream list ×6 |
| spawn_remote_named | agent spawn --host --task ×6 | agent spawn --host --task ×6 |
| add_three_titled | task add --title ×6 | task add --title ×5; task add --id --title ×1 |

## Top wrong guesses

### next

| × | Intent · first reach | Example command | Why it missed | First error line |
| --- | --- | --- | --- | --- |
| 6 | spawn_remote · agent spawn --host --task | `mu agent spawn -w auth --host dev --task t5` | no agent registered | error: missing required argument 'name' |
| 6 | add_three · task add | `mu -w auth task add n1 && mu -w auth task add n2 && mu -w auth task add n3 --blocked-by n2` | no task n1 | error: required option '-t, --title <title>' not specified |
| 6 | reopen · task reopen | `mu task reopen t6 -w auth` | t6 is CLOSED | error: unknown command 'reopen' |
| 6 | spawn_remote_named · agent spawn --host --task | `mu agent spawn worker-1 -w auth --task t5 --host dev` | no agent registered | error: --task needs --send: the sent text is the task's brief |
| 3 | blocked_by_t1 · sql [blockers] | `mu sql -w auth "SELECT * FROM blockers WHERE blocker_id = 't1'"` | t2 not listed |  |
| 3 | stop_worker · agent close | `mu -w auth agent close worker-3` | worker-3 still registered |  |
| 2 | blocked_by_t1 · sql [blockers,tasks] | `mu -w auth sql "SELECT b.task_id FROM blockers b JOIN tasks t ON t.id = b.task_id WHERE b.blocker_id = 't1' AN` | t2 not listed |  |
| 2 | log_tail · log --tail | `mu log -w auth --tail 20` | output lacks LOGREC-24 |  |
| 2 | needs_human · sql [tasks] | `mu sql -w auth "SELECT * FROM tasks WHERE kind = 'human' AND state <> 'closed'"` | exit 2 | {"ok":false,"error":"SqlColumnError","message":"no such column: state (did you mean status, substate?). columns: tasks(id, workstream_id, local_id, title, statu |
| 2 | stop_worker · agent stop --collect | `mu -w auth agent stop worker-3 --collect` | worker-3 still registered | error: unknown command 'stop' |
| 1 | blocked_by_t1 · task list --blocked-by --status | `mu -w auth --json task list --blocked-by t1 --status open` | exit 2 | {"ok":false,"error":"CommanderError","message":"unknown option '--blocked-by'","next":null,"exit":2,"nextSteps":[],"usage":["mu task list [options]","options: - |
| 1 | needs_human · sql [task] | `mu sql -w auth "select * from task where kind='human' and status!='CLOSED'"` | exit 1 | {"ok":false,"error":"SqliteError","message":"no such table: task","next":null,"exit":1,"nextSteps":[]} |

### 3.13.3

| × | Intent · first reach | Example command | Why it missed | First error line |
| --- | --- | --- | --- | --- |
| 6 | spawn_remote · agent spawn --host --task | `mu -w auth agent spawn --task t5 --host dev` | no agent registered | error: unknown option '--task' |
| 6 | add_three · task add | `mu -w auth task add n1 && mu -w auth task add n2 && mu -w auth task add n3 --blocked-by n2` | no task n1 | error: required option '-t, --title <title>' not specified |
| 6 | reopen · task reopen | `mu task reopen t6 -w auth` | t6 is CLOSED | error: unknown command 'reopen' |
| 6 | spawn_remote_named · agent spawn --host --task | `mu -w auth agent spawn worker-1 --task t5 --host dev` | no agent registered | error: unknown option '--task' |
| 5 | add_three_titled · task add --title | `mu -w auth task add n1 --title parse && mu -w auth task add n2 --title index && mu -w auth task add n3 --title` | no task n1 | error: required option '-i, --impact <n>' not specified |
| 4 | collect_commits · workspace collect --host | `mu -w auth workspace collect worker-2 --host dev` | the worker's commit is not in this repo | error: unknown command 'collect' |
| 3 | task_brief · task brief | `mu -w auth task brief t3` | exit 2 | error: unknown command 'brief' |
| 3 | stop_worker · agent stop | `mu -w auth agent stop worker-3` | worker-3 still registered | error: unknown command 'stop' |
| 3 | stop_worker · agent close | `mu agent close worker-3 -w auth` | worker-3 still registered | conflict: agent worker-3 has a workspace at /tmp/mu-eval-1419900-1792976265238-3e7f57/state/workspaces/auth/worker-3; refusing to close (would orphan the on-dis |
| 2 | blocked_by_t1 · task list --blocked-by | `mu -w auth task list --blocked-by t1` | exit 2 | error: unknown option '--blocked-by' |
| 2 | blocked_by_t1 · sql [task_edges,tasks] | `mu -w auth sql "SELECT t.* FROM tasks t JOIN task_edges e ON e.to_id = t.id WHERE e.from_id = 't1' AND t.statu` | exit 2 | error: `sql` takes no -w/--workstream; drop the root -w |
| 1 | blocked_by_t1 · task list | `mu task list -w auth --json` | output has open t5 |  |
