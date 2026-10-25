# Models

Use when you pick a model. mu passes it through.

Rank a model within its own family; the id prefix in `pi --list-models` names the family, the provider column often does not. 

| Tier | Position | Examples (2026-10) |
| --- | --- | --- |
| frontier | above the flagship | fable |
| strong | the flagship | opus |
| mid | everyday default | sonnet |
| cheap | small, fast, hosted | haiku, flash |
| local | on this machine | qwen |

| Work | Tier |
| --- | --- |
| scouts, watchers, first-pass finders | cheap |
| building, routine fixes | mid |
| design, plans, root cause, synthesis | strong |
| review, refute, judge, audit | the author's or higher |
| a strong attempt failed; a close final call | frontier, else the strongest unused family |

A cheap finder's misses stay missed: use mid or strong where omission is costly. Effort is no other family. A local model never checks.

**Checkers** must not share the author's blind spots: the author's tier or higher, another family when one exists; else the same model, fresh context, higher effort.

**Passing it.** `mu_delegate`: `model: "<provider>/<id>:<effort>"`. Spawn: `--command "pi --model <provider>/<id>:<effort>"`. Effort: `off|minimal|low|medium|high|xhigh|max`. Copy `<provider>/<id>` from `pi --list-models`. No `model`: the cli default. herdr refuses a command override.
