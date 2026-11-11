# Models

Use when you spawn, delegate or check. Pick model and effort per role.

Take ids from the harness you spawn, latest version only. A family is a lab.

Tiers frontier/strong/mid/cheap, as of 2026-11-11:

- **anthropic**: fable/opus/sonnet/haiku
- **openai**: astra/sol/terra/luna
- **google**: carbon/argon/flash/flash-lite (no Pro: the latest Flash beats it)
- **meta**: none/wonder/spark/ember (prefer wonder full)
- **one family each**, mid: grok, composer, kimi, deepseek, glm, mistral large, qwen max; cheap: glm flash, mistral small, qwen flash
- **local**: qwen

Work to tier:

- scouts, watchers, first-pass finders: cheap; mid or strong where a miss is costly
- building, routine fixes: mid
- design, plans, root cause, synthesis: strong
- review, refute, judge, audit: the author's tier or higher, another family; with one family, the same model, fresh context, higher effort
- a strong attempt failed; a close final call: frontier, else the strongest unused family

Higher effort is not another family. A local model never checks.

**Speed.** Smaller models answer faster. High effort is no default: as of 2026-11-11 it can multiply run time. Use medium; high for design, root cause and review; low for scouts and mechanical edits. When someone waits, pick the fastest good-enough pair.

**Passing it.** `mu agent spawn` passes `--model <id>` through the harness's own flag (`--cli codex --model <id>`). pi: `<provider>/<id>:<effort>` from `pi --list-models`, effort `off|minimal|low|medium|high|xhigh|max`; `mu_delegate`'s `model` likewise. No model: cli default. A native subagent takes its harness's names. herdr picks the binary: omit the model (`mu_delegate` is refused, spawn ignores it).
