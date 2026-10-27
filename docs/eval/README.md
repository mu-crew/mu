# Eval reports

The evidence behind the 4.0 release: how the 4.0 surface compares with
3.13.3 on the eval harness ([tools/eval/](../../tools/eval/README.md)),
and what isolated dogfood runs found. Each report names the commit it
measured. The raw JSONL rows are not in the tree; see
[history](../history/README.md#raw-eval-runs).

| Report | What it measured |
| --- | --- |
| [baseline-3.13.3.md](baseline-3.13.3.md), [baseline-3.13.3-v2.md](baseline-3.13.3-v2.md) | 3.13.3 on the scenarios, before and after the harness fixes (v2 supersedes v1) |
| [matrix-pre-settle.md](matrix-pre-settle.md) | first full 4.0 vs 3.13.3 matrix |
| [matrix-release.md](matrix-release.md) | the release-gate matrix and its gate re-run |
| [cold-guess.md](cold-guess.md) | one-command guesses from help text alone, no skill |
| [dogfood-1.md](dogfood-1.md) … [dogfood-4.md](dogfood-4.md), [dogfood-switch.md](dogfood-switch.md), [dogfood-full.md](dogfood-full.md) | isolated orchestrator runs on the checkout |
| [harnesses.md](harnesses.md) | mu driven from codex and cursor-agent |
