# Hypothesis panel

Use for root-cause work: a flaky test, an intermittent bug, a metric
that moved. One agent that forms a theory then tests its own theory
finds evidence for it. Separate agents, each given different evidence,
form independent theories; separate agents then try to kill them.

## Steps

1. **Write the symptom** on the umbrella: what happens, how often, the
   repro command, and what would count as fixed.
2. **One reader task per evidence source**: logs, the code path,
   recent commits, data, environment. Each agent sees only its source,
   so the theories do not anchor on each other. Each records its theory
   as an `OPEN/triage` task blocking the umbrella:

   ```bash
   mu task add -w <ws> --triage -t "h: <cause>" -i 60 -e 0.5 \
     --note 'PREDICTS: <an observation true if this is the cause, false otherwise>'
   ```

3. **Test each hypothesis** in its own workspace. The tester claims the
   hypothesis task with `--force`, builds the experiment that would
   kill it (force the race, revert the commit, feed the data), and
   records the result: a killed hypothesis closes
   `--as rejected --why '<evidence>'`; a survivor is accepted.
4. **If one survives**, add a fix task for it, then a review task
   ([adversarial-review](adversarial-review.md)). The fix is accepted
   only if the step 1 repro stops reproducing.
5. **If none survives**, start another round
   ([loop-until-done](loop-until-done.md)): the new hypothesis tasks get
   the killed hypotheses and their evidence as input.

Done when a fix closed `ACCEPT` and the repro from step 1 no longer
reproduces at the rate step 1 recorded.

## Traps

- **Two survivors** usually means the experiments were too weak. Design
  one experiment that separates them before you fix either.
- **Flaky repros need counts.** "Passed once" proves nothing for a 1 in
  50 failure. Put the run count in step 1.
