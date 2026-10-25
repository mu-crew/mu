// Waiting on a mix of refs: an already-CLOSED task, a worker's task, a task and an agent that
// share a name (`gate`), a non-pi pane's output, a worker that closes before the wait is
// registered, an unknown ref, and a wait whose exit status goes through a pipe.
//
// Fixture: mx-fast is CLOSED at setup (evidence carries the run nonce); mx-slow (7s), gate (task, 10s)
// and mx-race (instant) are worker tasks; `gate-cmd` (in PATH) is a non-pi pane command that
// prints GATE-READY-<nonce> after 4s and stays up. The AUT writes wait-report.txt:
//   fast: <mx-fast's close evidence>      ready: GATE-READY-<nonce> read from the PANE named gate
//   slow: <mx-slow's worker evidence>     gate: <the TASK gate's worker evidence>
//   race: <mx-race's worker evidence>     timeout-exit: <the exit status of a 2s-bound wait on mx-slow>
// Every value is derivable only from the real task/pane (nonce), so the judge compares the file to
// the fixture truth plus the DB, runs.log and what mu itself did, never to the AUT's claims.
// Judged by observed effects (the sandbox's mu-call record, observe.ts), not by verb spellings or
// exit codes mu-next changes:
//  - each line right; report written after the workers finished; no worker task closed by the AUT;
//  - the unknown ref: a mu invocation of the AUT asked about nosuch-ref, failed, and answered fast;
//  - each ref class was really waited on: a successful mu invocation (naming the ref, or blocking)
//    whose own output shows it CLOSED, returning after that ref's worker closed it (mx-fast: at
//    once; mx-race: after its worker was sent, the settle racing the registration; gate/mx-slow);
//    a long shell call that did not block in mu (a sleep) or polled the same state read repeatedly
//    is never a stand-in for a wait;
//  - timeout-exit: a mu invocation on mx-slow BLOCKED about 2s and reported a timeout (timedOut was
//    observed in its own output, whatever its exit code), and the report line is the status that
//    invocation really returned, recorded by the shim; a guess does not match;
//  - NATIVE (family-aware): one invocation naming a task and an agent ref, and a timeout that is a
//    reported outcome rather than an exit code. 3.x has neither as a guarantee: N/A baseline.
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
import { commandOf, native, prodWrong, waitWindows } from "../lifecycle.ts";
import {
  closeEarnedWrong,
  idleCalls,
  muCalls,
  muOut,
  names,
  observedClosed,
  pollingCalls,
  showsClosed,
  timedOut,
  toolHolds,
  verdictFx,
} from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, fileMoment, orderWrong } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const WORKERS = ["mx-slow", "gate", "mx-race"];

const scenario: Scenario = {
  id: "wait_mixed_refs",
  title: "wait on a mix of task, agent and pane refs, closed-already, raced and piped",
  prompt:
    "Workstream eval has: task mx-fast (already closed), worker tasks mx-slow, gate and mx-race (each needs a pi worker; use one worker per task, any names), and a non-pi build pane you must start with `mu agent spawn gate -w eval --command gate-cmd` (that agent is named gate, like the task gate; it prints a GATE-READY-<id> line when its build is ready). Wait with mu (do not sleep-poll in loops of your own if a mu wait can do it) and write wait-report.txt in the repo root with exactly these six lines: `fast: <the evidence mx-fast was closed with>`, `ready: <the GATE-READY-<id> line printed by the gate PANE>`, `slow: <evidence the worker closed mx-slow with>`, `gate: <evidence the worker closed the TASK gate with>`, `race: <evidence the worker closed mx-race with>`, and `timeout-exit: <the exit status mu itself returned for a wait on mx-slow that you bound to 2 seconds and ran right after you started mx-slow, with its output piped through tail -5 (the status of mu, not of tail)>`. Also check what mu says when asked to wait for the ref nosuch-ref. Work until it is done; do not ask me questions.",
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
    // the AUT closes nothing a worker earns: each worker task was closed by the worker that ran it
    for (const id of WORKERS) wrong.push(...closeEarnedWrong(sb, "eval", id, runs));
    const file = fileMoment(join(sb.repoDir, "wait-report.txt"));
    if (file && completed)
      wrong.push(
        ...orderWrong(
          { label: "workers finished", ms: lastRun },
          file,
          "wait-report.txt written last",
        ),
      );
    const calls = muCalls(sb);
    // the unknown ref: asked about through mu, and answered fast (not a wait that ran to a timeout)
    const bad = calls.filter((m) => names(m.argv, "nosuch-ref"));
    if (bad.length === 0) {
      completed = false;
      wrong.push("never asked mu about nosuch-ref");
    }
    for (const m of bad) {
      if (m.end - m.start > 5000)
        wrong.push(`a call on an unknown ref took ${m.end - m.start}ms (must fail fast)`);
      if (timedOut(muOut(sb, m)))
        wrong.push("a call on an unknown ref reported a timeout instead of refusing the ref");
    }
    // each ref class waited on, successfully, with the result in mu's own output for that call
    const waits = waitWindows(sb);
    const closedAt = (id: string): number => closeMoment(sb, "eval", id)?.ms ?? 0;
    for (const [ref, at] of [
      ["mx-fast", 0],
      ["mx-race", closedAt("mx-race")],
      ["gate", closedAt("gate")],
      ["mx-slow", closedAt("mx-slow")],
    ] as const) {
      if (!observedClosed(sb, run, ref, at)) {
        completed = false;
        wrong.push(
          `no successful mu call returned ${ref} CLOSED (returning after its worker closed it)`,
        );
      }
    }
    // a sleep or a poll loop is never a stand-in for a wait. Pane text has no authoritative wait
    // condition on 3x (a family option), so polling a pane read is the manual workaround there.
    for (const c of idleCalls(sb, run))
      wrong.push(
        `a long call that did not wait in mu stands in for a wait: ${commandOf(c).slice(0, 80)}`,
      );
    for (const c of pollingCalls(sb, run, { allowPaneReads: sandboxFamily(sb) === "3x" }))
      wrong.push(`a poll loop reads what a wait covers: ${commandOf(c).slice(0, 80)}`);
    // the timeout subcase is measured, not guessed: a mu invocation on mx-slow BLOCKED about 2s and
    // reported a timeout in its own output (timedOut observed, whatever exit code it carries); the
    // report line is the status that invocation really returned, recorded by the shim.
    const slowClosed = closedAt("mx-slow");
    const bounded = calls.filter(
      (m) =>
        names(m.argv, "mx-slow") &&
        !names(m.argv, "gate") &&
        m.end - m.start >= 1500 &&
        m.end - m.start <= 4500 &&
        (slowClosed === 0 || m.end <= slowClosed) &&
        timedOut(muOut(sb, m)),
    );
    const measured = bounded[0];
    if (!measured) {
      completed = false;
      wrong.push("timeout-exit was never measured: no 2s-bound wait on mx-slow that timed out");
    } else if (line("timeout-exit") !== String(measured.exit)) {
      completed = false;
      wrong.push(
        `timeout-exit is "${line("timeout-exit") ?? "missing"}", the wait returned ${measured.exit}`,
      );
    }
    // native guarantees: stated over what mu itself printed
    const oneCall = calls.some(
      (m) =>
        m.exit === 0 &&
        m.end - m.start >= 1500 &&
        names(m.argv, "gate") &&
        names(m.argv, "mx-slow") &&
        /\b(busy|free|needs_input|terminated|dead)\b/i.test(muOut(sb, m)) &&
        showsClosed(muOut(sb, m), "mx-slow"),
    );
    const exitInOut =
      measured !== undefined &&
      new RegExp(`"exit"\\s*:\\s*${measured.exit}\\b`).test(muOut(sb, measured));
    const readyCall = waits.some((w) => new RegExp(`GATE-READY-${n}`).test(muOut(sb, w.mu)));
    const nat = [
      native(
        sb,
        "one wait call settles task and agent refs",
        oneCall,
        `${waits.length} blocking call(s)`,
      ),
      native(sb, "a wait result embeds the exit status it returns", exitInOut, "timeout-exit"),
      native(sb, "pane readiness is an authoritative wait condition", readyCall, "GATE-READY"),
    ];
    wrong.push(...prodWrong(run), ...nat.flatMap((x) => x.wrong));
    return await verdictFx(sb, run, completed, {
      wrong,
      na: nat.flatMap((x) => x.na),
      expectFail: [
        // a refused unknown ref: fails fast (any exit code)
        {
          re: /nosuch-ref/,
          why: "unknown ref refused",
          when: (c) =>
            calls.some(
              (m) => names(m.argv, "nosuch-ref") && m.end - m.start <= 5000 && toolHolds(run, c, m),
            ),
        },
        // the deliberate 2s timeout on mu-3x is a failing exit: allowed only for that bounded wait
        {
          re: /./,
          why: "the deliberate 2s-bound wait timed out",
          when: (c) => bounded.some((m) => toolHolds(run, c, m)),
        },
      ],
      notes: [
        `report lines=${report.split("\n").filter(Boolean).length} blocking=${waits.length} badRefCalls=${bad.length} measuredExit=${measured?.exit ?? "-"}`,
        ...nat.flatMap((x) => x.notes),
      ],
    });
  },
};

export default scenario;
