# Cold-guess probe: mu-next vs 3.13.3 (no skill)

`e_cold_guess`, step 2 of `t_surface` pulled forward. Feeds `t_surface` (which verbs, flags and fields a cold reader reaches for) and `v_hints`. Not a scored scenario; no holdout is involved (the intents are one-liners, the holdouts are scenarios). **This is round 2.** Round 1 reported "57% vs 46%, mu-next reads cold better". That headline is withdrawn: one intent's wording (`Collect worker-2's commits`) named mu-next's verb `agent collect` and supplied the whole gap (49/90 vs 44/90 without it), and a post-hoc control sat in the headline. Round 2 changes the wording, the help depth and the reporting, below.

**Method.** The model gets only help text of the build under test (no skill, no tools, empty HOME) and one sentence, and answers with the single shell command it would run. That command runs in a fresh seeded sandbox (private DB, state and tmux; `MU_SYNC_DIR` blank; ssh host `dev` is the eval shim). A guess is a **hit** when the state or the command's own output shows the effect and it wrote nothing it should not have; spelling is never judged. Judges are proven first: `cold-guess check` runs a golden, a plausible bad and a no-op per intent on each surface (`tools/eval/cold-guess.ts`, `cold-intents.ts`, `cold-help.ts`; `test/eval/cold-guess*.test.ts`). 3 reps x haiku-5-5 + sonnet-5-5. Rows: [cold-guess.jsonl](cold-guess.jsonl). Reproduce (from the repo root, with a build and `prepare 3.13.3 v3.13.3`):

```bash
export MU_SYNC_DIR= MU_DB_PATH=$(mktemp -u) MU_STATE_DIR=$(mktemp -d)
node tools/eval/main.ts cold-guess run --surface "next=$PWD:next" --surface "3.13.3=3.13.3:3x" \
  --model modelbridge/anthropic/claude-haiku-5-5 --model modelbridge/anthropic/claude-sonnet-5-5 \
  --reps 3 --out docs/mu-next/eval/cold-guess.jsonl
node tools/eval/main.ts cold-guess report docs/mu-next/eval/cold-guess.jsonl   # the tables below
```

What round 2 fixed, and how it is enforced:

- **Neutral wording, linted.** No request uses a command, subcommand or flag name of either surface, at any depth (`surfaceVocab` walks every `--help`; plurals count; only the quoted payload of `close_with_evidence` and `sql_read`, and ten grammar words such as `for` and `from`, are exempt). `cold-guess run` refuses to start on a leak, and `cold-guess.integration.test.ts` runs the lint against the built checkout and the 3.13.3 surface. "Collect" became "bring worker-2's unmerged work from machine dev into the git repository here"; "needs a human" (next has `human-needed`) became "awaiting a person's decision"; "workstream" became "initiative called auth" (a bare "auth project" made both models write `-w hail-auth`, a 60-guess pilot that was thrown away).
- **Same help depth.** Both surfaces get `mu --help` followed by `mu <group> --help` for every group with subcommands (next 31.0 kB, 3.13.3 25.0 kB of help text; next's is bigger because it has more verbs, and its mean prompt is 9.0k vs 7.6k tokens). Round 1 showed `mu --help` only, so every subcommand was invisible on both surfaces and a hit measured whether the request's word matched a hidden verb name.
- **Pre-registered headline, controls apart.** Every intent carries a `role` in `cold-intents.ts`, fixed before the run: 14 pre-registered intents both surfaces can express are the headline; `delegates_wave` (next only) is reported on its own; `spawn_remote_named` and `add_three_titled` are controls and never enter the headline. The unit is the intent: a win or a loss needs a gap of 2 or more hits of 6 (reps and models of one intent share a cause), anything smaller is a tie.

## Findings

- **Headline, 14 intents, 84 guesses per surface: next 92% (77/84), 3.13.3 71% (60/84). Per intent: 3 wins for next, 0 losses, 11 ties.** Both models agree (sonnet 93 vs 71, haiku 90 vs 71). Read it by intent, not as 21 points: the three wins are three surface differences, and the other 11 intents read the same on both.
- **The three wins are real surface differences, not wording** (the wording is linted):
  1. `collect_commits` 6/6 vs 0/6: next has `agent collect`; 3.x has no verb to fetch a remote worker's commits (5/6 guessed `git fetch "$(mu workspace path worker-2)"`, which has no workspace). The round-1 win survives neutral wording, so it was never only the leak; what is gone is the round-1 size of the gap: `needs_human` and `log_tail`, which next lost in round 1, are ties now that the wording no longer names next's `human-needed` or invites `--tail`.
  2. `add_three` 6/6 vs 0/6 (control `add_three_titled` the same): next's `task add n1 n2 n3 -t ... -t ...` needs no score; 3.x requires `-i/--impact` and `-e`, and 12 of 12 guesses (both intents) omitted them. The test is "does the surface accept what a reader types", not "does the reader know a hidden flag".
  3. `spawn_remote` 5/6 vs 0/6: next has `--host`; 3.13.3's `agent spawn` has no `--host` (`unknown option '--host'` in 4 of 6 guesses; the 3.x spelling is an ssh recipe). **Caveat:** 5 of next's 5 hits omit `--task t5` (the judge asks for an agent and a pane on `dev`, and allows a claim, but does not demand the task link). The one guess that added `--task` missed (`--task needs --send`), and so did all 6 guesses on the named control. Read this win as "reaches the host flag", not "starts the task remotely".
- **Eleven ties.** Ten are 6/6 on both (`owner_of`, `task_brief`, `blocked_by_t1`, `close_with_evidence`, `log_tail`, `needs_human`, `reopen`, `sql_read`, `worker_doing`, `list_workstreams`); `stop_worker` is 0/6 on both. With subcommands visible, round 1's misses `task reopen` (verb is `task open`) and `blockers`-view SQL (needs `task tree --down`) went away on both surfaces: 12/12 `task open` and 12/12 `task tree t1 --down`. They were artefacts of hiding the subcommands, not findings about the surface.
- **`stop_worker`: 0/6 vs 0/6, but not the same zero.** On next 6/6 guesses were `agent close worker-3`, the correct first step: it previews with the `--if <rev>` apply and loses nothing (counted *partial*, not a hit, because the worker is still registered). On 3.x the same guess is refused ("has a workspace", 2/6) and the rest are `agent abort` / `workspace free` that fail or half-apply. Zero destructive guesses on either surface. No hit counted for a preview; with it next would be 6/6, which would be a 4th win for next, and that is not claimed.
- **Controls** (reported apart): `add_three_titled` 6/6 vs 0/6 (same cause as `add_three`); `spawn_remote_named` 0/6 vs 0/6: next's reader types `--task t5` and is refused with `--task needs --send` (6/6; the error is clear, but the flag pair is unguessable from the help), 3.x's reader types `--host`.
- **`delegates_wave` (next only, pre-registered): 3/6.** Two misses are a real bug: `mu -w auth delegates tally --wave w1` (global `-w` before the verb) dies `TypeError: value.trim is not a function` (`-w` after the verb works). Filed as `bug_delegates_global_w_not_a_string`. The third miss is `delegates list --all` without `--wave`.
- **`log --tail 20` writes a record on both surfaces; no round-2 guess typed it.** `--tail` is a boolean flag on both next and 3.13.3 (reproduced on temp DBs): `mu log -w auth --tail 20` exits 0 and appends a log record `20`, so a read writes. It is not a mu-next regression. In round 1 only next's rows guessed `--tail` (2/6; the 3.x misses were `--limit`), so it was mislabelled a shared miss. In round 2, with the neutral request ("newest entries of the journal"), all 12 guesses on both surfaces ran `-n 20`; in 6 replies the model considered `--tail`, read it as "blocks and prints new entries" and rejected it. So the round-1 hazard came from the old wording ("last 20 log records") plus next's one-line help for `log`, and the neutral wording does not reproduce it. The hazard is real wherever a reader reaches for `--tail N`; the fix is tracked in `bug_log_tail_n_writes`. Not in the headline.
- **No destructive guess, no stray write, every guess parsed (198/198).** The command exited 0 in 93 of 102 guesses on next and 63 of 96 on 3.13.3.
- **First reach, per intent, with counts** is in the "First verb reached" table below; the full per-guess record (`reply`, `command`, every mu call's argv, `firstError`, `why`) is in the jsonl.

## Caveats

- One command per intent, no retry: this measures the first reach from `--help`, not whether a model recovers after one error (that is the scenario matrix). Reps are highly correlated (temperature is the harness default); read a 0/6 or 6/6 as one finding, not six. No interval is computed on guesses for that reason; the win/loss/tie count is the reading.
- 14 intents is a small sample of an orchestrator's day and each is one sentence. A tie on an intent means this wording did not separate the surfaces, not that the surfaces are equal everywhere.
- The wording change and the help-depth change were made together, so this run cannot say how much each moved round 1's numbers.
- The bundle holds `mu --help` and the groups that have subcommands, the same rule on both surfaces; a leaf verb's own `--help` (`log`, `sql`, `state`) is not in it, so flags such as `log -n` are guessed from the one-line description on both. The bundle is longer for next than for 3.x. A longer help can hide a verb as easily as show one; it is not equalised.
- `delegates_wave` has no 3.x spelling and is not run there. Seeds on next go through `PI_SESSION_ID` identity for `human-needed` and `delegates register`; the guess runs with the same identity.

## Method (from the rows)

198 guesses; builds: next = mu 3.13.3+87eec06 (help 4e92a542b934); 3.13.3 = mu 3.13.3+fcc4259 (help aac178d9fe04); models: claude-sonnet-5-5, claude-haiku-5-5; 3 reps. The model got only the bundled help (`mu --help` plus `mu <group> --help` of every group, the same depth on every surface; no skill, no tools) and one sentence; its single command ran in a fresh seeded sandbox. **Hit** = the state or the command's own output shows the effect, with no stray write (judged by state, never spelling). **Partial** = a miss that was the right first step (a close preview whose `--if` apply was not run).

## Intents

| Intent | Group | Request (verbatim) |
| --- | --- | --- |
| owner_of | tasks | Which worker is assigned t3 in the initiative called auth? |
| task_brief | tasks | Print the original brief that t3 in the initiative called auth was given. |
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
| stop_worker | agents | Stop worker-3 in the initiative called auth safely: it has work that is not merged yet. |
| worker_doing | agents | What is worker-1 doing right now (initiative called auth)? |
| list_workstreams | workstream | Which separate initiatives does mu currently track? |

## Headline: the 14 pre-registered intents every surface ran

| Surface | Model | Hit (14 intents) | Parsed | Exit 0 | Destructive | Stray ops | Mean tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| next | claude-sonnet-5-5 | 93% (39/42) | 100% (42/42) | 100% (42/42) | 0 | 0 | 8910 |
| next | claude-haiku-5-5 | 90% (38/42) | 100% (42/42) | 98% (41/42) | 0 | 0 | 9186 |
| next | both | 92% (77/84) | 100% (84/84) | 99% (83/84) | 0 | 0 | 9048 |
| 3.13.3 | claude-sonnet-5-5 | 71% (30/42) | 100% (42/42) | 76% (32/42) | 0 | 0 | 7478 |
| 3.13.3 | claude-haiku-5-5 | 71% (30/42) | 100% (42/42) | 74% (31/42) | 0 | 0 | 7669 |
| 3.13.3 | both | 71% (60/84) | 100% (84/84) | 75% (63/84) | 0 | 0 | 7573 |

**Per intent, next vs 3.13.3: 3 wins, 0 losses, 11 ties.** The intent, not the guess, is the unit: reps and models of one intent share a cause, so the guess-level percentage above is not an interval. A win or loss needs a gap of at least 2 hits (of 6 guesses); a smaller gap is a tie.

| Intent | next hit | 3.13.3 hit | Result |
| --- | --- | --- | --- |
| owner_of | 6/6 | 6/6 | tie |
| task_brief | 6/6 | 6/6 | tie |
| blocked_by_t1 | 6/6 | 6/6 | tie |
| close_with_evidence | 6/6 | 6/6 | tie |
| spawn_remote | 5/6 | 0/6 | next wins |
| collect_commits | 6/6 | 0/6 | next wins |
| log_tail | 6/6 | 6/6 | tie |
| needs_human | 6/6 | 6/6 | tie |
| add_three | 6/6 | 0/6 | next wins |
| reopen | 6/6 | 6/6 | tie |
| sql_read | 6/6 | 6/6 | tie |
| stop_worker | 0/6 | 0/6 | tie |
| worker_doing | 6/6 | 6/6 | tie |
| list_workstreams | 6/6 | 6/6 | tie |

Pre-registered but run on one surface only (not in the headline): delegates_wave (50% (3/6)).

## Controls (added after the first pass; not in the headline)

| Control | next hit | 3.13.3 hit |
| --- | --- | --- |
| spawn_remote_named | 0% (0/6) | 0% (0/6) |
| add_three_titled | 100% (6/6) | 0% (0/6) |

## Hit rate per intent

Each cell: hits/guesses over both models and all reps; then the modal first reach of the misses. `-` = the surface has no way to do it.

| Intent | Group | Role | next hit | 3.13.3 hit | next modal miss | 3.13.3 modal miss |
| --- | --- | --- | --- | --- | --- | --- |
| owner_of | tasks | headline | 100% (6/6) | 100% (6/6) |  |  |
| task_brief | tasks | headline | 100% (6/6) | 100% (6/6) |  |  |
| blocked_by_t1 | tasks | headline | 100% (6/6) | 100% (6/6) |  |  |
| close_with_evidence | tasks | headline | 100% (6/6) | 100% (6/6) |  |  |
| spawn_remote | host | headline | 83% (5/6) | 0% (0/6) | agent spawn --host --task --worktree (1/1) | agent spawn --host --task (2/6) |
| spawn_remote_named | host | control | 0% (0/6) | 0% (0/6) | agent spawn --host --task --worktree (5/6) | agent spawn --host --task (3/6) |
| collect_commits | host | headline | 100% (6/6) | 0% (0/6) |  | workspace path (5/6) |
| log_tail | log | headline | 100% (6/6) | 100% (6/6) |  |  |
| needs_human | state | headline | 100% (6/6) | 100% (6/6) |  |  |
| add_three | tasks | headline | 100% (6/6) | 0% (0/6) |  | task add --title (5/6) |
| add_three_titled | tasks | control | 100% (6/6) | 0% (0/6) |  | task add --title (6/6) |
| reopen | tasks | headline | 100% (6/6) | 100% (6/6) |  |  |
| delegates_wave | delegates | headline | 50% (3/6) | - | delegates tally --wave (2/3) |  |
| sql_read | db | headline | 100% (6/6) | 100% (6/6) |  |  |
| stop_worker | agents | headline | 0% (0/6) +6 partial | 0% (0/6) | agent close (6/6) | agent close (2/6) |
| worker_doing | agents | headline | 100% (6/6) | 100% (6/6) |  |  |
| list_workstreams | workstream | headline | 100% (6/6) | 100% (6/6) |  |  |

## Hit rate per intent and model

| Intent | next claude-sonnet-5-5 | next claude-haiku-5-5 | 3.13.3 claude-sonnet-5-5 | 3.13.3 claude-haiku-5-5 |
| --- | --- | --- | --- | --- |
| owner_of | 3/3 | 3/3 | 3/3 | 3/3 |
| task_brief | 3/3 | 3/3 | 3/3 | 3/3 |
| blocked_by_t1 | 3/3 | 3/3 | 3/3 | 3/3 |
| close_with_evidence | 3/3 | 3/3 | 3/3 | 3/3 |
| spawn_remote | 3/3 | 2/3 | 0/3 | 0/3 |
| spawn_remote_named | 0/3 | 0/3 | 0/3 | 0/3 |
| collect_commits | 3/3 | 3/3 | 0/3 | 0/3 |
| log_tail | 3/3 | 3/3 | 3/3 | 3/3 |
| needs_human | 3/3 | 3/3 | 3/3 | 3/3 |
| add_three | 3/3 | 3/3 | 0/3 | 0/3 |
| add_three_titled | 3/3 | 3/3 | 0/3 | 0/3 |
| reopen | 3/3 | 3/3 | 3/3 | 3/3 |
| delegates_wave | 2/3 | 1/3 | - | - |
| sql_read | 3/3 | 3/3 | 3/3 | 3/3 |
| stop_worker | 0/3 | 0/3 | 0/3 | 0/3 |
| worker_doing | 3/3 | 3/3 | 3/3 | 3/3 |
| list_workstreams | 3/3 | 3/3 | 3/3 | 3/3 |

## Hit rate per verb group (headline intents)

| Group | next hit | 3.13.3 hit |
| --- | --- | --- |
| tasks | 100% (36/36) | 83% (30/36) |
| host | 92% (11/12) | 0% (0/12) |
| log | 100% (6/6) | 100% (6/6) |
| state | 100% (6/6) | 100% (6/6) |
| delegates | - | - |
| db | 100% (6/6) | 100% (6/6) |
| agents | 50% (6/12) | 50% (6/12) |
| workstream | 100% (6/6) | 100% (6/6) |

## First verb reached (all guesses)

| Intent | next first reach (count) | 3.13.3 first reach (count) |
| --- | --- | --- |
| owner_of | task show ×6 | task show ×6 |
| task_brief | task notes ×3; task notes --all ×2; task show --note ×1 | task show ×6 |
| blocked_by_t1 | task tree --down ×6 | task tree --down ×6 |
| close_with_evidence | task close --evidence ×4; task close --as --evidence ×2 | task note ×4; task close --as --why ×2 |
| spawn_remote | agent spawn --host --worktree ×5; agent spawn --host --task --worktree ×1 | agent spawn --host --task ×2; agent spawn --claim --host ×1; agent spawn --host ×1 |
| spawn_remote_named | agent spawn --host --task --worktree ×5; agent spawn --host --task ×1 | agent spawn --host --task ×3; agent spawn --host ×2; agent spawn --remote --task ×1 |
| collect_commits | agent collect ×6 | workspace path ×5; (no mu call) ×1 |
| log_tail | log -n ×6 | log -n ×6 |
| needs_human | sql [tasks] ×3; state --full ×1; task list ×1 | state ×6 |
| add_three | task add -t ×6 | task add --title ×5; task add ×1 |
| add_three_titled | task add -t ×6 | task add --title ×6 |
| reopen | task open ×6 | task open ×6 |
| delegates_wave | delegates list --all --wave ×2; delegates tally --wave ×2; delegates list --wave ×1 |  |
| sql_read | sql [tasks] ×6 | sql [tasks] ×6 |
| stop_worker | agent close ×6 | agent close ×2; agent abort ×2; workspace free --commit ×2 |
| worker_doing | agent show ×6 | agent show ×6 |
| list_workstreams | workstream list ×6 | workstream list ×6 |

## Top wrong guesses

### next

| × | Intent · first reach | Example command | Why it missed | First error line |
| --- | --- | --- | --- | --- |
| 6 | stop_worker · agent close | `mu agent close worker-3 -w auth` | worker-3 still registered |  |
| 5 | spawn_remote_named · agent spawn --host --task --worktree | `mu agent spawn worker-1 -w auth --host dev --worktree --task t5` | no agent registered | error: --task needs --send: the sent text is the task's brief |
| 2 | delegates_wave · delegates tally --wave | `mu -w auth delegates tally --wave w1 --json` | exit 1 | {"ok":false,"error":"TypeError","message":"value.trim is not a function","next":null,"exit":1,"nextSteps":[]} |
| 1 | spawn_remote · agent spawn --host --task --worktree | `mu -w auth agent spawn --host dev --worktree --task t5 t5` | no agent registered | error: --task needs --send: the sent text is the task's brief |
| 1 | spawn_remote_named · agent spawn --host --task | `mu agent spawn worker-1 -w auth --host dev --task t5` | no agent registered | error: --task needs --send: the sent text is the task's brief |
| 1 | delegates_wave · delegates list --all | `mu -w auth delegates list --all` | output has dg-b1 |  |

### 3.13.3

| × | Intent · first reach | Example command | Why it missed | First error line |
| --- | --- | --- | --- | --- |
| 6 | add_three_titled · task add --title | `mu -w auth task add n1 --title parse && mu -w auth task add n2 --title index && mu -w auth task add n3 --title` | no task n1 | error: required option '-i, --impact <n>' not specified |
| 5 | collect_commits · workspace path | `git fetch "$(mu workspace path worker-2 -w auth)" HEAD:refs/heads/auth-worker-2` | the worker's commit is not in this repo | not found: no workspace for agent: worker-2 |
| 5 | add_three · task add --title | `mu -w auth task add n1 --title n1 && mu -w auth task add n2 --title n2 && mu -w auth task add n3 --title n3 --` | no task n1 | error: required option '-i, --impact <n>' not specified |
| 3 | spawn_remote_named · agent spawn --host --task | `mu -w auth agent spawn worker-1 --host dev --task t5` | no agent registered | error: unknown option '--host' |
| 2 | spawn_remote · agent spawn --host --task | `mu -w auth agent spawn --host dev --task t5 worker-t5` | no agent registered | error: unknown option '--host' |
| 2 | spawn_remote_named · agent spawn --host | `mu agent spawn worker-1 -w auth --host dev` | no agent registered | error: unknown option '--host' |
| 2 | stop_worker · agent close | `mu -w auth agent close worker-3` | worker-3 still registered | conflict: agent worker-3 has a workspace at /tmp/mu-eval-1661878-1792978634631-a4a58a/state/workspaces/auth/worker-3; refusing to close (would orphan the on-dis |
| 2 | stop_worker · agent abort | `mu -w auth agent abort worker-3 && mu -w auth workspace free worker-3 --commit && mu -w auth agent close worke` | worker-3 still registered | ctl unreachable: agent worker-3 has no control socket (ctl: missing) at /tmp/mu-eval-1661878-1792978635329-53df49/state/sock/auth/worker-3.sock; mu cannot send  |
| 2 | stop_worker · workspace free --commit | `mu -w auth workspace free worker-3 --commit` | worker-3 still registered | conflict: agent worker-3 is unknown: freeing its workspace would pull it out from under it |
| 1 | spawn_remote · agent spawn --claim --host | `mu -w auth agent spawn t5-worker --host dev --claim t5` | no agent registered | error: unknown option '--host' |
| 1 | spawn_remote · agent spawn --host | `mu agent spawn worker-t5 -w auth --host dev` | no agent registered | error: unknown option '--host' |
| 1 | spawn_remote · agent spawn --ssh | `mu -w auth agent spawn t5 --ssh dev` | no agent registered | error: unknown option '--ssh' |
