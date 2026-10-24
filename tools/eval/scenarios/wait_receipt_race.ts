// Delivery receipts, stalls, a lost prompt and a restart while waiting. Six worker tasks, six faults:
//   r1, r2  API outage mid-run (error-once): pane and agent stay alive, task stays IN_PROGRESS
//   r3      healthy but slow (9s): a delayed answer is not a stall; steering it is wrong
//   r4      the prompt is delivered and silently lost (lose-once): the worker does nothing, no error
//   r5      the worker process dies (die-once): a new incarnation must do the work (another worker)
//   r6      finishes instantly: the wait is registered after the worker may already have closed it
// `d1` is a decoy: IN_PROGRESS, owned by agent `other` (a live agent, not the orchestrator's worker).
// The orchestrator waits on the right run of the right worker, re-prompts (carry on, never /new)
// ONLY the stalled or lost owners, once each, replaces the dead one, and never touches d1.
//
// Judged from the DB, runs.log (the fault injectors log `error`, `lost`, `die`), the call record and
// the lifecycle record, never from the AUT's words:
//  - r1..r6 CLOSED done, each completed by exactly one worker run that closed it (the AUT closed none
//    itself: a close on a stale run is a close nobody earned); each faulty task shows exactly its one
//    fault run and every other task none; r5's finishing worker is not the one that died;
//  - one initial `agent send` per worker, one carry-on (no --fresh) per stalled/lost worker (r1, r2,
//    r4), none to r3 or r6, one send to r5's replacement: a resend of delivered work, a reset, or a
//    carry-on to a healthy worker is wrong; each carry-on was sent after the fault was observed;
//  - every r1-r6 really went through a wait call that returned the ref CLOSED after its worker closed it, and no sleep >= 3s stands in for a wait;
//  - the decoy d1 is untouched: IN_PROGRESS, owner `other`, never released, closed or reopened;
//  - the AUT never stopped while work ran (prods == 0).
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
import { commandOf, isWaitCall, native, prodWrong, waitedClosed, windows } from "../lifecycle.ts";
import { openProbe } from "../probe.ts";
import { closeMoment } from "../provenance.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const IDS = ["r1", "r2", "r3", "r4", "r5", "r6"];
/** Task -> the run that must show up in runs.log exactly once before its close: the injected fault. */
const FAULT: Record<string, string> = { r1: "error", r2: "error", r4: "lost", r5: "die" };
/** Tasks whose worker must be re-prompted once (it is alive but did nothing); r5's worker is dead. */
const STALLED = ["r1", "r2", "r4"];

const scenario: Scenario = {
  id: "wait_receipt_race",
  title:
    "stall, lost prompt, dead worker, slow worker, instant worker: wait on the right run, steer only the stalled, leave the decoy",
  prompt:
    "Workstream eval has worker tasks r1-r6 (one pi worker per task, any names) and task d1, which belongs to another agent: do not touch it. Get r1-r6 done by the workers and wait with mu for them to finish. A worker can stall on an API error, silently lose the prompt you sent it, or die, while one is merely slow and one finishes at once. If a live worker did nothing, re-prompt it once to carry on in its session (never reset it, never re-send the work); if a worker is dead, give its task to a new worker; leave healthy workers alone. Work until r1-r6 are done; do not ask me questions.",
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
        sh: `sleep ${t === "r3" ? 9 : t === "r6" ? 0 : 3}; echo ok`,
        errorOnce: t === "r1" || t === "r2",
        loseOnce: t === "r4",
        dieOnce: t === "r5",
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
      const faults = runs.filter(
        (r) => r.task === id && ["error", "lost", "die"].includes(r.action),
      );
      const want = FAULT[id];
      if (fin.length !== 1) wrong.push(`${id}: ${fin.length} worker run(s) to completion (want 1)`);
      if (faults.length !== (want ? 1 : 0) || (want && faults[0]?.action !== want))
        wrong.push(
          `${id}: fault runs [${faults.map((r) => r.action)}] (fixture wants ${want ?? "none"})`,
        );
      if (id === "r5" && fin[0] && faults[0] && fin[0].agent === faults[0].agent)
        wrong.push(`r5 was finished by ${fin[0].agent}, the worker that died on it`);
      if (!(t?.status === "CLOSED" && t.substate === "done" && fin.length === 1)) completed = false;
    }
    const cmds = run.toolCalls.map((c) => ({ c, cmd: commandOf(c) }));
    for (const { cmd } of cmds) {
      if (/\bmu\s+task\s+close\b/.test(cmd))
        wrong.push(`the AUT closed a task itself: ${cmd.slice(0, 80)}`);
    }
    // sends: the work once per worker that took it, one carry-on per stalled worker, no reset
    const sendsOf = (agent: string) =>
      cmds.filter(
        ({ c, cmd }) => !c.isError && new RegExp(`\\bagent\\s+send\\s+${agent}\\b`).test(cmd),
      );
    const workers = new Map<string, string[]>();
    for (const { cmd } of cmds) {
      for (const m of cmd.matchAll(/\btask\s+claim\s+(r[1-6])\b[^;&|]*--for\s+(\S+)/g))
        if (m[1] && m[2]) workers.set(m[1], [...(workers.get(m[1]) ?? []), m[2]]);
    }
    for (const id of IDS) {
      const ws = workers.get(id) ?? [];
      const first = ws[0];
      if (!first) {
        completed = false;
        wrong.push(`${id} was never claimed for a worker`);
        continue;
      }
      if (id === "r5") {
        if (ws.length !== 2 || new Set(ws).size !== 2)
          wrong.push(`r5 was claimed for [${ws}] (want the dead worker, then one new worker)`);
      } else if (ws.length !== 1) wrong.push(`${id} was claimed ${ws.length} times (want 1)`);
      const stalled = STALLED.includes(id);
      for (const w of id === "r5" ? ws : [first]) {
        const sends = sendsOf(w);
        const want = stalled ? 2 : 1;
        if (sends.length !== want)
          wrong.push(
            `${id} (${w}): ${sends.length} send(s) (want ${want}: work${stalled ? " + one carry-on" : ""})`,
          );
        if (sends.slice(1).some(({ cmd }) => /--fresh\b|\/new\b/.test(cmd)))
          wrong.push(`${id} (${w}): the worker's session was reset instead of carried on`);
      }
      // the carry-on follows an OBSERVATION of the fault: a wait (or read) call that returned after
      // the fault ran. A carry-on sent in the same breath as the work guesses; it is not steering.
      const faultAt = runs.find((r) => r.task === id && FAULT[id] === r.action)?.ts ?? 0;
      const second = sendsOf(first)[1];
      const sentAt = second
        ? run.events.find((e) => e.kind === "tool_start" && e.id === second.c.id)?.t
        : undefined;
      const observed = windows(
        run,
        (c) => isWaitCall(c) || /\bagent\s+read\b|\btask\s+(list|show)\b/.test(commandOf(c)),
      ).find((w) => w.end >= faultAt);
      if (stalled && sentAt !== undefined && (observed === undefined || sentAt < observed.end))
        wrong.push(
          `${id}: carry-on sent before the stall at ${faultAt} was observed by a wait/read`,
        );
    }
    // every task was really waited on: a successful wait call naming it returned it CLOSED at or after
    // its worker closed it (r5: after the replacement's close; r1/r2/r4: after the carry-on's), and
    // r6 finishes at once so its wait is registered after the close (the settle races the registration)
    for (const id of IDS) {
      if (!waitedClosed(run, id, closeMoment(sb, "eval", id)?.ms ?? 0)) {
        completed = false;
        wrong.push(`no successful wait call returned ${id} CLOSED after its worker closed it`);
      }
    }
    for (const { cmd } of cmds) {
      const s = /\bsleep\s+(\d+)\b/.exec(cmd.replace(/'[^']*'/g, "''"));
      if (s && Number(s[1]) >= 3) wrong.push(`a sleep stands in for a wait: ${cmd.slice(0, 80)}`);
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
      na: nat.flatMap((x) => x.na),
      expectFail: [{ re: /^6 .*\bwait\b/, why: "the dead worker's pane ended (exit 6)" }],
      notes: [
        `workers=${[...workers].map(([t, w]) => `${t}:${w.join("+")}`).join(",")} runs=${runs.map((r) => `${r.task}:${r.action}`).join(",")}`,
      ],
    });
  },
};

export default scenario;
