# Findings

Use when an agent reviews, audits or checks something and reports problems.

**Mode.** Will agents fix these through the DAG? No (someone's PR, a doc): delegates answer with one `FINDING:` line each and you act; nothing enters the ops log. Yes: workstream mode, below.

## Record

One `OPEN/triage` task per finding, blocking the review's umbrella.

```bash
mu task add -w <ws> --triage --blocks <umbrella> -t "high: PUT /user skips auth" -i 70 -e 0.5 \
  --note 'FINDING: high src/api/user.ts:88 PUT skips the auth check EVIDENCE: curl -X PUT returned 200'
```

Grade strictly: `critical` needs a concrete path to data loss, breach or outage; `high` a plausible bug; style is `low`. When unsure, lower.

## Triage

1. **Refute each** with a [delegate call](tasks-or-calls.md) passing `record`. Skip low style findings. High: three refuters, accept at 2 CONFIRMED.
2. **Decide**; the state is the decision, and `--why` names the deciding evidence:
   - real: `mu task accept <id> --evidence "2/3 CONFIRMED: <why>"`
   - false: `mu task close <id> --as rejected --why "<the guard that disproves it>"`
   - same as another: `--as duplicate --why "same as <id>"`
   - true, not worth it: `--as wontfix --why "<cost vs impact>"`
   - unchecked: stays in triage with `UNVERIFIED: <why>`; report it to the human. It is not REFUTED.
3. **Group** accepted findings sharing files into one fix task, block the umbrella on it, close the grouped ones `--as superseded`.

`mu task close <umbrella> --if-ready` does nothing until every finding is closed.
