# Findings

Use when a review, audit or check reports problems.

**Mode.** Will agents fix these in the DAG? No (someone's PR, a doc): checkers answer with one `FINDING:` line each and you act; nothing enters your DAG. Yes: below.

## Record

One `OPEN/triage` task per finding, blocking the umbrella.

```bash
mu task add -w <ws> --triage --blocks <umbrella> -t "high: PUT /user skips auth" -i 70 -e 0.5 \
  --note 'FINDING: high src/api/user.ts:88 PUT skips the auth check EVIDENCE: curl -X PUT returned 200'
```

Grade strictly: `critical` needs a concrete path to data loss, breach or outage; `high` a plausible bug; style is `low`. When unsure, lower.

## Triage

1. **Refute each** with a [call or check](tasks-or-calls.md) (`record` in pi). Skip low style. High: three refuters, accept at 2 CONFIRMED. High or critical: one from another family (a pi delegate or a `scratch` pane).
2. **Decide**; the state is the decision, and `--why` names the deciding evidence:
   - real: `mu task accept <id> --evidence "2/3 CONFIRMED: <why>"`
   - false: `mu task close <id> --as rejected --why "<the guard that disproves it>"`
   - same as another: `--as duplicate --why "same as <id>"`
   - true, not worth it: `--as wontfix --why "<cost vs impact>"`
   - unchecked: stays in triage with `UNVERIFIED: <why>`, reported to the human; not REFUTED.
3. **Group** accepted findings sharing files into one fix task, block the umbrella on it, close the grouped ones `--as superseded`.

`mu task close <umbrella> --if-ready` waits for every finding and check.
