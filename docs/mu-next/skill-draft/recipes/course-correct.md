# Course-correct a long job

Use when a human asks, a job has run a day, or ~10 units merged since the last `COURSE CHECK` note.

1. **A read-only `mu_delegate` measures** (fresh context judges fairer):

   ```bash
   git log --since=<date> --format=%s | cut -d: -f1 | sort | uniq -c
   mu db query "SELECT CASE WHEN instr(local_id,'_')>0 THEN substr(local_id,1,instr(local_id,'_')-1) ELSE local_id END AS prefix, status, substate, count(*) AS n, sum(local_id GLOB '*_[2-9]') AS rounds FROM tasks t JOIN workstreams w ON w.id=t.workstream_id AND w.name='<ws>' WHERE t.created_at>'<date>' GROUP BY 1,2,3"
   mu db query "SELECT lower(substr(title,1,instr(title,':')-1)) AS severity, status, count(*) AS n FROM tasks t JOIN workstreams w ON w.id=t.workstream_id AND w.name='<ws>' WHERE t.created_at>'<date>' AND severity IN ('critical','high','medium','low') GROUP BY 1,2"
   tokei src
   mu task tree <umbrella> -w <ws>
   ```

2. **A second delegate refutes the numbers** before any proposal.
3. **Compare with the spec**: stale text, and:
   - Switch line: which open critical-path units can move after the switch?
   - Review cost: rounds per unit, findings by severity. Bar: high = fix + re-review; medium = fix, evidence in the close note; low = one batch.
   - Code budget: `src/` vs baseline; units >30% over budget.
   - Real use: last dogfood date; what it found that review missed.
4. **Propose at most 7 changes**, each tied to a number.
5. **Stop**: `mu human-needed -w <ws> "course check: <n> proposed changes, see note"`: settle ends a turn only there.
6. **Approved**: one umbrella note starting `COURSE CHECK <date>`, the DAG diff, dispatch.
