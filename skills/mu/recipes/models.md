# Models

Use when you pick a model. mu passes it through.

Take ids from the harness you spawn, latest version only (opus 5.5, not opus 4.8). Rank within a family, named by the model, not the provider.

Tiers as of 2026-11-11 (anthropic, openai, google, meta):

- **frontier**, above the flagship: fable, astra, carbon
- **strong**, the flagship: opus, sol, argon, wonder (prefer wonder full where offered)
- **mid**, everyday default: sonnet, terra, flash, spark
- **cheap**, small and hosted: haiku, luna, flash-lite, ember
- **local**: qwen

Gemini Pro has no tier: the latest Flash beats the last Pro, for less.

Work to tier:

- scouts, watchers, first-pass finders: cheap
- building, routine fixes: mid
- design, plans, root cause, synthesis: strong
- review, refute, judge, audit: the author's tier or higher, another family; with one family, the same model, fresh context, higher effort
- a strong attempt failed; a close final call: frontier, else the strongest unused family

A cheap finder's misses stay missed: use mid or strong where omission is costly. Higher effort is not another family. A local model never checks.

**Passing it.** `mu agent spawn` passes `--model <id>` through the harness's own flag (`--cli codex --model <id>`). pi: `<provider>/<id>:<effort>`, effort `off|minimal|low|medium|high|xhigh|max`; `mu_delegate` takes the same as `model`. No model: the cli default. A native subagent takes its harness's names. herdr refuses `--command`: it picks the binary.
