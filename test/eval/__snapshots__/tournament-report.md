<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# hill-r2 tournament: c1_wait

## 1. Setup

- Base: `abc123` built at `/surfaces/base`
- Models: weak claude-haiku-5-5, gemini-3.8-flash; gate claude-sonnet-5-5; provider ext -; systemSha sys
- B0: claude-haiku-5-5 ok, gemini-3.8-flash ok, claude-sonnet-5-5 ok
- Queue seed: seed; holdouts worker_dies, wait_receipt_race, wrong_id, single_channel_host (not run, not read)
- judgesHash: `j1` (checks green)

| case | ρ̂ claude-haiku-5-5 | ρ̂ gemini-3.8-flash | ρ̂ claude-sonnet-5-5 | ρ̂_pool |
|---|---|---|---|---|
| c1 | 0.20 | 0.20 | 0.20 | 0.20 |

n plan:

| case | kind | paraphrases | m | r | n_eff per model | pooled n_eff | MDE | reached |
|---|---|---|---|---|---|---|---|---|
| c1 | own | 10 | 30 | 3 | 64 | 90 | 0.77 | yes |
| g13 | guard | 6 | 12 | 8 | 40 | - | 0.48 | yes |

### Error rates and power (at the frozen plan)

- Own headline cases: per-model n_eff 64, pooled weak-model n_eff 90.
- Win power (pooled Fisher, 0.5 → 0.8, α 0.05/2): 0.99 on the weakest own case.
- CMH loss power per model at the planned per-case n_eff (α 0.05/3, cold-guess stratum not counted): 0.8→0.7 0.27, 0.8→0.75 0.07.
- R4 loss power per model (Fisher, 0.8 → 0.5, α 0.05/3; 48 runs wanted): k = 1: n 48, 0.80.
- **False wins are controlled per group, not across groups.** Each group lands a false R2 win with probability at most 0.05; over the 6 groups the chance of at least one false winner in the combined surface is up to 1 − 0.95^6 = 0.26. The holdouts are a no-regression check only: they cannot catch a false win.
- **End-to-end power.** A real 0.5 → 0.8 fix must survive a false loss in R1 (≤ 0.1), R2 (≤ 0.1) and R4 (≤ 0.05) and win R2: (1 − 0.1)·(1 − 0.1)·(1 − 0.05)·0.99 ≈ 0.76. The R1 cut and the holdout gate are not counted, so this is an upper bound.

Designer sessions:

- opus (claude-opus-5-5): clean

Row dir: `<tmp>/rows/c1_wait`

| file | sha256 |
|---|---|
| r4.jsonl | ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356 |
| tournament.jsonl | 3db1375d58a09b1bb6cc60b88809074418a0a958e7f5ebd3faa1b8b887e9ee2e |

## 2. Variants

### v1

- variant v1 (kind output; session opus)
- markers: `the worker's result follows below`, `read the result block first`; context: `wait returned; read the notes`
- behaviour: names --text; calls agent close|--if
- text delta 12; admission ok; goldenCompat clean

<details><summary>patch</summary>

```diff
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-a
+b
```

</details>

## 3. R1 / R2

### R1

not run

### R2

S = 2

#### v1

| case | claude-haiku-5-5 | gemini-3.8-flash | claude-sonnet-5-5 | exposed clusters | win p (threshold) | result |
|---|---|---|---|---|---|---|
| c1 | 70/90 (n_eff 64, p 0.990, Holm 1.000) | 70/90 (n_eff 64, p 0.990, Holm 1.000) | 70/90 (n_eff 64, p 0.990, Holm 1.000) | 30 | 1.0e-4 (0.008) | win |

CMH per model: claude-haiku-5-5 z 1.20 p 0.880; gemini-3.8-flash z 1.20 p 0.880; claude-sonnet-5-5 z 1.20 p 0.880

Keys: R1 score 0.00, wins 1, win z 4.10, exposed weak hits 140, mean tokens 900, text delta 12; eliminated: no

Cut: ranking v1; eligible v1; advance 1: v1

## 4. R3 scan

| scenario | v1 |
|---|---|
| course_check | yes (marker); R4 |

## 5. R4

| scenario | model | surface | completed | exposed | wrong | muErrors | destructive (attributable / new / noted) |
|---|---|---|---|---|---|---|---|
| course_check | claude-sonnet-5-5 | base | 13/16 | 0 | 0 | 1 | 0 / 0 / 0 |
| course_check | claude-sonnet-5-5 | v1 | 13/16 | 16 | 0 | 1 | 0 / 0 / 0 |

- v1 (1 scenarios × 48 reps): claude-sonnet-5-5 40/48 vs base 39/48, p 0.700, Holm 1.000; exercised yes; mean cost 5000; passes
- base mean cost 5100, spread (max − min of per-rep totals) 700

## 6. Review stops and decisions

```json
{"kind":"review_stop","id":"rs-1","variant":"v1","cell":"c1/h","entries":["sql-write: x"],"transcript":"t.jsonl","source":"probe"}
{"kind":"review_decision","stop":"rs-1","decision":"continue","why":"line 4: the AUT's own verification"}
```

## 7. Decision

**winner: v1**: v1 passes R4 with 1 R2 win(s) (z 4.10)

## 8. Spend

| round | epoch | tokens per model | wall |
|---|---|---|---|
| r4 | 0 | claude-sonnet-5-5 120000 | 2.0 h |

<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
