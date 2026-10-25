// A `mu task wait` is killed with SIGTERM mid-run (the harness's own timeout, a user abort). The
// orchestrator must come out knowing where things stand and carry on WITHOUT redoing work.
//
// Fixture: i1 (a worker task, 12s) and i2 (3s, so it is CLOSED when the SIGTERM lands). A private
// watcher (written to <bin>/eval-interrupter in setup, detached) finds the first mu process of THIS
// sandbox's AUT (no MU_AGENT_NAME) that has been running for 4s, whatever verb it runs, sends it
// SIGTERM once and logs "<ms> <pid> TERM <cmdline>" to <workers>/interrupt.log. Not SIGKILL: nothing
// can catch that. Setup code, not a judge: it keys on how long a call has been running.
//
// Judged from the DB, ops, runs.log, result.txt, the lifecycle record and the interrupted call's
// own output, never from the AUT's words:
//  - the interrupt really hit a blocked mu call of the AUT (interrupt.log, the shim's call record),
//    i1 and i2 each ran once in a worker and closed done, each worker was prompted once (the
//    workers' own prompt log: no re-dispatch), the AUT closed no task a worker earned, result.txt
//    quotes both workers' evidence and is written last, and after the interrupt the AUT read the
//    state through mu again and went on waiting for the open task;
//  - SNAPSHOT: what the interrupted call itself printed (the mu process's own output when it was
//    killed, else the AUT's wrapper output): a parseable, non-empty JSON snapshot with the REAL task
//    states and a resume command naming both refs. The wait itself printing it is the native
//    guarantee (3.x: empty output, N/A baseline; next: wrong). A wrapper that builds the snapshot
//    is a labelled manual workaround: its states must match the DB at the interrupt.
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
import { lastJson, native, prodWrong, snapshotStates } from "../lifecycle.ts";
import {
  claimCount,
  closeEarnedWrong,
  deliveries,
  muCalls,
  muOut,
  names,
  toolsOf,
  verdictFx,
} from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, fileMoment, orderWrong } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const IDS = ["i1", "i2"];

const INTERRUPTER = String.raw`#!/bin/bash
# SIGTERM the first mu process of the AUT in this sandbox that has run for 4s; log it. Whatever
# verb the process runs: a call that blocks that long is waiting.
D="$EVAL_SANDBOX"
for _ in $(seq 1 2400); do
  [ -d "$D" ] || exit 0
  for pid in $(pgrep -f 'dist/cli.js' 2>/dev/null); do
    grep -aq "MU_DB_PATH=$MU_DB_PATH" "/proc/$pid/environ" 2>/dev/null || continue
    grep -aq "MU_AGENT_NAME=" "/proc/$pid/environ" 2>/dev/null && continue
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    sleep 4
    if [ "$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)" = "$cmd" ]; then
      kill -TERM "$pid" && echo "$(date +%s%3N) $pid TERM $cmd" >> "$EVAL_WORKER_DIR/interrupt.log"
      exit 0
    fi
  done
  sleep 0.3
done
`;

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
    // the workers close their own tasks: a task closed by anyone else was a close nobody earned.
    for (const id of IDS) wrong.push(...closeEarnedWrong(sb, "eval", id, runs));
    // no re-dispatch: each worker was prompted once (the workers' own prompt log, however the
    // prompt was sent), and each task was claimed once.
    const ds = deliveries(sb);
    const byAgent = new Map<string, number>();
    for (const d of ds) byAgent.set(d.p.agent, (byAgent.get(d.p.agent) ?? 0) + 1);
    const dup = [...byAgent].filter(([, k]) => k > 1).map(([a]) => a);
    if (dup.length > 0)
      wrong.push(`re-sent work already in progress: ${dup.join(", ")} prompted more than once`);
    for (const id of IDS)
      if (claimCount(sb, "eval", id) !== 1)
        wrong.push(`${id} was claimed ${claimCount(sb, "eval", id)} times (want 1)`);
    // the call the SIGTERM landed in: the AUT's mu invocation that was killed (its own output is the
    // tee'd stdout), and the tool call that ran it (its output is what the AUT saw)
    const killedCall = muCalls(sb).find(
      (m) => hit > 0 && m.start <= hit && hit <= m.end + 2000 && m.exit >= 128,
    );
    const tool = killedCall
      ? toolsOf(run, killedCall).sort((a, b) => b.start - a.start)[0]
      : undefined;
    const call = tool?.call;
    if (hit > 0 && !killedCall) {
      completed = false;
      wrong.push("the SIGTERM did not land in a blocked mu call of the AUT (timing)");
    }
    if (killedCall && !call) {
      completed = false;
      wrong.push("the killed mu call is not inside any tool call of the AUT");
    }
    if (killedCall && call) {
      const own = muOut(sb, killedCall);
      // what the interrupted mu process itself printed (native), else what the AUT's wrapper printed
      const native_ = own.trim() !== "";
      const text = native_ ? own : call.output;
      const snap = lastJson(text);
      // real task states: each task's status in the snapshot must match the DB at the interrupt
      // (i2's 3s worker closed it before the SIGTERM; i1's 12s worker has not): a hard-coded echo
      // of plausible states is neither
      const st = snap ? snapshotStates(snap) : new Map<string, string>();
      const stateOk = IDS.every((id) => {
        const s = st.get(id) ?? "";
        const at = closeMoment(sb, "eval", id)?.ms ?? Number.POSITIVE_INFINITY;
        if (!/^[A-Z_]+$/.test(s)) return false;
        if (at <= hit) return s === "CLOSED";
        return at > hit + 1500 ? s !== "CLOSED" : true;
      });
      // a resume command that names both refs (any verb: it is data the AUT can run)
      const resume = /\bmu\b[^"'\n]*/.test(text) && IDS.every((id) => names(text, id));
      // the snapshot was produced by mu after the kill (a mu invocation inside the same tool call
      // started after the interrupt) or by the killed process itself; an echo has neither
      const readAfter = muCalls(sb).some(
        (m) =>
          m !== killedCall &&
          m.start >= hit - 50 &&
          toolsOf(run, m).some((t) => t.call.id === call.id),
      );
      const ok =
        snap !== null &&
        Object.keys(snap).length > 0 &&
        stateOk &&
        resume &&
        (native_ || readAfter);
      if (!native_ && !ok) {
        wrong.push(
          `the interrupted wrapper lost the state (no parseable snapshot with the real states of i1 and i2, read through mu after the kill, and a resume command): ${text.slice(0, 80)}`,
        );
      } else {
        const r = native(
          sb,
          "the interrupted wait itself prints a parseable snapshot + resume command",
          native_ && ok,
          native_
            ? `${own.length} bytes of its own output`
            : "built by the AUT's own wrapper, not by the wait",
        );
        wrong.push(...r.wrong);
        notes.push(...r.notes);
        na.push(...r.na);
      }
      // after the interrupt the AUT carried on: it read mu again and the open task was waited to the end
      const after = muCalls(sb).filter((m) => m.start > hit + 50);
      if (after.length === 0) {
        completed = false;
        wrong.push("the AUT never invoked mu after the interrupt");
      }
    }
    wrong.push(...prodWrong(run));
    return await verdictFx(sb, run, completed, {
      wrong,
      na,
      // the tool call the fixture interrupted ends with a signal exit (>= 128)
      expectFail: [
        {
          re: /./,
          why: "mu call SIGTERMed by the fixture",
          when: (c) => c.exitCode !== null && c.exitCode >= 128 && c.id === call?.id,
        },
      ],
      notes: [
        `interrupt=${killed.split(" ").slice(1, 3).join(" ")} prompts=${ds.length} muCalls=${run.muCalls}`,
        ...notes,
      ],
    });
  },
};

export default scenario;
