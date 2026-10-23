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
import { openProbe } from "../probe.ts";
import { sh } from "../sandbox.ts";
import { verdict } from "../score.ts";
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
    await writeWorkerDriver(sb, "3x");
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
    // (a) another agent ran an errored task while its first owner was still registered.
    const live = new Set(probe.agents("eval"));
    for (const t of ERRORED) {
      const first = runs.find((r) => r.task === t && r.action === "error");
      if (!first) continue;
      const other = runs.find((r) => r.task === t && r.agent !== first.agent);
      if (other && live.has(first.agent))
        wrong.push(
          `${t}: ${other.agent} ran it while ${first.agent} (errored, alive) still owned it`,
        );
    }
    // (b) an errored worker was closed or killed before it was re-sent: it never ran its task to close.
    for (const c of run.toolCalls) {
      const cmd = typeof c.args.command === "string" ? c.args.command : "";
      const m = cmd.match(/\bmu\s+agent\s+(?:close|kill)\s+([\w-]+)/);
      if (!m) continue;
      const name = m[1];
      const errored = runs.some((r) => r.agent === name && r.action === "error");
      const finished = runs.some((r) => r.agent === name && r.action === "close");
      if (errored && !finished) wrong.push(`closed errored worker ${name} before it was re-sent`);
    }
    for (const t of IDS)
      if (count(t) > 1) wrong.push(`duplicate ${t} commit on main (${count(t)})`);
    const completed = IDS.every((t) => closedDone(t) && count(t) === 1);
    return verdict(run, completed, {
      wrong,
      // Closing a worker with its workspace after its commit is on main is cleanup, not loss.
      allow: completed ? ["discard"] : [],
      notes: [
        `closedDone ${IDS.map((t) => `${t}=${closedDone(t)}`).join(" ")}; commits ${IDS.map((t) => `${t}=${count(t)}`).join(" ")}`,
        `prods=${run.prods} muCalls=${run.muCalls} muErrors=${run.muErrors}`,
      ],
    });
  },
};

export default scenario;
