# Tournament

Use when several answers are possible and the best is a judgement
call: a design, a name, an API shape, competing fixes, a ranking. Agents
compete on the same task; judges compare pairs. Comparing two is more
reliable than scoring one.

## Steps

1. **Write the rubric first**, on the umbrella: what good looks like,
   in a few ranked criteria. Judges apply it; they do not invent one.
2. **Generate.** N attempts with the same brief and a different
   approach or model each. Code attempts are tasks, each in its own
   workspace. Ideas (names, plans) are delegate calls; one call can
   generate many candidates.
3. **Filter** (when there are many candidates): one delegate call drops
   the ones that fail a hard rubric criterion and merges duplicates. What is left
   enters the bracket.
4. **Judge in pairs.** One [delegate call](tasks-or-calls.md#delegate-call) per comparison, a fresh agent
   each, so no judge holds the whole field
   ([tasks-or-calls](tasks-or-calls.md)). The judge sees the two
   candidates and the rubric and ends with `WINNER: <a|b> <reason>`.
   A judge decides a pair, not a task: no `record`. Record each round
   (pair, winner, reason) in the umbrella's note; winners meet in the
   next round. A round wider than the cap runs in batches
   ([orchestrator-loop § Concurrency](orchestrator-loop.md#concurrency)).
5. **Confirm the winner** with a final check against the rubric, then
   merge it. Free the losing workspaces.

Done when one candidate has won every comparison it entered and the
final check passed.

## Traps

- **Position bias.** Judges favour the first candidate shown. For close
  calls, judge the pair twice with the order swapped; a split decision
  goes to a third judge.
- **Same model, same taste.** Vary the attempt models, and judge with a
  model that made no attempt.
- **Ranking many items** (tickets by severity): bucket them in parallel,
  then run pairwise comparisons only within and across bucket edges.
