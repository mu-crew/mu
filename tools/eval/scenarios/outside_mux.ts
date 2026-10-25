// Outside a multiplexer: the caller is a plain shell (t3code, an IDE terminal, CI): TMUX, TMUX_PANE
// and HERDR_ENV are unset and MU_MUX is blank (setup asserts it; the sandbox env is a whitelist, and
// the sandbox's own MU_MUX=tmux override is blanked so mu runs the detection a plain shell runs,
// down to the "tmux is installed" rung). mu still has tmux on
// PATH and starts its own detached server, so a worker and a delegate wave must run to completion
// with no pane the caller can see, no tmux client and no prod.
//
// o1 is a worker task (5 s); c1 (true) and c2 (false) are claims for delegates (answers held 3 s,
// so the wave and the worker overlap). Judged from effects, never from the AUT's words:
//  - o1: one worker run (runs.log), main holds that worker's commit, closed done AFTER the worker
//    finished (closeEarnedWrong), claimed once;
//  - c1/c2: a mu_delegate call was issued for each, a verdict note carrying the delegate's ref
//    precedes the close, closed done (confirmed) / rejected (refuted);
//  - no turn end while work runs and prods == 0: the loop never needed a nudge, and no step of it
//    needed a pane the caller could see (the answer path is the delegate task, not a pane).
// check runs prod-enabled so a bad that stops and goes on only after a prod is exercised and flagged.
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
import { prodWrong, stopsWhileWorking } from "../lifecycle.ts";
import { claimCount, closeEarnedWrong, delegateFor, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, firstNote, orderWrong, workerCommitOnMain } from "../provenance.ts";
import type { Scenario } from "../types.ts";

const CLAIMS = [1, 2] as const;
const expected = (n: number): "CONFIRMED" | "REFUTED" => (n === 1 ? "CONFIRMED" : "REFUTED");
const claimText = (n: number): string =>
  n === 1
    ? `CLAIM claim-${n}: README.md in the repo root starts with the line "# eval repo".`
    : `CLAIM claim-${n}: gate.sh in the repo root is a Python script.`;

const scenario: Scenario = {
  id: "outside_mux",
  title: "a worker and a delegate wave from a caller outside tmux and herdr",
  prompt:
    "You are in a plain shell, not inside tmux or herdr. Workstream eval has a worker task o1 (a pi worker needs several seconds for it) and two claims in tasks c1 and c2 (claim-1 and claim-2). Get o1 done by a worker and merge its commit into main in the repo you are in. Get each claim independently checked (quote the claim, with its claim-N name, in the prompt of its check) with the verdict recorded on its task, then close each task as done if confirmed or rejected if refuted. Work until it is done; do not ask me questions, and do not stop while work is still running.",
  timeoutMs: 600_000,
  check: { quietMs: 3000, maxProds: 1 },
  env: { MU_MUX: "" },
  async setup(sb) {
    const leaked = ["TMUX", "TMUX_PANE", "HERDR_ENV"].filter((k) => sb.env[k] !== undefined);
    if (sb.env.MU_MUX) leaked.push("MU_MUX");
    if (leaked.length > 0)
      throw new Error(`outside_mux: caller env still has ${leaked.join(", ")}`);
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await delegateDelay(sb, 3);
    const ref = await nonce(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "o1", "-w", "eval", "-t", "add o1.txt", "-i", "50", "-e", "0.1"],
      ...CLAIMS.map((n) => [
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
    await workerTask(sb, "o1", {
      sh: "sleep 5; echo o1 >> o1.txt && git add o1.txt && git commit -qm o1",
    });
    for (const n of CLAIMS) {
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
    const wrong: string[] = [];
    let completed = true;
    // o1: a worker did it, main holds its commit, the close came after the worker finished.
    const runs = await runsLog(sb);
    const o1 = probe.task("eval", "o1");
    const o1Done = o1?.status === "CLOSED" && o1.substate === "done";
    const proof = await workerCommitOnMain(sb, "o1", runs);
    if (!proof.ok) wrong.push(proof.why);
    if (o1Done) wrong.push(...closeEarnedWrong(sb, "eval", "o1", runs));
    if (claimCount(sb, "eval", "o1") !== 1)
      wrong.push(`o1 was claimed ${claimCount(sb, "eval", "o1")} times (want 1)`);
    if (!(o1Done && proof.ok)) completed = false;
    // c1, c2: delegated, verdict recorded, then closed by the verdict.
    const issuedCalls = run.toolCalls.filter((c) => c.name === "mu_delegate" && !c.isError);
    let issued = 0;
    for (const n of CLAIMS) {
      const t = probe.task("eval", `c${n}`);
      const word = expected(n);
      const re = new RegExp(`claim-${n}(?!\\d)`);
      const isVerdict = (x: string): boolean =>
        /VERDICT:/.test(x) && x.includes(`ref=${ref}`) && re.test(x);
      const noted = probe.notes("eval", `c${n}`).filter(isVerdict);
      const got = noted.map((x) => /VERDICT:\s*\**(CONFIRMED|REFUTED)/.exec(x)?.[1]);
      const wasIssued = issuedCalls.some((c) => delegateFor(c.args, n));
      if (wasIssued) issued++;
      else wrong.push(`no delegate was issued for claim-${n}`);
      const closedRight =
        t?.status === "CLOSED" && t.substate === (word === "CONFIRMED" ? "done" : "rejected");
      if (t?.status === "CLOSED" && !closedRight)
        wrong.push(
          `c${n} closed ${t.substate}, want ${word === "CONFIRMED" ? "done" : "rejected"}`,
        );
      if (noted.length === 0) {
        if (t?.status === "CLOSED") wrong.push(`c${n} closed with no delegate verdict recorded`);
      } else if (!got.includes(word)) {
        wrong.push(`c${n} verdict ${got.join(",")} disagrees with fixture ${word}`);
      }
      const order = orderWrong(
        firstNote(sb, "eval", `c${n}`, isVerdict),
        closeMoment(sb, "eval", `c${n}`),
        `c${n} must close after its verdict was recorded`,
      );
      if (t?.status === "CLOSED" && noted.length > 0) wrong.push(...order);
      if (!(wasIssued && got.includes(word) && closedRight && order.length === 0))
        completed = false;
    }
    // never stop while work runs: no turn end between the first hand-out and the last close (a
    // delegate's answer restarts a stopped turn, so a stop needs no prod to go unnoticed)
    const lastClose = Math.max(
      ...["o1", "c1", "c2"].map((id) => closeMoment(sb, "eval", id)?.ms ?? 0),
    );
    const stops = stopsWhileWorking(sb, run, lastClose);
    if (stops.length > 0) wrong.push(`${stops.length} turn end(s) while work was running`);
    wrong.push(...prodWrong(run));
    return await verdictFx(sb, run, completed && run.prods === 0 && stops.length === 0, {
      wrong,
      notes: [
        `o1=${o1?.status}/${o1?.substate} delegatesIssued=${issued} prods=${run.prods} runs=${runs.map((r) => `${r.task}:${r.action}`).join(",")}`,
      ],
    });
  },
};

export default scenario;
