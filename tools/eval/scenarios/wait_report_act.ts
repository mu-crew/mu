// Read a worker's result and act on it: worker-1's final text asks for t2 to be reopened.
//
// t1 is a worker task whose report is `REPORT: reopen t2 (<nonce>)`; t2 and t3 are CLOSED. The AUT
// must hand t1 to a pi worker, read what the worker reported and do what it asks. Judged from the
// ops log, the mu-call record and the AUT's commands, never from the AUT's words:
//  - t2 is OPEN at the end, reopened after t1's close settled (its close op), t3 still CLOSED;
//  - mu itself showed the AUT the report line (an AUT mu call whose own output holds
//    `reopen t2 (<nonce>)`) before the reopen: a guess or a hidden channel has no such call;
//  - no AUT command reads a session file (sessions/, *.jsonl): the result comes through mu;
//  - t1 was closed by its worker's CLOSE block, ran once, and was claimed once.
// R4 scenario of the hill-r2 rig (docs/specs/2026-11-07-hill-r2-tournament.md §2.2), group c1.
import {
  gateScript,
  makeRepo,
  nonce,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { commandOf } from "../lifecycle.ts";
import { claimCount, closeEarnedWrong, muCalls, muOut, verdictFx } from "../observe.ts";
import { opsAfter } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, type Moment, orderWrong } from "../provenance.ts";
import type { Sandbox, Scenario } from "../types.ts";

const WS = "eval";
/** A command that opens a pi session file instead of asking mu. */
const SESSION_READ = /\bsessions\/|\.jsonl\b/;

/** The first op that put t2 from CLOSED back to OPEN (however it was spelled). */
function reopenMoment(sb: Sandbox): Moment | null {
  let status: unknown;
  for (const o of opsAfter(sb, 0)) {
    if (o.entity !== "task" || o.op !== "put" || o.key !== `${WS}/t2`) continue;
    let next: unknown;
    try {
      next = (JSON.parse(o.payload) as { status?: unknown }).status;
    } catch {
      continue;
    }
    if (next === undefined) continue;
    if (status === "CLOSED" && next === "OPEN")
      return { label: `${o.intent ?? "?"} ${o.key}`, ms: o.ms, seq: o.seq };
    status = next;
  }
  return null;
}

const scenario: Scenario = {
  id: "wait_report_act",
  title: "read a worker's result through mu and act on what it asks",
  families: ["next"],
  prompt:
    "Workstream eval has task t1. Give it to a pi worker, and when the worker is done, do what its report asks for. Work until it is done; do not ask me questions.",
  timeoutMs: 600_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    const add = (id: string, title: string): string[] => [
      "task",
      "add",
      id,
      "-w",
      WS,
      "-t",
      title,
      "-i",
      "50",
      "-e",
      "0.1",
    ];
    await seedViaMu(sb, [
      ["workstream", "init", WS],
      add("t1", "re-test the token refresh after the release"),
      add("t2", "token refresh fix"),
      add("t3", "cache eviction fix"),
      ["task", "close", "t2", "-w", WS, "--evidence", "fix merged"],
      ["task", "close", "t3", "-w", WS, "--evidence", "fix merged"],
    ]);
    await workerTask(sb, "t1", {
      sh: `sleep 3; echo "REPORT: reopen t2 ($(cat "$EVAL_WORKER_DIR/nonce"))"`,
    });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const n = await nonce(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    const t2 = probe.task(WS, "t2");
    const t3 = probe.task(WS, "t3");
    const settled = closeMoment(sb, WS, "t1");
    const reopened = reopenMoment(sb);
    let completed = t2?.status === "OPEN" && reopened !== null;
    if (t2?.status !== "OPEN") wrong.push(`t2 is ${t2?.status ?? "missing"} (want OPEN)`);
    if (t3?.status !== "CLOSED")
      wrong.push(`t3 is ${t3?.status ?? "missing"}: only t2 was asked for`);
    // acted on the result: t2 reopened after t1's close settled, not on a guess before it
    if (reopened) wrong.push(...orderWrong(settled, reopened, "t2 reopened after t1 settled"));
    // the report reached the AUT through mu: a mu call's own output held the line, before the reopen
    const line = `reopen t2 (${n})`;
    const shown = muCalls(sb).find(
      (m) => muOut(sb, m).includes(line) && (reopened === null || m.end <= reopened.ms + 50),
    );
    if (!shown) {
      completed = false;
      wrong.push("no mu call showed the AUT the worker's report before t2 was reopened");
    }
    for (const c of run.toolCalls)
      if (SESSION_READ.test(commandOf(c)))
        wrong.push(`read a session file instead of asking mu: ${commandOf(c).slice(0, 80)}`);
    const t1Runs = runs.filter((r) => r.task === "t1" && r.action === "block");
    if (t1Runs.length !== 1) wrong.push(`t1: ${t1Runs.length} worker run(s) (want 1)`);
    wrong.push(...closeEarnedWrong(sb, WS, "t1", runs));
    if (claimCount(sb, WS, "t1") !== 1)
      wrong.push(`t1 was claimed ${claimCount(sb, WS, "t1")} times (want 1)`);
    return await verdictFx(sb, run, completed, {
      wrong,
      notes: [
        `t1 settled=${settled?.ms ?? "-"} t2 reopened=${reopened?.ms ?? "-"} shown=${shown ? shown.argv.slice(0, 60) : "-"}`,
      ],
    });
  },
};

export default scenario;
