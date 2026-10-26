# Course-correct a long job

Use when a job has run a day or more, every ~10 merged units, or when a
dogfood run finds a bug that review missed. Stop dispatching, measure,
adjust the plan.

1. **When.** Daily, after ~10 merged units, or after a real-use bug
   that review missed.
2. **Measure from state, not memory.**
   - Commits per day by scope prefix:
     `git log --since=<date> --format='%ad %s' --date=short | cut -d: -f1 | sort | uniq -c`
   - Tasks created since the last check, by kind (units, reviews,
     re-review rounds, findings, triage):
     `mu db query -w <ws> "SELECT kind, substate, substr(local_id,1,7) AS p, count(*) AS n FROM tasks WHERE created_at > '<date>' GROUP BY 1,2,3"`
   - Findings by severity and gap kind: the same query grouped by
     the title's severity word.
   - Code lines against the baseline: `tokei src test`.
   - Open units against the plan:
     `mu task list -w <ws> --status OPEN --all --json`.
3. **Compare with the spec.** Find spec text a later decision made
   stale, critical-path units that could ship after the switch, and
   line budgets against actual growth.
4. **Propose at most ~7 changes, each tied to a number.** For
   example: a triage bar by severity, where mutation testing applies,
   a DAG split, dropping a unit, per-unit line budgets.
5. **The human approves.** Record the approved changes as one decision
   note on the umbrella, then show the DAG diff before dispatching more.
6. **Refute the numbers** with a delegate before acting on them.
