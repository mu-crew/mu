# Tasks or calls

Use when a step spawns an agent: is its job a **task** in the DAG or a **delegate call**?

**A task is work the graph tracks. Checking a thing is a call.**

| Task | Delegate call |
| --- | --- |
| a unit that produces commits | refuting a finding, checking a claim |
| a gate deciding whether work counts (`review_x`) | judging a pair, a skeptic or dedupe pass |
| a finding, or the umbrella | a scout or reader feeding one step |
| anything needing its own worktree | |

## The call

In pi: `mu_delegate`, with `record: {task: "<ws>/<id>"}` when it judges a task, `wave` for a fan-out. It starts empty: the brief carries the claim, paths, criteria and an answer ending:

```text
VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <one line>
EVIDENCE: <file:line or command + result>   (3-6 lines)
```

- **Issue every call of a step in one turn**; one at a time runs in series. Past `MU_DELEGATE_MAX` (16) they queue, then are refused and reissuable.

Outside pi, use `scratch`: `mu agent spawn r1 -w scratch`; `mu agent send r1 -w scratch --fresh --json -` (keep `runs`, `incarnation`); `mu agent wait r1 -w scratch --after-runs <runs> --inc <incarnation> --json`, whose `lastText` is the answer. Write it on the task as `REFUTER <n> (<agent>): <verdict lines>`, or `REFUTER <n>: no verdict (<outcome>)`. Then `mu agent close r1 -w scratch --if <rev>`.

