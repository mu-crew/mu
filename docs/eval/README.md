<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# Eval reports

Reports from the eval harness ([tools/eval/](../../tools/eval/README.md)).
Each names the commit it measured. Raw JSONL rows are not committed, except
each tournament group's control file.

| Report | What it measures |
| --- | --- |
| [every-harness.md](every-harness.md) | E1–E7 on claude, codex and pi orchestrators with mixed worker harnesses (template and live commands) |
| [hill-r2/](hill-r2/README.md) | the hill-r2 tournament: per-group results and what shipped |
| [eval-load.md](eval-load.md) | why each eval row runs under its own muzzle claim |

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
