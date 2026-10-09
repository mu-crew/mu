# Planning a DAG

Use when you turn a spec or a clear set of requirements into tasks.
The DAG is the plan: each task's note carries its full content, and
`mu state` is the progress tracker. Write a markdown plan only when the
human asks for a file.

## Steps

1. **Map the files first.** List what gets created or changed and what
   each file is responsible for. Task boundaries fall out of this map.
2. **Size the tasks.** A task is the smallest unit that carries its own
   verification and is worth a review. Split only where a reviewer
   could reject one task and accept its neighbour. Fold setup, config,
   and docs into the task whose deliverable needs them.
3. **Write the root task.** `task_0` holds the goal, the architecture
   in two or three sentences, and the global constraints copied
   verbatim from the spec. Every other task is blocked by it; close it
   at once. It carries notes, not work.
4. **Write each task's note** as a [brief](brief.md): its Shape, plus
   INTERFACES and STEPS:

   ```text
   GOAL:       one sentence
   DONE WHEN:  checkable, exhaustive criterion
   FILES:      Create/Modify/Test with exact paths (line ranges if known)
   INTERFACES: Consumes: <exact signatures from earlier tasks>
               Produces: <exact names and types later tasks use>
   STEPS:      one action each; code steps carry the code
   VERIFY:     <exact command and expected result>
   ```

   The worker sees only its own task. INTERFACES is how it learns the
   names its neighbours use.
5. **No placeholders.** "TBD", "add error handling", "similar to
   task 3", "write tests for the above": each is a missing decision the
   worker will make alone. Write the actual content; tasks are read out
   of order.
6. **Add edges for dependencies only.** `mu task block A --by B` when A
   consumes what B produces. Plan order is not a dependency: an extra
   edge serialises tracks that could run in parallel. The exception:
   tasks that edit the same files share a track ([waves](waves.md)).
7. **Self-review before dispatch.** Map each spec requirement to its
   task, grep the notes for placeholders, match INTERFACES names across
   tasks, and read the graph back (`mu task tree task_0 -w <ws> --down`).
   Then refute each brief that makes claims ([call](tasks-or-calls.md#delegate-call),
   all in one turn, at your tier from another family: [models](models.md#checkers)): "What in this brief is false about the code,
   ambiguous, or would make a correct worker fail review? Cite
   file:line." Rewrite each AMEND. Five of six briefs refuted in one run had
   such a defect, e.g. a fallback test old extensions made unpassable.

Done when every spec requirement maps to a task, no note holds a
placeholder, every claim-making brief has a verdict, and `mu state`
shows the intended parallel tracks. Then dispatch per [orchestrator-loop](orchestrator-loop.md).

## Notes

- `impact` comes from what breaks without the task; `effort_days` from
  its step count. Guess honestly rather than defaulting to 50 and 1.
- Review gates follow [adversarial-review](adversarial-review.md): a
  review task blocked by the work.
- When reality disagrees with the plan, append a note saying so. Do not
  rewrite earlier notes.
