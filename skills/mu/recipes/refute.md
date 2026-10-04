# Find, refute, synthesize

Use for audits, bug sweeps, and fact-checks: anything that produces
findings. Finders over-report; a separate agent told to kill each
finding filters what survives. Where findings live and how triage works
is [findings](findings.md); this recipe is the search around it. Builds
on [fan-out](fan-out.md).

**Mode:** workstream by default (an audit feeds fixes). For a quick
fact-check nobody will track, use delegate mode from
[findings](findings.md) and skip the tasks.

## Steps

1. **Pin the scope** on an umbrella task: what is searched, and what
   counts as a finding.
2. **Split the search** into slices (security, data integrity, one
   module each). One finder task per slice. Finders read; they do not
   fix.
3. **Finders record findings** as `OPEN/triage` tasks blocking the
   umbrella, one per finding, severity first in the title, file:line and
   evidence in the note ([findings § Record](findings.md#record)). A
   finder with more than 5 writes `FINDING:` lines in its own note
   instead; the triage step turns them into tasks.
4. **Refute each finding** with a [delegate call](tasks-or-calls.md#delegate-call), not a task
   ([tasks-or-calls](tasks-or-calls.md)). The refuter gets the finding
   and the code, not the finder's reasoning, and tries to prove it
   false: run it, find the guard, read the caller. Its answer ends with
   `VERDICT: CONFIRMED | REFUTED | UNVERIFIED <evidence>`. You record it
   on the finding ([findings § Triage](findings.md#triage)): accept, or
   close `--as rejected --why '<evidence>'`. For high-severity
   findings, run three refuters and accept only if most fail to kill it.
5. **Report** from the graph: accepted findings are the result, ranked
   by impact; `mu task list --substate rejected` is what was refuted.
   A synthesis task is needed only when the human wants prose.

Done when no finding is left in triage without an `UNVERIFIED` note,
and the umbrella closes with `--if-ready` once the accepted findings
are fixed or handed off.

## Traps

- **UNVERIFIED is not REFUTED.** A refuter that hit a rate limit or
  could not run the code disproved nothing. The finding stays in triage
  with an `UNVERIFIED:` note, reported apart.
- **Cheap finders, strong refuters.** Finders can run on `pi_mini`; the
  refute step is where the judgement is (`pi_big`).
- **No findings is a result.** A slice that finds nothing closes with
  that in its note; do not re-run it until it finds something.
