# Keep-driving nudge: one prompt when an orchestrator stops early

Status: shipped (unreleased). Implemented 2026-10-03; see [Deviations](#deviations-during-implementation)
Date: 2026-10-03

## Problem

An orchestrator dispatches workers, then ends its turn to print a
status summary while those workers are still running. Nothing happens
until the human notices and types "carry on". The crew sits idle for
as long as the human is away. This is the most common way a long run
stalls, and a rule in the skill alone has not stopped it.

`skills/mu/SKILL.md` § Orchestrator rules now states the rule ("While
workers run, keep driving"). The pi extension can back it up at the one
moment it matters: when the orchestrator is about to stop.

## Approach

When a pi session that dispatched mu work is about to settle, and that
work is still running, the extension injects **one** message quoting
the skill's rule, and asks pi to continue. The model then either goes
back to `mu task wait`, or ends the turn again with a reason. The
second stop is final: the nudge fires at most once per user prompt.

This is not a goal loop. It does not re-check, re-inject, or count
continuations. One reminder, then the model's judgement stands.

## Behaviour

1. **Arm.** During a run, the extension watches `tool_call` events for
   bash commands that dispatch mu work: `mu agent send`, `mu agent
   spawn`, or `mu task claim ... --for`. It records the workstreams
   they name (`-w`, `--workstream`, or a qualified `<ws>/<task>` ref),
   falling back to the default resolution (`$MU_SESSION`, tmux session).
   A run with no dispatch never arms. `mu_delegate` does not arm: its
   answers already arrive as follow-ups.
2. **Check.** On `agent_before_settle`, if armed and not yet fired for
   this prompt, run `mu state -w <ws...> --json` (about 1 s) and count
   `inProgress` tasks across those workstreams. Zero means the work is
   done or parked: let the turn end.
3. **Nudge.** Otherwise return one `custom_message` entry
   (`customType: "mu-keep-driving"`, `display: true`) and
   `continue: true`. The text is the skill paragraph verbatim, followed
   by the live count and the wait command:

   ```text
   [mu] <the skill paragraph>

   3 tasks IN_PROGRESS in auth. Next: mu task wait -w auth --first --on-stall exit
   ```

4. **Record.** Write `mu log -w <ws> --kind nudge 'keep-driving: 3 in
   progress'` so the push is visible in the activity log, next to the
   orchestrator's own entries.
5. **Reset.** The fired flag and the armed set clear on the next
   `input` event, i.e. the next human (or mu-sent) prompt.

`outcome: "aborted"` or `"error"` never nudges: the human pressed Esc,
or the run failed, and both should stop.

## Single source for the text

The paragraph lives in `SKILL.md` between
`<!-- mu:keep-driving -->` and `<!-- /mu:keep-driving -->`. The
extension reads it from the package's skill at load time. A test
asserts the markers exist and the extracted text is non-empty, so
editing the skill edits the nudge, and deleting the markers fails the
gate rather than silently sending nothing.

## Opt-out

`MU_NUDGE=0` disables it. `mu doctor` reports it next to `MU_DELEGATE`.

## Fit with the pillars

- **The CLI is the product.** The nudge adds no state and no logic the
  CLI lacks: its only data is `mu state --json`, and its only write is
  `mu log`. Without the extension, the same rule is in the skill. Like
  `mu_delegate`'s follow-up callback, it is harness glue, not a feature.
- **One DB is canonical.** The armed set and fired flag are per-prompt
  scratch, never persisted. Losing them loses one reminder.
- **Nothing hidden.** The message is displayed in the transcript and
  logged in the DB.
- **ROADMAP.** No daemon, watcher, or loop: one hook, one check, one
  message. Estimated under 150 LOC plus tests.

## Key decisions

| # | Decision | Why |
|---|---|---|
| D1 | At most once per user prompt. | A loop overrides the model's judgement on real human decisions; one reminder corrects the common mistake and then defers. |
| D2 | Arm only on observed dispatch. | A session that never dispatched is not orchestrating; nudging it would be noise. |
| D3 | Gate on `inProgress > 0`, not ready tasks. | Ready-but-unclaimed work may be waiting on the human's go-ahead. Running workers are the clear case. |
| D4 | Quote the skill paragraph, read at load. | One source of truth; the model sees the exact rule it was taught. |
| D5 | `agent_before_settle` + `continue: true`, not `sendUserMessage`. | The boundary hook is pi's designed point for one continuation, and the entry is a visible custom message, not fake user input. |
| D6 | Log every nudge with `--kind nudge`. | The push is part of the run's record; `mu log --kind nudge` shows how often orchestrators stop early. |

## Out of scope

- A worker that stops without closing its task. Same shape (check
  `mu me` for an owned IN_PROGRESS task, nudge once), but a separate
  decision.
- Non-pi harnesses. They get the skill rule only.
- Any repeat, backoff, or goal condition.

## Test plan

- Unit, with a fake pi API (as `delegate.ts` tests do):
  - no dispatch in the run → no nudge;
  - dispatch + `inProgress: 0` → no nudge;
  - dispatch + `inProgress: 2` → one entry, `continue: true`, one
    `mu log` call;
  - a second settle in the same prompt → no nudge;
  - a new `input` event → armed again;
  - `outcome: "aborted"` → no nudge;
  - `MU_NUDGE=0` → no nudge.
- Marker test: `SKILL.md` contains the markers; extracted text matches
  the paragraph.
- Manual: real orchestrator session, dispatch two workers, ask for a
  status summary; confirm one `[mu]` message, the model resumes
  waiting, and `mu log --kind nudge` shows the entry.

## Deviations during implementation

- **Wait hint names tasks.** `mu task wait` takes task ids, so the
  message lists up to eight `<ws>/<task>` refs and counts the rest,
  instead of a `-w <ws>` form that does not exist.
- **Both `mu state --json` shapes.** One `-w` prints a bare card; several
  print `{ workstreams: [...] }`. The unit tests first mocked only the
  second; the live run used the first and stayed silent. Both are read
  and tested now.
- **`scratch` never arms.** Dispatches into the reserved delegate
  workstream are `mu_delegate`'s, whose answers return as follow-ups.
- **The check runs once per prompt even when it fails.** A failing
  `mu state` does not retry on the next settle.

Live verification: a real pi orchestrator against a throwaway DB
claimed a task for a worker, ended its turn, received one
`[mu-keep-driving]` message with `mu task wait nudgeprobe/slow ...`, and
`mu log --kind nudge` held one entry. With nothing IN_PROGRESS, no
nudge fired.
