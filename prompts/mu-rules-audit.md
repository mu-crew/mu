---
description: "Rules audit with mu: check a change against AGENTS.md rule by rule, a checker per rule"
argument-hint: "[diff, PR, branch, or path]"
---
Run a rules audit with mu. Load the mu skill, then read its
`recipes/findings.md` in full. One checker call per AGENTS.md rule, then a
skeptic pass; each violation is a finding.

Target: ${@:-the uncommitted changes in this repo}
