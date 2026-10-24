// A delegate wave while four workers run: the orchestrator must keep working (never end its turn
// while a worker runs) and still act on every delegate verdict (never starve them).
//
// Fixture: workers w1-w4 each run one 8s task (k1-k4); 12 claims (c1-c12) go to independent
// delegates under MU_DELEGATE_MAX=2 (2 running + 8 queued: calls 11 and 12 are refused and
// issued again later). Each delegate holds its answer 2s. The answers carry a per-run ref.
//
// Judged from the DB, ops, runs.log and the harness lifecycle record, never from the AUT's words:
//  - every claim has exactly one verdict note (ref + its own claim) on ITS task, one successful
//    delegate per claim, and the task closes by that verdict AFTER the note (done/rejected);
//  - k1-k4 were done by workers (runs.log), and no agent_end happened while a dispatched worker
//    was still running (a stop), and prods == 0;
//  - NATIVE (family-aware, see lifecycle.native): every verdict reached the model inside a wait
//    call, and a wait result carried a per-wave tally. 3.x cannot: pi delivers delegate answers
//    only between turns, so the 3x golden is the best manual workaround (a bash poll loop that
//    never ends the turn and reads the notes through the CLI) and the baseline records N/A.
import {
  delegateAnswer,
  delegateDelay,
  gateScript,
  makeRepo,
  nonce,
  runsLog,
  seedNotes,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { deliveries, inside, native, prodWrong, waitWindows } from "../lifecycle.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, firstNote, orderWrong } from "../provenance.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const N = 12;
const K = ["k1", "k2", "k3", "k4"];
const expected = (n: number): "CONFIRMED" | "REFUTED" => (n % 2 === 1 ? "CONFIRMED" : "REFUTED");
const claimText = (n: number): string =>
  n % 2 === 1
    ? `CLAIM claim-${n}: README.md in the repo root starts with the line "# eval repo".`
    : `CLAIM claim-${n}: gate.sh in the repo root is a Python script.`;
const TALLY = /\b\d+\s*\/\s*\d+\s+CONFIRMED\b/;

const scenario: Scenario = {
  id: "wait_wave_starvation",
  title: "12 delegate verdicts while 4 workers run: act on all, never stop, never starve",
  prompt:
    "Workstream eval has workers' tasks k1-k4 (each takes a pi worker a few seconds) and twelve claim tasks c1-c12 (each holds a claim named claim-1 ... claim-12). Get k1-k4 done by four workers, and get every claim independently checked with its verdict recorded on its task; close each claim task as done if confirmed or rejected if refuted. Act on each verdict as soon as it arrives. Work until all of it is done; do not ask me questions, and do not stop while anything is still running.",
  env: { MU_DELEGATE_MAX: "2" },
  timeoutMs: 1_200_000,
  check: { quietMs: 3000, maxProds: 1 },
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await delegateDelay(sb, 2);
    const ref = await nonce(sb);
    const nums = Array.from({ length: N }, (_, i) => i + 1);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...K.map((k) => ["task", "add", k, "-w", "eval", "-t", `work ${k}`, "-i", "50", "-e", "0.1"]),
      ...nums.map((n) => [
        "task",
        "add",
        `c${n}`,
        "-w",
        "eval",
        "-t",
        `check claim-${n}`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]),
    ]);
    for (const k of K) await workerTask(sb, k, { sh: "sleep 8; echo ok" });
    for (const n of nums) {
      await seedNotes(sb, "eval", `c${n}`, [claimText(n)]);
      await delegateAnswer(
        sb,
        n,
        `VERDICT: ${expected(n)}\nEVIDENCE: fixture claim-${n} ref=${ref}`,
      );
    }
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const ref = await nonce(sb);
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    let completed = true;
    const delegates = run.toolCalls.filter((c) => c.name === "mu_delegate");
    const okCalls = delegates.filter((c) => !c.isError);
    const refused = delegates.filter((c) => c.isError && /\d+ queued/.test(c.output));
    let dupNotes = 0;
    let missing = 0;
    let doneAt = 0;
    for (let n = 1; n <= N; n++) {
      const re = new RegExp(`claim-${n}(?!\\d)`);
      const word = expected(n);
      const all = probe.notes("eval", `c${n}`).filter((x) => /VERDICT:/.test(x));
      const mine = all.filter((x) => x.includes(`ref=${ref}`) && re.test(x));
      for (const x of all) {
        const other = /claim-(\d+)/.exec(x)?.[1];
        if (other !== undefined && Number(other) !== n)
          wrong.push(`c${n} carries the verdict of claim-${other}`);
      }
      const issued = okCalls.filter((c) => re.test(String(c.args.task ?? ""))).length;
      if (issued > 1) wrong.push(`claim-${n}: ${issued} delegates issued (duplicate finding)`);
      if (mine.length > 1) {
        dupNotes++;
        wrong.push(`c${n} has ${mine.length} verdict notes (duplicate finding)`);
      }
      if (mine.length === 0) missing++;
      const t = probe.task("eval", `c${n}`);
      const closedRight =
        t?.status === "CLOSED" && t.substate === (word === "CONFIRMED" ? "done" : "rejected");
      if (t?.status === "CLOSED" && !closedRight)
        wrong.push(
          `c${n} closed ${t.substate}, want ${word === "CONFIRMED" ? "done" : "rejected"}`,
        );
      const order = orderWrong(
        firstNote(sb, "eval", `c${n}`, (x) => x.includes(`ref=${ref}`) && re.test(x)),
        closeMoment(sb, "eval", `c${n}`),
        `c${n} must close after its verdict was recorded`,
      );
      if (t?.status === "CLOSED" && mine.length > 0) wrong.push(...order);
      if (t?.status === "CLOSED" && mine.length === 0)
        wrong.push(`c${n} closed with no verdict note`);
      doneAt = Math.max(doneAt, closeMoment(sb, "eval", `c${n}`)?.ms ?? 0);
      if (!(issued >= 1 && mine.length === 1 && closedRight && order.length === 0))
        completed = false;
    }
    // k1-k4: done by a worker, not by the orchestrator.
    let workerEnd = 0;
    for (const k of K) {
      const t = probe.task("eval", k);
      const r = runs.find((x) => x.task === k && (x.action === "close" || x.action === "block"));
      if (!r) wrong.push(`${k} was never run to completion by a worker (runs.log)`);
      else workerEnd = Math.max(workerEnd, r.ts);
      if (!(t?.status === "CLOSED" && t.substate === "done" && r)) completed = false;
    }
    // never stop: no agent_end between the first dispatch and the last worker finishing.
    const send = run.events.find(
      (e) =>
        e.kind === "tool_end" &&
        /\bagent\s+send\b/.test(
          String(run.toolCalls.find((c) => c.id === e.id)?.args.command ?? ""),
        ),
    );
    const end = completed ? Math.max(workerEnd, doneAt) : Number.POSITIVE_INFINITY;
    const stopsDuringWork = run.events.filter(
      (e) => e.kind === "agent_end" && send !== undefined && e.t > send.t && e.t < end,
    );
    if (stopsDuringWork.length > 0)
      wrong.push(
        `${stopsDuringWork.length} turn end(s) while dispatched workers were still running`,
      );
    wrong.push(...prodWrong(run));
    // native guarantees: delivery inside a wait call, and a per-wave tally from wait.
    const ws = waitWindows(run);
    const dels = deliveries(run, /claim-\d+/);
    const inWait = dels.filter((e) => inside(e.t, ws)).length;
    const nat = [
      native(sb, "every verdict delivered inside a wait", inWait === N, `${inWait}/${N}`),
      native(
        sb,
        "wait returns a per-wave verdict tally",
        ws.some((w) => TALLY.test(w.call.output)),
        `${ws.length} wait call(s)`,
      ),
    ];
    return verdict(run, completed, {
      wrong: [...wrong, ...nat.flatMap((x) => x.wrong)],
      expectFail: [{ re: /\d+ queued/, on: "output", why: "delegate queue full" }],
      notes: [
        `delegate calls=${delegates.length} issued=${okCalls.length} refused=${refused.length} missingVerdict=${missing} dupNotes=${dupNotes} deliveries=${dels.length} inWait=${inWait} stops=${stopsDuringWork.length} doneAt=${doneAt}`,
        ...nat.flatMap((x) => x.notes),
      ],
    });
  },
};

export default scenario;
