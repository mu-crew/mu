---
description: "Loop with mu until a check is clean (tsc, lint, tests), with a stop rule written first"
argument-hint: "<stop rule, e.g. npx tsc --noEmit exits 0>"
---
Loop with mu until this holds. Load the mu skill, then read its
`recipes/orchestrator-loop.md` in full. Write the stop rule and a
no-progress rule on the umbrella first; one task per round; you run the
check.

Stop rule: $@
