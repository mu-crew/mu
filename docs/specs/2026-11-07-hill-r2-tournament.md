<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# hill-r2 tournament rig: next-step probe, tournament driver, exposure-gated scoring

Status: revision 3, for a fresh refutation (task `b1_rig_spec_3`, workstream `crew-hill2`). Revision 1 was refuted by `scratch/delegate_refute-spec_55f96588` and revision 2 by `scratch/delegate_refute-spec2_34abfd81`; the revision log at the end lists every change. It binds B2 (`nextstep_probe`), B3a (`exposure_scoring`), B3b (`tournament_driver`), B3c (`tournament_gate`), B4a (`intents_scenarios`) and B4b (`nextstep_cases`). Plan of record: `mu task notes hill2 -w crew-hill2` (brief plus REVISION 1). Every REVISION 1 Phase-B requirement maps to a section here; §8 checks each one off.

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
- **Execution.** In the **same** sandbox the lead-in left. Each command runs in order through `execGuess(sb, cmd, limitMs, shell, env)` (`cold-guess.ts:255`; it hard-codes `bash` and `sb.env` today and gains the `shell` and `env` parameters), with the case's shell, `limitMs` (default 120 000; the kill is real) and the same orchestrator env as the lead-in (`{...sb.env, PI_SESSION_ID: "nextstep-orch"}`), so an answer acts as the caller `pi:nextstep-orch` that the lead-in's waits and delegate calls belong to (`src/cli/wait.ts:354`, `src/cli/delegates.ts` `callerFromEnv`).
- **The `go` gate.** A gated worker's task script (§2) blocks until the file `<workers>/go` exists, then sleeps its own delay. The rig touches `go` immediately before the first answer command (the case's `go` hook, default "touch go"), so worker timing is measured from the answer, not from the model's latency. A case whose lead-in needs the worker running releases the gate itself in its seed; none of the cases below does.
- **Recorded per command:** exit, `killed`, start and end epoch ms, stdout, stderr. Also recorded: every mu call the answer made (the shim's `mu-calls.log`, `start >= t0`, `sandbox.ts:402-411`) and each call's own stdout (`mu-out/<pid>`, `muOut`, `observe.ts:193`).

**Answer-window adapter** (`answerMetrics`, in `nextstep.ts`). `pollingCalls` and `idleCalls` (`observe.ts:485,502`) read a `RunMetrics` through `toolWindows` (`observe.ts:119`), which pairs each `ToolCall` with its `tool_start`/`tool_end` lifecycle events by `id`. The adapter builds, from the answer's command records:
- one `ToolCall` per answer command: `{ id: "a<i>", name: "bash", args: { command }, isError: exit !== 0, output: stdout+stderr, exitCode: exit, durationMs: end − start }`. It sets no `turn` or `idx`: B3a adds both to `ToolCall` as **optional** fields (§5.1), so B2 and B3a typecheck in either merge order, and probe attribution never reads them (§5.2);
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

**"Printed" (`shown(ctx, marker)`)** holds iff there is **one** answer command `i` such that:
1. a mu call placed in command `i` (`muIn(sb, answerMetrics(ctx), call_i)`, `observe.ts:475`) has the marker in its own stdout (`mu-out`), **and**
2. command `i`'s own output (its stdout plus stderr, ANSI stripped; not the combined output of the whole answer) contains the marker, **and**
3. the marker does not occur in the text of **any** answer command, compared after deleting quotes, backslashes and whitespace from both (so `'PANE-'"ab12"` is caught as well as `PANE-ab12`).

Condition 1 and 2 on the same command defeats `mu agent read … >/dev/null` in one command and `echo <marker>` in another. Condition 3 defeats `mu agent read … >/dev/null; echo "<marker>"` in one command. A loop cannot synthesise a marker either: every marker that a case's transcript already shows (cases 6 and 8) is a **whole line carrying a per-row random phrase** (four words drawn from a fixed list by the row's nonce), so it can reach the output only through a mu call that printed it or by being typed, and typing it is condition 3. Consequence, accepted: an answer that greps for a full marker line misses; no natural filter spells one (they filter on `RL-`, `PANE`, `passed`, blank lines or glyphs).

**"Printed line" (`shownLine(ctx, pred)`)**, for observations that are not nonce markers (case 4's "t1 CLOSED", case 11's "worker-2", case 12, case 13a): some line `L` of a mu call's own `mu-out` in command `i` (ANSI stripped, trimmed) satisfies `pred`, `L` occurs verbatim as a line of command `i`'s own output, and `L` does not occur in any answer command's text. A case that needs a transformed rendering (case 6's unescaped notes) uses `shown` on its markers instead.

**Timing cases.** A case whose goal state arrives after `t0` (the worker finishes during the answer: cases 4, 5, 12; `NextCase.timed: true`) also requires `idleCalls(sb, answerMetrics(ctx))` and `pollingCalls(sb, answerMetrics(ctx))` (`observe.ts:485,502`) to be empty for a hit. `idleCalls` flags any answer command of at least 3 s that spent less than half of its time blocked in mu, whatever it ran (`sleep`, `read -t`, a busy loop), so a sleep that stands in for a wait is a miss. No other case has anything pending at `t0` (§2.3 sleep-wait column), so a sleep there changes no state and needs no rule.

**Every judge has a positive observable.** A hit needs a state change or a `shown` that the lead-in did not already produce. `true` (the no-op answer) must miss every case; §2.3 proves it per case.

**Hit** = the judge's effect holds, no stray op (as in cold-guess: an op the case's `allow` does not name), no command killed unless the case allows it, and no destructive effect.

**Partial** = the case's own "right direction" condition. It is reported, never counted as a hit.

**Destructive entries** come from the effect rules every judge already shares:
- `destructiveOps`, `localWrites`, `lostWork` (`tools/eval/observe.ts:407,443,340`),
- the `DESTRUCTIVE` regexes on the answer's commands (`tools/eval/score.ts:7`).

The probe row records the entries only. Exposure and attribution are computed by `exposure.ts` (B3a) at score time (§5); `nextstep.ts` never decides either.

### 1.4 Paraphrases and lint

**Paraphrases.**
- Each headline case ships **ten** paraphrases (`p1`-`p10`) of its goal, each guard **six**. B4b may add up to `p14` when the n plan (§4.2) needs more clusters. This raises REVISION 1's "2-3" because the effective n is bounded by the number of distinct prompts (§4.2); it keeps that rule's intent, which was never to lean on correlated reps.
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
  group: Group;                    // exactly one group: the one whose candidates the case scores; R2 runs it for every other group as a cross-group case (§4.3)
  /** headline: scored for its group; guard: no-regression only (R2, every group). */
  role: "headline" | "guard";
  arms: Arm[];                     // frozen
  shell: "bash" | "zsh";
  limitMs?: number;                // default 120_000
  timed?: boolean;                 // goal state arrives after t0: a hit also needs idleCalls and pollingCalls empty (§1.3)
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
  /** The other §2.3 rows `check` must prove: natural alternative right answers (expect hit), lucky
   *  spellings and forgeries (expect miss), and for a timed case the sleep-wait answer (expect miss). */
  extras(st: St, v: "a" | "b"): { label: "alt" | "lucky" | "sleep"; cmds: string[]; expect: "hit" | "miss" }[];
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

`nextstep check --surface <spec>` runs, per case and lead-in variant, with zero model cost:
- the golden must hit,
- the bad must miss,
- `true` must miss,
- every `extras` row must give its `expect`.

Every lead-in `expect` must also pass. Run `check` on the base and on each variant build. A variant on which a base golden stops hitting is recorded in its `variant` row (`goldenCompat`); this does not block it.

`nextstep selftest` drives the whole path (prompt build, extraction, execution, judge, row) with a scripted model, `evalfaux/golden` or `evalfaux/bad`, that answers with the case's golden or bad in fences. `askModel` short-circuits `evalfaux/*`. Zero cost.

### 1.6 Probe row (`kind: "probe"`)

```
group round case role paraphrase leadIn arm surface(variant id|base) surfaceId build model rep
promptSha systemSha transcriptPath
leadInCalls[{argv exit}] reply commands[] tooMany perCommand[{cmd exit killed start end}] muCalls[{argv exit start end cmdIdx}]
hit partial invalid why[] stray[] destructive[{entry source callIdx}] tokens ms modelError?
```

`markersSeen`, `exposed`, `nameCue` and `attributable` are **not** row fields. The driver's score pass derives them from the stored prompt, the row's `muCalls[]` (lead-in and answer, each with its argv) and the variant's `ExposureSpec` (`exposure.ts`, §3.1, §5) and writes them into `round_score` cells. The prompt text is stored once per `promptSha` under the run dir (§6). Rows are resumable by the `RunNextOpts.out` key.

## 2. Case catalogue (B4b writes them; observables fixed here)

Each case cites its friction slice:
- orch = `delegate_friction-orch_b97e7056`
- worker = `delegate_friction-worker_326c2002`
- linux-host = `delegate_friction-<linux-host>_02698f9c`
- harness2 = `delegate_friction-harness2_59dae84d`
- static = `delegate_friction-static_f8af89f1`

All cases share these defaults:
- workstream `auth` (as in cold-guess);
- faux workers (`writeWorkerDriver`, family `next`, CLOSE block);
- markers are random per row (`nonce`), so no marker can be learned across rows.

**Fixtures B4a adds to `tools/eval/fixtures.ts`** (the worker driver, `fixtures.ts:67-160`, has none of them today):
- `gate: { delayMs }` on a task script: the generated `T.sh` starts with `while [ ! -e "$W/go" ]; do sleep 0.2; done; sleep <delay>`. The driver itself is unchanged, so every existing scenario keeps its behaviour.
- `chromePane(sb, name, lines)`: a `--command` pane that prints pi-like chrome (blank lines, `─` rules, `↑` rows, `Working…`) and then the given lines, and stays alive.
- `seedDelegate(sb, { callId, caller, wave?, label, record?, brief, agent, outcome?, answer })`: a delegate call seeded through the real writers, in order `mu delegates register <callId> -w auth --caller <caller> [--wave <wave>] [--record <ws>/<task>] --label <label> --state starting --text -`, `mu delegates mark <callId> running --agent <agent>`, `mu delegates finish <callId> --outcome <outcome|done> --author <agent> --text -`. What that writes, and all it writes (`src/delegates.ts:304-560`): a `kind=delegate` task `delegate_<label>_<h8>` (`taskIdFor`, `delegates.ts:271`) in the wave, with its brief note; a `delegate_calls` row (caller, wave, record target, state `done`, `verdict` = the parsed label or NULL); on the record task a `verdict` note (`recordNote`, `delegate-verdict.ts:55`: `REFUTER <label> (<agent>, <elapsed>):` then the answer from its first VERDICT line, or `NO VERDICT LINE: <answer>`); and the delegate task closed with the answer as its `report` note. **No `checks` row** (`issueCheck` has one caller, `src/cli/tasks/checks.ts:37`), no pane, no delivery. Returns `{ task }`. The caller is `pi:nextstep-orch` for every case, so the lead-in's `mu wait --wave` (which needs a pi caller, `src/cli/wait.ts:354`, and counts only that caller's calls) sees the call.
- `delegateDefault(sb, text)`: writes `<workers>/delegate-default`. The driver prints that file, when it exists, in place of its generated `VERDICT: CONFIRMED` answer for a delegate with no keyed answer (`fixtures.ts:89-93`); without the file nothing changes, so every existing scenario keeps its behaviour.

Arms are `none, skill, recipe:<r>`, where `<r>` is the named recipe.

| # | Case | Group | Recipe arm | Seed and lead-in (live) | Goal (p1; others vary wording) | Judge observable | Partial / allowed |
|---|---|---|---|---|---|---|---|
| 1 | `close_preview_apply` | c2 | merge | worker-1 spawned `--worktree`; its commit cherry-picked onto main. Lead-in `mu agent close worker-1 -w auth` prints the preview. **b:** the same, piped `2>&1 \| tail -5`. | "worker-1's work is on main now; get rid of it." | worker-1's agent row is gone (`agent.close` op), its worktree dir is removed, `lostWork` is empty. | Partial: a second preview with no apply. Allowed: `agent.*` ops for worker-1. |
| 2 | `close_preview_conflict` | c2 | merge | worker-1 has one commit `C` **not** on main (the preview's worktree line names it unmerged). Same lead-in. **b:** the friction's scrape pipeline as the last step: `mu agent close worker-1 -w auth 2>&1 \| grep -o 'mu agent close.*--if [0-9]*' \| head -1 \| sh` prints nothing. | "Make sure worker-1's commit ends up on main, then get rid of worker-1." | `C` is on main (sha or patch-id, `provenance.ts`), **and** worker-1's agent row is gone, **and** `lostWork` is empty. | Partial: `C` on main, worker-1 still registered. Allowed: a cherry-pick or merge, `agent.*` ops for worker-1. A discarding close is destructive. |
| 3 | `wait_result_read` | c1 | orchestrator-loop | worker-1 is spawned on t1 with `--send`, and its final text is `REPORT-<nonce>: <one line>`. One lead-in only (variant a of revision 1 is dropped: its snapshot already printed the marker): `mu wait agent:auth/worker-1@<runs> --json \| jq -c '{exit:.data.exit, firing:.data.firing}'` (orch F1: 304 of 430 waits filtered). | "What did worker-1 report? Show me its result line." | `shown(REPORT-<nonce>)`. No answer command reads the sandbox `sessions/` or a pane's session file. | Partial: the answer shows worker-1 or t1 state without the line. |
| 4 | `wait_heartbeat_merge` | c1 | orchestrator-loop | t1 is owned by worker-1, **gated**, delay 75 s after `go` (the heartbeat interval is 60 s, `src/cli/wait.ts:64`). The gate stays shut through the lead-in, so the lead-in wait cannot fire; it ends on its own `--timeout 70`, after one heartbeat line. Lead-in: `mu wait task:auth/t1 --json --timeout 70 2>&1 \| python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["data"]["firing"])'` → `JSONDecodeError`, because the heartbeat line comes first (orch F5, linux-host #6). At answer time t1 is still IN_PROGRESS and closes 75 s after `go`. | "Find out how t1 ended." | **Timed.** `shownLine` of a line naming t1 and CLOSED (a mu call observed it after `t0` and the same command showed that line). No answer command was killed. `idleCalls` and `pollingCalls` empty (§1.3). | Partial: nothing killed, t1 not shown CLOSED. |
| 5 | `wait_shell_limit` | c1 | orchestrator-loop | worker-1 is spawned with `--send` on t1, **gated**, delay 200 s after `go`, so no single 120 s call on the default 1500 s timeout (`wait.ts:66`) sees it finish. Lead-in: the spawn (its `next: mu wait …`), then that hint run with `killAfterMs: 120000` → `Command timed out after 120 seconds` (linux-host N4). | "Get worker-1's result once it is done." | **Timed.** No answer command killed. Every blocking mu call (`WAIT_MS`, `observe.ts:53`) ended on its own. `shown(REPORT-<nonce>)`. `idleCalls` and `pollingCalls` empty (§1.3). | Partial: nothing killed, result not shown (clean timeouts). A kill is a miss. |
| 6 | `notes_report_read` | c3 | tasks-or-calls | `seedDelegate` (label `rev`, no record target): task `delegate_rev_<h8>` with a 40-line answer, which becomes its `report` note; line *k* is `RL-<nonce>-<k> <phrase_k>` (four random words), the brief carries `BRIEF-<nonce>`. Lead-in `mu task notes delegate_rev_<n> -w auth` prints the brief and the report with `\n` escapes (worker F2: 98 `sed` unescapes; linux-host #4: 272). | "Show me only the reviewer's findings, readable line by line." | `shown` holds for each whole line `RL-<nonce>-<k> <phrase_k>`, k = 1..40 (§1.3: markers already in the transcript are whole lines with a random phrase). In the answer's output, no line holds two consecutive `RL` markers (real newlines). `BRIEF-<nonce>` is not in the last answer command's output. | Partial: every marker shown, with escapes or with the brief. |
| 7 | `notes_multi` | c3 | — | t1, t2 and t3 have notes `N1-`, `N2-`, `N3-<nonce>`. **zsh.** Lead-in `mu task notes t1 -w auth`. | "Now give me the notes of t2 and t3 too, each one labelled." | `shown(N2-…)` and `shown(N3-…)`. Every answer command exits 0 (the zsh `echo ===` failure, worker F3: 27 calls, 25 sessions). | Partial: one of the two shown. |
| 8 | `agent_read_text` | c4 | — | `chromePane` worker-1: 30 blank lines, `─` rules, `↑` rows, `Working…`, then `PANE-<nonce>: tests 41 passed, <phrase>` (four random words). Lead-in `mu agent read worker-1 -w auth` (orch F4, linux-host #5: 176 filtered reads). | "What did worker-1 last say? Just its words." | `shown` of the whole line `PANE-<nonce>: tests 41 passed, <phrase>`. The last answer command's output has at most 3 lines that are blank or consist only of box-drawing or arrow glyphs. | Partial: shown with the chrome. |
| 9 | `delegate_no_verdict` | c5 | adversarial-review | t4 is OPEN (worker-4's commit is on main; t4 waits on its review). `seedDelegate({ callId: rv-<nonce>, caller: pi:nextstep-orch, wave: w1, label: review-t4, record: auth/t4, agent: <the delegate>, answer: "All four fixes are in place. I found no real problems." })`: the call is `done` with `verdict` NULL, t4 carries the verdict note `REFUTER review-t4 (…):\nNO VERDICT LINE: All four fixes…` (`delegate-verdict.ts:65`), and nothing writes a `checks` row. `delegateDefault`: any delegate run later answers `VERDICT: CONFIRMED` / `EVIDENCE: RV-<nonce> re-read the four fixes against main; tests pass`. Lead-in `mu wait --wave w1 -w auth` as `pi:nextstep-orch`: fires at once, tally `auth/t4` unverified 1. | "Did the review of t4 pass? If the reviewer gave no clear verdict, get one." | After `t0`, **dispatch**: a review of t4 is put in motion by any of (i) a new `checks` row on t4 (the outside-pi path, `mu task check`, `src/checks.ts:173`); (ii) a new `delegate_calls` row whose record target is `auth/t4`, in any state but `refused` (the delegate path, `delegates.ts:304`); (iii) a prompt naming t4 received by a non-delegate worker (`deliveries`, `observe.ts:295`). **And no forged verdict**: every CONFIRMED or REFUTED verdict recorded on t4 after `t0` (a `checks.verdict` of a check on t4, or a note on t4 of any kind whose first VERDICT line `parseVerdict` reads as CONFIRMED or REFUTED) carries `RV-<nonce>`, i.e. came from a reviewer run, whose answer the model never saw. **And** t4 is still OPEN. | Partial: `shownLine` of the `NO VERDICT LINE` note line, nothing dispatched. Allowed: `check.*`, `delegate.*` ops, a typed UNVERIFIED verdict. A typed CONFIRMED (prose read as a pass) or closing t4 is a miss (Q4, §9). A probe cannot run a native subagent, so recording the dispatch is the step scored; `mu delegates run` that lands the `RV` verdict also hits. |
| 10 | `close_already_closed` | c5 | orchestrator-loop | worker-1 closes t2 with the verb (close-mode `verb`), commits, and prints no CLOSE block. Lead-in `mu wait agent:auth/worker-1@<runs>` → `close:{applied:false, reason:"no CLOSE block…"}` (`close-block.ts:244`; harness2 O3). | "If t2 is finished, bring worker-1's commit onto main; otherwise have worker-1 finish it." | The worker's commit is on main (sha or patch-id). No prompt is delivered to worker-1 after `t0` (`deliveries`). t2 is still CLOSED, and its claim count is unchanged. | Partial: the commit is merged and a redundant prompt is sent. |
| 11 | `dead_once` | c5 | recovery | worker-1 dies on t1 (`dieOnce`). Lead-in: a wait fires `dead agent:…`; the rig respawns worker-2 for t1 (`spawn --task t1 --attempt 2 --send`); a second wait fires `dead task:…` for the same death (harness2 O6). **B4b must first reproduce the double event on base; if it cannot, the case is dropped and the report says so.** | "Keep t1 moving." | No third agent spawned for t1. worker-2 still owns t1. Claim count for t1 unchanged after `t0`. **And** a positive observation: `shownLine` of a line naming `worker-2` (t1's new owner; a line from `task show t1`, `agent list` or a wait snapshot), or a mu wait on worker-2 or t1 was armed after `t0` (a blocking call, `WAIT_MS`, that blocked ≥ 1 s or fired), or a prompt was delivered to worker-2. | Partial: the state is right and nothing was observed. |
| 12 | `sleep_poll` | c6 | orchestrator-loop | worker-1..3 spawned on t1-t3 with `--send`, **gated**, delays 20/40/60 s after `go`. No delegate calls and no wave (`mu wait --wave` counts delegate calls only, `src/cli/wait.ts:704`). Lead-in: the three spawns; the last output carries `next: mu wait …` (orch F6, linux-host #12: 58 loops). | "Tell me when all three are finished, and how each one ended." | **Timed.** For each of t1, t2, t3: `shownLine` of a line naming it and CLOSED. `pollingCalls` and `idleCalls` empty (§1.3). No kill. | Partial: all observed, but by polling or sleeping. |
| 13 | `sql_name_guess` | guard | — | Two workstreams with tasks; t1 has note `SN-<nonce>`. **a:** lead-in `mu sql "SELECT name, status FROM tasks WHERE workstream='auth'"` → column error. **b:** `mu sql "SELECT body FROM notes WHERE task='t1'"` → no such table (linux-host N2: 18% of sql calls failed). | a: "List the auth items with their states." b: "Show the text of t1's notes." | a: for every auth task id, `shownLine` of a line naming it and its state; no answer command's output names an id of the other workstream (seeded `x1`-`x3`, disjoint from auth's). b: `shown(SN-<nonce>)`. | — |
| 14 | `finding_guess` | guard | findings | A finding task `high_x` with title `HX-<nonce>` and note `HN-<nonce>`. Lead-in `mu finding show high_x -w auth` → unknown command (linux-host N3). | "Show me that finding." | `shown(HX-<nonce>)` and `shown(HN-<nonce>)`. | Partial: one of the two. |

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

### 2.3 Judge check: `true`, a plausible bad, a lucky spelling, a sleep-wait and the golden, per case

This is what `nextstep check` must prove on base for every lead-in variant: the golden and each `alt` hit; `true`, the bad, each `lucky` row and the `sleep` row miss (`NextCase.extras`, §1.5). B4b writes them to the effect described; the spellings below are base spellings. `<rev>`, `<sha>`, `<runs>`, `<dir>`, `<branch>` come from the seed state. "Lucky" is an answer that looks right (the right verb family, the marker in the output, a dispatch) but lacks the effect; "n/a" in the sleep column means nothing is pending at `t0` (the worker finished, or there is no worker), so a sleep changes no state.

| # | `true` | Plausible bad → result | Lucky spelling or forgery → result | Sleep-wait → result | Golden, and natural alternatives → result |
|---|---|---|---|---|---|
| 1 | Miss: worker-1's row remains. | `mu agent close worker-1 -w auth` (re-preview) → miss, partial. | `git worktree remove --force <dir>` → worktree gone, agent row remains: miss. | n/a | a: `mu agent close worker-1 -w auth --if <rev>`; b (rev cut by `tail`): `--if "$(mu agent close worker-1 -w auth --json \| jq -r .data.revision)"` → hit. Alt: the same with `--discard` (the commit is on main by patch-id, `lostWork` empty) → hit. |
| 2 | Miss: `C` not on main. | `mu agent close worker-1 -w auth --if <rev>` (apply without merging) → `C` kept on a branch, not on main: miss, not destructive. | `mu agent close worker-1 -w auth --discard --if <rev>` → row gone, `C` lost (`lostWork`): miss, destructive. | n/a | `git cherry-pick <sha>`, then `mu agent close worker-1 -w auth --if "$(mu agent close worker-1 -w auth --json \| jq -r .data.revision)"` (the cherry-pick may move the revision) → hit. Alt: `git merge <branch>` then the same close → hit. |
| 3 | Miss: nothing shown. | The same `--json \| jq -c '{exit,firing}'` wait again → `REPORT` in mu-out but filtered from the output: miss. | `mu task show t1 -w auth` → t1's state, no result line: miss, partial. | n/a | `mu wait agent:auth/worker-1@<runs>` (fires at once, snapshot printed) → hit. Alt: the same wait `--json \| jq -r` on the result-text field → hit. |
| 4 | Miss: no CLOSED observed after `t0`. | The same python pipeline without `--timeout` → heartbeat at 60 s, fires at 75 s, `JSONDecodeError` again; CLOSED only in mu-out: miss. | `mu task show t1 -w auth` at once → IN_PROGRESS shown: miss, partial. | `sleep 80; mu task show t1 -w auth` → CLOSED shown, but the 80 s command spent < 1 s in mu: `idleCalls`, miss. | `mu wait task:auth/t1 2>/dev/null; mu task show t1 -w auth` → blocked in mu ~75 s, CLOSED shown: hit. Alt: `mu wait task:auth/t1 --timeout 110` (its snapshot line names t1 CLOSED) → hit. |
| 5 | Miss: nothing shown. | The hint again (`mu wait agent:auth/worker-1@<runs>`) → killed at 120 s: miss. | One block `mu wait agent:auth/worker-1@<runs> --timeout 110` → ends on its own at 110 s, nothing shown: miss, partial. | Blocks `sleep 115`, `sleep 115`, `mu wait agent:auth/worker-1@<runs>` → the wait fires at once with the snapshot, but two idle commands: miss. | Three blocks `mu wait agent:auth/worker-1@<runs> --timeout 110` → the first ends on its own at 110 s, the second fires at ~200 s with the snapshot: hit. |
| 6 | Miss: nothing shown. | `mu task notes <dtask> -w auth \| sed 's/\\n/\n/g'` → markers and newlines fine, but `BRIEF` shown by the last command: miss, partial. | `mu task notes <dtask> -w auth --json \| jq -r '.data[].content'` → brief included: miss, partial. Forgery `mu task notes <dtask> -w auth >/dev/null; echo '<the 40 lines>'` → markers in the command text: miss (§1.3, 3). | n/a | `mu task notes <dtask> -w auth --json \| jq -r '.data[] \| select(.kind=="report") \| .content'` → hit. |
| 7 | Miss: nothing shown. | `mu task notes t2 -w auth; echo ===; mu task notes t3 -w auth` under zsh → `zsh: == not found`, exit 1: miss, partial. | `mu task list -w auth` → task lines, no note text: miss. | n/a | Two blocks, `mu task notes t2 -w auth` and `mu task notes t3 -w auth` → hit. Alt: `for t in t2 t3; do echo "## $t"; mu task notes $t -w auth; done` (quoted, zsh-safe) → hit. |
| 8 | Miss: nothing shown. | `mu agent read worker-1 -w auth` again → chrome lines > 3: miss, partial. | `mu agent read worker-1 -w auth \| grep -v '^$'` → rules and arrows remain: miss, partial. Forgery `mu agent read worker-1 -w auth >/dev/null; echo '<the PANE line>'` → in the command text: miss. | n/a | `mu agent read worker-1 -w auth \| grep -vE '^[[:space:]─━│↑↓]*$'` → hit. Alt: `mu agent read worker-1 -w auth \| tail -1` → hit. |
| 9 | Miss: no dispatch. | `mu task note t4 -w auth "VERDICT: CONFIRMED - the reviewer found no problems"` → a CONFIRMED on t4 without `RV-<nonce>`: miss. | `c=$(mu task check t4 -w auth --by claude --brief "re-review t4" \| cut -d= -f2); mu task verdict t4 -w auth --check "$c" "VERDICT: CONFIRMED"` → a dispatch, but a forged CONFIRMED: miss. `mu task close t4 -w auth --evidence "review passed"` → t4 closed: miss. | n/a | `mu task check t4 -w auth --by claude --brief "Re-review t4's four fixes and end with a VERDICT: line"` → new `checks` row on t4, no verdict: hit. Alt (delegate path): `mu delegates register rr-t4 -w auth --wave w1 --record auth/t4 --label review-t4 --state starting --text "Re-review t4…"`, then `mu delegates run rr-t4` → a call recorded on t4, the faux reviewer lands the `RV` verdict: hit (registration alone already hits by (ii) if `run` cannot finish in the sandbox). |
| 10 | Miss: commit not on main. | `mu agent send worker-1 -w auth "finish t2"` → a delivery, commit not on main: miss. | Reopening t2 so worker-1 redoes it (base's reopen verb) → t2 not CLOSED: miss. | n/a | `mu task show t2 -w auth`, then `git cherry-pick <sha>` → hit. Alt: `git merge <branch>` → hit. |
| 11 | Miss: no observation, no wait, no delivery. | `mu agent spawn worker-3 -w auth --task t1 --attempt 3 --send` → a third agent: miss. | `mu task release t1 -w auth` → worker-2 no longer owns t1: miss. | n/a | `mu task show t1 -w auth` → a shown line names worker-2: hit. Alt: `mu wait agent:auth/worker-2@<runs> --timeout 60` → a wait armed on worker-2: hit. |
| 12 | Miss: nothing observed. | `for t in t1 t2 t3; do until mu task show $t -w auth \| grep -q CLOSED; do sleep 5; done; done` → polling and idle: miss, partial. | `mu wait --wave w1 -w auth` → w1 has no delegate calls (exit 3), nothing observed: miss. | `sleep 70; mu task list -w auth` → all CLOSED shown, idle: miss. | `mu wait task:auth/t1 task:auth/t2 task:auth/t3 --all`, then `mu task list -w auth` → fires at ~60 s blocked in mu, each task shown CLOSED: hit. Alt: three blocks `mu wait task:auth/t1`, `…/t2`, `…/t3`, then the list → hit. |
| 13 | Miss (a and b): nothing listed or shown. | a: the same `name`/`workstream` query → column error again: miss. b: the same `body`/`notes` query: miss. | a: `mu sql "SELECT local_id, status FROM tasks"` (no workstream filter) → `x1`-`x3` listed too: miss. b: `mu sql "SELECT body FROM task_notes"` → column error: miss. | n/a | a: `mu task list -w auth`; b: `mu task notes t1 -w auth` → hit. Alt a: the `tasks` ⋈ `workstreams` query on `w.name='auth'` → hit. |
| 14 | Miss: nothing shown. | `mu finding show high_x -w auth` again → unknown command: miss. | `mu task show high_x -w auth` alone → title shown, note not: miss, partial. | n/a | `mu task show high_x -w auth` then `mu task notes high_x -w auth` → hit. |

Only cases 4, 5 and 12 have a pending goal state at `t0`; each one's sleep-wait row misses by `idleCalls`, and its golden blocks in mu for the whole wait. `<dtask>` is case 6's `delegate_rev_<h8>`. JSON field names in these goldens are illustrative; B4b writes base's real ones. If any row of this table fails on base in B4b, the case is fixed before the freeze, never after.

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
- **Behaviour signature** (`behaviourDiff`, B3b), for changes that print no marker (an exit code, a `--json` shape, a short new flag or verb name):
  1. **New names.** Every flag or command name on a `+` line of `src/` (`.option("<flags>"`, `.command("<name>"`) that base's parser lacks. Any length: `--text` counts.
  2. **Golden diff.** Run every golden on base and on the variant at fixed seeds (`nextstep check` goldens per lead-in variant, `cold-guess check` goldens, the R4 goldens of `check --family next`), pair the mu calls of the two runs by position and argv (nonces normalised), and compare exit status, the key-and-type tree of `--json` output, and `mu-out` text (nonces and timestamps normalised).
  3. **Changed calls** = the call keys `(verb path, sorted flag names)` of every pair that differs, e.g. `agent close|--if`.
  - The variant's `ExposureSpec` (the type lives in `exposure.ts`, B3a) is `{ markers, contextMarkers, newNames, changedCalls }`.
- **Admission** (each failure is blocking and goes into the `variant` row):
  - the patch touches only `src/`, `extension/`, `skills/`;
  - it builds, and `node dist/cli.js --help` exits 0;
  - SKILL.md is at most 600 words and recipes at most 4000 (`wc -w`);
  - **length cap per changed string**: a changed string is at most `max(⌈1.25 · base⌉, base + 40)` characters and never more than `base + 120`, where `base` is its counterpart's length; a string with no counterpart is at most 120 characters. This keeps a variant from winning by pouring text into `next:` hints;
  - the variant is observable: its derived markers are non-empty, **or** its behaviour signature is (a new name or a changed call). A variant with neither changes nothing any golden or any model can see, so it is refused. A behaviour-only variant is exposed by behaviour (§5.1): a row counts as exposed when a changed call ran in it, not when text reached the model.
- **Text delta.** The driver computes it: SKILL.md and recipe word delta, plus the changed characters of string literals in the patch. The final tie-breaks use it.
- **Non-blocking checks**, recorded as `goldenCompat`: `nextstep check`, `cold-guess check` and `check --family next` on the group's R4 candidate scenarios, on the variant. A broken golden script is not a broken judge; the landing unit fixes the script.

### 3.2 Judges are frozen first; the designer never sees cases, judges or lead-ins

**Freeze.** `tournament freeze <group>` runs after B2, B3a, B3b, B3c, B4a and B4b are merged, after B5 has fixed the n plan (§4.2), and with `nextstep check`, `cold-guess check` and the R4 `check` green on base. It writes `{kind:"freeze", judgesHash, files[], nPlan}`.
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

**Designers.** Two sessions per group, from different families: `claude-opus-5-5` and `gemini-3.1-pro-preview` (Q2 default, `hill2` note 5), each proposing 3-6 variants on its own, so N ≤ 12. Neither sees the other's patches. `tournament design <group> --model <m>` (B3b) launches each the way `askModel` launches a player (`cold-guess.ts:160`), plus tools:
- `pi -p --mode json --no-extensions -e <providerExt> --no-skills --no-context-files --no-prompt-templates --no-themes --no-mcp --session-dir <ddir>/sessions --model <m> <brief>`, tools left at pi's defaults (read, bash, edit, write);
- an **empty HOME**: `HOME` and `PI_CODING_AGENT_DIR` = `<ddir>/home`, a fresh dir holding only pi's `settings.json`; auth comes only through the provider extension, as for `askModel`. So the user's `~/.pi` (sessions, skills, extensions, AGENTS.md), `~/.claude`, `~/.codex` and the museum skill are not loaded;
- `PATH` = the system dirs (`systemPathDirs`, `sandbox.ts:80`) plus node's bin dir and the pack's `node_modules/.bin`, so neither the user's `mu` nor `museum` is on it;
- cwd = the pack (with `node_modules` cloned in, so `npm run build` and `node dist/cli.js` work);
- `MU_DB_PATH` = an empty temp DB, `MU_SYNC_DIR=` blank, `MU_STATE_DIR` = `<ddir>/state`, so `mu task notes` on crew-hill2 sees nothing;
- `<ddir>` = `~/.cache/mu/eval/designers/<group>/<session>/`;
- the brief: write 3-6 variants as patches against the pack, each with its manifest, and read nothing outside the pack.

An empty HOME does not stop a bash tool from reading an absolute path, so the audit below still runs on every session.

**Isolation audit.** `tournament build` greps the designer's session files for the deny list:
- case ids, `nextstep`, `cold-intents`, `hill-r2-tournament`, `docs/eval`;
- `tools/eval` and `test/eval` under any directory (any checkout, any worktree);
- the main checkout's path and `~/.local/state/mu-next/worktrees/` (every crew worktree);
- `~/.cache/mu/eval/surfaces/` (built surfaces carry `tools/eval`, `surface.ts:104`) and `~/.cache/mu/eval/packs/` other than its own pack;
- `~/.local/state/mu-next/eval-transcripts/`;
- harness archives and the session archive: `~/.pi/agent/sessions`, `~/.claude/projects`, `~/.codex/sessions`, the museum store `~/museum`, the museum checkout (`EVAL_MUSEUM_DIR`, or any dir named `museum` holding `skills/museum`), any `skills/museum` dir and the `museum` command;
- catch-all: any absolute path under the real HOME (`$HOME`, matched in `~/`, `$HOME`-expanded and literal forms) other than the session's own pack and its own `<ddir>`;
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
- `ρ̂_pool` is estimated per case the same way on haiku and gemini base rows pooled, with a cluster of `2r` rows spanning both models; floored at 0.1. The pooled win test (below) uses `DEFF_pool = 1 + (2r − 1)·ρ̂_pool`.
- Caveat, accepted: `ρ̂` comes from base alone, so a variant whose effect differs by paraphrase has a larger true ICC and its `n_eff` is optimistic. The floor and the paraphrase count, not the reps, carry the margin.
- **Scaled counts** (Kish): every test below uses `n* = round(n / DEFF)` and `hits* = round(hits / DEFF)` for each side.

**Exact test.** One-sided Fisher exact test on the scaled 2×2 table (`stats.ts`, B3a). Fisher is conservative; the n plan below is computed with Fisher's exact power, so the stated power is a lower bound.

**Loss.** Two tests, run side by side for each variant and round. A rejection by either is a loss.
1. **Per-case Holm.** The family is every (case, model) test of the round, all three models, plus the cold-guess guard (rows pooled across intents, one test per model, clusters = intents). Each test is H0: `p_variant ≥ p_base`, over **all** rows, exposed or not, `nameCue` rows kept. Holm step-down at family-wise α = 0.05. This catches a large drop on one case.
2. **Stratified CMH, one per model.** A one-sided Cochran-Mantel-Haenszel test (continuity-corrected, `stats.ts`) over the same cases as strata (the cold-guess guard is one more stratum), on the Kish-scaled counts of each stratum, H0: no drop, at α = 0.05/3 per model (Bonferroni over haiku, gemini, sonnet). This catches a broad, moderate drop that no single case shows.
- Under the null the two tests together reject with probability at most 0.05 + 0.05 = 0.10 per variant and round. The error is one-sided toward base: a false loss can only drop a variant, never land one.

**Win** on headline case `c` (exposure gates wins only):
- Rows counted: the variant's **exposed clusters**, those (arm, paraphrase) clusters in which at least half the variant's rows are exposed (§5.1), minus `nameCue` rows. Base rows of the same clusters are the comparator.
- At least 4 exposed clusters, else the case is `unexposed` for that variant.
- **One pooled test over the two weak models.** Haiku and gemini rows of a cluster share its prompt up to nonces, so they are correlated. Revision 2's route (a), "both models separately at p ≤ 0.05", assumed independence: its null rate per case lies anywhere between 0.0025 and 0.05 under that dependence, so it is dropped. Instead the haiku and gemini rows are pooled, the cluster is (arm, paraphrase) **across both models** (`2r` rows per cluster), and the DEFF uses `ρ̂_pool`, the ICC estimated by B5 on pooled haiku+gemini base rows with that clustering, which absorbs the shared-prompt dependence. One-sided Fisher on the Kish-scaled pooled counts, H0: `p_variant ≤ p_base`.
- **Direction on each weak model** (a condition, not a test): the variant's raw hit rate on the exposed clusters is at least base's on haiku and on gemini separately, so one model cannot carry a win while the other drops.
- **Multiplicity across the group** (false wins are controlled per group, not per variant). Let `S = A1`, the number of variants that enter R2 (§4.2). Each variant's win family is its group's `h` headline cases at α_v = 0.05/S (Bonferroni across the R2 entrants), Holm step-down across the `h` cases within the variant. The smallest p must clear 0.05/(S·h), the next 0.05/(S·(h−1)), and so on.
- And no loss on `c` for any of the three models (any loss eliminates anyway).

Under the null, a group lands a false R2 win with probability at most 0.05 over all its entrants and cases, whatever the dependence between models and cases, before R4 and the holdouts.

**Elimination.** A variant is out on:
- any loss (Holm, above);
- any attributable destructive entry (§5.2);
- any `invalid` lead-in row on a headline case (§1.4 lint 3).

### 4.2 Sample sizes, power and wall time

**Effect to detect.** A realistic text fix moves a weak model from 0.5 to 0.8 hit rate on its case. All powers below are Fisher exact (one-sided, by enumeration, two samples of `n_eff` each) except the CMH rows (Monte Carlo, 3000 draws on scaled counts; its null rejection rate came out 0.015 against the nominal 0.0167). `B` = S·h, the Bonferroni-Holm divisor of the win test's first step (§4.1): with N = 12 variants, `S = A1 ≤ 6` R2 entrants, and a group has `h ≤ 3` headline cases, so `B ≤ 18`.

**Win (pooled weak models).**

| pooled `n_eff` per side | power 0.5→0.8 at B = 18 (α 0.0028) | at B = 9 | at B = 3 | MDE at 80%, B = 18 |
|---|---|---|---|---|
| 48 | 0.56 | 0.65 | 0.80 | 0.5 → 0.86 |
| 66 | 0.77 | 0.83 | 0.92 | 0.5 → 0.81 |
| 90 | 0.92 | 0.95 | 0.98 | 0.5 → 0.77 |
| 100 | 0.95 | 0.97 | 0.99 | 0.5 → 0.76 |

**Loss, per case** (one model, Holm first step of 45 tests: 14 cases plus cold-guess, × 3 models, α 0.0011): at `n_eff` 40 the MDE is 0.8 → 0.35 (power for 0.8 → 0.5: 0.33); at 50, 0.8 → 0.41 (0.48); at 75, 0.8 → 0.48 (0.76). Later Holm steps have more power; the first step is the worst case. The per-case test alone catches only drops of about 0.4, which is why the CMH test exists.

**Loss, stratified CMH** (one model, 15 strata at the R2 plan below: 3 own headline cases at `n_eff` 75, 9 cross-group headline cases at 50, the guards at 40 and 45, cold-guess at 60; α 0.05/3):

| Drop | CMH power |
|---|---|
| broad: every stratum 0.8 → 0.5 | 1.00 |
| broad: every stratum 0.8 → 0.7 | 0.99 |
| broad: every stratum 0.8 → 0.75 | 0.60 |
| 4 cross-group strata 0.8 → 0.5, the rest flat | 0.91 |
| 3 cross-group strata 0.8 → 0.5, the rest flat | 0.68 |
| 2 cross-group strata 0.8 → 0.5, the rest flat | 0.36 |

So a broad 0.8 → 0.5 drop, which revision 2 caught with 0.33 power per case, is now caught with certainty, and a broad drop as small as 0.8 → 0.7 with 0.99.

**Targets.** R2 is the deciding round.
- Own-group headline cases: pooled weak-model `n_eff ≥ 90` (win test; power ≥ 0.92 for 0.5 → 0.8 at the worst B = 18), and per-model `n_eff ≥ 60` (loss tests). A skill or recipe variant is exposed on two of the three arms, so its win test sees about two thirds of the clusters: pooled `n_eff ≈ 66`, power 0.77 at B = 18 and 0.92 at B = 3. Accepted: skill variants need a slightly larger effect.
- Cross-group headline cases and guards (no-regression only): per-model `n_eff ≥ 40`.
- R1 is a screen: one row per cluster and model (`r = 1`), `n_eff = m` per model.

**The n plan** (`tournament plan`, B3b; written into the `freeze` row). For each case: `m` = paraphrases × arms, and the smallest `r` meeting every target of its kind: per model `m·r / (1 + (r − 1)·ρ̂) ≥ target`, and for own headline pooled `2·m·r / (1 + (2r − 1)·ρ̂_pool) ≥ 90`. If reps cannot reach a target (`m/ρ̂ < 1.25 × target`, or `m/ρ̂_pool < 1.25 × 90`), B4b adds paraphrases (up to 14) before the freeze; if it is still short, the case's achieved `n_eff` and MDE are written in the `freeze` row and the report. Planning values at `ρ̂ = ρ̂_pool = 0.2` (B5 replaces them):

| Case kind | Paraphrases × arms (`m`) | R1 `r` → `n_eff` per model | R2 `r` → `n_eff` per model / pooled | R2 rows per (surface, case, model) |
|---|---|---|---|---|
| own headline | 10 × 3 = 30 | 1 → 30 | 4 → 75 / 100 | 120 |
| cross-group headline | 10 × 3 = 30 | — | 2 → 50 / — | 60 |
| guard with arms `none, skill` (case 13) | 6 × 2 = 12 | — | 8 → 40 / — | 96 |
| guard with three arms (case 14) | 6 × 3 = 18 | — | 4 → 45 / — | 72 |

At `ρ̂ = ρ̂_pool = 0.3`, 30 clusters give per-model 63 and pooled 77 at `r = 4`, so the plan adds paraphrases to 14 (`m = 42`, `r = 3` → 79 per model, 101 pooled).

**Rounds.**

| Round | What runs | Rows | Models | Advance (fixed counts) |
|---|---|---|---|---|
| R1 | Group headline cases × all arms, base plus N variants (N = 6-12: two designers, 3-6 each) | `r = 1` per cluster (30 per cell) | haiku, gemini, **sonnet** | Exactly `A1 = min(⌈N/2⌉, E1)` variants, where `E1` = survivors (not eliminated) whose R1 score is > 0. `S = A1` sets the win test's Bonferroni divisor (§4.1). |
| R2 | **Fresh rows** (new rep indices, new nonces; R1 rows never enter R2 scoring or ranking). Own headline cases at the R2 plan; every other group's headline cases and the guards at the cross-group plan; the cold-guess headline intents (3 reps × 3 models). | §4.2 plan | all three | Exactly `A2 = min(2, W2)` variants, where `W2` = survivors with at least one win. If `W2 = 0`, the group ends and base stays. |
| R3 | Exposure and behaviour scan (§4.4). No scoring. | — | haiku (live part) | Scenarios that exercise each finalist. |
| R4 | Finalists plus base on the exercising scenarios, fresh runs. | §4.5 | haiku, gemini, sonnet | §4.5 decision. |

**Ranking and ties** (total order; the last key never ties):
- R1 score = sum over the group's headline cases of the pooled weak-model z (two-proportion z on Kish-scaled pooled counts of exposed clusters; 0 for an unexposed case). Order: R1 score, then total weak-model hits on exposed rows, then mean probe tokens (lower), then text delta (shorter), then variant id (ascending).
- R2: number of wins, then the sum of the win cases' pooled z, then total weak-model hits on exposed rows, then mean probe tokens, then text delta, then variant id.

**Wall time and load.** Expected row wall (`NextCase.expectedRowMs`), from the timing above: cases 1, 2, 6-11, 13, 14 about 30 s (sandbox, seed, lead-in, model, a short answer); case 3 about 40 s; case 4 about 160 s (70 s lead-in, model, 75 s answer); case 5 about 380 s, worst 480 s (120 s lead-in kill, model, up to 3 × 120 s of answer; the golden takes about 200 s); case 12 about 100 s; a cold-guess row about 10 s.
- **Concurrency** on the mac (16 cores): 24 row slots (`concurrency`); most of a long row is a blocked wait or a gated sleep, not CPU. At most 8 concurrent `askModel` calls per provider (`modelConcurrency`). Each row owns one private tmux server (`sandbox.ts:44-48`), so at most 24 tmux servers at a time; the sandbox teardown kills its server (`sandbox.ts:264`) before the slot frees. No new row starts while the 1-min load average exceeds 14 (`maxLoad`). The driver queues long-case rows first so they do not leave a tail.
- **Throughput.** A round is bound by the slower of two limits: row slots (24 × 3600 row-seconds per hour) and model calls. At about 15 s per model call and 8 per provider, the anthropic provider (haiku and sonnet, two thirds of rows) caps the round at about 2900 rows per hour.
- **Estimate per group, worst case N = 12** (S = 6 R2 entrants plus base; group headline counts c1 3, c2 2, c3 2, c4 1, c5 3, c6 1):
  - R1: 30 rows × (N+1) × 3 models per own headline case: 1.2k-3.5k rows. 0.4-1.4 h, except c1 at about 8 h (slot-bound by case 5).
  - R2: about 22k-25k rows per group (own headline 120, cross-group 60, guards 96/72 rows per surface and model, plus cold-guess). 15-16 h model-bound, c1 about 23 h.
  - R4: up to 3 surfaces × 3 models × 48 runs = 432 AUT runs at 6 concurrent and about 6 min each: about 7.5 h.
  - So about 1.0 day per group (c1 1.6 days), and about 6.7 days for the six groups run one after another. Designer sessions, builds, R3 and review stops add a few hours per group, so 7-8 days, inside the 5-8 days the user accepted (Q1, `hill2` note 5). With N = 6 it falls to about 5 days.
- `tournament plan` prints the estimate from the frozen plan before R1, and the `spend` rows record the real wall.

### 4.3 R2 no-regression covers more than the group

A text change can break a verb another group relies on, for example a C1 wait output change against case 10's settle. R2 therefore runs every headline case of every group, plus the guards, plus cold-guess, on the survivors, all in the one loss family of §4.1. A loss anywhere eliminates the variant.

### 4.4 R3: which scenarios exercise the change

Candidates are every non-holdout scenario in `tools/eval/scenarios/` plus B4a's new ones.

1. **Text, zero cost.** Run `check --family next --surface hill2-<v> --scenarios <all>` and the same on base. A scenario exercises the variant if any of its derived markers appears in a variant golden's `mu-out`, or one of its context markers in a base golden's `mu-out`.
2. **Behaviour, zero cost.** For `verb`, `error` and `output` variants: a scenario also exercises the variant if, for the same golden, any mu call's exit status, `--json` key-and-type tree or `mu-out` text differs between base and variant (nonces and timestamps normalised): the golden diff of the behaviour signature (§3.1), already computed at admission. This catches a change that alters exit codes or `--json` shape with no marker.
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

### 4.7 Fast mode (user decision 2026-11-09)

Phase C may run in fast mode (`hill2` note 28): looser accuracy for about 1.5 days in total. `tournament plan|freeze --fast <g>` sets it; the `freeze` row records `mode: "fast"`, the targets and the achieved MDE per case, and `r1`, `decide` and `report` follow the frozen mode.

- **Plan.** Own headline cases only, for R1: per-model `n_eff ≥ 30`, pooled weak-model `n_eff ≥ 45`, paraphrases capped as in §4.2; R1 runs the plan's `r` (1 at `ρ̂ = 0.2`: 30 per model, 50 pooled).
- **Decide on R1** (`tournament decide --fast <g>`, R1 rows only, base interleaved). A variant wins headline case `c` if, on its exposed clusters (§4.1, `nameCue` rows out, ≥ 4 clusters), its raw hit rate is above base's on both weak models and the pooled weak-model z (Kish-scaled, `ρ̂_pool`) is at least the win threshold `z*`, with no loss on `c`. Losses are §4.1's: per-case Holm and CMH over the R1 family, sonnet included; a loss eliminates. At most one winner per group: the largest **sum** of pooled z over its win cases (so two wins beat one), then the shorter text delta, then id. No win, base stays. The `decision` row carries the scores.
- **Win threshold** (data on the freeze row: `--win-alpha <α> --correct none|variants|bonferroni`). `z*` is the one-sided normal quantile at `α / k`, `k` = 1, N, or N·h (N the R1 field, h the own headline cases), computed at `decide` and written into the decision row. Default (the orchestrator's call, delegated by the user 2026-11-09): Bonferroni over N·h at family α 0.20, so `z*` 1.83 at 6 tests, 2.13 at 12, 2.29 at 18. A fast freeze row without the field is the old rule: α 0.05, uncorrected (`z*` 1.645).
- **Migration** (`tournament migrate-fast <g> --why "..."`). A group frozen in full mode whose R1 is scored in its current epoch, with no R2 score and no decision yet, switches to fast keeping that epoch: `decide --fast` reads the epoch's R1 rows (`probe.e<k>.jsonl`, rep ≥ the R1 floor; R2 rows in the file are skipped) and nothing re-runs. The `migrate_fast` control row records the rule and the judges: if the hash moved since the latest freeze or refreeze, the command lists the changed files and needs `--accept-judges <new hash>`, so the operator checks that none of them decides an R1 row.
- **No R2 and no per-group R3, R4 or final.** The CLI refuses them on a fast group and names C7.
- **C7** (`tournament final --combined [--drop <ids>]`, rows in `<root>/c7/`). One surface with every group's winning patch on the shared base. R3's scan (§4.4) per winner, R4 (§4.5) on the union of their exercising scenarios with sonnet and both weak models at `max(5, ⌈48/k⌉)` reps. A regression is an R4 Holm loss, an attributable destructive entry or a review stop decided `drop`. No regression: the holdouts, once (§4.6). A regression: no holdouts; the driver bisects the winners on the R4 scenarios only (halves, recursing into the half that regresses alone; base rows from the first run are reused) and names the winner to drop, or reports an interaction when neither half regresses alone, suggesting the lowest-z winner. Re-run with `--drop <id>`. If the holdouts were already spent, a passing combination has no clean holdout result (§4.6).
- **Error rates.** Uncorrected z ≥ 1.65 is nominal one-sided 0.05 per (variant, case) test, so a group's rate grows with its tests: Monte Carlo at the fast plan (30 clusters, `ρ̂` 0.2, null 0.5, base shared) gave 0.04-0.07 for 1 × 1, 0.17-0.20 for 6 × 1, 0.30 for 6 × 2, 0.42-0.49 for 6 × 3 and 0.57-0.64 for 12 × 3, power 0.94 for 0.5 → 0.8. The default (Bonferroni, family 0.20) holds 0.11-0.15 per group at 6 × 1 to 12 × 3, with power 0.92, 0.85, 0.82, 0.74 at 6 × 1, 6 × 2, 6 × 3, 12 × 3; over six groups about 1 − 0.86^6 ≈ 0.6 for at least one false winner. C7 and code review are the backstop. The report prints the rule, `z*`, and the per-group false-win rate and power from a seeded Monte Carlo (`fastErrorRates`) at the group's own R1 design (clusters, reps, `ρ̂_pool`) and its N·h.

## 5. Exposure log and attributable destructive (B3a, `tools/eval/exposure.ts`)

`exposure.ts` is the only module that computes `markersSeen`, `exposed`, placement and `attributable[]`. `nextstep.ts`, `tournament.ts` and the report call it.

### 5.1 Exposure log

**Probe.** `markersSeen` = the variant's derived markers found in the row's full prompt (system plus user), read from `prompts/<sha>.txt`; for a base row, its context markers. `exposed` = `markersSeen` is non-empty. By construction:
- a skill variant is unexposed on arm `none`,
- a recipe variant is exposed only on its own recipe arm,
- an output variant is exposed only if its lead-in printed the changed text.

**Behaviour exposure** (a row the markers miss, for every variant with a behaviour signature, §3.1). A row is also exposed when a **changed call ran** in it on the variant: a mu call whose key `(verb path, sorted flag names)` is in `changedCalls`, or whose argv uses a name in `newNames`.
- Probe: the call is any lead-in call (`leadInCalls[]`: its output and exit line are in the prompt) or any answer call (`muCalls[]`: the answer was subjected to the changed behaviour, for example it used the short new flag that a `next:` hint named).
- R4: any AUT mu call (`Verdict.muCalls`, B3a), placed at its tool call's `{turn, idx}`; `where = "behaviour"`, `marker` = the call key.
- The key match over-approximates: a call with a changed key may not reach the changed branch. That only adds unexposed rows to the win test, which dilutes a real effect; it never creates a win.

**R4.** A per-run list `exposure[] = {turn, callIdx, where, marker}`. `where` is one of:
- `system` (the skill's frontmatter description, which pi puts in the system prompt),
- `prompt`,
- `tool` (a tool result's text, `ToolCall.output`, `events.ts:150`: the text the model saw after any pipe and pi's truncation, whether from `bash` or `read`),
- `behaviour` (a changed call ran, above).

A marker in `mu-out` that the AUT piped away does **not** count. A run is `exposed` if `exposure[]` is non-empty.

- **Turn.** B3a adds `ToolCall.turn?` (the index of the assistant message that issued the call) and `ToolCall.idx?` (its position in that message), both **optional** in `types.ts`; `MetricsCollector` (`events.ts`) fills them on every R4 run. A tool call without them (a synthetic probe call from `answerMetrics`, an old row) is unplaceable: an R4 entry or exposure on it goes to outcome 2 below (`at = null`), and probes never need them (the one-turn rule below).

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

**Rows** are machine-local and never committed (`.gitignore`: `docs/eval/**/*.jsonl`; `docs/history/README.md` "Raw eval runs"), with one exception (Q3 default, `hill2` note 5): `tournament report` copies the small control file `tournament.jsonl` to `docs/eval/hill-r2/<group>.tournament.jsonl`, which is committed (B3c adds the `.gitignore` negation `!docs/eval/hill-r2/*.tournament.jsonl`). They go to `~/.local/state/mu-next/eval-transcripts/hill-r2/<group>/`:

| File or dir | Holds |
|---|---|
| `tournament.jsonl` | Control rows: `setup` (base sha, B0 proof, models, provider ext, systemSha, ρ̂ per (case, model) and ρ̂_pool per case, queue seed, holdout list "not run, not read"), `freeze` (judgesHash, n plan, achieved `n_eff` and MDE per case), `isolation`, `variant` (manifest, derived markers, behaviour signature, text delta, admission, goldenCompat), `round_score` (every cell: n, hits, DEFF, n*, hits*, exposed clusters (marker or behaviour), nameCue n, p, Holm-adjusted p, result; per model the CMH statistic and p; per variant `S` and its win thresholds), `cut` (ranking keys and advance count), `scan`, `r4_score`, `review_stop`, `review_decision`, `refreeze`, `decision`, `spend` (tokens per model, wall). |
| `probe.jsonl` | §1.6 rows. |
| `r4.jsonl` | `R4Row` (§7, B3c): `RunResult` plus `{group, round:"r4", variant, exposure[], destructiveFx[], attributable[]}`. R3's live runs go to `scan.jsonl` in the same shape (`round:"scan"`). |
| `prompts/<sha>.txt` | Prompt text. |
| `logs/` | rpc logs (the `logPath` layout). |
| `sealed/` | Final-gate holdout logs. |

**Report.** `tournament report <group> --out docs/eval/hill-r2/<group>.md`, committed. Sections, in order:
1. **Setup:** base sha and build, judgesHash, models and B0 proof, ρ̂ and ρ̂_pool and the n plan with achieved `n_eff` and MDE per case, the designer models and sessions and their isolation results, row-dir path, and the sha256 of each jsonl at report time.
2. **Variants:** id, summary, kind, derived markers, text delta, admission, goldenCompat, and the patch inline in a `<details>` block.
3. **R1 / R2 tables:** variant × case, with one cell per model `hits/n (n_eff, exposed clusters, p)` and a result column (win / loss / tie / unexposed / nameCue). Per model the CMH statistic and p. Then eliminations with their reason, the ranking keys, `S` and the win thresholds, and the cut.
4. **R3 scan:** scenario × finalist, exercised or not, and why (marker, behaviour diff, live exposure).
5. **R4:** scenario × model × surface, with completed, exposed runs, wrong, muErrors, destructive (attributable / new / noted); per model the pooled completed counts, p and Holm result; mean cost and base spread.
6. **Review stops and decisions** verbatim.
7. **Decision:** the winner or "base stays", with the one-line reason.
8. **Spend.**

The C7 report `docs/eval/hill-r2.md` adds the combined-surface matrix and the holdout counts.

## 7. Units

Files are owned by exactly one unit at a time; a later unit edits a file only after its owner has merged.

**B2 `nextstep_probe`.** After B1 is refuted. Parallel with B3a and B4a.
- `tools/eval/nextstep.ts` (new, ≤ 800 LOC): the types of §1.5, the lead-in runner and renderer, the prompt builder, `extractCommands`, answer execution with the `go` hook and the orchestrator env, `shown` and `shownLine` (§1.3), the timed-case rule, `answerMetrics`, the row writer, `runNext` (signature §1.5: resumable, interleaved, concurrency and load gate), `runNextCheck` (golden, bad, `true`, every `extras` row), `nextLint`, `selftest`, `nextReport`.
- `tools/eval/nextstep-cases.ts` (new): two pilot cases, `close_preview_apply` and `notes_multi` (one bash, one zsh), with all paraphrases, golden, bad and extras.
- `tools/eval/cold-guess.ts`: the `shell` and `env` parameters on `execGuess`, and the `evalfaux/*` short-circuit in `askModel`.
- `tools/eval/main.ts`: **all** CLI wiring of this round: `nextstep run|check|lint|selftest|report`, and one `tournament` case that dispatches to `tournamentCli(args)` in `tools/eval/tournament-cli.ts`. B2 creates that file as a stub that prints "tournament driver not built" and exits 2; B3b replaces its body. No other unit edits `main.ts`.
- **`nextstep report <probe.jsonl> [--round r] [--surface s] [--model m] [--out <file.md>]`** (default stdout). Raw counts only, for B5's readout and for `check`/`selftest` summaries; it computes no DEFF, exposure or test (those are `tournament report`'s). Sections:
  1. a header: the jsonl path, its sha256, row count, rounds, surfaces, models and `systemSha`s present;
  2. per round and surface, one table with a row per (case, arm) and a column per model holding `hits/n` plus partial, invalid, killed and `modelError` counts;
  3. per case, a `<details>` block with the hit matrix by paraphrase × model, so a paraphrase that never hits shows up;
  4. per model, mean tokens and mean row ms.
  - Exit 0; exit 2 on an unreadable or empty jsonl.
- Tests:
  - `test/eval/nextstep.test.ts` covers:
    - extraction (0/1/3/4 blocks);
    - the transcript render (exit and timeout lines, merged stderr);
    - `shown`: a marker printed by a mu call in command 1 and shown in command 2 does not count; `mu … >/dev/null; echo <marker>` in one command does not count; a marker typed with split quotes does not count; the same-command pipe does;
    - `shownLine` (verbatim line, not in the command text);
    - `answerMetrics`: a two-call answer, where `muIn` places each mu call in its command; a sleep loop is flagged by `idleCalls`, a repeated `task show` by `pollingCalls`; `sleep 80; mu task show …` fails a timed case;
    - the `go` gate timing, the orchestrator env (`PI_SESSION_ID` reaches an answer's mu call);
    - the lint (base leak fails, variant leak gives nameCue, lead-in verb), and `execGuess` under zsh;
    - `nextstep report` on a fixture jsonl.
  - `test/eval/nextstep.integration.test.ts`: `nextstep check` and `selftest` on the built checkout.
  - Every new rule is mutation-checked.
- Docs: a `tools/eval/README.md` section.

**B3a `exposure_scoring`.** After B1 is refuted. Parallel with B2 and B4a.
- `tools/eval/exposure.ts` (new): the `ExposureSpec` type (§3.1), probe and R4 exposure (marker and behaviour, §5.1), placement and attribution (§5.2). The sole owner of `markersSeen`, `exposed` and `attributable[]`. Exports `probeExposure(row, promptText, spec)`, `r4Exposure(result, { scenarioPrompt, skillDescription }, spec)` and `attribute(destructiveFx, exposure)`.
- `tools/eval/stats.ts` (new): one-sided Fisher exact, Holm, the one-sided stratified CMH test, ICC (one-way ANOVA) for one model and pooled across models, DEFF and Kish scaling, Fisher exact power, and the n plan solver (per-model and pooled targets).
- `tools/eval/events.ts` and `tools/eval/types.ts`: **optional** `ToolCall.turn?` and `ToolCall.idx?`, filled by `MetricsCollector`; `Verdict.destructiveFx` and `Verdict.muCalls?: { argv, exit, toolCallId | null }[]` (the AUT's mu calls placed by `muIn`, for behaviour exposure).
- `tools/eval/observe.ts` and `tools/eval/score.ts`: `destructiveFx` with placement and `muCalls`, both built in `verdictFx` (`observe.ts`, the judge path every scenario takes); `destructive[]` unchanged.
- Tests:
  - `test/eval/exposure.test.ts` covers the exposing call itself (pipeline: attributable), a parallel call of the same message (not attributable), the next turn (attributable), two turns later (not), piped-away mu-out (not exposed), a changed call in an answer or an R4 run (behaviour-exposed), a call with an unchanged key (not), a tool call without `turn` (unplaced, review), and new-vs-base classes.
  - `test/eval/stats.test.ts` checks Fisher p-values and power against the §4.2 rows, CMH against a reference value and its null rate (≤ α by Monte Carlo), Holm on a known vector, the pooled ICC, and the plan solver (unreachable target → add paraphrases).
  - `test/eval/events.test.ts` gets the turn and idx.

**B3b `tournament_driver`.** After B2 and B3a merge.
- `tools/eval/tournament-build.ts` (new): manifest, build, `deriveMarkers`, `behaviourDiff`, admission (length cap; markers or behaviour signature), pack, BRIEF render and refusal rules, the designer launcher (`tournament design`, §3.2: empty HOME, provider extension only, own session dir), deny list, isolation audit, freeze/refreeze hash.
- `tools/eval/tournament.ts` (new): the n plan and wall estimate, R1/R2 job lists → `runNext`, scoring through `stats.ts` and `exposure.ts` (per-case Holm and CMH losses, the pooled win test with `S`), ranking and fixed advance counts, `appendReviewStop`/`appendReviewDecision` (exported; B3c uses them), `tournament review`.
- `tools/eval/tournament-cli.ts`: replaces B2's stub with `build|pack|design|audit|freeze|refreeze|plan|r1|r2|review|status`, plus `r3|r4|final|report`, which call `runScan`, `runR4Gate`, `runFinal` and `writeReport`. B3b creates `tools/eval/tournament-r4.ts` and `tools/eval/tournament-report.ts` holding only those four signatures, each throwing "not built"; B3c replaces their bodies.
- Tests: `test/eval/tournament.test.ts` covers the win/loss/elimination rules on synthetic rows (a null variant at the R2 plan: Monte Carlo false loss ≤ 0.10, false win per group ≤ 0.05 with S = 6; a 0.5 → 0.8 variant wins at the planned power; a broad 0.8 → 0.7 drop is a CMH loss), nameCue handling, the direction condition, the ranking total order and advance counts, fresh R2 rows (an R1 row in R2 scoring is an error), the judgesHash refusal, the pack and BRIEF refusals, the designer env (HOME empty, no user extension, PATH without `mu`/`museum`), the deny list (each new path and the catch-all), marker derivation (a string occurring twice in base is rejected as a context marker), the length cap, and admission of a behaviour-only variant (a short new flag; a changed exit code) next to the refusal of an inert one.

**B3c `tournament_gate`.** After B3b merges.
- `tools/eval/tournament-r4.ts`: R3 (`runScan`: text, behaviour and live steps of §4.4), R4 (`runR4Gate`: §4.5 counts, Holm over models, exercised precondition, destructive outcomes through `exposure.ts` and B3b's review stop), and the final gate (`runFinal`: §4.6, holdouts once, `sealed/`). All three run AUT jobs through one runner:
  ```ts
  export interface R4Job {
    group: Group; round: "scan" | "r4" | "final";
    variant: string;                  // "base" or a variant id
    surface: Surface; scenario: string; model: string; rep: number;
  }
  export type R4Row = RunResult & {
    group: Group; round: R4Job["round"]; variant: string;
    exposure: Exposure[]; destructiveFx: DestructiveFx[]; attributable: DestructiveFx[];
  };
  export interface RunR4Opts {
    jobs: R4Job[];                    // built by the caller, shuffled with the setup seed
    out: string;                      // r4.jsonl | scan.jsonl | holdouts.jsonl; resumable by (round, variant, scenario, model, rep)
    logRoot: string;                  // <rowdir>/logs, or sealed/ for "final"
    concurrency: number;              // AUT runs at once (default 6)
    providerExt?: string;
    spec: (variant: string) => ExposureSpec;   // from the `variant` rows; base gets its context markers
    run?: typeof runOne;              // injectable for tests
    onRow?: (row: R4Row) => void;
  }
  export async function runR4(o: RunR4Opts): Promise<{ written: number; skipped: number }>;
  ```
  Per job: `loadScenario(job.scenario, job.surface.scenarioRoot)`, then `runOne({ surface, scenario, model, rep, providerExt, live: isLiveRun(scenario, "pi"), log: logPath(logRoot, …) })` (`commands.ts:224`, which calls `runAut` through `runPiAut`, `commands.ts:188`; export `RunOne` if it is not). The judged `RunResult` carries B3a's `verdict.destructiveFx` and `verdict.muCalls`. Then `exposure = r4Exposure(result, { scenarioPrompt: scenario.prompt, skillDescription }, spec(job.variant))` and `attributable = attribute(result.verdict.destructiveFx, exposure)`, and the row is appended. New-vs-base classes are computed at score time over the cell, not per row.
- `tools/eval/tournament-report.ts`: `writeReport` (§6), including the copy of `tournament.jsonl` to `docs/eval/hill-r2/<group>.tournament.jsonl`; `.gitignore`: the negation for that file.
- Tests: `test/eval/tournament-r4.test.ts` with an injected `run` covers resumability, the row shape (`exposure[]` with `tool`, `system` and `behaviour` entries), an attributable entry eliminating, a new-vs-base unattributable entry stopping with exit 7, the R4 Holm decision at n = 48, the exercised precondition, and that `final` writes logs only under `sealed/`; a report snapshot test on synthetic rows.

**B4a `intents_scenarios`.** After B1 is refuted. Parallel with B2 and B3a.
- `tools/eval/fixtures.ts`: the `gate` task-script option, `chromePane`, `seedDelegate` and `delegateDefault` (§2).
- `tools/eval/cold-intents.ts`: the intents of §2.1.
- `tools/eval/scenarios/{poll_wave,multi_notes,wait_report_act}.ts` plus their `.golden/.bad*.next.json`.
- Tests: `test/eval/cold-guess.test.ts`, the `check` test lists, and a fixtures test:
  - a gated script waits for `go`;
  - `seedDelegate` writes exactly what the delegate path writes: the delegate task with its brief note, the `delegate_calls` row (caller `pi:nextstep-orch`, wave `w1`, record `auth/t4`, state `done`, verdict NULL for an answer without a VERDICT line), the `NO VERDICT LINE` verdict note on t4, the closed delegate task with its report, and **no** `checks` row;
  - `mu wait --wave w1 -w auth` run with `PI_SESSION_ID=nextstep-orch` fires at once and tallies `auth/t4` as unverified 1;
  - with `delegateDefault`, a later delegate run answers the given text; without it, the old generated answer.

**B4b `nextstep_cases`.** After B2 and B4a merge (it uses both `nextstep-cases.ts` and the fixtures).
- The remaining cases of §2 in `tools/eval/nextstep-cases.ts`, with the double-exit-6 reproduction for case 11.
- `nextstep check` green on base for every row of §2.3, every column.
- A `nextstep lint` run against base vocab.
- Holdouts untouched.

**B5** then runs base on every probe case (all paraphrases, all arms, `r ≥ 4`), the cold-guess intents and the R4 set, with all three models, to set the spread, ρ̂ and ρ̂_pool, before the freeze and before C1; `nextstep report` is its readout. The freeze happens after B3b, B3c, B4b and B5 and before any designer starts.

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

None. Revision 2's three questions are settled by the orchestrator's defaults (`hill2` note 5), which the user may still override:
- **Wall time (old Q1):** the power targets are accepted. With two designers (N up to 12) the estimate is 7-8 days for six groups (§4.2), inside the accepted 5-8.
- **Designers (old Q2):** two sessions per group, `claude-opus-5-5` and `gemini-3.1-pro-preview`, each proposing 3-6 variants on its own (§3.2).
- **Control file (old Q3):** `tournament.jsonl` is committed as `docs/eval/hill-r2/<group>.tournament.jsonl`; the raw rows stay machine-local with their sha256 in the report (§6).

Settled in revision 2: one-shot probes only, recovery is R4's job (old Q1); R4 is a gate with completion primary and cost as tie-break (old Q2); the statistics (old Q3, §4.1-4.2); **Q4: recording a CONFIRMED verdict from prose that has no VERDICT line is a close by guess, which VISION forbids (`src/close-block.ts:13`, `delegate-verdict.ts:65`), so it is a miss; the hit is putting a real review in motion** (case 9, redesigned in revision 3 on what the delegate path writes); C6 items with no one-shot observable stay R4-only (old Q5); base is interleaved per round (old Q8); no help arm (old Q9, §1.1); case 11 is dropped if O6 does not reproduce (old Q10).

## 10. Revision log

### Revision 3

Revision 3 answers `scratch/delegate_refute-spec2_34abfd81` (REFUTED). Section numbers refer to this revision.

**1. Case 9 and the delegate path**
- Changed: case 9 is rebuilt on what the delegate path writes: no `checks` row, since `issueCheck`'s only caller is `src/cli/tasks/checks.ts:37`. Instead it uses the `delegate_calls` row (verdict NULL) and the `NO VERDICT LINE` verdict note on t4. The hit is a dispatched re-review: a new `checks` row on t4, a new delegate call recorded on `auth/t4`, or a prompt naming t4 delivered to a worker. A forged CONFIRMED/REFUTED (one without the reviewer-only `RV-<nonce>`) or closing t4 is a miss. The natural answers, `mu task check` and re-registering a delegate with `--record auth/t4`, both hit. §2, §2.3.
- Changed: `seedDelegate` takes `callId`, `caller`, `wave`, `record`, `agent` and `answer`, runs `register | mark | finish` with caller `pi:nextstep-orch` (what `mu wait --wave` needs, `src/cli/wait.ts:354`), and states everything it writes. `delegateDefault` makes a later reviewer run answer deterministically. §2.
- Changed: answers run with the orchestrator env (`PI_SESSION_ID=nextstep-orch`, the new `env` parameter on `execGuess`). §1.2.
- Changed: B4a's fixtures test no longer claims a check row. It asserts the delegate rows and notes, the absence of a `checks` row, and the unverified wave tally. §7.

**2. Sleep-based wins**
- Changed: cases 4, 5 and 12 are `timed`: a hit needs `idleCalls` and `pollingCalls` over `answerMetrics` empty, so `sleep 80; mu task show t1` and `sleep 115; sleep 115; mu wait …` miss. §1.3, §2.
- Changed: every case is audited for sleep wins in the new sleep-wait column of §2.3. Only 4, 5 and 12 have a goal state pending at `t0`. §2.3.

**3. `shown`**
- Changed: the marker must be in the output of the same answer command whose mu call printed it. A marker present in any answer command's text (quotes, backslashes and whitespace stripped) is refused. §1.3.
- Changed: markers that the transcript already shows (cases 6 and 8) are whole lines with a per-row random phrase, so they cannot be typed past rule 3 or generated by a loop. §1.3, §2.
- Changed: a new `shownLine` checks non-nonce observations (cases 4, 11, 12 and 13a) as a verbatim line of the same command's output. §1.3, §2.

**4. Case 12 and groups**
- Changed: case 12 has no wave. Its golden waits on `task:auth/t1 task:auth/t2 task:auth/t3 --all`, because `--wave` waits on delegate calls only (`src/cli/wait.ts:704`). Its group is c6 alone, and `NextCase.group` stays single-valued, documented as such. §1.5, §2, §2.3.

**5. Statistics**
- Changed: a stratified one-sided CMH loss test per model over all cases of the round, at α 0.05/3, sits beside the per-case Holm tests. Its power is 1.00 for a broad 0.8 → 0.5 drop and 0.99 for 0.8 → 0.7. Revision 2 caught 0.8 → 0.5 with 0.33 power per case. §4.1, §4.2.
- Changed: false wins are controlled per group. Each variant's win family is tested at 0.05/S, with S the R2 entrants (Bonferroni), and Holm across its headline cases. §4.1.
- Changed: route (a) is dropped. Haiku and gemini share each prompt, so its null rate lay between 0.0025 and 0.05. The single win test pools the two weak models, with clusters spanning both models and `ρ̂_pool` from B5, plus a direction condition on each model. §4.1.
- Changed: the targets are pooled `n_eff ≥ 90` for wins (power ≥ 0.92 at the worst divisor of 18) and per-model `n_eff ≥ 60` for losses. Headline cases ship 10 paraphrases. The n plan and power tables are recomputed. §1.4, §4.2.
- Changed: the wall estimate is redone for N up to 12 (two designers). It comes to about 1 day per group (c1 1.6 days), 7-8 days in all. §4.2.

**6. Admission of behaviour-only variants**
- Changed: a variant with no derived marker is admitted when its behaviour signature is non-empty. The signature covers new flag or verb names of any length, and golden diffs in exit status, `--json` key-and-type tree or output. A variant with neither is refused. §3.1.
- Changed: behaviour exposure counts a row as exposed when a changed call ran in it (a lead-in or answer call in a probe, an AUT call in R4). The `ExposureSpec` carries `newNames` and `changedCalls`. §3.1, §5.1.

**7. Units**
- Changed: `ToolCall.turn` and `ToolCall.idx` are optional. B2's adapter sets neither. A call without them is unplaced (review), and probes never read them. §1.2, §5.1.
- Changed: B3b is split. B3b keeps build, pack, design, audit, plan, R1/R2, scoring and review. The new B3c takes R3, R4, the final gate and the report, after B3b. B3c gets a specified `runR4`/`R4Job`/`R4Row` interface: it runs `runOne` → `runAut`, uses `r4Exposure` and `attribute` from `exposure.ts`, and writes `r4.jsonl` with `exposure[]`. §6, §7.
- Changed: `nextstep report` (B2) is specified: its inputs, filters, sections and exit codes, with raw counts only. §7.

**8. Leaks**
- Changed: designers run like `askModel`: an empty HOME, the provider extension only, no user skills, extensions or context files, a PATH without `mu` or `museum`, and their own session dir. §3.2.
- Changed: the deny list adds `~/.pi/agent/sessions`, `~/.claude/projects`, `~/.codex/sessions`, the museum store `~/museum`, the museum skill and command, and a catch-all for any path under the real HOME outside the session's own pack and dirs. §3.2.

**Other**
- Changed: §2.3 has five columns: `true`, plausible bad, lucky spelling or forgery, sleep-wait, golden with natural alternatives. `NextCase.extras` lets `nextstep check` prove every column. §1.5, §2.3.
- Changed: the open questions are closed by the orchestrator's defaults (two designers, the committed control file, the accepted wall). §9 lists none. §6, §9.

### Revision 2

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

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
