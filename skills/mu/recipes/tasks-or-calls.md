# Tasks or calls

Spawn, refute, check, or delegate: a **task** or a **call**?

**A task is work the graph tracks. Checking a thing is a call.**

| Task | Call |
| --- | --- |
| a unit that produces commits | refuting a finding, checking a claim |
| a gate (`review_x`) | judging a pair, skeptic, or dedupe |
| a finding or umbrella | a scout or reader for one step |
| anything needing its own worktree | |

## The call

In pi: `mu_delegate`, with `record: {task: "<ws>/<id>"}` when it judges a task, `wave` for a fan-out, `model` per [models](models.md). Brief: claim, paths, criteria, ending:

```text
VERDICT: <id> CONFIRMED|REFUTED|UNVERIFIED <one line>
EVIDENCE: <file:line or command + result>   (3-6 lines)
```

- **Issue every call of a step in one turn**. Past `MU_DELEGATE_MAX` (16) they queue, then are refused (reissuable).

## Outside pi

`mu task check` → native subagent (Cursor Task; Claude/Codex/Muse) → `mu task verdict` (`mu delegates` = pi ledger).

```bash
mu task check <id> -w <ws> --by <harness>[/<model>] --brief - <<'EOF'   # check=<c>
<brief>
EOF
# native subagent runs that brief
mu task verdict <id> -w <ws> --check <c> - <<'EOF'
<the answer>
EOF
```

Done: check gone from `mu state` (on check row, not a note).

**Cross-family:** `mu task check` first; spawn `r1 -w scratch --cli <harness>`; send `-w scratch --wait -` (claude, cursor-agent: retry early `unknown`), later `--fresh --wait`; then `verdict`. None: `REFUTER <n>: no verdict (<outcome>)`. Close (`--if <rev>`).
