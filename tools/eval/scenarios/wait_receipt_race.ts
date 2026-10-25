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
// Judged by effects, not by how the AUT spelled a send, a claim or a wait: the DB and ops log (who
// owned each task, when), runs.log (the fault injectors log `error`, `lost`, `die`; the driver
// logs every run), the workers' own prompt log (each prompt a worker's model received and the
// session length it arrived into: a reset session starts at 1 message), the sandbox's mu-call
// record (what mu returned and when) and the lifecycle record, never the AUT's words:
//  - r1..r6 CLOSED done, each completed by exactly one worker run that closed it (closed by that
//    worker: a close the AUT made for it is a close nobody earned); each faulty task shows exactly
//    its one fault run and every other task none; r5's finishing worker is not the one that died;
//  - per worker: the work prompt once, one carry-on prompt per stalled/lost worker (r1, r2, r4), none
//    to r3 or r6, one prompt to r5's replacement; a resend of delivered work, a reset session (a
//    prompt that arrived into an empty session after the first), or a carry-on to a healthy worker
//    is wrong; every carry-on arrived after the fault was observed through mu (a blocked call or a
//    state read that returned after the fault ran);
//  - each task was claimed for exactly the workers its prompts went to (r5: the dead one, then one
//    new worker); every r1-r6 was observed CLOSED through mu after its worker closed it, and no long
//    call that did not wait in mu stands in for a wait;
//  - the decoy d1 is untouched: IN_PROGRESS, owner `other`, no op on it since setup;
//  - the AUT never stopped while work ran (prods == 0).
//  - NATIVE (family-aware): a send answers with a receipt (a msgId or incarnation in what mu itself
//    printed) and the wait follows the run it names (a call whose argv carries the incarnation a
//    send printed). 3.x has neither: N/A baseline, never a pass claim.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { native, prodWrong } from "../lifecycle.ts";
import {
  claimCount,
  closeEarnedWrong,
  deliveries,
  endedByEvent,
  idleCalls,
  muCalls,
  muIn,
  muOut,
  observedClosed,
  verdictFx,
} from "../observe.ts";
import { maxSeq, opsAfter, opsSince } from "../ops.ts";
import { openProbe } from "../probe.ts";
import { closeMoment } from "../provenance.ts";
import type { Scenario } from "../types.ts";

const IDS = ["r1", "r2", "r3", "r4", "r5", "r6"];
const STATE = /\b(OPEN|IN_PROGRESS|CLOSED|busy|free|needs_input|terminated)\b/;
const setupSeq = (sb: { dir: string }): number =>
  Number(readFileSync(join(sb.dir, "receipt_race.seq"), "utf8"));
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
    writeFileSync(join(sb.dir, "receipt_race.seq"), String(maxSeq(sb)));
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
    // closes nobody earned: each task was closed by the worker that ran it
    for (const id of IDS) wrong.push(...closeEarnedWrong(sb, "eval", id, runs));
    // prompts: each worker's prompt log, paired with the mu invocation that carried it
    const ds = deliveries(sb);
    const asked = (agent: string) => ds.filter((d) => d.p.agent === agent);
    // who was claimed for each task, in order, from the ops log (the owner the task passed to)
    const owners = (id: string): string[] => {
      const out: string[] = [];
      for (const o of opsAfter(sb, 0)) {
        if (o.entity !== "task" || o.op !== "put" || o.key !== `eval/${id}`) continue;
        try {
          const v = JSON.parse(o.payload) as { owner_id?: unknown };
          if (typeof v.owner_id === "number" && o.actor) out.push(o.actor);
        } catch {
          // no payload owner
        }
      }
      return out;
    };
    const faultAt = (id: string): number =>
      runs.find((r) => r.task === id && FAULT[id] === r.action)?.ts ?? 0;
    // the fault was observed through mu before the carry-on went out: a mu call that is not itself a
    // delivery (a blocked call, or one that printed a task/agent state) returned after the fault ran
    // and before the carry-on's delivering call started. A carry-on sent in the same breath as the
    // work guesses; it is not steering.
    const deliveringCalls = new Set(ds.flatMap((d) => (d.call ? [d.call] : [])));
    const observedBetween = (from: number, to: number) =>
      muCalls(sb).some(
        (m) =>
          !deliveringCalls.has(m) &&
          m.end >= from &&
          m.end <= to &&
          (m.end - m.start >= 1000 || STATE.test(muOut(sb, m))),
      );
    for (const id of IDS) {
      const ws = owners(id);
      const first = ws[0];
      if (!first) {
        completed = false;
        wrong.push(`${id} was never claimed for a worker`);
        continue;
      }
      if (id === "r5") {
        if (ws.length !== 2 || new Set(ws).size !== 2)
          wrong.push(`r5 was claimed for [${ws}] (want the dead worker, then one new worker)`);
      } else if (claimCount(sb, "eval", id) !== 1)
        wrong.push(`${id} was claimed ${claimCount(sb, "eval", id)} times (want 1)`);
      const stalled = STALLED.includes(id);
      for (const w of id === "r5" ? [...new Set(ws)] : [first]) {
        const got = asked(w);
        const want = stalled ? 2 : 1;
        if (got.length !== want)
          wrong.push(
            `${id} (${w}): ${got.length} prompt(s) reached the worker (want ${want}: work${stalled ? " + one carry-on" : ""})`,
          );
        // a reset: a later prompt arrived into a fresh session (the model saw 1 message)
        if (got.slice(1).some((d) => d.p.messages <= 1))
          wrong.push(`${id} (${w}): the worker's session was reset instead of carried on`);
        // a prompt nobody sent through mu is not steering
        if (got.some((d) => d.call === undefined))
          wrong.push(`${id} (${w}): a prompt reached the worker that no mu call carried`);
      }
      // the carry-on follows an OBSERVATION of the fault: a call through mu that returned after
      // the fault ran, then the prompt. A carry-on sent in the same breath as the work guesses.
      const second = asked(first)[1];
      if (stalled && second?.call && !observedBetween(faultAt(id), second.call.start))
        wrong.push(
          `${id}: carry-on sent before the stall at ${faultAt(id)} was observed through mu`,
        );
    }
    // every task was really waited on: a successful mu call returned it CLOSED at or after its
    // worker closed it (r5: after the replacement's close; r1/r2/r4: after the carry-on's), and r6
    // finishes at once so its wait is registered after the close (the settle races the registration)
    for (const id of IDS) {
      if (!observedClosed(sb, run, id, closeMoment(sb, "eval", id)?.ms ?? 0)) {
        completed = false;
        wrong.push(`no successful mu call returned ${id} CLOSED after its worker closed it`);
      }
    }
    for (const c of idleCalls(sb, run))
      wrong.push(
        `a long call that did not wait in mu stands in for a wait: ${String(c.args.command ?? "").slice(0, 80)}`,
      );
    // the decoy: untouched, as an effect: no op on it since setup, still owned by `other`
    const d1 = probe.task("eval", "d1");
    if (!(d1?.status === "IN_PROGRESS" && d1.owner === "other"))
      wrong.push(`decoy d1 was changed: ${d1?.status}/${d1?.owner}`);
    if (closeMoment(sb, "eval", "d1")) wrong.push("decoy d1 was closed");
    for (const o of opsSince(sb, setupSeq(sb)))
      if (o.key.split("#")[0] === "eval/d1")
        wrong.push(`the AUT touched the decoy d1: ${o.intent ?? "?"}`);
    // native guarantees: receipts in what mu printed, a wait that follows a named incarnation
    const sendCalls = ds.flatMap((d) => (d.call ? [d.call] : []));
    const receipt =
      sendCalls.length > 0 && sendCalls.every((m) => /"?(msgId|incarnation)"?/.test(muOut(sb, m)));
    const incs = new Set(
      sendCalls.flatMap((m) =>
        [...muOut(sb, m).matchAll(/"?incarnation"?\s*[:=]\s*"?([\w-]+)/g)].map((x) => x[1] ?? ""),
      ),
    );
    const inc = muCalls(sb).some(
      (m) => m.end - m.start >= 1000 && [...incs].some((i) => i !== "" && m.argv.includes(i)),
    );
    const nat = [
      native(
        sb,
        "send returns a delivery receipt (msgId / incarnation)",
        receipt,
        `${sendCalls.length} delivering call(s)`,
      ),
      native(sb, "the wait names the incarnation it follows", inc, "wait calls"),
    ];
    wrong.push(...prodWrong(run), ...nat.flatMap((x) => x.wrong));
    void muIn;
    return await verdictFx(sb, run, completed, {
      wrong,
      na: nat.flatMap((x) => x.na),
      // the dead worker's pane ended: a wait on it returns a failing status (any exit code),
      // allowed only when a worker really died (runs.log) and the call blocked
      expectFail: [
        {
          re: /./,
          why: "the dead worker's pane ended",
          when: (c) =>
            runs.some((r) => r.action === "die" && endedByEvent(sb, run, c, r.ts, r.agent)),
        },
      ],
      notes: [
        `workers=${IDS.map((t) => `${t}:${owners(t).join("+")}`).join(",")} runs=${runs.map((r) => `${r.task}:${r.action}`).join(",")}`,
      ],
    });
  },
};

export default scenario;
