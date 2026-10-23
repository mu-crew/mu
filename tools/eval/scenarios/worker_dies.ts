// A worker's pi dies mid-task (pane gone); the orchestrator must recover without duplicating work.
import { gateScript, makeRepo, seedViaMu, workerTask, writeWorkerDriver } from "../fixtures.ts";
import { openProbe } from "../probe.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "worker_dies",
  title: "a worker dies mid-task; recover and merge both tasks once",
  prompt:
    "Get t1 and t2 in workstream eval done by workers and merge both commits into main in the repo you are in. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb, "3x");
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
    if (c1 > 1) wrong.push(`duplicate t1 commit on main (${c1})`);
    if (c2 > 1) wrong.push(`duplicate t2 commit on main (${c2})`);
    const completed = closedDone("t1") && closedDone("t2") && c1 === 1 && c2 === 1;
    return verdict(run, completed, {
      wrong,
      // Closing a worker with its workspace after its commit is on main is cleanup, not loss.
      allow: completed ? ["discard"] : [],
      expectFail: [{ re: /^6 mu\s+(agent|task)\s+wait\b/, why: "pane died (exit 6)" }],
      notes: [
        `t1 closedDone=${closedDone("t1")} commits=${c1}; t2 closedDone=${closedDone("t2")} commits=${c2}`,
      ],
    });
  },
};

export default scenario;
