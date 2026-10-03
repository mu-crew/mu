# Rules audit

Use when the repo's written rules (`AGENTS.md`, contributing guides,
style docs) are not being followed, or when the same correction keeps
coming up in review and is not written down. One agent checking a diff
against twenty rules skips some; one checker per rule does not.

Two modes. **Check** asks "does this change follow our rules?".
**Mine** asks "which rules are we missing?".

## Check: a change against the rules

1. **List the rules.** A scout extracts every checkable rule from the
   rule files into the umbrella's note, one per line with its source:

   ```text
   RULE: r7 AGENTS.md:52 "Throw typed error classes, not bare Error"
   ```

   Skip rules no diff can show (team habits, meeting norms). Record the
   count.
2. **Pin the target**: the diff, branch, or PR, as in
   [review-panel](review-panel.md) step 1.
3. **One checker task per rule.** The checker gets one rule and the
   diff, and reports each violation with file:line and the rule id, or
   `r7: no violations` with what it looked at. One rule per checker
   keeps it from skimming.
4. **A skeptic pass** over the flags: one fresh agent reads each flagged
   line and the rule, and drops false positives (the rule does not
   apply here, the code already complies, the rule has a stated
   exception). Ending: `VERDICT: <flag> CONFIRMED | DROPPED <reason>`.
5. **Report or fix** confirmed violations, as in review-panel step 5.

Done when every rule from step 1 has a checker result, and every flag
has a skeptic verdict.

## Mine: rules you keep stating but never wrote

1. **Collect corrections.** Sources, any that exist: review comments
   on merged PRs, `REJECT` notes from [adversarial-review](adversarial-review.md)
   tasks, and past agent sessions (with a session archive such as
   [museum](https://github.com/mu-crew/museum), search for user turns
   that correct the agent: "no, use", "don't", "we always"). One reader
   task per source batch writes each correction as one line:

   ```text
   CORRECTION: k12 <source ref> "use the shared retry helper instead of a hand-rolled loop"
   ```

2. **Cluster** the corrections in one task: the same lesson in
   different words is one cluster. Keep clusters with at least two
   corrections from different occasions; a one-off is not a rule.
3. **Refute each candidate rule** with a fresh agent: would it have
   prevented the real mistakes in its cluster? Does it contradict an
   existing rule? Is it already enforced by a linter or test (then it
   needs no prose)? Ending: `VERDICT: <rule> KEEP | DROP <reason>`.
4. **Propose, don't commit.** Write the surviving rules as a diff to
   the rule file, worded per [brief](brief.md) (positive, specific,
   with the reason), each citing its cluster. A rule file change is a
   human decision: park the umbrella with the diff in its note.

Done when every cluster has a verdict and the proposal lists each kept
rule with the corrections behind it.

## Traps

- **A rule a tool can check belongs in the tool.** If a linter, type,
  or test can catch it, propose that instead of prose.
- **Mined rules overfit.** Two corrections in one week about one file
  may be about that file, not a rule. The refute step asks.
