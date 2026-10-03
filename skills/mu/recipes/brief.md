# Writing a brief

Use when you write anything a worker reads: a task note, a `--fresh`
prompt, a reviewer brief. The worker starts with no context. What is
not in the brief, or one pointer away, does not exist for it.

<!-- Ideas adapted from mattpocock/skills `writing-for-agents` (MIT). -->

## Rules

1. **End on a completion criterion.** The brief says how the worker
   tells done from not done, and the criterion is both checkable and
   exhaustive: "every file in the UNITS list compiles under
   `npm run typecheck`", not "update the call sites". A vague bound
   invites the worker to stop at the first plausible point.
2. **Inline what every path needs; point to the rest.** Files, the
   verify command, scope, and the final action go in the brief. Shared
   context goes in one place (an umbrella's note) and the brief points
   at it: `Read: mu task notes sweep -w audit`. Repeating it per task
   copies it into every worker's context and lets the copies drift.
3. **State the target, not the ban.** "Edit only files under
   `src/auth/`" works; "don't touch other files" puts other files in
   the worker's head. Keep a prohibition only for a hard guardrail
   with no positive form, and pair it with the positive target.
4. **Reuse the recipe words.** *Unit*, *stop rule*, *verdict*,
   *finding*, *umbrella* mean the same thing in every recipe. Use them
   as written; a worker that read one recipe brief reads the next
   faster.
5. **Cut the default.** A sentence the worker would obey anyway
   ("be careful", "write clean code") costs attention and changes
   nothing. Delete the whole sentence.
6. **Ask for evidence, not reassurance.** The final note names the
   commands run and their exit codes (the task note contract). "Done,
   all good" is not a result.

## Shape

```text
Task <id> in <ws>. Workspace: <path>.
Read: mu task notes <id> -w <ws>   (and the umbrella's, if any)

GOAL: <one sentence>
FILES: <paths it may change>
DONE WHEN: <checkable, exhaustive criterion>
VERIFY: <exact command>

⚠️ FINAL ACTION
git commit -am '<msg>' THEN
mu task close <id> -w <ws> --evidence '<command + result>'
```

Done when a worker with no other context could finish the task from
the brief and the notes it points at, and could tell when it is done.
