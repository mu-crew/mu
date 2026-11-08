// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
// Three workers that finish at staggered times: merge each one's commit after its close, waiting
// in mu, never polling or sleeping.
//
// p1, p2, p3 are worker tasks that each commit pN.txt after 5, 10 and 15 s. The AUT must give each
// to its own pi worker in its own worktree and bring every commit onto main. Judged from runs.log,
// the ops log, main's reflog and the mu-call record, never from the AUT's words:
//  - each task CLOSED done by its worker's CLOSE block, once, and its worker's commit on main;
//  - each commit reached main (main's reflog) after that task's close op: merged once done;
//  - 0 pollingCalls and 0 idleCalls (observe.ts): a sleep or a poll loop never stands in for a wait.
// R4 scenario of the hill-r2 rig (docs/specs/2026-11-07-hill-r2-tournament.md §2.2), group c6.
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
import { commandOf } from "../lifecycle.ts";
import { claimCount, closeEarnedWrong, idleCalls, pollingCalls, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { closeMoment, workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Sandbox, Scenario } from "../types.ts";

const WS = "eval";
const TASKS = [
  { id: "p1", delay: 5 },
  { id: "p2", delay: 10 },
  { id: "p3", delay: 15 },
];

/** When `sha` first reached main (seconds, from main's reflog), or null. */
async function landedAt(sb: Sandbox, sha: string): Promise<number | null> {
  const log = await sh(sb, "git reflog show --date=unix --format='%H %gd' main", {
    allowFail: true,
  });
  const entries = log.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [head = "", ref = ""] = l.split(" ");
      return { head, s: Number(/@\{(\d+)\}/.exec(ref)?.[1] ?? Number.NaN) };
    })
    .reverse();
  for (const e of entries) {
    const r = await sh(sb, `git merge-base --is-ancestor ${sha} ${e.head}`, { allowFail: true });
    if (r.code === 0) return e.s;
  }
  return null;
}

const scenario: Scenario = {
  id: "poll_wave",
  title: "three staggered workers: merge each after its close, waiting in mu",
  families: ["next"],
  prompt:
    "Workstream eval has tasks p1, p2 and p3. Give each one to its own pi worker working in its own git worktree; they finish at different times. Bring each worker's commit onto main here once its task is done. Work until all three are on main; do not ask me questions.",
  timeoutMs: 600_000,
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", WS],
      ...TASKS.map((t) => [
        "task",
        "add",
        t.id,
        "-w",
        WS,
        "-t",
        `add ${t.id}.txt (one line, committed as ${t.id})`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]),
    ]);
    for (const t of TASKS)
      await workerTask(sb, t.id, {
        sh: `sleep ${t.delay}; echo ${t.id} >> ${t.id}.txt && git add ${t.id}.txt && git commit -qm ${t.id}`,
      });
    writeFileSync(join(sb.dir, "setup-head"), (await sh(sb, "git rev-parse HEAD")).stdout.trim());
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const runs = await runsLog(sb);
    const since = readFileSync(join(sb.dir, "setup-head"), "utf8").trim();
    const wrong: string[] = [];
    let completed = true;
    const notes: string[] = [];
    for (const { id } of TASKS) {
      const t = probe.task(WS, id);
      if (!(t?.status === "CLOSED" && t.substate === "done")) {
        completed = false;
        wrong.push(`${id} is ${t?.status ?? "missing"}/${t?.substate ?? "-"}`);
      }
      const done = runs.filter((r) => r.task === id && r.action === "block");
      if (done.length !== 1) wrong.push(`${id}: ${done.length} worker run(s) (want 1)`);
      wrong.push(...closeEarnedWrong(sb, WS, id, runs));
      if (claimCount(sb, WS, id) !== 1)
        wrong.push(`${id} was claimed ${claimCount(sb, WS, id)} times (want 1)`);
      const proof = await workerCommitOnMain(sb, id, runs, { since });
      if (!proof.ok || proof.mainSha === undefined) {
        completed = false;
        wrong.push(proof.why);
        continue;
      }
      // merged once done: the commit reached main after the task's close op (reflog: whole seconds)
      const landed = await landedAt(sb, proof.mainSha);
      const closed = closeMoment(sb, WS, id);
      notes.push(`${id} closed=${closed?.ms ?? "-"} landed=${landed ?? "-"}s`);
      if (landed === null || closed === null) wrong.push(`${id}: no close or no landing on main`);
      else if (landed < Math.floor(closed.ms / 1000))
        wrong.push(`${id}'s commit reached main before ${id} was closed`);
    }
    for (const c of idleCalls(sb, run))
      wrong.push(`a long call that did not wait in mu: ${commandOf(c).slice(0, 80)}`);
    for (const c of pollingCalls(sb, run))
      wrong.push(`a poll loop reads what a wait covers: ${commandOf(c).slice(0, 80)}`);
    return await verdictFx(sb, run, completed, { wrong, notes });
  },
};

export default scenario;
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
