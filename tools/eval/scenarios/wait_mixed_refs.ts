// Waiting on a mix of refs: an already-CLOSED task, a worker's task, a task and an agent that
// share a name (`gate`), a non-pi pane's output, a worker that closes before the wait is
// registered, an unknown ref, and a wait whose exit status goes through a pipe.
//
// Fixture: mx-fast is CLOSED at setup (evidence carries the run nonce); mx-slow (7s), gate (task, 10s)
// and mx-race (instant) are worker tasks; `gate-cmd` (in PATH) is a non-pi pane command that
// prints GATE-READY-<nonce> after 4s and stays up. The AUT writes wait-report.txt:
//   fast: <mx-fast's close evidence>      ready: GATE-READY-<nonce> read from the PANE named gate
//   slow: <mx-slow's worker evidence>     gate: <the TASK gate's worker evidence>
//   race: <mx-race's worker evidence>     timeout-exit: <mu's own exit status of a 2s wait on mx-slow>
// Every value is derivable only from the real task/pane (nonce), so the judge compares the file to
// the fixture truth plus the DB, runs.log and the call record, never to the AUT's claims:
//  - each line right; report written after the workers finished; the unknown-ref call failed fast
//    (< 5s, not a hang); `timeout-exit` is 5, not the pipe's status; no worker task closed by the AUT;
//  - each ref class was really waited on: a successful wait call naming mx-fast (CLOSED already, answers
//    at once), mx-race (issued after its worker was sent: the settle races the registration) and the
//    TASK gate (with mx-slow), whose output shows the ref CLOSED and which returned only after that
//    ref's worker run finished; a `sleep N` (N >= 3) is never a stand-in for a wait;
//  - NATIVE (family-aware): one wait verb for task+agent refs (a single `mu wait` call naming both),
//    mu's exit status embedded in the output (visible through a pipe), authoritative until-text /
//    until-idle conditions. 3.x has none (separate task/agent verbs, status lost in a pipe): N/A
//    baseline, and the goldens show the manual workaround (polling `agent read`, PIPESTATUS).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateScript,
  makeRepo,
  nonce,
  runsLog,
  sandboxFamily,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import {
  commandOf,
  isWaitCall,
  native,
  prodWrong,
  waitedClosed,
  waitWindows,
} from "../lifecycle.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, fileMoment, orderWrong } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const POLL_STATE = /\bmu\s+(?:task\s+(?:show|list|notes|next|ready)|agent\s+(?:list|show))\b/;
const POLL_ANY = /\bmu\s+(?:task\s+(?:show|list|notes|next|ready)|agent\s+(?:list|show|read))\b/;
const WORKERS = ["mx-slow", "gate", "mx-race"];

const scenario: Scenario = {
  id: "wait_mixed_refs",
  title: "wait on a mix of task, agent and pane refs, closed-already, raced and piped",
  prompt:
    "Workstream eval has: task mx-fast (already closed), worker tasks mx-slow, gate and mx-race (each needs a pi worker; use one worker per task, any names), and a non-pi build pane you must start with `mu agent spawn gate -w eval --command gate-cmd` (that agent is named gate, like the task gate; it prints a GATE-READY-<id> line when its build is ready). Wait with mu (do not sleep-poll in loops of your own if a mu wait can do it) and write wait-report.txt in the repo root with exactly these six lines: `fast: <the evidence mx-fast was closed with>`, `ready: <the GATE-READY-<id> line printed by the gate PANE>`, `slow: <evidence the worker closed mx-slow with>`, `gate: <evidence the worker closed the TASK gate with>`, `race: <evidence the worker closed mx-race with>`, and `timeout-exit: <the exit status mu itself returned for `mu task wait mx-slow -w eval --timeout 2 | tail -5` run right after you started mx-slow>`. Also check what mu says when asked to wait for the ref nosuch-ref. Work until it is done; do not ask me questions.",
  timeoutMs: 600_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    const n = await nonce(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...["mx-fast", ...WORKERS].map((t) => [
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
      ["task", "close", "mx-fast", "-w", "eval", "--evidence", `preclosed run=${n}`],
    ]);
    await workerTask(sb, "mx-slow", { sh: "sleep 7; echo ok" });
    await workerTask(sb, "gate", { sh: "sleep 10; echo ok" });
    await workerTask(sb, "mx-race", { sh: "echo ok" });
    writeFileSync(
      join(sb.binDir, "gate-cmd"),
      `#!/bin/sh\nsleep 4\necho GATE-READY-${n}\nsleep 600\n`,
      { mode: 0o755 },
    );
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n = await nonce(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    const report = (await sh(sb, "cat wait-report.txt", { allowFail: true })).stdout;
    const line = (k: string): string | undefined =>
      report
        .split("\n")
        .find((l) => l.startsWith(`${k}:`))
        ?.slice(k.length + 1)
        .trim();
    const want: Record<string, RegExp> = {
      fast: new RegExp(`preclosed run=${n}`),
      ready: new RegExp(`^GATE-READY-${n}$`),
      slow: new RegExp(`mx-slow\\.sh exit 0 run=${n}`),
      gate: new RegExp(`gate\\.sh exit 0 run=${n}`),
      race: new RegExp(`mx-race\\.sh exit 0 run=${n}`),
      "timeout-exit": /^5$/,
    };
    let completed = true;
    for (const [k, re] of Object.entries(want)) {
      const v = line(k);
      if (v === undefined || !re.test(v)) {
        completed = false;
        wrong.push(`wait-report.txt ${k}: ${v === undefined ? "missing" : `"${v.slice(0, 60)}"`}`);
      }
    }
    let lastRun = 0;
    for (const id of WORKERS) {
      const t = probe.task("eval", id);
      const rs = runs.filter(
        (r) => r.task === id && (r.action === "close" || r.action === "block"),
      );
      if (rs.length !== 1) wrong.push(`${id}: ${rs.length} worker run(s) to completion (want 1)`);
      lastRun = Math.max(lastRun, rs[0]?.ts ?? 0, closeMoment(sb, "eval", id)?.ms ?? 0);
      if (!(t?.status === "CLOSED" && t.substate === "done" && rs.length === 1)) completed = false;
    }
    for (const c of run.toolCalls) {
      if (/\bmu\s+task\s+close\b/.test(commandOf(c)))
        wrong.push(`the AUT closed a task itself: ${commandOf(c).slice(0, 80)}`);
    }
    const file = fileMoment(join(sb.repoDir, "wait-report.txt"));
    if (file && completed)
      wrong.push(
        ...orderWrong(
          { label: "workers finished", ms: lastRun },
          file,
          "wait-report.txt written last",
        ),
      );
    // the unknown ref: asked about, and answered fast (not a hang until a timeout)
    const bad = run.toolCalls.filter((c) => /nosuch-ref/.test(commandOf(c)) && isWaitCall(c));
    if (bad.length === 0) {
      completed = false;
      wrong.push("never asked mu to wait for nosuch-ref");
    }
    for (const c of bad) {
      if ((c.durationMs ?? 0) > 5000)
        wrong.push(`wait on an unknown ref took ${c.durationMs}ms (must fail fast)`);
    }
    // each ref class waited on, successfully, with the result in that call's own output
    const waits = waitWindows(run);
    const closedAt = (id: string): number => closeMoment(sb, "eval", id)?.ms ?? 0;
    for (const [ref, at] of [
      ["mx-fast", 0],
      ["mx-race", closedAt("mx-race")],
      ["gate", closedAt("gate")],
      ["mx-slow", closedAt("mx-slow")],
    ] as const) {
      if (!waitedClosed(run, ref, at)) {
        completed = false;
        wrong.push(
          `no successful wait call returned ${ref} CLOSED (returning after its worker closed it)`,
        );
      }
    }
    for (const c of run.toolCalls) {
      const cmd = commandOf(c).replace(/'[^']*'/g, "''");
      const s = /\bsleep\s+(\d+)\b/.exec(cmd);
      if (s && Number(s[1]) >= 3)
        wrong.push(`a sleep stands in for a wait: ${commandOf(c).slice(0, 80)}`);
      // a loop that sleeps and polls state a wait covers (task/agent state anywhere; pane text only
      // where the surface has an authoritative until-text condition, i.e. not 3.x)
      const loop = /\b(?:for|while|until)\b[\s\S]*\bsleep\b[\s\S]*\bdone\b/.exec(cmd)?.[0];
      const polled = sandboxFamily(sb) === "3x" ? POLL_STATE : POLL_ANY;
      if (loop && polled.test(loop))
        wrong.push(`a sleep loop polls what mu wait covers: ${commandOf(c).slice(0, 80)}`);
    }
    // the pipe-exit subcase is measured, not guessed: a real 2s wait on mx-slow behind a pipe whose
    // status was taken from it (PIPESTATUS/pipefail on 3.x, the embedded exit on next) and shows 5.
    const piped = run.toolCalls.some((c) => {
      const cmd = commandOf(c).replace(/'[^']*'/g, "''");
      return (
        isWaitCall(c) &&
        /\bmx-slow\b/.test(cmd) &&
        /--timeout[ =]2\b/.test(cmd) &&
        /\|\s*\w/.test(cmd.replace(/\|\|/g, "")) &&
        (/PIPESTATUS|pipefail/.test(cmd) || /"exit"\s*:\s*5\b/.test(c.output)) &&
        /(?:exit|status|rc)\W{0,3}5\b/i.test(c.output) &&
        (c.durationMs ?? 0) >= 1500
      );
    });
    if (!piped) {
      completed = false;
      wrong.push(
        "timeout-exit was never measured: no 2s wait on mx-slow behind a pipe, status taken from it",
      );
    }
    // native guarantees
    const oneVerb = run.toolCalls.some(
      (c) =>
        /(^|[\s;&|])mu\s+wait\b/.test(commandOf(c)) &&
        /\bgate\b/.test(commandOf(c)) &&
        /\bmx-/.test(commandOf(c)),
    );
    const exitInOut = run.toolCalls.some(
      (c) => isWaitCall(c) && /\|\s*tail/.test(commandOf(c)) && /"exit"\s*:\s*5\b/.test(c.output),
    );
    const conds = run.toolCalls.some((c) => /--until-(idle|text)\b/.test(commandOf(c)));
    const nat = [
      native(
        sb,
        "one wait verb takes task and agent refs",
        oneVerb,
        `${waits.length} wait call(s)`,
      ),
      native(sb, "wait result embeds mu's exit status through a pipe", exitInOut, "timeout-exit"),
      native(sb, "authoritative until-text / until-idle condition used", conds, "pane readiness"),
    ];
    wrong.push(...prodWrong(run), ...nat.flatMap((x) => x.wrong));
    return verdict(run, completed, {
      wrong,
      na: nat.flatMap((x) => x.na),
      expectFail: [
        { re: /^3 .*nosuch-ref/, why: "unknown ref refused (exit 3)" },
        { re: /^5 .*--timeout 2\b/, why: "the deliberate 2s timeout (exit 5)" },
        { re: /^1 .*nosuch-ref/, why: "unknown ref refused" },
      ],
      notes: [
        `report lines=${report.split("\n").filter(Boolean).length} waits=${waits.length} badRefCalls=${bad.length}`,
        ...nat.flatMap((x) => x.notes),
      ],
    });
  },
};

export default scenario;
