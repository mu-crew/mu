// A `mu task wait` is killed with SIGTERM mid-run (the harness's own timeout, a user abort). The
// orchestrator must come out knowing where things stand and carry on WITHOUT redoing work.
//
// Fixture: i1 (a worker task, 12s) and i2 (3s, so it is CLOSED when the SIGTERM lands). A private watcher (written to <bin>/eval-interrupter
// in setup, detached) finds the first `cli.js [task|agent] wait` process of THIS sandbox, waits 5s, sends
// it SIGTERM once and logs "<ms> <pid> TERM <cmdline>" to <workers>/interrupt.log. Not SIGKILL:
// nothing can catch that.
//
// Judged from the DB, ops, runs.log, result.txt, the lifecycle record and the interrupted call's
// own output, never from the AUT's words:
//  - the interrupt really hit a wait of the AUT (interrupt.log), i1 and i2 each ran once in a worker
//    and closed done, `agent send` ran once per worker (no re-dispatch), the AUT closed no task itself, result.txt quotes both workers' evidence and is written last;
//  - SNAPSHOT: the call the SIGTERM landed in printed a parseable, non-empty JSON snapshot with
//    the task states and a resume command. Direct (bare) `mu ... wait`: on 3.x the output is empty
//    (native N/A baseline); on next an empty/unparseable snapshot is wrong. A shell wrapper that
//    builds the snapshot itself is a labelled manual workaround: it must really contain one.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateScript,
  makeRepo,
  nonce,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import {
  commandOf,
  isWaitCall,
  lastJson,
  native,
  prodWrong,
  snapshotStates,
  waitWindows,
} from "../lifecycle.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, fileMoment, orderWrong } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const IDS = ["i1", "i2"];

const INTERRUPTER = String.raw`#!/bin/bash
# SIGTERM the first "cli.js [task|agent] wait" process of this sandbox, 5s after it appears; log it.
D="$EVAL_SANDBOX"
for _ in $(seq 1 2400); do
  [ -d "$D" ] || exit 0
  for pid in $(pgrep -f 'cli.js (task |agent )?wait ' 2>/dev/null); do
    grep -aq "MU_DB_PATH=$MU_DB_PATH" "/proc/$pid/environ" 2>/dev/null || continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    sleep 5
    if [ "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" = "$cmd" ]; then
      kill -TERM "$pid" && echo "$(date +%s%3N) $pid TERM $cmd" >> "$EVAL_WORKER_DIR/interrupt.log"
    else
      echo "$(date +%s%3N) $pid MISSED $cmd" >> "$EVAL_WORKER_DIR/interrupt.log"
    fi
    exit 0
  done
  sleep 0.5
done
`;

const BARE = /^\s*mu\s+(?:(?:task|agent)\s+)?wait\b[^;&|$`<>]*$/;

const scenario: Scenario = {
  id: "wait_interrupted",
  title: "a wait is SIGTERMed mid-run: recover the state, resume, redo nothing",
  prompt:
    "Workstream eval has worker tasks i1 (slow) and i2. Get both done by pi workers (one worker each), waiting for them with mu, and then write result.txt in the repo root with one line per task quoting the evidence the worker closed it with. Your wait call may be killed by the environment while it runs; if a call is killed, work out where things stand and carry on without redoing or re-sending anything already in progress. Work until it is done; do not ask me questions.",
  timeoutMs: 600_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...IDS.map((t) => [
        "task",
        "add",
        t,
        "-w",
        "eval",
        "-t",
        `work ${t}`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]),
    ]);
    await workerTask(sb, "i1", { sh: "sleep 12; echo ok" });
    await workerTask(sb, "i2", { sh: "sleep 3; echo ok" });
    writeFileSync(join(sb.binDir, "eval-interrupter"), INTERRUPTER, { mode: 0o755 });
    spawn(join(sb.binDir, "eval-interrupter"), [], {
      cwd: sb.repoDir,
      env: { ...sb.env, EVAL_SANDBOX: sb.dir },
      stdio: "ignore",
      detached: true,
    }).unref();
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n = await nonce(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    const notes: string[] = [];
    const na: string[] = [];
    let completed = true;
    let killed = "";
    try {
      killed = readFileSync(join(sb.workerDir, "interrupt.log"), "utf8").trim();
    } catch {
      // never fired
    }
    const hit = / TERM /.test(killed) ? Number(killed.split(" ")[0]) : 0;
    if (hit === 0) {
      completed = false;
      wrong.push(`fixture: the SIGTERM never reached a wait (${killed || "no interrupt.log"})`);
    }
    const result = await sh(sb, "cat result.txt", { allowFail: true });
    let lastRun = 0;
    let lastClose = 0;
    for (const id of IDS) {
      const t = probe.task("eval", id);
      const rs = runs.filter(
        (r) => r.task === id && (r.action === "close" || r.action === "block"),
      );
      const r = rs[0];
      if (rs.length !== 1) wrong.push(`${id}: ${rs.length} worker run(s) to completion (want 1)`);
      if (r) lastRun = Math.max(lastRun, r.ts);
      const close = closeMoment(sb, "eval", id);
      lastClose = Math.max(lastClose, close?.ms ?? 0);
      const done = t?.status === "CLOSED" && t.substate === "done";
      const quoted = new RegExp(`${id}\\.sh exit 0 run=${n}`).test(result.stdout);
      if (!quoted) wrong.push(`result.txt lacks ${id}'s worker evidence (run=${n})`);
      if (!(done && rs.length === 1 && quoted)) completed = false;
    }
    const file = fileMoment(join(sb.repoDir, "result.txt"));
    if (file && completed)
      wrong.push(
        ...orderWrong(
          { label: "both workers finished", ms: Math.max(lastRun, lastClose) },
          file,
          "result.txt must be written last",
        ),
      );
    // the workers close their own tasks: an AUT `task close` is a close nobody earned.
    for (const c of run.toolCalls) {
      if (/\bmu\s+task\s+close\b/.test(commandOf(c)))
        wrong.push(`the AUT closed a task itself: ${commandOf(c).slice(0, 80)}`);
    }
    // no re-dispatch: one `agent send` per worker, one claim per task.
    const sends = run.toolCalls
      .filter((c) => !c.isError)
      .flatMap((c) => commandOf(c).match(/\bagent\s+send\s+\S+/g) ?? []);
    const dup = sends.filter((s, i) => sends.indexOf(s) !== i);
    if (dup.length > 0)
      wrong.push(`re-sent work already in progress: ${[...new Set(dup)].join(", ")}`);
    // the call the SIGTERM landed in
    const ws = waitWindows(run).filter((w) => hit > 0 && w.start <= hit && hit <= w.end + 2000);
    const call = ws[0]?.call;
    if (hit > 0 && !call) {
      completed = false;
      wrong.push("the SIGTERM did not land in any wait call of the AUT (timing)");
    }
    if (call) {
      const snap = lastJson(call.output);
      const text = call.output;
      // real task states: each task's status in the snapshot must match the DB at the interrupt
      // (i2's 3s worker closed it before the SIGTERM; i1's 12s worker has not), and the command
      // must itself read mu state after the kill (an unquoted `mu task list|show` / wait call): a
      // hard-coded echo of plausible states is neither.
      const st = snap ? snapshotStates(snap) : new Map<string, string>();
      const stateOk = IDS.every((id) => {
        const s = st.get(id) ?? "";
        const at = closeMoment(sb, "eval", id)?.ms ?? Number.POSITIVE_INFINITY;
        if (!/^[A-Z_]+$/.test(s)) return false;
        if (at <= hit) return s === "CLOSED";
        return at > hit + 1500 ? s !== "CLOSED" : true;
      });
      const reads = /\bmu\s+(?:task\s+(?:list|show|notes)|(?:task\s+|agent\s+)?wait)\b/.test(
        commandOf(call).replace(/'[^']*'/g, "''"),
      );
      const resume = /\bmu\s+(?:(?:task|agent)\s+)?wait\b[^"'\n]*\bi1\b[^"'\n]*\bi2\b/.test(text);
      const bare = BARE.test(commandOf(call)) && isWaitCall(call);
      const ok =
        snap !== null && Object.keys(snap).length > 0 && stateOk && resume && (reads || bare);
      // A bare wait must print the snapshot itself. A wrapper that builds it is a manual workaround:
      // right on state (checked above), but never the guarantee: N/A on 3.x, wrong on next.
      if (!bare && !ok) {
        wrong.push(
          `the interrupted wrapper lost the state (no parseable snapshot with the real states of i1 and i2 and a resume wait command): ${text.slice(0, 80)}`,
        );
      } else {
        const r = native(
          sb,
          "direct wait prints a parseable snapshot + resume command on SIGTERM",
          bare && ok,
          bare
            ? `${text.length} bytes of output`
            : "built by the AUT's own wrapper, not by the wait",
        );
        wrong.push(...r.wrong);
        notes.push(...r.notes);
        na.push(...r.na);
      }
    }
    wrong.push(...prodWrong(run));
    return verdict(run, completed, {
      wrong,
      na,
      expectFail: [{ re: /^143 .*\bwait\b/, why: "wait SIGTERMed by the fixture" }],
      notes: [
        `interrupt=${killed.split(" ").slice(1, 3).join(" ")} sends=${sends.length} muCalls=${run.muCalls}`,
        ...notes,
      ],
    });
  },
};

export default scenario;
