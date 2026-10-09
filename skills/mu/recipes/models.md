# Model tiers

Read when you pick a model for a spawn or a delegate call. mu passes the
model through and never picks one; the choice is yours. Recipes name a
tier (cheap, mid, strong, frontier) and say which one their roles need;
this file says how to tell a model's tier.

## Tiers

Rank a model within its own family. The model-id prefix in
`pi --list-models` (`anthropic/`, `openai/`, `google/`) names the family
when it names a lab; the provider column is often one shared gateway, so
it does not tell families apart.

| Tier | Where it sits in its family | Names as of 2026-10 |
| --- | --- | --- |
| **frontier** | an exceptional tier above the lab's normal flagship, priced well above it, often gated | fable, astra |
| **strong** | the lab's normal flagship | opus, sol |
| **mid** | the everyday default | sonnet, terra |
| **cheap** | the lab's small, fast hosted model | haiku, luna, flash, mini, nano, lite |
| **local** | runs on this machine (ollama, lmstudio, llama.cpp) | qwen, gemma, gpt-oss |

Names go stale within months; the position in the family does not. Rank
a model you cannot place by the lab's own description of its lineup
(flagship, balanced, fast). `pi --list-models` shows context and max
output, not price or quality, and siblings often share both. Still
unsure: run it on a small slice of the real work and compare it with a
model you can place. Until then, pick conservatively: a model you know
is strong enough for the work, and for a checker never one that might
sit below the author.

Thinking effort strengthens a model within its tier. It does not change
the tier, and it does not stand in for another family.

## Local models are a last resort

A hosted cheap model beats a small local one at agent work: tool calls,
long briefs, multi-step edits. Small local models lose the thread of a
brief and fake tool results; in `pi --list-models` they tend to show
thinking `no` and small context and output limits. Use one only when no
hosted model is available, or the work must stay on the machine, and
then only for cheap-tier work whose output something stronger checks. A
local model never reviews, refutes or judges.

## Roles

| Work | Tier |
| --- | --- |
| fan-out scouting (listing units), claim lookups against a cited source, watchers, first-pass finders | cheap |
| building, refactoring, tests, routine fixes | mid |
| review, refute, judge, audit, synthesize | the tier of whoever wrote the thing being checked, or higher; another family when one exists |
| design, plans, incidents, root cause, final synthesis of a large run | strong |
| a strong attempt failed, or the final judge of a close call | frontier; none available: the strongest model, from a family not yet used on the job |

Cheap work suits bounded tasks whose output can be checked: a searcher's
claim carries a quote a checker verifies. A cheap finder's misses stay
missed, since refuters only test what was reported. When an omission is
costly (a security audit, a coverage sweep), run the finders mid or
strong, or add a second finder from another family.

## Checkers

A checker (reviewer, refuter, judge, auditor) must not share the
author's blind spots. The author is whoever wrote the thing being
checked: the worker for a diff, the planner for a brief, the finder for
a finding.

- **Level or up.** At least the author's tier; never down.
- **Another family when one exists**, at that tier. One model's blind
  spot repeated is still one blind spot.
- **No peer in another family**: the same model, fresh context, higher
  thinking unless at max.

A delegate with no `model` runs the cli's configured default, which is
your own model only if you are on that default. When the tier or family
matters, pass `model`.

## How to pass a model and effort level

pi takes both in one `--model` value: `<provider/id>:<level>`, where the
thinking (effort) level is one of `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`. Leave `:<level>` off to keep the model's default.

- `mu_delegate`: `model: "anthropic/claude-sonnet-5-5:high"`.
- Spawn: `mu agent spawn r -w <ws> --command "pi --model anthropic/claude-sonnet-5-5:high"`.
- A `cli` key (`--cli pi_big`) works only if `$MU_<KEY>_COMMAND` is set
  in the environment; check before you rely on one.
- herdr refuses a command override, so neither model nor level can be
  set per agent there: every helper runs the cli's default. The only
  independence left is fresh context; say so in the verdict.

Probe a model you have not used this session
(`pi --model <id> -p "say ok"`); `ctl: ok` after spawn does not test the
model.
