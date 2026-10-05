# Long runs

Use when a task or proof runs for hours, crosses context compaction,
or may hit flakes.

1. **Define done first.** Before dispatch, write the completion criterion
   into the task note: the checks, how many runs must agree, the
   allowed variance. A worker that finds the bar in the note stops at
   the bar, not at the first green. For chained batches (sweeps,
   campaigns, soaks) it also names the **inputs** each batch runs on
   (build sha, oracle commit, config) and when to refresh them
   ("rebuild from main before each batch"); each batch report states
   the inputs it used, and the stop rule counts only batches on
   current inputs.
2. **Split into independent units** ([fan-out](fan-out.md)). Shard a long proof into tasks
   that run in parallel, so one flake restarts only its unit. Each unit
   carries its own criterion.
3. **Keep state in the DB.** Progress lives in task notes, not in the
   orchestrator's context. After a compaction, `mu state` and
   `mu task notes <id>` are the whole picture.
4. **Bound each tool call** to minutes: batches of ≤10 minutes,
   `mu task wait --timeout` re-issued, no open-ended `sleep` loops.
   A `--steer` lands only when the running tool returns.
5. **Accept evidence, not close notes**
   ([orchestrator-loop § Merging](orchestrator-loop.md#merging)), and
   run a [drift-audit](drift-audit.md) after each batch report and
   every few hours.

Done when every unit is `CLOSED/done` and the criterion from step 1
holds on the merged tree.
