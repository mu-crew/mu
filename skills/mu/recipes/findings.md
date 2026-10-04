# Findings

Use whenever an agent reviews, audits, checks, or researches something
and reports problems: every recipe that produces findings follows this
one. It decides where findings live, and how they become work.

## Pick the mode first

Ask: **will anyone act on these findings through the DAG?**

| Situation | Mode | Findings live in |
| --- | --- | --- |
| The result is read once and acted on directly: PR comments, doc edits, a go/no-go, a draft fact-check | **Delegate** | the delegate's answer |
| Findings become work agents fix, or must be tracked to closure | **Workstream** | one `OPEN/triage` task per finding |

Delegate mode keeps reviews of other people's PRs and docs out of the
ops log, which is permanent and syncs to every machine. Workstream mode
is the mu way for your own work: the graph shows every finding, who
decided it, and the fix.

## Delegate mode

1. Run reviewers as [delegate calls](tasks-or-calls.md#delegate-call):
   one per angle or slice, all in one turn so they run in parallel,
   under the cap ([orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency)).
2. Each delegate ends its answer with one line per finding:

   ```text
   FINDING: high src/api/user.ts:88 PUT handler skips the auth check EVIDENCE: curl -X PUT ... returned 200
   ```

3. You read the answers, merge duplicates, and act: post the comments,
   edit the doc, give the verdict.
4. **Promote** when the findings turn out to be work: create one
   `OPEN/triage` task per line (below) and continue in workstream mode.

Done when every delegate answered and every finding line was acted on
or dropped with a reason.

## Workstream mode

### Record

The reviewer records each finding as a task in triage, blocking the
review's umbrella so the umbrella cannot close while findings are
undecided:

```bash
mu task add -w <ws> --triage \
  -t "high: PUT /user skips the auth check" -i 70 -e 0.5 \
  --note 'FINDING: high src/api/user.ts:88 PUT skips the auth check EVIDENCE: curl -X PUT ... returned 200 without a token'
mu task block <umbrella> -w <ws> --by <finding-id>
```

The title starts with the severity. The note is one `FINDING:` line,
the same shape everywhere: `FINDING: <severity> <file:line> <what>
EVIDENCE: <command + output>`. `OPEN/triage` keeps the finding out of `mu task next`, and
`claim` refuses it, so no worker starts on an undecided finding.

**More than 5 findings from one reviewer:** the reviewer writes them as
`FINDING:` lines in its own task note instead. Before that reviewer
task closes, the orchestrator adds `triage_<umbrella>` blocking the
umbrella; the triage agent ([Triage](#triage) step 1) merges duplicates
across reviewers and creates one task per real problem.

### Triage

1. **Who:** a handful of findings, the orchestrator triages itself. Many,
   or several reviewers on one change: a `triage_<umbrella>` task, run
   by a fresh agent, so the orchestrator reads only its result.
2. **Refute** each finding before accepting it with a
   [delegate call](tasks-or-calls.md#delegate-call): a fresh agent tries
   to prove it false and ends with
   `VERDICT: <id> CONFIRMED | REFUTED | UNVERIFIED <evidence>`. Skip this
   for low-severity style findings. High severity: three refuters,
   accept only if at least two say CONFIRMED.
3. **Decide** each one; the decision is the task's state:

   | Decision | Command |
   | --- | --- |
   | real work | `mu task accept <id> --evidence '<what confirmed it>'` |
   | false | `mu task close <id> --as rejected --why '<evidence>'` |
   | same as another | `mu task close <id> --as duplicate --why 'same as <id>'` |
   | valid, not worth it | `mu task close <id> --as wontfix --why '<reason>'` |
   | could not check | stays in triage, with an `UNVERIFIED: <why>` note |

4. **Group** accepted findings that touch the same files into one fix
   task when separate workers would collide; close the grouped findings
   `--as superseded --why 'fixed in <fix-task>'`.

Done when `mu task list --substate triage -w <ws>` lists only findings
with an `UNVERIFIED` note, and each of those is reported to the human.

### Fix and close

Accepted findings are ordinary tasks: dispatch them, review the fix
([adversarial-review](adversarial-review.md)), merge. The umbrella
closes with `mu task close <umbrella> --if-ready` once every finding is
`CLOSED/*`. A plain `close` would succeed with findings still open.

The report is a query, not a document: `mu task list -w <ws>
--substate rejected`, `--substate duplicate`, `--status OPEN`, and the
notes on each task.
