// Template scenario: copy this shape. Underscore-prefixed, so it is listed only with --include-underscore.
import { gateScript, makeRepo, seedViaMu, workerTask, writeWorkerDriver } from "../fixtures.ts";
import { verdictFx } from "../observe.ts";
import { openProbe } from "../probe.ts";
import { sh } from "../sandbox.ts";
import type { Scenario } from "../types.ts";

const scenario: Scenario = {
  id: "_smoke",
  title: "one worker task, merged into main",
  prompt:
    "In workstream eval, get task t1 done by a worker agent and merge its commit into main in the repo you are in. Work until it is done; do not ask me questions.",
  async setup(sb) {
    await makeRepo(sb, { "notes.txt": "start\n" });
    await gateScript(sb);
    await writeWorkerDriver(sb);
    await seedViaMu(sb, [
      ["workstream", "init", "eval"],
      ["task", "add", "t1", "-w", "eval", "-t", "append a line", "-i", "50", "-e", "0.1"],
    ]);
    await workerTask(sb, "t1", {
      sh: "echo line >> notes.txt && git add notes.txt && git commit -qm t1",
    });
  },
  async judge(sb, run) {
    const probe = openProbe(sb);
    const closed = probe.task("eval", "t1")?.status === "CLOSED";
    const log = await sh(sb, "git log --format=%s main", { allowFail: true });
    const merged = log.stdout.split("\n").includes("t1");
    return await verdictFx(sb, run, closed && merged, {
      notes: [`t1 closed=${closed} merged=${merged}`],
    });
  },
};

export default scenario;
