# Hypothesis panel

Use for root-cause work: a flaky test, an intermittent bug, a metric
that moved. One agent that forms a theory then tests its own theory
finds evidence for it. Separate agents, each given different evidence,
form independent theories; separate agents then try to kill them.

## Steps

1. **Write the symptom** on the umbrella: what happens, how often, the
   repro command, and what would count as fixed.
2. **One reader per evidence source** (a [delegate call](tasks-or-calls.md#delegate-call), strong tier:
   root cause is judgement, [models](models.md#roles)): logs, the
   code path, recent commits, data, environment. Each sees only its
   source, so the theories do not anchor on each other. Record each
   theory as an `OPEN/triage` task blocking the umbrella, decided like
   a finding ([findings § Triage](findings.md#triage)):

   ```bash
   mu task add -w <ws> --triage -t "h: <cause>" -i 60 -e 0.5 \
     --note 'PREDICTS: <an observation true if this is the cause, false otherwise>'
   ```

3. **Test each hypothesis.** An experiment that changes code (force the
   race, revert the commit) needs a workspace: `mu task accept` the
   hypothesis and dispatch it as a task. One that only reads (feed the
   data, grep the logs) is a delegate call with `record` on the
   hypothesis ([tasks-or-calls § Delegate call](tasks-or-calls.md#delegate-call)).
   A killed hypothesis closes `--as rejected --why "<the observation
   that contradicts PREDICTS>"`; a survivor gets a `SURVIVED: <evidence>`
   note. Prose reasons: [brief § Quoting](brief.md#quoting).
4. **If one survives**, add a fix task for it, then a review task
   ([adversarial-review](adversarial-review.md)). The fix is accepted
   only if the step 1 repro stops reproducing.
5. **If none survives**, start another round
   ([loop-until-done](loop-until-done.md)): the new hypothesis tasks get
   the killed hypotheses and their evidence as input.

Done when the fix's review task is `CLOSED/done` (ACCEPT) and the
repro from step 1 no longer
reproduces at the rate step 1 recorded.

## Traps

- **Two survivors** usually means the experiments were too weak. Design
  one experiment that separates them before you fix either.
- **Flaky repros need counts** ([long-run](long-run.md) step 1). "Passed once" proves nothing for a 1 in
  50 failure. Put the run count in step 1.
