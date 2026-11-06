# Tasks or calls

Use when a step spawns an agent: a **task** in the DAG, or a **call**?

**A task is work the graph tracks. Checking a thing is a call.**

| Task | Call |
| --- | --- |
| a unit that produces commits | refuting a finding, checking a claim |
| a gate on whether work counts (`review_x`) | judging a pair, a skeptic or dedupe pass |
| a finding, or the umbrella | a scout or reader feeding one step |
| anything needing its own worktree | |

## The call

In pi: `mu_delegate`, with `record: {task: "<ws>/<id>"}` when it judges a task, `wave` for a fan-out. Fresh context: the brief carries the claim, paths, criteria and an answer ending:

```text
VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <one line>
EVIDENCE: <file:line or command + result>   (3-6 lines)
```

- **Issue every call of a step in one turn**. Past `MU_DELEGATE_MAX` (16) they queue, then are refused (reissuable).

## Outside pi

Record a native subagent's check:

```bash
mu task check <id> -w <ws> --by <harness>/<model> --brief - <<'EOF'   # check=<c>
<brief>
EOF
mu task verdict <id> -w <ws> --check <c> - <<'EOF'
<the answer>
EOF
```

Reissue owed checks (`mu state`). Another family: record a `scratch` pane's `lastText` alike: `mu agent spawn r1 -w scratch --cli <harness>`; `mu agent send r1 -w scratch --force --wait -` (a new pane reads `unknown`), later `--fresh --wait`. None: `REFUTER <n>: no verdict (<outcome>)`. Close it (`--if <rev>`).
