# Deep research

Use when a question needs more sources than one context can read and
checking them against each other: how a library or protocol behaves,
what changed between versions, how competitors solve a problem, whether
a claim in a draft holds. This is [refute](refute.md) applied to
sources. Workers need a web search tool (pi's `brave_search`, or
`curl` on docs) or the code they research.

## Steps

1. **Write the question and the bar** on an umbrella task: the exact
   question, what a good answer contains (a recommendation, a
   comparison table, a yes/no with conditions), and how fresh sources
   must be.
2. **Split by angle**, one search task per angle: official docs,
   changelogs and release notes, issue trackers, independent write-ups,
   the code itself. Each searcher reads, fetches, and writes claims to
   its note, one per line:

   ```text
   CLAIM: c4 "Node 22 enables the permission model by default" SOURCE: <url> QUOTE: "<exact words>"
   ```

   A claim without a source and a quote is not a claim. Searchers can
   run on a cheap model.
3. **Dedupe claims** in one task: merge the same fact from several
   sources (keep every source), and flag claims that contradict each
   other.
4. **One check task per claim** that the answer depends on. The checker
   gets the claim and its sources, not the searcher's reasoning, fetches
   the source itself, and tries to break the claim: is the quote there,
   does it say that, is it current, does another source disagree? It
   ends with `VERDICT: c4 CONFIRMED | REFUTED | UNVERIFIED <evidence>`.
   For contradicted claims, one checker per side.
5. **Synthesize** in a task blocked by every check: answer the question
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
