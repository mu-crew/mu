# eval harness

Black-box rig: a surface is a directory with a built mu, mu runs as a subprocess, and workers are scripted faux pis. Only the AUT (agent under test) costs money. Imports nothing from `src/` or `extension/`.

- Prepare a surface: `node tools/eval/main.ts prepare 3x v3.13.3` (exports the ref into `~/.cache/mu/eval/surfaces/3x`, then `npm ci && npm run build`).
- Selftest, zero cost (faux model): `npm run build && node tools/eval/main.ts selftest [--surface <dir>]`.
- One scenario: `run` arrives with the scenario tasks. A scenario is a `Scenario` in `scenarios/<id>.ts`; `runAut(sandbox, scenario, opts)` runs it.
- Faux steps: `{calls}`, `{text}`, `{error}`, `{die}`, `{textFromLastResult}` (see `faux-steps.ts`).
- Provenance (`provenance.ts`): judges prove who did the work and in what order, not just the end state. `runs.log` lines are `<ms> <agent> <task> <action> <sha|-> <patch-id|-> <cwd>`; main's commit must be that worker's sha (or a cherry-pick with its patch-id), remote steps need a run under `<hostRoot>/home`, and order comes from ops/runs/hook timestamps.

## Surface family and candidate scenario roots

A `--surface <spec>` is `<dir|name>[:<3x|next>[:<scenario-root>]]`. A bare name is a built surface under `~/.cache/mu/eval/surfaces`; `check`, `run` and `matrix` all resolve it the same way. Family and root belong to the surface, so one matrix can pair a baseline with candidates. `--family` and `--scenario-root` only fill specs that leave them out; the defaults are `3x` and `tools/eval/scenarios`. Results and run logs key on a surface id, `<name>:<family>:<hash of dir+root>`, so one built dir under two specs stays two report rows; `matrix` refuses the same spec twice.

- The family is exactly `3x` or `next`. The sandbox sets `EVAL_SURFACE_FAMILY` from it, and `writeWorkerDriver` reads it: workers close with the verb on `3x` and print the `CLOSE:` block on `next` (an explicit `closeMode` wins). The judges do not change with the family.
- A scenario root holds `<id>.golden.<family>.json`, `<id>.bad.<family>.json`, `<id>.bad-<x>.<family>.json`, and optional `<id>.ts` overrides (which import `../../fixtures.ts`). An id missing from the root falls back to the default scenario. It must not be inside the surfaces cache (`prepare` deletes there). Keep candidate roots under `tools/eval/candidates/<decision>-<a|b|c>/` (gitignored).

```bash
R=tools/eval/candidates/dec-a
node tools/eval/main.ts check --surface "$PWD" --scenarios _smoke --include-underscore          # 3x, default root
node tools/eval/main.ts check --surface dec-a --family next --scenario-root $R                 # cached name
node tools/eval/main.ts matrix --surface 3x --surface "dec-a:next:$R" \
  --model haiku-5-5 --model sonnet-5-5 --scenarios delegate_saturation --out results.jsonl
```

## Native guarantees and N/A

A guarantee only a candidate can give (mid-wait delivery, a snapshot printed by the wait itself, one wait verb, receipts) goes through `lifecycle.native()`. Missed on the 3x family it becomes `Verdict.na` (never a pass, never a wrong entry); missed on `next` it is wrong. `score.verdict` turns `na` into `N/A baseline 3.x:` notes plus a `manual workaround` note, `check` marks the golden `(manual workaround: n N/A native)`, and `report` shows an N/A column plus a legend line per scenario. A Completed on such a row is a manual workaround, not the guarantee.

Fault injectors for waiting scenarios live in the worker driver, keyed by task: `errorOnce` (API outage, task stays IN_PROGRESS), `dieOnce` (the pane dies), `loseOnce` (the prompt is delivered and silently dropped: the worker does nothing, runs.log records `lost`). A judge reads the injected faults from runs.log, never from the AUT's words. `ssh-shim` logs the opener's `TMUX_PANE` in `sessions.log`, so a judge can tell a pane's ssh session from an AUT tool call's.
