# scenarios

One `<id>.ts` per scenario, default-exporting a `Scenario` (copy `_smoke.ts`; underscore ids need `--include-underscore`). `setup` builds the sandbox with `fixtures.ts`; `judge` reads end state through `probe.ts` and returns `verdict(run, completed, extra)` from `score.ts`.

Each scenario ships two faux AUT scripts per surface family: `<id>.golden.3x.json` completes it with no wrong or destructive entry (declare expected failures with `expectFail`), and `<id>.bad.3x.json` makes its characteristic mistake and must be flagged. `main.ts check` runs both without model tokens. Prompts name goals and ids, never mu verbs or flags.
