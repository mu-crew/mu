# hill-r2 tournament rig: next-step probe, tournament driver, exposure-gated scoring

Status: draft for refutation (task `b1_rig_spec`, workstream `crew-hill2`). It binds B2 (`nextstep_probe`), B3 (`tournament_driver`) and B4 (`intents_scenarios`). Plan of record: `mu task notes hill2 -w crew-hill2` (brief plus REVISION 1). Every REVISION 1 Phase-B requirement maps to a section here; the table at the end checks each one off.

## 0. Why this rig, and what it must not repeat

The last round's hill-climbs (`git show 799cd4bb^:docs/mu-next/eval/hillclimb-{skill,surface,errors}.jsonl`) produced three lessons. This design is built around them.

- **R4 alone cannot separate text variants.** The skill climb scored `cost = tokens + 10*muErrors + 50*wrong` per rep on 14 scenarios × haiku × 3 reps. The base spread was 694k tokens per rep, and steps 1-3 all fell inside it. Four steps cost 46.8M AUT tokens and 3h40, and one 42-word cut survived, on the tie rule (`stop` row).
  - So R4 here is a no-regression gate on scenarios that show the changed text. The discovery signal comes from cheap, paired, effect-judged probes.
- **Unseen text cannot win.** The `setup` row's exposure field says SKILL.md was read in 56 of 62 runs and recipes in at most 11. A recipe variant is invisible unless the run reads it.
- **Raw destructive counts block on noise.** The `t_errors` host-check step was dropped twice on raw counts: 2→3, then 0→1. That happened even though no entry was about the changed line: one run never saw the line, and the others were the same `rm -rf` cleanup pattern seen on base (`r4_score.destructive_note`, `compare.destructive_note`). Destructive ops must therefore be attributed to the variant. Anything new against base still stops the run for a person.

Fixed rules (user decisions, 2026-11-07, in the `hill2` brief):

- Weak players are `claude-haiku-5-5` and `gemini-3.8-flash`; the gate is `claude-sonnet-5-5`.
- A destructive action counts only when it is attributable to the variant.
- There is no budget limit; the target is result quality.
- The four holdouts (`worker_dies`, `wait_receipt_race`, `wrong_id`, `single_channel_host`) are never tuned, never mined for cases, never run mid-round, and their transcripts are never read mid-round.

**Precondition (B0, `b0_gemini_smoke`).** All three models must answer through `askModel` (`tools/eval/cold-guess.ts:160`: `pi -p --offline`, empty HOME, auth only via `--provider-ext`) and through `runAut` (`tools/eval/runner.ts`).
- A group's `setup` row records the B0 proof: model ids, the provider extension, and one probe row per model.
- The driver refuses to start a group without it. If gemini cannot run, the group does not start on haiku alone. That goes back to the user.

## 1. The next-step probe

A one-shot reading test of the surface in the middle of a session. The question it answers: given what mu just printed, does the model's next move get the job done?

### 1.1 Inputs

1. **Skill arm.** Each case lists its arms when it is frozen, and every arm in the list runs.
   - `none`: no skill text.
   - `skill`: the surface's `skills/mu/SKILL.md`, frontmatter included, verbatim.
   - `recipe:<name>`: SKILL.md plus `skills/mu/recipes/<name>.md`.
   - The text always comes from the surface under test (the variant's own copy), never from the checkout.
   - No help bundle in any arm. The transcript is the context. A `--help` command in the answer runs, but its output is never shown, so it only spends one of the three steps.
2. **Transcript, generated live.** Per row, the rig creates a fresh sandbox (`createSandbox`, `tools/eval/sandbox.ts:530`) on the surface under test, runs the case's `seed`, then runs each lead-in step as the orchestrator and captures what it actually printed. Nothing is canned.
   - Every step runs as `{ <cmd> ; } 2>&1` under the case's shell (bash, or zsh where the case says so) in `sb.repoDir`, with the orchestrator env (`PI_SESSION_ID=nextstep-orch`).
   - This merges stdout and stderr the way a shell tool result does, so a heartbeat line lands in the middle of the JSON, as it did in the friction.
   - A non-zero exit adds `Command exited with code N`, the pi format that `tools/eval/events.ts:153` parses. A step killed at its `killAfterMs` adds `Command timed out after <s> seconds`.
   - Rendered form:
     ```
     $ <cmd>
     <merged output, ANSI kept exactly as the surface printed it>
     [Command exited with code N]
     ```
   - The **last** step is a mu call (or a pipeline whose first command is mu). Its output (a result, a `next:` hint, an error, a notice) is what the case is about.
3. **Goal.** One sentence from the user, one per paraphrase (§1.4).

**System prompt (fixed; its sha goes in every row).**

> You orchestrate a crew of AI agents with a command-line tool called `mu`, and you are in the middle of a session. [arm text: "Below is the mu skill you loaded." `<skill>…</skill>`, and `<recipe name="…">…</recipe>` for a recipe arm.] Your shell tool runs one command per call in the project's git repo and kills a call after 120 seconds. Below are the last commands you ran and what each printed, then the user's goal. Answer with the next one to three commands that achieve the goal, each in its own ```sh fenced block, in the order to run them. You will not see any output before the last one has run. Names in the transcript and the goal are exact.

The user message is `<transcript>…</transcript>\n\nGoal: <goal>`. The model runs through `askModel` unchanged: `--no-tools`, empty HOME, the harness's default temperature.

### 1.2 Answer and execution

- **Extraction** (`extractCommands`, new). Every fenced block in the reply is one command, and a block may span several lines (one tool call).
  - No fence: the first line that runs mu, as in `extractCommand`.
  - Zero commands is a miss: `no command`.
  - More than three blocks is a miss, `more than 3 commands`, and nothing runs.
- **Execution.** In the **same** sandbox the lead-in left. Each command runs in order through `execGuess(sb, cmd, limitMs)` (`cold-guess.ts:255`, gaining a `shell` parameter), with the case's shell and `limitMs` (default 120 000; the kill is real). The rig calls the case's `go(sb, state)` hook just before the first command, which releases any worker gated on `<workers>/go` (§2), so timing is measured from the answer, not from the model's latency.
- **Recorded per command:** exit, `killed`, ms, stdout, stderr. Also recorded: every mu call the answer made (the shim's `mu-calls.log`, `start >= t0`) and each call's own stdout (`mu-out/<pid>`).

### 1.3 Judging: by state and mu's own output, never spelling

A judge gets `NextCtx` (below). It may read:

- the DB through `openProbe`,
- the ops after the lead-in (`opsSince(sb, base)`),
- git,
- `mu-calls.log` and `mu-out`,
- the workers' `prompts.log` and `runs.log`,
- each answer command's run record.

It never matches a mu verb, a flag, a hint string or an exit code, the rule of `tools/eval/README.md` "Judges assert effects, not spellings".

**"Printed" (`shown(ctx, marker)`) requires two things:**
1. some answer mu call's own stdout (`mu-out`) contains the marker, **and**
2. the answer's combined output contains it (so the model would see it, not a pipe that dropped it).

`echo <marker>` does not satisfy condition 1. This is what keeps a marker that already appears in the transcript from being echoed back for a hit.

**Hit** = the judge's effect holds, no stray op (as in cold-guess: an op the case's `allow` does not name), no command killed unless the case allows it, and no destructive effect.

**Partial** = the case's own "right direction" condition. It is reported, never counted as a hit.

**Destructive entries** come from the effect rules every judge already shares:
- `destructiveOps`, `localWrites`, `lostWork` (`tools/eval/observe.ts:407,443,340`),
- the `DESTRUCTIVE` regexes on the answer's commands (`tools/eval/score.ts:7`).

A probe row is exposed by construction (§5.1), so a destructive entry on an exposed variant row is attributable (§5.2).

### 1.4 Paraphrases and lint

**Paraphrases.**
- Each case ships three paraphrases (`p1`-`p3`) of its goal.
- They must use **different content words for the key noun or verb** (report / answer / findings; finish / remove / clean up), so that a word a variant turns into a flag cues at most one paraphrase.
- A paraphrase may also pick lead-in variant `a` or `b`, for example the wait output read raw versus piped through `jq`.
- Paraphrases replace correlated reps (`docs/eval/cold-guess.md`: "reps are highly correlated").

**Lint** (`nextstep lint`; `run` refuses to start on any failure):

1. **Goal neutrality.** `neutralityLeaks` (`tools/eval/cold-help.ts`) over each goal against the vocab of every surface in the round, base and all variants, with `payload` exempt.
   - A goal that leaks a **base** name is a lint failure: fix the case before freezing.
   - A goal that leaks only a name a **variant** introduced is marked `nameCue` for that variant's rows of that paraphrase. Those rows are scored apart (§4.3), and the run continues: the designer never saw the goal, so the name is not taught to the test, but it still cues the answer.
2. **Lead-in verbs.** Each case lists `leadInVerbs`, the first-reach verbs (`firstReach`, `cold-guess.ts:79`) its lead-in may use. A lead-in that uses another verb fails the lint, which keeps a case from demonstrating its own answer earlier in the transcript.
3. **Lead-in stays valid on each variant.** A lead-in is spelled in base grammar. If a variant makes a lead-in step fail where base succeeds (exit status class differs, or the step's `expect` fails), every row of that case on that variant is `invalid`, scored as a miss. A variant must keep base spellings working; this is the old rule "a winner becomes the main spelling with the old one kept as an alias" (`docs/history/mu-next-design/README.md` ~l.590).
   - `expect` may check only surface-independent preconditions, such as "the worker's commit exists" or "t1 is still open". It never checks output text. A variant whose lead-in already reaches the goal (for example, a clean close applied in one call) is judged normally: the end state hits and a no-op answer is fine.

### 1.5 Interface (B2 owns `tools/eval/nextstep.ts`; B4 fills `tools/eval/nextstep-cases.ts`)

```ts
export type Arm = "none" | "skill" | `recipe:${string}`;
export type Group = "c1_wait" | "c2_close" | "c3_notes" | "c4_read" | "c5_outcome" | "c6_skill" | "guard";

export interface LeadStep {
  cmd: string;
  killAfterMs?: number;            // a step the shell kills (wait_shell_limit)
  expect?: (sb: Sandbox, st: Record<string, string>) => Promise<string | null>; // surface-independent precondition
}

export interface NextCase {
  id: string;
  group: Group;
  /** headline: scored for its group; guard: no-regression only (R2, every group). */
  role: "headline" | "guard";
  arms: Arm[];                     // frozen
  shell: "bash" | "zsh";
  limitMs?: number;                // default 120_000
  paraphrases: { id: "p1" | "p2" | "p3"; goal: string; payload?: string; leadIn: "a" | "b" }[];
  leadInVerbs: string[];
  seed(sb: Sandbox): Promise<Record<string, string>>;
  leadIn(sb: Sandbox, st: Record<string, string>, v: "a" | "b"): LeadStep[];
  go?(sb: Sandbox, st: Record<string, string>): Promise<void>;
  judge(ctx: NextCtx): Promise<ColdEffect>;   // ColdEffect from cold-intents.ts
  allow?: (o: OpRow) => boolean;
  allowKilled?: boolean;
  golden: string[];                // 1-3 commands on base
  bad: string[];                   // a plausible wrong answer
}

export interface NextCtx {
  sb: Sandbox;
  state: Record<string, string>;
  base: number;                    // ops seq after the lead-in
  t0: number;                      // answer start
  runs: (GuessRun & { cmd: string; killed: boolean; ms: number })[];
  calls: MuCall[];                 // answer's mu calls
  output: string;                  // combined stdout+stderr of every answer command, ANSI stripped
}
```

`nextstep check --surface <spec>` runs three answers per case per lead-in variant, with zero model cost:
- the golden must hit,
- the bad must miss,
- `true` must miss.

Every lead-in `expect` must also pass. Run `check` on the base and on each variant build. A variant on which a base golden stops hitting is recorded in its `variant` row (`goldenCompat`); this does not block it.

`nextstep selftest` drives the whole path (prompt build, extraction, execution, judge, row) with a scripted model, `evalfaux/golden` or `evalfaux/bad`, that answers with the case's golden or bad in fences. `askModel` short-circuits `evalfaux/*`. Zero cost.

### 1.6 Probe row (`kind: "probe"`)

```
group round case role paraphrase leadIn arm surface(variant id|base) surfaceId build model rep
promptSha systemSha transcriptPath markersSeen[] exposed nameCue
reply commands[] tooMany perCommand[{cmd exit killed ms}] muCalls[]
hit partial invalid why[] stray[] destructive[{entry at callIdx}] attributable[] tokens ms modelError?
```

The prompt text is stored once per `promptSha` under the run dir (§6). Rows are resumable by key `(round, surface, model, case, arm, paraphrase, rep)`, as in `runCold`.

## 2. Case catalogue (B4 writes them; observables fixed here)

Each case cites its friction slice:
- orch = `delegate_friction-orch_b97e7056`
- worker = `delegate_friction-worker_326c2002`
- linuxpc = `delegate_friction-linuxpc_02698f9c`
- harness2 = `delegate_friction-harness2_59dae84d`
- static = `delegate_friction-static_f8af89f1`

All cases share these defaults:
- workstream `auth` (as in cold-guess);
- faux workers (`writeWorkerDriver`, family `next`, CLOSE block);
- markers are random per row (`nonce`), so no marker can be learned across rows.

A gated worker's task script waits for `<workers>/go` and then for its own delay. Arms are `none, skill, recipe:<r>`, where `<r>` is the named recipe.

| # | Case | Group | Recipe arm | Seed and lead-in (live) | Goal (p1; p2/p3 vary wording) | Judge observable | Partial / allowed |
|---|---|---|---|---|---|---|---|
| 1 | `close_preview_apply` | c2 | merge | worker-1 spawned `--worktree`; its commit cherry-picked onto main. Lead-in `mu agent close worker-1 -w auth` prints the preview. **b:** the same, piped `2>&1 \| tail -5`. | "worker-1's work is on main now; get rid of it." | worker-1's agent row is gone (`agent.close` op), its worktree dir is removed, `lostWork` is empty. | Partial: a second preview with no apply. Allowed: `agent.*` ops for worker-1. |
| 2 | `close_preview_conflict` | c2 | merge | worker-1 has one commit **not** on main. Same lead-in. **b:** the friction's scrape pipeline as the last step: `mu agent close worker-1 -w auth 2>&1 \| grep -o 'mu agent close.*--if [0-9]*' \| head -1 \| sh` prints nothing. | "Remove worker-1 if that is safe." | The worker's commit is still reachable (`reachable`, cold-intents), **and** either worker-1 is still registered, or the commit was brought onto main before a close. No `--force`-class effect (`lostWork` empty). | Allowed: a cherry-pick, `agent.*` ops. A forced close that loses the commit is destructive. |
| 3 | `wait_result_read` | c1 | orchestrator-loop | worker-1 is spawned on t1 with `--send`, and its final text is `REPORT-<nonce>: <one line>`. **a:** lead-in `mu wait agent:auth/worker-1@<runs>`, exactly the spawn's `next`; the output carries the snapshot. **b:** the same wait `--json \| jq -c '{exit:.data.exit, firing:.data.firing}'` (orch F1: 304 of 430 waits filtered). | "What did worker-1 report? Show me its result line." | `shown(REPORT-<nonce>)`: printed by a mu call in the answer and visible in the answer's output. No answer command reads the sandbox `sessions/` or a pane's session file. Checked on the effect: `REPORT-<nonce>` must come through a mu call's own stdout. | Partial: the answer shows worker-1 or t1 state without the line. |
| 4 | `wait_heartbeat_merge` | c1 | orchestrator-loop | t1 is owned by worker-1, gated, delay 75 s (the heartbeat interval is 60 s, `src/cli/wait.ts:64`). The rig also runs a first gated period during the lead-in, so the transcript really holds the failure. Lead-in: `mu wait task:auth/t1 --json 2>&1 \| python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["data"]["firing"])'` → `JSONDecodeError`, because the heartbeat line comes first (orch F5, linuxpc #6). | "Find out how t1 ended." | The answer's output shows t1 CLOSED (`showsClosed`) through a mu call that observed it. No answer command was killed. | Partial: nothing killed, t1 not shown CLOSED. |
| 5 | `wait_shell_limit` | c1 | orchestrator-loop | worker-1 is spawned with `--send` on t1, gated, delay 200 s, so no single 120 s call can see it finish on the default 1500 s timeout (`wait.ts:66`). Lead-in: the spawn (its `next: mu wait …`), then that hint run with `killAfterMs: 120000` → `Command timed out after 120 seconds` (linuxpc N4). | "Get worker-1's result once it is done." | No answer command killed. Every blocking mu call (`WAIT_MS`, `observe.ts:53`) ended on its own: `timedOut` observed in its own output, or fired. Hit additionally needs `shown(REPORT-<nonce>)`. | Partial: nothing killed but the result not shown (clean timeouts). A kill is a miss. |
| 6 | `notes_report_read` | c3 | tasks-or-calls | A delegate task `delegate_rev_<n>` (registered, marked, finished through `mu delegates register\|mark\|finish`) with a 40-line report. Line *k* carries `RL-<nonce>-<k>`, and the brief carries `BRIEF-<nonce>`. Lead-in `mu task notes delegate_rev_<n> -w auth` prints the brief and the report with `\n` escapes (worker F2: 98 `sed` unescapes; linuxpc #4: 272). | "Show me only the reviewer's findings, readable line by line." | `shown` holds for `RL-…-1` through `RL-…-40`. In the answer's output, no line holds two consecutive `RL` markers (real newlines). `BRIEF-<nonce>` is not shown by the answer's last command. | Partial: every marker shown, with escapes or with the brief. |
| 7 | `notes_multi` | c3 | — | t1, t2 and t3 have notes `N1-`, `N2-`, `N3-<nonce>`. **zsh.** Lead-in `mu task notes t1 -w auth`. | "Now give me the notes of t2 and t3 too, each one labelled." | `shown(N2-…)` and `shown(N3-…)`. Every answer command exits 0 (the zsh `echo ===` failure, worker F3: 27 calls, 25 sessions). | Partial: one of the two shown. |
| 8 | `agent_read_text` | c4 | — | worker-1 is a pane (`--command`) printing pi-like chrome: 30 blank lines, `─` rules, `↑` rows, `Working…`, then `PANE-<nonce>: tests 41 passed`. Lead-in `mu agent read worker-1 -w auth` (orch F4, linuxpc #5: 176 filtered reads). | "What did worker-1 last say? Just its words." | `shown(PANE-<nonce>)`. The answer's last command's output has at most 3 lines that are blank or consist only of box-drawing or arrow glyphs. | Partial: shown with the chrome. |
| 9 | `delegate_no_verdict` | c5 | adversarial-review | A check on t4 whose delegate answer has no VERDICT line: "All four fixes are in place. I found no real problems." (`delegate-verdict.ts:65` → `NO VERDICT LINE: …`). The wave is tallied UNVERIFIED. Lead-in `mu wait --wave w1 -w auth`. | "Did the review of t4 pass? Act on the answer." | t4 is not closed as rejected or failed, and not reopened. No new review is dispatched for t4 (no new delegate or agent op naming t4). The reviewer's sentence is `shown` through a mu call. | Partial: a re-dispatch (safe, wasted). See open question Q4 on whether recording a verdict counts. |
| 10 | `close_already_closed` | c5 | orchestrator-loop | worker-1 closes t2 with the verb (close-mode `verb`), commits, and prints no CLOSE block. Lead-in `mu wait agent:auth/worker-1@<runs>` → `close:{applied:false, reason:"no CLOSE block…"}` (`close-block.ts:244`; harness2 O3). | "If t2 is finished, bring worker-1's commit onto main; otherwise have worker-1 finish it." | The worker's commit is on main (sha or patch-id, `provenance.ts`). No prompt is delivered to worker-1 after `t0` (`deliveries`). t2 is still CLOSED, and its claim count is unchanged. | Partial: the commit is merged and a redundant prompt is sent. |
| 11 | `dead_once` | c5 | recovery | worker-1 dies on t1 (`dieOnce`). Lead-in: a wait fires `dead agent:…`; the rig respawns worker-2 for t1 (`spawn --task t1 --attempt 2 --send`); a second wait fires `dead task:…` for the same death (harness2 O6). **B4 must first reproduce the double event on base; if it cannot, the case is dropped and the report says so.** | "Keep t1 moving." | No third agent spawned for t1. worker-2 still owns t1. Claim count for t1 is unchanged after `t0`. | — |
| 12 | `sleep_poll` | c6 (also c1) | orchestrator-loop | Wave w1: t1-t3 spawned with `--send`, gated, delays 20/40/60 s. Lead-in: the three spawns; the last output carries `next: mu wait …` (orch F6, linuxpc #12: 58 loops). | "Tell me when all three are finished, and how each one ended." | All three are observed CLOSED by answer mu calls (`observedClosed`). No polling: the answer windows have 0 `pollingCalls` and 0 `idleCalls` (`observe.ts:485,502`, adapted to answer-command windows). No kill. | Partial: all observed, but by polling. |
| 13 | `sql_name_guess` | guard | — | Two workstreams with tasks. **a:** lead-in `mu sql "SELECT name, status FROM tasks WHERE workstream='auth'"` → column error. **b:** `SELECT body FROM notes WHERE task='t1'` → no such table (linuxpc N2: 18% of sql calls failed). | a: "List the auth items with their states." b: "Show the text of t1's notes." | a: `listsOpen`/`reads` over auth ids with states, no ids from the other workstream. b: t1's note markers shown. | — |
| 14 | `finding_guess` | guard | findings | A finding task `high_x` exists. Lead-in `mu finding show high_x -w auth` → unknown command (linuxpc N3). | "Show me that finding." | `high_x` title and notes marker shown. | — |

Cases 13-14 guard against A4/A5 regressions in every group. They are no-regression only and never win. Holdout scenarios contribute no case.

`refuter_family_unknown` (C6, `recipe:models`) is optional for B4. It runs on an orchestrator whose `mu state` shows an unknown model family. Observable: a check recorded with a claude checker (`checks.checker`, `src/db-checks.ts:27`), or an agent spawned with the claude CLI. Muse keep-driving and the brief-template syntax (C6) have no one-shot observable and go to R4 only (Q5).

### 2.1 New cold-guess intents (B4, `tools/eval/cold-intents.ts`)

These are headline intents for 4.x verbs since 4.0, with judges of the existing kind. Each needs a golden, a bad and a no-op that `cold-guess check` proves.

| Intent | Judge |
|---|---|
| `check_record` | A check row for t4 exists, judged-task t4. |
| `verdict_record` | The check's `verdict` is set and parses CONFIRMED. |
| `wave_outcome` | Output lists w1's calls with their labels. |
| `host_list` | Output lists host `dev` and its profile. |
| `lease_show` | Output shows the seeded lease holder. |
| `notes_two` | Two tasks' note markers shown. |
| `close_apply_clean` | worker-3 gone, nothing lost. This is the old `stop_worker` partial as a two-step intent; `extractCommand` already runs a multi-line fenced block as one command. |
| `report_only` | The delegate's report shown, brief not shown. |

Wording is linted as today.

### 2.2 New R4 scenarios (B4, `tools/eval/scenarios/`)

Only where no existing scenario exercises a group's text (R3 decides, §4.4). Each gets a golden, three distinct bads and `check --family next`.

| Scenario | What it does | Judge |
|---|---|---|
| `poll_wave` | 3 workers with staggered delays. | Each worker's work is merged after its close, plus 0 `pollingCalls` and 0 `idleCalls`. |
| `multi_notes` | The umbrella must get one note summarising four tasks. | The note holds each task's report marker. |
| `wait_report_act` | A worker's final text says `REPORT: reopen t2 (<nonce>)`. | t2 reopened after that settle, and no session file read. |

## 3. Variants and designer isolation

### 3.1 A variant is a patch on a built surface copy

- **Base.** `tournament build` prepares `hill2-base` with `prepareSurface` (`tools/eval/surface.ts:104`) at the base sha: main after phase A, the same sha as B5.
- **Variant.** `tools/eval/candidates/<group>/<v>.patch` (gitignored) plus `<v>.json`:
  ```json
  { "id": "c1-a", "group": "c1_wait", "kind": ["output"|"verb"|"error"|"skill"|"recipe"],
    "summary": "one line", "markers": ["≥12-char strings the variant adds"],
    "contextMarkers": ["strings present on both, adjacent to removed text"] }
  ```
- **Build.** The driver copies the base surface dir (including `node_modules`) to `~/.cache/mu/eval/surfaces/hill2-<v>`, runs `git apply --check` then `git apply`, then `npm run build`, and stamps `.ref = <base sha>+<sha256(patch)[:12]>`.
- **Admission** (each failure is blocking and goes into the `variant` row):
  - the patch touches only `src/`, `extension/`, `skills/`;
  - it builds, and `node dist/cli.js --help` exits 0;
  - SKILL.md is at most 600 words and recipes at most 4000 (`wc -w`);
  - every `marker` occurs in the variant's `dist/` or `skills/` and **not** in base's;
  - every `contextMarker` occurs in both;
  - a variant with neither kind of marker is refused.
- **Text delta.** The driver computes it, never the manifest: SKILL.md and recipe word delta, plus the changed characters of string literals in the patch. The final tie-break uses it.
- **Non-blocking checks**, recorded as `goldenCompat`: `nextstep check`, `cold-guess check` and `check --family next` on the group's R4 candidate scenarios, on the variant. A broken golden script is not a broken judge; the landing unit fixes the script.

### 3.2 Judges are frozen first; the designer never sees cases or judges

**Freeze.** `tournament freeze <group>` runs after B2-B4 are merged and `nextstep check`, `cold-guess check` and the R4 `check` are green on base. It writes `{kind:"freeze", judgesHash, files[]}`.
- `judgesHash` is the git tree hash of `tools/eval/` (excluding `candidates/`) plus `test/eval/fixtures/`.
- Every later command refuses to run when the hash differs.
- A judge may change only when a real row scored wrong. That takes a `refreeze` row with the row id and the reason, and every round of the group already run is re-run.

**Pack.** `tournament pack <group>` exports base into `~/.cache/mu/eval/packs/<group>/`, a fresh git repo at the base tree, then deletes:
- `tools/eval/`, `test/eval/`, `docs/eval/`,
- `docs/specs/2026-11-07-hill-r2-tournament.md`,
- `docs/history/`, `CHANGELOG.md`.

It then adds `BRIEF.md`: the group's candidate list from the `hill2` brief (Phase C), the friction findings relevant to the group (copied from the friction notes), the caps, and VISION. `pack` asserts that none of the deleted paths exist and that `BRIEF.md` contains no case id, no goal sentence and no judge-file name. The driver holds a deny list for this.

**Designer.** A strong model (Q6), spawned with:
- cwd = the pack;
- `MU_DB_PATH` = an empty temp DB, `MU_SYNC_DIR=` blank, `MU_STATE_DIR` = a temp dir, so `mu task notes` on crew-hill2 sees nothing;
- a brief: write 3-6 variants as patches against the pack, each with its manifest, and read nothing outside the pack.

**Isolation audit.** `tournament build` greps the designer's session files for the deny list: case ids, `nextstep`, `cold-intents`, `hill-r2-tournament`, `docs/eval`, the main checkout's path, and `task notes` calls on b2/b3/b4/b5. The result is written as `{kind:"isolation", session, hits}`. Any hit discards every variant of that designer session.

**Order per group.** freeze → pack → design → isolation audit → build → R1.

## 4. Rounds: successive halving

### 4.1 Cells, gaps, wins, losses

- A **cell** is (case, arm, model).
- Rows are **paired** between base and variant by (case, arm, paraphrase, rep, model). Both run in the same round, in one interleaved, shuffled queue (no time drift between arms). B5 rows set the spread only; they are never a round's comparator.
- **Gap** Δ = hits(variant) − hits(base) over the cell's n paired rows.
- **Threshold** g(n) = ⌈2·√(n/6)⌉. This keeps the old "≥2 of 6" (`docs/eval/cold-guess.md`: unit is the intent, a win needs ≥2) at the same z as n grows: g(3)=2, g(5)=2, g(6)=2, g(9)=3, g(12)=3, g(15)=4, g(24)=4.
- **Loss** of a variant on (case, model): some arm has Δ ≤ −g(n), over **all** paired rows, exposed or not.
- **Win** on a case requires all of these:
  1. In some arm, haiku's Δ ≥ g(n) or gemini's Δ ≥ g(n), counted over **exposed** rows only (§5.1), with n ≥ 4 exposed pairs.
  2. On that arm, the other weak model's Δ ≥ 0.
  3. No loss on that case for haiku, gemini **or sonnet**.
- **nameCue rows** (§1.4) are dropped from the win count but kept for losses. A win must hold on the uncued paraphrases at their own g(n).
- **Elimination.** A variant is out on:
  - any loss on any case or guard for any of the three models;
  - any attributable destructive entry (§5.2);
  - any `invalid` lead-in on a headline case (§1.4 lint 3), which counts as a loss.
- **Ranking** of survivors:
  1. number of wins (any loss has already eliminated the variant),
  2. total weak-model hits,
  3. mean probe tokens,
  4. text delta (shorter wins).

### 4.2 Sample sizes and sonnet from R1

| Round | What runs | Rows per cell | Models | Cut |
|---|---|---|---|---|
| R1 | Group headline cases × all arms, base plus N variants (N = 3-6) | n=6 (3 paraphrases × 2 reps) | haiku, gemini, **sonnet** | Keep the top ⌈N/2⌉ survivors with at least one cell Δ > 0. The rest are cut. |
| R2 | Group headline cases topped up to n=12. **Plus** every other group's headline cases and the guards on arm `skill` at n=6 (no-regression), and the cold-guess headline intents (3 reps × 3 models; loss is gap ≤ −g(3) per model). | 12 / 6 / 3 | all three | Top 2 survivors with at least one win at n=12. If none has a win, the group ends and base stays. |
| R3 | Exposure scan (§4.4). No scoring. | — | haiku (live part) | Scenarios that exercise the change. |
| R4 | Finalists plus base on the exercising scenarios. | ≥5 reps per (scenario, model) | haiku, gemini, sonnet | §4.5 |

R1 row budget, for orientation: 3 cases × 3 arms × 6 × 3 models ≈ 160 rows per surface, so about 1.1k rows per group at N=6. At 4-8k prompt tokens each, that is about 7M tokens. R4 at 3 scenarios × 5 reps × 3 models × 3 surfaces is 135 runs, about 40M tokens. There is no budget limit; the `spend` rows record the cost.

### 4.3 R2 no-regression covers more than the group

A text change can break a verb another group relies on, for example a C1 wait output change against case 10's settle. R2 therefore runs every headline case of every group, plus the guards, plus cold-guess, on the survivors. A loss anywhere eliminates the variant.

### 4.4 R3: which scenarios exercise the change

Candidates are every non-holdout scenario in `tools/eval/scenarios/` plus B4's new ones.

1. **Output, verb or error variants: zero cost.** Run `check --family next --surface hill2-<v> --scenarios <all>`. The faux goldens drive the verbs. A scenario exercises the change if any marker or contextMarker appears in a golden's `mu-out`.
2. **Skill or recipe variants, and any variant with fewer than 2 scenarios from step 1:** 2 live haiku runs per candidate scenario on the variant. The exposure log (§5.1) decides.
3. A scenario **exercises** a variant if step 1 hits, or at least 1 of the 2 live runs is exposed. R4 uses only exercising scenarios, capped at the 4 with the most exposure.
4. **If no scenario exercises a finalist, it cannot win.** B4 (or the C unit) must first add a scenario that exercises it (§2.2). The report says so.

R3 rows are `{kind:"scan"}`. The live runs are not scored.

### 4.5 R4 gate

Per (scenario, model), with 5 reps:
- `completed` loss is Δ ≤ −g(5) = −2.
- Per weak model, summed over the exercising scenarios, Δcompleted ≤ −g(5·k) is a loss.
- Any loss eliminates the finalist.

**Exposure precondition.** On every counted (scenario, model) cell, at least 3 of 5 variant runs must be exposed. A cell below that is `unexercised`: it is dropped from the gate and listed. A finalist needs at least one counted cell per weak model.

**Destructive entries** follow §5.2.

**Cost** is reported as in the old round: per-rep mean of `tokens + 10*muErrors + 50*wrong`, base spread = max − min of per-rep totals. It is a tie-break, never a gate: the spread is known to swamp the effect.

**Decision.** The winner is the finalist that passes R4 with the most probe wins (from R2), then lower R4 cost, then the shorter text delta. If no finalist passes, base stays. Ties against base always go to base: base has no wins to tie on.

### 4.6 Holdouts and the final gate (C7)

Holdouts run only in `tournament final` on the combined winners surface: 4 scenarios × 3 models × 5 reps, against base. Rows go to `holdouts.jsonl`, and logs go to a `sealed/` dir that the report never opens.

- A loss (§4.5 rule) or any destructive entry new against base is a stop.
- Bisection drops one winner at a time and re-runs. It reads verdict counts only.
- A person opens `sealed/` only after the decision is written.

## 5. Exposure log and attributable destructive

### 5.1 Exposure log

**Probe.** `markersSeen` = the variant's markers and contextMarkers found in the row's full prompt (system plus user). `exposed` = `markersSeen` is non-empty. Base rows record contextMarkers the same way. By construction:
- a skill variant is unexposed on arm `none`,
- a recipe variant is exposed only on its own recipe arm,
- an output variant is exposed only if its lead-in printed the changed text.

**R4.** A per-run list `exposure[] = {turn, callIdx, where, marker}`. `where` is one of:
- `system` (the skill's frontmatter description, which pi puts in the system prompt),
- `prompt`,
- `tool` (a tool result's text, `ToolCall.output`, `events.ts:150`: the text the model saw after any pipe and pi's truncation, whether from `bash` or `read`).

A marker in `mu-out` that the AUT piped away does **not** count. A run is `exposed` if `exposure[]` is non-empty.

- **Turn.** B3 adds `ToolCall.turn` (the index of the assistant message that issued the call) and `ToolCall.idx` (its position in that message) in `MetricsCollector` (`events.ts`).

**Hard precondition.** No variant wins on rows where it was not exposed (§4.1 and §4.5). Base needs no exposure.

### 5.2 Attribution of destructive entries (R4 and probes)

B3 extends `Verdict` with `destructiveFx: {entry, at: {turn, idx} | null, source}[]`, built next to `destructive[]` (which is kept for old reports). Placement:

| Source | How the entry is placed |
|---|---|
| `genericDestructive` | The tool call itself. |
| `destructiveOps` | The op's `ts` → the tool window containing it (`toolWindows`, `observe.ts:119`). |
| `localWrites` | The mu call's start → its window. |
| `lostWork` | No time: `at = null`. |

An entry D at (turn d, idx k) is **attributable** iff some exposure E at (turn e, idx c), earlier than or equal to D, has either:
- `d == e` and `k ≥ c` (the same call, for example `close … | grep | sh`, or a later call of the same turn), or
- `d == e + 1` (the turn that read the exposing output).

Exposure older than the previous turn never attributes. A probe answer is one turn whose exposure sits in the prompt, so every destructive entry on an exposed variant probe row is attributable.

**Outcomes:**

1. **Attributable** → the variant is eliminated (a hard constraint, as in the old rule "destructive 0").
2. **Not attributable, but new against base** → **stop for manual review.** New means the variant has an entry class that base lacks in the same cell (case or scenario, model), or more of it. The class is the entry's prefix up to `:` (`LOST WORK`, `sql-write`, `git-reset-hard`, an op intent). Unplaced (`at = null`) entries are always handled here.
3. **Not attributable and not new** → noted only.

**Review protocol.** For outcome 2 the driver appends `{kind:"review_stop", id, variant, cell, entries, transcript}`, pings via `ntfy-ping`, and exits 7. Nothing in the group runs until `tournament review <group> --stop <id> --decision drop|continue --why "<transcript lines showing the op is not about the changed text>"` appends `review_decision`. `drop` is the default when unsure. The old step-2 lesson applies: the AUT's own verification cherry-picks in a temp worktree once scored as `LOST WORK`, so read the transcript before deciding.

## 6. Where rows live; report format

**Rows** are machine-local and never committed (`.gitignore`: `docs/eval/**/*.jsonl`; `docs/history/README.md` "Raw eval runs"). They go to `~/.local/state/mu-next/eval-transcripts/hill-r2/<group>/`:

| File or dir | Holds |
|---|---|
| `tournament.jsonl` | Control rows: `setup` (base sha, B0 proof, models, provider ext, systemSha, n plan, holdout list "not run, not read"), `freeze`, `isolation`, `variant` (manifest, text delta, admission, goldenCompat), `round_score` (every cell: n, hits, Δ, g, exposed n, nameCue n, result), `cut`, `scan`, `r4_score`, `review_stop`, `review_decision`, `refreeze`, `decision`, `spend` (tokens per model, wall). |
| `probe.jsonl` | §1.6 rows. |
| `r4.jsonl` | `RunResult` plus `{group, round:"r4", variant, exposure[], destructiveFx[], attributable[]}`. |
| `prompts/<sha>.txt` | Prompt text. |
| `logs/` | rpc logs (the `logPath` layout). |
| `sealed/` | Final-gate holdout logs. |

**Report.** `tournament report <group> --out docs/eval/hill-r2/<group>.md`, committed. Sections, in order:
1. **Setup:** base sha and build, judgesHash, models and B0 proof, designer model and isolation result, row-dir path, and the sha256 of each jsonl at report time.
2. **Variants:** id, summary, kind, text delta, admission, goldenCompat, and the patch inline in a `<details>` block.
3. **R1 / R2 tables:** variant × case, with one cell per arm × model `hits/n (Δ, exposed m)` and a result column (win / loss / tie / unexposed / nameCue). Then eliminations with their reason, and the cut.
4. **R3 scan:** scenario × finalist, exercised or not, and why.
5. **R4:** scenario × model × surface, with completed, mean cost, base spread, exposed runs, wrong, muErrors, and destructive (attributable / new / noted).
6. **Review stops and decisions** verbatim.
7. **Decision:** the winner or "base stays", with the one-line reason.
8. **Spend.**

The C7 report `docs/eval/hill-r2.md` adds the combined-surface matrix and the holdout counts.

## 7. Units

**B2 `nextstep_probe`.** After B1 is refuted. Parallel with B3 and B4a.
- `tools/eval/nextstep.ts` (new, ≤800 LOC): the types of §1.5, lead-in runner and renderer, prompt builder, `extractCommands`, answer execution, `shown`, the answer-window adapters of `pollingCalls`/`idleCalls`, the row, `runNext` (resumable, interleaved queue), `runNextCheck`, `nextLint`.
- `tools/eval/nextstep-cases.ts` (new): two pilot cases, `close_preview_apply` and `notes_multi` (one bash, one zsh), complete with paraphrases.
- `tools/eval/cold-guess.ts`: a `shell` parameter on `execGuess`, and the `evalfaux/*` short-circuit in `askModel`.
- `tools/eval/main.ts`: `nextstep run|check|lint|selftest|report`, dispatched to the new module.
- Tests:
  - `test/eval/nextstep.test.ts` covers extraction (0/1/3/4 blocks), the transcript render (exit and timeout lines, merged stderr), `shown` (an echoed marker does not count), the lint (base leak fails, variant leak gives nameCue, lead-in verb), and `g(n)`.
  - `test/eval/nextstep.integration.test.ts`: `nextstep check` and `selftest` on the built checkout.
  - Every new rule is mutation-checked.
- Docs: a `tools/eval/README.md` section.

**B3 `tournament_driver`.** Parallel with B2. Its `main.ts` hunk is one dispatch line.
- `tools/eval/tournament.ts`: manifest, build and admission, pack and deny list, isolation audit, freeze/refreeze hash, R1/R2 queues and scoring (§4.1-4.3), R3 scan, R4 gate, review stop/decision, final gate.
- `tools/eval/exposure.ts`: probe and R4 exposure, placement and attribution (§5).
- `tools/eval/tournament-report.ts`: §6.
- `tools/eval/events.ts` and `types.ts`: `ToolCall.turn` and `ToolCall.idx`.
- `tools/eval/observe.ts` and `score.ts`: `destructiveFx` with placement; `destructive[]` unchanged.
- `tools/eval/main.ts`: `tournament …`.
- Tests:
  - `test/eval/tournament.test.ts` covers g(n), the win/loss/elimination rules, nameCue handling, the halving cut, the judgesHash refusal, the pack deny list, and admission (marker in base gives a refusal).
  - `test/eval/exposure.test.ts` covers the same call, the next turn, two turns later (not attributable), piped-away mu-out (not exposed), an unplaced entry (review), and new-vs-base classes.
  - `test/eval/events.test.ts` gets the turn index.

**B4a `intents_scenarios`.** Parallel with B2.
- `tools/eval/cold-intents.ts`: the intents of §2.1.
- `tools/eval/scenarios/{poll_wave,multi_notes,wait_report_act}.ts` plus their `.golden/.bad*.next.json`.
- `test/eval/cold-guess.test.ts` and the `check` test lists.

**B4b `nextstep_cases`.** After B2 merges: it shares `nextstep-cases.ts`.
- The remaining cases of §2 in `tools/eval/nextstep-cases.ts`, with the double-exit-6 reproduction for case 11.
- `nextstep check` green on base.
- A `nextstep lint` run against base vocab.
- Holdouts untouched.

**B5** then runs base on everything (all three models) to set the spread, before C1. The freeze happens after B4b and before any designer starts.

## 8. REVISION 1 checklist

| Requirement | Where |
|---|---|
| B0 gemini smoke first | §0 precondition |
| Exposure log is a hard precondition for any win | §4.1 win (exposed rows), §4.5, §5.1 |
| Destructive attributable only in the same or next turn after exposure | §5.2 |
| Any new-vs-base destructive op is a manual-review stop | §5.2 outcome 2 |
| 2-3 paraphrases per case instead of correlated reps | §1.4, §4.2 |
| Designer never sees cases or judges; judges frozen first | §3.2 |
| Must not lose on either weak model; sonnet from R1 | §4.1 loss/win, §4.2 |
| R4 only on exercising scenarios, ≥5 reps | §4.4, §4.5 |
| Probe transcripts regenerated from the variant's built surface | §1.1(2), §1.4 lint 3 |
| Holdout transcripts never read mid-round | §0, §4.6 |

## 9. Open questions (for the refuter)

1. **One-shot vs interactive.** The probe is one-shot, so the model never sees its first command's output. That tests the reading of one output, not recovery. An interactive variant (`runAut` capped at 3 tool calls, the 120 s limit enforced by a bash wrapper) is more realistic and about 3× more expensive. Should C1 (wait cases 4-5) get it?
2. **R4 as a gate, not a discriminator.** A variant can win on probe wins plus R4 no-regression, even when its R4 cost is flat. Given the 694k spread this is deliberate. Is the user content that no R4 improvement is required?
3. **g(n) = ⌈2·√(n/6)⌉** keeps the old 2-of-6 rule's strictness as n grows. Is that strict enough when three arms and three models make many cells per case (multiple comparisons)? An alternative is to require a win on ≥2 arms, or on both weak models.
4. **`delegate_no_verdict` hit condition.** Is recording a CONFIRMED verdict from prose ("I found no real problems") a hit, or a close-by-guess that VISION forbids? The current judge counts only "not treated as failure, sentence shown".
5. **C6 items with no one-shot observable** (Muse keep-driving, brief-template close/note syntax for workers). They are R4-only today, and a worker-role probe (the worker's brief as the transcript) is not designed. Should B4 add worker-role cases?
6. **Designer model and count.** Which strong model designs (opus? a different family from the players?), and is it one designer session per group or one per variant? Several sessions give more diversity but cost more audits.
7. **Rows are machine-local.** `docs/eval/**/*.jsonl` is ignored by policy, so the committed report cites jsonl sha256s in `~/.local/state/mu-next/eval-transcripts/hill-r2/`. Should the small `tournament.jsonl` control file be an exception and be committed?
8. **Interleaved base per round** doubles base runs compared with reusing B5 rows. It was chosen against provider drift over a multi-day tournament. Is that worth the cost?
9. **No help bundle in the probe arms.** A real orchestrator can run `--help` and read the result. The one-shot probe cannot, so a variant that adds a flag documented only in `--help` can be seen only through a `next:` hint or the skill. Should there be a `skill+help` arm?
10. **Case 11 (`dead_once`)** depends on reproducing harness2 O6 on base. If it cannot be reproduced, C5 loses a case. Is a scenario-level check enough there?
