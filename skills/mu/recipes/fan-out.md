# Fan-out

Use when the same treatment applies to many units: files, call sites,
failing tests, findings, modules. One context holding 50 units drops
some and calls the job done; one task per unit cannot.

## Steps

1. **Enumerate first.** A scout (a [delegate call](tasks-or-calls.md#delegate-call)) lists the units and
   writes them to the umbrella's note, one per line. The list is done
   when it matches a command the scout ran (`rg -l`, a test listing),
   not when it looks complete. Record the command and the count.
2. **One task per unit**, blocked into an umbrella:

   ```bash
   mu task add sweep -w <ws> -t "Sweep: <goal>" -i 60 -e 1 --note 'UNITS: 37 (rg -l ... | wc -l)'
   mu task add sweep_auth_ts -w <ws> -t "Sweep src/auth.ts" -i 50 -e 0.2
   mu task block sweep -w <ws> --by sweep_auth_ts
   ```

   Put the shared brief and acceptance criteria on the umbrella; each
   unit task's note holds only what differs.
3. **Cap concurrency** ([orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency)).
   Spawn at most one agent per ready track. Tell workers to avoid
   repo-wide commands so more can run.
4. **Pipeline.** Dispatch, wait `--first`, merge, dispatch the next unit
   to the freed worker with `--fresh`. Units that touch the same files
   go on one track (see [waves](waves.md)).
5. **Review per unit** when a wrong unit is costly: add a review task
   per unit ([adversarial-review](adversarial-review.md)).
6. **Synthesize** when the output is a report, not commits: one
   delegate call reads the unit notes (not transcripts) and writes one
   result into the umbrella's note.

Done when `mu task close sweep --if-ready` closes the umbrella: every
unit is closed, and the closed count matches the step 1 count.
