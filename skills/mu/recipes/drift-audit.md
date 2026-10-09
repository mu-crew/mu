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
mu sql (ops, tasks, task_notes, agents); git log in the repo and in each
owner's workspace. Never judge by a capped mu log -n window: the claim
or close you compare against is often older than it.
1. Unsent notes: notes on IN_PROGRESS tasks, by someone other than the
   owner, after the owner's last task.claim or agent.send op:
   mu sql "select t.local_id task, a.name owner, n.created_at, substr(n.content,1,80) note from tasks t join workstreams w on w.id=t.workstream_id join agents a on a.id=t.owner_id join task_notes n on n.task_id=t.id where w.name='<ws>' and t.status='IN_PROGRESS' and coalesce(n.author,'')<>a.name and n.created_at > max(coalesce((select max(o.created_at) from ops o where o.intent='task.claim' and o.key='<ws>/'||t.local_id),''), coalesce((select max(o.created_at) from ops o where o.intent='agent.send' and o.key='<ws>' and o.payload like 'agent send '||a.name||' (%'),'')) order by n.created_at"
   Quote each task's last claim (seq, time). For each instruction it
   lists: did the owner act on it (later commits, notes, pane)? Also read
   mu sql "select seq, created_at, payload from ops where intent='agent.send' and key='<ws>'"
   and flag mode=plain or mode=steer with state=busy since=<t> long
   before the send: it queued behind a long turn and may not have landed.
2. Stale pins: for each build/binary sha or oracle commit named in an
   IN_PROGRESS note, and each merged fix its task's findings depend on:
   git merge-base --is-ancestor <fix> <pinned>. Exit 1 = pin is stale.
3. Closed-task notes: notes added after the task's last task.close op,
   minus those the close verb writes in its own transaction
   (`--evidence`, `--why`: timestamp within 50ms of the close op); any
   other note counts, whatever its prefix. Report each of the top 5 by
   count as its own finding with its count,
   even when the notes look routine. A late note that reports the
   closed bug again usually ran on a build without the closing fix:
   check its sha with git merge-base --is-ancestor <fix> <sha>.
   mu sql "select t.local_id name, count(*) late from tasks t join workstreams w on w.id=t.workstream_id join task_notes n on n.task_id=t.id join (select key, max(created_at) at from ops where intent='task.close' and entity='task' group by key) c on c.key='<ws>/'||t.local_id where w.name='<ws>' and t.status='CLOSED' and (julianday(n.created_at)-julianday(c.at))*86400 > 0.05 group by t.local_id order by late desc"
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
