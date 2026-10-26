---
description: "Review panel with mu: parallel focused reviewers, refuted findings, one report"
argument-hint: "[diff, PR, branch, or path]"
---
Run a review panel with mu. Load the mu skill, then read its
`recipes/findings.md` in full. One reviewer call per angle on the target,
duplicates merged, each finding refuted before it is reported.

Target: ${@:-the uncommitted changes in this repo}
