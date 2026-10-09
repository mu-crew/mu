# Deep research

Use when a question needs more sources than one context can read and
checking them against each other: how a library or protocol behaves,
what changed between versions, how competitors solve a problem, whether
a claim in a draft holds. This is [refute](refute.md) applied to
sources. Workers need a web search tool (pi's `brave_search`, or
`curl` on docs) or the code they research.

**Mode:** delegates by default: the report is the result, and claims
need no permanent record. Use a workstream for a long run that must
survive compaction or feeds a tracked decision; then each claim the
answer rests on is an `OPEN/triage` task, decided like a finding
([findings](findings.md)).

## Steps

1. **Write the question and the bar**, into every searcher's brief
   (delegate mode) or on an umbrella task (workstream mode): the exact
   question, what a good answer contains (a recommendation, a
   comparison table, a yes/no with conditions), and how fresh sources
   must be.
2. **Split by angle**, one searcher per angle (delegates; tasks only in
   workstream mode): official docs,
   changelogs and release notes, issue trackers, independent write-ups,
   the code itself. Each searcher reads, fetches, and writes claims to
   its note, one per line:

   ```text
   CLAIM: c4 "Node 22 enables the permission model by default" SOURCE: <url> QUOTE: "<exact words>"
   ```

   A claim without a source and a quote is not a claim. Searchers can
   run cheap (hosted, not local: [models](models.md#local-models-are-a-last-resort));
   the checkers in step 4 run mid or higher.
3. **Dedupe claims**: merge the same fact from several sources (keep
   every source), and flag claims that contradict each other. In
   workstream mode, each surviving claim becomes an `OPEN/triage` task
   titled with the claim, its sources and quotes in the note.
4. **One checker per claim** that the answer depends on, as a
   [delegate call](tasks-or-calls.md#delegate-call) in both modes. The checker
   gets the claim and its sources, not the searcher's reasoning, fetches
   the source itself, and tries to break the claim: is the quote there,
   does it say that, is it current, does another source disagree? It
   ends with the VERDICT block
   ([tasks-or-calls § Delegate call](tasks-or-calls.md#delegate-call)).
   For contradicted claims, one checker per side. Batch under the cap
   ([orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency)).
   In workstream mode the checker passes `record` on the claim task, and
   the verdict is decided as in [findings § Triage](findings.md#triage)
   step 3.
5. **Synthesize** once every checker has answered (in workstream mode,
   when no claim task is left undecided): answer the question
   from confirmed claims only, each with its source URL. List
   unverified claims separately. Note what the sources disagree on and
   which side the evidence favours.

Done when every claim the answer uses has a `CONFIRMED` verdict line,
every sentence of fact in the report cites a URL, and the report meets
the bar from step 1.

## Traps

- **A fetch failure is UNVERIFIED, not REFUTED.** Rate limits and
  paywalls block checkers; say so, do not drop the claim silently.
- **Secondary sources copy each other.** Three blog posts repeating one
  changelog are one source. Prefer the primary source in the dedupe.
- **Version drift.** A claim true for v2 can be false for v3. Checkers
  confirm the version the question asks about.
