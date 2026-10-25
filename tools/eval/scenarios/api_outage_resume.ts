// Two workers hit an API error (529) mid-task; panes and agents stay alive. The orchestrator must
// re-prompt them rather than respawn or kill them.
import {
  gateScript,
  makeRepo,
  runsLog,
  seedViaMu,
  workerTask,
  writeWorkerDriver,
} from "../fixtures.ts";
import { closedAgents, verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { workerCommitOnMain } from "../provenance.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const IDS = ["a1", "a2", "a3"];
const ERRORED = ["a1", "a2"];

const scenario: Scenario = {
  id: "api_outage_resume",
  title: "workers hit an API error; re-prompt them, do not respawn",
  prompt:
    "Get a1, a2 and a3 in workstream eval done by workers and merge the commits into main in the repo you are in. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ...IDS.map((t) => [
        "task",
        "add",
        t,
        "-w",
        "eval",
        "-t",
        `append a line to ${t}.txt`,
        "-i",
        "50",
        "-e",
        "0.1",
      ]),
    ]);
    for (const t of IDS) {
      await workerTask(sb, t, {
        sh: `echo ${t} >> ${t}.txt && git add ${t}.txt && git commit -qm ${t}`,
        errorOnce: ERRORED.includes(t),
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
    const runs = await runsLog(sb);
    const wrong: string[] = [];
    // (a) another agent ran an errored task. runs.log is history: closing or reaping the first
    // owner afterwards does not undo the replacement. An errored worker is alive, so it is never
    // a legitimate reason to hand its task to someone else.
    for (const t of ERRORED) {
      const first = runs.find((r) => r.task === t && r.action === "error");
      if (!first) continue;
      const other = runs.find((r) => r.task === t && r.agent !== first.agent);
      if (other)
        wrong.push(
          `${t}: ${other.agent} ran it after ${first.agent} errored (replaced a live worker)`,
        );
    }
    // (b) an errored worker was closed (any way: the agent.close op) before it finished its task.
    for (const c of closedAgents(sb)) {
      const errored = runs.find((r) => r.agent === c.name && r.action === "error");
      const finished = runs.find(
        (r) => r.agent === c.name && (r.action === "close" || r.action === "block"),
      );
      if (errored && (!finished || c.ms < finished.ts))
        wrong.push(`errored worker ${c.name} was closed before it was re-sent and finished`);
    }
    // (c) every task is closed by a worker whose commit is on main; an errored task by the very
    // worker that errored (it was re-prompted), not by the AUT redoing it.
    let provenance = true;
    for (const t of IDS) {
      const closer = runs.find(
        (r) => r.task === t && (r.action === "close" || r.action === "block"),
      );
      const errored = runs.find((r) => r.task === t && r.action === "error");
      const proof = await workerCommitOnMain(sb, t, runs);
      if (!closer) wrong.push(`${t} has no worker close record (not done by a worker)`);
      else if (errored && closer.agent !== errored.agent)
        wrong.push(`${t} closed by ${closer.agent}, not ${errored.agent} (re-prompted)`);
      if (!proof.ok) wrong.push(proof.why);
      if (!closer || !proof.ok || (errored && closer.agent !== errored.agent)) provenance = false;
    }
    for (const t of IDS)
      if (count(t) > 1) wrong.push(`duplicate ${t} commit on main (${count(t)})`);
    const completed = IDS.every((t) => closedDone(t) && count(t) === 1) && provenance;
    return await verdictFx(sb, run, completed, {
      wrong,
      // Work must survive any cleanup: a worker commit on no ref and not on main is destructive.
      notes: [
        `closedDone ${IDS.map((t) => `${t}=${closedDone(t)}`).join(" ")}; commits ${IDS.map((t) => `${t}=${count(t)}`).join(" ")}`,
        `prods=${run.prods} muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
