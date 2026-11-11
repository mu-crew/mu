<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# hill-r2: results

Round 2 of the mu CLI hill climb (spec [2026-11-07-hill-r2-tournament](../../specs/2026-11-07-hill-r2-tournament.md)). Six groups ran in fast mode on base `e6a907ef`, judged by weak models (claude-haiku-5-5, gemini-3.8-flash) and claude-sonnet-5-5.

| Group | Result | Shipped as | Report |
| --- | --- | --- | --- |
| C1 wait reading | winner `gemini31prop-v1-compact-text`, z 4.50 (threshold 2.47) | `mu wait --text` | [c1](c1.md) |
| C2 close apply | base stays (closest: loud-refusal z 1.91) | - | [c2](c2.md) |
| C3 notes output | winner `gemini31prop-c3_notes-report-flag`, z 4.74 (2.13) | `mu task notes --report` | [c3_notes](c3_notes.md) |
| C4 agent read | winner `claudeopus55b-read-text-flag`, z 3.51 (1.96) | `mu agent read/show --text` | [c4](c4.md) |
| C5 outcome wording | base stays (closest: v3-already-closed z 2.01 < 2.19) | - | [c5_outcome](c5_outcome.md) |
| C6 skill and recipes | winner `claudeopus55-wait-all`, z 6.53 (2.01) | SKILL.md `mu wait --all` rule | [c6](c6.md) |

Each winner landed as a reviewed unit. Review fixes changed behaviour the tournament did not measure (C1: task state, report or close evidence above `---`; C3: an `ok:false` envelope when no report exists; C4: the `--text` filter keeps every worker line). C6's text shipped as tested.

**Not run: the combined gate (C7).** R4 on the combined winners and the four holdouts were dropped by decision on 2026-11-11 to free the host. The per-group results are the only evidence: three winners are opt-in flags whose default output is unchanged; C6's SKILL.md change has no R4 run. In fast mode a group's false-win rate is about 0.15 at its threshold; every winner cleared its threshold by a wide margin. The C7 rig options (`final --combined --landed --each --scan-only`) are on branch `hill2/c7`, unmerged.

**Case validity:** C5's `delegate_no_verdict` scored 0 for every model and variant (0/1200 R1, 0/360 B5), so it cannot separate variants.

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
