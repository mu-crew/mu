# Drift audit

Use during a long run to catch a crew drifting from what you decided:
an instruction that never reached its worker, a batch run on stale
inputs, work continuing on a closed task. One read-only
[delegate call](tasks-or-calls.md#delegate-call); it edits nothing.

## When

- every few hours of a long run;
- after each batch report of a chained task (sweep, campaign, soak);
- after a context compaction or a resume;
- before you declare a stop rule met.

## Run

Issue one delegate call with `record: { task: "<ws>/<umbrella>" }` and
this brief, with `<ws>` filled in:

```text
Read-only drift audit of mu workstream <ws>. Change nothing. Sources:
mu state -w <ws>; mu task list -w <ws> --json; mu task notes <id> -w <ws>;
mu log -w <ws> -n 500 --json (intents agent.send, task.claim, task.close);
git log in the repo and in each owner's workspace. Check:
1. Unsent notes: an instruction in a note on an IN_PROGRESS task, added
   after the owner's last agent.send or task.claim op. Did the owner act
   on it (later commits, notes, pane)? Also flag an agent.send with
   mode=plain or mode=steer whose state=busy since=<t> is long before
   the send: it queued behind a long turn and may not have landed.
2. Stale pins: for each build/binary sha or oracle commit named in an
   IN_PROGRESS note, and each merged fix its task's findings depend on:
   git merge-base --is-ancestor <fix> <pinned>. Exit 1 = pin is stale.
3. Closed-task notes: a note added after its task's task.close op.
4. Thin decisions: an ACCEPT/REJECTED/CLOSE/SUPERSEDED note under 40
   chars; a refuter tally with no REFUTER or VERDICT note; a review the
   orchestrator closed with no FILES/COMMANDS note and no commit.
5. Silent tasks: IN_PROGRESS with no note or commit for longer than
   the cadence its notes state (default 2h).
6. Missing work: a task or finding a note or log line says will be
   filed that does not exist.
7. Unrefuted briefs: IN_PROGRESS tasks with no note line starting
   REFUTER , VERDICT: or REFUTE-EXEMPT:.
End with exactly this, one EVIDENCE line per finding (none when clean):
VERDICT: <ws> DRIFT-AUDIT CLEAN | FINDINGS <n>
EVIDENCE: FINDING <high|med|low> <file:line|task> <what> (check <1-7>)
```

`record` keeps only the VERDICT line and the `EVIDENCE:` lines after
it, so each finding must be an `EVIDENCE: FINDING` line. The note
lands headed `REFUTER`, which the refute nudge and decision warnings
read as a recorded verdict; on an umbrella that is harmless.

## Act

Each finding becomes one of:

- an `OPEN/triage` task blocking the umbrella ([findings § Record](findings.md#record));
- a send to the worker it names, per
  [orchestrator-loop § Sending](orchestrator-loop.md#sending)
  (`--interrupt` when its current work is wasted, as with a stale pin).

Done when the verdict is recorded on the umbrella and every finding
is a task or a delivered send.
