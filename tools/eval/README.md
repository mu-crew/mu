# eval harness

Black-box rig: a surface is a directory with a built mu, mu runs as a subprocess, and workers are scripted faux pis. Only the AUT (agent under test) costs money. Imports nothing from `src/` or `extension/`.

- Prepare a surface: `node tools/eval/main.ts prepare 3x v3.13.3` (exports the ref into `~/.cache/mu/eval/surfaces/3x`, then `npm ci && npm run build`).
- Selftest, zero cost (faux model): `npm run build && node tools/eval/main.ts selftest [--surface <dir>]`.
- One scenario: `run` arrives with the scenario tasks. A scenario is a `Scenario` in `scenarios/<id>.ts`; `runAut(sandbox, scenario, opts)` runs it.
- Faux steps: `{calls}`, `{text}`, `{error}`, `{die}`, `{textFromLastResult}` (see `faux-steps.ts`).
- Provenance (`provenance.ts`): judges prove who did the work and in what order, not just the end state. `runs.log` lines are `<ms> <agent> <task> <action> <sha|-> <patch-id|-> <cwd>`; main's commit must be that worker's sha (or a cherry-pick with its patch-id), remote steps need a run under `<hostRoot>/home`, and order comes from ops/runs/hook timestamps.
