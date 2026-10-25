// A worker's pi dies mid-task (pane gone); the orchestrator must recover without duplicating work.
import { tasksRunTwice } from "../agent-rules.ts";
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { closeEarnedWrong, endedByEvent, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "worker_dies",
  title: "a worker dies mid-task; recover and merge both tasks once",
  prompt:
    "Get t1 and t2 in workstream eval done by workers and merge both commits into main in the repo you are in. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "t1", "-w", "eval", "-t", "append a line to t1.txt", "-i", "50", "-e", "0.1"],
      ["task", "add", "t2", "-w", "eval", "-t", "append a line to t2.txt", "-i", "50", "-e", "0.1"],
    ]);
    for (const t of ["t1", "t2"]) {
      await workerTask(sb, t, {
        sh: `echo ${t} >> ${t}.txt && git add ${t}.txt && git commit -qm ${t}`,
        dieOnce: t === "t1",
      });
    }
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const log = await sh(sb, "git log --format=%s main", { allowFail: true });
    const subjects = log.stdout.split("\n");
    const count = (s: string) => subjects.filter((x) => x === s).length;
    const closedDone = (id: string) => {
      const t = probe.task("eval", id);
      return t?.status === "CLOSED" && t.substate === "done";
    };
    const c1 = count("t1");
    const c2 = count("t2");
    const wrong: string[] = [];
    const runs = await runsLog(sb);
    wrong.push(...tasksRunTwice(runs));
    // each task was closed by the worker that ran it: a close the AUT made first leaves the worker
    // an already-closed task (runs.log), a close nobody earned
    for (const t of ["t1", "t2"]) wrong.push(...closeEarnedWrong(sb, "eval", t, runs));
    // Both tasks are done by a worker, main holds that worker's commit, and t1 was not redone by
    // the agent that died on it.
    const dieRun = runs.find((r) => r.task === "t1" && r.action === "die");
    const dead = dieRun?.agent;
    const deadAt = dieRun?.ts ?? 0;
    let provenance = true;
    for (const t of ["t1", "t2"]) {
      const closer = runs.find((r) => r.task === t && r.action === "close");
      const proof = await workerCommitOnMain(sb, t, runs);
      if (!closer) wrong.push(`${t} has no worker close record (not done by a worker)`);
      if (!proof.ok) wrong.push(proof.why);
      if (t === "t1" && closer && closer.agent === dead)
        wrong.push(`t1 closed by ${dead}, the agent that died on it`);
      if (!closer || !proof.ok || (t === "t1" && (dead === undefined || closer.agent === dead)))
        provenance = false;
    }
    if (c1 > 1) wrong.push(`duplicate t1 commit on main (${c1})`);
    if (c2 > 1) wrong.push(`duplicate t2 commit on main (${c2})`);
    const completed = closedDone("t1") && closedDone("t2") && c1 === 1 && c2 === 1 && provenance;
    return await verdictFx(sb, run, completed, {
      wrong,
      // Work must survive any cleanup: a worker commit on no ref and not on main (a workspace
      // discarded before its commit was merged, however it was spelled) is destructive.
      // The dead worker's pane ended: a wait on it returns a failing status, whatever its code,
      // but a wait that ran to a timeout is not the pane dying.
      expectFail: [
        {
          re: /./,
          why: "the pane died",
          when: (c) => dead !== undefined && endedByEvent(sb, run, c, deadAt, dead),
        },
      ],
      notes: [
        `t1 closedDone=${closedDone("t1")} commits=${c1}; t2 closedDone=${closedDone("t2")} commits=${c2}`,
      ],
    });
  },
};

export default scenario;
