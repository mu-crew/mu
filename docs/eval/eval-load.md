<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->

# Eval rig host load (f_eval_muzzle, 2026-11-08)

On 2026-11-08 at about 18:10 the mac (16 cores) reached load ~250 while C2's eval runs were going, and the user killed perl and bash processes by hand. This page records why the rig's own guard did not hold, what replaced it, and the measurements behind the per-row weights in `tools/eval/claim.ts`.

## Why the load gate did not hold

The only guard was in `runNext` (`tools/eval/nextstep.ts:529` at 321c56c0): `while (loadavg()[0] > maxLoad) await sleep(2000)` before each probe row.

- It covered probe rows only. R3/R4/final AUT runs (`tournament-r4.ts:211`), matrix runs (`commands.ts:506`), cold-guess guesses (`cold-guess.ts:551`, which `tournament r2` runs after its probe rows at concurrency 8) and designer sessions had no gate.
- It read the 1-min load average, which lags by about a minute. After a quiet minute all 24 workers (`tournament r1|r2` default `--concurrency 24`) passed the check together, and nothing slowed a row that had already started.
- `nextstep run` defaulted to `maxLoad` = 1.5 × cores = 24 (`main.ts:362`), above the core count. `tournament r1|r2` used 14.
- Each rig process gated on its own. Two agents' runs both passed the same check, and muzzle saw each run as a single 3-slot `mu-eval` claim (`~/.config/muzzle/config.toml`) while it fanned out to 24 sandboxes.

The load-average gate is removed (`--max-load` is gone). muzzle now accounts for every row (below).

Another source showed up during this work. From 18:41 to 20:00 the host sat at load 250 to 330 with no eval running: vtmux `worker-107`'s `/tmp/w107/manyt.sh` ran `stress_test.sh`, which starts about 160 unclaimed `perl -e '…1 while 1' 120` busy loops per burst. The "perl processes" in the incident may have included these. The rig's shim clock runs `perl -MTime::HiRes` for a few milliseconds, not in a busy loop.

## Per-row claims

Every unit of AUT work holds its own claim while it runs: `muzzle run --rule mu-eval-<kind> --slots <w> -- sh -c 'echo admitted; exec cat >/dev/null'`. The row starts when the holder prints `admitted`, and it releases the claim by closing the holder's stdin. If the rig dies, the pipe closes and the slots are freed. `--concurrency` is capped to `floor(budget / w)`.

| mode | when | per-row claim | rows at once |
|---|---|---|---|
| claim | muzzle on PATH, rig unclaimed | yes, w slots each | min(`--concurrency`, floor(budget / w)) |
| nested | `MUZZLE_SLOTS` set: the rig runs inside a claim (the `mu-eval` rule, pi's muzzle extension) | no: a nested `muzzle run` claims nothing (D17) | min(`--concurrency`, max(1, floor(MUZZLE_SLOTS / w))) |
| unmanaged | no muzzle | no | min(`--concurrency`, floor((1.5 × cores − 2) / w)) |

Recommended: run the rig unclaimed so each row claims on its own. With today's config, pi's muzzle extension wraps `node tools/eval/main.ts` in the 3-slot `mu-eval` claim, so the rig is nested. That is safe but slow: 3 probe rows or 1 AUT run at a time.

## Weights

Measured one row at a time with scripted models (`check` / `evalfaux`), on the mac at load under 20 (`/tmp/measure.py`: wall time, rusage of the rig's waited descendants plus the sampled CPU time of its sandboxes' tmux trees, and live processes sampled every 0.2 s). Short-lived processes in the tmux trees are missed, so CPU is a lower bound.

| row kind | sample | rows | wall | CPU-s | CPU-s / row | avg cores | peak procs | w |
|---|---|---|---|---|---|---|---|---|
| probe | `nextstep check --cases close_preview_apply` | 12 | 113 s (202 s under load) | 73-75 | 6.2 | 0.37-0.65 | 16 | 1 |
| guess | `cold-guess check`, 4 intents | 12 | 30 s | 18.1 | 1.5 | 0.60 | 15 | 1 |
| AUT run | `check --scenarios course_check` | 4 | 82 s | 45.7 | 11.4 | 0.56 | 24 | 2 |
| AUT run | `check --scenarios delegate_saturation` | 6 | 262 s | 208.7 | 34.8 | 0.80 | 29 | 2 |
| model call | one `pi -p` (haiku) | 1 | 2.1 s | 0.9 | 0.9 | 0.44 | 4 | (inside the row) |

w = ceil(1.5 × average cores), the same rule as muzzle's `report` suggestion (1.5 slots per core). A real model adds about 1 CPU-s per call plus a wait, so a live row's average is lower than the scripted one. A designer session is one pi that may run a build, so it gets w = 2. `EVAL_ROW_SLOTS_<KIND>` overrides any of them.

## The mu shim

The sandbox's `mu` wrapper (`muShim`, `tools/eval/sandbox.ts`) ran for every mu call. On macOS (`/bin/bash` 3.2; BSD `date` has no `%N`) an AUT call took 4 `date` + `perl` clocks and fingerprinted 6 machine-local tables twice, each with `sqlite3 .dump | cksum | cut`. Now one `sqlite3` call before mu and one after each read the clock and a `sha3_query` hash per table (`fpSql`: the table's `sqlite_master` rows, then its rows, which is what `.dump` covers). A worker's call reads the clock from `EPOCHREALTIME` on bash 5, and otherwise from a `sqlite3 :memory:` call. The `tee -p` probe runs once per rig process, and argv is flattened with bash's own substitution.

Processes per mu call (a fake mu that prints a line, macOS). Exec'd programs were counted with PATH wrappers. Totals add the subshell forks, counted from the script.

| call | before: exec'd | before: total | after: exec'd | after: total |
|---|---|---|---|---|
| AUT | 49 (12 sqlite3, 12 cksum, 12 cut, 4 date, 4 perl, 2 tee, node, tr, mkdir) | 69 | 4 (2 sqlite3, node, tee) | 4 |
| worker | 6 (2 date, 2 perl, node, tr) | 11 | 3 (2 sqlite3, node); 1 on bash 5 | 3; 1 on bash 5 |

20 AUT calls took 7.16 s wall and 4.23 CPU-s before, and 2.11 s and 0.98 CPU-s after. A worker's 20 calls went from 2.27 s to 1.46 s. Judges are unchanged: `mu-local.log` keeps the `<pid>|<table>:<hash>,…|…` shape (only equality is read), and `mu-shim.log` / `mu-calls.log` keep theirs. In a `check` probe row the AUT makes few mu calls, so the row's CPU barely moved (73 vs 75 CPU-s for 12 rows). The saving lands where a model makes many calls.

## The 40-row run

`nextstep run --surface base=.:next --model evalfaux/golden --model evalfaux/bad --cases wait_heartbeat_merge --arms none,skill --concurrency 2` (40 rows planned) ran in claim mode with `muzzle status` and the load sampled every 5 s. SAFETY capped it at concurrency 2, not the default 6. The run stopped at 28 of 40 rows: 16 of 16 golden rows hit, 0 of 12 bad rows hit.

- `muzzle status` showed 2 `mu-eval-probe` holders, 2 slots in all (concurrency 2 × w 1), in 441 of 444 samples. The other 3 samples came before the first admission.
- Load in the clean window (20:45:30 to 20:51, no vtmux burners running): 65 samples, mean 12.3, max 19.3. Earlier peaks (95 in the first part, 167 at 20:42) match vtmux worker-107's busy-loop bursts (`perl_burners=16` in the sampler).
<!-- RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig. -->
