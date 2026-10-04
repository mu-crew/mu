# Long runs

Use when a task or proof runs for hours, crosses context compaction,
or may hit flakes.

1. **Define done first.** Before dispatch, write the completion criterion
   into the task note: the checks, how many runs must agree, the
   allowed variance. A worker that finds the bar in the note stops at
   the bar, not at the first green.
2. **Split into independent units** ([fan-out](fan-out.md)). Shard a long proof into tasks
   that run in parallel, so one flake restarts only its unit. Each unit
   carries its own criterion.
3. **Keep state in the DB.** Progress lives in task notes, not in the
   orchestrator's context. After a compaction, `mu state` and
   `mu task notes <id>` are the whole picture.
4. **Accept evidence, not close notes**
   ([orchestrator-loop § Merging](orchestrator-loop.md#merging)).

Done when every unit is `CLOSED/done` and the criterion from step 1
holds on the merged tree.
