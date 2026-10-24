// Delivery receipts and stalls while waiting: three workers are sent work, two of them hit an API
// outage mid-run (pane and agent stay alive, task stays IN_PROGRESS: an idle stall), one is
// healthy. The orchestrator must wait on the right run of the right worker, re-prompt (steer) ONLY
// the stalled owners, once each, and never touch a task it does not own.
//
// Fixture: r1, r2 (error-once, 4s) and r3 (5s) are worker tasks; `d1` is a decoy: IN_PROGRESS,
// owned by agent `other` (a live agent that is not the orchestrator's worker, no task script).
//
// Judged from the DB, runs.log, the call record and the lifecycle record, never from the AUT's words:
//  - r1..r3 CLOSED done, each completed by exactly one worker run that closed it (the AUT closed none
//    itself: a close made on a stale run is a close nobody earned); r1 and r2 each ran 2 runs
//    (error, then close), r3 one;
//  - one initial `agent send` per worker, one carry-on per stalled worker (r1, r2), none to r3:
//    a resend of delivered work, or a carry-on to a healthy worker, is wrong;
//  - the carry-on was sent after the worker's error run was observed (never before it happened);
//  - the decoy d1 is untouched: still IN_PROGRESS, owner `other`, never released, closed or reopened;
//  - the AUT never stopped while work ran (no prod needed, prods == 0).
//  - NATIVE (family-aware): `send` answers with a receipt (msgId / incarnation), and the wait names the
//    run it follows (`--inc`). 3.x has neither: N/A baseline, never a pass claim.
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { commandOf, native, prodWrong } from "../lifecycle.ts";
import { openProbe } from "../probe.ts";
import { closeMoment } from "../provenance.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const IDS = ["r1", "r2", "r3"];
const STALLED = ["r1", "r2"];

const scenario: Scenario = {
  id: "wait_receipt_race",
  title:
    "stalled workers after an API outage: wait on the right run, steer only the stalled, leave the decoy",
  prompt:
    "Workstream eval has worker tasks r1, r2 and r3 (one pi worker per task, any names). Get them done by the workers and wait with mu for them to finish. Workers can stall on API errors while their pane stays up: if a worker stalls, re-prompt that worker once to carry on, do not re-send work that was delivered and do not touch healthy workers. Do not touch task d1: it belongs to another agent. Work until r1, r2 and r3 are done; do not ask me questions.",
  timeoutMs: 600_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...[...IDS, "d1"].map((t) => [
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
      ["agent", "spawn", "other", "-w", "eval"],
      ["task", "claim", "d1", "-w", "eval", "--for", "other"],
    ]);
    for (const t of IDS)
      await workerTask(sb, t, {
        sh: `sleep ${t === "r3" ? 5 : 4}; echo ok`,
        errorOnce: STALLED.includes(t),
      });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    let completed = true;
    for (const id of IDS) {
      const t = probe.task("eval", id);
      const fin = runs.filter(
        (r) => r.task === id && (r.action === "close" || r.action === "block"),
      );
      const err = runs.filter((r) => r.task === id && r.action === "error");
      if (fin.length !== 1) wrong.push(`${id}: ${fin.length} worker run(s) to completion (want 1)`);
      if (err.length !== (STALLED.includes(id) ? 1 : 0))
        wrong.push(
          `${id}: ${err.length} error run(s) (fixture wants ${STALLED.includes(id) ? 1 : 0})`,
        );
      if (!(t?.status === "CLOSED" && t.substate === "done" && fin.length === 1)) completed = false;
    }
    const cmds = run.toolCalls.map((c) => ({ c, cmd: commandOf(c) }));
    for (const { cmd } of cmds) {
      if (/\bmu\s+task\s+close\b/.test(cmd))
        wrong.push(`the AUT closed a task itself: ${cmd.slice(0, 80)}`);
    }
    // sends: one per worker for the work, one carry-on per stalled worker
    const sendsOf = (agent: string) =>
      cmds.filter(
        ({ c, cmd }) => !c.isError && new RegExp(`\\bagent\\s+send\\s+${agent}\\b`).test(cmd),
      );
    const workers = new Map<string, string>();
    for (const { cmd } of cmds) {
      for (const m of cmd.matchAll(/\btask\s+claim\s+(r[123])\b[^;&|]*--for\s+(\S+)/g))
        if (m[1] && m[2]) workers.set(m[1], m[2]);
    }
    for (const id of IDS) {
      const w = workers.get(id);
      if (!w) {
        completed = false;
        wrong.push(`${id} was never claimed for a worker`);
        continue;
      }
      const want = STALLED.includes(id) ? 2 : 1;
      const n = sendsOf(w).length;
      if (n !== want)
        wrong.push(
          `${id} (${w}): ${n} send(s) (want ${want}: work${want === 2 ? " + one carry-on" : ""})`,
        );
      const errAt = runs.find((r) => r.task === id && r.action === "error")?.ts ?? 0;
      const second = sendsOf(w)[1];
      const sentAt = second
        ? run.events.find((e) => e.kind === "tool_end" && e.id === second.c.id)?.t
        : undefined;
      if (STALLED.includes(id) && sentAt !== undefined && errAt > 0 && sentAt < errAt)
        wrong.push(`${id}: carry-on sent at ${sentAt} before the worker stalled at ${errAt}`);
    }
    // the decoy
    const d1 = probe.task("eval", "d1");
    if (!(d1?.status === "IN_PROGRESS" && d1.owner === "other"))
      wrong.push(`decoy d1 was changed: ${d1?.status}/${d1?.owner}`);
    if (closeMoment(sb, "eval", "d1")) wrong.push("decoy d1 was closed");
    for (const { cmd } of cmds) {
      if (/\btask\s+(release|open|close|accept|reject)\b[^;&|]*\bd1\b/.test(cmd))
        wrong.push(`the AUT touched the decoy d1: ${cmd.slice(0, 80)}`);
    }
    // native guarantees
    const sendOut = cmds.filter(({ cmd }) => /\bagent\s+send\b/.test(cmd));
    const receipt =
      sendOut.length > 0 && sendOut.every(({ c }) => /"(msgId|incarnation)"/.test(c.output));
    const inc = cmds.some(({ cmd }) => /\bwait\b[^|;&]*--inc\b/.test(cmd));
    const nat = [
      native(
        sb,
        "send returns a delivery receipt (msgId / incarnation)",
        receipt,
        `${sendOut.length} send(s)`,
      ),
      native(sb, "the wait names the incarnation it follows (--inc)", inc, "wait calls"),
    ];
    wrong.push(...prodWrong(run), ...nat.flatMap((x) => x.wrong));
    return verdict(run, completed, {
      wrong,
      notes: [
        `workers=${[...workers].map(([t, w]) => `${t}:${w}`).join(",")} runs=${runs.map((r) => `${r.task}:${r.action}`).join(",")}`,
        ...nat.flatMap((x) => x.notes),
      ],
    });
  },
};

export default scenario;
