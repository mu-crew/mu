# Course-correct a long job

On `course check due` or a request.

1. **A read-only `mu_delegate` (else a native subagent) measures**:

   ```bash
   git log --since=<date> --format=%s | cut -d: -f1 | sort | uniq -c
   mu db query -w <ws> "SELECT CASE WHEN instr(local_id,'_')>0 THEN substr(local_id,1,instr(local_id,'_')-1) ELSE local_id END AS prefix, status, substate, count(*) AS n, sum(local_id GLOB '*_[2-9]') AS rounds FROM tasks t JOIN workstreams w ON w.id=t.workstream_id AND w.name='<ws>' WHERE t.created_at>'<date>' GROUP BY 1,2,3"
   mu db query -w <ws> "SELECT lower(substr(title,1,instr(title,':')-1)) AS severity, status, count(*) AS n FROM tasks t JOIN workstreams w ON w.id=t.workstream_id AND w.name='<ws>' WHERE t.created_at>'<date>' AND severity IN ('critical','high','medium','low') GROUP BY 1,2"
   tokei src
   mu task tree <umbrella> -w <ws>
   ```

2. **A second refutes the numbers.** Dispatch nothing until both answer.
3. **Compare with the spec**:
   - Switch line: critical-path units movable after it.
   - Review cost: rounds per unit, findings by severity (high: fix + re-review; medium: fix + evidence; low: one batch).
   - Code budget: `src/` vs baseline; units >30% over.
   - Real use: what dogfood found that review missed.
   - Merge latency: gate+CI vs queue.
4. **Propose ≤7 changes**, each tied to a number.
5. **Apply** in-plan ones (DAG edges, order, merge batching, briefs, habits). One umbrella note starting `COURSE CHECK <date>` (the hint counts from it) lists all and the DAG diff.
6. **Escalate** scope, spend or goal changes, irreversible or external steps, judgment calls: `mu human-needed -w <ws> "course check: see note"` (`--no-stop` if nothing waits). Else dispatch.
