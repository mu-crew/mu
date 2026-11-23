# Models

Pick model and effort per role when you spawn, delegate or check.

From the harness's list (`pi --list-models`) take the highest version and default-context id per tier (larger window only if needed); no `-preview`/`-exp` unless alone, no `-latest` aliases. A missing tier steps to the family's next tier (family = lab), never an older version.

Tiers (frontier/strong/mid/cheap) as of 2026-11-23: **anthropic** fable/opus/sonnet/haiku; **openai** astra/sol/terra/luna; **google** carbon/neon/hydrogen/flash; **meta** none/wonder/spark/ember (prefer wonder full); **local** qwen. **One family each**, mid: grok, composer, kimi, deepseek, glm, mistral large, qwen max; cheap: glm flash, mistral small, qwen flash.

Work to tier:

- scouts, watchers, first-pass finders: cheap; mid or strong if a miss costs
- building, routine fixes: mid
- design, plans, root cause, synthesis: strong
- review, refute, judge, audit: the author's tier or higher, another family; one family: same model, fresh context, higher effort
- a strong attempt failed, or a close final call: frontier, else the strongest unused family

Higher effort is not another family. Local models never check.

**Speed.** Smaller is faster; high effort can multiply run time (as of 2026-11-11). Use medium; high for design, root cause and review; low for scouts and mechanical edits. If someone waits, take the fastest good-enough pair.

**Passing it.** `mu agent spawn` `--model <id>` passes it to the harness's own flag. pi: `<provider>/<id>:<effort>`, effort `off|minimal|low|medium|high|xhigh|max`; `mu_delegate`'s `model` likewise. No model: cli default; a native subagent uses its harness's names. herdr picks the binary: omit the model (`mu_delegate` refused, spawn ignores it).
