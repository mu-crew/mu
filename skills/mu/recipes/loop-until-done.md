# Loop until done

Use when the amount of work is unknown: fix type errors until clean,
find flaky tests until none are new, search until nothing new turns up.
A fixed number of passes stops too early or runs too long; a stop rule
written down first does neither.

## Steps

1. **Write the stop rule** on the umbrella before the first round. It
   names a command and a condition, plus a no-progress rule:

   ```text
   STOP: `npx tsc --noEmit` exits 0
   NO-PROGRESS: two rounds in a row reduce the error count by zero
   ```

2. **Each round is a task** that blocks the umbrella and is blocked by
   the previous round:
   `round_1`, `round_2`, .... Add the next round only when the current
   one closes; never pre-create rounds. Dispatch each per
   [orchestrator-loop](orchestrator-loop.md); multi-hour loops follow
   [long-run](long-run.md).
3. **Each round ends with its measurement** in the note:
   `MEASURE: 14 errors (was 31)`, or `NEW: 0 flaky tests`.
4. **After each round, check the rule** yourself, from the measurement
   command, not from the worker's note.
   - Rule met: `mu task close <umbrella> --if-ready --evidence '<stop
     command + result>'` (each round blocks the umbrella).
   - No progress: stop the loop and decide. Change the approach, split
     the work, or park the umbrella with
     `mu task park <umbrella> --why '<what is stuck>'` and tell the human.
   - Otherwise: add the next round and dispatch it.

Done when the stop rule holds on the merged tree, run by you.

## Traps

- **A round that only reports is not progress.** Each round must change
  something (fix, new search slice) or produce a new measurement.
- **Moving goalposts.** Edit the stop rule only with a note saying why;
  the old rule stays in the history.
