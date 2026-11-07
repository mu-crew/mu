# hill-r2 tournament rig: next-step probe, tournament driver, exposure-gated scoring

Status: revision 2, for a fresh refutation (task `b1_rig_spec_2`, workstream `crew-hill2`). Revision 1 was refuted by `scratch/delegate_refute-spec_55f96588`; the revision log at the end lists every change. It binds B2 (`nextstep_probe`), B3a (`exposure_scoring`), B3b (`tournament_driver`), B4a (`intents_scenarios`) and B4b (`nextstep_cases`). Plan of record: `mu task notes hill2 -w crew-hill2` (brief plus REVISION 1). Every REVISION 1 Phase-B requirement maps to a section here; §8 checks each one off.

## 0. Why this rig, and what it must not repeat

The last round's hill-climbs (`git show 799cd4bb^:docs/mu-next/eval/hillclimb-{skill,surface,errors}.jsonl`) produced three lessons. This design is built around them.

- **R4 alone cannot separate text variants.** The skill climb scored `cost = tokens + 10*muErrors + 50*wrong` per rep on 14 scenarios × haiku × 3 reps. The base spread was 694k tokens per rep, and steps 1-3 all fell inside it. Four steps cost 46.8M AUT tokens and 3h40, and one 42-word cut survived, on the tie rule (`stop` row).
  - So R4 here is a no-regression gate with completion as its primary measure and cost only as a tie-break. The discovery signal comes from cheap probes.
- **Unseen text cannot win.** The `setup` row's exposure field says SKILL.md was read in 56 of 62 runs and recipes in at most 11. A recipe variant is invisible unless the run reads it.
- **Raw destructive counts block on noise.** The `t_errors` host-check step was dropped twice on raw counts: 2→3, then 0→1. That happened even though no entry was about the changed line: one run never saw the line, and the others were the same `rm -rf` cleanup pattern seen on base (`r4_score.destructive_note`, `compare.destructive_note`). Destructive ops must therefore be attributed to the variant. Anything new against base still stops the run for a person.

Fixed rules (user decisions, 2026-11-07, in the `hill2` brief):

- Weak players are `claude-haiku-5-5` and `gemini-3.8-flash`; the gate is `claude-sonnet-5-5`.
- A destructive action counts only when it is attributable to the variant.
- There is no budget limit; the target is result quality. Sample sizes below are set by statistical power, not cost (§4.2).
- The four holdouts (`worker_dies`, `wait_receipt_race`, `wrong_id`, `single_channel_host`) are never tuned, never mined for cases, never run mid-round, and their transcripts are never read mid-round.

**Exposure gates wins only.** Every loss rule, on probes and R4 alike, counts every row and every run, exposed or not. A verb or behaviour change can regress a run without any of its text reaching the model.

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
   - No help bundle in any arm. The transcript is the context. A `--help` command in the answer runs, but its output is never shown, so it only spends one of the three steps. Consequence, accepted: a flag documented only in `--help` can win only through a `next:` hint or the skill.
2. **Transcript, generated live.** Per row, the rig creates a fresh sandbox (`createSandbox`, `tools/eval/sandbox.ts:530`, with its own private tmux socket, `sandbox.ts:44-48`) on the surface under test, runs the case's `seed`, then runs each lead-in step as the orchestrator and captures what it actually printed. Nothing is canned.
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
  - No fence: the first line that runs mu, as in `extractCommand` (`cold-guess.ts:44`).
  - Zero commands is a miss: `no command`.
  - More than three blocks is a miss, `more than 3 commands`, and nothing runs.
- **Execution.** In the **same** sandbox the lead-in left. Each command runs in order through `execGuess(sb, cmd, limitMs, shell)` (`cold-guess.ts:255`; it hard-codes `bash` today and gains the `shell` parameter), with the case's shell and `limitMs` (default 120 000; the kill is real).
- **The `go` gate.** A gated worker's task script (§2) blocks until the file `<workers>/go` exists, then sleeps its own delay. The rig touches `go` immediately before the first answer command (the case's `go` hook, default "touch go"), so worker timing is measured from the answer, not from the model's latency. A case whose lead-in needs the worker running releases the gate itself in its seed; none of the cases below does.
- **Recorded per command:** exit, `killed`, start and end epoch ms, stdout, stderr. Also recorded: every mu call the answer made (the shim's `mu-calls.log`, `start >= t0`, `sandbox.ts:402-411`) and each call's own stdout (`mu-out/<pid>`, `muOut`, `observe.ts:193`).

**Answer-window adapter** (`answerMetrics`, in `nextstep.ts`). `pollingCalls` and `idleCalls` (`observe.ts:485,502`) read a `RunMetrics` through `toolWindows` (`observe.ts:119`), which pairs each `ToolCall` with its `tool_start`/`tool_end` lifecycle events by `id`. The adapter builds, from the answer's command records:
- one `ToolCall` per answer command: `{ id: "a<i>", name: "bash", args: { command }, isError: exit !== 0, output: stdout+stderr, exitCode: exit, durationMs: end − start }`;
- two `LifecycleEvent`s per command: `{ t: start, kind: "tool_start", id: "a<i>", name: "bash" }` and `{ t: end, kind: "tool_end", id: "a<i>", name: "bash" }`;
- the rest of `RunMetrics` zeroed (`usage` zeros, `turns: 1`, `aborted: null`, `finalText: ""`).

Start and end come from `Date.now()` around the `execGuess` call, the same epoch-ms clock the shim writes to `mu-calls.log`, so `muIn` (`observe.ts:475`) attributes each mu call to its answer command unchanged. `observe.ts` is not edited for this.

### 1.3 Judging: by state and mu's own output, never spelling

A judge gets `NextCtx` (below). It may read:

- the DB through `openProbe`,
- the ops after the lead-in (`opsSince(sb, base)`),
- git,
- `mu-calls.log` and `mu-out`,
- the workers' `prompts.log` and `runs.log`,
- each answer command's run record, and `answerMetrics(ctx)`.

It never matches a mu verb, a flag, a hint string or an exit code, the rule of `tools/eval/README.md` "Judges assert effects, not spellings".

**"Printed" (`shown(ctx, marker)`) requires two things:**
1. some answer mu call's own stdout (`mu-out`) contains the marker, **and**
2. the answer's combined output contains it (so the model would see it, not a pipe that dropped it).

`echo <marker>` does not satisfy condition 1. This is what keeps a marker that already appears in the transcript from being echoed back for a hit.

**Every judge has a positive observable.** A hit needs a state change or a `shown` that the lead-in did not already produce. `true` (the no-op answer) must miss every case; §2.3 proves it per case.

**Hit** = the judge's effect holds, no stray op (as in cold-guess: an op the case's `allow` does not name), no command killed unless the case allows it, and no destructive effect.

**Partial** = the case's own "right direction" condition. It is reported, never counted as a hit.

**Destructive entries** come from the effect rules every judge already shares:
- `destructiveOps`, `localWrites`, `lostWork` (`tools/eval/observe.ts:407,443,340`),
- the `DESTRUCTIVE` regexes on the answer's commands (`tools/eval/score.ts:7`).

The probe row records the entries only. Exposure and attribution are computed by `exposure.ts` (B3a) at score time (§5); `nextstep.ts` never decides either.

### 1.4 Paraphrases and lint

**Paraphrases.**
- Each case, headline or guard, ships **six** paraphrases (`p1`-`p6`) of its goal. B4b may add up to `p12` when the n plan (§4.2) needs more clusters. This raises REVISION 1's "2-3" because the effective n is bounded by the number of distinct prompts (§4.2); it keeps that rule's intent, which was never to lean on correlated reps.
- Each paraphrase uses different content words for the key noun or verb where the language allows (report / answer / findings / result; finish / remove / clean up / get rid of), so that a word a variant turns into a flag cues at most a few paraphrases.
- A paraphrase may also pick a lead-in variant (`a` or `b`) where the case has two.

**Lint** (`nextstep lint`; `run` refuses to start on any failure):

1. **Goal neutrality.** `neutralityLeaks` (`tools/eval/cold-help.ts:108`) over each goal against the vocab of every surface in the round, base and all variants, with `payload` exempt.
   - A goal that leaks a **base** name is a lint failure: fix the case before freezing.
   - A goal that leaks only a name a **variant** introduced is marked `nameCue` for that variant's rows of that paraphrase. Those rows are dropped from wins and kept for losses (§4.1).
2. **Lead-in verbs.** Each case lists `leadInVerbs`, the first-reach verbs (`firstReach`, `cold-guess.ts:79`) its lead-in may use. A lead-in that uses another verb fails the lint, which keeps a case from demonstrating its own answer earlier in the transcript.
3. **Lead-in stays valid on each variant.** A lead-in is spelled in base grammar. If a variant makes a lead-in step fail where base succeeds (exit status class differs, or the step's `expect` fails), every row of that case on that variant is `invalid`, scored as a miss, and any invalid row on a headline case eliminates the variant (§4.1). A variant must keep base spellings working; this is the old rule "a winner becomes the main spelling with the old one kept as an alias" (`docs/history/mu-next-design/README.md` ~l.590).
   - `expect` may check only surface-independent preconditions, such as "the worker's commit exists" or "t1 is still open". It never checks output text. A variant whose lead-in already reaches the goal (for example, a clean close applied in one call) is judged normally: the end state hits and a no-op answer is fine on that variant only.

### 1.5 Interface (B2 owns `tools/eval/nextstep.ts`; B4b fills `tools/eval/nextstep-cases.ts`)

```ts
export type Arm = "none" | "skill" | `recipe:${string}`;
export type Group = "c1_wait" | "c2_close" | "c3_notes" | "c4_read" | "c5_outcome" | "c6_skill" | "guard";
type St = Record<string, string>;

export interface LeadStep {
  cmd: string;
  killAfterMs?: number;            // a step the shell kills (wait_shell_limit)
  expect?: (sb: Sandbox, st: St) => Promise<string | null>; // surface-independent precondition
}

export interface NextCase {
  id: string;
  group: Group;
  /** headline: scored for its group; guard: no-regression only (R2, every group). */
  role: "headline" | "guard";
  arms: Arm[];                     // frozen
  shell: "bash" | "zsh";
  limitMs?: number;                // default 120_000
  expectedRowMs: number;           // wall estimate, for the plan (§4.2)
  paraphrases: { id: string; goal: string; payload?: string; leadIn: "a" | "b" }[];
  leadInVerbs: string[];
  seed(sb: Sandbox): Promise<St>;
  leadIn(sb: Sandbox, st: St, v: "a" | "b"): LeadStep[];
  go?(sb: Sandbox, st: St): Promise<void>;     // default: touch <workers>/go
  judge(ctx: NextCtx): Promise<ColdEffect>;    // ColdEffect from cold-intents.ts
  allow?: (o: OpRow) => boolean;
  allowKilled?: boolean;
  golden(st: St, v: "a" | "b"): string[];      // 1-3 commands on base; may use seeded state (rev, sha)
  bad(st: St, v: "a" | "b"): string[];         // a plausible wrong answer (§2.3)
}

export interface NextCtx {
  sb: Sandbox;
  state: St;
  base: number;                    // ops seq after the lead-in
  t0: number;                      // answer start
  runs: (GuessRun & { cmd: string; killed: boolean; start: number; end: number })[];
  calls: MuCall[];                 // answer's mu calls
  output: string;                  // combined stdout+stderr of every answer command, ANSI stripped
}

export function answerMetrics(ctx: NextCtx): RunMetrics;   // §1.2 adapter

export interface NextJob {
  round: "r1" | "r2" | "b5" | "check";
  group: Group;                    // the tournament group the job belongs to
  surfaceLabel: string;            // "base" or the variant id
  surface: Surface;
  model: string;                   // "evalfaux/golden" | "evalfaux/bad" short-circuit (selftest)
  caseId: string;
  arm: Arm;
  paraphrase: string;
  rep: number;                     // fresh per round: R2 never reuses an R1 rep index
}

export interface RunNextOpts {
  jobs: NextJob[];                 // the driver builds and shuffles them (seed in the setup row)
  out: string;                     // probe.jsonl; resumable by (round, surfaceLabel, model, caseId, arm, paraphrase, rep)
  promptDir: string;               // prompts/<sha>.txt
  concurrency: number;             // row slots (§4.2 wall budget)
  modelConcurrency: number;        // concurrent askModel calls per provider
  maxLoad: number;                 // no new row starts while the 1-min loadavg exceeds this
  providerExt?: string;
  cases?: NextCase[];              // default: nextstep-cases.ts
  onRow?: (row: ProbeRow) => void;
}

export async function runNext(o: RunNextOpts): Promise<{ written: number; skipped: number }>;
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
promptSha systemSha transcriptPath
reply commands[] tooMany perCommand[{cmd exit killed start end}] muCalls[]
hit partial invalid why[] stray[] destructive[{entry source callIdx}] tokens ms modelError?
```

`markersSeen`, `exposed`, `nameCue` and `attributable` are **not** row fields. The driver's score pass derives them from the stored prompt and the variant's derived markers (`exposure.ts`, §5) and writes them into `round_score` cells. The prompt text is stored once per `promptSha` under the run dir (§6). Rows are resumable by the `RunNextOpts.out` key.

## 2. Case catalogue (B4b writes them; observables fixed here)

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

**Fixtures B4a adds to `tools/eval/fixtures.ts`** (the worker driver, `fixtures.ts:67-160`, has none of them today):
- `gate: { delayMs }` on a task script: the generated `T.sh` starts with `while [ ! -e "$W/go" ]; do sleep 0.2; done; sleep <delay>`. The driver itself is unchanged, so every existing scenario keeps its behaviour.
- `chromePane(sb, name, lines)`: a `--command` pane that prints pi-like chrome (blank lines, `─` rules, `↑` rows, `Working…`) and then the given lines, and stays alive.
- `seedDelegate(sb, { label, task, brief, report, verdict? })`: a delegate task seeded through the real verbs `mu delegates register | mark | finish`, so its notes, its wave tally and its check row are what mu itself writes.

Arms are `none, skill, recipe:<r>`, where `<r>` is the named recipe.

| # | Case | Group | Recipe arm | Seed and lead-in (live) | Goal (p1; others vary wording) | Judge observable | Partial / allowed |
|---|---|---|---|---|---|---|---|
| 1 | `close_preview_apply` | c2 | merge | worker-1 spawned `--worktree`; its commit cherry-picked onto main. Lead-in `mu agent close worker-1 -w auth` prints the preview. **b:** the same, piped `2>&1 \| tail -5`. | "worker-1's work is on main now; get rid of it." | worker-1's agent row is gone (`agent.close` op), its worktree dir is removed, `lostWork` is empty. | Partial: a second preview with no apply. Allowed: `agent.*` ops for worker-1. |
| 2 | `close_preview_conflict` | c2 | merge | worker-1 has one commit `C` **not** on main (the preview's worktree line names it unmerged). Same lead-in. **b:** the friction's scrape pipeline as the last step: `mu agent close worker-1 -w auth 2>&1 \| grep -o 'mu agent close.*--if [0-9]*' \| head -1 \| sh` prints nothing. | "Make sure worker-1's commit ends up on main, then get rid of worker-1." | `C` is on main (sha or patch-id, `provenance.ts`), **and** worker-1's agent row is gone, **and** `lostWork` is empty. | Partial: `C` on main, worker-1 still registered. Allowed: a cherry-pick or merge, `agent.*` ops for worker-1. A discarding close is destructive. |
| 3 | `wait_result_read` | c1 | orchestrator-loop | worker-1 is spawned on t1 with `--send`, and its final text is `REPORT-<nonce>: <one line>`. One lead-in only (variant a of revision 1 is dropped: its snapshot already printed the marker): `mu wait agent:auth/worker-1@<runs> --json \| jq -c '{exit:.data.exit, firing:.data.firing}'` (orch F1: 304 of 430 waits filtered). | "What did worker-1 report? Show me its result line." | `shown(REPORT-<nonce>)`. No answer command reads the sandbox `sessions/` or a pane's session file. | Partial: the answer shows worker-1 or t1 state without the line. |
| 4 | `wait_heartbeat_merge` | c1 | orchestrator-loop | t1 is owned by worker-1, **gated**, delay 75 s after `go` (the heartbeat interval is 60 s, `src/cli/wait.ts:64`). The gate stays shut through the lead-in, so the lead-in wait cannot fire; it ends on its own `--timeout 70`, after one heartbeat line. Lead-in: `mu wait task:auth/t1 --json --timeout 70 2>&1 \| python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["data"]["firing"])'` → `JSONDecodeError`, because the heartbeat line comes first (orch F5, linuxpc #6). At answer time t1 is still IN_PROGRESS and closes 75 s after `go`. | "Find out how t1 ended." | The answer's output shows t1 CLOSED (`showsClosed`) through a mu call that observed it after `t0`. No answer command was killed. | Partial: nothing killed, t1 not shown CLOSED. |
| 5 | `wait_shell_limit` | c1 | orchestrator-loop | worker-1 is spawned with `--send` on t1, **gated**, delay 200 s after `go`, so no single 120 s call on the default 1500 s timeout (`wait.ts:66`) sees it finish. Lead-in: the spawn (its `next: mu wait …`), then that hint run with `killAfterMs: 120000` → `Command timed out after 120 seconds` (linuxpc N4). | "Get worker-1's result once it is done." | No answer command killed. Every blocking mu call (`WAIT_MS`, `observe.ts:53`) ended on its own. And `shown(REPORT-<nonce>)`. | Partial: nothing killed, result not shown (clean timeouts). A kill is a miss. |
| 6 | `notes_report_read` | c3 | tasks-or-calls | `seedDelegate`: `delegate_rev_<n>` with a 40-line report; line *k* carries `RL-<nonce>-<k>`, the brief carries `BRIEF-<nonce>`. Lead-in `mu task notes delegate_rev_<n> -w auth` prints the brief and the report with `\n` escapes (worker F2: 98 `sed` unescapes; linuxpc #4: 272). | "Show me only the reviewer's findings, readable line by line." | `shown` holds for `RL-…-1` through `RL-…-40`. In the answer's output, no line holds two consecutive `RL` markers (real newlines). `BRIEF-<nonce>` is not in the last answer command's output. | Partial: every marker shown, with escapes or with the brief. |
| 7 | `notes_multi` | c3 | — | t1, t2 and t3 have notes `N1-`, `N2-`, `N3-<nonce>`. **zsh.** Lead-in `mu task notes t1 -w auth`. | "Now give me the notes of t2 and t3 too, each one labelled." | `shown(N2-…)` and `shown(N3-…)`. Every answer command exits 0 (the zsh `echo ===` failure, worker F3: 27 calls, 25 sessions). | Partial: one of the two shown. |
| 8 | `agent_read_text` | c4 | — | `chromePane` worker-1: 30 blank lines, `─` rules, `↑` rows, `Working…`, then `PANE-<nonce>: tests 41 passed`. Lead-in `mu agent read worker-1 -w auth` (orch F4, linuxpc #5: 176 filtered reads). | "What did worker-1 last say? Just its words." | `shown(PANE-<nonce>)`. The last answer command's output has at most 3 lines that are blank or consist only of box-drawing or arrow glyphs. | Partial: shown with the chrome. |
| 9 | `delegate_no_verdict` | c5 | adversarial-review | `seedDelegate`: a check on t4 whose delegate answer has no VERDICT line: "All four fixes are in place. I found no real problems." (`delegate-verdict.ts:65` → `NO VERDICT LINE: …`). The wave is tallied UNVERIFIED. Lead-in `mu wait --wave w1 -w auth`. | "Did the review of t4 pass? If the reviewer gave no clear verdict, get one." | After `t0`: a new check of t4 is recorded (a `checks` row for t4, `src/db-checks.ts:27`), **or** a prompt is delivered to t4's reviewer (`deliveries`). **And** no CONFIRMED or REFUTED verdict is recorded for any check of t4 after `t0`, and t4 is neither closed nor reopened. | Partial: the reviewer's sentence `shown`, nothing dispatched. An UNVERIFIED verdict is allowed. Recording CONFIRMED from the prose is a miss (Q4 settled, §9). |
| 10 | `close_already_closed` | c5 | orchestrator-loop | worker-1 closes t2 with the verb (close-mode `verb`), commits, and prints no CLOSE block. Lead-in `mu wait agent:auth/worker-1@<runs>` → `close:{applied:false, reason:"no CLOSE block…"}` (`close-block.ts:244`; harness2 O3). | "If t2 is finished, bring worker-1's commit onto main; otherwise have worker-1 finish it." | The worker's commit is on main (sha or patch-id). No prompt is delivered to worker-1 after `t0` (`deliveries`). t2 is still CLOSED, and its claim count is unchanged. | Partial: the commit is merged and a redundant prompt is sent. |
| 11 | `dead_once` | c5 | recovery | worker-1 dies on t1 (`dieOnce`). Lead-in: a wait fires `dead agent:…`; the rig respawns worker-2 for t1 (`spawn --task t1 --attempt 2 --send`); a second wait fires `dead task:…` for the same death (harness2 O6). **B4b must first reproduce the double event on base; if it cannot, the case is dropped and the report says so.** | "Keep t1 moving." | No third agent spawned for t1. worker-2 still owns t1. Claim count for t1 unchanged after `t0`. **And** a positive observation: an answer mu call's own output names both `worker-2` and t1 and is visible (`shown`), or a mu wait on worker-2 or t1 was armed after `t0` (a blocking call, `WAIT_MS`, that blocked ≥ 1 s or fired), or a prompt was delivered to worker-2. | Partial: the state is right and nothing was observed. |
| 12 | `sleep_poll` | c6 (also c1) | orchestrator-loop | Wave w1: t1-t3 spawned with `--send`, **gated**, delays 20/40/60 s after `go`. Lead-in: the three spawns; the last output carries `next: mu wait …` (orch F6, linuxpc #12: 58 loops). | "Tell me when all three are finished, and how each one ended." | All three observed CLOSED by answer mu calls (`observedClosed`). `pollingCalls` and `idleCalls` over `answerMetrics(ctx)` are both empty. No kill. | Partial: all observed, but by polling. |
| 13 | `sql_name_guess` | guard | — | Two workstreams with tasks; t1 has note `SN-<nonce>`. **a:** lead-in `mu sql "SELECT name, status FROM tasks WHERE workstream='auth'"` → column error. **b:** `mu sql "SELECT body FROM notes WHERE task='t1'"` → no such table (linuxpc N2: 18% of sql calls failed). | a: "List the auth items with their states." b: "Show the text of t1's notes." | a: answer mu output lists every auth task id with its state (`listsOpen`/`reads`), and no id of the other workstream. b: `shown(SN-<nonce>)`. | — |
| 14 | `finding_guess` | guard | findings | A finding task `high_x` with title `HX-<nonce>` and note `HN-<nonce>`. Lead-in `mu finding show high_x -w auth` → unknown command (linuxpc N3). | "Show me that finding." | `shown(HX-<nonce>)` and `shown(HN-<nonce>)`. | Partial: one of the two. |

Cases 13-14 guard against A4/A5 regressions in every group. They are no-regression only and never win. Holdout scenarios contribute no case.

`refuter_family_unknown` (C6, `recipe:models`) is optional for B4b. It runs on an orchestrator whose `mu state` shows an unknown model family. Observable: a check recorded with a claude checker (`checks.checker`, `src/db-checks.ts:27`), or an agent spawned with the claude CLI. Muse keep-driving and the brief-template syntax (C6) have no one-shot observable and go to R4 only.

### 2.1 New cold-guess intents (B4a, `tools/eval/cold-intents.ts`)

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

### 2.2 New R4 scenarios (B4a, `tools/eval/scenarios/`)

Only where no existing scenario exercises a group's text (R3 decides, §4.4). Each gets a golden, three distinct bads and `check --family next`.

| Scenario | What it does | Judge |
|---|---|---|
| `poll_wave` | 3 workers with staggered delays. | Each worker's work is merged after its close, plus 0 `pollingCalls` and 0 `idleCalls`. |
| `multi_notes` | The umbrella must get one note summarising four tasks. | The note holds each task's report marker. |
| `wait_report_act` | A worker's final text says `REPORT: reopen t2 (<nonce>)`. | t2 reopened after that settle, and no session file read. |

### 2.3 Judge check: `true`, a plausible bad, and the golden, per case

This is what `nextstep check` must prove on base for every lead-in variant. B4b writes the goldens and bads to the effect described; the spellings below are base spellings. `<rev>`, `<sha>`, `<runs>`, `<c>` come from the seed state.

| # | `true` | Plausible bad → result | Golden → result |
|---|---|---|---|
| 1 | Miss: worker-1's row remains. | `mu agent close worker-1 -w auth` (re-preview) → miss, partial. | a: `mu agent close worker-1 -w auth --if <rev>`; b (rev cut by `tail`): `mu agent close worker-1 -w auth --if "$(mu agent close worker-1 -w auth --json \| jq -r .data.revision)"` → row gone, worktree gone, nothing lost: hit. |
| 2 | Miss: `C` not on main. | `mu agent close worker-1 -w auth --if <rev>` (apply without merging) → `C` kept on a branch, not on main: miss, not destructive. | `git cherry-pick <sha>`, then `mu agent close worker-1 -w auth --if <rev>` → hit. |
| 3 | Miss: nothing shown. | The same `--json \| jq -c '{exit,firing}'` wait again → `REPORT` in mu-out but filtered from the output: miss. | `mu wait agent:auth/worker-1@<runs>` (fires at once, snapshot printed) → hit. |
| 4 | Miss: no CLOSED observed after `t0`. | The same python pipeline without `--timeout` → heartbeat at 60 s, fires at 75 s, `JSONDecodeError` again; CLOSED only in mu-out: miss. | `mu wait task:auth/t1 2>/dev/null; mu task show t1 -w auth` → fires at ~75 s, CLOSED shown: hit. |
| 5 | Miss: nothing shown. | The hint again (`mu wait agent:auth/worker-1@<runs>`) → killed at 120 s: miss. | Three blocks `mu wait agent:auth/worker-1@<runs> --timeout 110` → first ends on its own at 110 s, second fires at ~200 s with the snapshot: hit. |
| 6 | Miss: nothing shown. | `mu task notes delegate_rev_<n> -w auth \| sed 's/\\n/\n/g'` → markers and newlines fine, but `BRIEF` shown by the last command: miss (partial). | `mu task notes delegate_rev_<n> -w auth --json \| jq -r '.data[] \| select(.kind=="report") \| .content'` → hit. |
| 7 | Miss: nothing shown. | `mu task notes t2 -w auth; echo ===; mu task notes t3 -w auth` under zsh → `zsh: = not found`, exit 1: miss (partial). | Two blocks, `mu task notes t2 -w auth` and `mu task notes t3 -w auth` → hit. |
| 8 | Miss: nothing shown. | `mu agent read worker-1 -w auth` again → chrome lines > 3: miss (partial). | `mu agent read worker-1 -w auth \| grep -vE '^[[:space:]─━│↑↓]*$'` → hit. |
| 9 | Miss: no new check, no delivery. | `mu task verdict t4 --check <c> -w auth "VERDICT: CONFIRMED"` → a CONFIRMED verdict recorded from prose: miss. | `mu task check t4 -w auth --by claude --brief "Re-review t4 and end with a VERDICT: line"` → new check row, no verdict: hit. |
| 10 | Miss: commit not on main. | `mu agent send worker-1 -w auth "finish t2"` → a delivery, commit not on main: miss. | `mu task show t2 -w auth`, then `git cherry-pick <sha>` → hit. |
| 11 | Miss: no observation, no wait, no delivery. | `mu agent spawn worker-3 -w auth --task t1 --attempt 3 --send` → a third agent: miss. | `mu task show t1 -w auth` → output names owner worker-2 and t1: hit. |
| 12 | Miss: nothing observed. | `for t in t1 t2 t3; do until mu task show $t -w auth \| grep -q CLOSED; do sleep 5; done; done` → polling and idle windows: miss (partial). | The base wave wait over w1 (B4b writes the spelling), then `mu task list -w auth` → all three CLOSED, no polling: hit. |
| 13 | Miss (a and b): nothing listed or shown. | a: the same `name`/`workstream` query → column error again: miss. b: the same `body`/`notes` query: miss. | a: `mu task list -w auth`; b: `mu task notes t1 -w auth` → hit. |
| 14 | Miss: nothing shown. | `mu finding show high_x -w auth` again → unknown command: miss. | `mu task show high_x -w auth` then `mu task notes high_x -w auth` → hit. |

JSON field names and the wave-wait spelling in these goldens are illustrative; B4b writes base's real ones. If any row of this table fails on base in B4b, the case is fixed before the freeze, never after.

## 3. Variants and designer isolation

### 3.1 A variant is a patch on a built surface copy

- **Base.** `tournament build` prepares `hill2-base` with `prepareSurface` (`tools/eval/surface.ts:104`) at the base sha: main after phase A, the same sha as B5.
- **Variant.** `tools/eval/candidates/<group>/<v>.patch` (gitignored) plus `<v>.json`:
  ```json
  { "id": "c1-a", "group": "c1_wait", "kind": ["output"|"verb"|"error"|"skill"|"recipe"],
    "summary": "one line" }
  ```
  The manifest carries no markers. The driver derives them (below).
- **Build.** The driver copies the base surface dir (including `node_modules`) to `~/.cache/mu/eval/surfaces/hill2-<v>`, runs `git apply --check` then `git apply`, then `npm run build`, and stamps `.ref = <base sha>+<sha256(patch)[:12]>`.
- **Marker derivation** (`deriveMarkers`, B3b). From the patch's hunks:
  1. **Changed strings.** In `src/` and `extension/`: every string literal on a `+` line (quotes, backticks; a template splits at `${…}` into literal segments) that is not present verbatim on a `-` line of the same hunk. In `skills/`: every `+` paragraph or list item, word-diffed against its `-` counterpart; the added word runs are its changed parts. Each changed string is paired with its base counterpart (the `-` string it replaced, by position in the hunk), or has none.
  2. **Markers** = changed parts of at least 12 characters (whitespace collapsed) that occur in the variant's `dist/` or `skills/` and in **no** place in base's `dist/` or `skills/`.
  3. **Context markers** (for cuts and rewordings, where the new text may be short): base counterparts of at least 12 characters that the patch removed or rewrote. Each must occur in **exactly one** place in base's `dist/` plus `skills/` (one file, one offset). A string that occurs more than once in base is rejected, so a common string such as `next:` cannot mark every row as exposed.
  4. Exposure (§5) matches markers in variant rows and context markers in base rows only, so a context marker that the variant removed is never "seen" on the variant.
- **Admission** (each failure is blocking and goes into the `variant` row):
  - the patch touches only `src/`, `extension/`, `skills/`;
  - it builds, and `node dist/cli.js --help` exits 0;
  - SKILL.md is at most 600 words and recipes at most 4000 (`wc -w`);
  - **length cap per changed string**: a changed string is at most `max(⌈1.25 · base⌉, base + 40)` characters and never more than `base + 120`, where `base` is its counterpart's length; a string with no counterpart is at most 120 characters. This keeps a variant from winning by pouring text into `next:` hints;
  - the derived markers are non-empty (a variant whose change no model can see cannot be exposed, so it is refused).
- **Text delta.** The driver computes it: SKILL.md and recipe word delta, plus the changed characters of string literals in the patch. The final tie-breaks use it.
- **Non-blocking checks**, recorded as `goldenCompat`: `nextstep check`, `cold-guess check` and `check --family next` on the group's R4 candidate scenarios, on the variant. A broken golden script is not a broken judge; the landing unit fixes the script.

### 3.2 Judges are frozen first; the designer never sees cases, judges or lead-ins

**Freeze.** `tournament freeze <group>` runs after B2, B3a, B3b, B4a and B4b are merged, after B5 has fixed the n plan (§4.2), and with `nextstep check`, `cold-guess check` and the R4 `check` green on base. It writes `{kind:"freeze", judgesHash, files[], nPlan}`.
- `judgesHash` is the git tree hash of `tools/eval/` (excluding `candidates/`) plus `test/eval/fixtures/`.
- Every later command refuses to run when the hash differs.
- A judge may change only when a real row scored wrong. That takes a `refreeze` row with the row id and the reason, and every round of the group already run is re-run with fresh rows.

**Pack.** `tournament pack <group>` exports base into `~/.cache/mu/eval/packs/<group>/`, a fresh git repo at the base tree, then deletes:
- `tools/eval/`, `test/eval/`, `docs/eval/`,
- `docs/specs/2026-11-07-hill-r2-tournament.md`,
- `docs/history/`, `CHANGELOG.md`.

It then adds `BRIEF.md`, rendered from a human-written `tools/eval/candidates/<group>/brief.src.md`. BRIEF.md holds only:
- the group's candidate list from the `hill2` brief (Phase C);
- a **problem statement and counts** per friction finding, in prose (for example: "Most orchestrator waits were filtered through a JSON tool, 304 of 430, and the filter dropped the worker's result"), never a transcript, a command line or an output excerpt;
- the caps (SKILL.md 600 words, recipes 4000, the per-string length cap), and VISION.

`pack` refuses a BRIEF.md that contains any of:
- a fenced code block, or a line starting with `$ `;
- any lead-in step command of any case (placeholders as wildcards), or any 16-character substring of one;
- a case id, any goal paraphrase, or any 5-word run of a goal;
- a judge file name;
- a deleted path.

It also asserts that none of the deleted paths exist in the pack.

**Designer.** A strong model (Q2), spawned with:
- cwd = the pack;
- `MU_DB_PATH` = an empty temp DB, `MU_SYNC_DIR=` blank, `MU_STATE_DIR` = a temp dir, so `mu task notes` on crew-hill2 sees nothing;
- a brief: write 3-6 variants as patches against the pack, each with its manifest, and read nothing outside the pack.

**Isolation audit.** `tournament build` greps the designer's session files for the deny list:
- case ids, `nextstep`, `cold-intents`, `hill-r2-tournament`, `docs/eval`;
- `tools/eval` and `test/eval` under any directory (any checkout, any worktree);
- the main checkout's path and `~/.local/state/mu-next/worktrees/` (every crew worktree);
- `~/.cache/mu/eval/surfaces/` (built surfaces carry `tools/eval`, `surface.ts:104`) and `~/.cache/mu/eval/packs/` other than its own pack;
- `~/.local/state/mu-next/eval-transcripts/`;
- `task notes` calls on `hill2` or any `b*` or `delegate_friction-*` task.

The result is written as `{kind:"isolation", session, hits}`. Any hit discards every variant of that designer session.

**Order per group.** freeze → pack → design → isolation audit → build (markers, admission) → R1.

## 4. Rounds: successive halving

### 4.1 Tests, wins, losses

**Unit of test.** A cell is (surface, case, model). Each cell pools its rows across arms and paraphrases. Rows are **not** paired: base and variant rows are two independent samples, run in one interleaved, shuffled queue per round (seed in the `setup` row), so provider drift hits both sides alike. B5 rows set the spread and the correlation estimate only; they are never a round's comparator.

**Correlation.** Rows that share (arm, paraphrase) share a prompt up to nonces, and the cold-guess record says such reps are highly correlated (`docs/eval/cold-guess.md`). A **cluster** is (arm, paraphrase). With `m` clusters of `r` rows each and intra-cluster correlation `ρ`:
- design effect `DEFF = 1 + (r − 1)·ρ`;
- effective n `n_eff = m·r / DEFF`, which tends to `m/ρ` as `r` grows: extra reps stop helping, extra paraphrases do not.
- `ρ̂` is estimated per (case, model) from B5's base rows (one-way ANOVA ICC over clusters), floored at 0.1 and written into the `setup` row before the freeze. It is never re-estimated from round rows.
- **Scaled counts** (Kish): every test below uses `n* = round(n / DEFF)` and `hits* = round(hits / DEFF)` for each side.

**Exact test.** One-sided Fisher exact test on the scaled 2×2 table (`stats.ts`, B3a). Fisher is conservative; the n plan below is computed with Fisher's exact power, so the stated power is a lower bound.

**Loss.** For each variant and round, the **loss family** is every (case, model) test of that round, all three models, plus the cold-guess guard (rows pooled across intents, one test per model, clusters = intents). Each test is H0: `p_variant ≥ p_base`, over **all** rows, exposed or not, `nameCue` rows kept. Holm step-down at family-wise α = 0.05. A loss is any test Holm rejects.

**Win** on headline case `c` (exposure gates wins only):
- Rows counted: the variant's **exposed clusters**, those (arm, paraphrase) clusters in which at least half the variant's rows are exposed (§5.1), minus `nameCue` rows. Base rows of the same clusters are the comparator.
- At least 4 exposed clusters, else the case is `unexposed` for that variant.
- Win if either:
  - (a) both weak models separately give one-sided Fisher p ≤ 0.05 (H0: `p_variant ≤ p_base`), or
  - (b) the two weak models' scaled counts, summed, give p ≤ 0.0228 (one-sided z ≥ 2), Holm-adjusted across the group's `h` headline cases (the smallest p must clear 0.0228/h, and so on).
- And no loss on `c` for any of the three models (any loss eliminates anyway).

Under the null, route (a) fires with probability 0.0025 per case and route (b) at most 0.0228 across all `h` cases, so a null variant wins somewhere in the round with probability below `h·0.0025 + 0.0228` (≈ 3.3% for h = 4), before R4.

**Elimination.** A variant is out on:
- any loss (Holm, above);
- any attributable destructive entry (§5.2);
- any `invalid` lead-in row on a headline case (§1.4 lint 3).

### 4.2 Sample sizes, power and wall time

**Effect to detect.** A realistic text fix moves a weak model from 0.5 to 0.8 hit rate on its case. Fisher exact power (one-sided, computed by enumeration, two samples of `n_eff` each):

| `n_eff` per side | win power 0.5→0.8 at α 0.05 | win MDE at 80% (α 0.05) | loss MDE at 80%, Holm first step of 45 tests |
|---|---|---|---|
| 18 | 0.50 | 0.5 → 0.91 | 0.8 → 0.16 |
| 40 | 0.84 | 0.5 → 0.79 | 0.8 → 0.35 |
| 60 | 0.96 | 0.5 → 0.74 | 0.8 → 0.44 |
| 90 | 0.99 | 0.5 → 0.69 | 0.8 → 0.51 |

Later Holm steps have more power; the first step is the worst case.

**Targets.** R2 is the deciding round.
- Own-group headline cases: `n_eff ≥ 60` per (surface, case, model) over all clusters. A skill or recipe variant is exposed on two of the three arms, so its win test sees about two thirds of the clusters: `n_eff ≈ 40`, power 0.84 per weak model for 0.5→0.8, and route (b) pools both models.
- Cross-group headline cases and guards (no-regression only): `n_eff ≥ 40`.
- R1 is a screen: one row per cluster (`r = 1`, `DEFF = 1`), `n_eff = m`.

**The n plan** (`tournament plan`, B3b; written into the `freeze` row). For each case: `m` = paraphrases × arms, and the smallest `r` with `m·r / (1 + (r − 1)·ρ̂) ≥ target`. If `m/ρ̂ < 1.25 × target` (reps cannot reach it), B4b adds paraphrases (up to 12) before the freeze; if it is still short, the case's achieved `n_eff` and MDE are written in the `freeze` row and the report. Planning values at `ρ̂ = 0.2` (B5 replaces them):

| Case kind | Paraphrases × arms (`m`) | R1 `r` → `n_eff` | R2 `r` → `n_eff` | R2 rows per (surface, case, model) |
|---|---|---|---|---|
| own headline | 6 × 3 = 18 | 1 → 18 | 8 → 60 | 144 |
| cross-group headline | 6 × 3 = 18 | — | 4 → 45 | 72 |
| guard with arms `none, skill` (case 13; case 14 is as cross-group) | 6 × 2 = 12 | — | 8 → 40 | 96 |

At `ρ̂ = 0.3`, 18 clusters cap `n_eff` at 60, so the plan adds paraphrases to 10 (`m = 30`, `r = 5` → 68).

**Rounds.**

| Round | What runs | Rows | Models | Advance (fixed counts) |
|---|---|---|---|---|
| R1 | Group headline cases × all arms, base plus N variants (N = 3-6) | `r = 1` per cluster (18 per cell) | haiku, gemini, **sonnet** | Exactly `A1 = min(⌈N/2⌉, E1)` variants, where `E1` = survivors (not eliminated) whose R1 score is > 0. |
| R2 | **Fresh rows** (new rep indices, new nonces; R1 rows never enter R2 scoring or ranking). Own headline cases at the R2 plan; every other group's headline cases and the guards at the cross-group plan; the cold-guess headline intents (3 reps × 3 models). | §4.2 plan | all three | Exactly `A2 = min(2, W2)` variants, where `W2` = survivors with at least one win. If `W2 = 0`, the group ends and base stays. |
| R3 | Exposure and behaviour scan (§4.4). No scoring. | — | haiku (live part) | Scenarios that exercise each finalist. |
| R4 | Finalists plus base on the exercising scenarios, fresh runs. | §4.5 | haiku, gemini, sonnet | §4.5 decision. |

**Ranking and ties** (total order; the last key never ties):
- R1 score = sum over the group's headline cases of the pooled weak-model z (two-proportion z on scaled counts of exposed clusters; 0 for an unexposed case). Order: R1 score, then total weak-model hits on exposed rows, then mean probe tokens (lower), then text delta (shorter), then variant id (ascending).
- R2: number of wins, then the sum of the win cases' pooled z, then total weak-model hits on exposed rows, then mean probe tokens, then text delta, then variant id.

**Wall time and load.** Expected row wall (`NextCase.expectedRowMs`), from the timing above: cases 1, 2, 6-11, 13, 14 about 30 s (sandbox, seed, lead-in, model, a short answer); case 3 about 40 s; case 4 about 160 s (70 s lead-in, model, 75 s answer); case 5 about 380 s, worst 480 s (120 s lead-in kill, model, up to 3 × 120 s of answer; the golden takes about 200 s); case 12 about 100 s.
- **Concurrency** on the mac (16 cores): 24 row slots (`concurrency`); most of a long row is a blocked wait or a gated sleep, not CPU. At most 8 concurrent `askModel` calls per provider (`modelConcurrency`). Each row owns one private tmux server (`sandbox.ts:44-48`), so at most 24 tmux servers at a time; the sandbox teardown kills its server (`sandbox.ts:264`) before the slot frees. No new row starts while the 1-min load average exceeds 14 (`maxLoad`). The driver queues long-case rows first so they do not leave a tail.
- **Estimate per group** (N = 6, own headline h = 4, 3 R2 survivors plus base, mean row 70 s across all cases, 170 s for c1's cases): R1 about 1.5k rows, 1.5-3 h; R2 about 7k own rows plus 7-8k cross-group rows, 9-20 h; R4 about 400 runs at 6 concurrent AUT runs, about 7 h. So 1-1.5 days per group and 5-8 days for six groups run one after another (Q1). `tournament plan` prints the estimate from the frozen plan before R1, and the `spend` rows record the real wall.

### 4.3 R2 no-regression covers more than the group

A text change can break a verb another group relies on, for example a C1 wait output change against case 10's settle. R2 therefore runs every headline case of every group, plus the guards, plus cold-guess, on the survivors, all in the one loss family of §4.1. A loss anywhere eliminates the variant.

### 4.4 R3: which scenarios exercise the change

Candidates are every non-holdout scenario in `tools/eval/scenarios/` plus B4a's new ones.

1. **Text, zero cost.** Run `check --family next --surface hill2-<v> --scenarios <all>` and the same on base. A scenario exercises the variant if any of its derived markers appears in a variant golden's `mu-out`, or one of its context markers in a base golden's `mu-out`.
2. **Behaviour, zero cost.** For `verb`, `error` and `output` variants: a scenario also exercises the variant if, for the same golden, any mu call's exit status or `mu-out` text differs between base and variant (nonces and timestamps normalised). This catches a change that alters exit codes or `--json` shape with no marker.
3. **Skill or recipe variants, and any variant with fewer than 2 scenarios from steps 1-2:** 2 live haiku runs per candidate scenario on the variant. The exposure log (§5.1) decides.
4. A scenario **exercises** a variant if step 1 or 2 hits, or at least 1 of the 2 live runs is exposed. R4 uses every behaviour-diff scenario and the marker-exercising ones with the most exposure, up to 6 in total.
5. **If no scenario exercises a finalist, it cannot win.** B4a (or the C unit) must first add a scenario that exercises it (§2.2). The report says so.

R3 rows are `{kind:"scan"}`. The live runs are not scored.

### 4.5 R4 gate

**Primary measure: completion**, with an exact test. Scenarios are a fixed test set and each run is an independent session in its own sandbox, so runs of one scenario are independent given the scenario; R4 uses raw counts, no DEFF.
- Per model (haiku, gemini, sonnet), pool every run of every exercising scenario: one-sided Fisher exact on completed counts, H0: `p_variant ≥ p_base`. Holm across the three models at family-wise α = 0.05. A rejection is a loss and eliminates the finalist.
- **Every run counts**, exposed or not (exposure gates wins only). Per-scenario counts and exposed counts are reported, never gated on.
- **Reps.** `n ≥ 48` runs per (surface, model) pooled, so a completion drop of 0.8 → 0.5 is caught with 80% power at the first Holm step (α 0.05/3; Fisher exact power 0.80 at n = 48). Reps per scenario `r = max(5, ⌈48/k⌉)` for `k` exercising scenarios: k = 3 → 16, k = 4 → 12, k = 6 → 8.
- **Exercised precondition** (for winning, not for losses): a finalist needs at least one exercising scenario in which at least half of its runs are exposed, for at least one weak model. Otherwise it cannot win (§4.4 step 5).

**Destructive entries** follow §5.2.

**Cost is the tie-break, never a gate.** Per-rep mean of `tokens + 10*muErrors + 50*wrong`, with the base spread (max − min of per-rep totals) reported as in the old round. The old spread (694k tokens per rep) swamps any text effect, so cost only orders finalists that both pass.

**Decision.** The winner is the finalist that passes R4 with the most R2 wins, then the larger sum of R2 win-case pooled z, then lower R4 mean cost, then the shorter text delta, then variant id. If no finalist passes, base stays. Base cannot be beaten on a tie: a winner needs a probe win.

### 4.6 Holdouts and the final gate (C7)

Holdouts run **once**, only in `tournament final`, on the final combined winners surface: 4 scenarios × 3 models × 12 reps (48 runs per model), against base, fresh. Rows go to `holdouts.jsonl`, and logs go to a `sealed/` dir that the report never opens.

- The §4.5 loss test (Holm over three models) or any destructive entry new against base is a **stop**: `{kind:"review_stop", source:"holdout"}`, `ntfy-ping`, exit 7.
- There is **no bisection** and no re-run of holdouts on a subset. A person (with the C7 unit) decides from the non-holdout evidence (R2 and R4 rows, which winner touched what) whether to drop a winner. If any winner is dropped after a holdout stop, the report states that the holdouts have been spent and the new combination has no clean holdout result.
- A person opens `sealed/` only after the decision is written.

## 5. Exposure log and attributable destructive (B3a, `tools/eval/exposure.ts`)

`exposure.ts` is the only module that computes `markersSeen`, `exposed`, placement and `attributable[]`. `nextstep.ts`, `tournament.ts` and the report call it.

### 5.1 Exposure log

**Probe.** `markersSeen` = the variant's derived markers found in the row's full prompt (system plus user), read from `prompts/<sha>.txt`; for a base row, its context markers. `exposed` = `markersSeen` is non-empty. By construction:
- a skill variant is unexposed on arm `none`,
- a recipe variant is exposed only on its own recipe arm,
- an output variant is exposed only if its lead-in printed the changed text.

**R4.** A per-run list `exposure[] = {turn, callIdx, where, marker}`. `where` is one of:
- `system` (the skill's frontmatter description, which pi puts in the system prompt),
- `prompt`,
- `tool` (a tool result's text, `ToolCall.output`, `events.ts:150`: the text the model saw after any pipe and pi's truncation, whether from `bash` or `read`).

A marker in `mu-out` that the AUT piped away does **not** count. A run is `exposed` if `exposure[]` is non-empty.

- **Turn.** B3a adds `ToolCall.turn` (the index of the assistant message that issued the call) and `ToolCall.idx` (its position in that message) in `MetricsCollector` (`events.ts`).

**Hard precondition.** No variant wins on rows where it was not exposed (§4.1, §4.5). Base needs no exposure. Exposure never shields a loss.

### 5.2 Attribution of destructive entries (R4 and probes)

B3a extends `Verdict` with `destructiveFx: {entry, at: {turn, idx} | null, source}[]`, built next to `destructive[]` (which is kept for old reports). Placement:

| Source | How the entry is placed |
|---|---|
| `genericDestructive` | The tool call itself. |
| `destructiveOps` | The op's `ts` → the tool window containing it (`toolWindows`, `observe.ts:119`). |
| `localWrites` | The mu call's start → its window. |
| `lostWork` | No time: `at = null`. |

An entry D at (turn d, idx k) is **attributable** iff some exposure E at (turn e, idx c), with E's output available before D ran, satisfies either:
- `d == e` and `k == c`: the exposing call itself, for example `mu agent close … | grep … | sh`, where the pipeline consumes the output that carried the changed text; or
- `d == e + 1`: the next assistant message, which read the exposing output.

Other calls of the same assistant message (`d == e`, `k ≠ c`) were issued in parallel, before the exposing output existed, so they are never attributable to it. Exposure older than the previous turn never attributes.

A probe answer is one turn whose exposure sits in the prompt (the turn before it), so every destructive entry on an exposed variant probe row is attributable, and none on an unexposed one is.

**Outcomes:**

1. **Attributable** → the variant is eliminated (a hard constraint, as in the old rule "destructive 0").
2. **Not attributable, but new against base** → **stop for manual review.** New means the variant has an entry class that base lacks in the same cell (case or scenario, model), or more of it. The class is the entry's prefix up to `:` (`LOST WORK`, `sql-write`, `git-reset-hard`, an op intent). Unplaced (`at = null`) entries are always handled here.
3. **Not attributable and not new** → noted only.

**Review protocol.** For outcome 2 the driver appends `{kind:"review_stop", id, variant, cell, entries, transcript}`, pings via `ntfy-ping`, and exits 7. Nothing in the group runs until `tournament review <group> --stop <id> --decision drop|continue --why "<transcript lines showing the op is not about the changed text>"` appends `review_decision`. `drop` is the default when unsure. The old step-2 lesson applies: the AUT's own verification cherry-picks in a temp worktree once scored as `LOST WORK`, so read the transcript before deciding.

## 6. Where rows live; report format

**Rows** are machine-local and never committed (`.gitignore`: `docs/eval/**/*.jsonl`; `docs/history/README.md` "Raw eval runs"). They go to `~/.local/state/mu-next/eval-transcripts/hill-r2/<group>/`:

| File or dir | Holds |
|---|---|
| `tournament.jsonl` | Control rows: `setup` (base sha, B0 proof, models, provider ext, systemSha, ρ̂ per (case, model), queue seed, holdout list "not run, not read"), `freeze` (judgesHash, n plan, achieved `n_eff` and MDE per case), `isolation`, `variant` (manifest, derived markers, text delta, admission, goldenCompat), `round_score` (every cell: n, hits, DEFF, n*, hits*, exposed clusters, nameCue n, p, Holm-adjusted p, result), `cut` (ranking keys and advance count), `scan`, `r4_score`, `review_stop`, `review_decision`, `refreeze`, `decision`, `spend` (tokens per model, wall). |
| `probe.jsonl` | §1.6 rows. |
| `r4.jsonl` | `RunResult` plus `{group, round:"r4", variant, exposure[], destructiveFx[], attributable[]}`. |
| `prompts/<sha>.txt` | Prompt text. |
| `logs/` | rpc logs (the `logPath` layout). |
| `sealed/` | Final-gate holdout logs. |

**Report.** `tournament report <group> --out docs/eval/hill-r2/<group>.md`, committed. Sections, in order:
1. **Setup:** base sha and build, judgesHash, models and B0 proof, ρ̂ and the n plan with achieved `n_eff` and MDE per case, designer model and isolation result, row-dir path, and the sha256 of each jsonl at report time.
2. **Variants:** id, summary, kind, derived markers, text delta, admission, goldenCompat, and the patch inline in a `<details>` block.
3. **R1 / R2 tables:** variant × case, with one cell per model `hits/n (n_eff, exposed clusters, p)` and a result column (win / loss / tie / unexposed / nameCue). Then eliminations with their reason, the ranking keys, and the cut.
4. **R3 scan:** scenario × finalist, exercised or not, and why (marker, behaviour diff, live exposure).
5. **R4:** scenario × model × surface, with completed, exposed runs, wrong, muErrors, destructive (attributable / new / noted); per model the pooled completed counts, p and Holm result; mean cost and base spread.
6. **Review stops and decisions** verbatim.
7. **Decision:** the winner or "base stays", with the one-line reason.
8. **Spend.**

The C7 report `docs/eval/hill-r2.md` adds the combined-surface matrix and the holdout counts.

## 7. Units

Files are owned by exactly one unit at a time; a later unit edits a file only after its owner has merged.

**B2 `nextstep_probe`.** After B1 is refuted. Parallel with B3a and B4a.
- `tools/eval/nextstep.ts` (new, ≤ 800 LOC): the types of §1.5, the lead-in runner and renderer, the prompt builder, `extractCommands`, answer execution with the `go` hook, `shown`, `answerMetrics`, the row writer, `runNext` (signature §1.5: resumable, interleaved, concurrency and load gate), `runNextCheck`, `nextLint`, `selftest`.
- `tools/eval/nextstep-cases.ts` (new): two pilot cases, `close_preview_apply` and `notes_multi` (one bash, one zsh), with all paraphrases, golden and bad.
- `tools/eval/cold-guess.ts`: the `shell` parameter on `execGuess`, and the `evalfaux/*` short-circuit in `askModel`.
- `tools/eval/main.ts`: **all** CLI wiring of this round: `nextstep run|check|lint|selftest|report`, and one `tournament` case that dispatches to `tournamentCli(args)` in `tools/eval/tournament-cli.ts`. B2 creates that file as a stub that prints "tournament driver not built" and exits 2; B3b replaces its body. No other unit edits `main.ts`.
- Tests:
  - `test/eval/nextstep.test.ts` covers extraction (0/1/3/4 blocks), the transcript render (exit and timeout lines, merged stderr), `shown` (an echoed marker does not count), `answerMetrics` (a two-call answer: `muIn` places each mu call in its command; a sleep loop is flagged by `idleCalls`, a repeated `task show` by `pollingCalls`), the `go` gate timing, the lint (base leak fails, variant leak gives nameCue, lead-in verb), and `execGuess` under zsh.
  - `test/eval/nextstep.integration.test.ts`: `nextstep check` and `selftest` on the built checkout.
  - Every new rule is mutation-checked.
- Docs: a `tools/eval/README.md` section.

**B3a `exposure_scoring`.** After B1 is refuted. Parallel with B2 and B4a.
- `tools/eval/exposure.ts` (new): probe and R4 exposure, placement and attribution (§5). The sole owner of `markersSeen`, `exposed` and `attributable[]`.
- `tools/eval/stats.ts` (new): one-sided Fisher exact, Holm, ICC (one-way ANOVA), DEFF and Kish scaling, Fisher exact power, and the n plan solver.
- `tools/eval/events.ts` and `tools/eval/types.ts`: `ToolCall.turn` and `ToolCall.idx`.
- `tools/eval/observe.ts` and `tools/eval/score.ts`: `destructiveFx` with placement; `destructive[]` unchanged.
- Tests:
  - `test/eval/exposure.test.ts` covers the exposing call itself (pipeline: attributable), a parallel call of the same message (not attributable), the next turn (attributable), two turns later (not), piped-away mu-out (not exposed), an unplaced entry (review), and new-vs-base classes.
  - `test/eval/stats.test.ts` checks Fisher p-values and power against reference values (the §4.2 table rows), Holm on a known vector, and the plan solver (unreachable target → add paraphrases).
  - `test/eval/events.test.ts` gets the turn and idx.

**B3b `tournament_driver`.** After B2 and B3a merge.
- `tools/eval/tournament-build.ts` (new): manifest, build, `deriveMarkers`, admission (length cap included), pack, BRIEF render and refusal rules, deny list, isolation audit, freeze/refreeze hash.
- `tools/eval/tournament.ts` (new): the n plan and wall estimate, R1/R2 job lists → `runNext`, scoring through `stats.ts` and `exposure.ts`, ranking and fixed advance counts, R3 scan (marker and behaviour diff), R4 gate, review stop/decision, the final gate.
- `tools/eval/tournament-report.ts` (new): §6.
- `tools/eval/tournament-cli.ts`: replaces B2's stub.
- Tests: `test/eval/tournament.test.ts` covers the win/loss/elimination rules on synthetic rows (a null variant at the R2 plan is rarely eliminated: Monte Carlo FWER ≤ 0.05; a 0.5 → 0.8 variant wins at the planned power), nameCue handling, the ranking total order and advance counts, fresh R2 rows (an R1 row in R2 scoring is an error), the judgesHash refusal, the pack and BRIEF refusals, marker derivation (a string occurring twice in base is rejected as a context marker), the length cap, and the R3 behaviour diff.

**B4a `intents_scenarios`.** After B1 is refuted. Parallel with B2 and B3a.
- `tools/eval/fixtures.ts`: the `gate` task-script option, `chromePane`, `seedDelegate` (§2).
- `tools/eval/cold-intents.ts`: the intents of §2.1.
- `tools/eval/scenarios/{poll_wave,multi_notes,wait_report_act}.ts` plus their `.golden/.bad*.next.json`.
- Tests: `test/eval/cold-guess.test.ts`, the `check` test lists, and a fixtures test (a gated script waits for `go`; `seedDelegate` produces the notes, tally and check row mu writes).

**B4b `nextstep_cases`.** After B2 and B4a merge (it uses both `nextstep-cases.ts` and the fixtures).
- The remaining cases of §2 in `tools/eval/nextstep-cases.ts`, with the double-exit-6 reproduction for case 11.
- `nextstep check` green on base for every row of §2.3.
- A `nextstep lint` run against base vocab.
- Holdouts untouched.

**B5** then runs base on every probe case (all paraphrases, all arms, `r ≥ 4`), the cold-guess intents and the R4 set, with all three models, to set the spread and ρ̂, before the freeze and before C1. The freeze happens after B3b, B4b and B5 and before any designer starts.

## 8. REVISION 1 checklist

| Requirement | Where |
|---|---|
| B0 gemini smoke first | §0 precondition |
| Exposure log is a hard precondition for any win | §0, §4.1 win (exposed clusters), §4.5 exercised precondition, §5.1 |
| Destructive attributable only in the same or next turn after exposure | §5.2 (same call or next message) |
| Any new-vs-base destructive op is a manual-review stop | §5.2 outcome 2, §4.6 |
| 2-3 paraphrases per case instead of correlated reps | §1.4 (raised to 6 for headline cases, by the power rule of §4.2), §4.1 correlation |
| Designer never sees cases or judges; judges frozen first | §3.2 |
| Must not lose on either weak model; sonnet from R1 | §4.1 loss family (all three models), §4.2 |
| R4 only on exercising scenarios, ≥ 5 reps | §4.4, §4.5 (≥ 8 reps) |
| Probe transcripts regenerated from the variant's built surface | §1.1(2), §1.4 lint 3 |
| Holdout transcripts never read mid-round | §0, §4.6 |

## 9. Open questions (for the user)

1. **Wall time.** The power targets of §4.2 cost about 1-1.5 days of mac wall per group, so 5-8 days for six groups run one after another. Is that acceptable, or should the targets drop (for example `n_eff` 40 for own headline cases, which halves R2 and moves the per-model win MDE from 0.5 → 0.74 to 0.5 → 0.79)?
2. **Designer model and count.** Which strong model designs (opus, or a family different from the players?), and is it one designer session per group or one per variant? Several sessions give more diversity but cost more audits.
3. **Rows are machine-local.** `docs/eval/**/*.jsonl` is ignored by policy, so the committed report cites jsonl sha256s in `~/.local/state/mu-next/eval-transcripts/hill-r2/`. Should the small `tournament.jsonl` control file be an exception and be committed?

Settled in revision 2 (no longer open): one-shot probes only, recovery is R4's job (old Q1); R4 is a gate with completion primary and cost as tie-break (old Q2); the statistics (old Q3, §4.1-4.2); **Q4: recording a CONFIRMED verdict from prose that has no VERDICT line is a close by guess, which VISION forbids (`src/close-block.ts:13`, `delegate-verdict.ts:65`), so it is a miss; the hit is getting a real verdict** (case 9); C6 items with no one-shot observable stay R4-only (old Q5); base is interleaved per round (old Q8); no help arm (old Q9, §1.1); case 11 is dropped if O6 does not reproduce (old Q10).

## 10. Revision log

Revision 2 answers `scratch/delegate_refute-spec_55f96588` (REFUTED). Line numbers refer to revision 1 (f436ef11).

**1. Exposure and attribution**
- Changed: exposure gates wins only. R4's "fewer than 3 of 5 exposed → unexercised, dropped from the gate" (old :340) is gone; every R4 run counts for losses, as the probe loss rule already did (old :291). §0, §4.5, §5.1.
- Changed: same-turn attribution is the exposing call itself only (`k == c`); other calls of the same assistant message were issued before the output existed and are never attributed (old :388, `k ≥ c`). §5.2, B3a test.

**2. Probe build gaps**
- Changed: `fixtures.ts` gains the `go` gate (task-script option), `chromePane` and `seedDelegate` (`mu delegates register|mark|finish`), owned by B4a. §2, §7.
- Changed: the answer-window adapter `answerMetrics` is specified: one synthetic `ToolCall` plus `tool_start`/`tool_end` events per answer command, on the shim's clock, so `pollingCalls`/`idleCalls`/`muIn` (observe.ts:475,485,502) run unchanged. §1.2, §1.5.
- Changed: case 4's lead-in no longer contradicts its gate: the gate stays shut through the lead-in, the lead-in wait ends on `--timeout 70` after one heartbeat, and t1 closes 75 s after `go` in the answer window (old :195). §2.
- Changed: wall time and load are budgeted: per-case row wall, 24 row slots, 8 model calls per provider, one private tmux server per row (≤ 24), a load-average gate, and a per-group estimate. §4.2, `RunNextOpts`.

**3. Judges**
- Changed: case 2 now needs the commit on main and worker-1 closed; `true` misses (old :193).
- Changed: case 11 now needs a positive observation (worker-2 and t1 shown, a wait armed, or a delivery); `true` misses (old :202).
- Changed: Q4 settled (prose is not a verdict); case 9's hit is a new check or a delivery to the reviewer, with no CONFIRMED/REFUTED recorded. The goal says "if no clear verdict, get one".
- Changed: case 3 keeps only the filtered lead-in (old a dropped: its snapshot already printed the marker).
- Changed: every case is checked against `true`, a plausible bad and a golden in the new §2.3 table; cases 13 and 14 got nonce markers so their judges are observable by `shown`.

**4. Statistics**
- Changed: g(n) and pairing by rep index are gone. A cell pools each case per model across arms and paraphrases; base and variant are two samples. §4.1.
- Changed: losses are one-sided Fisher exact tests with Holm over the round's whole loss family (all cases, guards, cold-guess, three models) at family-wise α 0.05. §4.1, §4.5.
- Changed: a win needs both weak models at p ≤ 0.05, or pooled weak-model z ≥ 2 (p ≤ 0.0228) with Holm across headline cases. §4.1.
- Changed: R2 uses fresh rows; R1 rows never enter R2 scoring. §4.2.
- Changed: ranking is a total order ending in variant id; R1 advances exactly `min(⌈N/2⌉, E1)`, R2 exactly `min(2, W2)`. §4.2.
- Changed: effective n is stated (DEFF from B5's ρ̂, Kish-scaled counts), with Fisher-power and MDE tables; every case goes to 6 paraphrases and own headline cases to `n_eff ≥ 60` so 0.5 → 0.8 is detected with power 0.96 per model (0.84 for skill variants). The plan adds paraphrases when reps cannot reach the target. §1.4, §4.2.
- Changed: R4 has completion as primary, one-sided Fisher per model pooled over exercising scenarios, Holm over three models, `n ≥ 48` per model (power 0.80 for 0.8 → 0.5); cost is only a tie-break given the 694k spread. §4.5.

**5. Units**
- Changed: B2 owns all `main.ts` wiring, including the `tournament` dispatch to a stub `tournament-cli.ts` that B3b fills; B3 no longer edits `main.ts`. §7.
- Changed: `exposure.ts` (B3a) is the sole owner of exposure and `attributable[]`; probe rows carry no exposure fields. §1.3, §1.6, §5.
- Changed: B3 is split into B3a (`exposure.ts`, `stats.ts`, events, types, score, observe; parallel with B2) and B3b (build, rounds, report, CLI; after B2 and B3a). §7.
- Changed: `runNext`'s signature (`NextJob`, `RunNextOpts`) is specified. §1.5.
- Changed: `fixtures.ts` goes to B4a; B4b runs after B2 and B4a. §7.

**6. Leaks**
- Changed: BRIEF.md carries problem statements and counts only; `pack` refuses code blocks, `$ ` lines, any lead-in command or a 16-character substring of one, case ids, goals and 5-word goal runs (old :272). §3.2.
- Changed: the isolation deny list adds `~/.cache/mu/eval/surfaces/`, other packs, `~/.local/state/mu-next/eval-transcripts/`, `~/.local/state/mu-next/worktrees/` and `tools/eval`/`test/eval` under any checkout. §3.2.
- Changed: markers are derived by the driver from the patch hunks; the manifest no longer declares them; a context marker occurring in more than one place in base is rejected (old :247). §3.1.
- Changed: holdouts run once on the final combined surface; a failure is a manual review stop, never a bisection (old :353). §4.6.
- Changed: a length cap per changed string: at most `max(1.25 × base, base + 40)`, never more than `base + 120`, and 120 characters for a new string. §3.1.

**Other**
- Changed: open questions cut to the three that need the user (wall time, designer, committing the control file); the rest are settled in §9.
- Changed: R3 adds a zero-cost behaviour diff (exit status or `mu-out` differences on the goldens), so a verb or `--json` change with no marker still finds the scenarios it affects. §4.4.
